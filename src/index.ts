/**
 * Entry point for the la-pr-auto-assign action.
 *
 * Orchestration:
 *   1. Load config (auto-assign.yml from the action repo, via GITHUB_ACTION_PATH)
 *   2. Fetch PR context (PR + changed files + linked issue + truncated diff)
 *   3. Run three independent signals in parallel:
 *        - classifyVertical (LLM)
 *        - getRecentCommitters (Octokit listCommits per file)
 *        - getLoadMap (Octokit search)
 *   4. Score candidates and pick the top N
 *   5. Assign: requestReviewers + comment + Actions summary
 *
 * The action uses up to two tokens:
 *   - github-token  (workflow token, has pull-requests: write) — used for write ops
 *                   (requestReviewers, createComment) and same-repo reads.
 *   - load-token    (optional PAT) — used for read operations. In the current
 *                   implementation this should be a classic PAT with `repo`
 *                   scope that can read the config repo, any `load_repos`, and
 *                   the current consumer repo. Falls back to github-token.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';

import { parseConfig } from './config';
import { fetchConfigYaml } from './fetch-config';
import { fetchPRContext } from './pr-context';
import { classifyVertical } from './vertical';
import { getRecentCommitters } from './committers';
import { getLoadMap } from './load';
import { pickReviewers } from './score';
import { assignReviewers } from './assign';

/** Committer-signal lookback window. Separate from load window per plan §4. */
const COMMITTER_WINDOW_DAYS = 90;

export async function run(): Promise<void> {
  try {
    const anthropicApiKey = core.getInput('anthropic-api-key', { required: true });
    const configRepo = core.getInput('config-repo', { required: true });
    const configPath = core.getInput('config-path') || 'team.yml';
    const configRef = core.getInput('config-ref') || undefined;

    const githubToken =
      core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    if (!githubToken) {
      throw new Error(
        'github-token is required (no github-token input and no GITHUB_TOKEN env var)',
      );
    }
    const loadTokenInput = core.getInput('load-token');

    const writeOctokit = github.getOctokit(githubToken);
    const readOctokit = loadTokenInput
      ? github.getOctokit(loadTokenInput)
      : writeOctokit;

    const ctx = github.context;
    if (ctx.eventName !== 'pull_request') {
      core.info(
        `Skipping: event is "${ctx.eventName}" (only pull_request is supported).`,
      );
      return;
    }
    const prNumber = ctx.payload.pull_request?.number;
    if (typeof prNumber !== 'number') {
      throw new Error('pull_request.number not found in event payload');
    }

    const configYaml = await fetchConfigYaml(readOctokit, {
      repoSpec: configRepo,
      path: configPath,
      ref: configRef,
    });
    const config = parseConfig(configYaml);

    // Load-map search has no PR-context dependency, so kick it off as soon as config
    // is parsed and let it race the PR / file fetches.
    const loadPromise = getLoadMap(readOctokit, {
      whitelist: config.whitelist,
      loadRepos: config.assignment.load_repos,
      windowDays: config.assignment.load_window_days,
    });

    const prContext = await fetchPRContext(readOctokit, {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      number: prNumber,
    });
    const linkedRef = prContext.linkedIssue
      ? `${prContext.linkedIssue.ref.owner}/${prContext.linkedIssue.ref.repo}#${prContext.linkedIssue.ref.number}`
      : 'none';
    core.info(
      `PR #${prContext.number} by @${prContext.author}: ${prContext.changedFiles.length} files changed, linkedIssue=${linkedRef}`,
    );

    const [vertical, committers, load] = await Promise.all([
      classifyVertical(anthropicApiKey, prContext),
      getRecentCommitters(readOctokit, {
        owner: prContext.owner,
        repo: prContext.repo,
        files: prContext.changedFiles,
        sinceDays: COMMITTER_WINDOW_DAYS,
        whitelist: config.whitelist,
      }),
      loadPromise,
    ]);
    core.info(`Vertical: ${vertical ?? 'none (fallback)'}`);

    const decision = pickReviewers({
      config,
      prAuthor: prContext.author,
      vertical,
      committers,
      load,
    });

    if (decision.chosen.length === 0) {
      core.warning('No eligible reviewers found; nothing to assign.');
      return;
    }

    core.info(`Chosen: ${decision.chosen.map((l) => `@${l}`).join(', ')}`);

    await assignReviewers(writeOctokit, prContext, decision);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.setFailed(msg);
  }
}

/* istanbul ignore next -- only executed when invoked as the GitHub Action entry */
if (require.main === module) {
  void run();
}
