/**
 * Shared types for the la-pr-auto-assign action.
 * Every module in src/ imports from this file; do not redefine these types.
 */

/**
 * The three verticals the LLM can classify a PR into. `null` means the LLM
 * could not confidently classify the PR (or we failed to call it) and the
 * fallback path (`on_no_vertical`) should be taken.
 */
export const VERTICALS = ['Professional', 'Client', 'Designer'] as const;
export type Vertical = (typeof VERTICALS)[number];

export interface VerticalEntry {
  reviewers: string[];
}

export interface VerticalsConfig {
  Professional: VerticalEntry;
  Client: VerticalEntry;
  Designer: VerticalEntry;
}

export interface AssignmentWeights {
  /** Added once if candidate is in the matched vertical's reviewer list. */
  vertical_match: number;
  /** Multiplied by number of changed files the candidate recently committed to. */
  recent_committer: number;
  /** Multiplied by candidate's load count (review requests + completed reviews in window). */
  load_penalty: number;
}

export interface AssignmentFallback {
  /** Behavior when the LLM can't classify a vertical. Only `least_loaded` is supported. */
  on_no_vertical: 'least_loaded';
}

/**
 * One repo plus the GitHub logins associated with it. The `users` list serves
 * two purposes: (1) load-counting — a user only appears in the load search
 * for repos where they're listed; (2) eligibility — when a PR is opened in
 * this repo, only listed users can be picked as reviewers. A user not listed
 * for a given repo therefore neither reviews PRs there nor accrues load from it.
 */
export interface LoadRepo {
  /** Format: "owner/repo". */
  repo: string;
  /** GitHub logins eligible to review in this repo. */
  users: string[];
}

export interface AssignmentConfig {
  /** Number of reviewers to request. Currently locked to 1. */
  num_reviewers: number;
  /** Trailing window (days) used for both load calculation and committer lookups. */
  load_window_days: number;
  /** Repos to include in load search queries, each with its own user whitelist. */
  load_repos: LoadRepo[];
  weights: AssignmentWeights;
  fallback: AssignmentFallback;
}

export interface Config {
  whitelist: string[];
  verticals: VerticalsConfig;
  /**
   * GitHub logins whose PRs should be skipped entirely — no reviewer will be
   * assigned when they open a PR. Matched case-insensitively against the PR
   * author. Always an array; empty when the field is omitted.
   */
  ignore_authors: string[];
  assignment: AssignmentConfig;
}

export interface LinkedIssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface LinkedIssue {
  ref: LinkedIssueRef;
  title: string;
  body: string;
}

export interface PRContext {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  /** Login of the PR author. Excluded from the candidate pool. */
  author: string;
  title: string;
  body: string;
  /** Paths of files changed in the PR. */
  changedFiles: string[];
  /** Concatenated unified-diff patches for the PR, truncated to ~30KB. */
  diff: string;
  /**
   * The issue referenced by the PR body's "closes/fixes/resolves #N" (or
   * `owner/repo#N`) clause. `null` if no such clause was found or the issue
   * couldn't be fetched.
   */
  linkedIssue: LinkedIssue | null;
}

/** login -> count of (review-requested OR reviewed-by) PRs in the load window across load_repos. */
export type LoadMap = Record<string, number>;

/** login -> count of files in the current PR the user has recently committed to. */
export type CommitterMap = Record<string, number>;

export interface ScoreInput {
  config: Config;
  prAuthor: string;
  /** `null` triggers the `on_no_vertical` fallback path. */
  vertical: Vertical | null;
  committers: CommitterMap;
  load: LoadMap;
  /**
   * If provided, the candidate pool is restricted to whitelist members who
   * also appear here. Used to gate eligibility per current repo (the matching
   * `load_repos[i].users` list). Omit to consider the full whitelist.
   */
  eligibleLogins?: string[];
}

export interface ScoreBreakdown {
  /** Contribution from vertical_match weight (0 or weights.vertical_match). */
  verticalMatch: number;
  /** Contribution from recent_committer weight (committerFileCount * weight). */
  committerBonus: number;
  /** Penalty from load (negative or zero; loadCount * weight, subtracted). */
  loadPenalty: number;
  /** Raw load count used for the penalty. */
  loadCount: number;
  /** Raw number of files the candidate recently committed to. */
  committerFileCount: number;
  /** Whether the candidate was in the matched vertical's reviewer list. */
  inVertical: boolean;
}

export interface ScoredCandidate {
  login: string;
  /** Final numeric score. Higher = more preferred. */
  score: number;
  breakdown: ScoreBreakdown;
}

export interface AssignmentDecision {
  /** Logins that should be requested as reviewers (length = num_reviewers). */
  chosen: string[];
  /** Full scored candidate list, sorted descending by score. */
  scored: ScoredCandidate[];
  /** The vertical used in scoring. `null` means the fallback path was taken. */
  vertical: Vertical | null;
}
