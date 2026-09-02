/**
 * Shader tuning harness.
 *
 * Renders every material at every tone against a range of primitives, so the
 * hatch pitch / tier thresholds / material patterns can be judged without
 * dragging a 100-part assembly along for the ride.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildGeometry } from '../src/build/geometry.mjs';
import { buildDetails } from '../src/build/details.mjs';
import { edgesFor, setLineResolution, WEIGHTS } from '../src/build/edges.mjs';
import { makeHatchMaterial, makeSharedUniforms } from '../src/render/hatch-material.mjs';
import { PALETTE, MATERIAL_INDEX } from '../src/render/materials.mjs';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(new THREE.Color(PALETTE.paper), 1);
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
camera.position.set(16, 26, 46);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 2);
controls.enableDamping = true;

const shared = makeSharedUniforms({ dpr: Math.min(devicePixelRatio, 2), pitch: 4.0 });

const SHAPES = [
  { type: 'box', size: [4, 4, 4] },
  { type: 'cylinder', r: 2, h: 4.4, segments: 28 },
  { type: 'sphere', r: 2.2, segments: 28 },
  { type: 'lathe', points: [[0, -2], [1.9, -1.8], [2.2, 0], [1.3, 1.6], [0, 2.1]], segments: 28 },
];

const mats = Object.keys(MATERIAL_INDEX);
const COLS = 6;

mats.forEach((matName, i) => {
  const col = i % COLS, row = Math.floor(i / COLS);
  const shape = SHAPES[i % SHAPES.length];
  const geo = buildGeometry(shape);
  const part = { id: `m${i}`, material: matName, tone: 0.65 };
  const material = makeHatchMaterial(part, shared);
  const mesh = new THREE.Mesh(geo, material);
  const g = new THREE.Group();
  g.position.set((col - (COLS - 1) / 2) * 6.4, 2.4, (row - 0.5) * -7.5 - 6);
  g.add(mesh);
  const line = edgesFor(geo, 25, WEIGHTS.normal);
  if (line) g.add(line);
  scene.add(g);

  const label = document.createElement('div');
  label.className = 'lbl';
  label.textContent = matName;
  label.dataset.i = i;
  document.getElementById('labels').appendChild(label);
  g.userData.label = label;
});

// Tone ramp strip: one material, tone 0.3 -> 1.0, to check tier thresholds
const rampGroup = new THREE.Group();
rampGroup.position.set(0, 2.2, 8);
for (let i = 0; i < 8; i++) {
  const tone = 0.3 + (i / 7) * 0.7;
  const geo = buildGeometry({ type: 'box', size: [2.6, 4.2, 2.6] });
  const m = makeHatchMaterial({ id: `t${i}`, material: 'metal', tone }, shared);
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.x = (i - 3.5) * 3.1;
  rampGroup.add(mesh);
  const line = edgesFor(geo, 25, WEIGHTS.normal);
  if (line) { line.position.x = mesh.position.x; rampGroup.add(line); }
}
scene.add(rampGroup);

// A greebled plate, to check that details read at working distance
{
  const host = buildGeometry({ type: 'box', size: [14, 1.2, 7] });
  const { geometry: dg } = buildDetails(host, [
    { kind: 'boltCircle', face: 'top', r: 2.2, count: 12, boltR: 0.22, boltH: 0.2 },
    { kind: 'louvre', face: 'top', size: [4, 4], count: 6, cu: 4.2, depth: 0.5 },
    { kind: 'rivetRow', face: 'top', from: [-6, -3], to: [6, -3], count: 18, r: 0.16 },
    { kind: 'grille', face: 'top', size: [4, 4], rows: 4, cols: 6, cu: -4.4, bar: 0.18 },
  ], 0.25);
  const norm = (g) => {
    const n = g.index ? g.toNonIndexed() : g;
    const o = new THREE.BufferGeometry();
    o.setAttribute('position', n.attributes.position.clone());
    if (!n.attributes.normal) n.computeVertexNormals();
    o.setAttribute('normal', n.attributes.normal.clone());
    return o;
  };
  const merged = mergeGeometries([norm(host), norm(dg)], false);
  const m = makeHatchMaterial({ id: 'plate', material: 'metal', tone: 0.7 }, shared);
  const mesh = new THREE.Mesh(merged, m);
  const g = new THREE.Group();
  g.position.set(0, 0.6, 16);
  g.add(mesh);
  const line = edgesFor(merged, 25, WEIGHTS.normal);
  if (line) g.add(line);
  scene.add(g);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  setLineResolution(w, h);
  shared.uDpr.value = Math.min(devicePixelRatio, 2);
}
addEventListener('resize', resize);
resize();

const v = new THREE.Vector3();
function tick() {
  controls.update();
  renderer.render(scene, camera);
  // park the material labels under their objects
  for (const child of scene.children) {
    const label = child.userData?.label;
    if (!label) continue;
    v.setFromMatrixPosition(child.matrixWorld);
    v.y -= 3.2;
    v.project(camera);
    label.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
    label.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  }
  requestAnimationFrame(tick);
}
tick();

// live pitch tuning
addEventListener('keydown', (e) => {
  if (e.key === '[') shared.uPitch.value = Math.max(2, shared.uPitch.value - 0.5);
  if (e.key === ']') shared.uPitch.value = Math.min(16, shared.uPitch.value + 0.5);
  document.getElementById('hud').textContent = `pitch ${shared.uPitch.value.toFixed(1)} px  ·  dpr ${shared.uDpr.value}`;
});
document.getElementById('hud').textContent = `pitch ${shared.uPitch.value.toFixed(1)} px  ·  dpr ${shared.uDpr.value}`;
