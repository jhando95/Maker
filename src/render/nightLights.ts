/**
 * The lights that come on when the afternoon runs out.
 *
 * `daylight.ts` has always computed `lampsLit` and nothing ever read it, so the
 * sky went to dusk over a neighbourhood where every lamp post was a grey stick
 * and every window was the same pale blue it had been at noon. That is the half
 * of an evening people actually notice: not that the sky got darker, but that
 * the windows got warmer than it.
 *
 * ## Where the lights are is not written down anywhere
 *
 * Deliberately. A list of lamp coordinates beside the code that builds the lamp
 * posts is two records of one fact, and the moment somebody nudges a post the
 * light stays where it was. So a light *is* a slab: anything the map draws can
 * carry a `lit` tag, and this reads the same array that gets drawn and turned
 * into collision. The glow is at the slab's position, at the slab's size, under
 * the slab's rotation, because it is derived from the slab rather than agreed
 * with it. `pavedFootprints` already works this way and for the same reason.
 *
 * ## One draw, and none at all when the lamps are off
 *
 * An instanced mesh's `count` is a number handed to the draw call, so a lamp
 * "hidden" by scaling its matrix to nothing is a lamp still being drawn — this
 * project has got that wrong twice. Off means `count = 0`, which is the whole
 * of what the afternoon costs: one culled mesh.
 *
 * ## Why an additive blob and not a light
 *
 * A real point light would have to be one of a handful the toon material can
 * take, would light the lawn through the fence, and would land on a three-band
 * ramp that has no idea what a falling-off light is — the bands would step
 * across the grass in rings. What actually reads as a lit lamp in a cartoon is
 * the lamp being *brighter than the picture*, which is an additive surface and
 * nothing else. It also means fog does not touch it: a light in haze blooms, it
 * does not fade, and that is the one thing in this scene that should get more
 * visible as the fog closes in.
 */

import * as THREE from 'three';
import type { Slab } from '../world/neighborhood.ts';

/** Default bloom, for a caller who only wants to say what colour it is. */
export const DEFAULT_BLOOM = 0.35;

/**
 * How sharply the halo falls off toward its rim.
 *
 * Below about 1.2 the blob is a flat disc with a hard edge; above about 2.5 it
 * is a pinprick with nothing around it. This is the middle, where the centre
 * reads as the bulb and the edge as the air around it.
 */
const FALLOFF = 1.7;

/**
 * Detail on the halo's sphere.
 *
 * One step up from where this started, because the facets *were* visible: the
 * nearest street lamp fills a good part of the screen and an eighty-triangle
 * ball reads as a polygon with a light in it rather than as a halo. Three
 * hundred and twenty triangles across thirty-odd lights is two per cent of what
 * the yard already draws, and it only draws at all after sunset.
 */
const SPHERE_DETAIL = 2;

/** A light pulled off the map's own slab list. */
interface Source {
  x: number; y: number; z: number;
  /** Full extents, slab plus bloom. */
  w: number; h: number; d: number;
  rx: number; ry: number; rz: number;
  color: number;
}

/**
 * Every light the map put down.
 *
 * Exported because the scenario harness needs to be able to count them, and
 * because "the map has some lights in it" is a claim worth being able to make
 * from a test rather than from a screenshot.
 */
export function litSources(slabs: readonly Slab[]): Source[] {
  const out: Source[] = [];
  for (const s of slabs) {
    if (s.lit === undefined) continue;
    const bloom = s.lit.bloom ?? DEFAULT_BLOOM;
    out.push({
      x: s.x, y: s.y, z: s.z,
      w: s.w + bloom * 2, h: s.h + bloom * 2, d: s.d + bloom * 2,
      rx: s.rx ?? 0, ry: s.ry ?? 0, rz: s.rz ?? 0,
      color: s.lit.color,
    });
  }
  return out;
}

function glowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      // How far up the lamps are. Zero is an afternoon and costs nothing,
      // because at zero nothing is drawn at all.
      strength: { value: 0 },
      falloff: { value: FALLOFF },
    },
    vertexShader: /* glsl */ `
      #include <common>
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      varying vec3 vTint;

      void main() {
        #ifdef USE_INSTANCING
          mat4 modelInstance = modelViewMatrix * instanceMatrix;
        #else
          mat4 modelInstance = modelViewMatrix;
        #endif

        vec4 mvPosition = modelInstance * vec4( position, 1.0 );
        // The halo is a squashed sphere — a window pane is a centimetre thick
        // and two metres wide — so the upper 3x3 is emphatically not a
        // rotation and the naive transform stretches the normals. It does not
        // matter: normalizing afterwards leaves them pointing outward, which is
        // all a falloff needs, and the inverse transpose would be three more
        // matrix ops per vertex to move a soft edge by nothing anyone can see.
        vViewNormal = normalize( mat3( modelInstance ) * normal );
        vViewPosition = mvPosition.xyz;

        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3( 1.0 );
        #endif

        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      uniform float strength;
      uniform float falloff;
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      varying vec3 vTint;

      void main() {
        // Brightest where the surface faces you and gone at the rim, which is
        // what makes a solid ball of geometry read as a ball of light.
        vec3 toEye = normalize( -vViewPosition );
        float facing = max( dot( normalize( vViewNormal ), toEye ), 0.0 );
        gl_FragColor = vec4( vTint * pow( facing, falloff ) * strength, 1.0 );
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    // Additive surfaces must not write depth or they occlude each other and
    // themselves, and the back half of the ball must not draw over the front.
    depthWrite: false,
    side: THREE.FrontSide,
    // See the header: a light in fog blooms, it does not fade.
    fog: false,
  });
}

/**
 * The map's lights, as one instanced draw that is off by default.
 */
export class NightLights {
  readonly mesh: THREE.InstancedMesh;

  private readonly material: THREE.ShaderMaterial;
  private readonly count: number;
  private lit = 0;

  constructor(slabs: readonly Slab[]) {
    const sources = litSources(slabs);
    this.count = sources.length;
    this.material = glowMaterial();

    const geometry = new THREE.IcosahedronGeometry(0.5, SPHERE_DETAIL);
    // Room for at least one, because three refuses a zero-length instanced
    // buffer and a map with no lights in it is not worth a separate code path.
    this.mesh = new THREE.InstancedMesh(geometry, this.material, Math.max(1, this.count));
    this.mesh.name = 'nightLights';
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Drawn after the world, so the halo lands on top of what it is lighting
    // rather than fighting it for the same depth.
    this.mesh.renderOrder = 2;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();

    for (let i = 0; i < this.count; i++) {
      const s = sources[i]!;
      position.set(s.x, s.y, s.z);
      euler.set(s.rx, s.ry, s.rz, 'YXZ');
      quaternion.setFromEuler(euler);
      scale.set(s.w, s.h, s.d);
      matrix.compose(position, quaternion, scale);
      this.mesh.setMatrixAt(i, matrix);
      this.mesh.setColorAt(i, color.setHex(s.color, THREE.SRGBColorSpace));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;

    // The lights do not move, so three can be told once to stop recomputing a
    // bound it will never need again.
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // Measured over every instance, not over the zero currently being drawn.
    // `computeBoundingSphere` walks `count` — so computing it while the lamps
    // are off yields a bound around nothing, three culls the mesh against it
    // every frame, and the lamps never appear no matter how high the level
    // goes. That is exactly what happened: the shader was right, the count was
    // right, and the picture did not change by a single pixel.
    this.mesh.count = Math.max(1, this.count);
    this.mesh.computeBoundingSphere();
    this.mesh.count = 0;
  }

  /** How many lights the map put down. */
  get lightCount(): number {
    return this.count;
  }

  /** How far up they are, 0 to 1. */
  get level(): number {
    return this.lit;
  }

  /** How many are actually being drawn, which is zero for the whole afternoon. */
  get drawn(): number {
    return this.mesh.count;
  }

  /**
   * Turn the lamps up.
   *
   * @returns true when the level changed, which is the caller's cue that the
   *   picture is not what it was.
   */
  setLevel(level: number): boolean {
    const want = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
    if (want === this.lit) return false;
    this.lit = want;
    this.material.uniforms.strength!.value = want;
    // Off means off. Parking the matrices would leave every one of them in the
    // draw call, doing the vertex work and blending zero over the picture.
    this.mesh.count = want > 0 ? this.count : 0;
    return true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
