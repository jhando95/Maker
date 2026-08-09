import { describe, it, expect } from 'vitest';
import { allScenarios, costOf, shards } from './scenarios.mjs';

/** A cost table with an obvious right answer, so the balance can be checked. */
const cost = (n) => Number(n.split(':')[1]);
const jobs = ['a:100', 'b:60', 'c:60', 'd:40', 'e:40', 'f:20', 'g:20', 'h:20'];

describe('splitting the work', () => {
  it('gives every scenario to exactly one shard', () => {
    // The property a function returning a single slice cannot be asked. A split
    // that drops one is a scenario that silently never runs, which is the bug
    // this whole file exists to make impossible.
    for (const total of [1, 2, 3, 4, 5, 8, 13]) {
      const out = shards(jobs, total, cost);
      expect(out.flat().sort()).toEqual([...jobs].sort());
    }
  });

  it('makes as many shards as it was asked for', () => {
    expect(shards(jobs, 5, cost)).toHaveLength(5);
    expect(shards(jobs, 1, cost)).toHaveLength(1);
  });

  it('puts everything in one when there is one', () => {
    expect(shards(jobs, 1, cost)[0].sort()).toEqual([...jobs].sort());
  });

  it('balances rather than dealing round-robin', () => {
    // Round-robin over this list puts a:100 and e:40 together — 140 against a
    // shard holding 80. Longest-first onto the lightest keeps them level.
    const out = shards(jobs, 4, cost);
    const loads = out.map((s) => s.reduce((a, b) => a + cost(b), 0));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(20);
  });

  it('never lands two of the heaviest on one shard while another is empty', () => {
    const out = shards(['x:100', 'y:100', 'z:1'], 2, cost);
    expect(out.every((s) => s.length > 0)).toBe(true);
    expect(out.map((s) => s.length).sort()).toEqual([1, 2]);
  });

  it('copes with more shards than work, without losing any', () => {
    const out = shards(['x:5', 'y:5'], 6, cost);
    expect(out.flat().sort()).toEqual(['x:5', 'y:5']);
    expect(out.filter((s) => s.length > 0)).toHaveLength(2);
  });

  it('copes with nothing at all', () => {
    expect(shards([], 3, cost).flat()).toEqual([]);
  });

  it('splits the same way every time, so a failing shard can be re-run', () => {
    // Ties broken by name rather than by input order: a split that depends on
    // how the directory happened to be read is a split that cannot be
    // reproduced from a failure message.
    const shuffled = [...jobs].reverse();
    expect(shards(shuffled, 4, cost)).toEqual(shards(jobs, 4, cost));
  });

  it('never returns fewer than one shard, however it is asked', () => {
    expect(shards(jobs, 0, cost)).toHaveLength(1);
    expect(shards(jobs, -3, cost)).toHaveLength(1);
  });
});

describe('the list it splits', () => {
  it('is read off the directory rather than written down twice', () => {
    // The workflow used to name every scenario. A new one meant a new file and
    // a new step, and forgetting the step is silent.
    const names = allScenarios();
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain('soak');
    expect(names).toContain('voice');
    expect(names.every((n) => !n.endsWith('.mjs'))).toBe(true);
  });

  it('costs the ones nobody has timed as expensive rather than as free', () => {
    // A new scenario should land on a light shard, not on top of the heaviest.
    expect(costOf('a-scenario-nobody-has-timed')).toBeGreaterThanOrEqual(30);
    expect(costOf('voice')).toBeGreaterThan(costOf('hud'));
  });

  it('splits the real list evenly enough to be worth doing', () => {
    const names = allScenarios();
    const loads = shards(names, 4).map((s) => s.reduce((a, b) => a + costOf(b), 0));
    const serial = names.reduce((a, b) => a + costOf(b), 0);
    // The longest shard has to be a large fraction shorter than running the lot.
    expect(Math.max(...loads)).toBeLessThan(serial * 0.45);
  });
});
