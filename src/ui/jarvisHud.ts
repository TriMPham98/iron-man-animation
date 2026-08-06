import { WAVE_ORDER, type PieceWave } from '../suit/waves';

/** Max visible lines in the compact ephemeral log. */
export const JARVIS_LOG_CAP = 2;

/**
 * Hold on SYSTEMS ONLINE flourish before the panel starts leaving (ms).
 * Keep long enough for the cyan complete pulse to read, short enough to
 * clear the top bar before the showcase spin settles.
 */
export const JARVIS_DISMISS_MS = 1800;

/** Match `.jarvis-panel.is-leaving` collapse duration (ms). */
export const JARVIS_LEAVE_MS = 520;

/**
 * True only for the final suit-complete status line.
 * Intermediate beats like "ARC REACTOR ONLINE", "REPULSORS ONLINE",
 * "J.A.R.V.I.S. ONLINE", and the power-wave "SYSTEMS ONLINE — ARC STABLE…"
 * must not count — those used to dismiss the progress panel mid-cascade.
 */
export function isSystemsOnlineStatus(text: string): boolean {
  const t = text.trim();
  if (t === 'SYSTEMS ONLINE') return true;
  // Reduced-motion / explicit end variants (not ARC STABLE power-wave copy)
  if (t.startsWith('SYSTEMS ONLINE — REDUCED')) return true;
  return false;
}

/** Append a line to a ring buffer; de-dupes consecutive identical lines. */
export function appendLogLine(
  lines: string[],
  line: string,
  cap = JARVIS_LOG_CAP,
): string[] {
  const trimmed = line.trim();
  if (!trimmed) return lines.slice();
  if (lines.length > 0 && lines[lines.length - 1] === trimmed) {
    return lines.slice();
  }
  const next = [...lines, trimmed];
  if (next.length > cap) return next.slice(next.length - cap);
  return next;
}

export function isPieceWave(value: string): value is PieceWave {
  return (WAVE_ORDER as string[]).includes(value);
}
