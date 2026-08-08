/** JARVIS startup VO — one-shot on INITIATE (not the director timeline). */

export const JARVIS_STARTUP_FILE = 'jarvis-startup.mp3';

/** Engine voice id — transport stop/play must not kill this one-shot. */
export const JARVIS_STARTUP_VOICE_ID = 'jarvis-startup';

/**
 * Wall-clock length of `public/sounds/jarvis-startup.mp3` (ffprobe).
 * Keep in sync when the asset is replaced.
 */
export const JARVIS_STARTUP_SEC = 1.829;
