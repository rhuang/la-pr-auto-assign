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
  it('produces the exact expected string for 1 user, 2 repos, 21 days with a fixed now', () => {
    const now = new Date('2026-04-16T10:00:00Z');
    const q = buildSearchQuery('alice', ['test-org/repo-a', 'test-org/repo-b'], 21, now);
    expect(q).toBe(
      'is:pr (review-requested:alice OR reviewed-by:alice) created:>=2026-03-26 repo:test-org/repo-a repo:test-org/repo-b',
    );
  });

  it('subtracts windowDays from now (YYYY-MM-DD)', () => {
    const now = new Date('2026-04-16T10:00:00Z');
    const q = buildSearchQuery('bob', ['o/r'], 21, now);
    expect(q).toContain('created:>=2026-03-26');
  });
});

describe('getLoadMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { login: total_count } for each whitelist user, including zero counts', async () => {
    const counts: Record<string, number> = {
      alice: 3,
      bob: 0,
      carol: 5,
    };
    const { octokit } = makeOctokit(async ({ q }) => {
      const user = Object.keys(counts).find((u) => q.includes(`review-requested:${u}`))!;
      return { data: { total_count: counts[user] ?? 0 } };
    });

    const result = await getLoadMap(octokit, {
      whitelist: ['alice', 'bob', 'carol'],
      loadRepos: ['o/r'],
      windowDays: 21,
    });

    expect(result).toEqual({ alice: 3, bob: 0, carol: 5 });
  });

  it('fans out one call per whitelist user', async () => {
    const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
    const { octokit, issuesAndPullRequests } = makeOctokit(async () => ({
      data: { total_count: 0 },
    }));

    await getLoadMap(octokit, {
      whitelist: users,
      loadRepos: ['o/r'],
      windowDays: 21,
    });

    expect(issuesAndPullRequests).toHaveBeenCalledTimes(8);
  });

  it('gives a user load=0 when their query rejects; other users still tally', async () => {
    const { octokit } = makeOctokit(async ({ q }) => {
      if (q.includes('review-requested:bob')) {
        throw new Error('secondary rate limit');
      }
      if (q.includes('review-requested:alice')) {
        return { data: { total_count: 2 } };
      }
      return { data: { total_count: 7 } };
    });

    const result = await getLoadMap(octokit, {
      whitelist: ['alice', 'bob', 'carol'],
      loadRepos: ['o/r'],
      windowDays: 21,
    });

    expect(result).toEqual({ alice: 2, bob: 0, carol: 7 });
  });

  it('the `q` arg includes both review-requested:USER and reviewed-by:USER plus all repos', async () => {
    const { octokit, issuesAndPullRequests } = makeOctokit(async () => ({
      data: { total_count: 0 },
    }));

    await getLoadMap(octokit, {
      whitelist: ['alice'],
      loadRepos: ['test-org/repo-a', 'test-org/repo-b'],
      windowDays: 21,
    });

    expect(issuesAndPullRequests).toHaveBeenCalledTimes(1);
    const args = issuesAndPullRequests.mock.calls[0]![0] as SearchArgs;
    expect(args.q).toContain('review-requested:alice');
    expect(args.q).toContain('reviewed-by:alice');
    expect(args.q).toContain('repo:test-org/repo-a');
    expect(args.q).toContain('repo:test-org/repo-b');
    expect(args.per_page).toBe(1);
  });
});
