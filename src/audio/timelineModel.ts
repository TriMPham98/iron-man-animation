import { findSound, SOUNDS } from './sounds';

/** localStorage key — empty `{ clips: [] }` is a valid intentional save. */
export const TIMELINE_STORAGE_KEY = 'mark-suit-audio-timeline-v1';

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
  /** Wall-clock ms when this snapshot was written (debug / multi-tab). */
  updatedAt?: number;
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

/** True when a clip can be written to localStorage and survive a reload. */
export function isPersistableClip(c: unknown): c is TimelineClip {
  if (!c || typeof c !== 'object') return false;
  const clip = c as Partial<TimelineClip>;
  if (typeof clip.id !== 'string' || !clip.id) return false;
  if (typeof clip.soundId !== 'string') return false;
  if (typeof clip.file !== 'string' || !clip.file) return false;
  // Object URLs die across reloads — never persist them
  if (clip.file.startsWith('blob:')) return false;
  if (typeof clip.start !== 'number' || !Number.isFinite(clip.start)) return false;
  if (typeof clip.cropIn !== 'number' || !Number.isFinite(clip.cropIn)) return false;
  if (typeof clip.cropOut !== 'number' || !Number.isFinite(clip.cropOut)) return false;
  if (
    typeof clip.sourceDuration !== 'number' ||
    !Number.isFinite(clip.sourceDuration)
  ) {
    return false;
  }
  return true;
}

/**
 * Normalize a stored/seed clip: re-bind catalog file paths, clamp crops.
 * Returns null if the clip cannot be used after reload.
 */
export function normalizeClip(raw: unknown): TimelineClip | null {
  if (!isPersistableClip(raw)) return null;
  const def = findSound(raw.soundId);
  const base: TimelineClip = {
    id: raw.id,
    soundId: raw.soundId,
    label:
      typeof raw.label === 'string' && raw.label
        ? raw.label
        : (def?.label ?? raw.soundId),
    // Prefer live catalog path so renames still resolve
    file: def?.file ?? raw.file,
    start: raw.start,
    cropIn: raw.cropIn,
    cropOut: raw.cropOut,
    sourceDuration: raw.sourceDuration,
    lane: typeof raw.lane === 'number' && Number.isFinite(raw.lane) ? raw.lane : 0,
  };
  return clampCrop(base);
}

function readStorageRaw(): string | null {
  try {
    return window.localStorage.getItem(TIMELINE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Whether any timeline snapshot is already stored (including an empty list). */
export function hasSavedTimeline(): boolean {
  return readStorageRaw() != null;
}

/**
 * Parse clips from a snapshot object or JSON value.
 * Invalid entries are dropped; empty list is a valid result.
 */
export function parseTimelineClips(data: unknown): TimelineClip[] | null {
  if (!data || typeof data !== 'object') return null;
  const snap = data as Partial<TimelineSnapshot>;
  if (snap.version !== 1 || !Array.isArray(snap.clips)) return null;
  const keep: TimelineClip[] = [];
  for (const raw of snap.clips) {
    const n = normalizeClip(raw);
    if (n) keep.push(n);
  }
  return assignLanes(keep);
}

export function loadTimeline(): TimelineClip[] {
  try {
    const raw = readStorageRaw();
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    const clips = parseTimelineClips(data);
    // Corrupt / wrong version → treat as empty user save (do not re-seed)
    return clips ?? [];
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
    // Only write clips that can survive a reload. Guard each entry so one
    // bad clip cannot throw and abort the whole save (which used to leave
    // deletes unpersisted).
    const persistable: TimelineClip[] = [];
    for (const c of clips) {
      if (!isPersistableClip(c)) continue;
      const n = normalizeClip(c);
      if (n) persistable.push(n);
    }
    const snap: TimelineSnapshot = {
      version: 1,
      clips: persistable,
      updatedAt: Date.now(),
    };
    const payload = JSON.stringify(snap);
    window.localStorage.setItem(TIMELINE_STORAGE_KEY, payload);

    // Verify write — catches quota edge cases that setItem doesn't throw for
    const roundTrip = window.localStorage.getItem(TIMELINE_STORAGE_KEY);
    if (roundTrip !== payload) {
      console.warn('[audio-timeline] save verification failed');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[audio-timeline] failed to save clips', err);
    return false;
  }
}

/**
 * Load saved clips, or seed once when nothing has ever been stored.
 * After the first seed write, deletes/clears are permanent across refresh.
 */
export function initTimelineClips(seedClips: unknown): TimelineClip[] {
  if (hasSavedTimeline()) {
    return loadTimeline();
  }

  const fromSeed: TimelineClip[] = [];
  if (Array.isArray(seedClips)) {
    for (const raw of seedClips) {
      const n = normalizeClip(raw);
      if (n) fromSeed.push(n);
    }
  }
  const clips = assignLanes(fromSeed);
  // Always write — including empty — so the next visit never re-seeds
  saveTimeline(clips);
  return clips;
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
