/**
 * Seeded, deterministic pseudo-random numbers.
 *
 * `Math.random()` is banned everywhere that affects world state. The scene is
 * procedurally generated, so a seed is the difference between "every player in
 * the match sees the same backyard" and "everyone gets a different tree layout".
 * Once there is a server, the same property is what lets it replay a client's
 * inputs and get the same answer.
 *
 * mulberry32: 32-bit state, good enough distribution for scattering props and
 * jittering colors, and fast enough to call in a loop.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string = 1) {
    this.state = typeof seed === 'string' ? Rng.hashString(seed) : seed >>> 0;
    // A zero state is a fixed point for some generators; nudge it off zero.
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** FNV-1a, so a human-readable seed like "backyard-01" maps to a stable number. */
  static hashString(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with the given probability. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform in [-magnitude, +magnitude). */
  signed(magnitude = 1): number {
    return this.range(-magnitude, magnitude);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  /** A fresh generator derived from this one — lets subsystems branch without interfering. */
  fork(): Rng {
    return new Rng(Math.floor(this.next() * 0xffffffff));
  }
}
