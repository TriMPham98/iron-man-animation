/**
 * JARVIS telemetry cues for the cropped Binary Code Interface SFX.
 *
 * Crop window matches director seed v5 (`choreTimeline.seed.json`):
 *   start 12.075s on seed clock · cropIn 0 · cropOut 5.925
 *
 * Density sits between full onset spam and one-line-per-phrase: a couple
 * of beats per sonic cluster (beep / chirp / spark). Final line holds
 * through {@link SEQUENCE_SEED_DURATION}.
 */

import { SEQUENCE_SEED_DURATION } from '../animation/assemblyTimeline';

export type BinaryCueKind = 'beep' | 'chirp' | 'spark' | 'tick';
export type BinaryCueIntensity = 'soft' | 'med' | 'strong';

export interface BinaryInterfaceCue {
  /** Seconds into the cropped source window (cropIn = 0). */
  t: number;
  kind: BinaryCueKind;
  intensity: BinaryCueIntensity;
  /** JARVIS HUD line shown when this onset is active. */
  line: string;
}

/**
 * Placement of the Binary Code Interface clip on the seed/audio clock.
 * Keep in sync with `choreTimeline.seed.json` clip-seed-v5-17.
 */
export const BINARY_INTERFACE_CLIP = {
  soundId: 'binary-code-interface',
  /** Seed-clock start (seconds). */
  seedStart: 12.075,
  cropIn: 0,
  cropOut: 5.925,
} as const;

/** Crop duration in seconds. */
export const BINARY_INTERFACE_DURATION =
  BINARY_INTERFACE_CLIP.cropOut - BINARY_INTERFACE_CLIP.cropIn;

/**
 * Mid-density phrase cues — ~2 lines per major beep/chirp/spark cluster.
 * Soft micro-ticks inside a run are skipped so text can land.
 */
export const BINARY_INTERFACE_CUES: readonly BinaryInterfaceCue[] = [
  // P1 — opening beep triad
  {
    t: 0.099,
    kind: 'beep',
    intensity: 'med',
    line: 'UPLINK ESTABLISHED…',
  },
  {
    t: 0.255,
    kind: 'beep',
    intensity: 'soft',
    line: 'HANDSHAKE // 3-PULSE',
  },

  // P2 — chirp ladder → ack beep
  {
    t: 0.65,
    kind: 'chirp',
    intensity: 'med',
    line: 'DECODING PROTOCOL…',
  },
  {
    t: 0.917,
    kind: 'chirp',
    intensity: 'med',
    line: 'BINARY STREAM ACTIVE',
  },
  {
    t: 1.074,
    kind: 'beep',
    intensity: 'med',
    line: 'HANDSHAKE ACK — OK',
  },

  // P3 — spark open + dense data chirps + close beep
  {
    t: 1.834,
    kind: 'spark',
    intensity: 'med',
    line: 'TELEMETRY BURST…',
  },
  {
    t: 2.223,
    kind: 'chirp',
    intensity: 'soft',
    line: 'ROUTING POWER BUS…',
  },
  {
    t: 2.473,
    kind: 'beep',
    intensity: 'med',
    line: 'ACK // PACKET 0x2F',
  },

  // P4 — mid-tail cal chatter
  {
    t: 2.879,
    kind: 'chirp',
    intensity: 'soft',
    line: 'SENSOR MESH SCAN…',
  },
  {
    t: 3.164,
    kind: 'beep',
    intensity: 'soft',
    line: 'GYRO CALIBRATING…',
  },
  {
    t: 3.518,
    kind: 'chirp',
    intensity: 'soft',
    line: 'HUD LAYERS COMPILED',
  },

  // P5 — checksum beep cluster
  {
    t: 4.22,
    kind: 'beep',
    intensity: 'soft',
    line: 'FINAL CHECKSUM…',
  },
  {
    t: 4.423,
    kind: 'beep',
    intensity: 'soft',
    line: 'CHECKSUM — MATCH',
  },

  // P6 — close-out; final line holds through sequence end
  {
    t: 5.027,
    kind: 'spark',
    intensity: 'soft',
    line: 'ALL CHANNELS GREEN',
  },
  {
    t: 5.277,
    kind: 'chirp',
    intensity: 'med',
    line: 'J.A.R.V.I.S. LINK STABLE',
  },
  {
    t: 5.445,
    kind: 'chirp',
    intensity: 'soft',
    line: 'AWAITING ORDERS, SIR',
  },
] as const;

/** Sorted ascending by `t` (source order already is). */
const CUES_SORTED = BINARY_INTERFACE_CUES;

const FINAL_CUE = CUES_SORTED[CUES_SORTED.length - 1]!;

/**
 * Latest cue whose onset is ≤ crop-relative time, or null before the first hit.
 * After the final cue, holds that line for the rest of the crop window.
 */
export function cueAtCropTime(cropT: number): BinaryInterfaceCue | null {
  if (!Number.isFinite(cropT) || cropT < 0) return null;
  // Past final onset: hold that line (seed-time path uses a wider hold).
  if (cropT >= FINAL_CUE.t) return FINAL_CUE;

  let found: BinaryInterfaceCue | null = null;
  for (const c of CUES_SORTED) {
    if (c.t <= cropT + 1e-4) found = c;
    else break;
  }
  return found;
}

/**
 * Map seed-clock seconds → active cue.
 * Silent before the BCI window. After “AWAITING ORDERS, SIR” fires, hold
 * that line through {@link SEQUENCE_SEED_DURATION} (end of the animation).
 */
export function cueAtSeedTime(seedSec: number): BinaryInterfaceCue | null {
  if (!Number.isFinite(seedSec)) return null;
  const { seedStart, cropIn } = BINARY_INTERFACE_CLIP;
  const into = seedSec - seedStart;
  if (into < -0.02) return null;

  // Final line rides out the hero tail / seed end (not just the audio crop).
  if (into >= FINAL_CUE.t) {
    if (seedSec > SEQUENCE_SEED_DURATION + 0.05) return null;
    return FINAL_CUE;
  }

  if (into > BINARY_INTERFACE_DURATION + 0.08) return null;
  return cueAtCropTime(into + cropIn);
}

/** 0–1 progress through the BCI crop at a seed time (clamped). */
export function binaryInterfaceProgress(seedSec: number): number {
  const into = seedSec - BINARY_INTERFACE_CLIP.seedStart;
  if (into <= 0) return 0;
  if (into >= BINARY_INTERFACE_DURATION) return 1;
  return into / BINARY_INTERFACE_DURATION;
}
