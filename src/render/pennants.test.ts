/**
 * The cloth on the stands, measured off the instanced mesh.
 *
 * The pennant system's whole job is a transform: placed pole records in,
 * instance matrices out. So the tests hand it records and read the matrices —
 * where the cloth hangs, what colour it is, and that yesterday's flags do not
 * survive a world that no longer contains them.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Pennants } from './pennants.ts';
import { COLORWAYS, FLAG_POLE_KIND } from '../build/partKit.ts';
import type { PlacementRecord } from '../build/buildSystem.ts';

const QZ = Math.SQRT1_2;

/** A pole standing upright at (x, z), centre `y` up its 2m length. */
const pole = (x: number, z: number, colorway = 5, y = 1.0): PlacementRecord => ({
  kind: FLAG_POLE_KIND, colorway, x, y, z, qx: 0, qy: 0, qz: QZ, qw: QZ,
});

const plank = (x: number, z: number): PlacementRecord => ({
  kind: 0, colorway: 5, x, y: 0.5, z, qx: 0, qy: 0, qz: 0, qw: 1,
});

const withIds = (...records: PlacementRecord[]): Array<[number, PlacementRecord]> =>
  records.map((r, i) => [i, r]);

function positionOf(pennants: Pennants, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  pennants.mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('pennants', () => {
  it('flies one flag per stand and none for lumber', () => {
    const pennants = new Pennants();
    pennants.refresh(withIds(pole(2, 3), plank(4, 4), pole(-5, 1)));
    expect(pennants.drawn).toBe(2);
  });

  it('hangs the cloth at the top of the pole', () => {
    // Centre a metre up a two-metre standing pole: the top is at two.
    const pennants = new Pennants();
    pennants.refresh(withIds(pole(2, 3)));
    const at = positionOf(pennants, 0);
    expect(at.x).toBeCloseTo(2, 5);
    expect(at.y).toBeCloseTo(2, 5);
    expect(at.z).toBeCloseTo(3, 5);
  });

  it('finds the top of a pole planted upside-down', () => {
    // Local +X rotated to world -Y: same pole, flipped. The flag still flies
    // at the high end, because "the top" is a fact about the world and not
    // about which way the part's axis happens to point.
    const flipped: PlacementRecord = {
      kind: FLAG_POLE_KIND, colorway: 5, x: 2, y: 1.0, z: 3,
      qx: 0, qy: 0, qz: -QZ, qw: QZ,
    };
    const pennants = new Pennants();
    pennants.refresh(withIds(flipped));
    expect(positionOf(pennants, 0).y).toBeCloseTo(2, 5);
  });

  it('paints the cloth with the paint on its pole', () => {
    const pennants = new Pennants();
    pennants.refresh(withIds(pole(2, 3, 5), pole(4, 3, 4)));
    const colors = pennants.mesh.instanceColor!;
    const blue = new THREE.Color(COLORWAYS[5]!);
    const red = new THREE.Color(COLORWAYS[4]!);
    expect(colors.getX(0)).toBeCloseTo(blue.r, 5);
    expect(colors.getZ(0)).toBeCloseTo(blue.b, 5);
    expect(colors.getX(1)).toBeCloseTo(red.r, 5);
    // And the two are actually different, or this test paints nothing.
    expect(blue.getHex()).not.toBe(red.getHex());
  });

  it('takes a flag down with the stand that flew it', () => {
    const pennants = new Pennants();
    pennants.refresh(withIds(pole(2, 3)));
    expect(pennants.drawn).toBe(1);
    pennants.refresh([]);
    expect(pennants.drawn).toBe(0);
    expect(pennants.mesh.visible).toBe(false);
  });
});
