import * as THREE from 'three';
import type { FlapId } from '../animation/flightCheck';
import type { ArmorPieceId } from './armorPieces';
import type { ArmorPiece } from './waves';
import { boneSpec } from './rig';

type V3 = [number, number, number];

interface FlapSpec {
  id: FlapId;
  piece: ArmorPieceId;
  /**
   * Panels centred in this bind-space box become the flap (whole piece if
   * omitted) — unless they run more than {@link REGION_SLACK} out of it: a
   * long panel-line wall or seam sliver that only starts in the box would
   * otherwise swing out with the flap as a thin blade.
   */
  region?: { min: V3; max: V3 };
  /**
   * Take only whole plates (welded connectivity islands) that fit the
   * region — for a part that is one discrete plate on the model (the trap
   * cap, the round hip drum face), so it moves complete with its own side
   * walls and nothing of the surrounding armor comes with it.
   */
  plates?: boolean;
  /** Override of {@link REGION_SLACK} (m). */
  slack?: number;
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
/** How far the round hip plate pushes out on its flare drum (m). */
export const FLARE_PUSH = 0.05;

/** Outward normal of the outer forearm (bind), ⊥ to the forearm axis. */
export function forearmNormal(side: 'L' | 'R'): THREE.Vector3 {
  const s = side === 'L' ? 1 : -1;
  const spec = boneSpec(`forearm.${side}`);
  const y = new THREE.Vector3(...spec.tail).sub(new THREE.Vector3(...spec.head)).normalize();
  const n = new THREE.Vector3(s, 0.25, 0);
  return n.addScaledVector(y, -n.dot(y)).normalize();
}

/** How far (m) a flap panel / plate may reach past its region box. */
const REGION_SLACK = 0.025;

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
      // Trapezius cap shifts straight up on the mini-rocket silo
      id: `trap.${side}`,
      piece: 'back.upper',
      region: { min: [xr(0.09, 0.165)[0], 1.6, -0.1], max: [xr(0.09, 0.165)[1], 1.7, -0.02] },
      plates: true,
      hinge: (b) => ({
        pivot: new THREE.Vector3(mid(b, 'x'), b.max.y, b.min.z),
        axis: X,
        angle: 0,
        lift: new THREE.Vector3(0, SILO_RISE, 0),
      }),
    },
    {
      // Round hip plate: pushes straight out on its flare drum, then the
      // drum indexes a sixth of a turn like a revolver cylinder to line its
      // ports up — the flares leave from the drum's side
      id: `flare.${side}`,
      piece: 'hips.front',
      region: { min: [xr(0.16, 0.2)[0], 0.962, -0.012], max: [xr(0.16, 0.2)[1], 1.041, 0.075] },
      plates: true,
      slack: 0.006,
      hinge: (b) => {
        // The plate's face normal (it looks out and a touch forward)
        const n = new THREE.Vector3(s, 0, 0.17).normalize();
        return {
          pivot: b.getCenter(new THREE.Vector3()),
          axis: n,
          angle: Math.PI / 3,
          lift: n.clone().multiplyScalar(FLARE_PUSH),
          liftEnd: 0.5,
          swingStart: 0.4,
        };
      },
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

/** Union-find over n items. */
function unionFind(n: number) {
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  return { find, union: (a: number, b: number) => (parent[find(b)] = find(a)) };
}

/**
 * Triangle → panel id (connected through shared vertex indices) and → plate
 * id (panels welded where they share a position: split-normal / UV-seam
 * duplicates break one physical plate into many index-connected panels).
 */
function panels(
  index: ArrayLike<number>,
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): { panel: Int32Array; plate: Int32Array } {
  const tris = index.length / 3;
  const byIndex = unionFind(pos.count);
  const welded = unionFind(pos.count);
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i);
    else welded.union(first, i);
  }
  for (let t = 0; t < tris; t++) {
    for (const uf of [byIndex, welded]) {
      uf.union(index[3 * t], index[3 * t + 1]);
      uf.union(index[3 * t], index[3 * t + 2]);
    }
  }
  const panel = new Int32Array(tris);
  const plate = new Int32Array(tris);
  for (let t = 0; t < tris; t++) {
    panel[t] = byIndex.find(index[3 * t]);
    plate[t] = welded.find(index[3 * t]);
  }
  return { panel, plate };
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

/**
 * Two-sided copy of a subset: every triangle plus a back-to-back twin with
 * flipped normals. The model winds some plates inside-out (the hip drum
 * face reads only through the dark cavity shell while it is seated), so a
 * plate that travels clear of the suit must show both faces, lit properly.
 */
function twoSided(sub: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = sub.index!.array;
  const used = [...new Set(idx)];
  const local = new Map(used.map((v, i) => [v, i] as const));
  const n = used.length;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(sub.attributes)) {
    const size = attr.itemSize;
    const Arr = attr.array.constructor as new (n: number) => THREE.TypedArray;
    const arr = new Arr(n * 2 * size);
    used.forEach((v, i) => {
      for (let k = 0; k < size; k++) {
        const x = attr.getComponent(v, k);
        arr[i * size + k] = x;
        arr[(n + i) * size + k] = name === 'normal' ? -x : x;
      }
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, size, attr.normalized));
  }
  const tris: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [local.get(idx[t])!, local.get(idx[t + 1])!, local.get(idx[t + 2])!];
    tris.push(a, b, c, n + a, n + c, n + b);
  }
  out.setIndex(tris);
  out.boundingBox = sub.boundingBox!.clone();
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
  const cache = new Map<
    ArmorPieceId,
    {
      index: ArrayLike<number>;
      panel: Int32Array;
      bounds: Map<number, THREE.Box3>;
      centre: Map<number, THREE.Vector3>;
      plateOf: Map<number, number>;
      plateBounds: Map<number, THREE.Box3>;
      platePanels: Map<number, Set<number>>;
    }
  >();

  for (const spec of FLAPS) {
    const piece = pieces.find((p) => p.id === spec.piece);
    if (!piece) continue;
    const src = piece.mesh as THREE.SkinnedMesh;
    const geo = src.geometry;
    let info = cache.get(spec.piece);
    if (!info) {
      const index = indexOf(geo);
      const pos = geo.getAttribute('position');
      const { panel, plate } = panels(index, pos);
      const bounds = new Map<number, THREE.Box3>();
      const sums = new Map<number, THREE.Vector3>();
      const counts = new Map<number, number>();
      const plateBounds = new Map<number, THREE.Box3>();
      const platePanels = new Map<number, Set<number>>();
      const v = new THREE.Vector3();
      for (let t = 0; t < panel.length; t++) {
        let b = bounds.get(panel[t]);
        if (!b) bounds.set(panel[t], (b = new THREE.Box3()));
        let pb = plateBounds.get(plate[t]);
        if (!pb) plateBounds.set(plate[t], (pb = new THREE.Box3()));
        let c = sums.get(panel[t]);
        if (!c) sums.set(panel[t], (c = new THREE.Vector3()));
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, index[3 * t + k]);
          b.expandByPoint(v);
          pb.expandByPoint(v);
          c.add(v);
        }
        counts.set(panel[t], (counts.get(panel[t]) ?? 0) + 3);
        let pp = platePanels.get(plate[t]);
        if (!pp) platePanels.set(plate[t], (pp = new Set()));
        pp.add(panel[t]);
      }
      const centre = new Map([...sums].map(([id, c]) => [id, c.divideScalar(counts.get(id)!)] as const));
      const plateOf = new Map<number, number>();
      for (let t = 0; t < panel.length; t++) plateOf.set(panel[t], plate[t]);
      info = { index, panel, bounds, centre, plateOf, plateBounds, platePanels };
      cache.set(spec.piece, info);
    }
    const { index, panel, bounds, centre, plateOf, plateBounds, platePanels } = info;
    let mine: (t: number) => boolean;
    if (spec.region) {
      const region = new THREE.Box3(new THREE.Vector3(...spec.region.min), new THREE.Vector3(...spec.region.max));
      const loose = region.clone().expandByScalar(spec.slack ?? REGION_SLACK);
      const set = taken.get(spec.piece) ?? new Set<number>();
      // Panels centred in the region that don't run far out of it
      const ids = new Set(
        [...centre]
          .filter(
            ([id, c]) =>
              !set.has(id) &&
              region.containsPoint(c) &&
              loose.containsBox(bounds.get(id)!) &&
              (!spec.plates || loose.containsBox(plateBounds.get(plateOf.get(id)!)!)),
          )
          .map(([id]) => id),
      );
      // Complete every plate the flap touches that fits the region, so a
      // lifted panel carries its own rim / side walls instead of leaving
      // them standing on the suit as slivers
      for (const id of [...ids]) {
        const plate = plateOf.get(id)!;
        if (!loose.containsBox(plateBounds.get(plate)!)) continue;
        for (const other of platePanels.get(plate)!) if (!set.has(other)) ids.add(other);
      }
      if (ids.size === 0) continue;
      mine = (t) => ids.has(panel[t]);
      ids.forEach((id) => set.add(id));
      taken.set(spec.piece, set);
    } else {
      mine = () => true;
    }
    // Whole plates travel clear of the suit, so they show both faces
    const flapGeo = spec.plates ? twoSided(subset(geo, index, mine)) : subset(geo, index, mine);
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
