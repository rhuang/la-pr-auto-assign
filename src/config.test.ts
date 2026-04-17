import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseConfig } from './config';

const REPO_ROOT = path.resolve(__dirname, '..');

const VALID_YAML = `
verticals:
  Professional:
    reviewers: [alice, bob]
  Client:
    reviewers: [carol]
  Designer:
    reviewers: [carol, dave]
load_repos:
  - repo: org/repo-a
    users: [alice, bob, carol]
  - repo: org/repo-b
    users: [carol, dave]
`;

describe('parseConfig', () => {
  it('parses the sample YAML shipped in this repo', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, 'team.sample.yml'),
      'utf8',
    );
    const cfg = parseConfig(raw);
    expect(cfg.whitelist.length).toBeGreaterThan(0);
    expect(cfg.verticals.Professional.reviewers.length).toBeGreaterThan(0);
    expect(cfg.assignment.load_repos.length).toBeGreaterThan(0);
  });

  it('derives whitelist as the deduplicated union of vertical reviewers', () => {
    const cfg = parseConfig(VALID_YAML);
    // alice+bob from Professional, carol from Client, carol+dave from Designer → alice, bob, carol, dave
    expect(cfg.whitelist).toEqual(['alice', 'bob', 'carol', 'dave']);
  });

  it('fills in default assignment tuning and merges load_repos', () => {
    const cfg = parseConfig(VALID_YAML);
    expect(cfg.assignment.load_repos).toEqual([
      { repo: 'org/repo-a', users: ['alice', 'bob', 'carol'] },
      { repo: 'org/repo-b', users: ['carol', 'dave'] },
    ]);
    expect(cfg.assignment.num_reviewers).toBe(1);
    expect(cfg.assignment.load_window_days).toBe(10);
    expect(cfg.assignment.weights.vertical_match).toBe(5);
    expect(cfg.assignment.weights.recent_committer).toBe(2);
    expect(cfg.assignment.weights.load_penalty).toBe(3);
    expect(cfg.assignment.fallback.on_no_vertical).toBe('least_loaded');
  });

  it('rejects a vertical with an empty reviewers list', () => {
    const bad = VALID_YAML.replace('reviewers: [alice, bob]', 'reviewers: []');
    expect(() => parseConfig(bad)).toThrow(/Professional.*reviewers.*non-empty/);
  });

  it('rejects missing verticals', () => {
    expect(() => parseConfig('load_repos:\n  - org/repo-a\n')).toThrow(/verticals/);
  });

  it('rejects missing load_repos', () => {
    const bad = VALID_YAML.replace(/load_repos:[\s\S]*$/, '');
    expect(() => parseConfig(bad)).toThrow(/load_repos/);
  });

  it('rejects a load_repos entry whose repo is not owner/repo', () => {
    const bad = VALID_YAML.replace('repo: org/repo-a', 'repo: just-one-part');
    expect(() => parseConfig(bad)).toThrow(/load_repos\[0\]\.repo/);
  });

  it('rejects a load_repos entry with no users', () => {
    const bad = VALID_YAML.replace(
      'users: [alice, bob, carol]',
      'users: []',
    );
    expect(() => parseConfig(bad)).toThrow(/load_repos\[0\]\.users.*non-empty/);
  });

  it('rejects a load_repos entry that is missing the users field', () => {
    const bad = `
verticals:
  Professional:
    reviewers: [alice]
  Client:
    reviewers: [bob]
  Designer:
    reviewers: [bob]
load_repos:
  - repo: org/repo-a
`;
    expect(() => parseConfig(bad)).toThrow(/load_repos\[0\]\.users/);
  });

  it('rejects malformed YAML', () => {
    expect(() =>
      parseConfig('verticals: :\n  bad: ['),
    ).toThrow(/Invalid auto-assign config:/);
  });
});
