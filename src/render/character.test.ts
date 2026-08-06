import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CharacterBatch, lookFor, HIP_Y, TORSO_TOP, HEAD_Y } from './character.ts';
import { shirtColor, SHIRTS } from '../game/shirts.ts';
import { CAP_HEIGHT } from '../physics/constants.ts';
import { SOAKED } from '../game/wetness.ts';

const luma = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('how a kid looks', () => {
  it('is the same on every machine that draws them', () => {
    // The whole reason it is seeded by id rather than randomised. Two clients
    // that have never spoken must agree about what a person looks like, and
    // nobody should have to send it.
    for (const id of [0, 1, 7, 41, 900]) {
      const a = lookFor(id);
      const b = lookFor(id);
      expect(a.skin.getHexString()).toBe(b.skin.getHexString());
      expect(a.hair.getHexString()).toBe(b.hair.getHexString());
      expect(a.headScale).toBe(b.headScale);
    }
  });

  it('gives different people different heads', () => {
    const looks = Array.from({ length: 24 }, (_, i) => lookFor(i));
    const signatures = new Set(
      looks.map((l) => `${l.skin.getHexString()}/${l.hair.getHexString()}/${l.hairScaleY.toFixed(2)}`),
    );
    // Not all 24 — a palette repeats — but a lawn full of people must not be a
    // lawn full of one person.
    expect(signatures.size).toBeGreaterThan(12);
  });

  it('never puts hair the same colour as the skin under it', () => {
    // Both palettes are warm browns, so picking from each independently
    // eventually lands mid-brown on mid-brown and the head becomes one
    // featureless lump. Checked across far more ids than a round ever has.
    for (let id = 0; id < 400; id++) {
      const look = lookFor(id);
      const gap = Math.abs(luma(look.skin) - luma(look.hair));
      expect(gap, `kid ${id} has hair the colour of their head`).toBeGreaterThan(0.1);
    }
  });

  it('keeps heads a believable size, so nobody is a balloon', () => {
    for (let id = 0; id < 200; id++) {
      const look = lookFor(id);
      expect(look.headScale).toBeGreaterThan(0.8);
      expect(look.headScale).toBeLessThan(1.2);
    }
  });
});

describe('the character rig', () => {
  it('places joints inside the body that collides', () => {
    // A character whose feet float or sink is the first thing anyone notices,
    // so the drawing and the capsule are tied to the same height.
    expect(HIP_Y).toBeGreaterThan(0);
    expect(HIP_Y).toBeLessThan(TORSO_TOP);
    expect(TORSO_TOP).toBeLessThan(HEAD_Y);
    expect(HEAD_Y).toBeLessThan(CAP_HEIGHT);
  });

  it('draws exactly the people it was given', () => {
    const batch = new CharacterBatch(8);
    const shirt = new THREE.Color(0xffffff);
    batch.begin();
    for (let i = 0; i < 3; i++) {
      expect(batch.pose(1 / 60, {
        id: i, x: i, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt,
      })).toBe(true);
    }
    batch.finish();
    expect(batch.posed).toBe(3);
  });

  it('says no rather than growing when the pool is full', () => {
    // A mode may spawn more than the pool holds. Drawing as many as fit is the
    // right answer; growing an instanced buffer mid-round allocates and
    // recompiles at exactly the moment a wave arrives.
    const batch = new CharacterBatch(2);
    const shirt = new THREE.Color(0xffffff);
    batch.begin();
    expect(batch.pose(1 / 60, { id: 0, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt })).toBe(true);
    expect(batch.pose(1 / 60, { id: 1, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt })).toBe(true);
    expect(batch.pose(1 / 60, { id: 2, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt })).toBe(false);
    expect(batch.posed).toBe(2);
  });

  it('starts a new frame from nobody, so last frame cannot linger', () => {
    const batch = new CharacterBatch(4);
    const shirt = new THREE.Color(0xffffff);
    batch.begin();
    batch.pose(1 / 60, { id: 0, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt });
    batch.finish();
    batch.begin();
    batch.finish();
    expect(batch.posed).toBe(0);
  });

  it('carries a shell on the silhouette parts, and none on the small ones', () => {
    // The characters were the one thing in a world of inked objects that was not
    // inked. Counted rather than eyeballed: a shell that stops being created is
    // invisible in a screenshot until someone happens to look closely.
    const batch = new CharacterBatch(4);
    const meshes = batch.group.children.filter(
      (c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh === true,
    );
    const shells = meshes.filter((m) => m.material instanceof THREE.ShaderMaterial);
    // Torso, head, hair, two arms, two legs, two shoes.
    expect(shells.length).toBe(9);
    for (const shell of shells) {
      expect(shell.material).toHaveProperty('uniforms');
      expect((shell.material as THREE.ShaderMaterial).side).toBe(THREE.BackSide);
    }
  });

  it('hides everyone on demand, so leaving a round leaves an empty lawn', () => {
    const batch = new CharacterBatch(4);
    const shirt = new THREE.Color(0xffffff);
    batch.begin();
    batch.pose(1 / 60, { id: 0, x: 5, y: 0, z: 5, facing: 0, speed: 3, onGround: true, shirt });
    batch.finish();
    batch.hideAll();
    expect(batch.posed).toBe(0);

    const torso = batch.group.getObjectByName('torso') as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    torso.getMatrixAt(0, m);
    // Parked far below the world rather than resized, so instance counts never
    // churn.
    expect(m.elements[13]).toBeLessThan(-1000);
  });

  it('walks: a moving kid swings, a stopped one settles', () => {
    // Read off the instance matrices, because the stride is the one thing here
    // that is a function of time and could silently stop advancing.
    const batch = new CharacterBatch(2);
    const shirt = new THREE.Color(0xffffff);
    const legOf = (): THREE.Matrix4 => {
      const m = new THREE.Matrix4();
      (batch.group.getObjectByName('leg0') as THREE.InstancedMesh).getMatrixAt(0, m);
      return m;
    };

    const step = (speed: number): THREE.Matrix4 => {
      batch.begin();
      batch.pose(1 / 30, { id: 0, x: 0, y: 0, z: 0, facing: 0, speed, onGround: true, shirt });
      batch.finish();
      return legOf();
    };

    step(5);
    const a = step(5).clone();
    const b = step(5).clone();
    expect(a.equals(b), 'a walking kid should not hold one pose').toBe(false);

    // Stopped, the stride eases to neutral and stays there.
    for (let i = 0; i < 60; i++) step(0);
    const rest = step(0).clone();
    const stillRest = step(0).clone();
    const drift = new THREE.Vector3().setFromMatrixPosition(rest)
      .distanceTo(new THREE.Vector3().setFromMatrixPosition(stillRest));
    expect(drift).toBeLessThan(1e-3);
  });

  it('poses the air differently from the ground', () => {
    const batch = new CharacterBatch(2);
    const shirt = new THREE.Color(0xffffff);
    const legs = (onGround: boolean): THREE.Matrix4 => {
      batch.begin();
      batch.pose(1 / 60, { id: 0, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround, shirt });
      batch.finish();
      const m = new THREE.Matrix4();
      (batch.group.getObjectByName('leg0') as THREE.InstancedMesh).getMatrixAt(0, m);
      return m;
    };
    // A jump that leaves the legs hanging straight down is a person sliding
    // upwards rather than jumping.
    expect(legs(true).equals(legs(false))).toBe(false);
  });
});

describe('shirts', () => {
  it('paints the two sides differently, or the flag game is guesswork', () => {
    const left = shirtColor(new THREE.Color(), 'left');
    const right = shirtColor(new THREE.Color(), 'right');
    expect(left.getHexString()).not.toBe(right.getHexString());
    expect(left.getHexString()).toBe(SHIRTS.left.dry.getHexString());
  });

  it('darkens as it soaks, so you can see who is nearly finished', () => {
    const dry = shirtColor(new THREE.Color(), 'left', 0);
    const wet = shirtColor(new THREE.Color(), 'left', SOAKED);
    expect(luma(wet)).toBeLessThan(luma(dry));
  });

  it('washes a stunned kid out without losing whose side they are on', () => {
    // A fixed pale blue for "out of it" competed with the blue-violet of a team.
    // Stunned has to stay nearer its own side than the other one.
    const stunnedLeft = shirtColor(new THREE.Color(), 'left', 0, true);
    const stunnedRight = shirtColor(new THREE.Color(), 'right', 0, true);
    expect(stunnedLeft.getHexString()).not.toBe(stunnedRight.getHexString());

    const dist = (a: THREE.Color, b: THREE.Color) =>
      Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
    expect(dist(stunnedLeft, SHIRTS.left.dry)).toBeLessThan(dist(stunnedLeft, SHIRTS.right.dry));
    // And it must actually read as washed out, not merely differ.
    expect(luma(stunnedLeft)).toBeGreaterThan(luma(SHIRTS.left.dry));
  });

  it('allocates nothing, because it runs for everyone every frame', () => {
    const out = new THREE.Color();
    expect(shirtColor(out, 'right', 0.4)).toBe(out);
  });
});
