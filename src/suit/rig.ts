/**
 * Procedural humanoid rig for the (unrigged) Mark III GLB.
 *
 * The source model is a static mesh, so the skeleton is authored here from
 * landmarks measured on the normalized suit (feet at y=0, facing +Z, 1.85 m).
 * Every bone has an identity rotation in the bind pose — bone-local axes are
 * the model axes — so bind-space vectors double as bone-local vectors.
 *
 * Side convention: `.L` is the suit's own left, which is +X (the suit faces +Z).
 */

export type Vec3 = readonly [number, number, number];

export const BONE_NAMES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'upperArm.L',
  'forearm.L',
  'hand.L',
  'upperArm.R',
  'forearm.R',
  'hand.R',
  'thigh.L',
  'shin.L',
  'foot.L',
  'thigh.R',
  'shin.R',
  'foot.R',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Which limb a vertex island belongs to (limits candidate bones). */
export type Limb = 'core' | 'arm.L' | 'arm.R' | 'leg.L' | 'leg.R';

export interface BoneSpec {
  name: BoneName;
  parent: BoneName | null;
  /** Joint position (bone origin) in bind space. */
  head: Vec3;
  /** End of the bone (child joint or tip) in bind space. */
  tail: Vec3;
  /**
   * Weighting capsule (segment + radius). Defaults to head→tail. Torso bones
   * use their own spans so the pelvis capsule reaches the crotch, etc.
   */
  capsule?: readonly [Vec3, Vec3];
  /** Capsule radius — vertices are weighted by distance to its surface. */
  radius: number;
  /** False for the floor-level root (never skinned). */
  deform: boolean;
}

const mirror = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

const LEFT_ARM: Omit<BoneSpec, 'name' | 'parent'>[] = [
  // upperArm.L — measured shoulder socket under the pauldron → elbow
  { head: [0.225, 1.465, -0.03], tail: [0.275, 1.265, -0.035], radius: 0.06, deform: true },
  // forearm.L — elbow → wrist (gauntlet cuff)
  { head: [0.275, 1.265, -0.035], tail: [0.375, 1.03, 0.02], radius: 0.055, deform: true },
  // hand.L — wrist → fingertips
  { head: [0.375, 1.03, 0.02], tail: [0.4, 0.84, 0.045], radius: 0.045, deform: true },
];

const LEFT_LEG: Omit<BoneSpec, 'name' | 'parent'>[] = [
  { head: [0.1, 0.89, 0.0], tail: [0.14, 0.51, -0.02], radius: 0.09, deform: true },
  { head: [0.14, 0.51, -0.02], tail: [0.155, 0.1, -0.03], radius: 0.07, deform: true },
  {
    head: [0.155, 0.1, -0.03],
    tail: [0.165, 0.03, 0.16],
    capsule: [
      [0.155, 0.07, -0.07],
      [0.165, 0.04, 0.14],
    ],
    radius: 0.06,
    deform: true,
  },
];

function limbChain(
  side: 'L' | 'R',
  names: readonly [BoneName, BoneName, BoneName],
  parent: BoneName,
  specs: Omit<BoneSpec, 'name' | 'parent'>[],
): BoneSpec[] {
  return specs.map((s, i) => {
    const flip = side === 'R';
    return {
      ...s,
      head: flip ? mirror(s.head) : s.head,
      tail: flip ? mirror(s.tail) : s.tail,
      capsule: s.capsule
        ? flip
          ? [mirror(s.capsule[0]), mirror(s.capsule[1])]
          : s.capsule
        : undefined,
      name: names[i],
      parent: i === 0 ? parent : names[i - 1],
    };
  });
}

export const BONE_SPECS: readonly BoneSpec[] = [
  { name: 'root', parent: null, head: [0, 0, 0], tail: [0, 0.98, 0], radius: 0, deform: false },
  {
    name: 'hips',
    parent: 'root',
    head: [0, 0.98, 0],
    tail: [0, 1.1, -0.01],
    capsule: [
      [0, 0.86, 0],
      [0, 1.03, 0],
    ],
    radius: 0.14,
    deform: true,
  },
  {
    name: 'spine',
    parent: 'hips',
    head: [0, 1.1, -0.01],
    tail: [0, 1.3, -0.01],
    capsule: [
      [0, 1.07, -0.01],
      [0, 1.24, -0.01],
    ],
    radius: 0.15,
    deform: true,
  },
  {
    name: 'chest',
    parent: 'spine',
    head: [0, 1.3, -0.01],
    tail: [0, 1.555, -0.02],
    capsule: [
      [0, 1.29, -0.01],
      [0, 1.5, -0.02],
    ],
    radius: 0.17,
    deform: true,
  },
  { name: 'neck', parent: 'chest', head: [0, 1.555, -0.02], tail: [0, 1.635, -0.015], radius: 0.065, deform: true },
  {
    name: 'head',
    parent: 'neck',
    head: [0, 1.635, -0.015],
    tail: [0, 1.85, 0],
    capsule: [
      [0, 1.69, 0.0],
      [0, 1.78, 0.0],
    ],
    radius: 0.1,
    deform: true,
  },
  ...limbChain('L', ['upperArm.L', 'forearm.L', 'hand.L'], 'chest', LEFT_ARM),
  ...limbChain('R', ['upperArm.R', 'forearm.R', 'hand.R'], 'chest', LEFT_ARM),
  ...limbChain('L', ['thigh.L', 'shin.L', 'foot.L'], 'hips', LEFT_LEG),
  ...limbChain('R', ['thigh.R', 'shin.R', 'foot.R'], 'hips', LEFT_LEG),
];

const SPEC_BY_NAME = new Map(BONE_SPECS.map((s) => [s.name, s] as const));

export function boneSpec(name: BoneName): BoneSpec {
  const s = SPEC_BY_NAME.get(name);
  if (!s) throw new Error(`Unknown bone ${name}`);
  return s;
}

export function boneIndex(name: BoneName): number {
  return BONE_NAMES.indexOf(name);
}

/** Unit vector along a bone (head → tail) in bind space. */
export function boneAxis(name: BoneName): Vec3 {
  const { head, tail } = boneSpec(name);
  const d: [number, number, number] = [
    tail[0] - head[0],
    tail[1] - head[1],
    tail[2] - head[2],
  ];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / len, d[1] / len, d[2] / len];
}

/** Candidate bones per limb. Torso candidates gain arm/leg roots by region. */
const LIMB_BONES: Record<Limb, BoneName[]> = {
  core: ['hips', 'spine', 'chest', 'neck', 'head'],
  'arm.L': ['chest', 'upperArm.L', 'forearm.L', 'hand.L'],
  'arm.R': ['chest', 'upperArm.R', 'forearm.R', 'hand.R'],
  'leg.L': ['hips', 'thigh.L', 'shin.L', 'foot.L'],
  'leg.R': ['hips', 'thigh.R', 'shin.R', 'foot.R'],
};

/**
 * Classify a connected island by its centroid. Arms hang clear of the torso
 * below the armpit (≈1.42 m), legs separate below the crotch (≈0.8 m).
 */
export function classifyIslandLimb(c: Vec3): Limb {
  const [x, y] = c;
  const side = x >= 0 ? 'L' : 'R';
  if (y < 0.8 && Math.abs(x) > 0.02) return `leg.${side}`;
  if (Math.abs(x) > 0.2 && y >= 0.78 && y < 1.42) return `arm.${side}`;
  return 'core';
}

function candidatesFor(limb: Limb, x: number, y: number): BoneName[] {
  const base = LIMB_BONES[limb];
  if (limb !== 'core') return base;
  const side = x >= 0 ? 'L' : 'R';
  const out = base.slice();
  // Shoulder caps / deltoids live on torso islands but must ride the arm
  if (y > 1.3 && Math.abs(x) > 0.14) out.push(`upperArm.${side}`);
  // Hip crease / groin plates blend into the thigh
  if (y < 0.98 && Math.abs(x) > 0.02) out.push(`thigh.${side}`);
  return out;
}

/** Signed distance from p to a bone's capsule surface. */
export function capsuleDistance(
  px: number,
  py: number,
  pz: number,
  spec: BoneSpec,
): number {
  const [a, b] = spec.capsule ?? [spec.head, spec.tail];
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = px - a[0];
  const apy = py - a[1];
  const apz = pz - a[2];
  const len2 = abx * abx + aby * aby + abz * abz || 1e-9;
  let t = (apx * abx + apy * aby + apz * abz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.hypot(dx, dy, dz) - spec.radius;
}

/**
 * Welded connectivity islands. Non-shared duplicates at UV seams are merged
 * by quantized position so one armor plate is one island.
 */
export function computeIslands(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  weld = 1e-4,
): Int32Array {
  const n = positions.length / 3;
  const rep = new Int32Array(n);
  const byKey = new Map<number, number>();
  const q = 1 / weld;
  for (let i = 0; i < n; i++) {
    const ix = Math.round(positions[i * 3] * q) + 50000;
    const iy = Math.round(positions[i * 3 + 1] * q) + 50000;
    const iz = Math.round(positions[i * 3 + 2] * q) + 50000;
    const key = (ix * 100003 + iy) * 100003 + iz;
    const prev = byKey.get(key);
    if (prev === undefined) {
      byKey.set(key, i);
      rep[i] = i;
    } else {
      rep[i] = prev;
    }
  }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = rep[indices[t]];
    union(a, rep[indices[t + 1]]);
    union(a, rep[indices[t + 2]]);
  }

  const ids = new Map<number, number>();
  const island = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(rep[i]);
    let id = ids.get(r);
    if (id === undefined) {
      id = ids.size;
      ids.set(r, id);
    }
    island[i] = id;
  }
  return island;
}

export interface SkinWeightOptions {
  /** Softmin temperature (m) — larger blends joints over a wider band. */
  softness?: number;
  /** Fraction of an island on one bone before it is snapped rigid. */
  rigidIslandFraction?: number;
  /** Weld tolerance (m) for split-normal / UV-seam duplicates. */
  weld?: number;
}

const DEFAULT_SOFTNESS = 0.016;

/**
 * Softmin skin weights at a point for the bones its limb may use.
 * Writes 4 bone indices + normalized weights; returns the dominant bone.
 */
export function skinWeightsAt(
  x: number,
  y: number,
  z: number,
  limb: Limb,
  outIndex: Uint16Array | number[],
  outWeight: Float32Array | number[],
  offset = 0,
  softness = DEFAULT_SOFTNESS,
): number {
  const names = candidatesFor(limb, x, y);
  const cand: number[] = [];
  const dist: number[] = [];
  let dMin = Infinity;
  for (const name of names) {
    const d = capsuleDistance(x, y, z, boneSpec(name));
    cand.push(boneIndex(name));
    dist.push(d);
    if (d < dMin) dMin = d;
  }
  const order = cand.map((_, k) => k).sort((a, b) => dist[a] - dist[b]);
  const top = Math.min(4, order.length);
  const w = [0, 0, 0, 0];
  let total = 0;
  for (let k = 0; k < top; k++) {
    const wk = Math.exp(-(dist[order[k]] - dMin) / softness);
    w[k] = wk < 0.02 ? 0 : wk;
    total += w[k];
  }
  for (let k = 0; k < 4; k++) {
    if (k < top && w[k] > 0) {
      outIndex[offset + k] = cand[order[k]];
      outWeight[offset + k] = w[k] / total;
    } else {
      outIndex[offset + k] = 0;
      outWeight[offset + k] = 0;
    }
  }
  return cand[order[0]];
}

export interface SkinRig {
  /** Welded connectivity island id per vertex. */
  island: Int32Array;
  /** Limb class per island. */
  islandLimb: Limb[];
  /** Bone index an island is snapped to, or −1 when it blends. */
  islandBone: Int32Array;
  /** 4 bone indices per vertex (into {@link BONE_NAMES}). */
  skinIndex: Uint16Array;
  /** 4 normalized weights per vertex. */
  skinWeight: Float32Array;
  /** Highest-weight bone per vertex. */
  dominant: Uint8Array;
}

/**
 * Auto-skin the suit to {@link BONE_SPECS}.
 *
 * 1. Islands are classified into a limb (arm / leg / core) so a hanging arm
 *    never binds to the torso it nearly touches.
 * 2. Each vertex blends its nearest candidate capsules with a softmin.
 * 3. Islands that sit ≥ `rigidIslandFraction` on one bone are snapped rigid —
 *    armor plates stay hard and slide over each other at the joints, while
 *    shells that span a joint keep their smooth blend.
 */
export function computeSkinWeights(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  opts: SkinWeightOptions = {},
): SkinRig {
  const softness = opts.softness ?? DEFAULT_SOFTNESS;
  const rigidFraction = opts.rigidIslandFraction ?? 0.85;
  const n = positions.length / 3;

  const island = computeIslands(positions, indices, opts.weld ?? 1e-4);
  let islandCount = 0;
  for (let i = 0; i < n; i++) islandCount = Math.max(islandCount, island[i] + 1);

  // Island centroids → limb
  const sum = new Float64Array(islandCount * 3);
  const count = new Int32Array(islandCount);
  for (let i = 0; i < n; i++) {
    const id = island[i];
    sum[id * 3] += positions[i * 3];
    sum[id * 3 + 1] += positions[i * 3 + 1];
    sum[id * 3 + 2] += positions[i * 3 + 2];
    count[id]++;
  }
  const islandLimb: Limb[] = new Array(islandCount);
  for (let id = 0; id < islandCount; id++) {
    const c = Math.max(1, count[id]);
    islandLimb[id] = classifyIslandLimb([
      sum[id * 3] / c,
      sum[id * 3 + 1] / c,
      sum[id * 3 + 2] / c,
    ]);
  }

  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const dominant = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    dominant[i] = skinWeightsAt(
      positions[i * 3],
      positions[i * 3 + 1],
      positions[i * 3 + 2],
      islandLimb[island[i]],
      skinIndex,
      skinWeight,
      i * 4,
      softness,
    );
  }

  // Snap mostly-single-bone islands rigid
  const votes = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i++) {
    let m = votes.get(island[i]);
    if (!m) {
      m = new Map();
      votes.set(island[i], m);
    }
    m.set(dominant[i], (m.get(dominant[i]) ?? 0) + 1);
  }
  const islandBone = new Int32Array(islandCount).fill(-1);
  for (const [id, m] of votes) {
    let best = -1;
    let bestN = 0;
    for (const [bone, c] of m) {
      if (c > bestN) {
        bestN = c;
        best = bone;
      }
    }
    if (bestN / Math.max(1, count[id]) >= rigidFraction) islandBone[id] = best;
  }
  for (let i = 0; i < n; i++) {
    const b = islandBone[island[i]];
    if (b < 0) continue;
    skinIndex[i * 4] = b;
    skinWeight[i * 4] = 1;
    for (let k = 1; k < 4; k++) {
      skinIndex[i * 4 + k] = 0;
      skinWeight[i * 4 + k] = 0;
    }
    dominant[i] = b;
  }

  return { island, islandLimb, islandBone, skinIndex, skinWeight, dominant };
}
