import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { giveInstanceColor } from './instanceColor.ts';

const mesh = (slots: number) =>
  new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), slots);

describe('giving an instanced mesh its colour buffer up front', () => {
  it('makes one where there was none', () => {
    // The whole point: the presence of this buffer is part of the shader's
    // identity, so a mesh that gains it later compiles a second program in the
    // middle of a round.
    const m = mesh(8);
    expect(m.instanceColor).toBeNull();
    giveInstanceColor(m);
    expect(m.instanceColor).not.toBeNull();
  });

  it('sizes it from the slots, not from what is being drawn', () => {
    // `count` is routinely zero — that is how this project hides things — and a
    // buffer sized from it would be empty on exactly the meshes that matter.
    const m = mesh(8);
    m.count = 0;
    giveInstanceColor(m);
    expect(m.instanceColor!.count).toBe(8);
    expect(m.instanceColor!.array).toHaveLength(24);
  });

  it('fills it white, which is the identity for a multiply', () => {
    // Zeroed would paint every instance nobody has coloured black, which is a
    // far more visible bug than the stutter this removes.
    const m = mesh(4);
    giveInstanceColor(m);
    expect(Array.from(m.instanceColor!.array)).toEqual(new Array(12).fill(1));
  });

  it('leaves a buffer that already exists alone', () => {
    const m = mesh(4);
    m.setColorAt(0, new THREE.Color(1, 0, 0));
    const was = m.instanceColor;
    giveInstanceColor(m);
    expect(m.instanceColor).toBe(was);
    expect(m.instanceColor!.array[0]).toBe(1);
    expect(m.instanceColor!.array[1]).toBe(0);
  });

  it('hands the mesh back, so it can wrap a construction', () => {
    const m = mesh(2);
    expect(giveInstanceColor(m)).toBe(m);
  });

  it('does not disturb a colour written afterwards', () => {
    const m = mesh(4);
    giveInstanceColor(m);
    m.setColorAt(2, new THREE.Color(0, 0.5, 1));
    const c = new THREE.Color();
    m.getColorAt(2, c);
    expect(c.g).toBeCloseTo(0.5, 5);
    expect(c.b).toBeCloseTo(1, 5);
  });
});
