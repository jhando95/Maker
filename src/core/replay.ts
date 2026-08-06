/**
 * Record a round as commands, play it back, and check you got the same round.
 *
 * This exists to fail. Two machines running the same simulation from the same
 * inputs must reach the same state, and when they do not the symptom is a desync
 * — one player watching a flag they are not carrying, or standing on a wall the
 * other side cannot see. Desyncs are miserable to debug after the fact because
 * the evidence is two divergent worlds and no record of where they parted.
 *
 * A replay test moves that failure to the commit that causes it. This codebase
 * has already leaked simulation randomness twice: `Math.random` is banned from
 * world state for exactly this reason, and a purely cosmetic water splash was
 * drawing from the simulation's own RNG until it was noticed by hand. Neither
 * broke anything visible. Both would have broken two-player games, and the
 * second was found by reading code rather than by any test.
 *
 * What it does not do is prove *floating-point* portability across machines —
 * same inputs on a different CPU can still differ in the last bit. That is a
 * real limit, and the reason the plan for networking is host-authoritative:
 * one machine's simulation is the truth, and the others are told about it.
 * Determinism here buys reproducible bugs and correct prediction, which is worth
 * having whether or not lockstep is ever on the table.
 */

import type { Command, PackedCommand } from './command.ts';
import { packCommand, unpackCommand } from './command.ts';

export interface Recording {
  /** The seed the world was built from. Replaying under another is meaningless. */
  seed: string;
  /** One entry per tick, in order. */
  commands: PackedCommand[];
}

export function record(seed: string): Recorder {
  return new Recorder(seed);
}

export class Recorder {
  private readonly commands: PackedCommand[] = [];

  constructor(private readonly seed: string) {}

  /**
   * Copies the command rather than keeping it.
   *
   * The live loop reuses one command object every tick to avoid allocating, so
   * storing the reference would give a recording of a thousand ticks that all
   * say whatever the last one said.
   */
  push(command: Command): void {
    this.commands.push(packCommand(command));
  }

  get length(): number {
    return this.commands.length;
  }

  finish(): Recording {
    return { seed: this.seed, commands: [...this.commands] };
  }
}

/** Walk a recording back out, one command per tick. */
export function* playback(recording: Recording): Generator<Command> {
  for (const packed of recording.commands) yield unpackCommand(packed);
}

/**
 * A number that changes when the world does.
 *
 * FNV-1a over the numbers that describe the run, which is enough to notice
 * divergence and makes no attempt to be cryptographic. Quantised to a
 * thousandth: the point is to catch a simulation that took a different path, not
 * to fail a run because a float landed one bit apart after the same arithmetic
 * in a different order.
 */
export class StateHash {
  private value = 0x811c9dc5;

  add(n: number): this {
    // Rounded first so the hash is over the state, not over its representation.
    let x = Math.round(n * 1000) | 0;
    for (let i = 0; i < 4; i++) {
      this.value ^= x & 0xff;
      this.value = Math.imul(this.value, 0x01000193) >>> 0;
      x >>>= 8;
    }
    return this;
  }

  addAll(numbers: Iterable<number>): this {
    for (const n of numbers) this.add(n);
    return this;
  }

  get digest(): number {
    return this.value >>> 0;
  }
}

/** Everything about a body that a divergence would show up in. */
export interface Sampled {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

/**
 * Hash a set of bodies.
 *
 * Velocity as well as position, because two runs can agree on where everyone is
 * standing this tick and disagree about where they are going — which is a
 * divergence that has already happened and will be visible one tick later.
 */
export function hashBodies(bodies: Iterable<Sampled>): number {
  const hash = new StateHash();
  for (const b of bodies) hash.add(b.x).add(b.y).add(b.z).add(b.vx).add(b.vy).add(b.vz);
  return hash.digest;
}
