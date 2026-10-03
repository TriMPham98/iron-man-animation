import {
  boneAxis,
  boneSpec,
  type BoneName,
  type Limb,
  type Vec3,
} from './rig';
import type { PieceWave } from './waves';

/**
 * Mark III suit-up components (Iron Man, 2008 workshop sequence).
 *
 * The rigged mesh is cut along its own panel lines into the parts the
 * workshop robots fit onto Tony: boots (floor lifts), clamshell leg and
 * upper-arm plates, pelvis, back plates, abdomen, pecs + reactor housing,
 * sleeves and gauntlets that slide onto the outstretched arms, pauldrons,
 * then the helmet with the faceplate still hinged open.
 */
export type ArmorPieceId =
  | 'boot.L'
  | 'boot.R'
  | 'shin.L.front'
  | 'shin.L.back'
  | 'shin.R.front'
  | 'shin.R.back'
  | 'thigh.L.front'
  | 'thigh.L.back'
  | 'thigh.R.front'
  | 'thigh.R.back'
  | 'hips.front'
  | 'hips.back'
  | 'back.lower'
  | 'back.upper'
  | 'abdomen'
  | 'pec.L'
  | 'pec.R'
  | 'chest.core'
  | 'upperArm.L.front'
  | 'upperArm.L.back'
  | 'upperArm.R.front'
  | 'upperArm.R.back'
  | 'forearm.L'
  | 'forearm.R'
  | 'gauntlet.L'
  | 'gauntlet.R'
  | 'pauldron.L'
  | 'pauldron.R'
  | 'helmet'
  | 'faceplate';

/** Offset expressed in the suit's model frame or the anchor bone's frame. */
export interface FrameVec {
  v: Vec3;
  space: 'model' | 'anchor';
}

export interface PieceRotation {
  /** Axis in the anchor bone's frame. */
  axis: Vec3;
  /** Radians at channel value 1. */
  angle: number;
  /** Bind-space pivot (defaults to the anchor joint). */
  pivot?: Vec3;
}

export interface ArmorPieceDef {
  id: ArmorPieceId;
  label: string;
  wave: PieceWave;
  /** Bone whose frame the piece docks into. */
  anchor: BoneName;
  /**
   * Straight-line insertion at value 1: the staging pose is the socket offset
   * by this vector. Clamshell halves use it as their open jaw stroke.
   */
  insert: FrameVec;
  /** Screw-on rotation during the insertion (sleeves, gauntlets). */
  twist?: PieceRotation;
  /** Faceplate swing (1 = open). */
  hinge?: PieceRotation;
}

const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const model = (v: Vec3): FrameVec => ({ v, space: 'model' });
const anchor = (v: Vec3): FrameVec => ({ v, space: 'anchor' });

/**
 * Faceplate hinge — pivots at the ear discs so the mask swings up over the
 * brow (open) and down onto the face (closed), like the film prop.
 */
export const FACEPLATE_HINGE_PIVOT: Vec3 = [0, 1.735, 0.0];
export const FACEPLATE_OPEN_ANGLE = -1.45;

function sidePieces(side: 'L' | 'R'): ArmorPieceDef[] {
  const s = side === 'L' ? 1 : -1;
  const forearmAxis = boneAxis(`forearm.${side}`);
  const handAxis = boneAxis(`hand.${side}`);
  const half = (
    id: ArmorPieceId,
    label: string,
    wave: PieceWave,
    bone: BoneName,
    z: number,
  ): ArmorPieceDef => ({ id, label, wave, anchor: bone, insert: anchor([0, 0, z]) });
  return [
    {
      id: `boot.${side}`,
      label: `${side} boot`,
      wave: 'boots',
      anchor: `foot.${side}`,
      insert: model([0, -0.05, 0]),
    },
    half(`shin.${side}.front`, `${side} shin (front)`, 'calves', `shin.${side}`, 0.075),
    half(`shin.${side}.back`, `${side} shin (back)`, 'calves', `shin.${side}`, -0.075),
    half(`thigh.${side}.front`, `${side} thigh (front)`, 'thighs', `thigh.${side}`, 0.085),
    half(`thigh.${side}.back`, `${side} thigh (back)`, 'thighs', `thigh.${side}`, -0.085),
    half(`upperArm.${side}.front`, `${side} upper arm (front)`, 'arms', `upperArm.${side}`, 0.07),
    half(`upperArm.${side}.back`, `${side} upper arm (back)`, 'arms', `upperArm.${side}`, -0.07),
    {
      id: `forearm.${side}`,
      label: `${side} forearm`,
      wave: 'arms',
      anchor: `forearm.${side}`,
      // Slides on from past the fingertips and screws home on the elbow
      insert: anchor(scale(forearmAxis, 0.14)),
      twist: { axis: forearmAxis, angle: 0.9 * s },
    },
    {
      id: `gauntlet.${side}`,
      label: `${side} gauntlet`,
      wave: 'gauntlets',
      anchor: `hand.${side}`,
      insert: anchor(scale(handAxis, 0.1)),
      twist: { axis: handAxis, angle: -0.7 * s },
    },
    {
      id: `pauldron.${side}`,
      label: `${side} pauldron`,
      wave: 'shoulders',
      // Rides the chest frame (its skin still follows the arm), so the
      // gantry arm can lower it straight down in any stance
      anchor: 'chest',
      // Lowered straight down onto the shoulder
      insert: model([0, 0.08, 0]),
    },
    {
      id: `pec.${side}`,
      label: `${side} pectoral plate`,
      wave: 'torso',
      anchor: 'chest',
      insert: model([0.03 * s, 0, 0.09]),
    },
  ];
}

export const ARMOR_PIECES: readonly ArmorPieceDef[] = [
  ...sidePieces('L'),
  ...sidePieces('R'),
  { id: 'hips.front', label: 'codpiece', wave: 'hips', anchor: 'hips', insert: model([0, 0, 0.09]) },
  { id: 'hips.back', label: 'pelvis back', wave: 'hips', anchor: 'hips', insert: model([0, 0, -0.09]) },
  { id: 'back.lower', label: 'lower back plate', wave: 'torso', anchor: 'spine', insert: model([0, 0, -0.09]) },
  { id: 'back.upper', label: 'upper back plate', wave: 'torso', anchor: 'chest', insert: model([0, 0, -0.1]) },
  { id: 'abdomen', label: 'abdomen plate', wave: 'torso', anchor: 'spine', insert: model([0, 0, 0.08]) },
  // Reactor housing is driven home last — the impact beat
  { id: 'chest.core', label: 'reactor housing', wave: 'torso', anchor: 'chest', insert: model([0, 0, 0.13]) },
  { id: 'helmet', label: 'helmet', wave: 'helmet', anchor: 'head', insert: model([0, 0.09, 0]) },
  {
    id: 'faceplate',
    label: 'faceplate',
    wave: 'helmet',
    anchor: 'head',
    insert: model([0, 0.09, 0]),
    hinge: { axis: [1, 0, 0], angle: FACEPLATE_OPEN_ANGLE, pivot: FACEPLATE_HINGE_PIVOT },
  },
];

const DEF_BY_ID = new Map(ARMOR_PIECES.map((d) => [d.id, d] as const));

export function armorPieceDef(id: ArmorPieceId): ArmorPieceDef {
  const d = DEF_BY_ID.get(id);
  if (!d) throw new Error(`Unknown armor piece ${id}`);
  return d;
}

// ── Cutting the mesh into pieces ─────────────────────────────────────────

/** Affine plane test f(p) = n·p − d (positive side = `pos`). */
export interface CutPlane {
  n: Vec3;
  d: number;
}

export type CutTree = ArmorPieceId | { plane: CutPlane; pos: CutTree; neg: CutTree; id: number };

let nodeIds = 0;
const node = (plane: CutPlane, pos: CutTree, neg: CutTree): CutTree => ({
  plane,
  pos,
  neg,
  id: nodeIds++,
});
const plane = (n: Vec3, d: number): CutPlane => ({ n, d });
/** Plane with normal n through point p. */
const planeThrough = (n: Vec3, p: Vec3): CutPlane => {
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const u: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
  return { n: u, d: u[0] * p[0] + u[1] * p[1] + u[2] * p[2] };
};
const mirrorPlane = (c: CutPlane): CutPlane => ({ n: [-c.n[0], c.n[1], c.n[2]], d: c.d });

/**
 * Seam heights (bind space, m). Chosen on existing panel lines of the model
 * so pieces part where the armor already does.
 */
export const SEAMS = {
  /** Boot cuff top. */
  boot: 0.185,
  /** Shin / thigh split — knee cap rides with the thigh. */
  knee: 0.475,
  /** Thigh top: y = hipBase + hipSlope·|x| (higher on the outer hip). */
  hipBase: 0.79,
  hipSlope: 0.5,
  /** Pelvis / abdomen. */
  waist: 1.03,
  /** Abdomen / chest. */
  ribs: 1.22,
  /** Lower / upper back plate. */
  backSplit: 1.27,
  /** Reactor housing half-width (pecs outside it). */
  coreX: 0.085,
  /** Pauldron underside and its inner edge. */
  pauldronY: 1.405,
  pauldronX: 0.17,
  /** Collar top — chin and above is helmet. */
  collar: 1.607,
  /** Helmet half-width above the collar. */
  headX: 0.1,
  /** Faceplate: brow / cheek seam z = faceZ + faceSlope·(y − faceSplitY). */
  faceZ: 0.055,
  faceSlope: 0.1,
  faceSplitY: 1.7,
  /** Jaw / chin seam below faceSplitY. */
  jawZ: 0.02,
  /**
   * Chin plate: front panels under the mouth are only partly head-skinned
   * (they blend into the neck) but belong to the faceplate so it swings
   * as one unit, chin included.
   */
  chinX: 0.075,
  chinY: 1.6,
  chinZ: 0.075,
  /** Front / back clamshell planes (z). */
  torsoZ: -0.02,
  hipsZ: 0,
  thighZ: -0.01,
  shinZ: -0.025,
  upperArmZ: -0.03,
} as const;

const fb = (zSplit: number, front: ArmorPieceId, back: ArmorPieceId): CutTree =>
  node(plane([0, 0, 1], zSplit), front, back);

function hipPlane(side: 'L' | 'R'): CutPlane {
  const p = plane([-SEAMS.hipSlope, 1, 0], SEAMS.hipBase);
  return side === 'L' ? p : mirrorPlane(p);
}

function legTree(side: 'L' | 'R'): CutTree {
  const thighs = fb(SEAMS.thighZ, `thigh.${side}.front`, `thigh.${side}.back`);
  return node(
    plane([0, 1, 0], SEAMS.boot),
    node(
      plane([0, 1, 0], SEAMS.knee),
      node(hipPlane(side), fb(SEAMS.hipsZ, 'hips.front', 'hips.back'), thighs),
      fb(SEAMS.shinZ, `shin.${side}.front`, `shin.${side}.back`),
    ),
    `boot.${side}`,
  );
}

function armTree(side: 'L' | 'R'): CutTree {
  const upper = boneAxis(`upperArm.${side}`);
  const fore = boneAxis(`forearm.${side}`);
  const elbow = boneSpec(`forearm.${side}`).head;
  const wrist = boneSpec(`hand.${side}`).head;
  // Gauntlet cuff starts ~1 cm above the wrist joint
  const cuff: Vec3 = [wrist[0] - fore[0] * 0.012, wrist[1] - fore[1] * 0.012, wrist[2] - fore[2] * 0.012];
  const elbowN: Vec3 = [upper[0] + fore[0], upper[1] + fore[1], upper[2] + fore[2]];
  return node(
    planeThrough(fore, cuff),
    `gauntlet.${side}`,
    node(
      planeThrough(elbowN, elbow),
      `forearm.${side}`,
      node(
        plane([0, 1, 0], SEAMS.pauldronY),
        `pauldron.${side}`,
        fb(SEAMS.upperArmZ, `upperArm.${side}.front`, `upperArm.${side}.back`),
      ),
    ),
  );
}

function pelvisTree(side: 'L' | 'R'): CutTree {
  return node(
    hipPlane(side),
    fb(SEAMS.hipsZ, 'hips.front', 'hips.back'),
    fb(SEAMS.thighZ, `thigh.${side}.front`, `thigh.${side}.back`),
  );
}

function coreTree(): CutTree {
  const chest = node(
    plane([0, 0, 1], SEAMS.torsoZ),
    node(
      plane([1, 0, 0], SEAMS.coreX),
      'pec.L',
      node(plane([-1, 0, 0], SEAMS.coreX), 'pec.R', 'chest.core'),
    ),
    node(plane([0, 1, 0], SEAMS.backSplit), 'back.upper', 'back.lower'),
  );
  const head = node(
    plane([0, 1, 0], SEAMS.faceSplitY),
    // z − faceSlope·y > faceZ − faceSlope·faceSplitY
    node(
      plane([0, -SEAMS.faceSlope, 1], SEAMS.faceZ - SEAMS.faceSlope * SEAMS.faceSplitY),
      'faceplate',
      'helmet',
    ),
    node(plane([0, 0, 1], SEAMS.jawZ), 'faceplate', 'helmet'),
  );
  // Above the collar only the skull is helmet — trapezius / shoulder tops
  // that rise past it stay on the chest and pauldrons.
  const collarSide = (side: 'L' | 'R'): CutTree =>
    node(
      plane(side === 'L' ? [1, 0, 0] : [-1, 0, 0], SEAMS.pauldronX),
      `pauldron.${side}`,
      chest,
    );
  return node(
    plane([0, 1, 0], SEAMS.collar),
    node(
      plane([1, 0, 0], SEAMS.headX),
      collarSide('L'),
      node(plane([-1, 0, 0], SEAMS.headX), collarSide('R'), head),
    ),
    node(
      plane([0, 1, 0], SEAMS.pauldronY),
      node(
        plane([1, 0, 0], SEAMS.pauldronX),
        'pauldron.L',
        node(plane([-1, 0, 0], SEAMS.pauldronX), 'pauldron.R', chest),
      ),
      node(
        plane([0, 1, 0], SEAMS.ribs),
        chest,
        node(
          plane([0, 1, 0], SEAMS.waist),
          fb(SEAMS.torsoZ, 'abdomen', 'back.lower'),
          node(plane([1, 0, 0], 0), pelvisTree('L'), pelvisTree('R')),
        ),
      ),
    ),
  );
}

export const CUT_TREES: Record<Limb, CutTree> = {
  core: coreTree(),
  'arm.L': armTree('L'),
  'arm.R': armTree('R'),
  'leg.L': legTree('L'),
  'leg.R': legTree('R'),
};

/** Which piece a single bind-space point falls in (no clipping). */
export function pieceAt(limb: Limb, p: Vec3): ArmorPieceId {
  let t = CUT_TREES[limb];
  while (typeof t !== 'string') {
    const f = t.plane.n[0] * p[0] + t.plane.n[1] * p[1] + t.plane.n[2] * p[2] - t.plane.d;
    t = f >= 0 ? t.pos : t.neg;
  }
  return t;
}

export interface CutInput {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  uvs: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Island id per vertex and limb per island (from the rig). */
  island: ArrayLike<number>;
  islandLimb: readonly Limb[];
  skinIndex: ArrayLike<number>;
  skinWeight: ArrayLike<number>;
  /**
   * Head bone index: a panel only joins the helmet / faceplate if it is
   * actually skinned to the head (keeps trapezius / collar flares off it).
   */
  headBone?: number;
  /** Skin weights for a new seam vertex (same island as its edge). */
  weightsAt: (
    x: number,
    y: number,
    z: number,
    island: number,
    outIndex: number[],
    outWeight: number[],
  ) => void;
}

export interface PieceBuffers {
  id: ArmorPieceId;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  indices: Uint32Array;
}

/**
 * A panel (plate between the model's own panel lines) goes whole to the
 * section holding at least this share of its area.
 */
export const PANEL_MAJORITY = 0.7;

/**
 * Cut the skinned body into {@link ARMOR_PIECES} along {@link CUT_TREES}.
 * Triangles that straddle a seam plane are clipped (Sutherland–Hodgman), so
 * every piece has a clean straight mechanical edge. Seam vertices are shared
 * between the two sides (cached per edge + plane) and skinned identically,
 * so the assembled pieces deform without cracks.
 */
export function cutArmor(input: CutInput): PieceBuffers[] {
  const P = input.positions;
  const N = input.normals;
  const U = input.uvs;
  const nOrig = P.length / 3;

  // Extra (seam) vertices appended after the originals
  const xPos: number[] = [];
  const xNrm: number[] = [];
  const xUv: number[] = [];
  const xIdx: number[] = [];
  const xW: number[] = [];
  const xIsland: number[] = [];
  const seamCache = new Map<string, number>();

  const px = (v: number) => (v < nOrig ? P[v * 3] : xPos[(v - nOrig) * 3]);
  const py = (v: number) => (v < nOrig ? P[v * 3 + 1] : xPos[(v - nOrig) * 3 + 1]);
  const pz = (v: number) => (v < nOrig ? P[v * 3 + 2] : xPos[(v - nOrig) * 3 + 2]);
  const attr = (v: number, orig: ArrayLike<number>, extra: number[], size: number, k: number) =>
    v < nOrig ? orig[v * size + k] : extra[(v - nOrig) * size + k];
  const islandOf = (v: number) => (v < nOrig ? input.island[v] : xIsland[v - nOrig]);

  const seamVertex = (a: number, b: number, planeId: number, cp: CutPlane): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}|${hi}|${planeId}`;
    const hit = seamCache.get(key);
    if (hit !== undefined) return hit;
    const fl = cp.n[0] * px(lo) + cp.n[1] * py(lo) + cp.n[2] * pz(lo) - cp.d;
    const fh = cp.n[0] * px(hi) + cp.n[1] * py(hi) + cp.n[2] * pz(hi) - cp.d;
    const t = fl / (fl - fh);
    const lerp = (x0: number, x1: number) => x0 + (x1 - x0) * t;
    const x = lerp(px(lo), px(hi));
    const y = lerp(py(lo), py(hi));
    const z = lerp(pz(lo), pz(hi));
    xPos.push(x, y, z);
    let nx = lerp(attr(lo, N, xNrm, 3, 0), attr(hi, N, xNrm, 3, 0));
    let ny = lerp(attr(lo, N, xNrm, 3, 1), attr(hi, N, xNrm, 3, 1));
    let nz = lerp(attr(lo, N, xNrm, 3, 2), attr(hi, N, xNrm, 3, 2));
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    xNrm.push(nx, ny, nz);
    xUv.push(lerp(attr(lo, U, xUv, 2, 0), attr(hi, U, xUv, 2, 0)), lerp(attr(lo, U, xUv, 2, 1), attr(hi, U, xUv, 2, 1)));
    const isl = islandOf(lo);
    xIsland.push(isl);
    const wi = [0, 0, 0, 0];
    const ww = [0, 0, 0, 0];
    input.weightsAt(x, y, z, isl, wi, ww);
    xIdx.push(...wi);
    xW.push(...ww);
    const id = nOrig + xIsland.length - 1;
    seamCache.set(key, id);
    return id;
  };

  const pieceIndex = new Map(ARMOR_PIECES.map((d, i) => [d.id, i] as const));
  const trisByPiece: number[][] = ARMOR_PIECES.map(() => []);
  const EPS = 1e-7;

  /** Panel being clipped is not head-skinned: helmet leaves go to the torso. */
  let rerouteHead = false;
  let clipLimb: Limb = 'core';
  const emit = (leaf: ArmorPieceId, poly: number[]) => {
    let piece = leaf;
    if (rerouteHead && (leaf === 'helmet' || leaf === 'faceplate')) {
      let cx = 0;
      let cz = 0;
      for (const v of poly) {
        cx += px(v);
        cz += pz(v);
      }
      piece = pieceAt(clipLimb, [cx / poly.length, SEAMS.collar - 0.01, cz / poly.length]);
    }
    const out = trisByPiece[pieceIndex.get(piece)!];
    for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
  };

  const classify = (poly: number[], tree: CutTree) => {
    if (poly.length < 3) return;
    if (typeof tree === 'string') {
      emit(tree, poly);
      return;
    }
    const cp = tree.plane;
    const f = poly.map((v) => cp.n[0] * px(v) + cp.n[1] * py(v) + cp.n[2] * pz(v) - cp.d);
    let anyPos = false;
    let anyNeg = false;
    for (const d of f) {
      if (d > EPS) anyPos = true;
      else if (d < -EPS) anyNeg = true;
    }
    if (!anyNeg) return classify(poly, tree.pos);
    if (!anyPos) return classify(poly, tree.neg);

    const pos: number[] = [];
    const neg: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = f[i];
      const db = f[(i + 1) % poly.length];
      if (da >= -EPS) pos.push(a);
      if (da <= EPS) neg.push(a);
      if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
        const s = seamVertex(a, b, tree.id, cp);
        pos.push(s);
        neg.push(s);
      }
    }
    classify(pos, tree.pos);
    classify(neg, tree.neg);
  };

  // Panels: connectivity over the raw index buffer. The model splits its
  // vertices at hard edges and UV seams, so these components are exactly
  // the plates between its modelled panel lines. A panel that sits mostly in
  // one section goes there whole (the cut follows the suit's own lines);
  // only panels genuinely shared between sections — big smooth shells —
  // are clipped on the section planes.
  const I = input.indices;
  const triCount = Math.floor(I.length / 3);
  const parent = new Int32Array(nOrig);
  for (let i = 0; i < nOrig; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let t = 0; t < triCount; t++) {
    const a = find(I[t * 3]);
    const b = find(I[t * 3 + 1]);
    const c = find(I[t * 3 + 2]);
    if (a !== b) parent[a] = b;
    const cb = find(c);
    const bb = find(b);
    if (cb !== bb) parent[cb] = bb;
  }
  const panels = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(I[t * 3]);
    let list = panels.get(r);
    if (!list) panels.set(r, (list = []));
    list.push(t);
  }

  const area = (a: number, b: number, c: number) => {
    const ux = px(b) - px(a);
    const uy = py(b) - py(a);
    const uz = pz(b) - pz(a);
    const vx = px(c) - px(a);
    const vy = py(c) - py(a);
    const vz = pz(c) - pz(a);
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const share = new Map<ArmorPieceId, number>();
  for (const tris of panels.values()) {
    share.clear();
    let total = 0;
    for (const t of tris) {
      const a = I[t * 3];
      const b = I[t * 3 + 1];
      const c = I[t * 3 + 2];
      const limb = input.islandLimb[input.island[a]];
      const id = pieceAt(limb, [
        (px(a) + px(b) + px(c)) / 3,
        (py(a) + py(b) + py(c)) / 3,
        (pz(a) + pz(b) + pz(c)) / 3,
      ]);
      const w = area(a, b, c);
      share.set(id, (share.get(id) ?? 0) + w);
      total += w;
    }
    let best: ArmorPieceId | null = null;
    let bestW = -1;
    for (const [id, w] of share) {
      if (w > bestW) {
        bestW = w;
        best = id;
      }
    }
    // The chin rides with the faceplate even though it blends into the neck
    {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const v = I[t * 3 + k];
          cx += px(v);
          cy += py(v);
          cz += pz(v);
        }
      }
      const m = tris.length * 3;
      if (Math.abs(cx / m) < SEAMS.chinX && cy / m > SEAMS.chinY && cy / m < SEAMS.faceSplitY && cz / m > SEAMS.chinZ) {
        const out = trisByPiece[pieceIndex.get('faceplate')!];
        for (const t of tris) out.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
        continue;
      }
    }
    // Only head-skinned panels may join the helmet / faceplate — neck and
    // trapezius flares that rise past the collar stay with the torso
    let headShare = 1;
    if (input.headBone !== undefined) {
      let head = 0;
      let n = 0;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const v = I[t * 3 + k];
          for (let j = 0; j < 4; j++) {
            if (input.skinIndex[v * 4 + j] === input.headBone) head += input.skinWeight[v * 4 + j];
          }
          n++;
        }
      }
      headShare = head / Math.max(1, n);
    }
    rerouteHead = headShare < 0.5;
    if (best && (best === 'helmet' || best === 'faceplate') && rerouteHead) {
      const a = I[tris[0] * 3];
      let cx = 0;
      let cz = 0;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          cx += px(I[t * 3 + k]);
          cz += pz(I[t * 3 + k]);
        }
      }
      const m = tris.length * 3;
      best = pieceAt(input.islandLimb[input.island[a]], [cx / m, SEAMS.collar - 0.01, cz / m]);
      bestW = total;
    }
    if (best && (share.size === 1 || bestW >= PANEL_MAJORITY * total)) {
      const out = trisByPiece[pieceIndex.get(best)!];
      for (const t of tris) out.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
      continue;
    }
    for (const t of tris) {
      const a = I[t * 3];
      clipLimb = input.islandLimb[input.island[a]];
      classify([a, I[t * 3 + 1], I[t * 3 + 2]], CUT_TREES[clipLimb]);
    }
  }

  // Compact per-piece buffers
  const out: PieceBuffers[] = [];
  ARMOR_PIECES.forEach((def, pi) => {
    const tris = trisByPiece[pi];
    if (tris.length === 0) return;
    const remap = new Map<number, number>();
    const order: number[] = [];
    const indices = new Uint32Array(tris.length);
    for (let k = 0; k < tris.length; k++) {
      const v = tris[k];
      let dst = remap.get(v);
      if (dst === undefined) {
        dst = order.length;
        remap.set(v, dst);
        order.push(v);
      }
      indices[k] = dst;
    }
    const n = order.length;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    const skinIndex = new Uint16Array(n * 4);
    const skinWeight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = order[i];
      for (let k = 0; k < 3; k++) {
        positions[i * 3 + k] = attr(v, P, xPos, 3, k);
        normals[i * 3 + k] = attr(v, N, xNrm, 3, k);
      }
      for (let k = 0; k < 2; k++) uvs[i * 2 + k] = attr(v, U, xUv, 2, k);
      for (let k = 0; k < 4; k++) {
        skinIndex[i * 4 + k] = attr(v, input.skinIndex, xIdx, 4, k);
        skinWeight[i * 4 + k] = attr(v, input.skinWeight, xW, 4, k);
      }
    }
    out.push({
      id: def.id,
      positions,
      normals,
      uvs,
      skinIndex,
      skinWeight,
      indices,
    });
  });
  return out;
}
