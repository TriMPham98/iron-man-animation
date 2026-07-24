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
  /**
   * Peak gain 0–1 (Logic-style clip volume). Default 1.
   * Fades ramp to/from this level.
   */
  volume: number;
  /** Fade-in length in seconds from clip start (0 = none). */
  fadeIn: number;
  /** Fade-out length in seconds ending at clip end (0 = none). */
  fadeOut: number;
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
  return clampGain({
    ...c,
    cropIn,
    cropOut,
    sourceDuration: src,
    start: Math.max(0, c.start),
  });
}

/**
 * Clamp volume 0–1 and fades so fadeIn + fadeOut never exceed clip length
 * (same idea as Logic’s region fade handles).
 */
export function clampGain(c: TimelineClip): TimelineClip {
  const dur = Math.max(0, c.cropOut - c.cropIn);
  let volume =
    typeof c.volume === 'number' && Number.isFinite(c.volume) ? c.volume : 1;
  volume = Math.min(1, Math.max(0, volume));
  let fadeIn =
    typeof c.fadeIn === 'number' && Number.isFinite(c.fadeIn) ? c.fadeIn : 0;
  let fadeOut =
    typeof c.fadeOut === 'number' && Number.isFinite(c.fadeOut) ? c.fadeOut : 0;
  fadeIn = Math.max(0, fadeIn);
  fadeOut = Math.max(0, fadeOut);
  if (dur > 0 && fadeIn + fadeOut > dur) {
    const s = dur / (fadeIn + fadeOut);
    fadeIn *= s;
    fadeOut *= s;
  }
  return { ...c, volume, fadeIn, fadeOut };
}

/**
 * Instantaneous gain at time `t` into the clip (0 = start), applying
 * fade-in / sustain peak / fade-out. Used by the engine and envelope draw.
 */
export function gainAtTime(
  t: number,
  clipDur: number,
  peak: number,
  fadeIn: number,
  fadeOut: number,
): number {
  if (clipDur <= 0 || peak <= 0) return 0;
  const x = Math.max(0, Math.min(clipDur, t));
  let g = peak;
  if (fadeIn > 1e-6 && x < fadeIn) {
    g = peak * (x / fadeIn);
  }
  if (fadeOut > 1e-6 && x > clipDur - fadeOut) {
    const u = Math.max(0, (clipDur - x) / fadeOut);
    g = Math.min(g, peak * u);
  }
  return Math.min(1, Math.max(0, g));
}

const defaultGain = () =>
  ({
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  }) as const;

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
    ...defaultGain(),
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
    ...defaultGain(),
  });
}

/**
 * Stable list of non-catalog sound ids present in clips (sorted).
 * Each gets a track after the catalog rows.
 */
export function customSoundIds(clips: TimelineClip[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of clips) {
    if (findSound(c.soundId)) continue;
    if (seen.has(c.soundId)) continue;
    seen.add(c.soundId);
    out.push(c.soundId);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Default catalog track order (array index order in SOUNDS). */
export function defaultCatalogOrder(): string[] {
  return SOUNDS.map((s) => s.id);
}

/** Fixed catalog track count (one row per library sample). */
export function catalogTrackCount(): number {
  return SOUNDS.length;
}

/**
 * Resolve catalog sound ids in the given order (unknown ids skipped;
 * missing catalog ids appended in SOUNDS order).
 */
export function normalizeCatalogOrder(
  order: readonly string[] | null | undefined,
): string[] {
  if (!order || order.length === 0) return defaultCatalogOrder();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (!findSound(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const s of SOUNDS) {
    if (seen.has(s.id)) continue;
    out.push(s.id);
  }
  return out;
}

/**
 * Lane index for a sound id: catalog order, then sorted custom tracks.
 */
export function laneForSoundId(
  soundId: string,
  customs: readonly string[] = [],
  catalogOrder: readonly string[] = defaultCatalogOrder(),
): number {
  const order = normalizeCatalogOrder(catalogOrder);
  const cat = order.indexOf(soundId);
  if (cat >= 0) return cat;
  const cIdx = customs.indexOf(soundId);
  if (cIdx >= 0) return order.length + cIdx;
  // Unknown custom — append after known customs
  return order.length + customs.length;
}

export type TrackRow = {
  lane: number;
  soundId: string;
  label: string;
  /** Catalog sample vs user-imported / orphan. */
  kind: 'catalog' | 'custom';
};

/**
 * One track row per catalog sound (in `catalogOrder`), then customs.
 * Pass a duration-sorted order from the panel for shortest → longest.
 */
export function listTrackRows(
  clips: TimelineClip[],
  catalogOrder: readonly string[] = defaultCatalogOrder(),
): TrackRow[] {
  const order = normalizeCatalogOrder(catalogOrder);
  const customs = customSoundIds(clips);
  const rows: TrackRow[] = order.map((id, i) => {
    const def = findSound(id)!;
    return {
      lane: i,
      soundId: def.id,
      label: def.label,
      kind: 'catalog' as const,
    };
  });
  for (let i = 0; i < customs.length; i++) {
    const id = customs[i]!;
    const sample = clips.find((c) => c.soundId === id);
    rows.push({
      lane: order.length + i,
      soundId: id,
      label: sample?.label || id.replace(/^custom-/, ''),
      kind: 'custom',
    });
  }
  return rows;
}

/**
 * Assign each clip to its sound’s fixed track (one line per sample).
 * Same sample instances share a track; different samples never stack.
 */
export function assignLanes(
  clips: TimelineClip[],
  catalogOrder: readonly string[] = defaultCatalogOrder(),
): TimelineClip[] {
  const order = normalizeCatalogOrder(catalogOrder);
  const customs = customSoundIds(clips);
  return clips.map((c) => ({
    ...c,
    lane: laneForSoundId(c.soundId, customs, order),
  }));
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
  const r = raw as Partial<TimelineClip>;
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
    // Older saves omit gain — default to full volume, no fades
    volume:
      typeof r.volume === 'number' && Number.isFinite(r.volume) ? r.volume : 1,
    fadeIn:
      typeof r.fadeIn === 'number' && Number.isFinite(r.fadeIn) ? r.fadeIn : 0,
    fadeOut:
      typeof r.fadeOut === 'number' && Number.isFinite(r.fadeOut) ? r.fadeOut : 0,
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

  lines.push(
    '| # | start | end | id | cropIn | cropOut | vol | fadeIn | fadeOut | label |',
  );
  lines.push(
    '|--:|------:|----:|----|-------:|--------:|----:|-------:|--------:|-------|',
  );
  sorted.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.start.toFixed(3)} | ${clipEnd(c).toFixed(3)} | \`${c.soundId}\` | ${c.cropIn.toFixed(3)} | ${c.cropOut.toFixed(3)} | ${c.volume.toFixed(2)} | ${c.fadeIn.toFixed(3)} | ${c.fadeOut.toFixed(3)} | ${c.label} |`,
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
          volume: Number(c.volume.toFixed(3)),
          fadeIn: Number(c.fadeIn.toFixed(3)),
          fadeOut: Number(c.fadeOut.toFixed(3)),
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
