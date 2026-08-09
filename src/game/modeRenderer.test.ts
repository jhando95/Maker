import { describe, it, expect } from 'vitest';
import { ModeRenderer, type StreamShot } from './modeRenderer.ts';
import { CharacterBatch } from '../render/character.ts';
import { ProjectileSystem } from '../game/projectiles.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';

/**
 * The stream buffer, driven directly.
 *
 * `updateStream` is arithmetic over positions and a count handed to a draw
 * call, which is exactly the kind of thing a browser scenario is a poor place
 * to check: a raid has to be live and a trigger held for a stream to exist at
 * all, and the mode clears them at the top of every tick, so a sampling loop
 * outside the simulation sees nothing. What a scenario *can* say is that the
 * mode publishes one per person; what only this can say is what reaches the
 * GPU.
 */
function renderer(): ModeRenderer {
  return new ModeRenderer(new CharacterBatch(8));
}

const shot = (fx: number, tx: number): StreamShot => ({
  fx, fy: 1.4, fz: 0, tx, ty: 1, tz: 0,
});

/** Run the frame, which is what actually fills the buffer. */
const shots = new ProjectileSystem(new CollisionWorld());

function draw(r: ModeRenderer, streams: StreamShot[]): number {
  r.setStreams(streams);
  r.update(1 / 60, null, shots, 0, []);
  return r.streamDrops;
}

describe('drawing everybody\'s water', () => {
  it('costs nothing at all when nobody is spraying', () => {
    // Packed rather than parked. Hiding unused slots behind a degenerate matrix
    // still submits every one of them to the vertex shader, which is the
    // mistake this project has made and fixed in four separate batches.
    expect(draw(renderer(), [])).toBe(0);
  });

  it('draws one hose within one hose\'s worth of droplets', () => {
    const n = draw(renderer(), [shot(0, 6)]);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(ModeRenderer.MAX_DROPS);
  });

  it('draws a second person\'s water too, which is the whole gap', () => {
    // `streamFor` was published per actor from the day Water War was written
    // and the renderer took exactly one of them, so a guest saw their own jet
    // and never the host's — the fight looked one-sided from both ends.
    const one = draw(renderer(), [shot(0, 6)]);
    const two = draw(renderer(), [shot(0, 6), shot(20, 26)]);
    expect(two).toBeGreaterThan(one);
    expect(two).toBe(one * 2);
  });

  it('gives a longer stream more droplets than a short one', () => {
    // The count is derived from length, so a jet across the garden is not the
    // same handful of drops stretched thin.
    expect(draw(renderer(), [shot(0, 10)])).toBeGreaterThan(draw(renderer(), [shot(0, 2)]));
  });

  it('stops at the cap rather than overrunning the buffer', () => {
    // Water War spawns raiders continuously and every one can be spraying, so
    // this is a bound on the draw rather than on the game. Overrunning would be
    // a silent write past the end of an instanced buffer.
    const over = ModeRenderer.MAX_STREAMS + 4;
    const many = Array.from({ length: over }, (_, i) => shot(i * 3, i * 3 + 5));
    const n = draw(renderer(), many);
    expect(n).toBeLessThanOrEqual(ModeRenderer.MAX_DROPS * ModeRenderer.MAX_STREAMS);
    // And the hoses past the cap are dropped rather than squeezed in: the same
    // list truncated by hand draws exactly the same thing.
    expect(n).toBe(draw(renderer(), many.slice(0, ModeRenderer.MAX_STREAMS)));
  });

  it('forgets last frame\'s water', () => {
    // The streams are set every frame from a caller-owned array; a renderer
    // that held onto the old one would leave a jet hanging in the air for a
    // frame after the trigger was released, which reads as the weapon sticking.
    const r = renderer();
    expect(draw(r, [shot(0, 6), shot(20, 26)])).toBeGreaterThan(0);
    expect(draw(r, [])).toBe(0);
  });

  it('copies what it was handed rather than pointing at it', () => {
    // A caller refilling one scratch array every frame is the whole point of
    // taking a list rather than allocating one, and pointing at the caller's
    // objects would make the picture depend on when they were next touched.
    //
    // The mutation has to change the *shape* of the stream to discriminate:
    // emptying the array proves nothing, because the elements stay alive, and
    // a zero-length stream still draws the floor of two droplets. Collapsing a
    // six-metre jet changes the count, and a copy is unmoved by it.
    const r = renderer();
    const live = shot(0, 6);
    r.setStreams([live]);
    live.tx = live.fx;
    live.ty = live.fy;
    live.tz = live.fz;
    r.update(1 / 60, null, shots, 0, []);
    expect(r.streamDrops).toBe(draw(renderer(), [shot(0, 6)]));
  });
});
