import { describe, it, expect, vi } from 'vitest';
import { parseLinkedIssueRefs, fetchPRContext, DIFF_MAX_BYTES } from './pr-context';

describe('parseLinkedIssueRefs', () => {
  const OWNER = 'test-org';
  const REPO = 'repo-b';

  it('parses "Fixes #42" → one same-repo ref', () => {
    const refs = parseLinkedIssueRefs('Fixes #42', OWNER, REPO);
    expect(refs).toEqual([{ owner: OWNER, repo: REPO, number: 42 }]);
  });

  it('parses cross-repo "closes test-org/repo-a#17"', () => {
    const refs = parseLinkedIssueRefs(
      'closes test-org/repo-a#17',
      OWNER,
      REPO,
    );
    expect(refs).toEqual([
      { owner: 'test-org', repo: 'repo-a', number: 17 },
    ]);
  });

  it('parses two refs, preserving order', () => {
    const refs = parseLinkedIssueRefs(
      'This resolves owner/repo#1 and fixes #5',
      OWNER,
      REPO,
    );
    expect(refs).toEqual([
      { owner: 'owner', repo: 'repo', number: 1 },
      { owner: OWNER, repo: REPO, number: 5 },
    ]);
  });

  it('is case-insensitive: "FIXES #5"', () => {
    const refs = parseLinkedIssueRefs('FIXES #5', OWNER, REPO);
    expect(refs).toEqual([{ owner: OWNER, repo: REPO, number: 5 }]);
  });

  it('returns [] for bare "#1" with no keyword', () => {
    const refs = parseLinkedIssueRefs('#1', OWNER, REPO);
    expect(refs).toEqual([]);
  });

  it('de-duplicates repeated refs', () => {
    const refs = parseLinkedIssueRefs('fixes #3, closes #3', OWNER, REPO);
    expect(refs).toEqual([{ owner: OWNER, repo: REPO, number: 3 }]);
  });

  it('returns [] for an empty body', () => {
    expect(parseLinkedIssueRefs('', OWNER, REPO)).toEqual([]);
  });

  it('returns [] for a null-ish body', () => {
    // @ts-expect-error testing runtime null body
    expect(parseLinkedIssueRefs(null, OWNER, REPO)).toEqual([]);
  });
});

function makeOctokit(overrides: {
  pr?: Record<string, unknown>;
  files?: Array<{ filename: string; patch?: string }>;
  issue?: Record<string, unknown>;
  issueError?: { status: number; message?: string };
}) {
  const prData = {
    number: 123,
    title: 'Test PR',
    body: 'Fixes #99',
    head: { sha: 'abc123' },
    user: { login: 'alice' },
    ...overrides.pr,
  };

  const get = vi.fn().mockResolvedValue({ data: prData });
  const listFiles = vi
    .fn()
    .mockResolvedValue({ data: overrides.files ?? [] });

  const issuesGet = vi.fn();
  if (overrides.issueError) {
    issuesGet.mockRejectedValue(
      Object.assign(new Error(overrides.issueError.message ?? 'err'), {
        status: overrides.issueError.status,
      }),
    );
  } else {
    issuesGet.mockResolvedValue({
      data: overrides.issue ?? { title: 'Issue title', body: 'Issue body' },
    });
  }

  return {
    rest: {
      pulls: { get, listFiles },
      issues: { get: issuesGet },
    },
    _spies: { get, listFiles, issuesGet },
  };
}

describe('fetchPRContext', () => {
  const params = { owner: 'test-org', repo: 'repo-b', number: 123 };

  it('returns a PRContext with the expected fields', async () => {
    const octokit = makeOctokit({
      files: [
        { filename: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
        { filename: 'b.ts', patch: '@@ -2 +2 @@\n-x\n+y' },
        { filename: 'c.bin' }, // no patch — should be skipped
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await fetchPRContext(octokit as any, params);
    expect(ctx.owner).toBe('test-org');
    expect(ctx.repo).toBe('repo-b');
    expect(ctx.number).toBe(123);
    expect(ctx.headSha).toBe('abc123');
    expect(ctx.author).toBe('alice');
    expect(ctx.title).toBe('Test PR');
    expect(ctx.body).toBe('Fixes #99');
    expect(ctx.changedFiles).toEqual(['a.ts', 'b.ts', 'c.bin']);
    expect(ctx.diff).toContain('@@ -1 +1 @@');
    expect(ctx.diff).toContain('@@ -2 +2 @@');
    expect(ctx.linkedIssue).not.toBeNull();
    expect(ctx.linkedIssue?.ref).toEqual({
      owner: 'test-org',
      repo: 'repo-b',
      number: 99,
    });
    expect(ctx.linkedIssue?.title).toBe('Issue title');
  });

  it('falls back to "" for a null author', async () => {
    const octokit = makeOctokit({ pr: { user: null, body: '' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await fetchPRContext(octokit as any, params);
    expect(ctx.author).toBe('');
  });

  it('truncates the diff to DIFF_MAX_BYTES', async () => {
    const big = 'x'.repeat(20 * 1024);
    const octokit = makeOctokit({
      files: [
        { filename: 'a', patch: big },
        { filename: 'b', patch: big },
        { filename: 'c', patch: big },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await fetchPRContext(octokit as any, params);
    expect(ctx.diff.length).toBeLessThanOrEqual(DIFF_MAX_BYTES);
    expect(ctx.diff.length).toBe(DIFF_MAX_BYTES);
  });

  it('returns linkedIssue: null and does not throw on 404', async () => {
    const octokit = makeOctokit({
      pr: { body: 'Fixes #404' },
      issueError: { status: 404, message: 'Not Found' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await fetchPRContext(octokit as any, params);
    expect(ctx.linkedIssue).toBeNull();
    expect(octokit._spies.issuesGet).toHaveBeenCalledTimes(1);
  });

  it('does not call issues.get when body has no linked-issue keyword', async () => {
    const octokit = makeOctokit({
      pr: { body: 'Just a description with #5 but no keyword.' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await fetchPRContext(octokit as any, params);
    expect(ctx.linkedIssue).toBeNull();
    expect(octokit._spies.issuesGet).not.toHaveBeenCalled();
  });

  it('propagates non-404 errors from issues.get', async () => {
    const octokit = makeOctokit({
      pr: { body: 'Fixes #7' },
      issueError: { status: 500, message: 'boom' },
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchPRContext(octokit as any, params),
    ).rejects.toThrow(/boom/);
  });
});
