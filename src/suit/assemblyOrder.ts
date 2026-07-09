import type { ArmorPiece, PieceWave } from './createPieces';

/** Spine-distance weight — keep inside-out dominant. */
export const WEIGHT_RADIAL = 0.65;
/** Height / limb-axis weight — grow along the limb & soft bottom-up on core. */
export const WEIGHT_AXIS = 0.35;

export interface OrderPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Limb-like waves grow from joint → tip (proximal high Y → distal low Y).
 * Core waves use mild bottom→top as a secondary sweep.
 */
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
 * Hybrid assembly score — lower attaches first.
 *
 * score = wR * radialNorm + wY * axisNorm
 *
 * - radialNorm: 0 at spine, 1 at farthest piece in the set
 * - axisNorm (limbs): 0 at proximal (high Y), 1 at distal (low Y)
 * - axisNorm (core): 0 at bottom of band, 1 at top (soft bottom→top)
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
  if (isLimbWave(wave)) {
    // Proximal (high Y) first → low score; distal (low Y) later
    const yFromTop = (bounds.maxY - point.y) / yRange;
    axisNorm = clamp01(yFromTop);
  } else {
    // Core / helmet: mild bottom→top within the band
    axisNorm = clamp01((point.y - bounds.minY) / yRange);
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

/** Sort armor pieces in a single wave by hybrid spine + limb/height score. */
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

  return [...pieces].sort((a, b) => {
    const sa = assemblyScore(
      {
        x: a.restPosition.x,
        y: a.restPosition.y,
        z: a.restPosition.z,
      },
      wave,
      bounds,
    );
    const sb = assemblyScore(
      {
        x: b.restPosition.x,
        y: b.restPosition.y,
        z: b.restPosition.z,
      },
      wave,
      bounds,
    );
    if (Math.abs(sa - sb) > 1e-6) return sa - sb;
    // Stable-ish tie-break: left-to-right, then id
    if (Math.abs(a.restPosition.x - b.restPosition.x) > 1e-4) {
      return a.restPosition.x - b.restPosition.x;
    }
    return a.id.localeCompare(b.id);
  });
}
