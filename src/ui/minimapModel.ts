/**
 * Where things sit on a map of the neighbourhood, and what to do about the ones
 * that are not on it.
 *
 * The drawing is a canvas and belongs in `minimap.ts`. This is the part that can
 * be wrong in ways a screenshot will not show: which metre is which pixel, what
 * happens at the edge, and which of three hundred parts are worth touching at
 * all.
 *
 * ## Why a map at all
 *
 * The compass this game already has answers "which way is the flag" and cannot
 * answer "which way is *round*". A backyard with a house in the middle of it is
 * a maze the first six times you play it, and Tag runs the length of a street.
 * A direction is not a route.
 *
 * ## The three rates
 *
 * A map has three kinds of thing on it and they change at wildly different
 * speeds. The house, the fences and the road never move. What people have built
 * changes when somebody builds, which is a few times a minute. Players and
 * objectives move every frame. Drawing all three every frame would be a second
 * renderer running at sixty hertz to show a picture that is mostly identical to
 * the last one — so each layer is redrawn on its own clock, and the funnel that
 * says the world changed is the one `worldChanged()` already calls.
 *
 * ## The edge
 *
 * A marker outside the window is the interesting case, and the wrong answers are
 * "draw it anyway" — which puts a flag in the middle of a house because both are
 * off to the left — and "drop it", which loses the only thing telling you where
 * to go. It is pinned to the rim in the direction it lies, which is the same
 * decision the compass makes and for the same reason.
 */

/** A point on the map, in pixels from its top-left. */
export interface MapPoint {
  x: number;
  y: number;
  /** True when the thing is off the map and this is a point on the rim. */
  clamped: boolean;
}

export interface MapView {
  /** Where the middle of the map is, in world metres. */
  centreX: number;
  centreZ: number;
  /** How many metres fit across the whole map. */
  span: number;
  /** How many pixels across the map is. Square. */
  size: number;
}

/**
 * World metres to map pixels.
 *
 * The world's +z runs *into* the screen in a first-person view and downward on
 * a north-up map, so z maps to y with no flip. Getting that backwards produces
 * a map that is a mirror of the world, which is worse than no map: a player who
 * cannot trust it has to learn to invert it.
 */
export function project(view: MapView, x: number, z: number): MapPoint {
  const scale = view.size / view.span;
  const px = (x - view.centreX) * scale + view.size / 2;
  const py = (z - view.centreZ) * scale + view.size / 2;
  return { x: px, y: py, clamped: false };
}

/**
 * The same, but a marker beyond the edge is pinned to the rim pointing at it.
 *
 * `inset` keeps a pinned marker fully on the map rather than half off it, and is
 * in pixels because that is what it is measured against — a marker is a fixed
 * number of pixels across whatever the map is showing.
 */
export function projectClamped(view: MapView, x: number, z: number, inset = 0): MapPoint {
  const point = project(view, x, z);
  const half = view.size / 2 - inset;
  const dx = point.x - view.size / 2;
  const dy = point.y - view.size / 2;
  const reach = Math.max(Math.abs(dx), Math.abs(dy));
  if (reach <= half || reach === 0) return point;

  // Scaled rather than clipped per axis, so the pinned marker sits in the
  // *direction* of the thing. Clipping x and y separately walks a marker along
  // the edge to a corner and lies about which way to go.
  const k = half / reach;
  return { x: view.size / 2 + dx * k, y: view.size / 2 + dy * k, clamped: true };
}

/**
 * A view centred on the player but held inside the world.
 *
 * Without the clamp, standing at the edge of the map puts half the picture
 * outside the world — a large empty area that reads as unexplored rather than
 * as nothing. With it, walking toward the edge slides the player off centre,
 * which is what every map in every game does and what people already expect.
 *
 * `span` bigger than the world means the clamp cannot be satisfied, and then
 * the honest answer is the middle of the world rather than an argument between
 * two impossible constraints.
 */
export function viewFor(
  x: number, z: number, span: number, size: number, worldHalf: number,
): MapView {
  const slack = worldHalf - span / 2;
  const clamp = (v: number): number =>
    (slack <= 0 ? 0 : Math.max(-slack, Math.min(slack, v)));
  return { centreX: clamp(x), centreZ: clamp(z), span, size };
}
