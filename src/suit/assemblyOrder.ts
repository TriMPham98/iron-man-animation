import { mirrorEulerYZ, mirrorStartAroundRest } from '../utils/easeHelpers';
import type { ArmorPiece, PieceWave } from './waves';

/** Spine-distance weight — used for seed / tie-break only. */
export const WEIGHT_RADIAL = 0.35;
/** Height / limb-axis weight — primary structural preference for seeds. */
export const WEIGHT_AXIS = 0.65;

export interface OrderPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Which already-built waves a new wave may clamp onto.
 *
 * Critical: arms seed only from shoulders (never thighs — same height band),
 * and helmet seeds from collar (shoulders + upper torso), never gauntlets.
 */
export const FOUNDATION_WAVES: Record<PieceWave, PieceWave[]> = {
  boots: [],
  calves: ['boots'],
  thighs: ['calves', 'boots'],
  hips: ['thighs', 'calves'],
  torso: ['hips', 'thighs'],
  shoulders: ['torso', 'hips'],
  arms: ['shoulders'],
  gauntlets: ['arms'],
  helmet: ['shoulders', 'torso'],
  power: ['torso', 'shoulders'],
};

/**
 * Lower body + core grow bottom → top (plant feet, stack plates upward).
 * Upper limbs grow proximal → distal (shoulder → hand).
 */
function growsUpward(wave: PieceWave): boolean {
  return (
    wave === 'boots' ||
    wave === 'calves' ||
    wave === 'thighs' ||
    wave === 'hips' ||
    wave === 'torso' ||
    wave === 'helmet' ||
    wave === 'power'
  );
}

function isLimbWave(wave: PieceWave): boolean {
  return (
    wave === 'shoulders' ||
    wave === 'arms' ||
    wave === 'gauntlets' ||
    wave === 'thighs' ||
    wave === 'calves' ||
    wave === 'boots'
  );
}

/** Extremities that must clamp onto a prior wave’s stump (wrist, shoulder…). */
function needsFoundation(wave: PieceWave): boolean {
  return FOUNDATION_WAVES[wave].length > 0;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Hybrid seed / tie-break score — lower prefers earlier.
 *
 * Not the sole attach order (see sortPiecesInWave neighbor growth).
 * - radialNorm: 0 at spine, 1 at farthest piece in the set
 * - axisNorm (upward waves): 0 at bottom, 1 at top
 * - axisNorm (downward limbs): 0 at proximal (high Y), 1 at distal (low Y)
 */
export function assemblyScore(
  point: OrderPoint,
  wave: PieceWave,
  bounds: {
    minY: number;
    maxY: number;
    maxRadial: number;
  },
  wR = WEIGHT_RADIAL,
  wY = WEIGHT_AXIS,
): number {
  const yRange = Math.max(1e-4, bounds.maxY - bounds.minY);
  const maxR = Math.max(1e-4, bounds.maxRadial);
  const radial = Math.hypot(point.x, point.z);
  const radialNorm = clamp01(radial / maxR);

  let axisNorm: number;
  if (growsUpward(wave)) {
    // Bottom first → stack onto hips / lower plates
    axisNorm = clamp01((point.y - bounds.minY) / yRange);
  } else {
    // Proximal (high Y) first → grow out the arm
    const yFromTop = (bounds.maxY - point.y) / yRange;
    axisNorm = clamp01(yFromTop);
  }

  return wR * radialNorm + wY * axisNorm;
}

export function boundsFromPoints(points: OrderPoint[]): {
  minY: number;
  maxY: number;
  maxRadial: number;
} {
  let minY = Infinity;
  let maxY = -Infinity;
  let maxRadial = 0;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    maxRadial = Math.max(maxRadial, Math.hypot(p.x, p.z));
  }
  if (!Number.isFinite(minY)) {
    return { minY: 0, maxY: 1, maxRadial: 1 };
  }
  return { minY, maxY, maxRadial: Math.max(maxRadial, 1e-4) };
}

export function distSq(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function minDistSqToSet(
  point: { x: number; y: number; z: number },
  set: OrderPoint[],
): number {
  let minD = Infinity;
  for (const f of set) {
    const d = distSq(point, f);
    if (d < minD) minD = d;
  }
  return minD;
}

export function restPoint(p: ArmorPiece): OrderPoint {
  return {
    x: p.restPosition.x,
    y: p.restPosition.y,
    z: p.restPosition.z,
  };
}

/**
 * Filter already-built pieces down to the structural stumps this wave
 * is allowed to grow from.
 */
export function selectFoundation(
  wave: PieceWave,
  built: ArmorPiece[],
): ArmorPiece[] {
  const allowed = new Set(FOUNDATION_WAVES[wave]);
  if (allowed.size === 0) return [];
  return built.filter((p) => allowed.has(p.wave));
}

/**
 * Structural seeds: where this wave connects to the already-built suit.
 *
 * When a foundation (prior waves) is provided, seed at the pieces nearest
 * that structure so hands clamp onto wrists, arms onto shoulders, etc.
 * Otherwise fall back to axis/radial score within the wave alone.
 */
function pickSeeds(
  pieces: ArmorPiece[],
  wave: PieceWave,
  bounds: { minY: number; maxY: number; maxRadial: number },
  foundation: OrderPoint[],
): ArmorPiece[] {
  const scored = pieces
    .map((p) => {
      const point = restPoint(p);
      const foundationDist =
        foundation.length > 0 ? minDistSqToSet(point, foundation) : 0;
      const axisScore = assemblyScore(point, wave, bounds);
      return { piece: p, foundationDist, axisScore };
    })
    .sort((a, b) => {
      // Prefer pieces that touch the already-built suit
      if (foundation.length > 0) {
        if (Math.abs(a.foundationDist - b.foundationDist) > 1e-8) {
          return a.foundationDist - b.foundationDist;
        }
      }
      if (Math.abs(a.axisScore - b.axisScore) > 1e-6) {
        return a.axisScore - b.axisScore;
      }
      return a.piece.id.localeCompare(b.piece.id);
    });

  const seeds: ArmorPiece[] = [scored[0].piece];

  // Second seed on the opposite side so paired limbs / chest flanks build together
  if (isLimbWave(wave) || wave === 'torso' || wave === 'hips') {
    const first = scored[0].piece;
    const firstSign = Math.sign(first.restPosition.x) || 1;
    const opposite = scored.find((s) => {
      const x = s.piece.restPosition.x;
      return (
        s.piece !== first &&
        Math.abs(x) > 0.04 &&
        Math.sign(x) === -firstSign
      );
    });
    if (opposite) seeds.push(opposite.piece);
  }

  return seeds;
}

export interface WaveOrderResult {
  ordered: ArmorPiece[];
  /** Number of structural seeds at the front of `ordered` (1 or 2). */
  seedCount: number;
}

/**
 * Sort armor pieces so each plate attaches onto already-placed structure.
 *
 * 1. Seed at the connection to prior waves (foundation) when available
 * 2. Repeatedly attach the nearest remaining piece to the built set
 * 3. Tie-break with assemblyScore (axis-first, then spine)
 *
 * Macro wave order (legs → core → arms → helmet) stays in WAVE_ORDER.
 *
 * @param foundation Rest positions (or pieces) already assembled from earlier waves
 */
export function sortPiecesInWave(
  pieces: ArmorPiece[],
  wave: PieceWave,
  foundation: OrderPoint[] | ArmorPiece[] = [],
): ArmorPiece[] {
  return planWaveOrder(pieces, wave, foundation).ordered;
}

/**
 * Same as sortPiecesInWave but also reports how many leading seeds were
 * chosen — used by the timeline so opposite limbs can launch in parallel
 * without waiting on each other.
 */
export function planWaveOrder(
  pieces: ArmorPiece[],
  wave: PieceWave,
  foundation: OrderPoint[] | ArmorPiece[] = [],
): WaveOrderResult {
  if (pieces.length <= 1) {
    return { ordered: pieces.slice(), seedCount: pieces.length };
  }

  const foundationPts: OrderPoint[] = foundation.map((f) =>
    'restPosition' in f ? restPoint(f as ArmorPiece) : (f as OrderPoint),
  );

  const bounds = boundsFromPoints(pieces.map(restPoint));

  const remaining = new Set(pieces);
  const ordered: ArmorPiece[] = [];

  // Virtual anchors: foundation points act as already-placed structure so
  // growth starts at the stump (wrist, shoulder, hip…) rather than floating.
  const useFoundation =
    foundationPts.length > 0 && needsFoundation(wave);

  const seeds = pickSeeds(
    pieces,
    wave,
    bounds,
    useFoundation ? foundationPts : [],
  );

  for (const seed of seeds) {
    if (!remaining.has(seed)) continue;
    ordered.push(seed);
    remaining.delete(seed);
  }
  const seedCount = ordered.length;

  while (remaining.size > 0) {
    let best: ArmorPiece | null = null;
    let bestDist = Infinity;
    let bestTie = Infinity;
    let bestId = '';

    for (const candidate of remaining) {
      // Distance to already-placed pieces in this wave…
      let minD = Infinity;
      for (const placed of ordered) {
        const d = distSq(candidate.restPosition, placed.restPosition);
        if (d < minD) minD = d;
      }
      // …and to the prior-wave foundation (hands → wrist/arm stump)
      if (useFoundation) {
        const fd = minDistSqToSet(candidate.restPosition, foundationPts);
        if (fd < minD) minD = fd;
      }

      const tie = assemblyScore(restPoint(candidate), wave, bounds);

      const closer = minD < bestDist - 1e-8;
      const sameDist = Math.abs(minD - bestDist) <= 1e-8;
      const betterTie = sameDist && tie < bestTie - 1e-8;
      const betterId =
        sameDist &&
        Math.abs(tie - bestTie) <= 1e-8 &&
        (best === null || candidate.id.localeCompare(bestId) < 0);

      if (best === null || closer || betterTie || betterId) {
        best = candidate;
        bestDist = minD;
        bestTie = tie;
        bestId = candidate.id;
      }
    }

    if (!best) break;
    ordered.push(best);
    remaining.delete(best);
  }

  // Torso: seat the sternum / arc-reactor plate last so the chest core
  // only lands once surrounding plates have something to clamp onto —
  // and so reactor ignition can wait on a fully complete torso.
  if (wave === 'torso' && ordered.length > 2) {
    let reactorIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i].restPosition;
      // Prefer front-center chest (low |x|, moderate y, positive z)
      const score =
        Math.hypot(p.x, Math.max(0, -p.z) * 0.5) * 2.2 +
        Math.abs(p.y - (bounds.minY + bounds.maxY) * 0.55) * 0.35 -
        p.z * 0.4;
      if (score < bestScore) {
        bestScore = score;
        reactorIdx = i;
      }
    }
    if (reactorIdx < ordered.length - 1) {
      const [reactorPiece] = ordered.splice(reactorIdx, 1);
      ordered.push(reactorPiece);
    }
  }

  return { ordered, seedCount };
}

/** On-spine plates (no L/R pair) — absolute X below this stays solo. */
const CENTERLINE_X = 0.05;
/**
 * Max match cost to accept a mirror pair.
 * Cost ≈ 2·Δ|x| + Δy + 0.5·Δz (meters).
 */
const MAX_PAIR_COST = 0.38;
/**
 * Dual-layer / stacked shells at the same socket (e.g. Object_2 + Object_3
 * head plates). If they launch on different beats, the first one seats alone
 * and reads as a floating fragment (former helmet#219 without #220).
 *
 * Kept tight and **non-transitive** (at most one partner) so the helmet
 * cascade does not collapse into one mega-group.
 */
const COLOCATED_DIST = 0.07;

/**
 * Nearest unused plate within `maxDist` of `anchor` (dual-layer shell mate).
 */
function findColocatedPartner(
  anchor: ArmorPiece,
  candidates: ArmorPiece[],
  used: Set<string>,
  maxDist = COLOCATED_DIST,
): ArmorPiece | null {
  const maxDistSq = maxDist * maxDist;
  let best: ArmorPiece | null = null;
  let bestD = maxDistSq;
  for (const q of candidates) {
    if (used.has(q.id) || q.id === anchor.id) continue;
    const d = anchor.restPosition.distanceToSquared(q.restPosition);
    if (d <= bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * Group plates in a wave for **paired L/R launches**.
 *
 * Each group is 1–4 pieces that should start at the same timeline time.
 * Group order is structural (assemblyScore: bottom→top or proximal→distal),
 * then greedily match each plate with its best opposite-side mirror.
 *
 * Centerline pieces (`|x|` small) launch alone, except on the helmet wave
 * where a co-located dual-layer shell is claimed so stacked meshes clamp
 * together (helmet#219 + #220).
 */
export function planSymmetricLaunchGroups(
  pieces: ArmorPiece[],
  wave: PieceWave,
): ArmorPiece[][] {
  if (pieces.length === 0) return [];
  if (pieces.length === 1) return [pieces.slice()];

  const bounds = boundsFromPoints(pieces.map(restPoint));
  const absorbDualLayer = wave === 'helmet';

  // Structural priority first so pairs march boots→thighs / shoulder→hand
  const priority = pieces.slice().sort((a, b) => {
    const sa = assemblyScore(restPoint(a), wave, bounds);
    const sb = assemblyScore(restPoint(b), wave, bounds);
    if (Math.abs(sa - sb) > 1e-6) return sa - sb;
    // Prefer outer |x| slightly later within same band so pairs form cleanly
    const dAbs =
      Math.abs(a.restPosition.x) - Math.abs(b.restPosition.x);
    if (Math.abs(dAbs) > 1e-6) return dAbs;
    return a.id.localeCompare(b.id);
  });

  const used = new Set<string>();
  const groups: ArmorPiece[][] = [];

  for (const p of priority) {
    if (used.has(p.id)) continue;
    used.add(p.id);

    const px = p.restPosition.x;
    if (Math.abs(px) < CENTERLINE_X) {
      const cluster: ArmorPiece[] = [p];
      if (absorbDualLayer) {
        const mate = findColocatedPartner(p, priority, used);
        if (mate) {
          used.add(mate.id);
          cluster.push(mate);
        }
      }
      groups.push(cluster);
      continue;
    }

    const pSign = Math.sign(px) || 1;
    let best: ArmorPiece | null = null;
    let bestCost = Infinity;

    for (const q of priority) {
      if (used.has(q.id)) continue;
      const qx = q.restPosition.x;
      if (Math.abs(qx) < CENTERLINE_X) continue;
      if ((Math.sign(qx) || 1) === pSign) continue;

      const cost =
        Math.abs(Math.abs(px) - Math.abs(qx)) * 2 +
        Math.abs(p.restPosition.y - q.restPosition.y) +
        Math.abs(p.restPosition.z - q.restPosition.z) * 0.5;

      if (cost < bestCost) {
        bestCost = cost;
        best = q;
      }
    }

    if (best && bestCost <= MAX_PAIR_COST) {
      used.add(best.id);
      // Stable within-group order (left then right) — same launch time either way
      const pair = [p, best].sort(
        (a, b) => a.restPosition.x - b.restPosition.x,
      );
      if (absorbDualLayer) {
        // Optional dual-layer mate for each side (Object_2 + Object_3 cheek, etc.)
        for (const side of [...pair]) {
          const mate = findColocatedPartner(side, priority, used);
          if (mate) {
            used.add(mate.id);
            pair.push(mate);
          }
        }
      }
      groups.push(pair);
    } else {
      const cluster: ArmorPiece[] = [p];
      if (absorbDualLayer) {
        const mate = findColocatedPartner(p, priority, used);
        if (mate) {
          used.add(mate.id);
          cluster.push(mate);
        }
      }
      groups.push(cluster);
    }
  }

  return groups;
}

/**
 * For each true L/R launch pair, copy the left plate’s scatter offset onto the
 * right (mirrored across YZ in rest-local space) so flight paths can be
 * geometric mirrors.
 *
 * Skips dual-layer co-located shells (same side / near-centerline) and groups
 * larger than 2 — those keep independent scatter.
 *
 * Mutates `startPosition` / `startRotation` and the live mesh pose.
 * Left = lower rest X (first in group after sort).
 */
export function applyMirroredFlightStarts(groups: ArmorPiece[][]): void {
  for (const group of groups) {
    if (group.length !== 2) continue;
    const [left, right] = group[0].restPosition.x <= group[1].restPosition.x
      ? group
      : [group[1], group[0]];

    // Must be opposite sides of the spine — dual-layer shells at the same
    // socket share a sign(x) and must not be mirrored into each other.
    const lx = left.restPosition.x;
    const rx = right.restPosition.x;
    if (Math.abs(lx) < CENTERLINE_X || Math.abs(rx) < CENTERLINE_X) continue;
    if ((Math.sign(lx) || 1) === (Math.sign(rx) || 1)) continue;

    const start = mirrorStartAroundRest(
      left.startPosition,
      left.restPosition,
      right.restPosition,
    );
    const rot = mirrorEulerYZ(left.startRotation);

    right.startPosition.copy(start);
    right.startRotation.copy(rot);
    right.mesh.position.copy(start);
    right.mesh.rotation.copy(rot);
  }
}
