import type { getOctokit } from '@actions/github';

type Octokit = ReturnType<typeof getOctokit>;

/**
 * Fetch the raw YAML string for the config file from a (typically private) repo.
 * The caller must pass an octokit built from a token that can read that repo.
 *
 * `repoSpec` format: `owner/repo`.
 * `path` is the file path inside the repo (e.g. `auto-assign.yml`).
 * `ref` is an optional branch/tag/SHA; omit to read the default branch.
 */
export async function fetchConfigYaml(
  octokit: Octokit,
  params: { repoSpec: string; path: string; ref?: string },
): Promise<string> {
  const { repoSpec, path, ref } = params;
  const parts = repoSpec.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `config-repo must be in "owner/repo" form (got "${repoSpec}")`,
    );
  }
  const [owner, repo] = parts;

  const resp = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    ...(ref ? { ref } : {}),
  });

  const data = resp.data as {
    type?: string;
    encoding?: string;
    content?: string;
  };
  if (data.type !== 'file' || typeof data.content !== 'string') {
    throw new Error(
      `config-repo ${repoSpec}:${path} is not a file (got type="${data.type}")`,
    );
  }

  const encoding = data.encoding ?? 'base64';
  if (encoding !== 'base64') {
    throw new Error(
      `config-repo ${repoSpec}:${path} has unsupported encoding "${encoding}"`,
    );
  }

  return Buffer.from(data.content, 'base64').toString('utf8');
}
