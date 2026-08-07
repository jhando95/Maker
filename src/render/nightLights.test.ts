import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { NightLights, litSources, DEFAULT_BLOOM } from './nightLights.ts';
import { neighborhoodSlabs, HOUSE, type Slab } from '../world/neighborhood.ts';
import { Rng } from '../core/rng.ts';

const plain = (over: Partial<Slab> = {}): Slab => ({
  w: 1, h: 1, d: 1, x: 0, y: 0, z: 0, color: 0x888888, ...over,
});

describe('reading the lights off the map', () => {
  it('takes only the slabs that say they are lights', () => {
    const found = litSources([
      plain(),
      plain({ x: 5, lit: { color: 0xff0000 } }),
      plain({ x: 9 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.x).toBe(5);
    expect(found[0]!.color).toBe(0xff0000);
  });

  it('stands the glow exactly where the slab stands', () => {
    // The whole reason a light is a tag on a slab rather than a coordinate in a
    // list somewhere: nudge the lamp post and the light comes with it, because
    // there is only one record of where it is.
    const s = plain({ x: -11.2, y: 5.05, z: 30.5, lit: { color: 0xffffff } });
    const [glow] = litSources([s]);
    expect(glow!.x).toBe(s.x);
    expect(glow!.y).toBe(s.y);
    expect(glow!.z).toBe(s.z);
  });

  it('blooms past the slab it is painted on, in every direction', () => {
    const [glow] = litSources([
      plain({ w: 0.5, h: 0.2, d: 0.3, lit: { color: 0xffffff, bloom: 1 } }),
    ]);
    expect(glow!.w).toBeCloseTo(2.5, 6);
    expect(glow!.h).toBeCloseTo(2.2, 6);
    expect(glow!.d).toBeCloseTo(2.3, 6);
  });

  it('has a bloom for a caller who only said what colour', () => {
    const [glow] = litSources([plain({ w: 1, lit: { color: 0xffffff } })]);
    expect(glow!.w).toBeCloseTo(1 + DEFAULT_BLOOM * 2, 6);
  });

  it('carries the slab rotation, so a window on a turned house faces the road', () => {
    // Five of the six houses on the cul-de-sac are turned to look at the
    // turning head. A glow that ignored the rotation would sit in the wall
    // rather than in the window.
    const [glow] = litSources([plain({ ry: 0.7, lit: { color: 0xffffff } })]);
    expect(glow!.ry).toBeCloseTo(0.7, 6);
  });
});

describe('drawing them', () => {
  const build = (): NightLights =>
    new NightLights([
      plain({ x: 1, lit: { color: 0xffdd88 } }),
      plain({ x: 2, lit: { color: 0xffdd88 } }),
      plain({ x: 3, lit: { color: 0xffdd88 } }),
    ]);

  it('draws nothing at all through the afternoon', () => {
    // An instanced mesh's count is a number handed to the draw call, so a lamp
    // "hidden" by scaling its matrix to nothing is a lamp still being drawn.
    // This project has got that wrong twice; off has to mean a count of zero.
    const lights = build();
    expect(lights.lightCount).toBe(3);
    expect(lights.drawn).toBe(0);
    expect(lights.level).toBe(0);
  });

  it('draws every one of them once they are up', () => {
    const lights = build();
    lights.setLevel(1);
    expect(lights.drawn).toBe(3);
  });

  it('draws them all the moment there is any light at all', () => {
    // The warm-up is a dimmer, not a queue: a lamp at a tenth is a dim lamp,
    // not a lamp that has not been switched on yet.
    const lights = build();
    lights.setLevel(0.05);
    expect(lights.drawn).toBe(3);
  });

  it('goes back to drawing nothing when the level returns to zero', () => {
    const lights = build();
    lights.setLevel(1);
    lights.setLevel(0);
    expect(lights.drawn).toBe(0);
  });

  it('says whether anything changed, so a caller can skip the work', () => {
    const lights = build();
    expect(lights.setLevel(0)).toBe(false);
    expect(lights.setLevel(0.4)).toBe(true);
    expect(lights.setLevel(0.4)).toBe(false);
  });

  it('clamps a level that has gone strange rather than passing it on', () => {
    const lights = build();
    lights.setLevel(9);
    expect(lights.level).toBe(1);
    lights.setLevel(-3);
    expect(lights.level).toBe(0);
    lights.setLevel(NaN);
    expect(lights.level).toBe(0);
  });

  it('adds nothing to the picture rather than subtracting from it', () => {
    // Additive, and never writing depth. A glow that wrote depth would punch a
    // hole in the lamp post it is wrapped around, and one that blended normally
    // would darken the sky behind it instead of lighting it.
    const lights = build();
    const material = lights.mesh.material as THREE.ShaderMaterial;
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    // A light in haze blooms; it does not fade. Fogging it would be the one
    // thing in the scene that should get *more* visible as the fog closes in
    // getting less.
    expect(material.fog).toBe(false);
  });

  it('survives a map with no lights in it', () => {
    const lights = new NightLights([plain(), plain({ x: 4 })]);
    expect(lights.lightCount).toBe(0);
    expect(lights.drawn).toBe(0);
    lights.setLevel(1);
    expect(lights.drawn).toBe(0);
  });
});

describe('the map itself', () => {
  const slabs = neighborhoodSlabs(new Rng('lights'));
  const lights = litSources(slabs);

  it('actually has lights in it', () => {
    // The assertion that stops the tags quietly disappearing. Everything else
    // in this file would still pass against a neighbourhood where nothing is
    // tagged at all — it would just draw zero of zero, forever.
    expect(lights.length).toBeGreaterThanOrEqual(20);
  });

  it('lights both storeys of the evening: windows and the lamps above them', () => {
    // Two heights, and they do different jobs. Windows at head height say
    // people; lamps at five metres say the street. A dusk with only one of
    // them reads as either an empty neighbourhood or an unlit one.
    expect(lights.filter((l) => l.y > 4).length).toBeGreaterThanOrEqual(4);
    expect(lights.filter((l) => l.y > 1.8 && l.y < 2.6).length).toBeGreaterThanOrEqual(10);
  });

  /**
   * Lights on the player's own house, at door height, at either end of it.
   *
   * Bounded in x as well as z, and that is not belt-and-braces. Written as a z
   * band alone, the back-door check passed with the back-door light deleted:
   * a neighbour's front window forty-two metres east sits at z 7.2, which is
   * inside "behind the house" if you never said how far behind. It was a test
   * asserting on somebody else's house.
   */
  const onTheHouse = (near: number) => lights.filter((l) =>
    Math.abs(l.x) < HOUSE.halfWidth + 1
    && Math.abs(l.z - near) < 2.5
    && l.y > 1.5 && l.y < 3);

  it('lights the porch of the house the player lives in', () => {
    // The one lamp in the game that is theirs. Every other light at dusk is
    // somebody else's house across the road, which is atmosphere; a light over
    // your own front door is the bit that means you live here.
    expect(onTheHouse(-(HOUSE.halfDepth + 1.5)).length).toBeGreaterThanOrEqual(1);
  });

  it('puts one over the back door, which is where a round of Lava starts', () => {
    expect(onTheHouse(HOUSE.halfDepth).length).toBeGreaterThanOrEqual(1);
  });

  it('warms every one of them past the daylight they replace', () => {
    // A light the same colour as the sky it is seen against is not a light. The
    // whole read is that the windows go warmer than the evening does.
    for (const l of lights) {
      const r = (l.color >> 16) & 255;
      const b = l.color & 255;
      expect(r - b, `light at ${l.x},${l.z} is not warm`).toBeGreaterThan(40);
    }
  });
});
