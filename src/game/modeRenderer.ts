/**
 * Draws whatever the running mode has in the world: bots, balloons, the stash.
 *
 * Presentation only — it reads mode state and never writes it. Bots and balloons
 * are pooled InstancedMeshes sized to their hard caps, so a wave arriving costs
 * no allocation and no shader compile mid-round.
 */

import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial } from '../render/toonMaterial.ts';
import { chamferedBox } from '../render/geometry.ts';
import { MAX_BALLOONS, BALLOON_RADIUS } from './projectiles.ts';
import type { ProjectileSystem } from './projectiles.ts';
import type { GameMode, Marker } from './gameMode.ts';
import { CharacterBatch, lookFor, type CharacterPose } from '../render/character.ts';
import { shirtColor } from './shirts.ts';
import type { Actor } from './actor.ts';

/** Simultaneous splash bursts. */
const MAX_SPLASHES = 16;
const SPLASH_LIFETIME = 0.5;

/**
 * Droplets thrown off by impacts, shared across every splash on screen.
 *
 * Sixteen splashes at seven droplets each would be 112, and the pool is
 * deliberately smaller: a burst that big only happens when a dozen balloons
 * land in the same half-second, and at that point nobody can tell which
 * droplets belong to which splash. The pool recycles oldest-first, so what gets
 * dropped is the tail of a splash already half over.
 */
const MAX_DROPLETS = 96;
const DROPLETS_PER_SPLASH = 7;
/**
 * Droplet gravity, lighter than the player's 23.
 *
 * Not a physical claim — nothing collides with these. Real gravity at this
 * scale pulls the arc down inside three frames, which reads as the droplets
 * being sucked into the floor. A little over half of it lets the spray hang
 * long enough to be seen, which is the entire job.
 */
const DROPLET_GRAVITY = 14;
const DROPLET_LIFETIME = 0.55;
const DROPLET_RADIUS = 0.06;

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

/** One thrown-off bead of water. Ballistic, and it collides with nothing. */
interface Droplet {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
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

  /**
   * Everyone in the world, drawn by one shared rig.
   *
   * Passed in rather than owned, because the local player is drawn from it too
   * and main.ts is what knows whether the camera is currently showing them.
   */
  private readonly characters: CharacterBatch;
  private readonly balloons: THREE.InstancedMesh;
  private readonly splashMesh: THREE.InstancedMesh;
  private readonly stands: Stand[] = [];
  private readonly flagPoles: FlagPole[] = [];
  private readonly drops: THREE.InstancedMesh;
  private streamFrom: { x: number; y: number; z: number } | null = null;
  private streamEnd: { x: number; y: number; z: number } | null = null;

  private readonly splashes: Splash[] = [];
  private readonly dropletMesh: THREE.InstancedMesh;
  private readonly droplets: Droplet[] = [];
  /** Next slot to try, so spawning does not scan the pool from zero every time. */
  private dropletCursor = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  /** Reused scratch for a shirt colour, so drawing a wave allocates nothing. */
  private readonly shirt = new THREE.Color();
  private readonly scratchPose: CharacterPose = {
    id: 0, x: 0, y: 0, z: 0, facing: 0, speed: 0, onGround: true, shirt: this.shirt,
  };
  private readonly outlineMaterials: THREE.ShaderMaterial[] = [];
  private readonly outlineMeshes: THREE.Mesh[] = [];

  /** Kept off-screen rather than resized, so instance counts never churn. */
  private static readonly HIDDEN = new THREE.Matrix4().makeTranslation(0, -9999, 0);
  private static readonly NO_ROTATION = new THREE.Quaternion();

  constructor(characters: CharacterBatch) {
    this.group.name = 'mode';
    this.characters = characters;

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

    // The spray. A single expanding sphere is a puff of smoke wearing blue —
    // it says "something happened here" and nothing about what. What makes an
    // impact read as *water* is that pieces of it come off and fall, so the
    // burst keeps its job of marking the spot and these do the describing.
    //
    // Opaque and unlit-bright rather than translucent like the burst: at this
    // size a transparent droplet against a bright lawn is nothing at all, and
    // sixteen splashes' worth of transparency is sixteen sorted draws.
    this.dropletMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(DROPLET_RADIUS, 5, 4),
      createToonMaterial({ color: 0xcdf2ff }),
      MAX_DROPLETS,
    );
    this.dropletMesh.frustumCulled = false;
    this.dropletMesh.castShadow = false;
    this.group.add(this.dropletMesh);

    for (let i = 0; i < MAX_DROPLETS; i++) {
      this.droplets.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, active: false });
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
    for (let i = 0; i < MAX_BALLOONS; i++) this.balloons.setMatrixAt(i, ModeRenderer.HIDDEN);
    // The two packed pools have nothing to hide: drawing none of them is what
    // a count of zero already means.
    this.splashMesh.count = 0;
    this.dropletMesh.count = 0;
    this.balloons.instanceMatrix.needsUpdate = true;
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

    this.spawnDroplets(x, y, z);
  }

  /**
   * Throw a handful of beads off an impact.
   *
   * `Math.random` on purpose, like the rest of this file's presentation: the
   * renderer is never replayed and never hashed, and spending the simulation's
   * seeded stream on spray would make two players' worlds diverge on nothing —
   * exactly the mistake `SPLASH_INTERVAL` was written to avoid.
   *
   * Sprayed up and out rather than in a sphere. A splash on the lawn throws
   * nothing downwards, and one on somebody's back throws nothing into them, so
   * a symmetric burst spends half its droplets inside whatever was hit.
   */
  private spawnDroplets(x: number, y: number, z: number): void {
    for (let n = 0; n < DROPLETS_PER_SPLASH; n++) {
      const d = this.takeDroplet();
      const angle = Math.random() * Math.PI * 2;
      // Sideways speed spread wide, so the spray is a crown and not a ring.
      const out = 1.1 + Math.random() * 2.2;
      d.x = x; d.y = y; d.z = z;
      d.vx = Math.cos(angle) * out;
      d.vz = Math.sin(angle) * out;
      d.vy = 2.4 + Math.random() * 2.3;
      d.age = 0;
      d.active = true;
    }
  }

  /** A free droplet, or the oldest one if there are none. */
  private takeDroplet(): Droplet {
    for (let n = 0; n < MAX_DROPLETS; n++) {
      const i = (this.dropletCursor + n) % MAX_DROPLETS;
      if (!this.droplets[i]!.active) {
        this.dropletCursor = (i + 1) % MAX_DROPLETS;
        return this.droplets[i]!;
      }
    }
    // Full. The cursor is the least recently taken slot, which is the closest
    // thing to "oldest" available without sorting.
    const i = this.dropletCursor;
    this.dropletCursor = (i + 1) % MAX_DROPLETS;
    return this.droplets[i]!;
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
    /**
     * Anything to draw beside the mode's own objectives — pings, today.
     *
     * Passed in rather than read from anywhere, for the same reason `others` is:
     * a ping is not the mode's business. You can ping in Free Build, where
     * there is no mode at all to publish one, and a mark on the world that only
     * appeared during a round would be a strange thing to explain.
     */
    extraMarkers?: readonly Marker[],
  ): void {
    this.updateCharacters(dt, others ?? mode?.bots ?? [], mode);
    this.updateBalloons(projectiles);
    this.updateSplashes(dt);
    this.updateDroplets(dt);
    this.updateMarkers(mode, time, extraMarkers);
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
  private updateMarkers(
    mode: GameMode | null, time: number, extra: readonly Marker[] = [],
  ): void {
    const own = mode?.markers() ?? [];
    const markers = extra.length === 0 ? own : [...own, ...extra];
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
   * How many objective markers are actually on screen.
   *
   * For scenarios, and it is a different question from how many the mode
   * published: the pools here are fixed-size, so a mode with more objectives
   * than there are stands loses the surplus silently. Tag is the first mode
   * whose marker count is a function of how many people are playing, which is
   * the first time that ceiling could be reached by accident.
   */
  get markersDrawn(): number {
    let n = 0;
    for (const stand of this.stands) if (stand.group.visible) n++;
    for (const flag of this.flagPoles) if (flag.group.visible) n++;
    return n;
  }

  /**
   * Live splash bursts and droplets, for scenarios.
   *
   * Both, because they fail differently and one covers for the other. A burst
   * with no spray is the old effect back; spray with no burst is a splash that
   * spawned into a pool it could not reach. Neither number alone would notice.
   */
  get splashesLive(): number {
    let n = 0;
    for (const s of this.splashes) if (s.active) n++;
    return n;
  }

  get dropletsLive(): number {
    let n = 0;
    for (const d of this.droplets) if (d.active) n++;
    return n;
  }

  /**
   * Draw everyone who is not holding the camera.
   *
   * Was `updateBots`, and the rename is the point: a bot and another person are
   * the same silhouette moving through the same world, and the only thing this
   * code ever needed from either was a position, a facing, and how wet they are.
   *
   * The posing itself belongs to the character rig, so what is left here is only
   * the translation from "what a mode knows about somebody" to "what it takes to
   * draw a kid". Everything the two must agree about — proportions, the walk
   * cycle, what a soaked shirt looks like — is now stated in exactly one place,
   * which is what lets the local player be drawn by the same code.
   */
  private updateCharacters(dt: number, others: readonly Actor[], mode: GameMode | null): void {
    const pose = this.scratchPose;
    for (const who of others) {
      if (who.alive === false) continue;

      const body = who.controller;
      pose.id = who.id;
      pose.x = body.x;
      pose.y = body.y;
      pose.z = body.z;
      pose.facing = who.heading ?? 0;
      pose.speed = Math.hypot(body.vx ?? 0, body.vz ?? 0);
      pose.onGround = body.onGround !== false;
      pose.stunned = who.stunned === true;
      // Your shirt is yours until a round starts, and then it is your team's.
      //
      // The two team palettes are what make a fight legible — `shirts.ts` says
      // it outright, and the moment allies existed one palette meant every kid
      // on the lawn looked identical and the flag game became guesswork. A
      // locker cannot be allowed to take that away, because the cost is paid by
      // everybody else in the round rather than by the person who chose it.
      //
      // So the choice shows where there is nothing to confuse it with: free
      // build, and the yard you are standing in while you pick it. Everything
      // else somebody chose — face, hair, trousers, shoes, shaping, the marks —
      // travels into the round untouched.
      const own = mode === null ? lookFor(who.id).shirt : null;
      shirtColor(
        this.shirt, who.team, mode?.wetnessOf?.(who.id) ?? 0, pose.stunned, own,
      );

      // A full batch is a real answer rather than an error: a mode may spawn
      // more than the pool holds, and drawing as many as fit beats growing a
      // buffer mid-round.
      if (!this.characters.pose(dt, pose)) break;
    }
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

  /**
   * Both of these pools are *packed* rather than parked.
   *
   * The pool slot a splash lives in and the instance slot it draws in used to
   * be the same number, with the unused ones pushed to y = -9999. That works,
   * but it means the draw is always for the full pool — and since nothing is
   * splashing during the great majority of a round, the common case was two
   * draw calls a frame for a hundred and twelve invisible spheres. Writing the
   * live ones into the front of the buffer and setting `count` costs one extra
   * local and lets three.js skip the draw entirely at zero, which is the same
   * fix the character batch got and for the same reason.
   */
  private updateSplashes(dt: number): void {
    let drawn = 0;
    for (let i = 0; i < this.splashes.length; i++) {
      const s = this.splashes[i]!;
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= SPLASH_LIFETIME) {
        s.active = false;
        continue;
      }
      // Out fast, then back in. It used to expand and hold, which meant it
      // vanished at full size — a sphere blinking out of existence at its
      // largest is the one shape that cannot read as anything dissipating.
      // The material's opacity is shared across every instance and so cannot
      // fade one of them, which makes the silhouette the only thing left to
      // say "gone", so it has to say it.
      const t = s.age / SPLASH_LIFETIME;
      const shape = t < 0.32 ? Math.sqrt(t / 0.32) : 1 - (t - 0.32) / 0.68;
      const radius = 0.18 + shape * 1.05;
      this.pos.set(s.x, s.y, s.z);
      this.scale.setScalar(radius);
      this.matrix.compose(this.pos, ModeRenderer.NO_ROTATION, this.scale);
      this.splashMesh.setMatrixAt(drawn++, this.matrix);
      this.scale.setScalar(1);
    }
    this.splashMesh.count = drawn;
    this.splashMesh.instanceMatrix.needsUpdate = true;
  }

  private updateDroplets(dt: number): void {
    let drawn = 0;
    for (let i = 0; i < this.droplets.length; i++) {
      const d = this.droplets[i]!;
      if (!d.active) continue;
      d.age += dt;
      if (d.age >= DROPLET_LIFETIME) {
        d.active = false;
        continue;
      }
      d.vy -= DROPLET_GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;

      // Shrink over the back half only. Shrinking from the moment it spawns
      // makes the spray look like it is being pulled back into the impact.
      const t = d.age / DROPLET_LIFETIME;
      const size = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
      this.pos.set(d.x, d.y, d.z);
      this.scale.setScalar(Math.max(size, 0.001));
      this.matrix.compose(this.pos, ModeRenderer.NO_ROTATION, this.scale);
      this.dropletMesh.setMatrixAt(drawn++, this.matrix);
      this.scale.setScalar(1);
    }
    this.dropletMesh.count = drawn;
    this.dropletMesh.instanceMatrix.needsUpdate = true;
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
    for (const d of this.droplets) d.active = false;
    for (const stand of this.stands) stand.group.visible = false;
    for (const flag of this.flagPoles) flag.group.visible = false;
    this.setStream(null, 0, 0, 0);
    this.updateStream(0);
  }
}
