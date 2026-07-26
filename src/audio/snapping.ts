import { clipEnd, type TimelineClip } from './timelineModel';

/**
 * Magnetic snapping for timeline drags — the DAW behaviour where a clip
 * edge "sticks" to a nearby ruler tick, the playhead, or another clip.
 *
 * Pure module: the panel converts a pixel tolerance into seconds
 * (`SNAP_PX / pxPerSec`) so the magnet feels identical at every zoom.
 */

/** What a snap landed on — drives the guide colour and readout. */
export type SnapKind = 'grid' | 'playhead' | 'clip' | 'bounds';

export type SnapTarget = {
  time: number;
  kind: SnapKind;
};

export type SnapResult = {
  /** Snapped value, or the raw value when nothing was in range. */
  time: number;
  /** The target that won, or null when unsnapped. */
  target: SnapTarget | null;
};

export interface SnapTargetOptions {
  clips: readonly TimelineClip[];
  /** Clip being dragged — its own edges never snap to themselves. */
  excludeId?: string | null;
  playheadSec?: number | null;
  assemblyDuration?: number | null;
  /** Ruler minor-tick spacing in seconds; <= 0 omits grid targets. */
  gridStep?: number;
}

const EPS = 1e-6;

/**
 * Tie-break order when two targets sit the same distance away.
 * Musical intent beats the grid: a director aligning to the playhead or to
 * an adjacent clip means that edge, not the 0.5s tick next to it.
 */
const KIND_PRIORITY: Record<SnapKind, number> = {
  playhead: 0,
  clip: 1,
  bounds: 2,
  grid: 3,
};

/** Every time value a dragged edge may stick to, unsorted. */
export function collectSnapTargets(opts: SnapTargetOptions): SnapTarget[] {
  const {
    clips,
    excludeId = null,
    playheadSec = null,
    assemblyDuration = null,
    gridStep = 0,
  } = opts;

  const out: SnapTarget[] = [{ time: 0, kind: 'bounds' }];

  if (assemblyDuration != null && assemblyDuration > EPS) {
    out.push({ time: assemblyDuration, kind: 'bounds' });
    if (gridStep > EPS) {
      // Cap the walk so a pathological gridStep can't spin forever.
      const maxTicks = 4096;
      let i = 1;
      for (
        let t = gridStep;
        t < assemblyDuration - EPS && i <= maxTicks;
        t = gridStep * ++i
      ) {
        out.push({ time: t, kind: 'grid' });
      }
    }
  }

  if (playheadSec != null && playheadSec >= 0) {
    out.push({ time: playheadSec, kind: 'playhead' });
  }

  for (const c of clips) {
    if (excludeId != null && c.id === excludeId) continue;
    out.push({ time: c.start, kind: 'clip' });
    out.push({ time: clipEnd(c), kind: 'clip' });
  }

  return out;
}

/** Nearest in-range target to `raw`, or `raw` untouched. */
export function snapTime(
  raw: number,
  targets: readonly SnapTarget[],
  toleranceSec: number,
): SnapResult {
  if (!(toleranceSec > 0) || !Number.isFinite(raw)) {
    return { time: raw, target: null };
  }

  let best: SnapTarget | null = null;
  let bestDelta = Infinity;

  for (const t of targets) {
    const delta = Math.abs(t.time - raw);
    if (delta > toleranceSec + EPS) continue;
    const closer = delta < bestDelta - EPS;
    const tied =
      best != null &&
      Math.abs(delta - bestDelta) <= EPS &&
      KIND_PRIORITY[t.kind] < KIND_PRIORITY[best.kind];
    if (closer || tied) {
      best = t;
      bestDelta = delta;
    }
  }

  return best ? { time: best.time, target: best } : { time: raw, target: null };
}

/**
 * Snap a moving clip by whichever of its two edges is closest to a target,
 * returning the resulting start. Snapping the tail is what makes
 * back-to-back SFX butt together cleanly.
 */
export function snapClipStart(
  rawStart: number,
  duration: number,
  targets: readonly SnapTarget[],
  toleranceSec: number,
): SnapResult {
  const head = snapTime(rawStart, targets, toleranceSec);
  const tail = snapTime(rawStart + duration, targets, toleranceSec);

  const headDelta = head.target ? Math.abs(head.time - rawStart) : Infinity;
  const tailDelta = tail.target
    ? Math.abs(tail.time - (rawStart + duration))
    : Infinity;

  if (headDelta === Infinity && tailDelta === Infinity) {
    return { time: rawStart, target: null };
  }
  if (tailDelta < headDelta - EPS) {
    return { time: Math.max(0, tail.time - duration), target: tail.target };
  }
  return { time: Math.max(0, head.time), target: head.target };
}
