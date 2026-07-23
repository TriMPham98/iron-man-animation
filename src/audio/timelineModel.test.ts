import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampGain,
  createClipFromSound,
  gainAtTime,
  hasSavedTimeline,
  initTimelineClips,
  loadTimeline,
  normalizeClip,
  saveTimeline,
  TIMELINE_STORAGE_KEY,
  type TimelineClip,
} from './timelineModel';

/** In-memory localStorage for node vitest. */
function installMemoryStorage() {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
  // timelineModel reads window.localStorage
  (globalThis as { window?: Window }).window = {
    localStorage: storage,
  } as Window;
  return storage;
}

function sampleClip(id: string, soundId = 'ratchet'): TimelineClip {
  const c = createClipFromSound(soundId, 1, 2.0, 0);
  if (!c) throw new Error('missing catalog sound');
  return { ...c, id };
}

describe('audio timeline persistence', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    delete (globalThis as { window?: Window }).window;
  });

  it('seeds once on first visit and marks storage as saved', () => {
    const seed = [sampleClip('clip-a'), sampleClip('clip-b', 'impact')];
    const clips = initTimelineClips(seed);
    expect(clips.map((c) => c.id).sort()).toEqual(['clip-a', 'clip-b']);
    expect(hasSavedTimeline()).toBe(true);
    expect(loadTimeline().map((c) => c.id).sort()).toEqual(['clip-a', 'clip-b']);
  });

  it('keeps a deleted clip deleted after reload (no re-seed)', () => {
    const seed = [sampleClip('clip-a'), sampleClip('clip-b', 'impact')];
    let clips = initTimelineClips(seed);

    // User deletes clip-a
    clips = clips.filter((c) => c.id !== 'clip-a');
    expect(saveTimeline(clips)).toBe(true);

    // Simulate page refresh: init again with the same seed available
    const reloaded = initTimelineClips(seed);
    expect(reloaded.map((c) => c.id)).toEqual(['clip-b']);
    expect(reloaded.some((c) => c.id === 'clip-a')).toBe(false);
  });

  it('persists an empty timeline after clear (does not restore seed)', () => {
    const seed = [sampleClip('clip-a'), sampleClip('clip-b', 'impact')];
    initTimelineClips(seed);
    expect(saveTimeline([])).toBe(true);

    const reloaded = initTimelineClips(seed);
    expect(reloaded).toEqual([]);
    expect(hasSavedTimeline()).toBe(true);
  });

  it('does not throw when a bad clip is mixed into a save', () => {
    const good = sampleClip('clip-good');
    const bad = { id: 'bad', file: undefined } as unknown as TimelineClip;
    expect(saveTimeline([good, bad])).toBe(true);
    expect(loadTimeline().map((c) => c.id)).toEqual(['clip-good']);
  });

  it('drops blob: imports on save and load', () => {
    const catalog = sampleClip('clip-cat');
    const blob: TimelineClip = {
      ...sampleClip('clip-blob'),
      file: 'blob:http://localhost/abc',
    };
    expect(saveTimeline([catalog, blob])).toBe(true);
    expect(loadTimeline().map((c) => c.id)).toEqual(['clip-cat']);
  });

  it('writes a verifiable snapshot under the storage key', () => {
    const clip = sampleClip('clip-x');
    saveTimeline([clip]);
    const raw = window.localStorage.getItem(TIMELINE_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { version: number; clips: TimelineClip[] };
    expect(parsed.version).toBe(1);
    expect(parsed.clips).toHaveLength(1);
    expect(parsed.clips[0]!.id).toBe('clip-x');
  });

  it('defaults volume/fades on legacy clips and persists gain', () => {
    const legacy = {
      id: 'clip-legacy',
      soundId: 'ratchet',
      label: 'Ratchet',
      file: 'ratchet.mp3',
      start: 0,
      cropIn: 0,
      cropOut: 2,
      sourceDuration: 2,
      lane: 0,
    };
    const n = normalizeClip(legacy);
    expect(n?.volume).toBe(1);
    expect(n?.fadeIn).toBe(0);
    expect(n?.fadeOut).toBe(0);

    const withGain = clampGain({
      ...sampleClip('clip-g'),
      volume: 0.5,
      fadeIn: 0.2,
      fadeOut: 0.2,
    });
    expect(saveTimeline([withGain])).toBe(true);
    const loaded = loadTimeline();
    expect(loaded[0]?.volume).toBeCloseTo(0.5, 5);
    expect(loaded[0]?.fadeIn).toBeCloseTo(0.2, 5);
    expect(loaded[0]?.fadeOut).toBeCloseTo(0.2, 5);
  });

  it('scales overlapping fades to fit clip length', () => {
    const c = clampGain({
      ...sampleClip('clip-long-fade'),
      cropIn: 0,
      cropOut: 1,
      sourceDuration: 1,
      fadeIn: 0.8,
      fadeOut: 0.8,
    });
    expect(c.fadeIn + c.fadeOut).toBeCloseTo(1, 5);
  });
});

describe('gainAtTime', () => {
  it('ramps fade-in, holds peak, ramps fade-out', () => {
    expect(gainAtTime(0, 1, 1, 0.25, 0.25)).toBeCloseTo(0, 5);
    expect(gainAtTime(0.125, 1, 1, 0.25, 0.25)).toBeCloseTo(0.5, 5);
    expect(gainAtTime(0.5, 1, 1, 0.25, 0.25)).toBeCloseTo(1, 5);
    expect(gainAtTime(0.875, 1, 1, 0.25, 0.25)).toBeCloseTo(0.5, 5);
    expect(gainAtTime(1, 1, 1, 0.25, 0.25)).toBeCloseTo(0, 5);
  });

  it('scales by peak volume', () => {
    expect(gainAtTime(0.5, 1, 0.4, 0, 0)).toBeCloseTo(0.4, 5);
  });
});
