/**
 * JARVIS telemetry cues for the cropped Binary Code Interface SFX.
 *
 * Crop window matches director seed v5 (`choreTimeline.seed.json`):
 *   start 12.075s on seed clock · cropIn 0 · cropOut 5.925
 *
 * Lines are Iron Man (2008) J.A.R.V.I.S. dialogue from the suit HUD /
 * power-up sequence (Paul Bettany), timed to mid-density chirp/beep
 * phrases. Final line holds through {@link SEQUENCE_SEED_DURATION}.
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
 * How long past {@link SEQUENCE_SEED_DURATION} to keep the final
 * “AT YOUR SERVICE, SIR” line (covers hero pad + soft ticker hide so the
 * bottom HUD never shows the J.A.R.V.I.S. tag with an empty line).
 */
export const BINARY_INTERFACE_FINAL_HOLD_PAD = 1.5;

/**
 * Mid-density phrase cues — technical HUD copy on chirp/beep onsets,
 * with two Iron Man (2008) J.A.R.V.I.S. anchors:
 *   “Importing preferences…” mid-stream
 *   “At your service, sir.” as the hold-to-end closer
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
    line: 'IMPORTING PREFERENCES…',
  },
  {
    t: 1.074,
    kind: 'beep',
    intensity: 'med',
    line: 'CALIBRATING VIRTUAL ENVIRONMENT',
  },

  // Pre-blip cluster
  {
    t: 1.76,
    kind: 'spark',
    intensity: 'med',
    line: 'TELEMETRY BURST…',
  },
  {
    t: 2.14,
    kind: 'chirp',
    intensity: 'soft',
    line: 'ROUTING POWER BUS…',
  },
  {
    t: 2.38,
    kind: 'beep',
    intensity: 'med',
    line: 'ACK // PACKET 0x2F',
  },

  /**
   * Seven audio blips seed 14.93–15.82 (crop 2.855–3.745).
   * Onsets from spectral-flux peaks on the BCI crop — one line per blip.
   */
  {
    t: 2.867,
    kind: 'chirp',
    intensity: 'med',
    line: 'SENSOR MESH SCAN…',
  },
  {
    t: 2.919,
    kind: 'chirp',
    intensity: 'soft',
    line: 'GYRO AXIS LOCK…',
  },
  {
    t: 3.015,
    kind: 'beep',
    intensity: 'med',
    line: 'INERTIAL REF — OK',
  },
  {
    t: 3.171,
    kind: 'chirp',
    intensity: 'med',
    line: 'HUD LAYERS COMPILED',
  },
  {
    t: 3.276,
    kind: 'chirp',
    intensity: 'med',
    line: 'OPTICS ALIGN…',
  },
  {
    t: 3.494,
    kind: 'beep',
    intensity: 'soft',
    line: 'TARGETING SUITE…',
  },
  {
    t: 3.627,
    kind: 'chirp',
    intensity: 'soft',
    line: 'SERVO MAP SYNC…',
  },

  // P5 — checksum beep cluster
  {
    t: 4.1,
    kind: 'beep',
    intensity: 'soft',
    line: 'FINAL CHECKSUM…',
  },
  {
    t: 4.3,
    kind: 'beep',
    intensity: 'soft',
    line: 'CHECKSUM — MATCH',
  },

  // P6 — close-out; final film line holds through sequence end
  {
    t: 4.92,
    kind: 'spark',
    intensity: 'soft',
    line: 'ALL CHANNELS GREEN',
  },
  {
    t: 5.16,
    kind: 'chirp',
    intensity: 'med',
    line: 'LINK STABLE',
  },
  {
    t: 5.35,
    kind: 'chirp',
    intensity: 'soft',
    line: 'AT YOUR SERVICE, SIR',
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
 * Silent before the BCI window. After the final JARVIS line fires, hold
 * “AT YOUR SERVICE, SIR” through sequence end plus
 * {@link BINARY_INTERFACE_FINAL_HOLD_PAD} so the ticker never empties early.
 */
export function cueAtSeedTime(seedSec: number): BinaryInterfaceCue | null {
  if (!Number.isFinite(seedSec)) return null;
  const { seedStart, cropIn } = BINARY_INTERFACE_CLIP;
  const into = seedSec - seedStart;
  if (into < -0.02) return null;

  // Final line rides out the hero tail / seed end (not just the audio crop).
  if (into >= FINAL_CUE.t) {
    const holdUntil =
      SEQUENCE_SEED_DURATION + BINARY_INTERFACE_FINAL_HOLD_PAD;
    if (seedSec > holdUntil) return null;
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
