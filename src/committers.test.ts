import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRecentCommitters, MAX_FILES } from './committers';

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

type ListCommitsArgs = {
  owner: string;
  repo: string;
  path: string;
  since: string;
  per_page: number;
};

type CommitFixture = {
  author?: { login: string } | null;
  committer?: { login: string } | null;
};

function makeOctokit(
  handler: (args: ListCommitsArgs) => Promise<{ data: CommitFixture[] }>,
) {
  const listCommits = vi.fn(handler);
  return {
    octokit: {
      rest: {
        repos: {
          listCommits,
        },
      },
    } as unknown as Parameters<typeof getRecentCommitters>[0],
    listCommits,
  };
}

describe('getRecentCommitters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: tallies unique files per login across multiple files', async () => {
    const byPath: Record<string, CommitFixture[]> = {
      'src/a.ts': [
        { author: { login: 'alice' }, committer: { login: 'alice' } },
        { author: { login: 'bob' }, committer: { login: 'bob' } },
      ],
      'src/b.ts': [
        { author: { login: 'alice' }, committer: { login: 'alice' } },
        { author: { login: 'carol' }, committer: { login: 'carol' } },
      ],
    };
    const { octokit, listCommits } = makeOctokit(async ({ path }) => ({
      data: byPath[path] ?? [],
    }));

    const result = await getRecentCommitters(octokit, {
      owner: 'o',
      repo: 'r',
      files: ['src/a.ts', 'src/b.ts'],
      sinceDays: 30,
      whitelist: ['alice', 'bob', 'carol'],
    });

    expect(result).toEqual({ alice: 2, bob: 1, carol: 1 });
    expect(listCommits).toHaveBeenCalledTimes(2);
  });

  it('caps file lookups at MAX_FILES (20)', async () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const { octokit, listCommits } = makeOctokit(async () => ({ data: [] }));

    await getRecentCommitters(octokit, {
      owner: 'o',
      repo: 'r',
      files,
      sinceDays: 30,
      whitelist: ['alice'],
    });

    expect(listCommits).toHaveBeenCalledTimes(MAX_FILES);
    expect(MAX_FILES).toBe(20);
  });

  it('filters out commits by non-whitelisted users', async () => {
    const { octokit } = makeOctokit(async () => ({
      data: [
        { author: { login: 'alice' }, committer: { login: 'alice' } },
        { author: { login: 'stranger' }, committer: { login: 'stranger' } },
      ],
    }));

    const result = await getRecentCommitters(octokit, {
      owner: 'o',
      repo: 'r',
      files: ['src/a.ts'],
      sinceDays: 30,
      whitelist: ['alice'],
    });

    expect(result).toEqual({ alice: 1 });
    expect(result.stranger).toBeUndefined();
  });

  it('counts both author and committer separately when they differ', async () => {
    const { octokit } = makeOctokit(async () => ({
      data: [{ author: { login: 'A' }, committer: { login: 'B' } }],
    }));

    const result = await getRecentCommitters(octokit, {
      owner: 'o',
      repo: 'r',
      files: ['src/a.ts'],
      sinceDays: 30,
      whitelist: ['A', 'B'],
    });

    expect(result).toEqual({ A: 1, B: 1 });
  });

  it('does not double-count the same login across multiple commits on the same file', async () => {
    const { octokit } = makeOctokit(async () => ({
      data: [
        { author: { login: 'alice' }, committer: { login: 'alice' } },
        { author: { login: 'alice' }, committer: { login: 'alice' } },
        { author: { login: 'alice' }, committer: { login: 'alice' } },
      ],
    }));

    const result = await getRecentCommitters(octokit, {
      owner: 'o',
      repo: 'r',
      files: ['src/a.ts'],
      sinceDays: 30,
      whitelist: ['alice'],
    });

    expect(result).toEqual({ alice: 1 });
  });

  it('swallows per-file errors (does not throw; surviving files still tallied)', async () => {
    const { octokit, listCommits } = makeOctokit(async ({ path }) => {
      if (path === 'src/broken.ts') {
        throw new Error('404 not found');
      }
      return {
        data: [{ author: { login: 'alice' }, committer: { login: 'alice' } }],
      };
    });

    const result = await getRecentCommitters(octokit, {
      owner: 'o',
      repo: 'r',
      files: ['src/broken.ts', 'src/ok.ts'],
      sinceDays: 30,
      whitelist: ['alice'],
    });

    expect(result).toEqual({ alice: 1 });
    expect(listCommits).toHaveBeenCalledTimes(2);
  });

  it('computes `since` from sinceDays (ISO string within 1s of now - sinceDays*86400s)', async () => {
    const sinceDays = 21;
    const before = Date.now();
    const { octokit, listCommits } = makeOctokit(async () => ({ data: [] }));

    await getRecentCommitters(octokit, {
      owner: 'o',
      repo: 'r',
      files: ['src/a.ts'],
      sinceDays,
      whitelist: ['alice'],
    });
    const after = Date.now();

    expect(listCommits).toHaveBeenCalledTimes(1);
    const args = listCommits.mock.calls[0]![0] as { since: string; per_page: number };
    expect(args.per_page).toBe(10);

    const sinceMs = new Date(args.since).getTime();
    expect(Number.isFinite(sinceMs)).toBe(true);

    const lowerBound = before - sinceDays * 86400_000 - 1000;
    const upperBound = after - sinceDays * 86400_000 + 1000;
    expect(sinceMs).toBeGreaterThanOrEqual(lowerBound);
    expect(sinceMs).toBeLessThanOrEqual(upperBound);
  });
});
