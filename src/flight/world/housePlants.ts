import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Planting round the house: Mexican fan palms (tall, slender, a little
 * bent, a ragged crown of drooping fronds), Italian cypress columns and
 * clipped shrubs. One unit geometry each, instanced.
 */

function colorize(g: THREE.BufferGeometry, fn: (p: THREE.Vector3) => THREE.Color): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const c = fn(p.fromBufferAttribute(pos, i));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') geo.deleteAttribute(k);
  return geo;
}

/** A palm about 16 m tall (scaled per instance). */
export function palmGeometry(): THREE.BufferGeometry {
  const H = 16;
  const bend = (y: number) => 0.9 * (y / H) ** 2;
  const trunk = new THREE.CylinderGeometry(0.17, 0.3, H, 7, 10, true).translate(0, H / 2, 0);
  const tp = trunk.getAttribute('position');
  for (let i = 0; i < tp.count; i++) tp.setX(i, tp.getX(i) + bend(tp.getY(i)));
  trunk.computeVertexNormals();
  const bark = new THREE.Color(0.24, 0.2, 0.16);
  const barkTop = new THREE.Color(0.32, 0.27, 0.2);
  const parts = [colorize(trunk, (p) => bark.clone().lerp(barkTop, p.y / H).multiplyScalar(0.85 + 0.15 * Math.sin(p.y * 9)))];
  // Dead frond skirt under the crown
  const skirt = new THREE.ConeGeometry(0.75, 1.6, 8, 1, true).translate(bend(H) , H - 0.7, 0);
  parts.push(colorize(skirt, () => new THREE.Color(0.28, 0.22, 0.14)));
  // Fronds
  const leaf = new THREE.Color(0.1, 0.17, 0.06);
  const leafTip = new THREE.Color(0.2, 0.25, 0.1);
  const crown = new THREE.Vector3(bend(H), H, 0);
  const N = 16;
  for (let f = 0; f < N; f++) {
    const yaw = (f / N) * Math.PI * 2 + (f % 2) * 0.2;
    const lift = f % 3 === 0 ? 0.55 : f % 3 === 1 ? 0.2 : -0.15;
    const len = 3.6 + (f % 4) * 0.35;
    const segs = 6;
    const tris: number[] = [];
    const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const out = t * len;
      const y = Math.sin(lift) * out - 1.4 * t * t * len * 0.45;
      pts.push(crown.clone().addScaledVector(dir, out * Math.cos(lift * 0.5)).add(new THREE.Vector3(0, y, 0)));
    }
    for (let s = 0; s < segs; s++) {
      const w0 = 0.9 * Math.sin(Math.PI * Math.min(1, (s / segs) * 1.15 + 0.08));
      const w1 = 0.9 * Math.sin(Math.PI * Math.min(1, ((s + 1) / segs) * 1.15 + 0.08));
      const a = pts[s];
      const b = pts[s + 1];
      // Folded down the rib (a shallow V)
      const fold = new THREE.Vector3(0, -0.18, 0);
      const al = a.clone().addScaledVector(side, -w0).add(fold);
      const ar = a.clone().addScaledVector(side, w0).add(fold);
      const bl = b.clone().addScaledVector(side, -w1).add(fold);
      const br = b.clone().addScaledVector(side, w1).add(fold);
      for (const v of [al, a, bl, a, b, bl, a, ar, b, ar, br, b]) tris.push(v.x, v.y, v.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
    g.computeVertexNormals();
    // Foliage lighting: normals mostly up and out (soft, not faceted)
    const nrm = g.getAttribute('normal');
    const gp = g.getAttribute('position');
    for (let i = 0; i < nrm.count; i++) {
      const o = new THREE.Vector3(gp.getX(i) - crown.x, 1.2, gp.getZ(i) - crown.z).normalize();
      nrm.setXYZ(i, o.x, o.y, o.z);
    }
    parts.push(colorize(g, (p) => leaf.clone().lerp(leafTip, Math.min(1, p.distanceTo(crown) / len))));
  }
  return mergeGeometries(parts)!;
}

function blob(r: number, sy: number, at: THREE.Vector3, seed: number, detail = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.getAttribute('position');
  const nrm = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const k = 1 + 0.12 * Math.sin(v.x * 5.1 + seed) * Math.sin(v.z * 4.3 + seed * 2) + 0.08 * Math.sin(v.y * 7 + seed);
    v.multiplyScalar(k);
    v.y *= sy;
    pos.setXYZ(i, v.x + at.x, v.y + at.y, v.z + at.z);
    n.y = n.y * 0.8 + 0.35;
    n.normalize();
    nrm.set([n.x, n.y, n.z], i * 3);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/** An Italian cypress about 11 m tall. */
export function cypressGeometry(): THREE.BufferGeometry {
  const g = blob(1, 1, new THREE.Vector3(), 3, 3);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Spindle: widest a third of the way up, to a point at the top
    const t = (y + 1) / 2;
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    // Clumpy: tufts round the column, stacked up it
    const tuft = 1 + 0.16 * Math.sin(a * 5 + t * 23) * Math.sin(t * 31 + a * 2) + 0.08 * Math.sin(t * 57);
    const w = 0.95 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.12)) * (1 - 0.35 * t) * tuft;
    pos.setXYZ(i, pos.getX(i) * w, t * 11, pos.getZ(i) * w);
  }
  const dark = new THREE.Color(0.04, 0.07, 0.03);
  const top = new THREE.Color(0.09, 0.13, 0.05);
  return colorize(g, (p) => dark.clone().lerp(top, p.y / 11));
}

/** A clipped shrub mass about 1.2 m. */
export function shrubGeometry(): THREE.BufferGeometry {
  const g = mergeGeometries([blob(0.8, 0.7, new THREE.Vector3(0, 0.45, 0), 1, 1), blob(0.6, 0.75, new THREE.Vector3(0.6, 0.38, 0.2), 2, 1), blob(0.55, 0.8, new THREE.Vector3(-0.5, 0.35, -0.25), 4, 1)].map((x) => x.toNonIndexed()))!;
  const lo = new THREE.Color(0.03, 0.05, 0.02);
  const hi = new THREE.Color(0.11, 0.16, 0.05);
  return colorize(g, (p) => lo.clone().lerp(hi, Math.min(1, p.y / 1.1)));
}
