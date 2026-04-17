import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import type { LoadMap } from './types';

type Octokit = ReturnType<typeof getOctokit>;

export type LoadQualifier = 'review-requested' | 'reviewed-by';

const QUALIFIERS: readonly LoadQualifier[] = ['review-requested', 'reviewed-by'];

/**
 * Computes per-user review load across `loadRepos` over the last `windowDays` days.
 *
 * For each user in `whitelist`, issues two Search API calls — one per qualifier —
 * and sums their `total_count`s:
 *   q = is:pr review-requested:USER created:>=YYYY-MM-DD repo:R1 repo:R2
 *   q = is:pr reviewed-by:USER     created:>=YYYY-MM-DD repo:R1 repo:R2
 *
 * The OR compound `(review-requested:X OR reviewed-by:X)` is avoided: Search
 * rejects it with 422 "users cannot be searched" for some logins even when each
 * qualifier succeeds alone.
 *
 * Returns { login -> total_count } including zero counts for users with no hits.
 *
 * A sub-query failure is swallowed (logged via core.warning) and contributes 0
 * to that user's total, so a partial outage still lets the other qualifier count.
 */
export async function getLoadMap(
  octokit: Octokit,
  params: {
    whitelist: string[];
    loadRepos: string[];
    windowDays: number;
  },
): Promise<LoadMap> {
  const { whitelist, loadRepos, windowDays } = params;
  const now = new Date();

  const entries = await Promise.all(
    whitelist.map(async (user): Promise<[string, number]> => {
      const subTotals = await Promise.all(
        QUALIFIERS.map(async (qualifier) => {
          const q = buildSearchQuery(user, qualifier, loadRepos, windowDays, now);
          try {
            const res = await octokit.rest.search.issuesAndPullRequests({
              q,
              per_page: 1,
            });
            return res.data?.total_count ?? 0;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            core.warning(
              `load search failed for user "${user}" (${qualifier}): ${msg}`,
            );
            core.debug(`failed query was: ${q}`);
            return 0;
          }
        }),
      );
      return [user, subTotals.reduce((a, b) => a + b, 0)];
    }),
  );

  const map: LoadMap = {};
  for (const [login, count] of entries) {
    map[login] = count;
  }
  return map;
}

/**
 * Builds the GitHub Search API query string used by `getLoadMap`.
 *
 * Exported for unit testing. Format:
 *   `is:pr <qualifier>:USER created:>=YYYY-MM-DD repo:R1 repo:R2`
 *
 * The date is `now - windowDays` days, formatted `YYYY-MM-DD` (UTC date only).
 */
export function buildSearchQuery(
  user: string,
  qualifier: LoadQualifier,
  loadRepos: string[],
  windowDays: number,
  now: Date = new Date(),
): string {
  const since = new Date(now.getTime() - windowDays * 86400_000);
  const dateStr = since.toISOString().slice(0, 10);

  const parts = [
    'is:pr',
    `${qualifier}:${user}`,
    `created:>=${dateStr}`,
  ];
  if (loadRepos.length > 0) {
    parts.push(loadRepos.map((r) => `repo:${r}`).join(' '));
  }
  return parts.join(' ');
}
