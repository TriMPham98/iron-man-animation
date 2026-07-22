import { soundUrl } from './sounds';

export type PlayRequest = {
  /** Unique clip instance id (for stop-by-id). */
  id: string;
  /**
   * Catalog filename (e.g. `impact.mp3`), or an absolute / blob URL
   * for user-imported clips.
   */
  file: string;
  /** Seconds into the source file to begin. */
  offset: number;
  /** How long to play from offset (seconds). */
  duration: number;
  volume?: number;
};

function resolveSrc(file: string): string {
  if (
    file.startsWith('blob:') ||
    file.startsWith('http://') ||
    file.startsWith('https://') ||
    file.startsWith('data:') ||
    file.startsWith('/')
  ) {
    return file;
  }
  return soundUrl(file);
}

type ActiveVoice = {
  id: string;
  audio: HTMLAudioElement;
  stopTimer: number;
};

/**
 * Lightweight multi-voice player for timeline clips.
 * Uses HTMLAudioElement so crop is just currentTime + timed stop.
 */
export function createAudioEngine() {
  const active = new Map<string, ActiveVoice>();
  let muted = false;
  let masterVolume = 1;

  const stopVoice = (voice: ActiveVoice) => {
    window.clearTimeout(voice.stopTimer);
    try {
      voice.audio.pause();
      voice.audio.removeAttribute('src');
      voice.audio.load();
    } catch {
      /* ignore teardown errors */
    }
    active.delete(voice.id);
  };

  const stop = (id?: string) => {
    if (id) {
      const v = active.get(id);
      if (v) stopVoice(v);
      return;
    }
    for (const v of [...active.values()]) stopVoice(v);
  };

  const play = (req: PlayRequest): void => {
    if (muted) return;
    const dur = Math.max(0, req.duration);
    if (dur < 0.01) return;

    // Re-trigger same clip id: restart
    stop(req.id);

    const audio = new Audio(resolveSrc(req.file));
    audio.preload = 'auto';
    audio.volume = Math.min(1, Math.max(0, (req.volume ?? 1) * masterVolume));

    const startAt = Math.max(0, req.offset);

    const begin = () => {
      try {
        // Seek then play — browsers tolerate currentTime before metadata on many codecs
        if (Number.isFinite(startAt) && startAt > 0) {
          audio.currentTime = startAt;
        }
      } catch {
        /* seek may fail until canplay; retry below */
      }

      const p = audio.play();
      if (p) {
        void p.catch(() => {
          active.delete(req.id);
        });
      }
    };

    const onMeta = () => {
      try {
        if (startAt > 0 && startAt < (audio.duration || Infinity)) {
          audio.currentTime = startAt;
        }
      } catch {
        /* ignore */
      }
    };

    audio.addEventListener('loadedmetadata', onMeta, { once: true });
    audio.addEventListener(
      'ended',
      () => {
        const v = active.get(req.id);
        if (v) stopVoice(v);
      },
      { once: true },
    );

    const stopTimer = window.setTimeout(() => {
      const v = active.get(req.id);
      if (v) stopVoice(v);
    }, dur * 1000 + 30);

    active.set(req.id, { id: req.id, audio, stopTimer });
    begin();
  };

  /** Probe source duration via a temporary Audio element. */
  const probeDuration = (file: string): Promise<number> =>
    new Promise((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      const done = (sec: number) => {
        a.removeAttribute('src');
        a.load();
        resolve(sec);
      };
      a.addEventListener(
        'loadedmetadata',
        () => {
          const d = a.duration;
          done(Number.isFinite(d) && d > 0 ? d : 1);
        },
        { once: true },
      );
      a.addEventListener(
        'error',
        () => {
          done(1);
        },
        { once: true },
      );
      a.src = resolveSrc(file);
    });

  return {
    play,
    stop,
    setMuted: (m: boolean) => {
      muted = m;
      if (m) stop();
    },
    isMuted: () => muted,
    setMasterVolume: (v: number) => {
      masterVolume = Math.min(1, Math.max(0, v));
      for (const voice of active.values()) {
        voice.audio.volume = masterVolume;
      }
    },
    probeDuration,
    activeCount: () => active.size,
  };
}

export type AudioEngine = ReturnType<typeof createAudioEngine>;
