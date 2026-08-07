import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CharacterBatch, lookFor, HIP_Y, TORSO_TOP, HEAD_Y, HEAD_R } from './character.ts';
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

    // Nothing is submitted, which is a stronger claim than the one this used to
    // make. Unused slots were given a matrix that parked them below the world,
    // on the stated grounds that resizing would churn instance counts — and
    // that is not a thing that happens: `count` is a number three.js hands to
    // the draw call, not a buffer to reallocate. So the old arrangement paid
    // the GPU to transform thirteen thousand triangles into no pixels, and paid
    // the CPU to write the matrices that made them invisible.
    const torso = batch.group.getObjectByName('torso') as THREE.InstancedMesh;
    expect(torso.count).toBe(0);
    const eyes = batch.group.getObjectByName('eyes') as THREE.InstancedMesh;
    expect(eyes.count).toBe(0);
  });

  it('draws exactly as many people as were posed', () => {
    // The other half, and the one that would catch a `count` left at capacity:
    // hiding everybody is easy to get right by accident, and a batch that draws
    // its whole pool whenever anybody is on the lawn is the actual bug.
    const batch = new CharacterBatch(8);
    const shirt = new THREE.Color(0xffffff);
    batch.begin();
    for (let id = 0; id < 3; id++) {
      batch.pose(1 / 60, { id, x: id, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt });
    }
    batch.finish();

    const torso = batch.group.getObjectByName('torso') as THREE.InstancedMesh;
    expect(torso.count).toBe(3);
    // Two eyes and two hands each, so those run at twice the count.
    expect((batch.group.getObjectByName('eyes') as THREE.InstancedMesh).count).toBe(6);
    // And one neck and one mouth each. Listed by name rather than counted,
    // because a part left at zero is a part that is simply never drawn and
    // nothing else in the frame says so.
    expect((batch.group.getObjectByName('mouth') as THREE.InstancedMesh).count).toBe(3);
    expect((batch.group.getObjectByName('neck') as THREE.InstancedMesh).count).toBe(3);
    // And the ink follows the body it outlines, or a kid loses their outline.
    const ink = batch.group.getObjectByName('torso-ink') as THREE.InstancedMesh | null;
    if (ink !== null) expect(ink.count).toBe(3);
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

  it('seats the face on the head rather than hanging it off the front', () => {
    // The bug this replaced, and the reason it took a screenshot from the side
    // to find. The eyes were placed at the offset (0.37r, -0.14r, -0.97r),
    // which reads as "just inside the surface" and is nothing of the sort: that
    // vector is 1.048r long, and the eye's own radius added another quarter of
    // a head on top. Face on it looked perfect. In profile it was a black bead
    // stuck to the temple.
    //
    // Checked across every head size the look generator can produce, because
    // the eyes did not scale with the head either — so the bigger the head, the
    // worse it got, and the ids that produce big heads are a minority.
    const batch = new CharacterBatch(4);
    const shirt = new THREE.Color(0xffffff);
    const centre = new THREE.Vector3();
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const m = new THREE.Matrix4();

    const readAt = (name: string, slot: number, out: THREE.Vector3): number => {
      const mesh = batch.group.getObjectByName(name) as THREE.InstancedMesh;
      mesh.getMatrixAt(slot, m);
      out.setFromMatrixPosition(m);
      m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      // How far the part stands out along its own facing, which is the number
      // that matters. Its bounding *sphere* would be the eye's width, and the
      // eye is a flattened disc — measuring the wrong axis would fail a feature
      // that is doing exactly the right thing.
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox!.max.z * scale.z;
    };

    for (let id = 0; id < 120; id++) {
      const look = lookFor(id);
      const r = HEAD_R * look.headScale;
      batch.begin();
      batch.pose(1 / 60, { id, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt });
      batch.finish();
      readAt('head', 0, centre);

      for (const [name, slot] of [['eyes', 0], ['eyes', 1], ['mouth', 0]] as const) {
        const depth = readAt(name, slot, at);
        const out = at.distanceTo(centre);
        expect(out / r, `kid ${id}: the ${name} are floating off the face`)
          .toBeLessThan(1.02);
        expect(out / r, `kid ${id}: the ${name} are inside the skull`)
          .toBeGreaterThan(0.9);
        expect((out + depth) / r, `kid ${id}: the ${name} stand proud of the head`)
          .toBeLessThan(1.14);
      }
    }
  });

  it('grows the face with the head, or a big kid has beady eyes', () => {
    const batch = new CharacterBatch(4);
    const shirt = new THREE.Color(0xffffff);
    const scaleOf = (id: number): number => {
      batch.begin();
      batch.pose(1 / 60, { id, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt });
      batch.finish();
      const m = new THREE.Matrix4();
      (batch.group.getObjectByName('eyes') as THREE.InstancedMesh).getMatrixAt(0, m);
      const scale = new THREE.Vector3();
      m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      return scale.x;
    };
    // Find the two extremes the generator actually produces rather than
    // asserting on a pair of ids that might both land in the middle.
    let smallest = 0;
    let largest = 0;
    for (let id = 0; id < 200; id++) {
      if (lookFor(id).headScale < lookFor(smallest).headScale) smallest = id;
      if (lookFor(id).headScale > lookFor(largest).headScale) largest = id;
    }
    expect(lookFor(largest).headScale).toBeGreaterThan(lookFor(smallest).headScale);
    expect(scaleOf(largest)).toBeGreaterThan(scaleOf(smallest));
  });

  it('leaves no gap between the smallest head and the collar', () => {
    // `headScale` runs down to 0.92, and the head's centre is fixed — so the
    // small heads clear the top of the torso and float. That is what the neck
    // is for, and it is invisible on every other kid, which is exactly the kind
    // of part that stops being correct without anybody noticing.
    const batch = new CharacterBatch(2);
    const shirt = new THREE.Color(0xffffff);
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();

    let smallest = 0;
    for (let id = 0; id < 200; id++) {
      if (lookFor(id).headScale < lookFor(smallest).headScale) smallest = id;
    }
    batch.begin();
    batch.pose(1 / 60, {
      id: smallest, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt,
    });
    batch.finish();

    const neck = batch.group.getObjectByName('neck') as THREE.InstancedMesh;
    neck.getMatrixAt(0, m);
    at.setFromMatrixPosition(m);
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    neck.geometry.computeBoundingBox();
    const half = neck.geometry.boundingBox!.max.y * scale.y;

    const chin = HEAD_Y - HEAD_R * lookFor(smallest).headScale;
    expect(at.y + half, 'the neck must reach the jaw').toBeGreaterThanOrEqual(chin);
    expect(at.y - half, 'and down into the collar').toBeLessThanOrEqual(TORSO_TOP);
  });

  it('breathes when standing, without moving anybody\'s feet', () => {
    // Four kids waiting on a lawn were four statues in identical poses, which
    // is the loudest thing wrong with a group shot: a person who is completely
    // still is not a person.
    //
    // The feet half is not decoration. The stride eases to neutral and settles
    // when somebody stops, and a breath leaking into the legs would leave a
    // walk cycle that never quite finishes — which is what the easing exists to
    // prevent in the first place.
    const batch = new CharacterBatch(2);
    const shirt = new THREE.Color(0xffffff);
    const sample = (part: string): THREE.Vector3 => {
      const m = new THREE.Matrix4();
      (batch.group.getObjectByName(part) as THREE.InstancedMesh).getMatrixAt(0, m);
      return new THREE.Vector3().setFromMatrixPosition(m);
    };
    const step = (): void => {
      batch.begin();
      batch.pose(1 / 30, { id: 3, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt });
      batch.finish();
    };

    // Let the stride settle first, so what is left moving is the breath.
    for (let i = 0; i < 90; i++) step();
    let mostTorso = 0;
    let mostLeg = 0;
    const torso0 = sample('torso');
    const leg0 = sample('leg0');
    for (let i = 0; i < 40; i++) {
      step();
      mostTorso = Math.max(mostTorso, sample('torso').distanceTo(torso0));
      mostLeg = Math.max(mostLeg, sample('leg0').distanceTo(leg0));
    }
    expect(mostTorso, 'a standing kid should still be breathing').toBeGreaterThan(0.002);
    expect(mostLeg, 'but their feet should be on the ground').toBeLessThan(1e-6);
  });

  it('does not have a whole lawn of them breathing in step', () => {
    const batch = new CharacterBatch(8);
    const shirt = new THREE.Color(0xffffff);
    const heights: number[] = [];
    const ids = [3, 4, 5, 6, 7];
    batch.begin();
    for (const id of ids) {
      batch.pose(1 / 30, { id, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt });
    }
    batch.finish();
    const torso = batch.group.getObjectByName('torso') as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    for (let i = 0; i < ids.length; i++) {
      torso.getMatrixAt(i, m);
      heights.push(new THREE.Vector3().setFromMatrixPosition(m).y);
    }
    const spread = Math.max(...heights) - Math.min(...heights);
    expect(spread, 'they should not all inhale together').toBeGreaterThan(0.002);
  });

  it('builds kids to different widths and never to different heights', () => {
    // Width is the safe axis. The joints are tied to `CAP_HEIGHT` precisely so
    // the drawing and the thing that collides cannot disagree about how tall
    // somebody is, and a kid drawn taller than their own capsule has feet that
    // float.
    const batch = new CharacterBatch(8);
    const shirt = new THREE.Color(0xffffff);
    const widths: number[] = [];
    const heights = new Set<number>();
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const at = new THREE.Vector3();
    const torso = () => batch.group.getObjectByName('torso') as THREE.InstancedMesh;

    for (let id = 0; id < 40; id++) {
      batch.begin();
      batch.pose(1 / 60, { id, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt });
      batch.finish();
      torso().getMatrixAt(0, m);
      m.decompose(at, new THREE.Quaternion(), scale);
      widths.push(scale.x);
      heights.add(Number(scale.y.toFixed(6)));
    }
    expect(new Set(widths.map((w) => w.toFixed(3))).size,
      'a line of kids should not be one kid recoloured').toBeGreaterThan(8);
    expect(heights, 'nobody may be drawn taller or shorter than their capsule')
      .toEqual(new Set([1]));
  });

  it('forgets a kid who is no longer being drawn', () => {
    // Ids come from a counter that never goes backwards inside a round and Water
    // War spawns a raid every few seconds, so state keyed by id and never pruned
    // grows for as long as a round lasts. Pruning on "was not posed" rather than
    // on a departure hook is the point: a bot goes down inside its mode, a guest
    // drops off a socket, a whole roster is replaced at the end of a round —
    // three places to remember, and the one that is forgotten leaves a ghost.
    const batch = new CharacterBatch(8);
    const shirt = new THREE.Color(0xffffff);
    const drawSome = (count: number): void => {
      batch.begin();
      for (let id = 0; id < count; id++) {
        batch.pose(1 / 60, { id, x: id, y: 0, z: 0, facing: 0, speed: 3, onGround: true, shirt });
      }
      batch.finish();
    };
    drawSome(5);
    expect(batch.remembered).toBe(5);
    drawSome(2);
    expect(batch.remembered, 'three kids left the world and are still remembered').toBe(2);
    drawSome(0);
    expect(batch.remembered).toBe(0);
  });

  it('opens the mouth of somebody who is out of it', () => {
    // The only expression in the game, and it costs a different scale rather
    // than different geometry. The shirt already says "out of the fight" at
    // forty metres; this says it at four.
    const batch = new CharacterBatch(2);
    const shirt = new THREE.Color(0xffffff);
    const mouth = (stunned: boolean): THREE.Vector3 => {
      batch.begin();
      batch.pose(1 / 60, {
        id: 0, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt, stunned,
      });
      batch.finish();
      const m = new THREE.Matrix4();
      (batch.group.getObjectByName('mouth') as THREE.InstancedMesh).getMatrixAt(0, m);
      const scale = new THREE.Vector3();
      m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      return scale;
    };
    const calm = mouth(false);
    const shocked = mouth(true);
    expect(shocked.y).toBeGreaterThan(calm.y);
    expect(shocked.x).toBeLessThan(calm.x);
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
