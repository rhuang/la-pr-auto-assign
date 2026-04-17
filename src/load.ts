import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import type { LoadMap } from './types';

type Octokit = ReturnType<typeof getOctokit>;

/**
 * Computes per-user review load across `loadRepos` over the last `windowDays` days.
 *
 * For each user in `whitelist`, issues one Search API call:
 *   q = is:pr (review-requested:USER OR reviewed-by:USER) created:>=YYYY-MM-DD repo:R1 repo:R2
 *
 * Returns { login -> total_count } including zero counts for users with no hits.
 *
 * Errors on a single user's query are swallowed (logged via core.warning) and that user gets load=0,
 * which is actually pessimistic against the action's goals (they'll appear preferred) — so we also
 * record to a debug log. Don't fail the whole action.
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
      const q = buildSearchQuery(user, loadRepos, windowDays, now);
      try {
        const res = await octokit.rest.search.issuesAndPullRequests({
          q,
          per_page: 1,
        });
        const total = res.data?.total_count ?? 0;
        return [user, total];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`load search failed for user "${user}": ${msg}`);
        core.debug(`failed query was: ${q}`);
        return [user, 0];
      }
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
 *   `is:pr (review-requested:USER OR reviewed-by:USER) created:>=YYYY-MM-DD repo:R1 repo:R2`
 *
 * The date is `now - windowDays` days, formatted `YYYY-MM-DD` (UTC date only).
 */
export function buildSearchQuery(
  user: string,
  loadRepos: string[],
  windowDays: number,
  now: Date = new Date(),
): string {
  const since = new Date(now.getTime() - windowDays * 86400_000);
  const dateStr = since.toISOString().slice(0, 10);

  const parts = [
    'is:pr',
    `(review-requested:${user} OR reviewed-by:${user})`,
    `created:>=${dateStr}`,
  ];
  if (loadRepos.length > 0) {
    parts.push(loadRepos.map((r) => `repo:${r}`).join(' '));
  }
  return parts.join(' ');
}
