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
    return file;
  }
  return soundUrl(file);
}

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
  let muted = false;
  let masterVolume = 1;

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

    const peak = Math.min(1, Math.max(0, req.volume ?? 1));
    const fadeIn = Math.max(0, req.fadeIn ?? 0);
    const fadeOut = Math.max(0, req.fadeOut ?? 0);
    const clipDur = Math.max(dur, req.clipDuration ?? dur);
    const clipOffset = Math.max(0, Math.min(clipDur, req.clipOffset ?? 0));

    const audio = new Audio(resolveSrc(req.file));
    audio.preload = 'auto';

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
      const elapsed = (performance.now() - startedAt) / 1000;
      const t = clipOffset + elapsed;
      v.envelopeGain = gainAtTime(t, clipDur, peak, fadeIn, fadeOut);
      applyVoiceVolume(v);
      if (elapsed < dur + 0.05) {
        v.fadeRaf = requestAnimationFrame(tickFade);
      }
    };

    // Continuous automation only when fades are active (peak alone is static)
    if (fadeIn > 1e-4 || fadeOut > 1e-4) {
      voice.fadeRaf = requestAnimationFrame(tickFade);
    }

    const startAt = Math.max(0, req.offset);

    const begin = () => {
      try {
        if (Number.isFinite(startAt) && startAt > 0) {
          audio.currentTime = startAt;
        }
      } catch {
        /* seek may fail until canplay; retry below */
      }

      const p = audio.play();
      if (p) {
        void p.catch(() => {
          const v = active.get(req.id);
          if (v) stopVoice(v);
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

    voice.stopTimer = window.setTimeout(() => {
      const v = active.get(req.id);
      if (v) stopVoice(v);
    }, dur * 1000 + 30);

    active.set(req.id, voice);
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
        applyVoiceVolume(voice);
      }
    },
    probeDuration,
    activeCount: () => active.size,
  };
}

export type AudioEngine = ReturnType<typeof createAudioEngine>;
