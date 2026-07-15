import type { ArmorPiece, PieceWave } from './createPieces';

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

/**
 * Schedule launch times so no plate flies before its structural parent
 * is mostly locked.
 *
 * - Seeds attach to the prior-wave foundation (ready at `foundationReady`)
 * - Opposite-side seeds may launch in parallel (both only need foundation)
 * - Later pieces wait until the nearest already-scheduled neighbor is
 *   ~PARENT_READY_FRAC through its travel
 */
export function planPieceStartTimes(
  ordered: ArmorPiece[],
  seedCount: number,
  opts: {
    waveStart: number;
    duration: number;
    foundationReady: number;
    foundationPts: OrderPoint[];
    minStagger: number;
    /** Fraction of parent travel that must complete before child launches. */
    parentReadyFrac?: number;
    /** Small continuous-motion lead (seconds). */
    childLead?: number;
  },
): number[] {
  const {
    waveStart,
    duration,
    foundationReady,
    foundationPts,
    minStagger,
    parentReadyFrac = 0.55,
    childLead = 0.05,
  } = opts;

  const starts: number[] = [];
  const n = ordered.length;
  if (n === 0) return starts;

  for (let i = 0; i < n; i++) {
    const piece = ordered[i];
    const pt = restPoint(piece);

    let readyAt = Math.max(waveStart, foundationReady);

    if (i < seedCount) {
      // Seeds only need the prior-wave stump — launch together (tiny stagger)
      readyAt = Math.max(waveStart, foundationReady);
      if (i > 0) {
        readyAt = Math.max(readyAt, starts[0] + Math.min(minStagger, 0.08));
      }
    } else {
      // Nearest already-scheduled piece in this wave
      let nearestJ = 0;
      let nearestD = Infinity;
      for (let j = 0; j < i; j++) {
        const d = distSq(pt, restPoint(ordered[j]));
        if (d < nearestD) {
          nearestD = d;
          nearestJ = j;
        }
      }

      const foundationD =
        foundationPts.length > 0
          ? minDistSqToSet(pt, foundationPts)
          : Infinity;

      // Prefer foundation if this plate is still closer to prior structure
      // than to anything placed this wave (second limb / chest flank).
      if (foundationPts.length > 0 && foundationD <= nearestD * 1.05) {
        readyAt = Math.max(waveStart, foundationReady);
      } else {
        const parentReady =
          starts[nearestJ] + duration * parentReadyFrac - childLead;
        readyAt = Math.max(waveStart, foundationReady, parentReady);
      }

      // Mild floor so we never launch before the previous slot by much
      const staggerFloor = starts[i - 1] + minStagger * 0.25;
      readyAt = Math.max(readyAt, staggerFloor);
    }

    starts.push(readyAt);
  }

  return starts;
}
