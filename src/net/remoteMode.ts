/**
 * The round, as seen from a machine that is not running it.
 *
 * A guest does not play Capture the Flag. It watches the host play Capture the
 * Flag, and its own character happens to be in it. That distinction is the whole
 * design: a guest that ran `WaterWarMode.fixedUpdate` would spawn its own bots
 * into its own roster, roll its own RNG for its own raid timings, run its own
 * clock and score — a second game with the same name, diverging from the first
 * from the opening tick. The multiplayer work refused to let guests start modes
 * for exactly that reason. This is how they get to be in one anyway.
 *
 * It is a `GameMode` because everything downstream of a mode already reads it
 * through that interface and nothing downstream cares who computed the answers.
 * The HUD asks for `hud()`, the compass asks for `markers()`, the shell asks
 * whether the round `finished`. Every one of those is satisfied by a value the
 * host sent, and not one line of the presentation layer has to learn that a
 * network exists.
 *
 * That only works because modes have never rendered. `gameMode.ts` has said from
 * the start that "modes publish state, and the presentation layer reads it",
 * with the note that it is "what will let a server run a mode headlessly". This
 * is the other half of that bet coming due, and it paid.
 *
 * ## What it does not do
 *
 * `fixedUpdate` is empty and always will be. There is no rule here, no timer, no
 * decision — every one of those belongs to the authority. If something on a
 * guest's screen is wrong, the fix is in what the host sends, never in here.
 */

import type {
  GameMode, Marker, ModeHud, ModeSummary,
} from '../game/gameMode.ts';
import type { Bot } from '../game/bot.ts';
import { Lumber } from '../build/lumber.ts';
import { MARKER_FLAG, MARKER_KINDS, type PackedRound } from './protocol.ts';

export class RemoteMode implements GameMode {
  id = 'remote';
  name = 'Round';

  finished = false;
  won = false;
  buildingAllowed = true;

  /**
   * Always empty, and that is not a stub.
   *
   * The host's bots arrive as ordinary actors in the snapshot, so they are
   * already in the roster and already drawn — the renderer takes its list of
   * bodies from the roster and falls back to `mode.bots` only for the headless
   * tests. A guest that also reported them here would have them counted twice.
   */
  readonly bots: readonly Bot[] = [];

  /**
   * The shared pile, mirrored so the local build system can refuse a placement
   * before it is sent.
   *
   * A guest could send every request and let the host say no, and the wood
   * counter would still be right — but the ghost would stay green while the
   * yard was out of wood, and the answer would arrive a round trip after the
   * click. Mirroring costs one number per snapshot and keeps the refusal where
   * the player's hand is.
   */
  readonly lumber = new Lumber(Infinity);

  private state: PackedRound | null = null;
  private readonly markerList: Marker[] = [];

  /**
   * @param wetnessSource how soaked an actor is, read straight from the session.
   *
   * Read through rather than copied in. Wetness arrives per actor on every
   * snapshot, and a second copy of it here would be one more thing that can be a
   * frame behind the bodies it is painting.
   */
  constructor(private readonly wetnessSource: (actorId: number) => number) {}

  start(): void {}
  fixedUpdate(): void {}
  end(): void {}

  get playerSpeedScale(): number {
    // Movement is predicted locally and corrected by the host, which already
    // runs the guest's body through the same rule. Scaling here as well would
    // apply it twice on the predicting machine and guarantee a correction every
    // snapshot for as long as anybody was wet.
    return 1;
  }

  /** Take a round packet from the host. Returns true when a new round began. */
  apply(round: PackedRound | null): boolean {
    const wasId = this.state?.id ?? null;
    this.state = round;
    if (round === null) {
      this.finished = false;
      this.won = false;
      this.buildingAllowed = true;
      this.lumber.set(Infinity);
      this.markerList.length = 0;
      return false;
    }

    this.id = round.id ?? 'remote';
    this.name = round.name;
    this.buildingAllowed = round.build;
    this.finished = round.over !== null;
    this.won = round.over?.won ?? false;
    if (round.wood === null) this.lumber.set(Infinity);
    else this.lumber.set(round.wood);

    this.markerList.length = 0;
    for (const [kind, x, y, z, color, flags] of round.markers) {
      this.markerList.push({
        kind: MARKER_KINDS[kind] ?? 'stash',
        x, y, z, color,
        active: (flags & MARKER_FLAG.active) !== 0,
        faded: (flags & MARKER_FLAG.faded) !== 0,
      });
    }
    return round.id !== null && round.id !== wasId;
  }

  wetnessOf(actorId: number): number {
    return this.wetnessSource(actorId);
  }

  markers(): readonly Marker[] {
    return this.markerList;
  }

  summary(): ModeSummary {
    const over = this.state?.over;
    if (over === undefined || over === null) return { headline: this.name, lines: [] };
    return {
      headline: over.headline,
      lines: over.lines.map(([label, value]) => ({ label, value })),
    };
  }

  hud(): ModeHud {
    const s = this.state;
    return {
      phase: s?.phase ?? 'WAITING',
      timer: s?.timer ?? null,
      primary: s?.pri === undefined || s.pri === null ? null : { label: s.pri[0], value: s.pri[1] },
      secondary: s?.sec === undefined || s.sec === null ? null : { label: s.sec[0], value: s.sec[1] },
      score: s?.score === undefined || s.score === null
        ? null
        : { left: s.score[0], right: s.score[1] },
      message: s?.msg ?? null,
      // Null rather than a mirrored value, all four of them. These are the
      // fields that are true of one player rather than of the round — how wet
      // you are, what is in your tank, how far a channel has got, how hard you
      // are winding up a throw — and a guest is not yet fighting, so it does not
      // have them. Showing the host's numbers on a guest's HUD would be worse
      // than showing none: a meter that describes somebody else is not a meter,
      // it is a lie with a needle on it.
      charge: null,
      wetness: null,
      ammo: null,
      refill: null,
      lumber: s?.wood ?? null,
    };
  }
}
