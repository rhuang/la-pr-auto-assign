import * as yaml from 'js-yaml';
import type {
  Config,
  VerticalsConfig,
  VerticalEntry,
  AssignmentConfig,
  LoadRepo,
} from './types';

const ERR_PREFIX = 'Invalid auto-assign config:';

/**
 * Algorithm tuning lives in the action, not the team config. To change tuning,
 * edit these constants and bump the action tag. The team config (`la-team`)
 * only specifies *who* the reviewers are and *which repos* count toward load.
 */
const DEFAULT_ASSIGNMENT: Omit<AssignmentConfig, 'load_repos'> = {
  num_reviewers: 1,
  load_window_days: 10,
  weights: {
    vertical_match: 5,
    recent_committer: 2,
    load_penalty: 3,
  },
  fallback: {
    on_no_vertical: 'least_loaded',
  },
};

function fail(msg: string): never {
  throw new Error(`${ERR_PREFIX} ${msg}`);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function asRecord(v: unknown, field: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    fail(`${field} must be an object`);
  }
  return v as Record<string, unknown>;
}

function validateVerticalEntry(raw: unknown, name: string): VerticalEntry {
  const entry = asRecord(raw, `verticals.${name}`);
  const reviewers = entry.reviewers;
  if (!isStringArray(reviewers) || reviewers.length === 0) {
    fail(`verticals.${name}.reviewers must be a non-empty array of strings`);
  }
  return { reviewers };
}

function validateVerticals(raw: unknown): VerticalsConfig {
  const v = asRecord(raw, 'verticals');
  return {
    Professional: validateVerticalEntry(v.Professional, 'Professional'),
    Client: validateVerticalEntry(v.Client, 'Client'),
    Designer: validateVerticalEntry(v.Designer, 'Designer'),
  };
}

function validateLoadRepos(raw: unknown): LoadRepo[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('load_repos must be a non-empty array');
  }
  const out: LoadRepo[] = [];
  raw.forEach((entry, i) => {
    const obj = asRecord(entry, `load_repos[${i}]`);
    const repo = obj.repo;
    if (typeof repo !== 'string' || !/^[^\s/]+\/[^\s/]+$/.test(repo)) {
      fail(`load_repos[${i}].repo must be a string matching "owner/repo"`);
    }
    const users = obj.users;
    if (!isStringArray(users) || users.length === 0) {
      fail(`load_repos[${i}].users must be a non-empty array of strings`);
    }
    out.push({ repo, users });
  });
  return out;
}

function deriveWhitelist(verticals: VerticalsConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [verticals.Professional, verticals.Client, verticals.Designer]) {
    for (const login of v.reviewers) {
      if (!seen.has(login)) {
        seen.add(login);
        out.push(login);
      }
    }
  }
  return out;
}

/**
 * Parse and validate a team-config YAML string.
 *
 * Accepted top-level fields: `verticals`, `load_repos`. The candidate pool
 * (a.k.a. whitelist) is derived as the union of all vertical reviewer lists —
 * so every reviewer must belong to at least one vertical.
 */
export function parseConfig(yamlString: string): Config {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlString);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${ERR_PREFIX} YAML parse error: ${msg}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('top-level must be a mapping');
  }
  const root = parsed as Record<string, unknown>;

  const verticals = validateVerticals(root.verticals);
  const load_repos = validateLoadRepos(root.load_repos);
  const whitelist = deriveWhitelist(verticals);

  return {
    whitelist,
    verticals,
    assignment: { ...DEFAULT_ASSIGNMENT, load_repos },
  };
}
