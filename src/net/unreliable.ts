/**
 * A network that is bad on purpose, and repeats exactly.
 *
 * `loopbackPair` delivers every message instantly, in order, and never loses
 * one. That is the right default — it makes the session testable without a
 * socket — and it is also a claim about the world that is false everywhere
 * outside this process. Every rule in `session.ts` has been verified against a
 * network that cannot misbehave, so the failure modes a real session meets on an
 * ordinary evening have never been exercised at all: a command that arrives
 * after the one behind it, a snapshot that never arrives, a hello that is sent
 * into thirty seconds of dead wifi.
 *
 * This wraps a `Transport` and makes it behave like a network. Four dials —
 * latency, jitter, loss and duplication — and a clock the test owns.
 *
 * ## Why the test owns the clock
 *
 * Delivery is driven by `advance(dt)` rather than by a timer, for the reason
 * this whole codebase runs on a fixed timestep: a test that waits on real
 * milliseconds is a test whose result depends on how busy the machine was. With
 * an owned clock, a session under 8% loss at 120ms plays out the same on a
 * laptop and on a loaded CI runner, and a failure can be replayed by rerunning
 * it with the same seed.
 *
 * ## Why there is no reorder dial
 *
 * Because reordering is not a thing a network decides to do. It is what jitter
 * *is*: two messages sent a millisecond apart, one delayed forty and the other
 * five, arrive in the other order. So delivery is by due time rather than by
 * send order, and reordering falls out at exactly the rate the jitter implies.
 * A separate dial would be a second, disagreeing model of the same phenomenon.
 *
 * ## Counting what it did
 *
 * A lossy-link test that happens to lose nothing is a test that passed for the
 * wrong reason, and this project has written enough of those to know it does not
 * find out by accident. So the link counts what it dropped, duplicated, held and
 * delivered, and a test asserting on behaviour under loss can assert that loss
 * occurred in the same breath.
 */

import { Rng } from '../core/rng.ts';
import type { NetMessage } from './protocol.ts';
import type { Transport } from './transport.ts';

export interface LinkConditions {
  /** One-way delay before jitter, in seconds. */
  latency: number;
  /**
   * Random spread either side of the latency, in seconds.
   *
   * Symmetric and uniform, which is not what a real network's delay
   * distribution looks like — real jitter has a long tail. It is the right
   * first model because the property under test is "messages can arrive out of
   * order and late", and a uniform spread produces both.
   */
  jitter: number;
  /** Chance in [0, 1] that a message is never delivered. */
  loss: number;
  /** Chance in [0, 1] that a delivered message is delivered twice. */
  duplicate: number;
}

/** A link that behaves exactly like the loopback it wraps. */
export const PERFECT: LinkConditions = { latency: 0, jitter: 0, loss: 0, duplicate: 0 };

/**
 * Two people in the same country on home broadband.
 *
 * The condition most sessions will actually run under, and the one worth being
 * the default in tests that are not specifically about hostility.
 */
export const HOME: LinkConditions = { latency: 0.025, jitter: 0.006, loss: 0.001, duplicate: 0 };

/** A congested evening: enough delay to see prediction working, enough loss to notice. */
export const POOR: LinkConditions = { latency: 0.12, jitter: 0.04, loss: 0.03, duplicate: 0.005 };

/**
 * Hostile, and deliberately worse than most players will ever see.
 *
 * A quarter of a second each way with a hundred milliseconds of slop, one packet
 * in twelve gone. The point of a condition nobody plays under is that anything
 * that survives it survives everything milder, and the bugs it shakes out are
 * the same bugs — they just happen sooner.
 */
export const AWFUL: LinkConditions = { latency: 0.25, jitter: 0.1, loss: 0.08, duplicate: 0.02 };

interface Held {
  due: number;
  /** Send order, to break ties without depending on the sort being stable. */
  seq: number;
  message: NetMessage;
}

export class UnreliableLink implements Transport {
  private readonly held: Held[] = [];
  private readonly rng: Rng;
  private now = 0;
  private seq = 0;
  private blackoutUntil = -1;

  /** How many messages were handed to `send`. */
  sent = 0;
  /** How many reached the wrapped transport. Duplicates count twice. */
  delivered = 0;
  /** How many were thrown away by loss or by a blackout. */
  dropped = 0;
  /** How many were sent twice. */
  duplicated = 0;
  /** How many arrived at the far end before something sent earlier. */
  reordered = 0;
  /**
   * The shortest and longest delay the link actually applied, in seconds.
   *
   * A harness that asks for 120ms and 40ms of slop wants to know it got them —
   * a condition set that silently did not apply is a whole test suite quietly
   * running on a perfect network. These are also what make the clamp in `hold`
   * load-bearing: without them nothing outside this class can tell a delay of
   * zero from a delay of minus four hundred milliseconds, because both deliver
   * on the next `advance`. That is what the first version of the test for it
   * discovered, and it is written up in `docs/verification.md`.
   */
  fastest = Infinity;
  slowest = 0;

  constructor(
    private readonly inner: Transport,
    private conditions: LinkConditions = HOME,
    seed: number | string = 'link',
  ) {
    this.rng = new Rng(seed);
  }

  /** Change the weather mid-session, which is what a real one does. */
  setConditions(conditions: LinkConditions): void {
    this.conditions = conditions;
  }

  /**
   * Lose everything sent for the next `seconds`.
   *
   * The wifi dropping out, modelled as a hole rather than as a closed socket,
   * because those are different events and the game has to survive both. A
   * close is unambiguous and the session is told about it; a blackout is
   * silence, and silence is the harder one — nothing tells anybody, and both
   * ends have to work out for themselves that the other has gone quiet.
   */
  blackout(seconds: number): void {
    this.blackoutUntil = this.now + seconds;
  }

  get blacked(): boolean {
    return this.now < this.blackoutUntil;
  }

  /** Messages held by the link, neither delivered nor lost. */
  get inFlight(): number {
    return this.held.length;
  }

  get open(): boolean {
    return this.inner.open;
  }

  send(message: NetMessage): void {
    if (!this.inner.open) return;
    this.sent++;
    if (this.blacked || this.rng.next() < this.conditions.loss) {
      this.dropped++;
      return;
    }
    this.hold(message);
    if (this.rng.next() < this.conditions.duplicate) {
      this.duplicated++;
      this.hold(message);
    }
  }

  private hold(message: NetMessage): void {
    const wobble = (this.rng.next() * 2 - 1) * this.conditions.jitter;
    // Clamped at zero: a negative delay would deliver a message before it was
    // sent, which is a bug rather than a network condition.
    const delay = Math.max(0, this.conditions.latency + wobble);
    if (delay < this.fastest) this.fastest = delay;
    if (delay > this.slowest) this.slowest = delay;
    this.held.push({ due: this.now + delay, seq: this.seq++, message });
  }

  /**
   * Move the link's clock on and deliver whatever has come due.
   *
   * Delivered in due order rather than send order, which is where reordering
   * comes from. The `seq` tiebreak keeps two messages due at the same instant
   * in the order they were sent, so a link with no jitter never reorders at all
   * — a property worth having, because it is what makes `PERFECT` a control.
   */
  advance(dt: number): void {
    this.now += dt;
    if (this.held.length === 0) return;

    const due: Held[] = [];
    for (let i = this.held.length - 1; i >= 0; i--) {
      const entry = this.held[i]!;
      if (entry.due <= this.now) {
        due.push(entry);
        this.held.splice(i, 1);
      }
    }
    if (due.length === 0) return;

    due.sort((a, b) => (a.due === b.due ? a.seq - b.seq : a.due - b.due));
    let highest = -1;
    for (const entry of due) {
      if (entry.seq < highest) this.reordered++;
      else highest = entry.seq;
      this.inner.send(entry.message);
      this.delivered++;
    }
  }

  drain(): NetMessage[] {
    return this.inner.drain();
  }

  /**
   * Close, dropping everything still in flight.
   *
   * A socket that closes does not deliver its backlog first, and a link that
   * did would quietly make "the host left mid-round" a tidier event than it is.
   */
  close(): void {
    this.dropped += this.held.length;
    this.held.length = 0;
    this.inner.close();
  }
}

export interface UnreliablePair {
  host: UnreliableLink;
  client: UnreliableLink;
  /** Move both directions on by `dt` seconds. */
  advance(dt: number): void;
}

/**
 * A loopback pair with a bad network in the middle of it.
 *
 * Both directions get their own link and their own generator, seeded apart, so
 * a burst of loss on the way up is not mirrored by a burst on the way down —
 * which is the failure a single shared generator would quietly produce, and
 * exactly the correlation a real network does not have.
 */
export function unreliablePair(
  pair: { host: Transport; client: Transport },
  conditions: LinkConditions = HOME,
  seed: number | string = 'link',
): UnreliablePair {
  const host = new UnreliableLink(pair.host, conditions, `${String(seed)}:host`);
  const client = new UnreliableLink(pair.client, conditions, `${String(seed)}:client`);
  return {
    host,
    client,
    advance(dt: number): void {
      host.advance(dt);
      client.advance(dt);
    },
  };
}
