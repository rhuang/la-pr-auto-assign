import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  AssignmentDecision,
  PRContext,
  ScoredCandidate,
} from './types';

const { mockRequestReviewers, mockCreateComment, mockSummary } = vi.hoisted(() => ({
  mockRequestReviewers: vi.fn(),
  mockCreateComment: vi.fn(),
  mockSummary: {
    addHeading: vi.fn(),
    addRaw: vi.fn(),
    addTable: vi.fn(),
    write: vi.fn(),
  },
}));

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  summary: mockSummary,
}));

// Import AFTER vi.mock so the module under test gets the mocked core.
import * as core from '@actions/core';
import { assignReviewers, buildAssignmentComment } from './assign';

function makeOctokit() {
  return {
    rest: {
      pulls: {
        requestReviewers: mockRequestReviewers,
      },
      issues: {
        createComment: mockCreateComment,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    owner: 'test-org',
    repo: 'repo-a',
    number: 42,
    headSha: 'deadbeef',
    author: 'external-contrib',
    title: 'Some PR',
    body: 'Body',
    changedFiles: ['a.ts', 'b.ts'],
    diff: '',
    linkedIssue: null,
    ...overrides,
  };
}

function scoredFor(
  login: string,
  opts: { committerFileCount?: number; loadCount?: number; inVertical?: boolean } = {},
): ScoredCandidate {
  const committerFileCount = opts.committerFileCount ?? 0;
  const loadCount = opts.loadCount ?? 0;
  const inVertical = opts.inVertical ?? true;
  const verticalMatch = inVertical ? 5 : 0;
  const committerBonus = committerFileCount * 2;
  const loadPenalty = loadCount * 3;
  return {
    login,
    score: verticalMatch + committerBonus - loadPenalty,
    breakdown: {
      verticalMatch,
      committerBonus,
      loadPenalty,
      loadCount,
      committerFileCount,
      inVertical,
    },
  };
}

beforeEach(() => {
  mockRequestReviewers.mockReset();
  mockCreateComment.mockReset();
  mockSummary.addHeading.mockReset();
  mockSummary.addRaw.mockReset();
  mockSummary.addTable.mockReset();
  mockSummary.write.mockReset();
  // Default: chainable
  mockSummary.addHeading.mockReturnValue(mockSummary);
  mockSummary.addRaw.mockReturnValue(mockSummary);
  mockSummary.addTable.mockReturnValue(mockSummary);
  mockSummary.write.mockResolvedValue(undefined);

  mockRequestReviewers.mockResolvedValue({});
  mockCreateComment.mockResolvedValue({});

  (core.warning as unknown as ReturnType<typeof vi.fn>).mockReset();
  (core.info as unknown as ReturnType<typeof vi.fn>).mockReset();
  (core.debug as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe('assignReviewers', () => {
  it('calls requestReviewers with owner, repo, pull_number, reviewers', async () => {
    const octokit = makeOctokit();
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: ['alice'],
      scored: [scoredFor('alice', { loadCount: 1, committerFileCount: 2 })],
      vertical: 'Professional',
    };

    await assignReviewers(octokit, prContext, decision);

    expect(mockRequestReviewers).toHaveBeenCalledTimes(1);
    expect(mockRequestReviewers).toHaveBeenCalledWith({
      owner: 'test-org',
      repo: 'repo-a',
      pull_number: 42,
      reviewers: ['alice'],
    });
  });

  it('calls createComment with the body produced by buildAssignmentComment', async () => {
    const octokit = makeOctokit();
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: ['alice'],
      scored: [scoredFor('alice', { loadCount: 1, committerFileCount: 2 })],
      vertical: 'Professional',
    };

    await assignReviewers(octokit, prContext, decision);

    const expectedBody = buildAssignmentComment(decision);
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'test-org',
      repo: 'repo-a',
      issue_number: 42,
      body: expectedBody,
    });
  });

  it('writes summary with a row per scored candidate', async () => {
    const octokit = makeOctokit();
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: ['alice'],
      scored: [
        scoredFor('alice', { loadCount: 1, committerFileCount: 2 }),
        scoredFor('bob', { loadCount: 0, committerFileCount: 0, inVertical: false }),
      ],
      vertical: 'Professional',
    };

    await assignReviewers(octokit, prContext, decision);

    expect(mockSummary.addHeading).toHaveBeenCalledWith('Reviewer assignment');
    expect(mockSummary.addTable).toHaveBeenCalledTimes(1);
    const tableArg = mockSummary.addTable.mock.calls[0]![0] as string[][];
    // Header + one row per scored candidate
    expect(tableArg).toHaveLength(decision.scored.length + 1);
    expect(tableArg[0]).toEqual([
      'Login',
      'Score',
      'Vertical-match',
      'Committer-files',
      'Load',
    ]);
    expect(tableArg[1]![0]).toBe('alice');
    expect(tableArg[2]![0]).toBe('bob');
    expect(mockSummary.write).toHaveBeenCalledTimes(1);
  });

  it('no-ops with a warning when decision.chosen is empty', async () => {
    const octokit = makeOctokit();
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: [],
      scored: [],
      vertical: 'Professional',
    };

    await assignReviewers(octokit, prContext, decision);

    expect(mockRequestReviewers).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalled();
  });

  it('does NOT throw when summary.write rejects (best-effort)', async () => {
    mockSummary.write.mockRejectedValueOnce(new Error('boom'));
    const octokit = makeOctokit();
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: ['alice'],
      scored: [scoredFor('alice')],
      vertical: 'Professional',
    };

    await expect(
      assignReviewers(octokit, prContext, decision),
    ).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalled();
  });

  it('DOES throw when requestReviewers rejects (bubbles up)', async () => {
    mockRequestReviewers.mockRejectedValueOnce(new Error('API down'));
    const octokit = makeOctokit();
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: ['alice'],
      scored: [scoredFor('alice')],
      vertical: 'Professional',
    };

    await expect(
      assignReviewers(octokit, prContext, decision),
    ).rejects.toThrow('API down');
  });
});

describe('buildAssignmentComment', () => {
  it('formats a single-reviewer case exactly', () => {
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: ['alice'],
      scored: [scoredFor('alice', { loadCount: 1, committerFileCount: 2 })],
      vertical: 'Professional',
    };
    const body = buildAssignmentComment(decision);
    expect(body).toBe(
      'Assigned @alice — vertical: Professional, recent committer on 2 files, current load: 1.',
    );
  });

  it('uses "none (fallback)" when vertical is null', () => {
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: ['alice'],
      scored: [
        scoredFor('alice', {
          loadCount: 0,
          committerFileCount: 0,
          inVertical: false,
        }),
      ],
      vertical: null,
    };
    const body = buildAssignmentComment(decision);
    expect(body).toBe(
      'Assigned @alice — vertical: none (fallback), recent committer on 0 files, current load: 0.',
    );
  });

  it('returns the "no eligible reviewers" message when chosen is empty', () => {
    const prContext = makePRContext();
    const decision: AssignmentDecision = {
      chosen: [],
      scored: [],
      vertical: 'Professional',
    };
    const body = buildAssignmentComment(decision);
    expect(body).toBe('Auto-assign: no eligible reviewers found.');
  });
});
