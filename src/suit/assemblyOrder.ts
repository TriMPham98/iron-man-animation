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

function distSq(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Structural seeds: where this wave connects to the already-built suit.
 * - Upward waves: lowest band (ankles → knees → hips → chest → crown)
 * - Downward limbs: highest band (shoulder → elbow → hand)
 * Bilateral waves also seed the opposite X side so L/R grow together.
 */
function pickSeeds(
  pieces: ArmorPiece[],
  wave: PieceWave,
  bounds: { minY: number; maxY: number; maxRadial: number },
): ArmorPiece[] {
  const scored = pieces
    .map((p) => ({
      piece: p,
      score: assemblyScore(
        {
          x: p.restPosition.x,
          y: p.restPosition.y,
          z: p.restPosition.z,
        },
        wave,
        bounds,
      ),
    }))
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1e-6) return a.score - b.score;
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

/**
 * Sort armor pieces so each plate attaches onto already-placed structure.
 *
 * 1. Seed at the wave’s connection root (bottom of core / proximal limb)
 * 2. Repeatedly attach the nearest remaining piece to the built set
 * 3. Tie-break with assemblyScore (axis-first, then spine)
 *
 * Macro wave order (legs → core → arms → helmet) stays in WAVE_ORDER.
 */
export function sortPiecesInWave(
  pieces: ArmorPiece[],
  wave: PieceWave,
): ArmorPiece[] {
  if (pieces.length <= 1) return pieces;

  const bounds = boundsFromPoints(
    pieces.map((p) => ({
      x: p.restPosition.x,
      y: p.restPosition.y,
      z: p.restPosition.z,
    })),
  );

  const remaining = new Set(pieces);
  const ordered: ArmorPiece[] = [];

  for (const seed of pickSeeds(pieces, wave, bounds)) {
    if (!remaining.has(seed)) continue;
    ordered.push(seed);
    remaining.delete(seed);
  }

  while (remaining.size > 0) {
    let best: ArmorPiece | null = null;
    let bestDist = Infinity;
    let bestTie = Infinity;
    let bestId = '';

    for (const candidate of remaining) {
      let minD = Infinity;
      for (const placed of ordered) {
        const d = distSq(candidate.restPosition, placed.restPosition);
        if (d < minD) minD = d;
      }

      const tie = assemblyScore(
        {
          x: candidate.restPosition.x,
          y: candidate.restPosition.y,
          z: candidate.restPosition.z,
        },
        wave,
        bounds,
      );

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

  return ordered;
}
