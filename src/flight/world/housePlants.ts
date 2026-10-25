import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BARK, SHRUB_HI, SPECIES, TREE_HI, V, bare, clump, foliage, limb, paint, seeded, type Detail, type Species } from './vegetation';

/**
 * Planting round the house, built the way the coast cover is (leaf
 * clumps with their light baked in, wind sway, backlit crowns, a close and
 * a lighter build): the coast's own fan palms, live oaks and brush, plus
 * what a garden adds — Italian cypress columns lining the drive, silvery
 * olives in the entry court, clipped hedges along the beds and terrace
 * planters, agave rosettes, and dry grass where the lawn gives out.
 * They're species like the coast's (see {@link Species}): the vegetation
 * draws them through its own tiers, impostors and all.
 */

/**
 * An Italian cypress, about 11 m: a smooth spindle on a short trunk, widest
 * a third of the way up, closing to a point. Close up its surface is
 * shingled with small upswept sprays standing off it, so the outline is
 * fuzzy, not faceted; the spindle's own normal shades them as one column.
 */
function cypressGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  const H = 11;
  const rnd = seeded(17, 4);
  const trunk = paint(limb(V(0, 0, 0), V(0, 1.6, 0), 0.2, 0.14, hi ? 6 : 4), BARK[0], BARK[1], 0, 2);
  const width = (t: number) => 0.92 * Math.sin(Math.PI * Math.min(1, t * 0.88 + 0.1)) * (1 - 0.42 * t);
  const Y0 = 0.9;
  const core = new THREE.CylinderGeometry(1, 1, 1, hi ? 12 : 8, hi ? 22 : 12, false);
  const cp = core.getAttribute('position');
  for (let i = 0; i < cp.count; i++) {
    const t = cp.getY(i) + 0.5;
    const a = Math.atan2(cp.getZ(i), cp.getX(i));
    // Gently tufted: lobes round the column, wandering up it
    const r = width(t) * (1 + 0.07 * Math.sin(a * 5 + t * 19) * Math.sin(t * 27 + a * 2)) * (hi ? 0.84 : 1);
    cp.setXYZ(i, cp.getX(i) * r, Y0 + t * (H - Y0), cp.getZ(i) * r);
  }
  const parts: THREE.BufferGeometry[] = [bare(core)];
  if (hi) {
    const n = 1400;
    const pos = new Float32Array(n * 9);
    const nrm = new Float32Array(n * 9);
    const out = new THREE.Vector3();
    const t1 = new THREE.Vector3();
    const up = V(0, 1, 0);
    for (let k = 0; k < n; k++) {
      // Even over the surface: rows weighted by their girth
      let t = rnd();
      while (rnd() > width(t) / 0.75) t = rnd();
      const a = rnd() * Math.PI * 2;
      const r = width(t) * (0.88 + rnd() * 0.16);
      out.set(Math.cos(a), 0, Math.sin(a));
      const c = V(out.x * r, Y0 + t * (H - Y0), out.z * r);
      t1.set(-out.z, 0, out.x);
      const s = 0.2 + rnd() * 0.14;
      // A spray pointing up and a little out, tilted at random
      const dir = up.clone().multiplyScalar(0.85).addScaledVector(out, 0.35 + rnd() * 0.3).addScaledVector(t1, (rnd() - 0.5) * 0.6).normalize();
      const corners = [c.clone().addScaledVector(dir, s), c.clone().addScaledVector(t1, s * 0.45).addScaledVector(dir, -s * 0.35), c.clone().addScaledVector(t1, -s * 0.45).addScaledVector(dir, -s * 0.35)];
      const fn = corners[1].clone().sub(corners[0]).cross(corners[2].clone().sub(corners[0]));
      if (fn.dot(out) < 0) corners.reverse();
      corners.forEach((q, j) => {
        pos.set([q.x, q.y, q.z], k * 9 + j * 3);
        nrm.set([out.x, 0.3, out.z], k * 9 + j * 3);
      });
    }
    const leaves = new THREE.BufferGeometry();
    leaves.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    leaves.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    parts.push(leaves);
  }
  const crown = foliage(parts, V(0, H / 2 + 0.4, 0), V(0.95, H / 2, 0.95), new THREE.Color(0.08, 0.11, 0.047), new THREE.Color(0.026, 0.042, 0.02), 9);
  return mergeGeometries([trunk, crown]);
}

/** A clipped hedge mound, about 1.2 m: small leaves, dense, a tidy outline. */
function hedgeGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  return foliage(
    [
      clump(0.75, 0.75, V(0, 0.55, 0), 61, hi, 0.08, 0.13),
      clump(0.62, 0.78, V(0.62, 0.48, 0.12), 62, hi, 0.08, 0.13),
      clump(0.6, 0.76, V(-0.6, 0.46, -0.1), 63, hi, 0.08, 0.13),
      clump(0.5, 0.8, V(0.1, 0.5, 0.55), 64, hi, 0.08, 0.13),
      clump(0.5, 0.8, V(-0.05, 0.48, -0.55), 65, hi, 0.08, 0.13),
    ],
    V(0, 0.55, 0),
    V(1.2, 0.6, 1.0),
    new THREE.Color(0.11, 0.15, 0.05),
    new THREE.Color(0.035, 0.05, 0.02),
    12,
  );
}

/**
 * Olive: two or three gnarled trunks leaning out from one root, each
 * forking into a loose, silvery grey-green crown.
 */
function oliveGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  const rnd = seeded(23, 8);
  const wood: THREE.BufferGeometry[] = [];
  const clumps: THREE.BufferGeometry[] = [];
  const stems = 3;
  for (let s = 0; s < stems; s++) {
    const a = (s / stems) * Math.PI * 2 + rnd() * 0.5;
    const knee = V(Math.cos(a) * 0.45, 1.1 + rnd() * 0.3, Math.sin(a) * 0.45);
    const top = V(Math.cos(a) * 1.2, 2.3 + rnd() * 0.4, Math.sin(a) * 1.2);
    wood.push(limb(V(Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1), knee, 0.24, 0.18, hi ? 7 : 5), limb(knee, top, 0.18, 0.1, hi ? 6 : 4));
    for (let t = 0; t < 3; t++) {
      const b = a + (t - 1) * 0.8 + (rnd() - 0.5) * 0.3;
      const out = 1.3 + rnd() * 0.7;
      const tip = V(Math.cos(b) * out, top.y + 0.5 + rnd() * 0.6, Math.sin(b) * out);
      if (hi) wood.push(limb(top, tip, 0.07, 0.03, 4));
      clumps.push(clump(0.95 + rnd() * 0.3, 0.85, tip, 70 + s * 3 + t, hi, 0.35, 0.36));
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    clumps.push(clump(1.05, 0.85, V(Math.cos(a) * 0.9, 3.9 + rnd() * 0.4, Math.sin(a) * 0.9), 80 + i, hi, 0.35, 0.36));
  }
  const crown = foliage(clumps, V(0, 3.2, 0), V(2.6, 1.4, 2.6), new THREE.Color(0.15, 0.165, 0.11), new THREE.Color(0.05, 0.058, 0.04), 7);
  return mergeGeometries([...wood.map((g) => paint(g, new THREE.Color(0.13, 0.115, 0.095), new THREE.Color(0.06, 0.052, 0.042), 0, 2.5)), crown]);
}

/** Agave: a rosette of thick, blue-grey, sword-shaped leaves curling up and out (single sheets). */
function agaveGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  const rnd = seeded(31, 2);
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const base = new THREE.Color(0.11, 0.14, 0.12);
  const tip = new THREE.Color(0.27, 0.33, 0.3);
  const N = hi ? 22 : 12;
  const S = hi ? 4 : 2;
  const c0 = new THREE.Color();
  const c1 = new THREE.Color();
  for (let f = 0; f < N; f++) {
    const a = f * 2.39996 + rnd() * 0.2;
    // Inner leaves stand up; outer ones splay
    const ring = f / N;
    const lift = 1.2 - ring * 0.85;
    const len = 0.65 + (1 - ring) * 0.25 + rnd() * 0.1;
    const dir = V(Math.cos(a), 0, Math.sin(a));
    const side = V(-dir.z, 0, dir.x);
    const at = (t: number) =>
      V(0, 0.08, 0)
        .addScaledVector(dir, Math.cos(lift * (1 - 0.35 * t)) * len * t)
        .add(V(0, Math.sin(lift * (1 - 0.35 * t)) * len * t, 0));
    const width = (t: number) => 0.11 * (1 - t) ** 0.8;
    const n = side.clone().cross(at(1).sub(at(0))).normalize();
    if (n.y < 0) n.negate();
    n.y += 0.5;
    n.normalize();
    for (let s = 0; s < S; s++) {
      const t0 = s / S;
      const t1 = (s + 1) / S;
      const p0 = at(t0);
      const p1 = at(t1);
      c0.copy(base).lerp(tip, t0);
      c1.copy(base).lerp(tip, t1);
      // Folded down the middle (a shallow V)
      const quad = [
        [p0.clone().addScaledVector(side, -width(t0)).add(V(0, 0.02, 0)), c0],
        [p0, c0],
        [p1.clone().addScaledVector(side, -width(t1)).add(V(0, 0.02, 0)), c1],
        [p0, c0],
        [p1, c1],
        [p1.clone().addScaledVector(side, -width(t1)).add(V(0, 0.02, 0)), c1],
        [p0, c0],
        [p0.clone().addScaledVector(side, width(t0)).add(V(0, 0.02, 0)), c0],
        [p1, c1],
        [p0.clone().addScaledVector(side, width(t0)).add(V(0, 0.02, 0)), c0],
        [p1.clone().addScaledVector(side, width(t1)).add(V(0, 0.02, 0)), c1],
        [p1, c1],
      ] as const;
      for (const [p, c] of quad) {
        pos.push(p.x, p.y, p.z);
        nrm.push(n.x, n.y, n.z);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * Every species the garden plants, keyed as the house lays them out (its
 * dry grass is the cover's own, drawn with the brush by the eye). The
 * coast's kinds are its very entries, so the two never drift apart.
 */
export const GARDEN: Record<string, Species> = {
  ...SPECIES,
  olive: { build: oliveGeometry, hiRange: TREE_HI },
  cypress: { build: cypressGeometry, hiRange: TREE_HI },
  hedge: { build: hedgeGeometry, hiRange: SHRUB_HI },
  agave: { build: agaveGeometry, twoSided: true, hiRange: SHRUB_HI },
};
