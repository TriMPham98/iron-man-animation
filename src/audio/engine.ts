import { soundUrl } from './sounds';
import { gainAtTime } from './timelineModel';

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
  /** Peak clip volume 0–1 (before master). Default 1. */
  volume?: number;
  /** Fade-in seconds measured from the full clip start (not mid-join). */
  fadeIn?: number;
  /** Fade-out seconds ending at the full clip end. */
  fadeOut?: number;
  /**
   * Playback rate / pitch (1 = original). Affects pitch and how fast
   * media time advances; wall-clock length is duration / pitch.
   */
  pitch?: number;
  /**
   * Full region duration (crop length) used for the fade envelope.
   * Defaults to `duration` when starting at the clip head.
   */
  clipDuration?: number;
  /**
   * How far into the full clip we already are when starting mid-region
   * (0 = clip start). Used so mid-join continues the correct fade ramp.
   */
  clipOffset?: number;
};

function resolveSrc(file: string): string {
  if (
    file.startsWith('blob:') ||
    file.startsWith('http://') ||
    file.startsWith('https://') ||
    file.startsWith('data:') ||
    file.startsWith('/')
  ) {
    // Root-relative paths still go through soundUrl when they are /sounds/…
    // so BASE_URL deploys work. Absolute http(s)/blob/data stay as-is.
    if (file.startsWith('/') && !file.startsWith('//')) {
      const base =
        typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
          ? String(import.meta.env.BASE_URL)
          : '/';
      if (base !== '/' && !file.startsWith(base)) {
        const root = base.endsWith('/') ? base.slice(0, -1) : base;
        return `${root}${file}`;
      }
    }
    return file;
  }
  return soundUrl(file);
}

/** Minimal silent WAV — used to unlock autoplay on a user gesture. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

type ActiveVoice = {
  id: string;
  audio: HTMLAudioElement;
  stopTimer: number;
  /** Peak clip gain 0–1 (before master). */
  peakVolume: number;
  /** Latest envelope gain 0–1 (after fades, before master). */
  envelopeGain: number;
  fadeRaf: number;
};

/**
 * Lightweight multi-voice player for timeline clips.
 * Uses HTMLAudioElement so crop is just currentTime + timed stop;
 * fade/volume automation ramps `audio.volume` on rAF.
 */
export function createAudioEngine() {
  const active = new Map<string, ActiveVoice>();
  /**
   * Pre-decoded elements keyed by catalog file / URL. Taking one out for
   * play() means INITIATE one-shots can call play() while already HAVE_FUTURE_DATA,
   * which avoids the intermittent NotAllowedError that happens when a cold
   * element defers play until canplay (outside the user-gesture window).
   */
  const warmPool = new Map<string, HTMLAudioElement>();
  let muted = false;
  let masterVolume = 1;
  let unlocked = false;
  let unlockInFlight: Promise<void> | null = null;

  const applyVoiceVolume = (voice: ActiveVoice) => {
    voice.audio.volume = Math.min(
      1,
      Math.max(0, voice.envelopeGain * masterVolume),
    );
  };

  const stopVoice = (voice: ActiveVoice) => {
    window.clearTimeout(voice.stopTimer);
    if (voice.fadeRaf) cancelAnimationFrame(voice.fadeRaf);
    try {
      voice.audio.pause();
      const src = voice.audio.currentSrc || voice.audio.src;
      // Blob URLs must be released; catalog files stay warm for the next hit.
      if (src.startsWith('blob:')) {
        voice.audio.removeAttribute('src');
        voice.audio.load();
      } else {
        try {
          voice.audio.currentTime = 0;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore teardown errors */
    }
    active.delete(voice.id);
  };

  const makeAudio = (file: string): HTMLAudioElement => {
    const a = new Audio();
    a.preload = 'auto';
    a.src = resolveSrc(file);
    return a;
  };

  /**
   * Take a warmed element if ready; otherwise allocate a fresh one.
   * Fresh elements are more likely to miss autoplay if data is not loaded.
   */
  const acquireAudio = (file: string): HTMLAudioElement => {
    const warmed = warmPool.get(file);
    if (warmed && warmed.readyState >= 2 /* HAVE_CURRENT_DATA */) {
      warmPool.delete(file);
      try {
        warmed.pause();
        warmed.currentTime = 0;
      } catch {
        /* ignore */
      }
      return warmed;
    }
    return makeAudio(file);
  };

  const stop = (id?: string) => {
    if (id) {
      const v = active.get(id);
      if (v) stopVoice(v);
      return;
    }
    for (const v of [...active.values()]) stopVoice(v);
  };

  /**
   * Stop every active voice except the given ids.
   * Used so assembly transport can re-arm timeline SFX without killing
   * one-shots (e.g. JARVIS startup VO on INITIATE).
   */
  const stopAllExcept = (keepIds: readonly string[]) => {
    if (!keepIds.length) {
      stop();
      return;
    }
    const keep = new Set(keepIds);
    for (const v of [...active.values()]) {
      if (keep.has(v.id)) continue;
      stopVoice(v);
    }
  };

  /**
   * Call from a user gesture (INITIATE click, keydown, pointerdown).
   * Production browsers block HTMLAudioElement.play() until the origin
   * has media engagement; delayed setTimeout starts lose the gesture
   * unless we unlock first.
   */
  const unlock = (): Promise<void> => {
    if (unlocked) return Promise.resolve();
    if (unlockInFlight) return unlockInFlight;

    unlockInFlight = (async () => {
      try {
        const a = new Audio(SILENT_WAV);
        a.preload = 'auto';
        a.volume = 0;
        // play() must be invoked in the gesture turn; await can settle later
        const p = a.play();
        if (p) await p;
        a.pause();
        a.removeAttribute('src');
        a.load();
        unlocked = true;
      } catch {
        // Still mark unlocked so we don't spin forever; later plays may work
        // after a second gesture.
        unlocked = true;
      } finally {
        unlockInFlight = null;
      }
    })();

    return unlockInFlight;
  };

  /** Best-effort warm so first cues aren't racing the network on cold deploys. */
  const preload = (file: string): void => {
    void warm(file);
  };

  /**
   * Fully buffer a clip to canplaythrough and keep the element in the warm
   * pool. Await this before showing INITIATE so the VO play() is synchronous
   * and stays inside the user-gesture window.
   */
  const warm = (file: string): Promise<void> => {
    const existing = warmPool.get(file);
    if (existing && existing.readyState >= 3 /* HAVE_FUTURE_DATA */) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (el?: HTMLAudioElement) => {
        if (settled) return;
        settled = true;
        if (el) warmPool.set(file, el);
        resolve();
      };

      try {
        const a = makeAudio(file);
        if (a.readyState >= 3) {
          finish(a);
          return;
        }
        a.addEventListener(
          'canplaythrough',
          () => {
            finish(a);
          },
          { once: true },
        );
        a.addEventListener(
          'error',
          () => {
            finish();
          },
          { once: true },
        );
        try {
          a.load();
        } catch {
          finish(a);
        }
        // Don't block boot forever on a hung decode
        window.setTimeout(() => finish(a), 4000);
      } catch {
        finish();
      }
    });
  };

  // Capture any early interaction so late-scheduled SFX still play on Vercel.
  if (typeof window !== 'undefined') {
    const onGesture = () => {
      void unlock();
    };
    window.addEventListener('pointerdown', onGesture, {
      capture: true,
      passive: true,
      once: true,
    });
    window.addEventListener('keydown', onGesture, {
      capture: true,
      once: true,
    });
  }

  const play = (req: PlayRequest): void => {
    if (muted) return;
    // `duration` is media/source seconds to consume from offset
    const mediaDur = Math.max(0, req.duration);
    if (mediaDur < 0.01) return;

    // Re-trigger same clip id: restart
    stop(req.id);

    const peak = Math.min(1, Math.max(0, req.volume ?? 1));
    const fadeIn = Math.max(0, req.fadeIn ?? 0);
    const fadeOut = Math.max(0, req.fadeOut ?? 0);
    const pitch = Math.min(4, Math.max(0.25, req.pitch ?? 1));
    const clipDur = Math.max(mediaDur, req.clipDuration ?? mediaDur);
    const clipOffset = Math.max(0, Math.min(clipDur, req.clipOffset ?? 0));
    // Wall-clock length of this voice (pitch speeds up / slows media time)
    const wallDur = mediaDur / pitch;

    // Prefer a pre-warmed element so play() is not deferred past the gesture.
    const audio = acquireAudio(req.file);
    audio.playbackRate = pitch;
    // Keep pitch shift when browser would otherwise preserve pitch on rate change
    try {
      (audio as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch =
        false;
      (
        audio as HTMLMediaElement & { mozPreservesPitch?: boolean }
      ).mozPreservesPitch = false;
      (
        audio as HTMLMediaElement & { webkitPreservesPitch?: boolean }
      ).webkitPreservesPitch = false;
    } catch {
      /* ignore */
    }

    const startedAt = performance.now();
    const initialGain = gainAtTime(
      clipOffset,
      clipDur,
      peak,
      fadeIn,
      fadeOut,
    );

    const voice: ActiveVoice = {
      id: req.id,
      audio,
      stopTimer: 0,
      peakVolume: peak,
      envelopeGain: initialGain,
      fadeRaf: 0,
    };
    applyVoiceVolume(voice);

    const tickFade = () => {
      const v = active.get(req.id);
      if (!v) return;
      const wallElapsed = (performance.now() - startedAt) / 1000;
      // Fade envelope is authored in media/source seconds
      const t = clipOffset + wallElapsed * pitch;
      v.envelopeGain = gainAtTime(t, clipDur, peak, fadeIn, fadeOut);
      applyVoiceVolume(v);
      if (wallElapsed < wallDur + 0.05) {
        v.fadeRaf = requestAnimationFrame(tickFade);
      }
    };

    // Continuous automation only when fades are active (peak alone is static)
    if (fadeIn > 1e-4 || fadeOut > 1e-4) {
      voice.fadeRaf = requestAnimationFrame(tickFade);
    }

    const startAt = Math.max(0, req.offset);

    const applySeek = () => {
      try {
        audio.playbackRate = pitch;
        if (Number.isFinite(startAt) && startAt > 0) {
          const cap = Number.isFinite(audio.duration)
            ? audio.duration
            : Infinity;
          if (startAt < cap) audio.currentTime = startAt;
        }
      } catch {
        /* seek may fail until canplay */
      }
    };

    const failVoice = () => {
      const v = active.get(req.id);
      if (v) stopVoice(v);
    };

    const tryPlay = (attempt: number) => {
      if (!active.has(req.id)) return;
      applySeek();
      const p = audio.play();
      if (!p) return;
      void p.catch((err: unknown) => {
        if (!active.has(req.id)) return;
        const name =
          err && typeof err === 'object' && 'name' in err
            ? String((err as { name?: string }).name)
            : '';
        // Media not buffered yet — wait for data, then retry. This can lose
        // the user-gesture token on some browsers; prefer warm() beforehand.
        if (
          attempt < 2 &&
          (name === 'AbortError' ||
            name === 'NotSupportedError' ||
            audio.readyState < 2)
        ) {
          audio.addEventListener(
            'canplay',
            () => tryPlay(attempt + 1),
            { once: true },
          );
          try {
            audio.load();
          } catch {
            /* ignore */
          }
          return;
        }
        // Autoplay policy: only useful if we can still unlock in-gesture.
        // Async unlock().then(play) is outside the gesture and usually fails —
        // kick unlock for future SFX and drop this voice.
        if (name === 'NotAllowedError') {
          void unlock();
        }
        failVoice();
      });
    };

    const onMeta = () => {
      applySeek();
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
    audio.addEventListener(
      'error',
      () => {
        failVoice();
      },
      { once: true },
    );

    voice.stopTimer = window.setTimeout(() => {
      const v = active.get(req.id);
      if (v) stopVoice(v);
    }, wallDur * 1000 + 30);

    active.set(req.id, voice);

    // Prefer canplay when seeking into the file so currentTime sticks
    if (startAt > 0.01 && audio.readyState < 1) {
      audio.addEventListener(
        'loadedmetadata',
        () => tryPlay(0),
        { once: true },
      );
      // Also kick load explicitly for cold CDN hits
      try {
        audio.load();
      } catch {
        /* ignore */
      }
    } else {
      tryPlay(0);
    }
  };

  /**
   * Probe source duration via a temporary Audio element.
   * Some VBR/ADTS MP3s report `Infinity` until a seek forces the decoder to
   * scan length — fall back to that before defaulting to 1s.
   */
  const probeDuration = (file: string): Promise<number> =>
    new Promise((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      let settled = false;
      const done = (sec: number) => {
        if (settled) return;
        settled = true;
        try {
          a.removeAttribute('src');
          a.load();
        } catch {
          /* ignore */
        }
        resolve(sec > 0 && Number.isFinite(sec) ? sec : 1);
      };

      const finishFromDuration = () => {
        const d = a.duration;
        if (Number.isFinite(d) && d > 0) {
          done(d);
          return true;
        }
        return false;
      };

      a.addEventListener(
        'error',
        () => {
          done(1);
        },
        { once: true },
      );

      a.addEventListener(
        'loadedmetadata',
        () => {
          if (finishFromDuration()) return;
          // Infinity / NaN: seek far to force duration calculation (Chromium).
          const onUpdate = () => {
            if (finishFromDuration()) {
              a.removeEventListener('timeupdate', onUpdate);
              a.removeEventListener('durationchange', onUpdate);
            }
          };
          a.addEventListener('timeupdate', onUpdate);
          a.addEventListener('durationchange', onUpdate);
          try {
            a.currentTime = 1e101;
          } catch {
            done(1);
            return;
          }
          window.setTimeout(() => {
            if (!settled) done(finishFromDuration() ? a.duration : 1);
          }, 800);
        },
        { once: true },
      );

      a.src = resolveSrc(file);
    });

  return {
    play,
    stop,
    stopAllExcept,
    unlock,
    preload,
    warm,
    isUnlocked: () => unlocked,
    isMuted: () => muted,
    setMuted: (m: boolean) => {
      muted = m;
      // Mute kills everything, including one-shots.
      if (m) stop();
    },
    setMasterVolume: (v: number) => {
      masterVolume = Math.min(1, Math.max(0, v));
      for (const voice of active.values()) {
        applyVoiceVolume(voice);
      }
    },
    probeDuration,
    activeCount: () => active.size,
  };
}

export type AudioEngine = ReturnType<typeof createAudioEngine>;
