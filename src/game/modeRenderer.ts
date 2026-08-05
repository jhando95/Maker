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
import { BUCKETS, BUCKET_RADIUS, type FortDefenseMode } from './fortDefense.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';

const MAX_BOTS = 24;
/** Simultaneous splash bursts. */
const MAX_SPLASHES = 16;
const SPLASH_LIFETIME = 0.5;

interface Splash {
  x: number; y: number; z: number;
  age: number;
  active: boolean;
}

export class ModeRenderer {
  readonly group = new THREE.Group();

  private readonly botBody: THREE.InstancedMesh;
  private readonly botHead: THREE.InstancedMesh;
  private readonly balloons: THREE.InstancedMesh;
  private readonly splashMesh: THREE.InstancedMesh;
  private readonly stash: THREE.Group;
  private readonly stashGlow: THREE.Mesh;
  private readonly buckets: THREE.Group;
  private readonly bucketMarkers: THREE.Mesh[] = [];

  private readonly splashes: Splash[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private readonly outlineMaterials: THREE.ShaderMaterial[] = [];

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

    // The stash: a crate with a glowing marker above it, so it is findable from
    // anywhere in the yard. The whole mode is about protecting this, so it must
    // never be ambiguous where it is.
    this.stash = new THREE.Group();
    const crateGeometry = chamferedBox(1.1, 0.8, 1.1, 0.02);
    const crate = new THREE.Mesh(crateGeometry, createToonMaterial({ color: 0xd8564f }));
    crate.castShadow = true;
    crate.receiveShadow = true;
    crate.position.y = 0.4;
    this.stash.add(crate);

    const crateOutline = new THREE.Mesh(crateGeometry, createOutlineMaterial(0x6a2320, 0.02));
    crateOutline.position.y = 0.4;
    this.stash.add(crateOutline);
    this.outlineMaterials.push(crateOutline.material as THREE.ShaderMaterial);

    const glowMaterial = createToonMaterial({ color: 0xffe98a });
    glowMaterial.transparent = true;
    glowMaterial.opacity = 0.85;
    this.stashGlow = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), glowMaterial);
    this.stashGlow.position.y = 1.6;
    this.stash.add(this.stashGlow);

    this.stash.visible = false;
    this.group.add(this.stash);

    // Ammo buckets, out past where a fort usually ends up. Each carries a marker
    // like the stash's, because the player has to be able to find them from
    // inside their own walls — a bucket you cannot see is a bucket you do not
    // plan a route to.
    this.buckets = new THREE.Group();
    const bucketGeometry = chamferedBox(0.7, 0.7, 0.7, 0.03);
    const ringGeometry = new THREE.TorusGeometry(BUCKET_RADIUS, 0.05, 6, 24).rotateX(Math.PI / 2);

    for (const b of BUCKETS) {
      const mesh = new THREE.Mesh(bucketGeometry, createToonMaterial({ color: 0x4f8fd8 }));
      mesh.position.set(b.x, 0.35, b.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.buckets.add(mesh);

      const outline = new THREE.Mesh(bucketGeometry, createOutlineMaterial(0x24506f, 0.018));
      outline.position.copy(mesh.position);
      this.buckets.add(outline);
      this.outlineMaterials.push(outline.material as THREE.ShaderMaterial);

      // A ring on the ground showing exactly where "close enough" is, so the
      // channel never fails for a reason the player cannot see.
      const ringMaterial = createToonMaterial({ color: 0x9fd8ee });
      ringMaterial.transparent = true;
      ringMaterial.opacity = 0.5;
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.position.set(b.x, 0.03, b.z);
      this.buckets.add(ring);

      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.2, 0),
        createToonMaterial({ color: 0x6ec6ff }),
      );
      marker.position.set(b.x, 1.3, b.z);
      marker.name = 'bucketMarker';
      this.buckets.add(marker);
      this.bucketMarkers.push(marker);
    }

    this.buckets.visible = false;
    this.group.add(this.buckets);

    this.hideAll();
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
  update(dt: number, mode: FortDefenseMode | null, projectiles: ProjectileSystem, time: number): void {
    this.updateBots(mode);
    this.updateBalloons(projectiles);
    this.updateSplashes(dt);

    if (mode === null) {
      this.stash.visible = false;
      this.buckets.visible = false;
      return;
    }

    this.buckets.visible = true;
    this.bucketMarkers.forEach((marker, i) => {
      marker.position.y = 1.3 + Math.sin(time * 2.6 + i * 1.7) * 0.1;
      marker.rotation.y = time * 1.4;
      // The one being used lifts and spins faster, so the channel is legible
      // from third person where the HUD bar is easy to miss.
      const active = mode.currentBucket === i;
      marker.scale.setScalar(active ? 1.25 + mode.refillFraction * 0.35 : 1);
    });

    this.stash.visible = true;
    this.stash.position.set(mode.stash.x, mode.stash.y, mode.stash.z);
    // A slow bob and spin, so the marker reads as a live objective rather than
    // another piece of scenery.
    this.stashGlow.position.y = 1.6 + Math.sin(time * 2.2) * 0.12;
    this.stashGlow.rotation.y = time * 1.1;
  }

  private updateBots(mode: FortDefenseMode | null): void {
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

  setOutlinesVisible(visible: boolean): void {
    for (const child of this.stash.children) {
      if (child instanceof THREE.Mesh && child.material === this.outlineMaterials[0]) {
        child.visible = visible;
      }
    }
  }

  setViewportHeight(height: number): void {
    for (const m of this.outlineMaterials) m.uniforms.viewportHeight!.value = height;
  }

  /** Hide everything, e.g. when returning to the menu. */
  clear(): void {
    this.hideAll();
    for (const s of this.splashes) s.active = false;
    this.stash.visible = false;
    this.buckets.visible = false;
  }
}
