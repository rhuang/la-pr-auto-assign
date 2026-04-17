import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSearchQuery, getLoadMap } from './load';

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

type SearchArgs = { q: string; per_page: number };

function makeOctokit(
  handler: (args: SearchArgs) => Promise<{ data: { total_count: number } }>,
) {
  const issuesAndPullRequests = vi.fn(handler);
  return {
    octokit: {
      rest: {
        search: {
          issuesAndPullRequests,
        },
      },
    } as unknown as Parameters<typeof getLoadMap>[0],
    issuesAndPullRequests,
  };
}

describe('buildSearchQuery', () => {
  it('builds a single-qualifier review-requested query for 1 user, 2 repos, 21 days', () => {
    const now = new Date('2026-04-16T10:00:00Z');
    const q = buildSearchQuery(
      'alice',
      'review-requested',
      ['test-org/repo-a', 'test-org/repo-b'],
      21,
      now,
    );
    expect(q).toBe(
      'is:pr review-requested:alice created:>=2026-03-26 repo:test-org/repo-a repo:test-org/repo-b',
    );
  });

  it('builds a single-qualifier reviewed-by query with the same shape', () => {
    const now = new Date('2026-04-16T10:00:00Z');
    const q = buildSearchQuery('alice', 'reviewed-by', ['o/r'], 21, now);
    expect(q).toBe('is:pr reviewed-by:alice created:>=2026-03-26 repo:o/r');
  });

  it('subtracts windowDays from now (YYYY-MM-DD)', () => {
    const now = new Date('2026-04-16T10:00:00Z');
    const q = buildSearchQuery('bob', 'review-requested', ['o/r'], 21, now);
    expect(q).toContain('created:>=2026-03-26');
  });
});

describe('getLoadMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sums the two per-qualifier totals into a single load number per user', async () => {
    const byQualifier: Record<string, { 'review-requested': number; 'reviewed-by': number }> = {
      alice: { 'review-requested': 3, 'reviewed-by': 4 },
      bob: { 'review-requested': 0, 'reviewed-by': 0 },
      carol: { 'review-requested': 5, 'reviewed-by': 2 },
    };
    const { octokit } = makeOctokit(async ({ q }) => {
      const user = Object.keys(byQualifier).find((u) =>
        q.includes(`:${u} `) || q.endsWith(`:${u}`) || q.includes(`:${u} `),
      )!;
      const qualifier = q.includes('review-requested:') ? 'review-requested' : 'reviewed-by';
      return { data: { total_count: byQualifier[user]![qualifier] } };
    });

    const result = await getLoadMap(octokit, {
      whitelist: ['alice', 'bob', 'carol'],
      loadRepos: ['o/r'],
      windowDays: 21,
    });

    expect(result).toEqual({ alice: 7, bob: 0, carol: 7 });
  });

  it('fans out two calls per whitelist user (one per qualifier)', async () => {
    const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
    const { octokit, issuesAndPullRequests } = makeOctokit(async () => ({
      data: { total_count: 0 },
    }));

    await getLoadMap(octokit, {
      whitelist: users,
      loadRepos: ['o/r'],
      windowDays: 21,
    });

    expect(issuesAndPullRequests).toHaveBeenCalledTimes(16);
  });

  it('when one sub-query fails, the other qualifier still contributes to load', async () => {
    const { octokit } = makeOctokit(async ({ q }) => {
      if (q.includes('review-requested:bob')) {
        throw new Error('users cannot be searched');
      }
      if (q.includes('reviewed-by:bob')) {
        return { data: { total_count: 4 } };
      }
      return { data: { total_count: 0 } };
    });

    const result = await getLoadMap(octokit, {
      whitelist: ['bob'],
      loadRepos: ['o/r'],
      windowDays: 21,
    });

    expect(result).toEqual({ bob: 4 });
  });

  it('issues one query per qualifier, each with a single qualifier and all repos', async () => {
    const { octokit, issuesAndPullRequests } = makeOctokit(async () => ({
      data: { total_count: 0 },
    }));

    await getLoadMap(octokit, {
      whitelist: ['alice'],
      loadRepos: ['test-org/repo-a', 'test-org/repo-b'],
      windowDays: 21,
    });

    expect(issuesAndPullRequests).toHaveBeenCalledTimes(2);
    const qs = issuesAndPullRequests.mock.calls.map((c) => (c[0] as SearchArgs).q);

    const rrQ = qs.find((q) => q.includes('review-requested:alice'))!;
    const rbQ = qs.find((q) => q.includes('reviewed-by:alice'))!;
    expect(rrQ).toBeDefined();
    expect(rbQ).toBeDefined();

    // No OR compound — each query carries exactly one user qualifier.
    expect(rrQ).not.toContain('reviewed-by:');
    expect(rrQ).not.toContain(' OR ');
    expect(rbQ).not.toContain('review-requested:');
    expect(rbQ).not.toContain(' OR ');

    for (const q of [rrQ, rbQ]) {
      expect(q).toContain('repo:test-org/repo-a');
      expect(q).toContain('repo:test-org/repo-b');
    }
    const args = issuesAndPullRequests.mock.calls[0]![0] as SearchArgs;
    expect(args.per_page).toBe(1);
  });
});
