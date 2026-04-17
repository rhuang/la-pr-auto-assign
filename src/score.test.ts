import { describe, it, expect } from 'vitest';
import { scoreCandidates, pickReviewers } from './score';
import type { Config, ScoreInput } from './types';

/**
 * Minimal Config fixture. Tests can override fields as needed.
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    whitelist: [
      'alice',
      'bob',
      'carol',
      'dave',
      'eve',
      'frank',
      'george',
      'harry',
    ],
    verticals: {
      Professional: { reviewers: ['alice', 'bob', 'carol', 'dave'] },
      Client: { reviewers: ['eve', 'frank', 'george', 'harry'] },
      Designer: { reviewers: ['eve', 'frank', 'george', 'harry'] },
    },
    assignment: {
      num_reviewers: 1,
      load_window_days: 10,
      load_repos: [
        {
          repo: 'org/repo',
          users: ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'george', 'harry'],
        },
      ],
      weights: {
        vertical_match: 5,
        recent_committer: 2,
        load_penalty: 3,
      },
      fallback: { on_no_vertical: 'least_loaded' },
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    config: makeConfig(),
    prAuthor: 'nobody',
    vertical: 'Professional',
    committers: {},
    load: {},
    ...overrides,
  };
}

describe('scoreCandidates', () => {
  it('applies vertical-match boost for in-vertical reviewers', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'eve'] }),
      vertical: 'Professional',
      committers: {},
      load: { alice: 0, eve: 0 },
    });
    const scored = scoreCandidates(input);
    expect(scored[0]!.login).toBe('alice');
    expect(scored[0]!.breakdown.verticalMatch).toBe(5);
    expect(scored[1]!.login).toBe('eve');
    expect(scored[1]!.breakdown.verticalMatch).toBe(0);
  });

  it('applies committer bonus based on recent-committer file count', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob'] }),
      vertical: 'Professional',
      committers: { alice: 3, bob: 1 },
      load: { alice: 0, bob: 0 },
    });
    const scored = scoreCandidates(input);
    // alice: 5 + 3*2 = 11; bob: 5 + 1*2 = 7
    expect(scored[0]!.login).toBe('alice');
    expect(scored[0]!.breakdown.committerBonus).toBe(6);
    expect(scored[1]!.login).toBe('bob');
    expect(scored[1]!.breakdown.committerBonus).toBe(2);
  });

  it('subtracts load penalty based on load count', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob'] }),
      vertical: 'Professional',
      committers: {},
      load: { alice: 0, bob: 2 },
    });
    const scored = scoreCandidates(input);
    // alice: 5 - 0 = 5; bob: 5 - 6 = -1
    expect(scored[0]!.login).toBe('alice');
    expect(scored[0]!.breakdown.loadPenalty).toBe(0);
    expect(scored[1]!.login).toBe('bob');
    expect(scored[1]!.breakdown.loadPenalty).toBe(6);
  });

  it('excludes the PR author from the scored list', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob', 'carol'] }),
      prAuthor: 'alice',
      vertical: 'Professional',
      committers: {},
      load: {},
    });
    const scored = scoreCandidates(input);
    expect(scored.map((c) => c.login)).not.toContain('alice');
    expect(scored.map((c) => c.login).sort()).toEqual(['bob', 'carol']);
  });

  it('breaks score ties by lower load first', () => {
    // alice in-vertical, bob in-vertical with committer bonus:
    // craft equal scores but different loads.
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob'] }),
      vertical: 'Professional',
      committers: { alice: 1, bob: 0 },
      // alice: 5 + 1*2 - 1*3 = 4
      // bob:   5 + 0*2 - 0*3 = 5  -- not equal. Recompute.
      // We need equal scores. Put alice at 0 load, bob at 0 load, but add bonuses.
      load: {},
    });
    // Actually: make both equal-scored with different loads.
    // Both in vertical; committers 0; alice load 0, bob load 0 → same score & same load.
    // Add different committers? That changes scores. Use non-vertical fallback trick:
    const tieInput = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob'] }),
      vertical: 'Professional',
      committers: { alice: 1, bob: 1 },
      load: { alice: 1, bob: 2 },
    });
    // alice: 5 + 2 - 3 = 4; bob: 5 + 2 - 6 = 1 — not tied.
    // Build real tie: same bonuses, different loads but tie somehow — impossible if weight>0.
    // Use fallback mode (vertical null): score = -loadPenalty. Different loads → different scores.
    // Instead engineer a tie: alice +committer bonus offsets bob's lower load.
    // alice: 5 + 3*2 - 3*3 = 2; bob: 5 + 0*2 - 1*3 = 2 → tie, bob has load 1, alice load 3.
    const realTie = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob'] }),
      vertical: 'Professional',
      committers: { alice: 3, bob: 0 },
      load: { alice: 3, bob: 1 },
    });
    const scored = scoreCandidates(realTie);
    expect(scored[0]!.score).toBe(scored[1]!.score);
    expect(scored[0]!.login).toBe('bob');
    expect(scored[1]!.login).toBe('alice');
    // Silence unused vars
    expect(input.vertical).toBe('Professional');
    expect(tieInput.vertical).toBe('Professional');
  });

  it('breaks score+load ties alphabetically (lowercase)', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['Bob', 'alice'] }),
      vertical: 'Professional',
      // Neither in Professional vertical (default fixture has 'alice'/'bob' lowercase)
      // Use a config with both listed in vertical to equalize verticalMatch.
      committers: {},
      load: { Bob: 0, alice: 0 },
    });
    // Custom config where both are in Professional.
    const cfg = makeConfig({
      whitelist: ['Bob', 'alice'],
      verticals: {
        Professional: { reviewers: ['Bob', 'alice'] },
        Client: { reviewers: [] },
        Designer: { reviewers: [] },
      },
    });
    const scored = scoreCandidates({
      ...input,
      config: cfg,
    });
    expect(scored[0]!.score).toBe(scored[1]!.score);
    expect(scored[0]!.breakdown.loadCount).toBe(scored[1]!.breakdown.loadCount);
    // 'alice' < 'bob' (lowercase), so alice first.
    expect(scored[0]!.login).toBe('alice');
    expect(scored[1]!.login).toBe('Bob');
  });

  it('falls back to pure least-loaded when vertical is null', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'eve', 'bob'] }),
      vertical: null,
      // Even though alice/bob are in Professional list and have committers,
      // vertical=null zeroes both contributions.
      committers: { alice: 5, bob: 5, eve: 5 },
      load: { alice: 2, eve: 0, bob: 1 },
    });
    const scored = scoreCandidates(input);
    for (const c of scored) {
      expect(c.breakdown.verticalMatch).toBe(0);
      expect(c.breakdown.committerBonus).toBe(0);
    }
    // Pure least-loaded ordering: eve (0), bob (1), alice (2).
    expect(scored.map((c) => c.login)).toEqual(['eve', 'bob', 'alice']);
  });

  it('scored has length whitelist.length - 1 when author is in whitelist', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob', 'carol'] }),
      prAuthor: 'alice',
    });
    const scored = scoreCandidates(input);
    expect(scored).toHaveLength(2);
  });

  it('scored has length whitelist.length when author is not in whitelist', () => {
    const input = makeInput({
      config: makeConfig({ whitelist: ['alice', 'bob', 'carol'] }),
      prAuthor: 'external',
    });
    const scored = scoreCandidates(input);
    expect(scored).toHaveLength(3);
  });
});

describe('pickReviewers', () => {
  it('returns top-1 when num_reviewers = 1', () => {
    const cfg = makeConfig({
      whitelist: ['alice', 'bob'],
      assignment: {
        ...makeConfig().assignment,
        num_reviewers: 1,
      },
    });
    const decision = pickReviewers({
      config: cfg,
      prAuthor: 'external',
      vertical: 'Professional',
      committers: {},
      load: { alice: 0, bob: 1 },
    });
    expect(decision.chosen).toHaveLength(1);
    expect(decision.chosen[0]).toBe('alice');
    expect(decision.vertical).toBe('Professional');
  });

  it('returns top-3 when num_reviewers = 3, ordered by scored', () => {
    const cfg = makeConfig({
      whitelist: ['alice', 'bob', 'carol', 'dave', 'eve'],
      assignment: {
        ...makeConfig().assignment,
        num_reviewers: 3,
      },
    });
    const decision = pickReviewers({
      config: cfg,
      prAuthor: 'external',
      vertical: 'Professional',
      committers: {},
      load: { alice: 2, bob: 0, carol: 1, dave: 3, eve: 4 },
    });
    expect(decision.chosen).toHaveLength(3);
    expect(decision.chosen).toEqual(decision.scored.slice(0, 3).map((c) => c.login));
  });

  it('returns empty chosen/scored when the pool is empty (whitelist = [prAuthor])', () => {
    const cfg = makeConfig({ whitelist: ['alice'] });
    const decision = pickReviewers({
      config: cfg,
      prAuthor: 'alice',
      vertical: 'Professional',
      committers: {},
      load: {},
    });
    expect(decision.chosen).toEqual([]);
    expect(decision.scored).toEqual([]);
    expect(decision.vertical).toBe('Professional');
  });
});
