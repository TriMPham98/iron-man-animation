import { SUIT_GROUND_CLEARANCE } from '../suit/loadSuitModel';

/**
 * Shared clocks for the suit-up. Kept free of timeline/choreography imports so
 * both (and the BCI cue sheet) can depend on it without cycles.
 *
 * Two clocks:
 * - GSAP time — the timeline playhead, starts at 0 on the empty pad.
 * - Seed time — the director audio ruler (`choreTimeline.seed.json`).
 *   seed = gsap − {@link audioTimelineOffset}. The HUD timer reads seed time.
 */

/**
 * Hangar pre-roll before the first SFX: the fitting hologram materializes,
 * the rig raises its arms into the suit-up stance and the floor hatches open
 * while the boots start rising. Seed 0 lands {@link audioTimelineOffset}
 * seconds into the timeline.
 */
export const OPENING_HOLD = 1.18;

/**
 * Seed-clock time the hold maps to (historical: boots used to launch at
 * seed 0.2). audioSec = gsapTime − (OPENING_HOLD − AUDIO_SEED_ORIGIN).
 */
export const AUDIO_SEED_ORIGIN = 0.2;

/** Offset from GSAP time → seed/audio timeline seconds. */
export function audioTimelineOffset(): number {
  return Math.max(0, OPENING_HOLD - AUDIO_SEED_ORIGIN);
}

/**
 * Director-facing full sequence length (seed clock = HUD timer + audio ruler).
 * GSAP wall-clock end is this plus {@link audioTimelineOffset}.
 */
export const SEQUENCE_SEED_DURATION = 18.5;

/** GSAP end time that maps to {@link SEQUENCE_SEED_DURATION} on the seed clock. */
export function sequenceGsapDuration(): number {
  return SEQUENCE_SEED_DURATION + audioTimelineOffset();
}

/** Lift author camera heights by the suit's pad clearance. */
export const gy = (y: number): number => y + SUIT_GROUND_CLEARANCE;

/** Base cinematic FOV (matches createCamera). */
export const BASE_CAM_FOV = 34;

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  lx: number;
  ly: number;
  lz: number;
  fov: number;
}

/** Final hero framing after the faceplate pullback (held through the tail). */
export const HERO_END_CAM: Readonly<CameraPose> = {
  x: 1.15,
  y: gy(1.2),
  z: 3.35,
  lx: 0,
  ly: gy(0.95),
  lz: 0,
  fov: BASE_CAM_FOV,
};

/**
 * Hangar establish framing at sequence t=0 (wider than hero). The
 * post-showcase soft restart eases into this exact pose.
 */
export const OPEN_WIDE_CAM: Readonly<CameraPose> = {
  x: 2.15,
  y: gy(1.55),
  z: 4.85,
  lx: 0,
  ly: gy(0.88),
  lz: 0,
  fov: BASE_CAM_FOV + 3.5,
};
