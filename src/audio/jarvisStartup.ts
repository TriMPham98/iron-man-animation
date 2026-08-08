/** JARVIS startup VO — one-shot on INITIATE (not the director timeline). */

export const JARVIS_STARTUP_FILE = 'jarvis-startup.mp3';

/** Engine voice id — transport stop/play must not kill this one-shot. */
export const JARVIS_STARTUP_VOICE_ID = 'jarvis-startup';

/**
 * Wall-clock length of `public/sounds/jarvis-startup.mp3` (ffprobe).
 * Keep in sync when the asset is replaced / re-faded.
 */
export const JARVIS_STARTUP_SEC = 1.254;

/**
 * Peak energy of the VO (~0.21s) — orb exit bright-pulse keyframe lands here.
 */
export const JARVIS_STARTUP_PEAK_SEC = 0.21;

/**
 * Orb / gate exit duration — same wall-clock as the VO so the shrink tracks
 * the (accelerated) blip-train decrescendo.
 */
export const JARVIS_STARTUP_EXIT_MS = Math.round(JARVIS_STARTUP_SEC * 1000);

/**
 * When assembly boots during the exit (after the bright pulse, early in the
 * continuous shrink — same ratio as the original 320/920 handoff).
 */
export const JARVIS_STARTUP_ASSEMBLY_AT_MS = Math.round(
  JARVIS_STARTUP_EXIT_MS * (320 / 920),
);
