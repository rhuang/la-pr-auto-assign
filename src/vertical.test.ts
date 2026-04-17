import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PRContext } from './types';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { classifyVertical, buildUserMessage, VERTICAL_SYSTEM_PROMPT } from './vertical';

function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    owner: 'test-org',
    repo: 'repo-a',
    number: 42,
    headSha: 'deadbeef',
    author: 'alice',
    title: 'Add attorney case queue filter',
    body: 'Adds a filter to the attorney case queue.',
    changedFiles: ['src/attorney/queue.ts'],
    diff: 'diff --git a/src/attorney/queue.ts b/src/attorney/queue.ts\n@@ -1 +1,2 @@\n+// new line\n',
    linkedIssue: null,
    ...overrides,
  };
}

function textResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('classifyVertical', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns "Professional" when SDK returns {"vertical":"Professional"}', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('{"vertical":"Professional"}'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBe('Professional');
  });

  it('returns "Client" when SDK returns {"vertical":"Client"}', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('{"vertical":"Client"}'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBe('Client');
  });

  it('returns "Designer" when SDK returns {"vertical":"Designer"}', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('{"vertical":"Designer"}'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBe('Designer');
  });

  it('returns null when SDK returns {"vertical":"None"}', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('{"vertical":"None"}'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBeNull();
  });

  it('parses JSON wrapped in a ```json code fence', async () => {
    mockCreate.mockResolvedValueOnce(
      textResponse('```json\n{"vertical":"Professional"}\n```'),
    );
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBe('Professional');
  });

  it('parses JSON wrapped in a bare ``` code fence', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('```\n{"vertical":"Client"}\n```'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBe('Client');
  });

  it('parses JSON with an opening ```json fence but no closing fence (truncated)', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('```json\n{"vertical":"None"}'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBeNull();
  });

  it('parses JSON with leading commentary', async () => {
    mockCreate.mockResolvedValueOnce(
      textResponse('Here is the classification:\n{"vertical":"Designer"}'),
    );
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBe('Designer');
  });

  it('returns null when SDK returns unparseable text', async () => {
    mockCreate.mockResolvedValueOnce(textResponse("I think it's Professional"));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBeNull();
  });

  it('returns null when SDK returns an invalid vertical value', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('{"vertical":"Other"}'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBeNull();
  });

  it('returns null when the SDK throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('boom'));
    const result = await classifyVertical('fake-key', makePRContext());
    expect(result).toBeNull();
  });

  it('passes the correct model id and system prompt to the SDK', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('{"vertical":"Professional"}'));
    await classifyVertical('fake-key', makePRContext());
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        system: VERTICAL_SYSTEM_PROMPT,
      }),
    );
  });
});

describe('buildUserMessage', () => {
  it('includes title, body, and diff when linkedIssue is null', () => {
    const ctx = makePRContext({
      title: 'Fix attorney queue',
      body: 'Fixes a rendering bug in the attorney case queue.',
      diff: 'diff --git a/a b/b\n@@ -1 +1 @@\n-old\n+new\n',
      linkedIssue: null,
    });
    const msg = buildUserMessage(ctx);
    expect(msg).toContain('Title: Fix attorney queue');
    expect(msg).toContain('Body: Fixes a rendering bug in the attorney case queue.');
    expect(msg).toContain('Diff:\ndiff --git a/a b/b');
  });

  it('does NOT include a linked-issue section when linkedIssue is null', () => {
    const ctx = makePRContext({ linkedIssue: null });
    const msg = buildUserMessage(ctx);
    expect(msg).not.toContain('Linked issue');
  });

  it('includes the linked-issue section when linkedIssue is present', () => {
    const ctx = makePRContext({
      linkedIssue: {
        ref: { owner: 'test-org', repo: 'repo-a', number: 101 },
        title: 'Queue needs a status filter',
        body: 'Users want to filter by case status.',
      },
    });
    const msg = buildUserMessage(ctx);
    expect(msg).toContain('Linked issue (test-org/repo-a#101): Queue needs a status filter');
    expect(msg).toContain('Users want to filter by case status.');
  });

  it('truncates the body to 2KB', () => {
    const bigBody = 'x'.repeat(5000);
    const ctx = makePRContext({ body: bigBody });
    const msg = buildUserMessage(ctx);
    // The line after "Body: " should have at most 2048 x's (the truncation budget).
    const match = msg.match(/Body: (x+)/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(2048);
  });

  it('truncates the linked-issue body to 2KB', () => {
    const bigBody = 'y'.repeat(5000);
    const ctx = makePRContext({
      linkedIssue: {
        ref: { owner: 'test-org', repo: 'repo-a', number: 7 },
        title: 'Big issue',
        body: bigBody,
      },
    });
    const msg = buildUserMessage(ctx);
    const match = msg.match(/Big issue\n(y+)/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(2048);
  });
});
