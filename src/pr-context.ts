import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import type { PRContext, LinkedIssueRef, LinkedIssue } from './types';

type Octokit = ReturnType<typeof getOctokit>;

export const DIFF_MAX_BYTES = 30 * 1024;
export const MAX_FILES_CAP = 300;
const PER_PAGE = 100;
const MAX_PAGES = Math.ceil(MAX_FILES_CAP / PER_PAGE);

const ISSUE_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

/**
 * Parse linked-issue references from a PR body.
 */
export function parseLinkedIssueRefs(
  body: string,
  defaultOwner: string,
  defaultRepo: string,
): LinkedIssueRef[] {
  if (!body) return [];
  // Local, non-stateful regex: safer than a module-level /g regex shared across async callers.
  const re = new RegExp(
    `\\b(?:${ISSUE_KEYWORDS.join('|')})\\b\\s*:?\\s*(?:([A-Za-z0-9][A-Za-z0-9-_.]*)\\/([A-Za-z0-9][A-Za-z0-9-_.]*))?#(\\d+)`,
    'gi',
  );
  const out: LinkedIssueRef[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(re)) {
    const owner = m[1] ?? defaultOwner;
    const repo = m[2] ?? defaultRepo;
    const number = parseInt(m[3], 10);
    const key = `${owner}/${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, repo, number });
  }
  return out;
}

function hasStatus(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: unknown }).status === status
  );
}

async function fetchLinkedIssue(
  octokit: Octokit,
  ref: LinkedIssueRef | undefined,
): Promise<LinkedIssue | null> {
  if (!ref) return null;
  try {
    const resp = await octokit.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
    });
    return {
      ref,
      title: resp.data.title ?? '',
      body: resp.data.body ?? '',
    };
  } catch (err) {
    if (hasStatus(err, 404)) return null;
    throw err;
  }
}

async function fetchChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<Array<{ filename: string; patch?: string }>> {
  const files: Array<{ filename: string; patch?: string }> = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: number,
      per_page: PER_PAGE,
      page,
    });
    const data = resp.data as Array<{ filename: string; patch?: string }>;
    for (const f of data) files.push({ filename: f.filename, patch: f.patch });
    if (data.length < PER_PAGE) return files;
  }
  // Reached the page cap with a full last page — there may be more files the action won't see.
  core.warning(
    `listFiles: PR has more than ${MAX_FILES_CAP} files; only the first ${MAX_FILES_CAP} are considered for committer / diff signals.`,
  );
  return files;
}

/**
 * Fetch PR, changed files, diff, and the first linked issue (if any).
 */
export async function fetchPRContext(
  octokit: Octokit,
  params: { owner: string; repo: string; number: number },
): Promise<PRContext> {
  const { owner, repo, number } = params;

  const prResp = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  const pr = prResp.data;
  const body = pr.body ?? '';
  const refs = parseLinkedIssueRefs(body, owner, repo);

  // listFiles and the linked-issue fetch are independent — run them in parallel.
  const [files, linkedIssue] = await Promise.all([
    fetchChangedFiles(octokit, owner, repo, number),
    fetchLinkedIssue(octokit, refs[0]),
  ]);

  const changedFiles = files.map((f) => f.filename);
  const diff = files
    .map((f) => f.patch)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join('\n')
    .slice(0, DIFF_MAX_BYTES);

  return {
    owner,
    repo,
    number,
    headSha: pr.head.sha,
    author: pr.user?.login ?? '',
    title: pr.title ?? '',
    body,
    changedFiles,
    diff,
    linkedIssue,
  };
}
