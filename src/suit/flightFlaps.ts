import * as THREE from 'three';
import type { FlapId } from '../animation/flightCheck';
import type { ArmorPieceId } from './armorPieces';
import type { ArmorPiece } from './waves';
import { boneSpec } from './rig';

type V3 = [number, number, number];

interface FlapSpec {
  id: FlapId;
  piece: ArmorPieceId;
  /** Panels whose centroid falls in this bind-space box become the flap (whole piece if omitted). */
  region?: { min: V3; max: V3 };
  /** Hinge from the flap's bind bounds (+ optional straight lift first). */
  hinge: (b: THREE.Box3) => Motion;
}

/**
 * Flap motion at channel k: optionally lift straight out by `lift`
 * (k 0 → liftEnd), then swing `angle` about the hinge (k swingStart → 1).
 */
interface Motion {
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  angle: number;
  lift?: THREE.Vector3;
  liftEnd?: number;
  swingStart?: number;
}

/** How far the trapezius rocket silo rises out of the shoulder (m). */
export const SILO_RISE = 0.04;
/** How far the hip plate slides out over the flare dispenser (m). */
export const FLARE_SLIDE = 0.03;

/** Outward normal of the outer forearm (bind), ⊥ to the forearm axis. */
export function forearmNormal(side: 'L' | 'R'): THREE.Vector3 {
  const s = side === 'L' ? 1 : -1;
  const spec = boneSpec(`forearm.${side}`);
  const y = new THREE.Vector3(...spec.tail).sub(new THREE.Vector3(...spec.head)).normalize();
  const n = new THREE.Vector3(s, 0.25, 0);
  return n.addScaledVector(y, -n.dot(y)).normalize();
}

const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const mid = (b: THREE.Box3, k: 'x' | 'y' | 'z') => (b.min[k] + b.max[k]) / 2;

/**
 * Mark III flight-control surfaces: the twin shoulder-blade flaps, the
 * small flaps on top of each pauldron, and the calf plates. Flaps are the
 * model's own panels (connected panel components), so they part on the
 * existing panel lines.
 */
const FLAPS: FlapSpec[] = (['L', 'R'] as const).flatMap((side): FlapSpec[] => {
  const s = side === 'L' ? 1 : -1;
  const xr = (a: number, b: number): [number, number] => (s > 0 ? [a, b] : [-b, -a]);
  const [bx0, bx1] = xr(0.035, 0.16);
  const [px0, px1] = xr(0.225, 0.33);
  return [
    {
      id: `back.${side}`,
      piece: 'back.upper',
      region: { min: [bx0, 1.29, -0.3], max: [bx1, 1.43, -0.13] },
      // Hinged on the top edge; the lower edge swings out from the back
      hinge: (b) => ({ pivot: new THREE.Vector3(mid(b, 'x'), b.max.y, mid(b, 'z')), axis: X, angle: 0.55 }),
    },
    {
      id: `shoulder.${side}`,
      piece: `pauldron.${side}`,
      region: { min: [px0, 1.53, -0.1], max: [px1, 1.64, 0.1] },
      // Hinged on the neck-side edge; the outer edge lifts
      hinge: (b) => ({
        pivot: new THREE.Vector3(s > 0 ? b.min.x : b.max.x, mid(b, 'y'), mid(b, 'z')),
        axis: Z,
        angle: 0.6 * s,
      }),
    },
    {
      // Outer forearm panel rises straight out on the launcher rail
      id: `launcher.${side}`,
      piece: `forearm.${side}`,
      region: { min: [xr(0.355, 0.41)[0], 1.17, -0.09], max: [xr(0.355, 0.41)[1], 1.31, 0.0] },
      hinge: (b) => ({
        pivot: new THREE.Vector3(mid(b, 'x'), b.max.y, mid(b, 'z')),
        axis: Z,
        angle: 0.1 * s,
        lift: forearmNormal(side).multiplyScalar(0.04),
        liftEnd: 0.7,
        swingStart: 0.6,
      }),
    },
    {
      // Trapezius panel shifts straight up on the mini-rocket silo
      id: `trap.${side}`,
      piece: 'back.upper',
      region: { min: [xr(0.09, 0.165)[0], 1.6, -0.1], max: [xr(0.09, 0.165)[1], 1.7, -0.02] },
      hinge: (b) => ({
        pivot: new THREE.Vector3(mid(b, 'x'), b.max.y, b.min.z),
        axis: X,
        angle: 0,
        lift: new THREE.Vector3(0, SILO_RISE, 0),
      }),
    },
    {
      // Hip side plate slides out over the flare dispenser
      id: `flare.${side}`,
      piece: 'hips.front',
      region: { min: [xr(0.165, 0.215)[0], 0.93, 0.0], max: [xr(0.165, 0.215)[1], 1.04, 0.1] },
      hinge: (b) => ({
        pivot: new THREE.Vector3(mid(b, 'x'), mid(b, 'y'), mid(b, 'z')),
        axis: X,
        angle: 0,
        lift: new THREE.Vector3(s * FLARE_SLIDE, 0, -0.012),
      }),
    },
    {
      id: `calf.${side}`,
      piece: `shin.${side}.back`,
      hinge: (b) => ({ pivot: new THREE.Vector3(mid(b, 'x'), b.max.y - 0.02, b.min.z + 0.03), axis: X, angle: 0.26 }),
    },
  ];
});

export interface Flap extends Motion {
  id: FlapId;
  piece: ArmorPiece;
  mesh: THREE.SkinnedMesh;
  /** Bind bounds of the flap's panels. */
  bounds: THREE.Box3;
}

const smooth = (a: number, b: number, k: number) => {
  const u = Math.min(1, Math.max(0, (k - a) / Math.max(1e-6, b - a)));
  return u * u * (3 - 2 * u);
};
const _r = new THREE.Matrix4();
const _t = new THREE.Matrix4();

/** Bind-space motion of a flap at channel k: T(lift) · T(p) R T(−p). */
export function flapMotion(f: Flap, k: number, out: THREE.Matrix4): THREE.Matrix4 {
  out.identity();
  if (k <= 1e-4) return out;
  const lift = f.lift ? smooth(0, f.liftEnd ?? 1, k) : 0;
  const swing = f.swingStart !== undefined ? smooth(f.swingStart, 1, k) : k;
  if (f.lift) out.makeTranslation(f.lift.x * lift, f.lift.y * lift, f.lift.z * lift);
  return out
    .multiply(_t.makeTranslation(f.pivot.x, f.pivot.y, f.pivot.z))
    .multiply(_r.makeRotationAxis(f.axis, f.angle * swing))
    .multiply(_t.makeTranslation(-f.pivot.x, -f.pivot.y, -f.pivot.z));
}

/** Index buffer of a geometry (synthesised for non-indexed). */
function indexOf(geo: THREE.BufferGeometry): ArrayLike<number> {
  if (geo.index) return geo.index.array;
  const n = geo.getAttribute('position').count;
  return Array.from({ length: n }, (_, i) => i);
}

/** Triangle → panel id (connected through shared vertex indices). */
function panels(index: ArrayLike<number>, vertexCount: number): Int32Array {
  const parent = new Int32Array(vertexCount).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const tris = index.length / 3;
  for (let t = 0; t < tris; t++) {
    const a = find(index[3 * t]);
    parent[find(index[3 * t + 1])] = a;
    parent[find(index[3 * t + 2])] = a;
  }
  const out = new Int32Array(tris);
  for (let t = 0; t < tris; t++) out[t] = find(index[3 * t]);
  return out;
}

/** Same attributes, only the chosen triangles. */
function subset(geo: THREE.BufferGeometry, index: ArrayLike<number>, keep: (t: number) => boolean): THREE.BufferGeometry {
  const idx: number[] = [];
  for (let t = 0; t < index.length / 3; t++) {
    if (keep(t)) idx.push(index[3 * t], index[3 * t + 1], index[3 * t + 2]);
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) out.setAttribute(name, attr);
  out.setIndex(idx);
  // Attributes are shared, so bound only the vertices this subset uses
  const pos = geo.getAttribute('position');
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const i of idx) box.expandByPoint(v.fromBufferAttribute(pos, i));
  out.boundingBox = box;
  return out;
}

function skinned(geo: THREE.BufferGeometry, like: THREE.SkinnedMesh, name: string): THREE.SkinnedMesh {
  const m = new THREE.SkinnedMesh(geo, like.material);
  m.name = name;
  m.bindMode = THREE.DetachedBindMode;
  m.frustumCulled = false;
  m.matrixAutoUpdate = false;
  m.visible = false;
  return m;
}

/**
 * Split the flapped parts into a fixed remainder + moving flaps (flight
 * check only). Returns the flaps and, per split part, its remainder mesh.
 */
export function buildFlightFlaps(pieces: readonly ArmorPiece[]): {
  flaps: Flap[];
  rests: Map<ArmorPieceId, THREE.SkinnedMesh>;
} {
  const flaps: Flap[] = [];
  const taken = new Map<ArmorPieceId, Set<number>>();
  const rests = new Map<ArmorPieceId, THREE.SkinnedMesh>();
  const cache = new Map<ArmorPieceId, { index: ArrayLike<number>; panel: Int32Array; centre: Map<number, THREE.Vector3> }>();

  for (const spec of FLAPS) {
    const piece = pieces.find((p) => p.id === spec.piece);
    if (!piece) continue;
    const src = piece.mesh as THREE.SkinnedMesh;
    const geo = src.geometry;
    let info = cache.get(spec.piece);
    if (!info) {
      const index = indexOf(geo);
      const pos = geo.getAttribute('position');
      const panel = panels(index, pos.count);
      const sum = new Map<number, { v: THREE.Vector3; n: number }>();
      for (let t = 0; t < panel.length; t++) {
        let e = sum.get(panel[t]);
        if (!e) sum.set(panel[t], (e = { v: new THREE.Vector3(), n: 0 }));
        for (let k = 0; k < 3; k++) {
          const i = index[3 * t + k];
          e.v.x += pos.getX(i);
          e.v.y += pos.getY(i);
          e.v.z += pos.getZ(i);
        }
        e.n += 3;
      }
      const centre = new Map([...sum].map(([id, e]) => [id, e.v.divideScalar(e.n)] as const));
      info = { index, panel, centre };
      cache.set(spec.piece, info);
    }
    const { index, panel, centre } = info;
    let mine: (t: number) => boolean;
    if (spec.region) {
      const box = new THREE.Box3(new THREE.Vector3(...spec.region.min), new THREE.Vector3(...spec.region.max));
      const ids = new Set([...centre].filter(([, c]) => box.containsPoint(c)).map(([id]) => id));
      if (ids.size === 0) continue;
      mine = (t) => ids.has(panel[t]);
      const set = taken.get(spec.piece) ?? new Set<number>();
      ids.forEach((id) => set.add(id));
      taken.set(spec.piece, set);
    } else {
      mine = () => true;
    }
    const flapGeo = subset(geo, index, mine);
    const mesh = skinned(flapGeo, src, `flap-${spec.id}`);
    const h = spec.hinge(flapGeo.boundingBox!);
    flaps.push({ id: spec.id, piece, mesh, bounds: flapGeo.boundingBox!.clone(), ...h });
  }

  // Remainders for parts that only lost some panels
  for (const [id, ids] of taken) {
    const piece = pieces.find((p) => p.id === id)!;
    const src = piece.mesh as THREE.SkinnedMesh;
    const { index, panel } = cache.get(id)!;
    rests.set(id, skinned(subset(src.geometry, index, (t) => !ids.has(panel[t])), src, `flap-rest-${id}`));
  }
  return { flaps, rests };
}
