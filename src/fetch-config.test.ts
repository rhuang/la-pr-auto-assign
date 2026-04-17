import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchConfigYaml } from './fetch-config';

function makeOctokit(getContent: ReturnType<typeof vi.fn>) {
  return {
    rest: {
      repos: { getContent },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

describe('fetchConfigYaml', () => {
  let getContent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getContent = vi.fn();
  });

  it('fetches, decodes, and returns the YAML string', async () => {
    const yaml = 'whitelist:\n  - alice\n';
    getContent.mockResolvedValue({
      data: { type: 'file', encoding: 'base64', content: b64(yaml) },
    });

    const result = await fetchConfigYaml(makeOctokit(getContent), {
      repoSpec: 'owner/config-repo',
      path: 'auto-assign.yml',
    });

    expect(result).toBe(yaml);
    expect(getContent).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'config-repo',
      path: 'auto-assign.yml',
    });
  });

  it('passes ref through when provided', async () => {
    getContent.mockResolvedValue({
      data: { type: 'file', encoding: 'base64', content: b64('a: 1') },
    });

    await fetchConfigYaml(makeOctokit(getContent), {
      repoSpec: 'owner/repo',
      path: 'cfg.yml',
      ref: 'v2',
    });

    expect(getContent).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      path: 'cfg.yml',
      ref: 'v2',
    });
  });

  it('rejects malformed repoSpec', async () => {
    await expect(
      fetchConfigYaml(makeOctokit(getContent), {
        repoSpec: 'just-one-part',
        path: 'auto-assign.yml',
      }),
    ).rejects.toThrow(/config-repo must be in "owner\/repo" form/);
    expect(getContent).not.toHaveBeenCalled();
  });

  it('throws when the path is a directory, not a file', async () => {
    getContent.mockResolvedValue({
      data: [{ type: 'file', name: 'a.yml' }],
    });
    await expect(
      fetchConfigYaml(makeOctokit(getContent), {
        repoSpec: 'owner/repo',
        path: '.',
      }),
    ).rejects.toThrow(/not a file/);
  });

  it('throws on unsupported encoding', async () => {
    getContent.mockResolvedValue({
      data: { type: 'file', encoding: 'utf8', content: 'plaintext' },
    });
    await expect(
      fetchConfigYaml(makeOctokit(getContent), {
        repoSpec: 'owner/repo',
        path: 'cfg.yml',
      }),
    ).rejects.toThrow(/unsupported encoding/);
  });

  it('propagates Octokit errors (e.g. 404)', async () => {
    getContent.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(
      fetchConfigYaml(makeOctokit(getContent), {
        repoSpec: 'owner/repo',
        path: 'missing.yml',
      }),
    ).rejects.toThrow('Not Found');
  });
});
