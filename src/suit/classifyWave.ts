import type { PieceWave } from './waves';

/** Minimal point type so classifyWave stays pure (no THREE dependency). */
export interface WavePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Map a shard centroid to a body region for Mark III–style waves.
 *
 * This GLB’s centroid envelope is tight (radial ≈ 0–0.37m). Two different
 * things sit at similar heights near the hip:
 *   - body outer-thigh plates:  r ≲ 0.24 (on the leg surface)
 *   - hanging hands / gauntlets: r ≳ 0.26 (beside the thigh at rest)
 *
 * Using height alone folds hands into the thigh wave → they clamp early and
 * float with no arm stump. Using rNorm alone (relative to maxR ≈ outer hand)
 * folds outer thighs into arms. Split on **absolute radial** + height.
 *
 * Measured:
 *   - outer thigh body armor: y ≈ 0.85–1.05, r ≈ 0.15–0.24
 *   - hands at hang pose:     y ≈ 0.90–1.00, r ≈ 0.28–0.37
 *   - upper arms:             y ≈ 1.07–1.30, r ≈ 0.16–0.33
 *   - shoulders:              y ≈ 1.41–1.50
 *
 * Typical envelope used by loadSuitModel (for tests / callers):
 *   minY ≈ 0, yRange ≈ 1.85, maxRadial ≈ 0.37
 */
export function classifyWave(
  c: WavePoint,
  minY: number,
  yRange: number,
  maxRadial: number,
): PieceWave {
  const yNorm = (c.y - minY) / yRange;
  const radial = Math.hypot(c.x, c.z);
  const rNorm = radial / Math.max(maxRadial, 1e-4);

  // Soft torso / pelvis core (normalized)
  const CORE_RNORM = 0.22;
  // Skull narrower than pauldrons
  const HEAD_RNORM = 0.42;
  // Absolute meters — hands sit further from the spine than body thigh armor
  const HAND_RADIAL = 0.26;
  const ARM_Y_MIN = minY + yRange * 0.6; // ~1.05 — upper-arm band
  const SHOULDER_Y_MIN = minY + yRange * 0.78;

  // ── Head first ────────────────────────────────────────────────
  if (yNorm > 0.82 && rNorm <= HEAD_RNORM) return 'helmet';
  if (yNorm > 0.86) return 'helmet';

  // Feet
  if (yNorm < 0.1) return 'boots';

  // Lower legs
  if (yNorm < 0.28) return 'calves';

  // ── Hanging hands / gauntlets (before thigh catch-all) ────────
  // Rest beside the outer thigh but must ride the arm wave so they
  // only clamp after the shoulder→arm stump exists.
  if (yNorm >= 0.35 && yNorm < 0.6 && radial >= HAND_RADIAL) {
    return 'arms';
  }

  // ── Legs — body armor only (inside hand radial) ───────────────
  if (c.y < ARM_Y_MIN) {
    if (yNorm >= 0.48 && rNorm <= CORE_RNORM) return 'hips';
    return 'thighs';
  }

  // Soft torso core (abs / lower chest) before lateral arms
  if (yNorm < 0.72 && rNorm < 0.28) return 'torso';

  // Arc reactor / sternum / center chest
  if (yNorm >= 0.58 && yNorm <= 0.82 && rNorm < 0.36) return 'torso';

  // Upper arms — at/above ARM_Y_MIN, lateral of the torso core
  if (c.y < SHOULDER_Y_MIN && rNorm > CORE_RNORM) return 'arms';

  // Shoulders / pauldrons — high lateral collar
  if (yNorm >= 0.72 && yNorm <= 0.86 && rNorm > 0.35) return 'shoulders';

  // Chest / back / collar core
  if (yNorm >= 0.55 && yNorm <= 0.86) return 'torso';

  // Fallbacks
  if (c.y < ARM_Y_MIN) {
    return radial >= HAND_RADIAL ? 'arms' : 'thighs';
  }
  if (rNorm > 0.35) return 'arms';
  return 'torso';
}
