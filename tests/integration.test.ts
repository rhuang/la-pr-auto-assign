/**
 * End-to-end integration test for the action's entry point.
 *
 * All I/O is mocked:
 *   - @actions/github — getOctokit returns a stub whose methods are vi.fn()s
 *   - @actions/github context — a mutable object we set per test
 *   - @anthropic-ai/sdk — default export mocked to a stubbed client
 *   - @actions/core — partially mocked so getInput can be driven by process.env
 *
 * Each test mutates the shared mock objects in beforeEach, then awaits run(),
 * and asserts on the captured calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ------------------------------------------------------------------ */
/* Mocks (hoisted so vi.mock factories can see them)                  */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => {
  const mockRequestReviewers = vi.fn();
  const mockCreateComment = vi.fn();
  const mockPullsGet = vi.fn();
  const mockListFiles = vi.fn();
  const mockIssuesGet = vi.fn();
  const mockListCommits = vi.fn();
  const mockGetContent = vi.fn();
  const mockSearch = vi.fn();
  const mockAnthropicCreate = vi.fn();

  const mockOctokit = {
    rest: {
      pulls: {
        get: mockPullsGet,
        listFiles: mockListFiles,
        requestReviewers: mockRequestReviewers,
      },
      issues: {
        get: mockIssuesGet,
        createComment: mockCreateComment,
      },
      repos: {
        listCommits: mockListCommits,
        getContent: mockGetContent,
      },
      search: {
        issuesAndPullRequests: mockSearch,
      },
    },
  };

  const mockContext: {
    eventName: string;
    repo: { owner: string; repo: string };
    payload: { pull_request?: { number: number } };
  } = {
    eventName: 'pull_request',
    repo: { owner: 'test-org', repo: 'repo-a' },
    payload: { pull_request: { number: 42 } },
  };

  return {
    mockRequestReviewers,
    mockCreateComment,
    mockPullsGet,
    mockListFiles,
    mockIssuesGet,
    mockListCommits,
    mockGetContent,
    mockSearch,
    mockAnthropicCreate,
    mockOctokit,
    mockContext,
  };
});

vi.mock('@actions/github', () => ({
  getOctokit: vi.fn(() => mocks.mockOctokit),
  context: mocks.mockContext,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mocks.mockAnthropicCreate },
  })),
}));

// Keep @actions/core real (getInput relies on env) but silence log/summary noise.
vi.mock('@actions/core', async () => {
  const actual = await vi.importActual<typeof import('@actions/core')>('@actions/core');
  return {
    ...actual,
    info: vi.fn(),
    warning: vi.fn(),
    debug: vi.fn(),
    setFailed: vi.fn((msg: string) => {
      // Surface test failures when the action fails unexpectedly.
      throw new Error(`setFailed called: ${msg}`);
    }),
    summary: {
      addHeading: vi.fn().mockReturnThis(),
      addRaw: vi.fn().mockReturnThis(),
      addTable: vi.fn().mockReturnThis(),
      write: vi.fn().mockResolvedValue(undefined),
    },
  };
});

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

const PROFESSIONAL_REVIEWERS = [
  'prof-a',
  'prof-b',
  'prof-c',
  'prof-d',
];
const CLIENT_REVIEWERS = [
  'client-a',
  'client-b',
  'client-c',
  'client-d',
];
const ALL_WHITELIST = [...PROFESSIONAL_REVIEWERS, ...CLIENT_REVIEWERS];

const CONFIG_YAML = `
verticals:
  Professional:
    reviewers:
${PROFESSIONAL_REVIEWERS.map((u) => `      - ${u}`).join('\n')}
  Client:
    reviewers:
${CLIENT_REVIEWERS.map((u) => `      - ${u}`).join('\n')}
  Designer:
    reviewers:
${CLIENT_REVIEWERS.map((u) => `      - ${u}`).join('\n')}
load_repos:
  - repo: test-org/repo-a
    users:
${ALL_WHITELIST.map((u) => `      - ${u}`).join('\n')}
  - repo: test-org/repo-b
    users:
${ALL_WHITELIST.map((u) => `      - ${u}`).join('\n')}
`;

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function resetMocks() {
  mocks.mockRequestReviewers.mockReset().mockResolvedValue({});
  mocks.mockCreateComment.mockReset().mockResolvedValue({});
  mocks.mockPullsGet.mockReset();
  mocks.mockListFiles.mockReset();
  mocks.mockIssuesGet.mockReset();
  mocks.mockListCommits.mockReset().mockResolvedValue({ data: [] });
  mocks.mockGetContent.mockReset().mockResolvedValue({
    data: { type: 'file', encoding: 'base64', content: b64(CONFIG_YAML) },
  });
  mocks.mockSearch.mockReset().mockResolvedValue({ data: { total_count: 0 } });
  mocks.mockAnthropicCreate.mockReset();
}

function setDefaultPREventFixtures() {
  mocks.mockPullsGet.mockResolvedValue({
    data: {
      head: { sha: 'abc123' },
      user: { login: 'newdev' },
      title: 'Add case queue filter for attorneys',
      body: 'Closes #7\n\nGive attorneys a way to filter their active cases.',
    },
  });
  mocks.mockListFiles.mockResolvedValue({
    data: [
      {
        filename: 'src/cases/queue.ts',
        patch: '@@ -1,3 +1,5 @@\n+const filter = ...;',
      },
      {
        filename: 'src/cases/queue.test.ts',
        patch: '@@ -1,1 +1,2 @@\n+it("filters", () => {});',
      },
    ],
  });
  mocks.mockIssuesGet.mockResolvedValue({
    data: {
      title: 'Attorneys need case queue filter',
      body: 'Professional-side feature.',
    },
  });
  mocks.mockAnthropicCreate.mockResolvedValue({
    content: [{ type: 'text', text: '{"vertical":"Professional"}' }],
  });
}

describe('integration: run()', () => {
  beforeEach(() => {
    resetMocks();
    setDefaultPREventFixtures();

    process.env['INPUT_ANTHROPIC-API-KEY'] = 'test-anthropic-key';
    process.env['INPUT_GITHUB-TOKEN'] = 'test-gh-token';
    process.env['INPUT_CONFIG-REPO'] = 'test-org/team-config';

    // Reset the shared context to the PR default.
    mocks.mockContext.eventName = 'pull_request';
    mocks.mockContext.repo = { owner: 'test-org', repo: 'repo-a' };
    mocks.mockContext.payload = { pull_request: { number: 42 } };
  });

  afterEach(() => {
    delete process.env['INPUT_ANTHROPIC-API-KEY'];
    delete process.env['INPUT_GITHUB-TOKEN'];
    delete process.env['INPUT_LOAD-TOKEN'];
    delete process.env['INPUT_CONFIG-REPO'];
    delete process.env['INPUT_CONFIG-PATH'];
    delete process.env['INPUT_CONFIG-REF'];
    // Re-import index.ts fresh each test.
    vi.resetModules();
  });

  it('assigns a Professional reviewer for a Professional-classified PR', async () => {
    const { run } = await import('../src/index');
    await run();

    expect(mocks.mockRequestReviewers).toHaveBeenCalledOnce();
    const call = mocks.mockRequestReviewers.mock.calls[0][0];
    expect(call.owner).toBe('test-org');
    expect(call.repo).toBe('repo-a');
    expect(call.pull_number).toBe(42);
    expect(call.reviewers).toHaveLength(1);
    expect(PROFESSIONAL_REVIEWERS).toContain(call.reviewers[0]);
  });

  it('posts a comment explaining the assignment with the vertical', async () => {
    const { run } = await import('../src/index');
    await run();

    expect(mocks.mockCreateComment).toHaveBeenCalledOnce();
    const call = mocks.mockCreateComment.mock.calls[0][0];
    expect(call.owner).toBe('test-org');
    expect(call.repo).toBe('repo-a');
    expect(call.issue_number).toBe(42);
    expect(call.body).toMatch(/Assigned @\w+/);
    expect(call.body).toContain('Professional');
    expect(call.body).toContain('current load:');
  });

  it('excludes the PR author from the candidate pool', async () => {
    // Make the PR author one of the Professional reviewers; expect them NOT to be chosen.
    mocks.mockPullsGet.mockResolvedValue({
      data: {
        head: { sha: 'abc123' },
        user: { login: 'prof-a' },
        title: 'Add case queue filter',
        body: 'Closes #7',
      },
    });

    const { run } = await import('../src/index');
    await run();

    const call = mocks.mockRequestReviewers.mock.calls[0][0];
    expect(call.reviewers).not.toContain('prof-a');
    // Still someone from Professional.
    expect(PROFESSIONAL_REVIEWERS).toContain(call.reviewers[0]);
  });

  it('falls back to least-loaded when the LLM returns None', async () => {
    mocks.mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"vertical":"None"}' }],
    });
    // Differential loads: client-d has the lowest load (0); everyone else has 5+.
    mocks.mockSearch.mockImplementation(async ({ q }: { q: string }) => {
      if (q.includes('review-requested:client-d')) {
        return { data: { total_count: 0 } };
      }
      return { data: { total_count: 5 } };
    });

    const { run } = await import('../src/index');
    await run();

    const reviewerCall = mocks.mockRequestReviewers.mock.calls[0][0];
    expect(reviewerCall.reviewers[0]).toBe('client-d');

    const commentCall = mocks.mockCreateComment.mock.calls[0][0];
    expect(commentCall.body).toContain('none (fallback)');
  });

  it('prefers recent committers within the matched vertical', async () => {
    // Make prof-b a recent committer on both files.
    mocks.mockListCommits.mockResolvedValue({
      data: [
        {
          author: { login: 'prof-b' },
          committer: { login: 'prof-b' },
        },
      ],
    });

    const { run } = await import('../src/index');
    await run();

    const call = mocks.mockRequestReviewers.mock.calls[0][0];
    expect(call.reviewers[0]).toBe('prof-b');
  });

  it('skips assignment when PR author is in ignore_authors (case-insensitive)', async () => {
    const ignoreYaml = CONFIG_YAML + '\nignore_authors:\n  - NewDev\n';
    mocks.mockGetContent.mockResolvedValue({
      data: { type: 'file', encoding: 'base64', content: b64(ignoreYaml) },
    });

    const { run } = await import('../src/index');
    await run();

    expect(mocks.mockRequestReviewers).not.toHaveBeenCalled();
    expect(mocks.mockCreateComment).not.toHaveBeenCalled();
    // Author was `newdev` (from setDefaultPREventFixtures) — case should not matter.
  });

  it('skips with an info log when event is not pull_request', async () => {
    mocks.mockContext.eventName = 'push';

    const { run } = await import('../src/index');
    await run();

    expect(mocks.mockRequestReviewers).not.toHaveBeenCalled();
    expect(mocks.mockCreateComment).not.toHaveBeenCalled();
  });

  it('calls the Anthropic SDK with the correct model', async () => {
    const { run } = await import('../src/index');
    await run();

    expect(mocks.mockAnthropicCreate).toHaveBeenCalledOnce();
    const call = mocks.mockAnthropicCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
  });

  it('makes two Search API calls per whitelist member (one per qualifier)', async () => {
    const { run } = await import('../src/index');
    await run();

    expect(mocks.mockSearch).toHaveBeenCalledTimes(ALL_WHITELIST.length * 2);
  });
});
