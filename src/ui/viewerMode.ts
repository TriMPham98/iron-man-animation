const STORAGE_KEY = 'mark-suit-director';

/**
 * Director mode shows timeline scrubber, plate pick, and active-piece readout.
 * Viewer mode is the clean portfolio surface.
 *
 * Enable via:
 *   - `?debug=1` / `?director=1` in the URL
 *   - `?debug=0` to force viewer even if localStorage prefers director
 *   - HUD DIR toggle (persists to localStorage)
 */
export function readDirectorPreference(): boolean {
  if (typeof window === 'undefined') return false;

  const params = new URLSearchParams(window.location.search);
  const debugParam = params.get('debug') ?? params.get('director');
  if (debugParam === '1' || debugParam === 'true') return true;
  if (debugParam === '0' || debugParam === 'false') return false;

  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeDirectorPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // private mode / blocked storage — ignore
  }
}

/** Prefer reduced motion: skip plate cascade, land on finished suit. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
