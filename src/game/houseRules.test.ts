import { describe, it, expect, afterEach } from 'vitest';
import { HOUSE_RULES, applyHouseRules, houseRuleById, resetHouseRules } from './houseRules.ts';
import { MOTION, KNOCKBACK } from '../physics/constants.ts';

afterEach(resetHouseRules);

describe('house rules', () => {
  it('offers Classic first and at identity, so the default is the shipped feel', () => {
    const classic = HOUSE_RULES[0]!;
    expect(classic.id).toBe('classic');
    const g = MOTION.gravityScale;
    applyHouseRules(classic);
    expect(MOTION.gravityScale).toBe(g);
  });

  it('actually bends the world, and reset actually unbends it', () => {
    const before = {
      g: MOTION.gravityScale, j: MOTION.jumpScale,
      ks: KNOCKBACK.speed, kl: KNOCKBACK.lift,
    };
    applyHouseRules(HOUSE_RULES.find((r) => r.id === 'moon')!);
    expect(MOTION.gravityScale).toBeCloseTo(before.g * 0.5, 10);
    expect(KNOCKBACK.speed).toBeGreaterThan(before.ks);
    resetHouseRules();
    expect(MOTION.gravityScale).toBe(before.g);
    expect(MOTION.jumpScale).toBe(before.j);
    expect(KNOCKBACK.speed).toBe(before.ks);
    expect(KNOCKBACK.lift).toBe(before.kl);
  });

  it('finds a preset by the id that crosses the wire', () => {
    // The welcome carries an id and a guest looks it up here; a lookup that
    // quietly returned Classic for everything would leave every session on
    // shipped physics while the host played on the moon.
    expect(houseRuleById('moon').gravityScale).toBe(0.5);
    expect(houseRuleById('heavy').id).toBe('heavy');
  });

  it('answers a strange id with Classic rather than a throw', () => {
    // The id crosses a wire, and a guest that threw on a hand-typed string
    // would be a guest anybody could disconnect with one message.
    expect(houseRuleById('no-such-preset').id).toBe('classic');
  });

  it('applies from the shipped baseline, not from whatever came before', () => {
    // Presets stack nowhere: Moon after Heavyweight must equal Moon after
    // Classic, or two rounds of experimenting compounds into nonsense.
    applyHouseRules(HOUSE_RULES.find((r) => r.id === 'heavy')!);
    const heavyG = MOTION.gravityScale;
    applyHouseRules(HOUSE_RULES.find((r) => r.id === 'moon')!);
    expect(MOTION.gravityScale).not.toBe(heavyG * 0.5);
    expect(MOTION.gravityScale).toBeCloseTo(1 * 0.5, 10);
  });
});
