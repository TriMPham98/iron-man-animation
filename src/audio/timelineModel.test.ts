import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createClipFromSound,
  hasSavedTimeline,
  initTimelineClips,
  loadTimeline,
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
});
