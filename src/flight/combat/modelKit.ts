import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * A small kit for the hostiles' hard-surface models. Every rigid piece is
 * baked into one vertex-coloured geometry (built once, shared by every
 * instance), so a drone, truck or ship with dozens of panels still costs only
 * a draw call or two per moving part. Lofted pieces are faceted on purpose —
 * flat-shaded steel reads at a distance and suits the stealth shapes.
 */

export type V3 = readonly [number, number, number];
export type Paint = THREE.ColorRepresentation;

const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();

/** One flat colour on a geometry, stripped to position + normal + colour so anything merges with anything. */
export function paint(geo: THREE.BufferGeometry, color: Paint, gain = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  _c.set(color).multiplyScalar(gain);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) _c.toArray(col, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.clearGroups();
  return g;
}

/** Merge painted pieces into one geometry. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('modelKit: pieces do not merge');
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/** Collects triangles, each wound to face away from a given inside point. */
class Tris {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  add(a: V3, b: V3, c: V3, inside: THREE.Vector3, color: Paint): void {
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    _n.crossVectors(_a, _b);
    if (_n.lengthSq() < 1e-12) return;
    const gx = (a[0] + b[0] + c[0]) / 3 - inside.x;
    const gy = (a[1] + b[1] + c[1]) / 3 - inside.y;
    const gz = (a[2] + b[2] + c[2]) / 3 - inside.z;
    const flip = _n.x * gx + _n.y * gy + _n.z * gz < 0;
    this.pos.push(...a, ...(flip ? c : b), ...(flip ? b : c));
    _c.set(color);
    for (let i = 0; i < 3; i++) this.col.push(_c.r, _c.g, _c.b);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

const centroid = (ring: readonly V3[], out: THREE.Vector3) => {
  out.set(0, 0, 0);
  for (const p of ring) out.add(_a.set(p[0], p[1], p[2]));
  return out.divideScalar(ring.length);
};

/**
 * Skin a run of rings (each the same number of points, in order round the
 * section) into a faceted solid. `color(edge, seg)` paints the band from ring
 * point `edge` to `edge + 1` on span `seg`; the end caps ask with seg −1 and
 * seg rings.length − 1. Faces wind outward from the section centre, so any
 * convex section works whichever way round it is listed; for sheared runs
 * (a raked stem) `inside` names a point inside the solid near each face.
 */
export function loft(
  rings: readonly (readonly V3[])[],
  color: Paint | ((edge: number, seg: number) => Paint),
  caps: readonly [boolean, boolean] = [true, true],
  inside?: (centre: THREE.Vector3) => THREE.Vector3,
): THREE.BufferGeometry {
  const paintOf = typeof color === 'function' ? color : () => color;
  const t = new Tris();
  const c0 = new THREE.Vector3();
  const c1 = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const n = rings[0].length;
  for (let s = 0; s < rings.length - 1; s++) {
    const r0 = rings[s];
    const r1 = rings[s + 1];
    mid.addVectors(centroid(r0, c0), centroid(r1, c1)).multiplyScalar(0.5);
    for (let e = 0; e < n; e++) {
      const f = (e + 1) % n;
      const p = paintOf(e, s);
      const ref = (a: V3, b: V3, c: V3) => (inside ? inside(c0.set((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3)) : mid);
      t.add(r0[e], r0[f], r1[f], ref(r0[e], r0[f], r1[f]), p);
      t.add(r0[e], r1[f], r1[e], ref(r0[e], r1[f], r1[e]), p);
    }
  }
  const cap = (ring: readonly V3[], next: readonly V3[], seg: number) => {
    const c = centroid(ring, new THREE.Vector3());
    const inside = centroid(next, new THREE.Vector3());
    const cc: V3 = [c.x, c.y, c.z];
    for (let e = 0; e < n; e++) t.add(cc, ring[e], ring[(e + 1) % n], inside, paintOf(e, seg));
  };
  if (caps[0]) cap(rings[0], rings[1], -1);
  if (caps[1]) cap(rings[rings.length - 1], rings[rings.length - 2], rings.length - 1);
  return t.geometry();
}

/**
 * A block with sloped sides: at the foot (height y0) it spans ±hw0 across and
 * z0…z1 along; at the head (y1) ±hw1 and z2…z3. Ring points run front-right,
 * front-left, back-left, back-right, so edge 0 is the front face, 1 the
 * left (−x), 2 the back, 3 the right; caps are the floor and the roof.
 */
export interface Frustum {
  hw0: number;
  z0: number;
  z1: number;
  y0: number;
  hw1: number;
  z2: number;
  z3: number;
  y1: number;
  x?: number;
}

export function frustum(f: Frustum, color: Paint | ((edge: number, seg: number) => Paint)): THREE.BufferGeometry {
  const x = f.x ?? 0;
  const ring = (hw: number, za: number, zb: number, y: number): V3[] => [
    [x + hw, y, Math.max(za, zb)],
    [x - hw, y, Math.max(za, zb)],
    [x - hw, y, Math.min(za, zb)],
    [x + hw, y, Math.min(za, zb)],
  ];
  return loft([ring(f.hw0, f.z0, f.z1, f.y0), ring(f.hw1, f.z2, f.z3, f.y1)], color);
}

/**
 * A flat panel laid on one face of a {@link Frustum} ('f'ront, 'b'ack,
 * 'l'eft, 'r'ight): u0…u1 across the face (−1…1), v0…v1 up it (0…1), lifted
 * `lift` off the steel. Windows, doors, sensor faces.
 */
export function panelOn(f: Frustum, face: 'f' | 'b' | 'l' | 'r', u0: number, u1: number, v0: number, v1: number, color: Paint, lift = 0.03): THREE.BufferGeometry {
  const x = f.x ?? 0;
  const front0 = Math.max(f.z0, f.z1);
  const back0 = Math.min(f.z0, f.z1);
  const front1 = Math.max(f.z2, f.z3);
  const back1 = Math.min(f.z2, f.z3);
  const at = (u: number, v: number): THREE.Vector3 => {
    const y = f.y0 + (f.y1 - f.y0) * v;
    const hw = f.hw0 + (f.hw1 - f.hw0) * v;
    const fz = front0 + (front1 - front0) * v;
    const bz = back0 + (back1 - back0) * v;
    const mz = (fz + bz) / 2;
    const hl = (fz - bz) / 2;
    switch (face) {
      case 'f': return new THREE.Vector3(x - u * hw, y, fz);
      case 'b': return new THREE.Vector3(x + u * hw, y, bz);
      case 'l': return new THREE.Vector3(x - hw, y, mz - u * hl);
      case 'r': return new THREE.Vector3(x + hw, y, mz + u * hl);
    }
  };
  const out = face === 'f' ? new THREE.Vector3(0, 0, 1) : face === 'b' ? new THREE.Vector3(0, 0, -1) : face === 'l' ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(1, 0, 0);
  const a = at(u0, v0);
  const b = at(u1, v0);
  const c = at(u1, v1);
  const d = at(u0, v1);
  const nrm = new THREE.Vector3().crossVectors(b.clone().sub(a), d.clone().sub(a)).normalize();
  if (nrm.dot(out) < 0) nrm.negate();
  return quad(a.addScaledVector(nrm, lift), b.addScaledVector(nrm, lift), c.addScaledVector(nrm, lift), d.addScaledVector(nrm, lift), nrm, color);
}

/** Four corners (in order round the edge) as a two-triangle panel facing `out`. */
export function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, out: THREE.Vector3, color: Paint): THREE.BufferGeometry {
  const t = new Tris();
  const inside = a.clone().add(b).add(c).add(d).multiplyScalar(0.25).sub(out);
  const v = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];
  t.add(v(a), v(b), v(c), inside, color);
  t.add(v(a), v(c), v(d), inside, color);
  return t.geometry();
}

/** A strut from a to b: a `sides`-sided prism of radius r. */
export function beam(a: V3, b: V3, r: number, color: Paint, sides = 4): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(from);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, sides, 1);
  if (sides === 4) g.rotateY(Math.PI / 4);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate(from.x + (b[0] - a[0]) / 2, from.y + (b[1] - a[1]) / 2, from.z + (b[2] - a[2]) / 2);
  return paint(g, color);
}

/** An axis-aligned box centred at (x, y, z). */
export function box(w: number, h: number, l: number, color: Paint, x: number, y: number, z: number): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, l).translate(x, y, z), color);
}

/**
 * Lights baked into geometry: unlit, the vertex colour is the emission (so
 * values over 1 bloom), but still a standard material so the haze takes it.
 */
export function glowMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;');
  };
  m.customProgramCacheKey = () => 'glowVertexColour';
  return m;
}
