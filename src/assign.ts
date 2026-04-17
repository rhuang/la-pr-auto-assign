/**
 * Request reviewers on the PR, post a one-line explanation comment, and write a
 * score table to the Actions run summary.
 */

import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';

import type { PRContext, AssignmentDecision, Vertical } from './types';

type Octokit = ReturnType<typeof getOctokit>;

function verticalLabel(v: Vertical | null): string {
  if (v === null) return 'none (fallback)';
  return v;
}

export function buildAssignmentComment(decision: AssignmentDecision): string {
  if (decision.chosen.length === 0) {
    return 'Auto-assign: no eligible reviewers found.';
  }

  const label = verticalLabel(decision.vertical);

  const lines = decision.chosen.map((login) => {
    const entry = decision.scored.find((c) => c.login === login);
    const committerFileCount = entry?.breakdown.committerFileCount ?? 0;
    const loadCount = entry?.breakdown.loadCount ?? 0;
    return `Assigned @${login} — vertical: ${label}, recent committer on ${committerFileCount} files, current load: ${loadCount}.`;
  });

  return lines.join('\n');
}

export async function assignReviewers(
  octokit: Octokit,
  prContext: PRContext,
  decision: AssignmentDecision,
): Promise<void> {
  if (decision.chosen.length === 0) {
    core.warning('Auto-assign: decision.chosen is empty; skipping reviewer request.');
    return;
  }

  // Primary action — allowed to throw; the workflow should fail if this fails.
  await octokit.rest.pulls.requestReviewers({
    owner: prContext.owner,
    repo: prContext.repo,
    pull_number: prContext.number,
    reviewers: decision.chosen,
  });

  const body = buildAssignmentComment(decision);

  try {
    await octokit.rest.issues.createComment({
      owner: prContext.owner,
      repo: prContext.repo,
      issue_number: prContext.number,
      body,
    });
  } catch (err) {
    core.warning(
      `Auto-assign: failed to post comment: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const rows = [
      ['Login', 'Score', 'Vertical-match', 'Committer-files', 'Load'],
      ...decision.scored.map((c) => [
        c.login,
        String(c.score),
        String(c.breakdown.verticalMatch),
        String(c.breakdown.committerFileCount),
        String(c.breakdown.loadCount),
      ]),
    ];

    const verticalLine = `Vertical: ${verticalLabel(decision.vertical)}`;
    const chosenLine = `Chosen: ${decision.chosen.map((l) => `@${l}`).join(', ')}`;

    await core.summary
      .addHeading('Reviewer assignment')
      .addRaw(`${verticalLine}\n\n${chosenLine}\n`)
      .addTable(rows)
      .write();
  } catch (err) {
    core.warning(
      `Auto-assign: failed to write summary: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
