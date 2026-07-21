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
 *   - upper reactor collar / upper chest (not helmet) — absolute Y required
 *     when the skull raises maxY and yNorm climbs past 0.85:
 *     · centerline sternum top z≈0.04–0.14 (former helmet#216 / #218 / #241)
 *     · front upper pec z≈0.10, |x|≈0.12 (former helmet#335)
 *     · lateral collar / trap low |z| (former helmet#336 / #343)
 *     · shoulder-pad lobes split off welded faceplate (former helmet#333 pads)
 *   - high pauldron / shoulder pads (not helmet) — absolute Y before
 *     yNorm>0.86 blanket helmet when the skull raises maxY:
 *     · outer stack max|x|≳0.20 (former #392–#393, #409, #438–#439, #449, #395)
 *     · mid-lateral pads max|x|≳0.14 (former #318, #364, #376, #299, #371)
 *     · high back-lateral trap y≈1.64 (former #405)
 *     · near-centerline wide collar y≈1.60 (former #244, #254)
 *     · high mid-collar trap y≈1.61, ax≈0.10, max|x|≈0.15 (former #315)
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

  // ── Upper chest / reactor collar (absolute Y) ─────────────────
  // High-tier former helmet plates when skull maxY inflates yNorm past 0.85.
  // Keep true faceplate / skull (y≳1.66 centerline, or high mid-face) as helmet.
  if (c.y >= 1.52 && c.y <= 1.66) {
    // Centerline upper chest / reactor top (#216, #218, #241)
    if (ax <= 0.05 && c.z >= 0.035 && c.z <= 0.15 && c.y <= 1.58) {
      return 'torso';
    }
    // Front upper pec / collar pad (#335, true #333 chest-pad fragments).
    // y ceiling 1.61 — higher lobes (e.g. former torso#311 at y≈1.622) are
    // mid-face / helmet, not upper chest.
    if (
      ax >= 0.08 &&
      ax <= 0.14 &&
      c.z >= 0.05 &&
      c.z <= 0.12 &&
      c.y <= 1.61 &&
      laterality < 0.2 &&
      radial < 0.18
    ) {
      return 'torso';
    }
    // Lateral collar / trap side plates (#336, #343, L/R mirrors) — low |z|
    if (
      ax >= 0.1 &&
      ax <= 0.16 &&
      az <= 0.08 &&
      laterality < 0.2 &&
      radial < 0.19
    ) {
      return 'torso';
    }
  }

  // ── High pauldron / shoulder pads BEFORE blanket helmet ───────
  // Outer pauldron stack — wide laterality at collar height
  // (#392–#393, #409, #395, #438–#439, #449 and L/R mirrors).
  if (
    c.y >= 1.46 &&
    c.y <= 1.62 &&
    laterality >= 0.2 &&
    ax >= 0.14 &&
    ax <= 0.35
  ) {
    return 'shoulders';
  }

  // Mid-lateral pads / trap plates — tighter max|x| than outer stack
  // (#318, #364, #376, #299, #371 and mirrors). Front, side, or back.
  if (
    c.y >= 1.46 &&
    c.y <= 1.58 &&
    ax >= 0.135 &&
    ax <= 0.22 &&
    laterality >= 0.14 &&
    laterality < 0.22 &&
    (az <= 0.11 || c.z < 0)
  ) {
    return 'shoulders';
  }

  // High back-lateral trap / rear pauldron (#405 and L/R mirror)
  if (
    c.y >= 1.62 &&
    c.y <= 1.66 &&
    ax >= 0.1 &&
    ax <= 0.15 &&
    laterality >= 0.13 &&
    laterality < 0.18 &&
    c.z <= -0.05 &&
    c.z >= -0.12 &&
    radial >= 0.12 &&
    radial <= 0.18
  ) {
    return 'shoulders';
  }

  // Near-centerline wide collar span (#244, #254) — spans both shoulders.
  // Slight |x| offset allowed; true faceplate is taller (y≳1.65) or narrower.
  if (
    c.y >= 1.58 &&
    c.y <= 1.62 &&
    ax <= 0.04 &&
    c.z >= 0.06 &&
    c.z <= 0.1 &&
    laterality >= 0.12 &&
    laterality <= 0.16
  ) {
    return 'shoulders';
  }

  // High mid-collar / trap pad (#315) — y≈1.61, maxAbsX≈0.15, slightly more
  // medial than lateral collar torso (ax≥0.10). Front-biased; not back trap.
  if (
    c.y >= 1.59 &&
    c.y <= 1.64 &&
    ax >= 0.09 &&
    ax < 0.11 &&
    laterality >= 0.13 &&
    laterality <= 0.16 &&
    az <= 0.08 &&
    c.z >= 0.02
  ) {
    return 'shoulders';
  }

  // Neck / upper-chest collar peeled from cranial shell (helmet#220 chest half).
  // Centroid often near centerline with wide maxAbsX and low |z|; crown sits higher.
  if (
    c.y >= 1.6 &&
    c.y <= 1.64 &&
    ax <= 0.08 &&
    az <= 0.06 &&
    laterality >= 0.1 &&
    laterality <= 0.18
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
