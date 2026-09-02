/**
 * Spec -> scene graph.
 *
 * Node layout per part:
 *
 *   parent.nodes[0]
 *     └ holder[i]        instance offset, in the PARENT's frame
 *         └ pivot        base transform from spec.transform
 *             └ nodes[i] animation channels write HERE
 *                 ├ mesh shaded geometry (part + merged details)
 *                 └ lines ink creases
 *
 * The instance offset sits *above* the part's own transform on purpose. Author
 * `step: [-7100, 0, 0]` and you mean 7100 back along the assembly's X, not along
 * whatever axis the part's own rotation happens to point X at — putting the
 * offset below a 90° roll silently turns it into a move in Y.
 *
 * Children attach to `nodes[0]` rather than to the pivot, so a turret's spin
 * carries its gun, and a crank's rotation carries the rod hung off it.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildGeometry } from './geometry.mjs';
import { buildDetails } from './details.mjs';
import { edgesFor, linesFromSegments, WEIGHTS } from './edges.mjs';

const DEG = Math.PI / 180;

/** Every assembly is normalised to this diagonal, so a watch and a warehouse
 *  arrive at the camera the same size. Must match `scene.mjs`. */
const SCENE_DIAG = 10;

/** Local matrices for every instance of a part (index 0 is always identity). */
function instanceMatrices(inst) {
  if (!inst) return [new THREE.Matrix4()];
  const out = [];
  const { pattern, count = 1 } = inst;

  if (pattern === 'linear') {
    const step = inst.step ?? [0, 0, 0];
    for (let i = 0; i < count; i++) {
      out.push(new THREE.Matrix4().makeTranslation(step[0] * i, step[1] * i, step[2] * i));
    }
  } else if (pattern === 'radial') {
    const axis = inst.axis ?? 'y';
    const radius = inst.radius ?? 0;
    const arc = (inst.arc ?? 360) * DEG;
    const full = Math.abs((inst.arc ?? 360) - 360) < 1e-6;
    const div = full ? count : Math.max(count - 1, 1);
    const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis];
    for (let i = 0; i < count; i++) {
      const a = (arc / div) * i;
      const rot = new THREE.Matrix4().makeRotationAxis(AX, a);
      // radial offset lies in the plane perpendicular to the axis
      const radial = axis === 'y' ? new THREE.Vector3(radius, 0, 0)
                   : axis === 'x' ? new THREE.Vector3(0, radius, 0)
                                  : new THREE.Vector3(radius, 0, 0);
      const p = radial.clone().applyMatrix4(rot);
      const m = new THREE.Matrix4().setPosition(p);
      // `orient` turns each instance to face outward from the axis
      if (inst.orient) m.multiply(rot);
      out.push(m);
    }
  } else if (pattern === 'grid') {
    const counts = inst.counts ?? [count, 1];
    const steps = inst.steps ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const [nx, ny, nz = 1] = counts;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const p = new THREE.Vector3();
          p.addScaledVector(new THREE.Vector3(...steps[0]), i);
          if (steps[1]) p.addScaledVector(new THREE.Vector3(...steps[1]), j);
          if (steps[2]) p.addScaledVector(new THREE.Vector3(...steps[2]), k);
          out.push(new THREE.Matrix4().setPosition(p));
        }
      }
    }
  } else {
    out.push(new THREE.Matrix4());
  }

  if (inst.mirror && inst.mirror !== 'none') {
    const s = { x: [-1, 1, 1], y: [1, -1, 1], z: [1, 1, -1] }[inst.mirror];
    const flip = new THREE.Matrix4().makeScale(...s);
    for (const m of [...out]) out.push(flip.clone().multiply(m));
  }
  return out;
}

/**
 * Sample a part's surface into candidate leader-anchor points.
 *
 * A leader has to land on the actual solid, and the point that reads best moves
 * as the model turns — a face pointing at the camera from one view is edge-on
 * from the next. So instead of one fixed anchor we keep a spread of surface
 * points with their normals and let the annotation layer pick per view.
 *
 * Coordinates are in the part's STATIC frame (the geometry sits at the node's
 * base transform, which is identity), so animation channels do not disturb them.
 */
function sampleSurface(geometry, limit = 48) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  if (!pos) return [];
  const total = pos.count;
  const stride = Math.max(1, Math.floor(total / limit));
  const out = [];
  for (let i = 0; i < total; i += stride) {
    out.push({
      p: new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)),
      n: nrm
        ? new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).normalize()
        : new THREE.Vector3(0, 1, 0),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function decompose(m) {
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);
  return { pos, quat, scale };
}

/**
 * @param {object} spec - a normalized spec
 * @param {(part:object)=>THREE.Material} materialFor
 * @returns {{ root: THREE.Group, records: Map<string,object>, pickables: THREE.Mesh[], bbox: THREE.Box3, stats: object }}
 */
export function buildAssembly(spec, materialFor) {
  const root = new THREE.Group();
  root.name = 'assembly';

  const records = new Map();
  const pickables = [];
  const stats = { meshes: 0, tris: 0, lineSegments: 0, merged: 0 };

  const bySpec = new Map(spec.parts.map((p) => [p.id, p]));
  const hasChildren = new Set(spec.parts.map((p) => p.parent).filter(Boolean));
  const charSize = (spec._derived?.diag ?? 100) * 0.01;   // for default fastener sizes

  // Depth-first so a parent's nodes exist before its children ask for them.
  const order = [];
  const emitted = new Set();
  const visit = (p, guard = new Set()) => {
    if (emitted.has(p.id) || guard.has(p.id)) return;
    guard.add(p.id);
    if (p.parent && bySpec.has(p.parent)) visit(bySpec.get(p.parent), guard);
    if (emitted.has(p.id)) return;
    emitted.add(p.id);
    order.push(p);
  };
  for (const p of spec.parts) visit(p);

  for (const part of order) {
    let geometry;
    try {
      geometry = buildGeometry(part.shape);
    } catch (err) {
      console.warn(`[assembly] part "${part.id}": ${err.message} — skipped`);
      continue;
    }

    // details merge into the part's own geometry so they shade and outline as one
    const { geometry: detailGeo, lines: engraved } = buildDetails(geometry, part.details, charSize);
    let shaded = geometry;
    if (detailGeo) {
      const a = geometry.index ? geometry.toNonIndexed() : geometry;
      const norm = (g) => {
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', g.attributes.position.clone());
        if (!g.attributes.normal) g.computeVertexNormals();
        out.setAttribute('normal', g.attributes.normal.clone());
        return out;
      };
      shaded = mergeGeometries([norm(a), norm(detailGeo)], false) ?? geometry;
    }

    const material = materialFor(part);
    const weight = WEIGHTS[part.outline] ?? WEIGHTS.normal;

    const t = part.transform;
    const pivotMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.pos),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(t.rot[0] * DEG, t.rot[1] * DEG, t.rot[2] * DEG)),
      new THREE.Vector3(...t.scale),
    );

    const parentRec = part.parent ? records.get(part.parent) : null;
    const parentNode = parentRec ? parentRec.nodes[0] : root;

    const mats = instanceMatrices(part.instances);
    const animated = (part.channels?.length ?? 0) > 0;
    const nodes = [];
    const holders = [];
    const baseTransforms = [];

    // Kept per part so hover can recolour the outline instead of flooding the
    // body — the reference highlights a component by reddening its edges.
    const lines = [];

    // The geometry actually drawn under a node. For a merged part that is the
    // baked multi-instance geometry, not `shaded` — using `shaded` there would
    // report a single link as the bounds of a whole track run.
    let drawnGeo = null;

    const attach = (node, geo) => {
      drawnGeo = geo;
      const mesh = new THREE.Mesh(geo, material);
      mesh.userData = { partId: part.id, name: part.name, note: part.note, group: part.group };
      node.add(mesh);
      pickables.push(mesh);
      stats.meshes++;
      stats.tris += geo.attributes.position.count / 3;
      const line = edgesFor(geo, 25, weight);
      if (line) {
        node.add(line);
        lines.push(line);
        stats.lineSegments += line.geometry.attributes.instanceStart?.count ?? 0;
      }
    };

    // Static repeats collapse to one draw call — but only when nothing hangs off
    // this part, since merging bakes away the per-instance frames children need.
    const canMerge = !animated && mats.length > 1 && !hasChildren.has(part.id);

    if (canMerge) {
      const baked = mats.map((m) => {
        const g = (shaded.index ? shaded.toNonIndexed() : shaded).clone()
          .applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, pivotMatrix));
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', g.attributes.position.clone());
        if (!g.attributes.normal) g.computeVertexNormals();
        out.setAttribute('normal', g.attributes.normal.clone());
        return out;
      });
      const merged = mergeGeometries(baked, false);

      const holder = new THREE.Object3D();
      holder.name = `${part.id}:holder`;
      parentNode.add(holder);
      const node = new THREE.Object3D();
      holder.add(node);
      holders.push(holder);
      nodes.push(node);
      baseTransforms.push({
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1),
      });
      stats.merged += mats.length - 1;
      attach(node, merged);
    } else {
      for (const m of mats) {
        const holder = new THREE.Object3D();
        holder.name = `${part.id}:holder`;
        const { pos, quat, scale: sc } = decompose(m);
        holder.position.copy(pos);
        holder.quaternion.copy(quat);
        holder.scale.copy(sc);
        parentNode.add(holder);

        const pivot = new THREE.Object3D();
        pivot.name = `${part.id}:pivot`;
        pivot.position.set(...t.pos);
        pivot.rotation.set(t.rot[0] * DEG, t.rot[1] * DEG, t.rot[2] * DEG);
        pivot.scale.set(...t.scale);
        holder.add(pivot);

        const node = new THREE.Object3D();
        pivot.add(node);
        holders.push(holder);
        nodes.push(node);
        baseTransforms.push({
          pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1),
        });
        attach(node, shaded);
      }
    }

    if (engraved.length) {
      const el = linesFromSegments(engraved, WEIGHTS.light);
      if (el) nodes[0].add(el);
    }

    // `hidden` is the initial state of the SAME flag the visibility channel
    // drives. Hiding the holder instead would win permanently — the channel
    // writes to the node, so an internal part with `hidden: true` plus a
    // visibility channel could never be revealed.
    if (part.hidden) for (const n of nodes) n.visible = false;

    const boxGeo = drawnGeo ?? shaded;
    boxGeo.computeBoundingBox();
    shaded.computeBoundingBox();
    // Candidate leader anchors, in the part's static frame. The annotation
    // layer re-picks from these whenever the view settles, so the exit point
    // slides across the real surface instead of being nailed to one vertex.
    const anchors = sampleSurface(shaded, 48);

    records.set(part.id, {
      anchors,
      spec: part, holders, nodes, baseTransforms, lines, weight,
      localBox: boxGeo.boundingBox.clone(),
      material,
    });
  }

  // Frame the model consistently: centre it in XZ, sit it on Y=0, then scale so
  // every subject arrives at the camera the same size.
  //
  // The scale comes from the geometry that actually got built, not from
  // `bounds`. `bounds` is a drawing statement — a tank's quoted height is to the
  // turret roof, not to the tip of its antennas — so trusting it for framing
  // sends anything with a mast or a boom straight off the top of the sheet.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  const size = new THREE.Vector3();
  box.getSize(size);

  const actualDiag = Math.hypot(size.x, size.y, size.z) || 1;
  const scale = SCENE_DIAG / actualDiag;

  const shell = new THREE.Group();
  shell.name = 'assembly-shell';
  root.position.set(-centre.x, -box.min.y, -centre.z);
  shell.add(root);
  shell.scale.setScalar(scale);
  shell.updateMatrixWorld(true);

  // Publish the real numbers: annotations project dimension offsets with this
  // scale, and the camera frames against this height.
  if (spec._derived) {
    spec._derived.sceneScale = scale;
    spec._derived.modelHeightScene = size.y * scale;
    spec._derived.actualSize = { x: size.x, y: size.y, z: size.z };
  }

  const worldBox = new THREE.Box3().setFromObject(shell);

  return { root: shell, inner: root, records, pickables, bbox: worldBox, stats };
}
