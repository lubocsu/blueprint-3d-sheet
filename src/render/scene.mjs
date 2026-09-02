/**
 * The drawing "stage": paper, ground grid, datum axes, cast shadow, and the
 * perspective/orthographic camera pair.
 *
 * Grid pitch and camera distance are derived from the scene scale rather than
 * hard-coded, so a wristwatch and a warehouse both arrive framed the same way.
 */

import * as THREE from 'three';
import { PALETTE } from './materials.mjs';

/* --------------------------------------------------------------- ground grid */

const gridVert = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const gridFrag = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  uniform vec3  uMinor;
  uniform vec3  uMajor;
  uniform vec3  uAxis;
  uniform float uPitch;
  uniform float uFade;

  float gridMask(vec2 p, float pitch, float w) {
    vec2 c = p / pitch;
    vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
    return 1.0 - min(min(g.x, g.y) / w, 1.0);
  }

  void main() {
    vec2 p = vWorld.xz;
    float minor = gridMask(p, uPitch, 1.0);
    float major = gridMask(p, uPitch * 5.0, 1.3);

    // datum axes
    vec2 a = abs(p) / fwidth(p);
    float axis = 1.0 - min(min(a.x, a.y) / 1.6, 1.0);

    float d = length(p);
    float fade = 1.0 - smoothstep(uFade * 0.35, uFade, d);
    float alpha = max(max(minor * 0.55, major * 0.9), axis) * fade;
    if (alpha < 0.004) discard;

    vec3 col = mix(uMinor, uMajor, major);
    col = mix(col, uAxis, axis * 0.85);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

function makeGrid(extent, pitch) {
  const geo = new THREE.PlaneGeometry(extent * 2.4, extent * 2.4);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: gridVert,
    fragmentShader: gridFrag,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uMinor: { value: new THREE.Color(PALETTE.grid) },
      uMajor: { value: new THREE.Color(PALETTE.gridMajor) },
      uAxis:  { value: new THREE.Color(PALETTE.axis) },
      uPitch: { value: pitch },
      uFade:  { value: extent * 1.15 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.002;
  mesh.renderOrder = -10;
  mesh.raycast = () => {};
  return mesh;
}

/* -------------------------------------------------------------- cast shadow */

const shadowFrag = /* glsl */`
  precision highp float;
  uniform vec3  uInk;
  uniform float uDpr;
  uniform float uPitch;
  void main() {
    vec2 p = gl_FragCoord.xy / max(uDpr, 0.5);
    float d = p.x * 0.7071 + p.y * 0.7071;
    float m = mod(d, uPitch * 1.5);
    float dist = min(m, uPitch * 1.5 - m);
    float cov = 1.0 - smoothstep(0.25, 1.15, dist);
    if (cov < 0.02) discard;
    gl_FragColor = vec4(uInk, cov * 0.42);
    #include <colorspace_fragment>
  }
`;

/** Andrew monotone chain. */
function convexHull2(points) {
  const pts = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** True while every ancestor up to (and including) `stop` is visible. */
function chainVisible(o, stop) {
  let n = o;
  while (n) {
    if (!n.visible) return false;
    if (n === stop) return true;
    n = n.parent;
  }
  return true;
}

/**
 * Real planar-projected shadow.
 *
 * Each mesh is drawn a second time through a matrix that collapses it onto
 * Y=0 along the light direction. Because the projection consumes the mesh's own
 * `matrixWorld`, the shadow follows everything the model does for free — the
 * hull rocks, the turret slews, the tracks march, parts fly apart on EXPLODE —
 * and it reproduces concave outlines that a bounding-box hull cannot.
 */
function makeProjectedShadow(root, lightDir, shared) {
  const L = lightDir;
  if (Math.abs(L.y) < 1e-4) return null;

  // p' = p - L * (p.y / L.y)
  const P = new THREE.Matrix4().set(
    1, -L.x / L.y, 0, 0,
    0, 0, 0, 0,
    0, -L.z / L.y, 1, 0,
    0, 0, 0, 1,
  );

  const group = new THREE.Group();
  group.name = 'shadow';
  group.matrixAutoUpdate = false;
  group.matrix.copy(P);
  group.renderOrder = -5;

  const mat = new THREE.ShaderMaterial({
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: shadowFrag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    uniforms: {
      uInk: { value: new THREE.Color(PALETTE.ink) },
      uDpr: shared.uDpr,
      uPitch: shared.uPitch,
    },
  });

  const pairs = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.userData?.partId) return;
    const sm = new THREE.Mesh(o.geometry, mat);
    sm.matrixAutoUpdate = false;
    sm.frustumCulled = false;
    sm.raycast = () => {};
    group.add(sm);
    pairs.push([o, sm]);
  });

  return {
    group,
    /** Call after the scene graph's world matrices are up to date. */
    update() {
      for (const [src, sm] of pairs) {
        const vis = chainVisible(src, root);
        sm.visible = vis;
        if (vis) sm.matrix.copy(src.matrixWorld);
      }
    },
  };
}

/**
 * Footprint shadow: every part's world bounding box, projected along the light
 * onto Y=0, hulled, and filled with single-direction hatch. Cheap fallback for
 * very large assemblies, where one extra draw per mesh starts to bite.
 */
function makeShadow(root, lightDir, shared) {
  const pts = [];
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    box.setFromObject(o);
    if (!isFinite(box.min.x)) return;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          v.set(x, y, z);
          // slide down the light ray to the ground plane
          const t = lightDir.y !== 0 ? v.y / lightDir.y : 0;
          pts.push([v.x - lightDir.x * t, v.z - lightDir.z * t]);
        }
      }
    }
  });
  if (pts.length < 3) return null;

  const hull = convexHull2(pts);
  if (hull.length < 3) return null;

  const shape = new THREE.Shape();
  hull.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z)));
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(Math.PI / 2);
  geo.scale(1, 1, -1);

  const mat = new THREE.ShaderMaterial({
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: shadowFrag,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uInk:   { value: new THREE.Color(PALETTE.ink) },
      uDpr:   shared.uDpr,
      uPitch: shared.uPitch,
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.001;
  mesh.renderOrder = -5;
  mesh.raycast = () => {};
  return mesh;
}

/* ------------------------------------------------------------------- section */

const SECTION_NORMAL = {
  xy: new THREE.Vector3(0, 0, 1),
  yz: new THREE.Vector3(1, 0, 0),
  zx: new THREE.Vector3(0, 1, 0),
};

/* --------------------------------------------------------------------- stage */

export function createStage(canvas, spec, shared) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new THREE.Color(PALETTE.paper), 1);
  renderer.localClippingEnabled = true;
  renderer.sortObjects = true;

  const scene = new THREE.Scene();

  // The assembly is normalised to a 10-unit diagonal by the builder.
  const SCENE_DIAG = 10;
  const extent = SCENE_DIAG * 1.9;
  const gridPitch = SCENE_DIAG / 20;

  const grid = makeGrid(extent, gridPitch);
  scene.add(grid);

  // One camera only — `views.mjs` reaches orthographic by tweening the FOV down
  // rather than swapping in an OrthographicCamera, which would pop.
  const camera = new THREE.PerspectiveCamera(30, 1, SCENE_DIAG * 0.01, SCENE_DIAG * 60);

  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  let sectionActive = false;

  return {
    renderer, scene, grid, camera,
    extent, sceneDiag: SCENE_DIAG, gridPitch,
    clipPlane,

    /**
     * @param {THREE.Object3D} root
     * @param {"projected"|"hull"|"none"} mode
     */
    addShadow(root, mode = 'projected') {
      if (mode === 'none') { this.shadow = null; this.shadowUpdate = () => {}; return null; }

      if (mode === 'projected') {
        const s = makeProjectedShadow(root, shared.uLightDir.value, shared);
        if (s) {
          scene.add(s.group);
          this.shadow = s.group;
          this.shadowUpdate = () => s.update();
          return s.group;
        }
      }

      const hull = makeShadow(root, shared.uLightDir.value, shared);
      if (hull) scene.add(hull);
      this.shadow = hull;
      this.shadowUpdate = () => {};
      return hull;
    },

    /**
     * Enable/disable the section cut. Materials must have been created with
     * `clipping: true`, which hatch-material does.
     */
    setSection(section, materials) {
      if (!section) {
        if (sectionActive) {
          for (const m of materials) { m.clippingPlanes = null; m.needsUpdate = true; }
          sectionActive = false;
        }
        shared.uClipped.value = 0;
        return;
      }
      shared.uClipped.value = 1;
      const n = SECTION_NORMAL[section.plane].clone();
      if (section.flip) n.negate();
      // spec units -> scene units
      const at = (section.at ?? 0) * (spec._derived?.sceneScale ?? 1);
      clipPlane.set(n, -at * (section.flip ? -1 : 1));
      for (const m of materials) { m.clippingPlanes = [clipPlane]; m.needsUpdate = true; }
      sectionActive = true;
    },

    resize(w, h) {
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      shared.uDpr.value = Math.min(window.devicePixelRatio || 1, 2);
    },
  };
}

export { convexHull2, SECTION_NORMAL };
