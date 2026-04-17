/**
 * Pure scoring logic. No side effects; imports only types.
 */

import type {
  ScoreInput,
  ScoredCandidate,
  AssignmentDecision,
  ScoreBreakdown,
} from './types';

/**
 * Score all whitelist members (minus the PR author) against the given signals.
 * Returned array is sorted DESCENDING by score, with deterministic tie-breaking:
 *   1. Higher score first.
 *   2. Lower loadCount first (less-loaded preferred on ties).
 *   3. Alphabetical (lowercase) login.
 */
export function scoreCandidates(input: ScoreInput): ScoredCandidate[] {
  const { config, prAuthor, vertical, committers, load } = input;
  const weights = config.assignment.weights;

  const verticalReviewers =
    vertical !== null ? config.verticals[vertical].reviewers : [];

  const pool = config.whitelist.filter((login) => login !== prAuthor);

  const scored: ScoredCandidate[] = pool.map((login) => {
    const inVertical = vertical !== null && verticalReviewers.includes(login);
    const committerFileCount = vertical !== null ? committers[login] ?? 0 : 0;
    const loadCount = load[login] ?? 0;

    const verticalMatch = inVertical ? weights.vertical_match : 0;
    const committerBonus =
      vertical !== null ? committerFileCount * weights.recent_committer : 0;
    const loadPenalty = loadCount * weights.load_penalty;

    const score = verticalMatch + committerBonus - loadPenalty;

    const breakdown: ScoreBreakdown = {
      verticalMatch,
      committerBonus,
      loadPenalty,
      loadCount,
      committerFileCount,
      inVertical,
    };

    return { login, score, breakdown };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.breakdown.loadCount !== b.breakdown.loadCount) {
      return a.breakdown.loadCount - b.breakdown.loadCount;
    }
    const al = a.login.toLowerCase();
    const bl = b.login.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  });

  return scored;
}

/**
 * Pick the top N reviewers using the same ordering.
 */
export function pickReviewers(input: ScoreInput): AssignmentDecision {
  const scored = scoreCandidates(input);
  const n = input.config.assignment.num_reviewers;
  const chosen = scored.slice(0, n).map((c) => c.login);

  return {
    chosen,
    scored,
    vertical: input.vertical,
  };
}
