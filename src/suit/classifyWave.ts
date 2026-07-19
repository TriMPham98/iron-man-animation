import type { PieceWave } from './waves';

/** Minimal point type so classifyWave stays pure (no THREE dependency). */
export interface WavePoint {
  x: number;
  y: number;
  z: number;
  /**
   * Max |world X| of the shard’s vertices when known. Distinguishes true arm
   * plates (extend outward) from thin waist-side hip flares whose centroid is
   * only slightly lateral (former arms#180 / #193 and L/R mirrors).
   */
  maxAbsX?: number;
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
 *   - hip side flare (not arms): y ≈ 1.04–1.35, |x| centroid ≈ 0.14–0.16,
 *     max|x| ≲ 0.23 (arms#180/#193 L+R); true arm neighbors max|x| ≳ 0.28
 *   - lateral chest (not arms): y ≈ 1.31–1.40, |x|≈0.16, max|x|≲0.19,
 *     front z ≳ 0.06 (former arms#251/#252)
 *   - upper sternum / reactor (not helmet): y ≈ 1.39–1.53, centerline,
 *     front z ≳ 0.09, yNorm just above 0.82 (former helmet#270)
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
  // Absolute meters — hands sit further from the spine than body thigh armor.
  // 0.245 catches outer hang / soft palm edge without stealing r≈0.22 body thighs.
  const HAND_RADIAL = 0.245;
  const ARM_Y_MIN = minY + yRange * 0.6; // ~1.05 — upper-arm band
  const SHOULDER_Y_MIN = minY + yRange * 0.78;
  const ax = Math.abs(c.x);
  // Prefer vertex laterality when the caller measured it; else centroid |x|.
  const laterality = c.maxAbsX ?? ax;
  const az = Math.abs(c.z);

  // ── Upper sternum / arc-reactor collar BEFORE helmet ──────────
  // Tall reactor housing parks its centroid at yNorm≈0.82 with front z≳0.09.
  // The old helmet gate (yNorm>0.82 && rNorm≤HEAD) swallowed former helmet#270.
  if (
    yNorm >= 0.75 &&
    yNorm <= 0.85 &&
    ax <= 0.12 &&
    c.z >= 0.08 &&
    rNorm < 0.45
  ) {
    return 'torso';
  }

  // ── Head ──────────────────────────────────────────────────────
  if (yNorm > 0.82 && rNorm <= HEAD_RNORM) return 'helmet';
  if (yNorm > 0.86) return 'helmet';

  // Feet
  if (yNorm < 0.1) return 'boots';

  // Lower legs
  if (yNorm < 0.28) return 'calves';

  // ── Hanging hands / gauntlets (before thigh catch-all) ────────
  // Beside outer thigh at hang pose — own wave so fingers assemble after
  // the arm stump (not one big “plop” with the arm cascade).
  if (yNorm >= 0.35 && yNorm < 0.58 && radial >= HAND_RADIAL) {
    return 'gauntlets';
  }
  // Strongly lateral hang-height only (true hand hang |x|≳0.25). Body outer
  // thigh is typically |x|≲0.22 at r≲0.24 — leave those as thighs.
  // (Finer palm fragments after hand refine are forced via handRegion flag.)
  if (
    yNorm >= 0.42 &&
    yNorm < 0.56 &&
    ax >= 0.25 &&
    radial >= 0.21
  ) {
    return 'gauntlets';
  }

  // ── Legs — body armor only (inside hand radial) ───────────────
  if (c.y < ARM_Y_MIN) {
    if (yNorm >= 0.48 && rNorm <= CORE_RNORM) return 'hips';
    return 'thighs';
  }

  // ── Hip side flare (waist module) — not free arms ─────────────
  // Thin medial side plates at hip→lower-rib height (former arms#180 / #193
  // and L/R mirrors). Centroid |x|≈0.15 clears the old arms gate (ax>0.14)
  // but vertices stay on the body (max|x|≲0.23). True arm neighbors at the
  // same band reach max|x|≳0.28. Keep these with the waist wave.
  if (
    yNorm >= 0.55 &&
    yNorm <= 0.72 &&
    ax >= 0.12 &&
    ax <= 0.175 &&
    radial < 0.19 &&
    laterality < 0.24
  ) {
    return 'hips';
  }

  // Soft torso core (abs / lower chest) before lateral arms
  if (yNorm < 0.72 && rNorm < 0.28) return 'torso';

  // Arc reactor / sternum / center chest (radial-based — works for shallow plates)
  if (yNorm >= 0.58 && yNorm <= 0.84 && rNorm < 0.40) return 'torso';

  // Front / back lower–mid chest including the reactor housing.
  // Chest protrusion inflates radial (hypot(x,z)) even on the centerline, so
  // rNorm alone mis-tags medial plates as arms (e.g. former arms#227:
  // |x|≈0.04, z≈0.18, y≈1.37 → lower chest under the reactor).
  // Gate on lateral |x| + front/back depth instead of rNorm.
  if (
    yNorm >= 0.55 &&
    yNorm <= 0.84 &&
    ax <= 0.13 &&
    az >= 0.06
  ) {
    return 'torso';
  }

  // Lateral chest / pec plates — on the body wall with front/back depth,
  // not free arms (former arms#251/#252: ax≈0.16, maxAbsX≈0.19, z≳0.06).
  // True upper-arm plates at this height reach max|x|≳0.22.
  if (
    yNorm >= 0.70 &&
    yNorm <= 0.82 &&
    ax >= 0.12 &&
    ax <= 0.18 &&
    laterality < 0.21 &&
    az >= 0.05
  ) {
    return 'torso';
  }

  // Upper arms — at/above ARM_Y_MIN, truly lateral (not front-chest radial).
  // Prefer vertex laterality so wide arm plates with a medial centroid still
  // count as arms; hip side flares were already caught above.
  if (
    c.y < SHOULDER_Y_MIN &&
    laterality > 0.14 &&
    rNorm > CORE_RNORM
  ) {
    return 'arms';
  }

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
