import { WAVE_ORDER, type PieceWave } from '../suit/waves';

/** Max visible lines in the compact ephemeral log. */
export const JARVIS_LOG_CAP = 2;

/**
 * Fallback hold on SYSTEMS ONLINE when Binary Code Interface telemetry never
 * appears (skip-to-end, reduced motion). Normal play hands off the moment
 * the bottom ticker goes live ({@link shouldHandoffJarvisPanel}).
 */
export const JARVIS_DISMISS_MS = 1800;

/** Match `.jarvis-panel.is-leaving` collapse duration (ms). */
export const JARVIS_LEAVE_MS = 520;

/**
 * Integrity threshold treated as “assembly done” for the BCI handoff
 * (matches the 100% progress / systems-online path).
 */
export const JARVIS_HANDOFF_INTEGRITY = 0.999;

/**
 * True when the top integrity panel should leave so the bottom Binary Code
 * Interface ticker owns the post-lock beat — same frame the bottom goes on.
 *
 * Only when assembly is complete (systems online or integrity ≈ 1); mid-cascade
 * BCI audio must not collapse the progress strip early.
 */
export function shouldHandoffJarvisPanel(opts: {
  telemetryActive: boolean;
  panelVisible: boolean;
  systemsOnline: boolean;
  integrity01: number;
}): boolean {
  if (!opts.telemetryActive || !opts.panelVisible) return false;
  if (opts.systemsOnline) return true;
  return opts.integrity01 >= JARVIS_HANDOFF_INTEGRITY;
}

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
