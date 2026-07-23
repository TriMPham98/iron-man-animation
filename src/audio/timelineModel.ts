import { findSound, SOUNDS } from './sounds';

const STORAGE_KEY = 'mark-suit-audio-timeline-v1';

export type TimelineClip = {
  /** Unique instance id on the track. */
  id: string;
  /** Catalog sound id, or custom- for user drops. */
  soundId: string;
  label: string;
  file: string;
  /** Timeline start (seconds, assembly time). */
  start: number;
  /** Source crop in (seconds into file). */
  cropIn: number;
  /** Source crop out (seconds into file, exclusive end). */
  cropOut: number;
  /** Full source length (seconds). */
  sourceDuration: number;
  /** Lane index (0-based) for visual stacking. */
  lane: number;
};

export type TimelineSnapshot = {
  version: 1;
  clips: TimelineClip[];
};

export function clipDuration(c: TimelineClip): number {
  return Math.max(0, c.cropOut - c.cropIn);
}

export function clipEnd(c: TimelineClip): number {
  return c.start + clipDuration(c);
}

export function clampCrop(c: TimelineClip): TimelineClip {
  const src = Math.max(0.05, c.sourceDuration);
  let cropIn = Math.min(Math.max(0, c.cropIn), src - 0.05);
  let cropOut = Math.min(Math.max(cropIn + 0.05, c.cropOut), src);
  return { ...c, cropIn, cropOut, sourceDuration: src, start: Math.max(0, c.start) };
}

let idSeq = 0;
export function newClipId(): string {
  idSeq += 1;
  return `clip-${Date.now().toString(36)}-${idSeq}`;
}

export function createClipFromSound(
  soundId: string,
  start: number,
  sourceDuration: number,
  lane = 0,
): TimelineClip | null {
  const def = findSound(soundId);
  if (!def) return null;
  const src = Math.max(0.05, sourceDuration);
  return clampCrop({
    id: newClipId(),
    soundId: def.id,
    label: def.label,
    file: def.file,
    start: Math.max(0, start),
    cropIn: 0,
    cropOut: src,
    sourceDuration: src,
    lane,
  });
}

export function createClipFromFileMeta(meta: {
  soundId: string;
  label: string;
  file: string;
  start: number;
  sourceDuration: number;
  lane?: number;
}): TimelineClip {
  const src = Math.max(0.05, meta.sourceDuration);
  return clampCrop({
    id: newClipId(),
    soundId: meta.soundId,
    label: meta.label,
    file: meta.file,
    start: Math.max(0, meta.start),
    cropIn: 0,
    cropOut: src,
    sourceDuration: src,
    lane: meta.lane ?? 0,
  });
}

/** Pack clips into non-overlapping lanes (greedy by start time). */
export function assignLanes(clips: TimelineClip[]): TimelineClip[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  const out: TimelineClip[] = [];
  for (const c of sorted) {
    const end = clipEnd(c);
    let lane = laneEnds.findIndex((le) => le <= c.start + 1e-4);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    out.push({ ...c, lane });
  }
  return out;
}

/** Whether any timeline snapshot is already stored (including an empty list). */
export function hasSavedTimeline(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

export function loadTimeline(): TimelineClip[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as TimelineSnapshot;
    if (data?.version !== 1 || !Array.isArray(data.clips)) return [];
    // Drop blob: imports — object URLs die across reloads
    const keep = data.clips.filter(
      (c) => c && typeof c.file === 'string' && !c.file.startsWith('blob:'),
    );
    return assignLanes(keep.map(clampCrop));
  } catch {
    return [];
  }
}

/**
 * Persist the full clip list (adds, moves, crops, deletes, clear).
 * Empty arrays are saved intentionally so deletes survive reload.
 * Returns false if storage is unavailable (private mode / quota).
 */
export function saveTimeline(clips: TimelineClip[]): boolean {
  try {
    // Persist catalog clips only (blob URLs are session-local)
    const persistable = clips.filter((c) => !c.file.startsWith('blob:'));
    const snap: TimelineSnapshot = { version: 1, clips: persistable };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    return true;
  } catch (err) {
    console.warn('[audio-timeline] failed to save clips', err);
    return false;
  }
}

export function formatExportCard(clips: TimelineClip[], assemblyDuration: number): string {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const lines: string[] = [
    '## Audio timeline',
    '',
    `assemblyDuration: ${assemblyDuration.toFixed(3)}s`,
    `clips: ${sorted.length}`,
    '',
  ];

  if (sorted.length === 0) {
    lines.push('(no clips)');
    return lines.join('\n');
  }

  lines.push('| # | start | end | id | cropIn | cropOut | label |');
  lines.push('|--:|------:|----:|----|-------:|--------:|-------|');
  sorted.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.start.toFixed(3)} | ${clipEnd(c).toFixed(3)} | \`${c.soundId}\` | ${c.cropIn.toFixed(3)} | ${c.cropOut.toFixed(3)} | ${c.label} |`,
    );
  });

  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        unit: 'seconds',
        assemblyDuration: Number(assemblyDuration.toFixed(3)),
        events: sorted.map((c) => ({
          t: Number(c.start.toFixed(3)),
          end: Number(clipEnd(c).toFixed(3)),
          id: c.soundId,
          file: c.file,
          cropIn: Number(c.cropIn.toFixed(3)),
          cropOut: Number(c.cropOut.toFixed(3)),
          label: c.label,
        })),
      },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('');
  lines.push('<!-- paste this card in chat for assembly SFX cues -->');
  return lines.join('\n');
}

export { SOUNDS };
