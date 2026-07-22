/**
 * Fast raycast camera search for the right-palm repulsor hero beat.
 * Builds a local triangle soup around the hand and scores candidate cameras
 * by unoccluded visibility of thruster-face samples (no thumb/thigh block).
 */
globalThis.self = globalThis;
globalThis.URL = URL;
class FakeImage {
  set onload(fn) {
    this._onload = fn;
  }
  set src(_v) {
    this.width = 1;
    this.height = 1;
    queueMicrotask(() => this._onload?.());
  }
}
globalThis.Image = FakeImage;
globalThis.createImageBitmap = async () => ({
  width: 1,
  height: 1,
  close() {},
});

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const rootDir = process.cwd();
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath(pathToFileURL(path.join(rootDir, 'public/draco/')).href);
loader.setDRACOLoader(draco);

const buf = fs.readFileSync(path.join(rootDir, 'public/models/ironman.glb'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((resolve, reject) =>
  loader.parse(ab, '', resolve, reject),
);
const root = gltf.scene;

root.updateMatrixWorld(true);
let box = new THREE.Box3().setFromObject(root);
let size = box.getSize(new THREE.Vector3());
if (size.z > size.y * 1.25 && size.z > size.x) {
  root.rotation.x = -Math.PI / 2;
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  size = box.getSize(new THREE.Vector3());
}
const s = 1.85 / Math.max(size.y, 1e-4);
root.scale.multiplyScalar(s);
root.updateMatrixWorld(true);
box = new THREE.Box3().setFromObject(root);
const center = box.getCenter(new THREE.Vector3());
root.position.x -= center.x;
root.position.z -= center.z;
root.position.y -= box.min.y;
root.updateMatrixWorld(true);

// Local occluder region: right arm + body that can block palm view
const REGION = { xMin: -0.15, xMax: 0.75, yMin: 0.25, yMax: 1.45, zMin: -0.55, zMax: 1.2 };

const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const n = new THREE.Vector3();
const nMat = new THREE.Matrix3();
const palmSamples = [];
const palmDir = new THREE.Vector3(-1, -0.1, 0.15).normalize();

// Flat triangle list [ax,ay,az, bx,by,bz, cx,cy,cz] ...
const tris = [];

function inRegion(p) {
  return (
    p.x >= REGION.xMin &&
    p.x <= REGION.xMax &&
    p.y >= REGION.yMin &&
    p.y <= REGION.yMax &&
    p.z >= REGION.zMin &&
    p.z <= REGION.zMax
  );
}

root.traverse((mesh) => {
  if (!mesh.isMesh || !mesh.geometry) return;
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  if (!pos) return;
  nMat.getNormalMatrix(mesh.matrixWorld);
  const index = geo.index;
  const triCount = index ? index.count / 3 : pos.count / 3;

  const getV = (i, out) => {
    out.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
  };

  for (let t = 0; t < triCount; t++) {
    let i0, i1, i2;
    if (index) {
      i0 = index.getX(t * 3);
      i1 = index.getX(t * 3 + 1);
      i2 = index.getX(t * 3 + 2);
    } else {
      i0 = t * 3;
      i1 = t * 3 + 1;
      i2 = t * 3 + 2;
    }
    getV(i0, vA);
    getV(i1, vB);
    getV(i2, vC);
    // Keep triangle if any vertex in region
    if (!inRegion(vA) && !inRegion(vB) && !inRegion(vC)) continue;
    tris.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);

    // Palm samples from triangle verts with medial normals
    if (!nor) continue;
    for (const ii of [i0, i1, i2]) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, ii).applyMatrix4(mesh.matrixWorld);
      if (p.y < 0.84 || p.y > 1.06) continue;
      if (p.x < 0.3 || p.x > 0.46) continue;
      if (Math.abs(p.z) > 0.1) continue;
      n.fromBufferAttribute(nor, ii).applyMatrix3(nMat).normalize();
      if (n.dot(palmDir) < 0.6) continue;
      palmSamples.push({ p, n: n.clone() });
    }
  }
});

console.log('triangles in region', tris.length / 9, 'palm samples raw', palmSamples.length);

// Dedup palm samples by spatial hash
const hash = new Map();
for (const s of palmSamples) {
  const k = `${(s.p.x * 80) | 0},${(s.p.y * 80) | 0},${(s.p.z * 80) | 0}`;
  if (!hash.has(k)) hash.set(k, s);
}
const uniquePalm = [...hash.values()];
console.log('unique palm samples', uniquePalm.length);

const palmC = new THREE.Vector3();
const palmN = new THREE.Vector3();
for (const s of uniquePalm) {
  palmC.add(s.p);
  palmN.add(s.n);
}
palmC.multiplyScalar(1 / uniquePalm.length);
palmN.normalize();
console.log(
  'palm center',
  palmC.toArray().map((x) => +x.toFixed(3)),
  'n',
  palmN.toArray().map((x) => +x.toFixed(3)),
);

// Target points: densest near palm center (core thruster disk)
uniquePalm.sort((a, b) => a.p.distanceToSquared(palmC) - b.p.distanceToSquared(palmC));
const targets = uniquePalm.slice(0, 24).map((s) => s.p);

// Möller–Trumbore
const edge1 = new THREE.Vector3();
const edge2 = new THREE.Vector3();
const h = new THREE.Vector3();
const svec = new THREE.Vector3();
const q = new THREE.Vector3();
const EPSILON = 1e-7;

function rayTri(orig, dir, maxT) {
  let closest = maxT;
  let hit = false;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i],
      ay = tris[i + 1],
      az = tris[i + 2];
    const bx = tris[i + 3],
      by = tris[i + 4],
      bz = tris[i + 5];
    const cx = tris[i + 6],
      cy = tris[i + 7],
      cz = tris[i + 8];
    edge1.set(bx - ax, by - ay, bz - az);
    edge2.set(cx - ax, cy - ay, cz - az);
    h.crossVectors(dir, edge2);
    const a = edge1.dot(h);
    if (a > -EPSILON && a < EPSILON) continue;
    const f = 1 / a;
    svec.set(orig.x - ax, orig.y - ay, orig.z - az);
    const u = f * svec.dot(h);
    if (u < 0 || u > 1) continue;
    q.crossVectors(svec, edge1);
    const v = f * dir.dot(q);
    if (v < 0 || u + v > 1) continue;
    const t = f * edge2.dot(q);
    if (t > 0.002 && t < closest) {
      closest = t;
      hit = true;
    }
  }
  return hit ? closest : null;
}

const dir = new THREE.Vector3();
const palmToCam = new THREE.Vector3();

function scoreCam(cam) {
  palmToCam.copy(cam).sub(palmC);
  const dist = palmToCam.length();
  palmToCam.multiplyScalar(1 / dist);
  const facing = palmN.dot(palmToCam);
  if (facing < 0.25) return null;

  let vis = 0;
  for (const tp of targets) {
    const d = cam.distanceTo(tp);
    dir.copy(tp).sub(cam).normalize();
    // Bias target slightly toward camera so we don't immediately hit the palm surface from "inside"
    // Actually we cast FROM camera TO palm — first hit should be ~d
    const hitT = rayTri(cam, dir, d + 0.02);
    if (hitT == null) {
      vis += 0.4; // empty space (unlikely)
      continue;
    }
    // Allow hit within 3.5cm of target distance
    if (Math.abs(hitT - d) < 0.035) vis += 1;
    else if (hitT > d - 0.02) vis += 0.5; // near far plane
    // else occluded early (thumb/thigh)
  }
  const visRatio = vis / targets.length;
  const distScore = 1 - Math.min(1, Math.abs(dist - 0.72) / 0.5);
  // Prefer slightly elevated / frontal cinematic (not dead-on into thigh gap)
  const zBias = Math.max(0, Math.min(1, (cam.z - palmC.z + 0.1) / 0.6));
  const score = visRatio * 12 + facing * 2 + distScore * 1 + zBias * 0.4;
  return { vis: visRatio, facing, dist, score };
}

// Coarse then fine search
const candidates = [];
function addHemisphere(distStep, elevStep, azimStep, distList) {
  const upHint =
    Math.abs(palmN.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(upHint, palmN).normalize();
  const trueUp = new THREE.Vector3().crossVectors(palmN, right).normalize();
  for (const dist of distList) {
    for (let elev = -45; elev <= 50; elev += elevStep) {
      for (let azim = -65; azim <= 65; azim += azimStep) {
        const er = (elev * Math.PI) / 180;
        const ar = (azim * Math.PI) / 180;
        const offset = new THREE.Vector3()
          .addScaledVector(palmN, Math.cos(er) * Math.cos(ar))
          .addScaledVector(right, Math.sin(ar) * Math.cos(er))
          .addScaledVector(trueUp, Math.sin(er))
          .normalize();
        const cam = palmC.clone().addScaledVector(offset, dist);
        if (cam.y < 0.2 || cam.y > 1.65) continue;
        // avoid deep body interior
        if (Math.hypot(cam.x, cam.z) < 0.12 && cam.y > 0.7 && cam.y < 1.35) continue;
        candidates.push(cam);
      }
    }
  }
}

addHemisphere(10, 12, 12, [0.5, 0.65, 0.8, 0.95, 1.1]);
console.log('coarse candidates', candidates.length);

const scored = [];
for (const cam of candidates) {
  const r = scoreCam(cam);
  if (!r || r.vis < 0.35) continue;
  scored.push({ cam, ...r });
}
scored.sort((a, b) => b.score - a.score);
console.log('coarse survivors', scored.length);

// Refine around top 12
const refined = [];
for (const base of scored.slice(0, 12)) {
  for (let dx = -0.08; dx <= 0.08; dx += 0.04) {
    for (let dy = -0.08; dy <= 0.08; dy += 0.04) {
      for (let dz = -0.08; dz <= 0.08; dz += 0.04) {
        const cam = base.cam.clone().add(new THREE.Vector3(dx, dy, dz));
        const r = scoreCam(cam);
        if (!r) continue;
        refined.push({ cam, ...r });
      }
    }
  }
}
// Also keep coarse tops
refined.push(...scored.slice(0, 20));
refined.sort((a, b) => b.score - a.score);

// Dedup similar cams
const tops = [];
for (const r of refined) {
  if (tops.some((t) => t.cam.distanceTo(r.cam) < 0.05)) continue;
  tops.push(r);
  if (tops.length >= 10) break;
}

console.log('\n=== TOP camera poses (ray-scored) ===');
for (const t of tops) {
  console.log(
    JSON.stringify({
      score: +t.score.toFixed(3),
      vis: +t.vis.toFixed(3),
      facing: +t.facing.toFixed(3),
      dist: +t.dist.toFixed(3),
      cam: t.cam.toArray().map((x) => +x.toFixed(3)),
      look: palmC.toArray().map((x) => +x.toFixed(3)),
    }),
  );
}

const baselines = [
  ['current-front-below', new THREE.Vector3(0.18, 0.5, 0.98)],
  ['old-medial', new THREE.Vector3(0.02, 0.72, 0.48)],
  ['old-outer', new THREE.Vector3(0.78, 0.62, 1.05)],
];
console.log('\n=== baselines ===');
for (const [name, cam] of baselines) {
  const r = scoreCam(cam);
  console.log(name, r ? { score: +r.score.toFixed(3), vis: +r.vis.toFixed(3), facing: +r.facing.toFixed(3) } : null);
}

const best = tops[0];
if (!best) {
  console.error('no viable cam');
  process.exit(1);
}

const approach = best.cam.clone();
const pushDir = palmC.clone().sub(approach).normalize();
const push = approach.clone().addScaledVector(pushDir, best.dist * 0.15);
const pushScore = scoreCam(push);

const result = {
  approach: {
    x: +approach.x.toFixed(4),
    y: +approach.y.toFixed(4),
    z: +approach.z.toFixed(4),
    lx: +palmC.x.toFixed(4),
    ly: +palmC.y.toFixed(4),
    lz: +palmC.z.toFixed(4),
    fov: 28,
  },
  push: {
    x: +push.x.toFixed(4),
    y: +push.y.toFixed(4),
    z: +push.z.toFixed(4),
    lx: +palmC.x.toFixed(4),
    ly: +palmC.y.toFixed(4),
    lz: +(palmC.z + 0.02).toFixed(4),
    fov: 24,
    vis: pushScore?.vis ?? null,
  },
  palm: { center: palmC.toArray(), normal: palmN.toArray() },
  score: best.score,
  visible: best.vis,
  top: tops.slice(0, 5).map((t) => ({
    score: t.score,
    vis: t.vis,
    cam: t.cam.toArray().map((x) => +x.toFixed(4)),
  })),
};

console.log('\n=== RECOMMENDED ===');
console.log(JSON.stringify(result, null, 2));
fs.writeFileSync(
  path.join(rootDir, 'scripts/palm-cam-result.json'),
  JSON.stringify(result, null, 2),
);
console.log('wrote scripts/palm-cam-result.json');
