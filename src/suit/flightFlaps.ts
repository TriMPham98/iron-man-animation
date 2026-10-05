import * as THREE from 'three';
import type { FlapId } from '../animation/flightCheck';
import type { ArmorPieceId } from './armorPieces';
import type { ArmorPiece } from './waves';
import { boneSpec } from './rig';
import { cutSoup, soupFrom, soupGeometry, wallFor, type FlapCut, type Soup } from './flapCut';

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
  /** Clean-edged plate clipped out of the part's surface (see flapCut). */
  cut?: FlapCut;
  /**
   * Hinge from the flap's bind bounds (+ optional straight lift first).
   * `edge` is the middle of a cut plate's top edge on its outer skin.
   */
  hinge: (b: THREE.Box3, edge: THREE.Vector3) => Motion;
}

/**
 * Flap motion at channel k: optionally lift straight out by `lift`
 * (k 0 → liftEnd), slide by `slide` (k over slideSpan), then swing `angle`
 * about the hinge (k swingStart → swingEnd).
 */
interface Motion {
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  angle: number;
  lift?: THREE.Vector3;
  liftEnd?: number;
  swingStart?: number;
  swingEnd?: number;
  slide?: THREE.Vector3;
  slideSpan?: readonly [number, number];
}

/**
 * The trap plate and the missile pod under it rise together, level, the
 * plate riding on top of the pod and the tubes aimed straight ahead (m).
 */
export const SILO_RISE = 0.034;
/** Height of the launcher block (m). */
export const SILO_POD_H = 0.026;
/**
 * The outer forearm lid lifts straight out, then slides back toward the
 * elbow (m), and the anti-tank missile under it rises out of the forearm.
 */
export const LAUNCHER_LID_OUT = 0.026;
export const LAUNCHER_LID_BACK = 0.042;
export const MISSILE_RISE = 0.019;
export const MISSILE_RISE_SPAN = [0.45, 0.92] as const;

/** Forearm axis (bind), elbow → hand. */
export function forearmAxis(side: 'L' | 'R'): THREE.Vector3 {
  const spec = boneSpec(`forearm.${side}`);
  return new THREE.Vector3(...spec.tail).sub(new THREE.Vector3(...spec.head)).normalize();
}
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
 * Mark III flight-control surfaces, after the film's flight test: twin
 * shoulder-blade air brakes on the back, a rear spoiler on each pauldron,
 * hamstring air brakes and the calf flaps. Each is a clean-edged plate cut
 * from the suit's own outer shell (straight machined edges with a short side
 * wall), hinged on its leading (top) edge so the trailing edge swings out
 * into the airflow. Weapons housings and the flare plates use whole panels.
 */
const FLAPS: FlapSpec[] = (['L', 'R'] as const).flatMap((side): FlapSpec[] => {
  const s = side === 'L' ? 1 : -1;
  const xr = (a: number, b: number): [number, number] => (s > 0 ? [a, b] : [-b, -a]);
  /** Outline seen from behind (x, y), mirrored for the right side. */
  const back = (pts: Array<[number, number]>) => pts.map(([x, y]) => [s * x, y] as const);
  /**
   * Top-edge hinge on the outer skin, so the leading edge stays put and the
   * trailing edge swings out behind the suit. (Hinged at the bounds' middle,
   * the outer top edge would rise into the shell above and fight it.)
   */
  const topHinge = (angle: number) => (b: THREE.Box3, edge: THREE.Vector3) => ({
    pivot: new THREE.Vector3(mid(b, 'x'), edge.y, edge.z),
    axis: X,
    angle,
  });
  return [
    {
      // Shoulder-blade air brake: the large plate either side of the spine.
      // Like the calf, its edges stay where the shell faces the view: the
      // outer corner is clipped off the blade's fold under the pauldron,
      // where an edge would run along the neighbouring armor and fight it
      id: `back.${side}`,
      piece: 'back.upper',
      cut: {
        along: 'z',
        outline: back([
          [0.058, 1.48],
          [0.132, 1.48],
          [0.142, 1.45],
          [0.135, 1.34],
          [0.072, 1.326],
        ]),
        depth: [-0.3, -0.07],
        wall: 0.007,
      },
      hinge: topHinge(0.5),
    },
    {
      // Shoulder air brake: the outer face of the pauldron, hinged along
      // its top edge, swings out sideways like a speed brake. Kept off the
      // pauldron's rounded front and back, and cut from the outer skin only
      id: `shoulder.${side}`,
      piece: `pauldron.${side}`,
      cut: {
        along: 'x',
        outline: [
          [-0.06, 1.582],
          [0.04, 1.582],
          [0.036, 1.486],
          [-0.056, 1.486],
        ],
        depth: s > 0 ? [0.27, 0.4] : [-0.4, -0.27],
        wall: 0.007,
      },
      hinge: (b, edge) => ({
        pivot: new THREE.Vector3(edge.x, edge.y, mid(b, 'z')),
        axis: Z,
        angle: 0.5 * s,
      }),
    },
    {
      // Outer forearm panel rises straight out on the launcher rail. Cut
      // just inside its raised rim (the rim stays on the forearm), so the
      // whole plate lifts clean instead of a patchwork of panels that left
      // half its surface behind for the launcher to pass through
      id: `launcher.${side}`,
      piece: `forearm.${side}`,
      cut: {
        along: 'x',
        outline: [
          [-0.02, 1.264],
          [-0.042, 1.289],
          [-0.068, 1.285],
          [-0.076, 1.276],
          [-0.077, 1.249],
          [-0.071, 1.219],
          [-0.014, 1.216],
          [-0.013, 1.232],
        ],
        depth: s > 0 ? [0.35, 0.46] : [-0.46, -0.35],
        // The face slants across the window: outer skin (and its liner) only
        skin: 0.006,
        wall: 0.006,
      },
      // Unlatches and lifts straight out of the forearm, then slides back
      // toward the elbow, clear of the missile bay
      hinge: () => ({
        pivot: new THREE.Vector3(),
        axis: Z,
        angle: 0,
        lift: forearmNormal(side).multiplyScalar(LAUNCHER_LID_OUT),
        liftEnd: 0.32,
        slide: forearmAxis(side).multiplyScalar(-LAUNCHER_LID_BACK),
        slideSpan: [0.22, 0.6],
      }),
    },
    {
      // Trapezius cap: the top plate of the mini-missile pod under it — the
      // two rise together, level, baring the forward-facing rack
      id: `trap.${side}`,
      piece: 'back.upper',
      region: { min: [xr(0.09, 0.165)[0], 1.6, -0.1], max: [xr(0.09, 0.165)[1], 1.7, -0.02] },
      plates: true,
      hinge: (b) => ({
        pivot: new THREE.Vector3(mid(b, 'x'), b.max.y, b.min.z),
        axis: X,
        angle: 0,
        lift: new THREE.Vector3(0, SILO_RISE, 0.004),
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
      // Hamstring air brake on the back of the thigh, its outer edge in
      // off the thigh's flank (as the calf flap)
      id: `thigh.${side}`,
      piece: `thigh.${side}.back`,
      cut: {
        along: 'z',
        outline: back([
          [0.094, 0.872],
          [0.16, 0.872],
          [0.155, 0.728],
          [0.1, 0.728],
        ]),
        depth: [-0.3, -0.04],
        wall: 0.006,
      },
      hinge: topHinge(0.32),
    },
    {
      // Calf flap: the upper calf plate only (as in the film), not the
      // whole calf
      id: `calf.${side}`,
      piece: `shin.${side}.back`,
      cut: {
        along: 'z',
        outline: back([
          // Edges stay on the back of the calf, clear of the grazing flanks
          [0.104, 0.488],
          [0.19, 0.488],
          [0.197, 0.398],
          [0.186, 0.252],
          [0.114, 0.252],
          [0.097, 0.398],
        ]),
        depth: [-0.3, -0.04],
        wall: 0.006,
      },
      hinge: topHinge(0.3),
    },
  ];
});

export interface Flap extends Motion {
  id: FlapId;
  piece: ArmorPiece;
  mesh: THREE.SkinnedMesh;
  /**
   * Side walls of a cut plate. Drawn only while this flap is open: at rest
   * they sit in the neighbouring shell, and showing them because a sibling
   * flap on the same part moved makes that shell flicker.
   */
  walls?: THREE.SkinnedMesh;
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
  const swing = f.swingStart !== undefined || f.swingEnd !== undefined ? smooth(f.swingStart ?? 0, f.swingEnd ?? 1, k) : k;
  const sl = f.slide ? smooth(f.slideSpan?.[0] ?? 0, f.slideSpan?.[1] ?? 1, k) : 0;
  if (f.lift || f.slide) {
    out.makeTranslation(
      (f.lift?.x ?? 0) * lift + (f.slide?.x ?? 0) * sl,
      (f.lift?.y ?? 0) * lift + (f.slide?.y ?? 0) * sl,
      (f.lift?.z ?? 0) * lift + (f.slide?.z ?? 0) * sl,
    );
  }
  return out
    .multiply(_t.makeTranslation(f.pivot.x, f.pivot.y, f.pivot.z))
    .multiply(_r.makeRotationAxis(f.axis, f.angle * swing))
    .multiply(_t.makeTranslation(-f.pivot.x, -f.pivot.y, -f.pivot.z));
}

/**
 * Middle of a cut plate's top edge on its outer skin: the vertices along
 * the top of the outline, the outermost of them along the view axis.
 */
function outerTopEdge(plate: Soup, cut: FlapCut): THREE.Vector3 {
  const ax = cut.along;
  const out = cut.depth[0] + cut.depth[1] < 0 ? -1 : 1;
  const verts = plate.flat().map((v) => v.p);
  const top = Math.max(...verts.map((p) => p.y));
  const rim = verts.filter((p) => p.y > top - 0.008);
  const outer = Math.max(...rim.map((p) => out * p[ax]));
  const skin = rim.filter((p) => out * p[ax] > outer - 0.006);
  const c = new THREE.Vector3();
  for (const p of skin) c.add(p);
  return c.divideScalar(skin.length);
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
 * Same material, drawn from both sides. A duplicated back-to-back triangle
 * sits on the plate and flickers against it; `DoubleSide` does not.
 */
function bothSides(mat: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  const one = (m: THREE.Material) => {
    const c = m.clone();
    c.side = THREE.DoubleSide;
    return c;
  };
  return Array.isArray(mat) ? mat.map(one) : one(mat);
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
    if (spec.cut) continue;
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
    // Whole plates travel clear of the suit. Some are wound inside-out, so
    // the plate is drawn from both sides without a second coplanar skin.
    const flapGeo = subset(geo, index, mine);
    const mesh = skinned(flapGeo, src, `flap-${spec.id}`);
    if (spec.plates) mesh.material = bothSides(src.material);
    const h = spec.hinge(flapGeo.boundingBox!, flapGeo.boundingBox!.getCenter(new THREE.Vector3()));
    flaps.push({ id: spec.id, piece, mesh, bounds: flapGeo.boundingBox!.clone(), ...h });
  }

  // Clean-edged plates cut from whatever each part still has
  const soups = new Map<ArmorPieceId, Soup>();
  for (const spec of FLAPS) {
    if (!spec.cut) continue;
    const piece = pieces.find((p) => p.id === spec.piece);
    if (!piece) continue;
    const src = piece.mesh as THREE.SkinnedMesh;
    let soup = soups.get(spec.piece);
    if (!soup) {
      const ids = taken.get(spec.piece);
      const info = cache.get(spec.piece);
      const index = info?.index ?? indexOf(src.geometry);
      soup = soupFrom(src.geometry, index, (t) => !ids || !info || !ids.has(info.panel[t]));
    }
    const { plate, rest, edges } = cutSoup(soup, spec.cut);
    soups.set(spec.piece, rest);
    if (plate.length === 0) continue;
    const depth = spec.cut.wall ?? 0.006;
    // Plate walls sit a hair inside the cut so they don't share a face with the shell
    const view = spec.cut.along === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const flapGeo = soupGeometry(plate);
    const wallTris = wallFor(edges, depth, 0.0006, view);
    const mesh = skinned(flapGeo, src, `flap-${spec.id}`);
    const walls = wallTris.length ? skinned(soupGeometry(wallTris), src, `flap-walls-${spec.id}`) : undefined;
    const h = spec.hinge(flapGeo.boundingBox!, outerTopEdge(plate, spec.cut));
    flaps.push({ id: spec.id, piece, mesh, bounds: flapGeo.boundingBox!.clone(), walls, ...h });
  }

  // Remainders for parts that only lost some panels
  for (const [id, ids] of taken) {
    if (soups.has(id)) continue;
    const piece = pieces.find((p) => p.id === id)!;
    const src = piece.mesh as THREE.SkinnedMesh;
    const { index, panel } = cache.get(id)!;
    rests.set(id, skinned(subset(src.geometry, index, (t) => !ids.has(panel[t])), src, `flap-rest-${id}`));
  }
  for (const [id, soup] of soups) {
    const src = pieces.find((p) => p.id === id)!.mesh as THREE.SkinnedMesh;
    rests.set(id, skinned(soupGeometry(soup), src, `flap-rest-${id}`));
  }
  return { flaps, rests };
}
