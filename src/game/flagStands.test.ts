/**
 * The scan that turns planted stands into bases.
 *
 * Everything else about a stand is tested where parts are tested — placement,
 * support, the wire. What is tested here is the one rule no other test owns:
 * which stands claim which side, and where the flag they claim actually sits.
 */

import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import {
  FLAG_POLE_KIND, LEFT_STAND_COLORWAY, RIGHT_STAND_COLORWAY,
} from '../build/partKit.ts';
import { flagStands } from './flagStands.ts';

/** A pole standing upright: local +X rotated to world +Y. */
const QZ = Math.SQRT1_2;

/** A standing pole whose foot is at ground level (centre 1m up a 2m pole). */
const pole = (x: number, z: number, colorway: number, y = 1.0) => ({
  kind: FLAG_POLE_KIND, colorway, x, y, z, qx: 0, qy: 0, qz: QZ, qw: QZ,
});

const plank = (x: number, z: number, colorway: number) => ({
  kind: 0, colorway, x, y: 0.5, z, qx: 0, qy: 0, qz: 0, qw: 1,
});

function makeBuild(): BuildSystem {
  return new BuildSystem(new CollisionWorld(), new PartRenderer());
}

describe('flag stands', () => {
  it('claims nothing on a yard with no stands', () => {
    const build = makeBuild();
    build.applyPlace(plank(3, 3, LEFT_STAND_COLORWAY));
    expect(flagStands(build)).toEqual({ left: null, right: null });
  });

  it('reads a blue stand as the left base, at the foot of the pole', () => {
    // The foot, not the centre: the capture radius and the drawn flag belong
    // on the ground the stand occupies, and for a 2m pole standing upright
    // the centre is a metre in the air.
    const build = makeBuild();
    build.applyPlace(pole(4, 6, LEFT_STAND_COLORWAY));
    const stands = flagStands(build);
    expect(stands.right).toBeNull();
    expect(stands.left).not.toBeNull();
    expect(stands.left!.x).toBeCloseTo(4, 5);
    expect(stands.left!.z).toBeCloseTo(6, 5);
    expect(stands.left!.y).toBeCloseTo(0, 5);
  });

  it('reads a red stand as the right base', () => {
    const build = makeBuild();
    build.applyPlace(pole(-7, 2, RIGHT_STAND_COLORWAY));
    const stands = flagStands(build);
    expect(stands.left).toBeNull();
    expect(stands.right!.x).toBeCloseTo(-7, 5);
  });

  it('lets the last stand planted win the argument', () => {
    // Re-planting your flag somewhere better has to be one action, not
    // find-and-demolish-the-old-one — and both machines must agree which one
    // counts, which is why the order is the part id and not iteration luck.
    const build = makeBuild();
    build.applyPlace(pole(4, 6, LEFT_STAND_COLORWAY));
    build.applyPlace(pole(-10, 12, LEFT_STAND_COLORWAY));
    expect(flagStands(build).left!.x).toBeCloseTo(-10, 5);
    expect(flagStands(build).left!.z).toBeCloseTo(12, 5);
  });

  it('treats any other paint as decoration', () => {
    const build = makeBuild();
    build.applyPlace(pole(4, 6, 0));
    build.applyPlace(pole(5, 6, 7));
    expect(flagStands(build)).toEqual({ left: null, right: null });
  });

  it('keeps a stand on a platform grounded on the platform', () => {
    // Centre 3m up means the foot is at 2m — a stand on a tower deck claims
    // the deck, which is where anyone capturing has to actually stand.
    const build = makeBuild();
    build.applyPlace(pole(0, 0, RIGHT_STAND_COLORWAY, 3.0));
    expect(flagStands(build).right!.y).toBeCloseTo(2.0, 5);
  });
});
