/**
 * Screen-space hatching.
 *
 * The reference film's giveaway: hatch pitch is identical on the gun barrel,
 * the hull flank and the far track — it does not follow UVs, surface curvature
 * or depth. That means the pattern is evaluated in screen space and selected by
 * tone, exactly like a draughtsman choosing a hatch density per face.
 *
 * So: shade -> quantise to 4 density tiers -> evaluate the material's pattern at
 * gl_FragCoord / devicePixelRatio. Dividing by DPR is load-bearing; without it
 * the hatch doubles in density on a retina display and the whole thing turns to
 * mud.
 */

import * as THREE from 'three';
import { PALETTE, MATERIAL_INDEX, MATERIAL_TONE_BIAS, hexToRgb } from './materials.mjs';

const vertexShader = /* glsl */`
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  #include <clipping_planes_pars_vertex>

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);

    vec4 mvPosition = viewMatrix * worldPos;
    #include <clipping_planes_vertex>
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;

  varying vec3 vNormalW;
  varying vec3 vViewDir;

  uniform vec3  uInk;
  uniform vec3  uPaper;
  uniform vec3  uAccent;
  uniform vec3  uLightDir;
  uniform float uTone;        // per-part darkness multiplier
  uniform float uBias;        // per-material tone bias
  uniform int   uMaterial;
  uniform float uHighlight;   // 0..1 hover
  uniform float uDpr;
  uniform float uPitch;       // base hatch pitch in CSS px
  uniform float uGhost;       // 0..1 fade for exploded / cut-away pieces
  uniform float uClipped;     // 1 while a section plane is active
  uniform float uUniformHatch;// 1 = one crosshatch for every material on solid faces

  #include <clipping_planes_pars_fragment>

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Distance-to-nearest-line mask for a family of parallel lines.
  float lines(vec2 p, float ang, float pitch, float w) {
    float d = p.x * cos(ang) + p.y * sin(ang);
    float m = mod(d, pitch);
    float dist = min(m, pitch - m);
    return 1.0 - smoothstep(w * 0.5 - 0.6, w * 0.5 + 0.6, dist);
  }

  // Same, but broken into dashes along the line direction.
  float dashedLines(vec2 p, float ang, float pitch, float w, float dash, float duty) {
    float base = lines(p, ang, pitch, w);
    float along = -p.x * sin(ang) + p.y * cos(ang);
    float g = step(mod(along, dash), dash * duty);
    return base * g;
  }

  float stipple(vec2 p, float pitch, float r) {
    vec2 cell = floor(p / pitch);
    vec2 f = fract(p / pitch);
    vec2 j = vec2(hash12(cell), hash12(cell + 17.3)) * 0.6 + 0.2;
    float d = length((f - j) * pitch);
    return 1.0 - smoothstep(r - 0.6, r + 0.6, d);
  }

  float zigzag(vec2 p, float pitch, float w) {
    float x = mod(p.x, pitch) / pitch;
    float tri = abs(x - 0.5) * 2.0;
    float d = p.y + tri * pitch * 0.6;
    float m = mod(d, pitch);
    return 1.0 - smoothstep(w * 0.5 - 0.6, w * 0.5 + 0.6, min(m, pitch - m));
  }

  float brick(vec2 p, float pitch, float w) {
    float row = floor(p.y / pitch);
    float off = mod(row, 2.0) * pitch;
    float h = lines(p, 1.5707963, pitch, w);                       // horizontal courses
    float vx = mod(p.x + off, pitch * 2.0);
    float v = 1.0 - smoothstep(w * 0.5 - 0.6, w * 0.5 + 0.6, min(vx, pitch * 2.0 - vx));
    return max(h, v);
  }

  /**
   * Pattern coverage for a material at a given density tier (0 = none, 3 = dense).
   */
  float pattern(vec2 p, int mat, int tier, float pitch) {
    if (tier <= 0) return 0.0;
    float t1 = float(tier);
    float w = 1.0;

    if (mat == 0) {                       // metal - 45 deg crosshatch
      float a = lines(p, 0.7853982, pitch, w);
      if (tier == 1) return a;
      float b = lines(p, -0.7853982, pitch, w);
      if (tier == 2) return max(a, b);
      return max(max(a, b), lines(p, 0.7853982, pitch * 0.5, w * 0.8));
    }
    if (mat == 1) {                       // casting - stipple
      float r = 0.7 + t1 * 0.25;
      return stipple(p, pitch * 0.85, r);
    }
    if (mat == 2) {                       // plastic - fine unidirectional
      float a = lines(p, 0.7853982, pitch * 0.62, 0.8);
      if (tier <= 2) return a;
      return max(a, lines(p, 0.7853982, pitch * 0.31, 0.7));
    }
    if (mat == 3) {                       // glass - sparse broken diagonal
      return dashedLines(p, 1.0472, pitch * 2.4, 0.9, pitch * 5.0, 0.45) * 0.85;
    }
    if (mat == 4) {                       // rubber - dense dark stipple
      float s = stipple(p, pitch * 0.5, 0.9 + t1 * 0.2);
      return max(s, stipple(p, pitch * 0.62, 0.8));
    }
    if (mat == 5) {                       // wood - warped grain
      vec2 q = vec2(p.x, p.y + sin(p.x * 0.035) * pitch * 1.6 + sin(p.x * 0.011) * pitch * 3.0);
      float a = lines(q, 1.5707963, pitch * 1.15, 0.9);
      if (tier <= 2) return a;
      return max(a, lines(q, 1.5707963, pitch * 0.57, 0.7));
    }
    if (mat == 6) {                       // concrete - dots plus aggregate
      float s = stipple(p, pitch * 1.2, 0.8);
      float a = stipple(p + 41.0, pitch * 2.1, 1.7);
      return max(s, a * 0.9);
    }
    if (mat == 7) return brick(p, pitch * 1.9, 0.9);          // masonry
    if (mat == 8) {                       // liquid - horizontal waves
      vec2 q = vec2(p.x, p.y + sin(p.x * 0.13) * 2.4);
      return lines(q, 1.5707963, pitch * 1.5, 0.9) * 0.8;
    }
    if (mat == 9) return zigzag(p, pitch * 1.6, 0.9);         // insulation
    if (mat == 10) {                      // fabric - orthogonal weave
      return max(lines(p, 0.0, pitch * 0.9, 0.7), lines(p, 1.5707963, pitch * 0.9, 0.7));
    }
    if (mat == 11) {                      // earth - dots and short dashes
      return max(stipple(p, pitch * 1.4, 0.8),
                 dashedLines(p, 0.0, pitch * 1.8, 0.8, pitch * 2.4, 0.4));
    }
    return lines(p, 0.7853982, pitch, w);
  }

  void main() {
    #include <clipping_planes_fragment>

    vec3 N = normalize(vNormalW);
    bool back = !gl_FrontFacing;
    if (back) N = -N;                         // DoubleSide: mirrored instances

    vec3 L = normalize(uLightDir);
    float lambert = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
    float rim = pow(1.0 - clamp(dot(N, normalize(vViewDir)), 0.0, 1.0), 2.5);

    // 0 = fully lit, 1 = deepest shade.
    // The 0.78 exponent lifts mid-tones: on the reference sheet almost every
    // face that isn't catching the key light carries at least single hatch,
    // and a linear ramp leaves far too much bare paper.
    float shade = pow(1.0 - lambert, 0.78);
    float darkness = clamp(shade * uTone * uBias * 1.45 - rim * 0.20, 0.0, 1.0);

    int tier = 0;
    if (darkness > 0.60)      tier = 3;
    else if (darkness > 0.36) tier = 2;
    else if (darkness > 0.17) tier = 1;

    // Where a section plane has opened the solid, the surfaces facing us are the
    // insides of the far wall. Drafting convention fills a cut face with dense
    // section lining, so force the top tier there rather than letting it read as
    // an unlit dark void.
    if (uClipped > 0.5 && back) {
      tier = 3;
      darkness = max(darkness, 0.72);
    }

    // The reference uses ONE 45° crosshatch for every substance on a solid
    // surface and varies only its density. Per-material patterns are reserved
    // for cut faces, which is the job drafting standards actually give them.
    bool cutFace = (uClipped > 0.5 && back);
    int matIdx = (uUniformHatch > 0.5 && !cutFace) ? 0 : uMaterial;

    vec2 sp = gl_FragCoord.xy / max(uDpr, 0.5);
    float cov = pattern(sp, matIdx, tier, uPitch);

    // A faint fill tint under the hatch so tiers aren't the only depth cue.
    vec3 base = mix(uPaper, mix(uPaper, uInk, 0.10), darkness);
    vec3 col = mix(base, uInk, cov * 0.92);

    col = mix(col, uAccent, uHighlight * 0.12);   // outline carries the highlight
    col = mix(uPaper, col, 1.0 - uGhost * 0.62);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/**
 * @param {object} part - a normalized spec part
 * @param {object} shared - uniforms shared across every part (light, dpr, pitch)
 * @returns {THREE.ShaderMaterial}
 */
export function makeHatchMaterial(part, shared) {
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,       // mirrored instances have inverted winding
    clipping: true,
    uniforms: {
      uInk:       { value: new THREE.Color(PALETTE.ink) },
      uPaper:     { value: new THREE.Color(PALETTE.surface) },
      uAccent:    { value: new THREE.Color(PALETTE.accent) },
      uLightDir:  shared.uLightDir,
      uDpr:       shared.uDpr,
      uPitch:     shared.uPitch,
      uTone:      { value: part.tone ?? 0.6 },
      uBias:      { value: MATERIAL_TONE_BIAS[part.material] ?? 1 },
      uMaterial:  { value: MATERIAL_INDEX[part.material] ?? 0 },
      uHighlight: { value: 0 },
      uGhost:     { value: 0 },
      uClipped:   shared.uClipped,
      uUniformHatch: shared.uUniformHatch,
    },
  });
  mat.userData.partId = part.id;
  return mat;
}

/** Uniforms every hatch material shares, so a resize or DPR change is one write. */
export function makeSharedUniforms({ dpr = 1, pitch = 4.0, uniformHatch = true } = {}) {
  return {
    uLightDir: { value: new THREE.Vector3(-0.45, 0.82, 0.36).normalize() },
    uDpr:      { value: dpr },
    uPitch:    { value: pitch },
    uClipped:  { value: 0 },
    uUniformHatch: { value: uniformHatch ? 1 : 0 },
  };
}

export { vertexShader, fragmentShader };
