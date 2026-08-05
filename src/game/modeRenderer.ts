/**
 * Draws whatever the running mode has in the world: bots, balloons, the stash.
 *
 * Presentation only — it reads mode state and never writes it. Bots and balloons
 * are pooled InstancedMeshes sized to their hard caps, so a wave arriving costs
 * no allocation and no shader compile mid-round.
 */

import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial } from '../render/toonMaterial.ts';
import { chamferedBox, blob } from '../render/geometry.ts';
import { Rng } from '../core/rng.ts';
import { MAX_BALLOONS, BALLOON_RADIUS } from './projectiles.ts';
import type { ProjectileSystem } from './projectiles.ts';
import type { GameMode } from './gameMode.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';
import { wetBlend } from './wetness.ts';
import type { Actor, Team } from './actor.ts';

const MAX_BOTS = 24;
/** Simultaneous splash bursts. */
const MAX_SPLASHES = 16;
const SPLASH_LIFETIME = 0.5;

/** Objective stands and flags a mode can ask for at once. */
const MAX_MARKERS = 8;
const MAX_FLAGS = 4;
/**
 * Droplets in a stream.
 *
 * A jet drawn as one tapered mesh reads as a solid rod of glass; a line of
 * shrinking blobs reads as water, and it comes free because it is one instanced
 * draw either way.
 */
const MAX_DROPS = 26;

interface Splash {
  x: number; y: number; z: number;
  age: number;
  active: boolean;
}

/** A crate with a floating diamond over it: any objective you stand on. */
interface Stand {
  group: THREE.Group;
  crateMaterial: THREE.MeshToonMaterial;
  glow: THREE.Mesh;
  glowMaterial: THREE.MeshToonMaterial;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshToonMaterial;
}

/** A pole with a cloth on it: the thing you actually carry. */
interface FlagPole {
  group: THREE.Group;
  cloth: THREE.Mesh;
  clothMaterial: THREE.MeshToonMaterial;
}

export class ModeRenderer {
  readonly group = new THREE.Group();

  private readonly botBody: THREE.InstancedMesh;
  private readonly botHead: THREE.InstancedMesh;
  private readonly balloons: THREE.InstancedMesh;
  private readonly splashMesh: THREE.InstancedMesh;
  private readonly stands: Stand[] = [];
  private readonly flagPoles: FlagPole[] = [];
  private readonly drops: THREE.InstancedMesh;
  private streamFrom: { x: number; y: number; z: number } | null = null;
  private streamEnd: { x: number; y: number; z: number } | null = null;

  private readonly splashes: Splash[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private readonly outlineMaterials: THREE.ShaderMaterial[] = [];
  private readonly outlineMeshes: THREE.Mesh[] = [];

  /** Kept off-screen rather than resized, so instance counts never churn. */
  private static readonly HIDDEN = new THREE.Matrix4().makeTranslation(0, -9999, 0);
  private static readonly NO_ROTATION = new THREE.Quaternion();
  /** Hoisted: composing a character's matrix allocated one of these per bot per frame. */
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  /**
   * A dry shirt and the same shirt wringing wet, per side.
   *
   * Two palettes rather than one because the moment your own team existed, one
   * palette meant every kid on the lawn looked identical and the flag game
   * became guesswork — you cannot decide who to throw at if you cannot tell who
   * is who. Violet against the neighbourhood's oranges and greens rather than a
   * second warm colour, and deliberately not the pale blue a stunned kid washes
   * out to, which would make "on your side" and "out of it" the same cue.
   */
  private static readonly SHIRTS: Record<Team, { dry: THREE.Color; soaked: THREE.Color }> = {
    left: {
      dry: new THREE.Color().setHex(0x7a3fc8, THREE.SRGBColorSpace),
      soaked: new THREE.Color().setHex(0x321a5c, THREE.SRGBColorSpace),
    },
    right: {
      dry: new THREE.Color().setHex(0xe07a4f, THREE.SRGBColorSpace),
      soaked: new THREE.Color().setHex(0x6b3524, THREE.SRGBColorSpace),
    },
  };

  /**
   * What being stunned looks like: your own shirt, washed out.
   *
   * Not a colour of its own. A fixed pale blue for "out of it" competed with the
   * blue-violet of a team — a screenshot with one kid from each side in it had
   * them reading as the same thing, and under the toon ramp a mid violet
   * desaturates almost exactly onto that blue. Washing the team colour toward
   * this keeps who someone is while saying they are briefly not a threat, which
   * are two different questions and should not share a channel.
   */
  private static readonly STUNNED_WASH = new THREE.Color().setHex(0xd6e2ea, THREE.SRGBColorSpace);

  constructor() {
    this.group.name = 'mode';
    const rng = new Rng('mode-visuals');

    // Bots: a capsule body and a round head, same silhouette as the player so
    // they read as other kids rather than as a different kind of thing.
    const bodyGeometry = new THREE.CapsuleGeometry(CAP_RADIUS, CAP_HEIGHT - CAP_RADIUS * 2, 4, 10);
    this.botBody = new THREE.InstancedMesh(
      bodyGeometry,
      createToonMaterial({ color: 0xffffff }),
      MAX_BOTS,
    );
    this.botBody.castShadow = true;
    this.botBody.frustumCulled = false;

    const headGeometry = blob(0.22, 1, 0.1, () => rng.next());
    this.botHead = new THREE.InstancedMesh(
      headGeometry,
      createToonMaterial({ color: 0xf0c8a0 }),
      MAX_BOTS,
    );
    this.botHead.castShadow = true;
    this.botHead.frustumCulled = false;

    this.group.add(this.botBody, this.botHead);

    // Balloons in flight.
    const balloonGeometry = new THREE.SphereGeometry(BALLOON_RADIUS, 8, 6);
    this.balloons = new THREE.InstancedMesh(
      balloonGeometry,
      createToonMaterial({ color: 0x4fc3e8 }),
      MAX_BALLOONS,
    );
    this.balloons.castShadow = true;
    this.balloons.frustumCulled = false;
    this.group.add(this.balloons);

    // Splashes: one expanding, fading sphere each. Cheaper than a particle
    // system and reads fine at cartoon scale.
    const splashGeometry = new THREE.SphereGeometry(1, 8, 6);
    const splashMaterial = createToonMaterial({ color: 0x9fe8ff });
    splashMaterial.transparent = true;
    splashMaterial.opacity = 0.55;
    splashMaterial.depthWrite = false;
    this.splashMesh = new THREE.InstancedMesh(splashGeometry, splashMaterial, MAX_SPLASHES);
    this.splashMesh.frustumCulled = false;
    this.group.add(this.splashMesh);

    for (let i = 0; i < MAX_SPLASHES; i++) {
      this.splashes.push({ x: 0, y: 0, z: 0, age: 0, active: false });
    }

    // Objective markers: a pool of stands and a pool of flags, positioned from
    // whatever the running mode publishes. The renderer used to know what a
    // stash and a bucket were, which meant a second mode could not add an
    // objective without editing drawing code.
    for (let i = 0; i < MAX_MARKERS; i++) {
      this.stands.push(this.makeStand());
    }
    for (let i = 0; i < MAX_FLAGS; i++) {
      this.flagPoles.push(this.makeFlag());
    }

    // The stream: droplets strung from the nozzle to wherever the mode says the
    // water stops. Pooled and hidden off-screen like everything else here, so a
    // trigger pull never compiles a shader.
    this.drops = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 6, 5),
      createToonMaterial({ color: 0x8fd8f4 }),
      MAX_DROPS,
    );
    this.drops.frustumCulled = false;
    this.drops.castShadow = false;
    this.group.add(this.drops);

    this.hideAll();
  }

  /**
   * A crate, a range ring and a floating diamond.
   *
   * The diamond does the work: an objective you cannot see from inside your own
   * fort is one you never plan a route to, and the ring shows exactly where
   * "close enough" is so nothing ever fails for an invisible reason.
   */
  private makeStand(): Stand {
    const group = new THREE.Group();

    const crateGeometry = chamferedBox(1.1, 0.8, 1.1, 0.02);
    const crateMaterial = createToonMaterial({ color: 0xd8564f });
    const crate = new THREE.Mesh(crateGeometry, crateMaterial);
    crate.castShadow = true;
    crate.receiveShadow = true;
    crate.position.y = 0.4;
    group.add(crate);

    const outline = new THREE.Mesh(crateGeometry, createOutlineMaterial(0x3a2c2a, 0.02));
    outline.position.y = 0.4;
    group.add(outline);
    this.outlineMaterials.push(outline.material as THREE.ShaderMaterial);
    this.outlineMeshes.push(outline);

    const glowMaterial = createToonMaterial({ color: 0xffe98a });
    glowMaterial.transparent = true;
    glowMaterial.opacity = 0.85;
    const glow = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), glowMaterial);
    glow.position.y = 1.6;
    group.add(glow);

    const ringMaterial = createToonMaterial({ color: 0x9fd8ee });
    ringMaterial.transparent = true;
    ringMaterial.opacity = 0.45;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.5, 0.05, 6, 24).rotateX(Math.PI / 2),
      ringMaterial,
    );
    ring.position.y = 0.03;
    group.add(ring);

    group.visible = false;
    this.group.add(group);
    return { group, crateMaterial, glow, glowMaterial, ring, ringMaterial };
  }

  private makeFlag(): FlagPole {
    const group = new THREE.Group();

    const poleGeometry = chamferedBox(0.08, 1.9, 0.08, 0.01);
    const pole = new THREE.Mesh(poleGeometry, createToonMaterial({ color: 0xd8b585 }));
    pole.castShadow = true;
    pole.position.y = 0.95;
    group.add(pole);

    // A bedsheet on a broom handle, which is what a backyard flag is.
    const clothGeometry = chamferedBox(0.9, 0.6, 0.04, 0.01);
    const clothMaterial = createToonMaterial({ color: 0xff8a6a });
    const cloth = new THREE.Mesh(clothGeometry, clothMaterial);
    cloth.castShadow = true;
    cloth.position.set(0.47, 1.5, 0);
    group.add(cloth);

    const outline = new THREE.Mesh(clothGeometry, createOutlineMaterial(0x3a2c2a, 0.02));
    outline.position.copy(cloth.position);
    group.add(outline);
    this.outlineMaterials.push(outline.material as THREE.ShaderMaterial);
    this.outlineMeshes.push(outline);

    group.visible = false;
    this.group.add(group);
    return { group, cloth, clothMaterial };
  }

  private hideAll(): void {
    for (let i = 0; i < MAX_BOTS; i++) {
      this.botBody.setMatrixAt(i, ModeRenderer.HIDDEN);
      this.botHead.setMatrixAt(i, ModeRenderer.HIDDEN);
    }
    for (let i = 0; i < MAX_BALLOONS; i++) this.balloons.setMatrixAt(i, ModeRenderer.HIDDEN);
    for (let i = 0; i < MAX_SPLASHES; i++) this.splashMesh.setMatrixAt(i, ModeRenderer.HIDDEN);
    this.botBody.instanceMatrix.needsUpdate = true;
    this.botHead.instanceMatrix.needsUpdate = true;
    this.balloons.instanceMatrix.needsUpdate = true;
    this.splashMesh.instanceMatrix.needsUpdate = true;
  }

  /** Add a splash burst at a world position. */
  splash(x: number, y: number, z: number): void {
    let slot = this.splashes.findIndex((s) => !s.active);
    // All busy: recycle the oldest, which is the least missed.
    if (slot === -1) {
      slot = 0;
      let oldest = -1;
      this.splashes.forEach((s, i) => {
        if (s.age > oldest) {
          oldest = s.age;
          slot = i;
        }
      });
    }
    const s = this.splashes[slot]!;
    s.x = x; s.y = y; s.z = z;
    s.age = 0;
    s.active = true;
  }

  /** Called every frame. `time` drives the stash marker's idle animation. */
  update(
    dt: number,
    mode: GameMode | null,
    projectiles: ProjectileSystem,
    time: number,
    /**
     * Everyone to draw except the person holding the camera.
     *
     * Passed in rather than read off the mode because a remote player is not
     * the mode's business — the mode owns its bots, the session owns its
     * people, and both need drawing the same way. Omitted, this falls back to
     * the mode's bots, which is what the headless tests hand it.
     */
    others?: readonly Actor[],
  ): void {
    this.updateCharacters(others ?? mode?.bots ?? [], mode);
    this.updateBalloons(projectiles);
    this.updateSplashes(dt);
    this.updateMarkers(mode, time);
    this.updateStream(time);
  }

  /**
   * Where the water is going this frame.
   *
   * Set every frame from the mode, because a stream that persists for one frame
   * after the trigger is released reads as the weapon sticking.
   */
  setStream(
    end: { x: number; y: number; z: number } | null,
    fromX: number, fromY: number, fromZ: number,
  ): void {
    this.streamEnd = end;
    this.streamFrom = end === null ? null : { x: fromX, y: fromY, z: fromZ };
  }

  private updateStream(time: number): void {
    const from = this.streamFrom;
    const to = this.streamEnd;
    if (from === null || to === null) {
      for (let i = 0; i < MAX_DROPS; i++) this.drops.setMatrixAt(i, ModeRenderer.HIDDEN);
      this.drops.instanceMatrix.needsUpdate = true;
      return;
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    const used = Math.max(2, Math.min(MAX_DROPS, Math.round(length * 2.6)));

    for (let i = 0; i < MAX_DROPS; i++) {
      if (i >= used) {
        this.drops.setMatrixAt(i, ModeRenderer.HIDDEN);
        continue;
      }
      const t = (i + 0.5) / used;
      // A little sag and a little wobble: dead straight reads as a laser.
      const sag = Math.sin(t * Math.PI) * length * 0.035;
      const wobble = Math.sin(time * 22 + i * 1.7) * 0.035 * t;
      this.pos.set(
        from.x + dx * t + wobble,
        from.y + dy * t - sag,
        from.z + dz * t + wobble,
      );
      // Fattens along its length, so the jet has a direction you can read.
      this.scale.setScalar(0.045 + t * 0.085);
      this.matrix.compose(this.pos, ModeRenderer.NO_ROTATION, this.scale);
      this.drops.setMatrixAt(i, this.matrix);
    }
    this.scale.setScalar(1);
    this.drops.instanceMatrix.needsUpdate = true;
  }

  /**
   * Position the pools from whatever the mode published.
   *
   * Pools rather than meshes created per round: a marker appearing mid-round
   * would compile a shader on the frame it appeared, which is a visible hitch
   * at exactly the moment something important just happened.
   */
  private updateMarkers(mode: GameMode | null, time: number): void {
    const markers = mode?.markers() ?? [];
    let standIndex = 0;
    let flagIndex = 0;

    for (const marker of markers) {
      if (marker.kind === 'flag') {
        const flag = this.flagPoles[flagIndex++];
        if (flag === undefined) continue;
        flag.group.visible = true;
        flag.group.position.set(marker.x, marker.y, marker.z);
        // Carried flags ride above the shoulder and spin; planted ones stand.
        flag.group.position.y += marker.active === true ? 1.1 : 0;
        flag.group.rotation.y = marker.active === true ? time * 2.2 : Math.sin(time * 0.7) * 0.25;
        flag.clothMaterial.color.setHex(marker.color, THREE.SRGBColorSpace);
        continue;
      }

      const stand = this.stands[standIndex++];
      if (stand === undefined) continue;
      stand.group.visible = true;
      stand.group.position.set(marker.x, marker.y, marker.z);
      stand.crateMaterial.color.setHex(marker.color, THREE.SRGBColorSpace);
      stand.ringMaterial.color.setHex(marker.color, THREE.SRGBColorSpace);
      stand.ring.visible = marker.kind === 'bucket';

      // A slow bob and spin, so a marker reads as a live objective rather than
      // as another piece of scenery. The active one lifts and spins faster,
      // which is legible from third person where the HUD bar is easy to miss.
      const active = marker.active === true;
      stand.glow.position.y = 1.6 + Math.sin(time * 2.2 + standIndex * 1.7) * 0.12;
      stand.glow.rotation.y = time * (active ? 2.6 : 1.1);
      stand.glow.scale.setScalar(active ? 1.3 : 1);
      stand.glowMaterial.opacity = marker.faded === true ? 0.35 : 0.85;
    }

    for (let i = standIndex; i < this.stands.length; i++) this.stands[i]!.group.visible = false;
    for (let i = flagIndex; i < this.flagPoles.length; i++) this.flagPoles[i]!.group.visible = false;
  }

  /**
   * Draw everyone who is not holding the camera.
   *
   * Was `updateBots`, and the rename is the point: a bot and another person are
   * the same silhouette moving through the same world, and the only thing this
   * code ever needed from either was a position, a facing, and how wet they are.
   */
  private updateCharacters(others: readonly Actor[], mode: GameMode | null): void {
    let count = 0;
    for (const who of others) {
      if (who.alive === false || count >= MAX_BOTS) continue;

      const body = who.controller;
      const facing = who.heading ?? 0;
      this.pos.set(body.x, body.y + CAP_HEIGHT / 2, body.z);
      this.quat.setFromAxisAngle(ModeRenderer.UP, facing);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.botBody.setMatrixAt(count, this.matrix);

      // Stunned characters wash out toward blue, so it is obvious at a glance
      // who is still a threat. Otherwise the shirt darkens as it soaks, which is
      // how the player reads who is nearly finished and picks a target.
      const shirt = ModeRenderer.SHIRTS[who.team];
      this.color.copy(shirt.dry);
      this.color.lerp(shirt.soaked, wetBlend(mode?.wetnessOf?.(who.id) ?? 0));
      // Washed out while stunned, so it stays obvious at a glance who is still a
      // threat without costing the team colour that says whose side they are on.
      if (who.stunned === true) this.color.lerp(ModeRenderer.STUNNED_WASH, 0.72);
      this.botBody.setColorAt(count, this.color);

      this.pos.set(body.x, body.y + CAP_HEIGHT - 0.05, body.z);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.botHead.setMatrixAt(count, this.matrix);

      count++;
    }

    for (let i = count; i < MAX_BOTS; i++) {
      this.botBody.setMatrixAt(i, ModeRenderer.HIDDEN);
      this.botHead.setMatrixAt(i, ModeRenderer.HIDDEN);
    }
    this.botBody.count = MAX_BOTS;
    this.botHead.count = MAX_BOTS;
    this.botBody.instanceMatrix.needsUpdate = true;
    this.botHead.instanceMatrix.needsUpdate = true;
    if (this.botBody.instanceColor !== null) this.botBody.instanceColor.needsUpdate = true;
  }

  private updateBalloons(projectiles: ProjectileSystem): void {
    const seen = new Set<number>();
    projectiles.forEachActive((index, x, y, z) => {
      this.pos.set(x, y, z);
      this.matrix.compose(this.pos, new THREE.Quaternion(), this.scale);
      this.balloons.setMatrixAt(index, this.matrix);
      seen.add(index);
    });
    for (let i = 0; i < MAX_BALLOONS; i++) {
      if (!seen.has(i)) this.balloons.setMatrixAt(i, ModeRenderer.HIDDEN);
    }
    this.balloons.instanceMatrix.needsUpdate = true;
  }

  private updateSplashes(dt: number): void {
    for (let i = 0; i < this.splashes.length; i++) {
      const s = this.splashes[i]!;
      if (!s.active) {
        this.splashMesh.setMatrixAt(i, ModeRenderer.HIDDEN);
        continue;
      }
      s.age += dt;
      if (s.age >= SPLASH_LIFETIME) {
        s.active = false;
        this.splashMesh.setMatrixAt(i, ModeRenderer.HIDDEN);
        continue;
      }
      // Expand fast then hold, which reads as a burst rather than a balloon.
      const t = s.age / SPLASH_LIFETIME;
      const radius = 0.25 + Math.sqrt(t) * 1.1;
      this.pos.set(s.x, s.y, s.z);
      this.scale.setScalar(radius);
      this.matrix.compose(this.pos, new THREE.Quaternion(), this.scale);
      this.splashMesh.setMatrixAt(i, this.matrix);
      this.scale.setScalar(1);
    }
    this.splashMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Toggle every outline shell.
   *
   * The old version walked the stash group looking for meshes whose material
   * was outlineMaterials[0], which matched exactly one mesh and silently left
   * every other outline on. Keeping a list of the shells removes the search and
   * the class of bug with it.
   */
  setOutlinesVisible(visible: boolean): void {
    for (const shell of this.outlineMeshes) shell.visible = visible;
  }

  setViewportHeight(height: number): void {
    for (const m of this.outlineMaterials) m.uniforms.viewportHeight!.value = height;
  }

  /** Hide everything, e.g. when returning to the menu. */
  clear(): void {
    this.hideAll();
    for (const s of this.splashes) s.active = false;
    for (const stand of this.stands) stand.group.visible = false;
    for (const flag of this.flagPoles) flag.group.visible = false;
    this.setStream(null, 0, 0, 0);
    this.updateStream(0);
  }
}
