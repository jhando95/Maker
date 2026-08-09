/**
 * Every decision proximity voice makes, with no browser in sight.
 *
 * `RTCPeerConnection`, `getUserMedia` and the Web Audio graph cannot be run in a
 * unit test and cannot be reasoned about by reading them. What *can* be both is
 * the set of rules underneath: who dials whom, how loud somebody twenty metres
 * away should be, whether a wall is between you, when a run of samples counts as
 * speech. Those live here, as arithmetic over numbers, and `voiceChat.ts` is the
 * thin shell that hands them to the platform.
 *
 * The split is worth stating because the temptation is strong to skip it. Voice
 * is the first system in this game whose failures are all invisible — a gain
 * ramp that is subtly wrong sounds like a bad connection, an offer sent in both
 * directions sounds like a dropped call, a speaking gate with no hysteresis
 * looks like a flickering icon. None of those throw. If the rule is not in a
 * file that can be tested, the only way to find out it is wrong is for somebody
 * to say "you sounded weird".
 */

import { NEAR_RADIUS } from '../game/comms.ts';

/**
 * How far a voice carries.
 *
 * **The same number the text `near` channel uses, imported rather than
 * repeated.** Two radii would mean a game where you can hear somebody who
 * cannot read you, or read somebody you cannot hear — and the bug would be
 * invisible until two players compared notes about a conversation only one of
 * them had. There is one answer to "is this person near me" in this game.
 */
export const VOICE_RADIUS = NEAR_RADIUS;

/**
 * Inside this, a voice is at full volume.
 *
 * A curve that starts falling from zero metres means the person standing next
 * to you is quieter than the person standing on you, which is true of physics
 * and useless in a game: the common case is a group of three within arm's reach
 * of each other and they should all simply be audible.
 */
export const VOICE_CLEAR = 5;

/**
 * Lowpass cutoff for a clear line and for one through a wall, in Hz.
 *
 * The open value is above the top of what a voice codec sends, so the filter is
 * doing nothing at all when there is nothing in the way — deliberately, rather
 * than bypassing the node, because a filter that is switched in and out clicks
 * and one that is always in the path and swept does not.
 *
 * 700Hz is muffled and still intelligible, which is the point. A wall should
 * tell you somebody is on the other side of it; a wall that made them
 * unintelligible would just be a mute with extra steps.
 */
export const OPEN_CUTOFF = 18000;
export const MUFFLED_CUTOFF = 700;

/** What a wall costs on top of the muffling, as a gain multiplier. */
export const OCCLUDED_GAIN = 0.55;

/** How wide the stereo image goes. 1 would put a voice fully in one ear. */
export const MAX_PAN = 0.85;

export interface VoiceMix {
  /** 0..1, before the listener's own output volume. */
  readonly gain: number;
  /** -1 left to +1 right. */
  readonly pan: number;
  /** Lowpass corner in Hz. */
  readonly cutoff: number;
}

export interface Placed {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Silence, and the shape every caller can fall back to. */
export const SILENT: VoiceMix = { gain: 0, pan: 0, cutoff: OPEN_CUTOFF };

/**
 * How a speaker should sound to a listener standing where they are standing.
 *
 * `rightX`/`rightZ` are the listener camera's right vector in the ground plane,
 * which is all a stereo pan needs — the same basis `AudioBus.spatial` uses for
 * footsteps and splashes. **That consistency is the reason this does not use a
 * `PannerNode`**, which would be the obvious choice and would spatialise better
 * in isolation: a `PannerNode` has its own listener with its own orientation,
 * and the moment two spatialisation models coexist in one scene a player's
 * voice and that same player's footsteps arrive from measurably different
 * directions. One model, slightly cruder, beats two that disagree.
 */
export function voiceMix(
  speaker: Placed,
  listener: Placed,
  rightX: number,
  rightZ: number,
  occluded = false,
  radius = VOICE_RADIUS,
): VoiceMix {
  const dx = speaker.x - listener.x;
  const dy = speaker.y - listener.y;
  const dz = speaker.z - listener.z;
  const distance = Math.hypot(dx, dy, dz);
  // An early-out rather than the rule. The clamp below already takes the gain
  // to exactly zero at the radius, so deleting this line changes no audible
  // behaviour — it saves the pan and occlusion work for somebody nobody can
  // hear, which in a wide game is most of the roster most of the time.
  if (distance >= radius) return SILENT;

  // Flat inside the clear radius, then `1 - t²` out to the edge.
  //
  // The curve is chosen by its *shape* rather than by physics, and the shape
  // that matters is: nearly flat at first, falling faster the further out you
  // get, and reaching exactly zero at the limit. Which is to say it holds
  // somebody across the width of a garden at about three quarters volume —
  // still plainly intelligible, which is the entire value of proximity chat —
  // and then drops away over the last few metres so nobody is cut off mid-word
  // by a step backwards.
  //
  // Both obvious alternatives fail one half of that. Linear drops equally
  // everywhere, so it is already at half volume across the same garden. And
  // `(1 - t)²`, which looks like the "inverse square" answer and is what a
  // first draft of this used, is *steepest right next to the listener* — it
  // loses two thirds of its volume in the first half of the range, which puts
  // a teammate ten metres away below the game.
  const span = Math.max(radius - VOICE_CLEAR, 1e-3);
  const t = Math.min(1, Math.max(0, distance - VOICE_CLEAR) / span);
  const falloff = 1 - t * t;

  const pan = distance < 1e-4
    ? 0
    : Math.max(-1, Math.min(1, ((dx * rightX + dz * rightZ) / distance) * MAX_PAN));

  return {
    gain: falloff * (occluded ? OCCLUDED_GAIN : 1),
    pan,
    cutoff: occluded ? MUFFLED_CUTOFF : OPEN_CUTOFF,
  };
}

/**
 * Which end of a pair places the call.
 *
 * The lower id offers; the higher answers. Trivial, and it is the whole of the
 * glare problem: two peers that both send an offer end up in
 * `have-local-offer` on both sides and neither call ever connects. The formal
 * fix is "perfect negotiation" with a polite peer and rollback, which is worth
 * it when either side may renegotiate at any time. Here, ids are assigned by
 * one authority and never change, so an ordering is free and there is nothing
 * to roll back.
 */
export function shouldOffer(me: number, them: number): boolean {
  return me < them;
}

/**
 * Who this machine should be connected to, and what has changed since last time.
 *
 * Deliberately **not** gated on proximity, and this is the design decision most
 * worth arguing with. Connecting only to people within earshot would obviously
 * save bandwidth in a big world. It is wrong here because establishing a peer
 * connection takes one to three seconds — ICE gathering, DTLS, the first key
 * frame of audio — so gating on distance means walking up to somebody and
 * getting silence for exactly as long as it takes to say the thing you walked
 * over to say. The connection stays up and the *gain* is what proximity moves,
 * which costs a few tens of kbit per person in a game capped at eight.
 */
export class VoiceMesh {
  private readonly open = new Set<number>();

  /**
   * Reconcile against the people currently in the world.
   *
   * Returns what to do rather than doing it, so the caller owns every platform
   * call and this stays testable. Idempotent: calling it twice with the same
   * roster asks for nothing the second time.
   */
  sync(present: Iterable<number>): { dial: number[]; hangUp: number[] } {
    const wanted = new Set(present);
    const dial: number[] = [];
    const hangUp: number[] = [];
    for (const id of wanted) {
      if (!this.open.has(id)) dial.push(id);
    }
    for (const id of this.open) {
      if (!wanted.has(id)) hangUp.push(id);
    }
    for (const id of dial) this.open.add(id);
    for (const id of hangUp) this.open.delete(id);
    // Sorted so a test can state an expectation and a log reads the same twice.
    dial.sort((a, b) => a - b);
    hangUp.sort((a, b) => a - b);
    return { dial, hangUp };
  }

  /** Forget one connection without touching the rest, e.g. after a failure. */
  forget(id: number): void {
    this.open.delete(id);
  }

  has(id: number): boolean {
    return this.open.has(id);
  }

  get size(): number {
    return this.open.size;
  }

  clear(): void {
    this.open.clear();
  }
}

/** Level above which a run of samples starts counting as speech. */
export const SPEAK_ON = 0.018;
/** And below which it stops. Lower than `SPEAK_ON` on purpose — see the class. */
export const SPEAK_OFF = 0.009;
/** How long a voice keeps the indicator lit after dropping below the floor. */
export const SPEAK_HOLD = 0.35;

/**
 * Is this person talking?
 *
 * Two thresholds and a hold, rather than one comparison, and each of the three
 * is answering a different way the naive version looks broken:
 *
 * - **A single threshold flickers**, because speech crosses any given level
 *   dozens of times a second. An icon that strobes at 20Hz reads as a rendering
 *   fault, not as somebody talking.
 * - **The hold covers the gaps between words.** Ordinary speech has 100–300ms
 *   of near-silence in it constantly; without a hold the indicator blinks off
 *   between every word.
 * - **The gap between on and off is hysteresis.** With one threshold, a voice
 *   sitting exactly at it toggles on every frame — the classic Schmitt trigger
 *   problem, and the classic answer.
 */
export class SpeakingGate {
  private on = false;
  private held = 0;

  constructor(
    private readonly onLevel = SPEAK_ON,
    private readonly offLevel = SPEAK_OFF,
    private readonly hold = SPEAK_HOLD,
  ) {}

  /** Feed one measured RMS level and the time since the last one. */
  update(level: number, dt: number): boolean {
    if (level >= this.onLevel) {
      this.on = true;
      this.held = this.hold;
      return true;
    }
    if (this.on && level >= this.offLevel) {
      // Still above the floor: keep talking and keep the hold topped up.
      this.held = this.hold;
      return true;
    }
    if (this.on) {
      this.held -= dt;
      if (this.held <= 0) this.on = false;
    }
    return this.on;
  }

  get speaking(): boolean {
    return this.on;
  }

  reset(): void {
    this.on = false;
    this.held = 0;
  }
}

/**
 * How much signalling one person is allowed to send.
 *
 * A token bucket rather than the minimum-gap limiter chat uses, because the
 * traffic has the opposite shape: ICE candidates arrive in a burst of ten or
 * twenty over a second or two and then nothing for the rest of the round. A gap
 * limiter sized for the burst is no limit at all, and one sized for the average
 * would break every call it was meant to protect.
 *
 * It is on the host because that is where it is a rule. A client can send
 * whatever it likes; what it cannot do is make the host forward it. Without
 * this, one guest can push arbitrary bytes at every other guest in the yard at
 * whatever rate their connection allows, which is a denial of service with the
 * host as the amplifier.
 */
export class SignalBudget {
  private readonly tokens = new Map<number, number>();

  constructor(
    /** Steady-state signals per second. */
    private readonly rate = 8,
    /** How many may arrive at once. Sized for a full ICE burst. */
    private readonly burst = 40,
  ) {}

  tick(dt: number): void {
    for (const [id, have] of this.tokens) {
      this.tokens.set(id, Math.min(this.burst, have + this.rate * dt));
    }
  }

  /** True when this person may send one more, and spends it. */
  allow(id: number): boolean {
    const have = this.tokens.get(id) ?? this.burst;
    if (have < 1) {
      this.tokens.set(id, have);
      return false;
    }
    this.tokens.set(id, have - 1);
    return true;
  }

  forget(id: number): void {
    this.tokens.delete(id);
  }

  /** For tests and the debug overlay. */
  remaining(id: number): number {
    return this.tokens.get(id) ?? this.burst;
  }
}

/**
 * Should this machine be sending audio right now?
 *
 * Pulled out of the shell because it is four booleans with an order, and an
 * order that is easy to get wrong in a way nobody notices until they are the
 * one being heard: muting yourself has to beat push-to-talk, or a muted player
 * holding the key transmits.
 */
export function transmitting(
  enabled: boolean,
  micMuted: boolean,
  pushToTalk: boolean,
  keyHeld: boolean,
): boolean {
  if (!enabled || micMuted) return false;
  return pushToTalk ? keyHeld : true;
}
