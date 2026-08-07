/**
 * What is holding your structure up, and what happens when it stops.
 *
 * The title screen has said *"Build it yourself. Then find out if it holds."*
 * since the first commit, and nothing ever found out. A placement was checked
 * for overlap and for bounds and for nothing else, so a tower stood whether or
 * not it had legs — knock the bottom plank out of a six-metre staircase and the
 * remaining five metres hung in the air, unbothered, exactly as before. That is
 * the largest gap in this game between what it says it is and what it does.
 *
 * ## The model: nailed, not stacked
 *
 * A joint here is *contact*, in any direction, and that is a deliberate choice
 * about what these things are. This is not masonry, where a block rests on the
 * one below and gravity does the rest — it is a kid with a hammer, and a plank
 * nailed to the side of a post is held by that post as surely as one laid on top
 * of it. Half of what people build in this game is cantilevered off something:
 * a rung on a wall, a shelf off a fence, a bridge out over the pool. A rule that
 * only counted things underneath would refuse all of it.
 *
 * So: two parts are joined if their boxes touch. A part is *anchored* if it
 * meets the ground or is nailed to the map — the house, the fence, the
 * treehouse, anything the player did not put there and cannot take away. A part
 * stands if some chain of joints reaches an anchor. Everything else is in the
 * air, and the moment it is, it comes down.
 *
 * ## Why this runs on removal and not on placement
 *
 * Both are true statements about a structure and only one of them is a change
 * to how the game plays. Everything anybody has ever built in this game is
 * already supported — the snapper puts parts against surfaces, so you have to
 * work at making something float. Refusing an unsupported placement would
 * therefore mostly be a rule nobody meets, while collapsing what loses its
 * footing is a rule everybody meets the first time they take a leg out of
 * something. The interesting half is the cheap half.
 *
 * ## The local flood, and why it is not a whole-world sweep
 *
 * The obvious implementation is "recompute what is grounded, drop the rest",
 * and it is O(everything) on every click. It is also unnecessary: taking one
 * part away can only strand parts that reached the ground *through* it, so the
 * search starts at the hole and floods outward. A component that finds an
 * anchor stops immediately; one that does not has been fully enumerated by the
 * time that is known, which is exactly the list to bring down.
 *
 * ## Determinism
 *
 * The host decides what falls and tells everyone; nobody recomputes it. Even
 * so, ids come back sorted and the flood works off a sorted frontier — a
 * collapse that reported the same parts in a different order would still be a
 * different sequence of messages on the wire, and the one thing worse than a
 * desync is one that only shows up when a tower comes down.
 */

/** An axis-aligned box, which is all this file needs to know about a part. */
export interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/**
 * How close two things have to be to count as nailed together.
 *
 * Three centimetres. Parts placed flush against each other touch exactly, and
 * exact contact between two floats is not a thing to build a rule on — the
 * placement check already shrinks its probe by 6mm for the same reason, in the
 * other direction. This is that number with room to spare: big enough that a
 * snapped joint always reads as a joint, small enough that two planks a hand's
 * width apart do not hold each other up.
 */
export const TOUCH = 0.03;

/** The world this reads. Narrow on purpose, so a test can be four boxes. */
export interface Structure {
  /** Every live part, in ascending id order. */
  ids(): Iterable<number>;
  /** Where a part is. Only called for live ids. */
  box(id: number): Box;
  /**
   * Ids whose space is near this box.
   *
   * A broadphase is fine and expected — it may return things that do not
   * actually touch, and this file checks. What it must not do is *miss* one.
   */
  near(box: Box): Iterable<number>;
  /** Map geometry: holds itself up, and holds up whatever is nailed to it. */
  fixed(id: number): boolean;
  /** Where the lawn is. */
  groundY: number;
}

/** The box, grown by the joint tolerance in every direction. */
function grown(box: Box): Box {
  return {
    minX: box.minX - TOUCH, minY: box.minY - TOUCH, minZ: box.minZ - TOUCH,
    maxX: box.maxX + TOUCH, maxY: box.maxY + TOUCH, maxZ: box.maxZ + TOUCH,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && a.maxX > b.minX
    && a.minY < b.maxY && a.maxY > b.minY
    && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

/** Is this part standing on the lawn? */
export function onGround(s: Structure, box: Box): boolean {
  return box.minY <= s.groundY + TOUCH;
}

/**
 * Everything joined to the space this box occupies, ignoring the part that
 * fills it.
 *
 * Takes a box rather than an id so it can be asked about a part that has
 * already been taken away — which is the whole question after a removal.
 */
export function joinedTo(s: Structure, box: Box, self = -1): number[] {
  const reach = grown(box);
  const out: number[] = [];
  for (const id of s.near(reach)) {
    if (id === self) continue;
    if (overlaps(reach, s.box(id))) out.push(id);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Is anything holding this part up, without going through another part?
 *
 * The two ways a structure meets the world: it stands on the lawn, or it is
 * nailed to something the player did not build.
 */
export function anchored(s: Structure, id: number): boolean {
  const box = s.box(id);
  if (onGround(s, box)) return true;
  for (const other of joinedTo(s, box, id)) if (s.fixed(other)) return true;
  return false;
}

/**
 * What comes down now that the space `box` filled is empty.
 *
 * Call it **after** the removal, passing the box the part used to occupy. Ids
 * come back in ascending order, and the list is everything that has to go — not
 * just the first thing that lost its footing, but the whole load it was
 * carrying.
 */
export function collapseAfter(s: Structure, box: Box): number[] {
  const doomed: number[] = [];
  const settled = new Set<number>();

  for (const start of joinedTo(s, box)) {
    if (settled.has(start) || s.fixed(start)) continue;

    // Flood this neighbour's component, stopping the moment it turns out to
    // reach the world. A component that finds an anchor is not interesting and
    // the parts in it are marked settled so a later neighbour in the same
    // component does not walk it again.
    const seen = new Set<number>([start]);
    const queue = [start];
    let standing = false;
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]!;
      if (anchored(s, id)) { standing = true; break; }
      for (const next of joinedTo(s, s.box(id), id)) {
        // A fixture is an anchor, and `anchored` has already said this part is
        // not touching one — so anything fixed in the neighbour list is out of
        // reach of the tolerance test there and must not be walked *through*
        // either, or the flood would leave the player's structure and wander
        // off into the house.
        if (s.fixed(next) || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    for (const id of seen) settled.add(id);
    if (!standing) for (const id of seen) doomed.push(id);
  }

  doomed.sort((a, b) => a - b);
  return doomed;
}

/**
 * Everything in the world that is not holding itself up.
 *
 * The whole-world sweep `collapseAfter` exists to avoid. Kept because it is the
 * definition the local version has to agree with, and a test that runs both
 * against the same structure is the only thing that would catch the local one
 * getting clever and wrong.
 */
export function unsupported(s: Structure): number[] {
  const standing = new Set<number>();
  const frontier: number[] = [];

  for (const id of s.ids()) {
    if (s.fixed(id) || !anchored(s, id)) continue;
    standing.add(id);
    frontier.push(id);
  }
  for (let head = 0; head < frontier.length; head++) {
    for (const next of joinedTo(s, s.box(frontier[head]!), frontier[head]!)) {
      if (s.fixed(next) || standing.has(next)) continue;
      standing.add(next);
      frontier.push(next);
    }
  }

  const out: number[] = [];
  for (const id of s.ids()) if (!s.fixed(id) && !standing.has(id)) out.push(id);
  return out;
}
