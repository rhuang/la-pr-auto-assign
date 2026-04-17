import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import type { CommitterMap } from './types';

type Octokit = ReturnType<typeof getOctokit>;

/** Maximum number of changed files we look up committers for per PR. */
export const MAX_FILES = 20;

/**
 * For each file (capped at MAX_FILES), calls `repos.listCommits({owner, repo, path, since, per_page: 10})`
 * and tallies commit authors/committers that appear in `whitelist`.
 *
 * `since` = now() - sinceDays (ISO string).
 *
 * Returns a map { login -> count }. A login is counted once per file in which they committed
 * (regardless of how many commits they made to that file), so the map value equals "# of
 * changed files the user recently touched" — which is what the scorer multiplies by.
 *
 * Errors on individual file lookups are swallowed (logged via core.warning) so one 404 doesn't
 * sink the whole signal.
 */
export async function getRecentCommitters(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    files: string[];
    sinceDays: number;
    whitelist: string[];
  },
): Promise<CommitterMap> {
  const { owner, repo, files, sinceDays, whitelist } = params;
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const whitelistSet = new Set(whitelist);
  const limitedFiles = files.slice(0, MAX_FILES);

  const perFileLogins = await Promise.all(
    limitedFiles.map(async (path): Promise<Set<string>> => {
      try {
        const res = await octokit.rest.repos.listCommits({
          owner,
          repo,
          path,
          since,
          per_page: 10,
        });
        const logins = new Set<string>();
        const commits = res.data ?? [];
        for (const commit of commits) {
          const authorLogin = commit.author?.login;
          const committerLogin = commit.committer?.login;
          if (authorLogin && whitelistSet.has(authorLogin)) {
            logins.add(authorLogin);
          }
          if (committerLogin && whitelistSet.has(committerLogin)) {
            logins.add(committerLogin);
          }
        }
        return logins;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`listCommits failed for ${owner}/${repo} path="${path}": ${msg}`);
        return new Set<string>();
      }
    }),
  );

  const tally: CommitterMap = {};
  for (const logins of perFileLogins) {
    for (const login of logins) {
      tally[login] = (tally[login] ?? 0) + 1;
    }
  }

  core.info(
    `Committers (window=${sinceDays}d, files=${limitedFiles.length}/${files.length}):`,
  );
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    core.info('  (no whitelisted committers matched)');
  } else {
    for (const [login, count] of sorted) {
      core.info(`  ${login}: ${count} files`);
    }
  }
  return tally;
}
