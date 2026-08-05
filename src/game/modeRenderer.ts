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

const MAX_BOTS = 24;
/** Simultaneous splash bursts. */
const MAX_SPLASHES = 16;
const SPLASH_LIFETIME = 0.5;

/** Objective stands and flags a mode can ask for at once. */
const MAX_MARKERS = 8;
const MAX_FLAGS = 4;

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
  update(dt: number, mode: GameMode | null, projectiles: ProjectileSystem, time: number): void {
    this.updateBots(mode);
    this.updateBalloons(projectiles);
    this.updateSplashes(dt);
    this.updateMarkers(mode, time);
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

  private updateBots(mode: GameMode | null): void {
    let count = 0;
    if (mode !== null) {
      for (const bot of mode.bots) {
        if (!bot.alive || count >= MAX_BOTS) continue;

        this.pos.set(bot.x, bot.y + CAP_HEIGHT / 2, bot.z);
        this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), bot.heading);
        this.matrix.compose(this.pos, this.quat, this.scale);
        this.botBody.setMatrixAt(count, this.matrix);

        // Stunned bots wash out toward blue, so it is obvious at a glance which
        // are still a threat.
        const stunned = bot.state === 'stunned';
        this.color.setHex(stunned ? 0x7fb8d8 : 0xe07a4f, THREE.SRGBColorSpace);
        this.botBody.setColorAt(count, this.color);

        this.pos.set(bot.x, bot.y + CAP_HEIGHT - 0.05, bot.z);
        this.matrix.compose(this.pos, this.quat, this.scale);
        this.botHead.setMatrixAt(count, this.matrix);

        count++;
      }
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
  }
}
