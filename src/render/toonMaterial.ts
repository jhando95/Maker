/**
 * Cel shading.
 *
 * Built on MeshToonMaterial rather than a hand-rolled ShaderMaterial. Toon is
 * already wired into three's shadow, instancing, per-instance-color and fog
 * paths; a custom material would have to reimplement all four, and the build
 * system leans on every one of them.
 *
 * The only change is a patch to `getGradientIrradiance`, swapping three's
 * two-band ramp for a three-band one with a warm lit tone and a cool shadow.
 * Doing it in the shader rather than through a gradient-map texture avoids the
 * aliasing a NearestFilter ramp produces: band boundaries land *inside*
 * triangles, so MSAA cannot touch them, and they crawl as the light or camera
 * moves. `fwidth` gives the band edge a one-pixel ramp, which fixes it exactly.
 */

import * as THREE from 'three';

export interface ToonBands {
  /** Lit-to-mid boundary, in normalized dot(N,L) space. */
  band0: number;
  /** Mid-to-shadow boundary. */
  band1: number;
  lit: [number, number, number];
  mid: [number, number, number];
  shade: [number, number, number];
}

export const DEFAULT_BANDS: ToonBands = {
  band0: 0.52,
  band1: 0.7,
  // Shadows drift cool and slightly blue, lit stays neutral. That warm/cool
  // split is most of what separates a cartoon look from a flat one.
  lit: [1.0, 1.0, 1.0],
  mid: [0.72, 0.75, 0.82],
  shade: [0.46, 0.5, 0.66],
};

const v3 = (c: [number, number, number]) => `vec3(${c[0].toFixed(4)}, ${c[1].toFixed(4)}, ${c[2].toFixed(4)})`;

function bandedIrradiance(bands: ToonBands): string {
  return /* glsl */ `
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {

	float dotNL = dot( normal, lightDirection );
	float coord = dotNL * 0.5 + 0.5;

	// Screen-space derivative of the ramp coordinate: exactly one pixel of
	// blend at the band edge, whatever the surface angle or distance.
	float fw = fwidth( coord ) * 0.5;

	float t0 = smoothstep( ${bands.band0.toFixed(3)} - fw, ${bands.band0.toFixed(3)} + fw, coord );
	float t1 = smoothstep( ${bands.band1.toFixed(3)} - fw, ${bands.band1.toFixed(3)} + fw, coord );

	vec3 c = mix( ${v3(bands.shade)}, ${v3(bands.mid)}, t0 );
	c = mix( c, ${v3(bands.lit)}, t1 );
	return c;

}
`;
}

/**
 * The include this replaces.
 *
 * `onBeforeCompile` runs *before* three resolves `#include` directives, so the
 * shader text at this point still contains the directive rather than the
 * function body — matching on the function source silently never fires and
 * leaves stock two-band shading in place.
 */
const STOCK_INCLUDE = '#include <gradientmap_pars_fragment>';

let patchWarned = false;

/**
 * Apply the band patch to a toon material.
 *
 * Materials that share a patch also share a compiled program, so this is called
 * once per material rather than once per part.
 */
export function patchToon(material: THREE.MeshToonMaterial, bands: ToonBands = DEFAULT_BANDS): THREE.MeshToonMaterial {
  material.onBeforeCompile = (shader) => {
    if (!shader.fragmentShader.includes(STOCK_INCLUDE)) {
      if (!patchWarned) {
        patchWarned = true;
        console.warn(
          `[toon] '${STOCK_INCLUDE}' not found in the toon shader — three.js may have ` +
            'renamed the chunk. Falling back to stock two-band shading.',
        );
      }
      return;
    }
    // Swap the whole include for our own definition. Substituting the include
    // rather than editing resolved source means we never depend on the exact
    // body of the stock function, only on the chunk's name.
    shader.fragmentShader = shader.fragmentShader.replace(
      STOCK_INCLUDE,
      bandedIrradiance(bands),
    );
  };
  // Two materials with different patches must not share a cached program.
  material.customProgramCacheKey = () =>
    `toon-${bands.band0}-${bands.band1}-${bands.lit.join()}-${bands.mid.join()}-${bands.shade.join()}`;
  return material;
}

export interface ToonMaterialOptions {
  color?: THREE.ColorRepresentation;
  bands?: ToonBands;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  /** Enables the per-instance color attribute path. */
  vertexColors?: boolean;
}

export function createToonMaterial(options: ToonMaterialOptions = {}): THREE.MeshToonMaterial {
  // Faceting comes from the geometry, not the material: chamferedBox and the
  // icosahedron blobs split vertices per facet, so computeVertexNormals already
  // yields per-face normals. Nothing here needs material.flatShading.
  const material = new THREE.MeshToonMaterial({
    color: options.color ?? 0xffffff,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide,
    vertexColors: options.vertexColors ?? false,
  });
  return patchToon(material, options.bands ?? DEFAULT_BANDS);
}

/**
 * Material for inverted-hull outline shells.
 *
 * Front faces are culled so only the back of the expanded shell survives, which
 * leaves a rim around the silhouette. Unlit, because an outline that responds to
 * lighting stops reading as ink.
 *
 * The expansion happens in view space along a smoothed normal supplied as
 * `outlineNormal`, not the shading normal: a chamfered box has split vertices at
 * every edge, and expanding along per-face normals tears the shell open at the
 * corners.
 */
export function createOutlineMaterial(color: number, worldThickness: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      outlineColor: { value: new THREE.Color(color) },
      thickness: { value: worldThickness },
      // Keeps a distant outline from thinning to nothing and a close one from
      // ballooning over the object it is meant to trace.
      minPixels: { value: 0.8 },
      maxPixels: { value: 3.0 },
      viewportHeight: { value: 1080 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      attribute vec3 outlineNormal;
      uniform float thickness;
      uniform float minPixels;
      uniform float maxPixels;
      uniform float viewportHeight;

      #ifdef USE_INSTANCING
        // three injects instanceMatrix for instanced draws.
      #endif

      void main() {
        vec3 transformed = position;
        vec3 objectNormal = outlineNormal;

        #ifdef USE_INSTANCING
          mat4 modelInstance = modelViewMatrix * instanceMatrix;
        #else
          mat4 modelInstance = modelViewMatrix;
        #endif

        vec4 mvPosition = modelInstance * vec4( transformed, 1.0 );
        // Normal into view space. Non-uniform scale is never applied to parts,
        // so the upper 3x3 is a rotation and needs no inverse transpose.
        vec3 viewNormal = normalize( mat3( modelInstance ) * objectNormal );

        // Perspective divide makes a fixed world thickness shrink with distance;
        // clamp it in pixels so it stays legible at both extremes.
        float pixelsPerWorldUnit = viewportHeight * projectionMatrix[1][1] / max( -mvPosition.z, 0.001 ) * 0.5;
        float px = thickness * pixelsPerWorldUnit;
        float clamped = clamp( px, minPixels, maxPixels );
        float scale = thickness * ( clamped / max( px, 0.0001 ) );

        mvPosition.xyz += viewNormal * scale;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      uniform vec3 outlineColor;
      void main() {
        gl_FragColor = vec4( outlineColor, 1.0 );
        // Without this the ink renders darker than intended and drifts away
        // from the outline colors the palette actually specifies.
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    // Nudges the shell behind the surface it traces, so a flush face does not
    // z-fight with its own outline.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}
