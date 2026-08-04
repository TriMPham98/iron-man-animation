import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  audioTimelineOffset,
  createAssemblyTimeline,
  type AssemblyController,
} from '../animation/assemblyTimeline';
import type { Suit } from '../suit/Suit';
import type { AudioTimelinePanel } from '../ui/audioTimelinePanel';
import type { OverlayHandles } from '../ui/overlay';
import { isPieceWave, isSystemsOnlineStatus } from '../ui/jarvisHud';

const VIEWER_HINT =
  'Drag to orbit · R replay · Space pause · S skip · ←→ scrub';
const DIRECTOR_HINT =
  'Drag to orbit · plate · RECLASS · AUDIO scrub · A add · [ ] wave · ←→ · R · Space · S';

export interface AssemblySessionOptions {
  suit: Suit;
  camera: THREE.PerspectiveCamera;
  lookTarget: THREE.Vector3;
  controls: OrbitControls;
  ui: OverlayHandles;
  clock: THREE.Clock;
  reducedMotion: boolean;
  onClearPick: () => void;
  /** Optional director audio timeline (playhead + transport sync). */
  audioTimeline?: AudioTimelinePanel | null;
}

export interface AssemblySession {
  startSequence: () => void;
  skipToEnd: () => void;
  togglePause: () => void;
  seek: (progress01: number) => void;
  /** Per-frame: restarts assembly after the complete-mode idle spin finishes a full 360°. */
  update: () => void;
  assembly: AssemblyController;
  isComplete: () => boolean;
  /**
   * HUD timer seconds: assembly timeline time while building/scrubbing;
   * after complete, keeps counting past the sequence duration (showcase).
   */
  getHudElapsed: () => number;
  /** @deprecated Prefer getHudElapsed — kept for boot handoff. */
  getClockStart: () => number;
  setClockStart: (t: number) => void;
  refreshHintCopy: () => void;
}

/**
 * Owns assembly complete/UI state, sequence controls, and timeline ↔ HUD wiring.
 * Behavior matches the former inline logic in main.ts.
 */
export function createAssemblySession(
  options: AssemblySessionOptions,
): AssemblySession {
  const {
    suit,
    camera,
    lookTarget,
    controls,
    ui,
    clock,
    reducedMotion,
    onClearPick,
    audioTimeline = null,
  } = options;

  let assemblyComplete = false;
  let clockStart = 0;
  /**
   * When true (AUDIO timeline LOOP), restart the full assembly as soon as
   * the sequence ends — skip idle 360° showcase spin.
   */
  let loopFullCycle = false;
  /**
   * Wall-clock time when we entered complete (progress ≥ 1).
   * HUD shows assemblyDuration + (now − completeAnchor) so the timer
   * keeps running through the finished-suit showcase.
   */
  let completeAnchor: number | null = null;

  /**
   * After assembly finishes, OrbitControls auto-rotates the finished suit.
   * Once the camera has yawed a full turn, we restart the sequence so the
   * loop reads: assemble → spin showcase → assemble again.
   * Free-look (user drag) cancels auto-rotate and this auto-replay.
   */
  let completeSpinActive = false;
  let completeSpinAccum = 0;
  let completeSpinLastTheta: number | null = null;
  const _spinOffset = new THREE.Vector3();
  const _spinSpherical = new THREE.Spherical();

  const cameraAzimuth = (): number => {
    _spinOffset.copy(camera.position).sub(controls.target);
    _spinSpherical.setFromVector3(_spinOffset);
    return _spinSpherical.theta;
  };

  const stopCompleteSpinTracking = () => {
    completeSpinActive = false;
    completeSpinAccum = 0;
    completeSpinLastTheta = null;
  };

  const startCompleteSpinTracking = () => {
    // Reduced motion lands on the finished suit instantly — no loop churn.
    if (reducedMotion) {
      stopCompleteSpinTracking();
      return;
    }
    completeSpinActive = true;
    completeSpinAccum = 0;
    completeSpinLastTheta = null;
  };

  const refreshHintCopy = () => {
    const hintEl = document.getElementById('hint');
    if (hintEl) {
      hintEl.textContent = ui.isDirectorMode() ? DIRECTOR_HINT : VIEWER_HINT;
    }
  };

  /**
   * Orbit is always available during assembly and after complete.
   * While the cinematic path is playing, the first drag claims free-look
   * (`userOwnsCamera`) and overrides the progress-driven camera.
   * `preserveTarget` keeps the current orbit pivot instead of re-seeding
   * from the cinematic lookTarget.
   */
  const setOrbitMode = (
    mode: 'free' | 'complete',
    opts?: { preserveTarget?: boolean },
  ) => {
    if (!opts?.preserveTarget) {
      controls.target.copy(lookTarget);
    }
    controls.enabled = true;
    controls.autoRotate = mode === 'complete';
  };

  // Declared before callbacks so they can call into the controller once assigned.
  let assembly!: ReturnType<typeof createAssemblyTimeline>;

  /** Visual assembly span (includes opening hold → systems online). */
  const asmDuration = () => Math.max(assembly.getDuration(), 1e-6);

  /**
   * SFX seed was authored before OPENING_HOLD. Map GSAP time onto that clock
   * so plate hits stay aligned; hangar hold is silent lead-in.
   */
  const sfxOffset = () => audioTimelineOffset();
  const audioDuration = () => Math.max(asmDuration() - sfxOffset(), 1e-6);
  const toAudioSec = (gsapTime: number) => gsapTime - sfxOffset();
  const fromAudioSec = (audioSec: number) => audioSec + sfxOffset();

  const syncAudioDuration = () => {
    if (!audioTimeline) return;
    const dur = audioDuration();
    if (dur > 0) audioTimeline.setAssemblyDuration(dur);
  };

  const audioPlayFromTime = (gsapTime?: number) => {
    // Play in viewer and director — panel is authoring UI only.
    // Pass seed-clock seconds (may be negative during the hangar hold so
    // clip delays keep original absolute starts vs the cascade).
    // Integrity progress is wave-paced — always drive SFX from raw GSAP time.
    if (!audioTimeline) return;
    const gsapT = gsapTime ?? assembly.getTime();
    audioTimeline.onTransportPlay(toAudioSec(gsapT));
  };

  const audioStop = () => {
    audioTimeline?.onTransportStop();
  };

  /** Sync playhead from live GSAP time (integrity % is wave-paced, not linear). */
  const audioPlayheadFromTime = (gsapTime?: number) => {
    if (!audioTimeline) return;
    const gsapT = gsapTime ?? assembly.getTime();
    // Ruler playhead stays ≥ 0 (hold shows 0 until cascade clock starts).
    audioTimeline.setPlayhead(Math.max(0, toAudioSec(gsapT)));
  };

  const syncDebugPauseLabel = () => {
    const paused = assembly.isPaused() || assemblyComplete;
    ui.setDebugPaused(paused);
    audioTimeline?.setPaused(paused);
  };

  const markCompleteClock = () => {
    // Only stamp once per complete stretch so scrubbing to end mid-showcase
    // does not zero the post-duration counter.
    if (completeAnchor == null) {
      completeAnchor = clock.getElapsedTime();
    }
  };

  const clearCompleteClock = () => {
    completeAnchor = null;
  };

  const getHudElapsed = (): number => {
    const dur = assembly.getDuration();
    // Clock uses raw GSAP time — integrity progress is wave-paced, not linear.
    if (assemblyComplete || assembly.getProgress() >= 0.999) {
      const base = Math.max(dur, 0);
      const anchor = completeAnchor ?? clock.getElapsedTime();
      return base + Math.max(0, clock.getElapsedTime() - anchor);
    }
    return Math.max(0, Math.min(assembly.getTime(), Math.max(dur, 0)));
  };

  const applyCompleteUi = (opts?: { preserveCamera?: boolean }) => {
    assemblyComplete = true;
    markCompleteClock();
    suit.showFinal(); // seamless mesh — no grid-shard square blooms
    // Preserve free-look framing (no idle auto-rotate snap)
    const preserve = opts?.preserveCamera || assembly.userOwnsCamera();
    if (preserve) {
      setOrbitMode('free', { preserveTarget: true });
      controls.autoRotate = false;
      stopCompleteSpinTracking();
    } else {
      setOrbitMode('complete');
      startCompleteSpinTracking();
    }
    ui.setReplayEnabled(true);
    ui.setSkipEnabled(false);
    ui.setHintVisible(true);
    ui.fadeTitle(true);
    ui.setIntegrity('INTEGRITY 100%');
    ui.setStatus('SYSTEMS ONLINE', true);
    ui.setSystemsOnline(true);
    ui.setActiveWave(null);
    ui.setDebugProgress(1);
    ui.setDebugActivePieces([]);
    audioStop();
    audioPlayheadFromTime(asmDuration());
    syncDebugPauseLabel();
    refreshHintCopy();
  };

  const applyAssemblyUi = (opts?: { preserveTarget?: boolean }) => {
    assemblyComplete = false;
    clearCompleteClock();
    stopCompleteSpinTracking();
    // Keep orbit live so a mid-play drag can override the cinematic path
    setOrbitMode('free', { preserveTarget: opts?.preserveTarget });
    ui.setReplayEnabled(false);
    ui.setSkipEnabled(true);
    ui.setHintVisible(false);
    ui.fadeTitle(false);
    ui.setSystemsOnline(false);
  };

  assembly = createAssemblyTimeline(suit, camera, lookTarget, {
    onStatus: (text) => {
      // Only final SYSTEMS ONLINE dismisses the progress panel — not
      // intermediate * ONLINE beats (reactor, repulsors, J.A.R.V.I.S., etc.).
      ui.setStatus(text, isSystemsOnlineStatus(text));
    },
    onWave: (wave) => {
      if (isPieceWave(wave)) {
        ui.setActiveWave(wave);
      }
    },
    onProgress: (t) => {
      const pct = Math.round(t * 100);
      ui.setIntegrity(`INTEGRITY ${String(pct).padStart(3, ' ')}%`);
      ui.setDebugProgress(t);
      // Seed clock from live GSAP time so hold doesn’t skew SFX vs plates
      audioPlayheadFromTime();
      if (t < 0.999 && assemblyComplete) {
        // Scrubbed back from the end — keep free-look if user owns the camera
        applyAssemblyUi({
          preserveTarget: assembly.userOwnsCamera(),
        });
      }
    },
    onActivePieces: (pieces) => {
      ui.setDebugActivePieces(pieces);
    },
    onComplete: () => {
      ui.setDebugActivePieces([]);
      if (loopFullCycle) {
        // Full assembly cycle only — restart immediately, no idle spin.
        startSequence();
        return;
      }
      applyCompleteUi({ preserveCamera: assembly.userOwnsCamera() });
    },
  });

  syncAudioDuration();

  const clearPick = () => {
    onClearPick();
    ui.setDebugPickedPiece(null);
    ui.setReclassPick(null);
  };

  const finishInstantly = () => {
    clearPick();
    clearCompleteClock();
    assembly.seek(1);
    applyCompleteUi();
    clockStart = clock.getElapsedTime();
  };

  const startSequence = () => {
    clearPick();
    clearCompleteClock();
    ui.resetJarvisChrome();

    if (reducedMotion) {
      finishInstantly();
      ui.setStatus('SYSTEMS ONLINE — REDUCED MOTION', true);
      return;
    }

    applyAssemblyUi();
    ui.setIntegrity('INTEGRITY   0%');
    // Opening hold copy — timeline stages J.A.R.V.I.S. / INITIATED next
    ui.setStatus('STANDBY // HANGAR LOCK');
    ui.setDebugProgress(0);
    assembly.rebuild();
    syncAudioDuration();
    audioStop();
    assembly.play();
    audioPlayFromTime(0);
    audioPlayheadFromTime(0);
    syncDebugPauseLabel();
    clockStart = clock.getElapsedTime();
  };

  const skipToEnd = () => {
    if (assemblyComplete) return;
    clearPick();
    audioStop();
    assembly.seek(1);
    applyCompleteUi();
  };

  const togglePause = () => {
    if (assembly.isPlaying()) {
      assembly.pause();
      audioStop();
      // Orbit stays enabled; path is frozen at this frame until resume
      setOrbitMode('free', {
        preserveTarget: assembly.userOwnsCamera(),
      });
    } else if (assemblyComplete || assembly.getProgress() >= 0.999) {
      startSequence();
      return;
    } else {
      // Free-look only if the user claimed orbit; otherwise resume on path.
      const preserveCamera = assembly.userOwnsCamera();
      applyAssemblyUi({ preserveTarget: preserveCamera });
      assembly.resume({ preserveCamera });
      audioPlayFromTime();
    }
    syncDebugPauseLabel();
  };

  /** Seek visual integrity progress 0–1 (wave-paced; includes hangar hold at 0%). */
  const seek = (p: number) => {
    // Scrub invalidates overlay parents / visibility — drop selection
    clearPick();
    // Timeline scrub always re-attaches to the cinematic camera. Orbiting
    // the viewport (bindInput controls 'start') is what detaches free-look.
    audioStop();
    assembly.seek(p, { preserveCamera: false });
    audioPlayheadFromTime();
    syncDebugPauseLabel();
    if (p >= 0.999) {
      applyCompleteUi({ preserveCamera: false });
    } else {
      // Reseed orbit pivot from cinematic lookTarget so the next drag
      // starts from this frame’s path pose (not a stale free-look target).
      applyAssemblyUi({ preserveTarget: false });
      const pct = Math.round(p * 100);
      ui.setIntegrity(`INTEGRITY ${String(pct).padStart(3, ' ')}%`);
      ui.setStatus('DEBUG SCRUB', false);
    }
  };

  /**
   * Audio DAW scrub is 0–1 on the *seed* clock (no hangar hold).
   * Seek by absolute GSAP time (integrity % is wave-paced, not linear time).
   */
  const seekFromAudioProgress = (audioProgress01: number) => {
    const audioT = Math.max(0, Math.min(1, audioProgress01)) * audioDuration();
    const gsapT = fromAudioSec(audioT);
    clearPick();
    audioStop();
    assembly.seekTime(gsapT, { preserveCamera: false });
    audioPlayheadFromTime();
    syncDebugPauseLabel();
    const p = assembly.getProgress();
    if (p >= 0.999) {
      applyCompleteUi({ preserveCamera: false });
    } else {
      applyAssemblyUi({ preserveTarget: false });
      const pct = Math.round(p * 100);
      ui.setIntegrity(`INTEGRITY ${String(pct).padStart(3, ' ')}%`);
      ui.setStatus('DEBUG SCRUB', false);
    }
  };

  ui.onReplay(() => {
    startSequence();
  });

  ui.onSkip(() => {
    skipToEnd();
  });

  ui.onDirectorModeChange((enabled) => {
    if (!enabled) {
      clearPick();
      // Keep SFX transport running — director only toggles authoring chrome.
    } else {
      syncAudioDuration();
      audioPlayheadFromTime();
    }
    audioTimeline?.setVisible(enabled);
    refreshHintCopy();
  });

  // Panel chrome follows director preference; audio duration always tracked.
  audioTimeline?.setVisible(ui.isDirectorMode());
  syncAudioDuration();

  audioTimeline?.onSeek((p) => {
    seekFromAudioProgress(p);
  });

  audioTimeline?.onTogglePause(() => {
    togglePause();
  });

  audioTimeline?.onLoopChange((enabled) => {
    loopFullCycle = enabled;
    // If already sitting on the finished suit with loop just enabled, kick
    // a fresh cycle so the director does not wait for a spin.
    if (enabled && assemblyComplete) {
      startSequence();
    }
  });

  /**
   * Call each frame after controls.update(). Accumulates yaw while the
   * finished suit auto-rotates; after a full turn, replays the assembly.
   * (Disabled while AUDIO LOOP is on — that path restarts on onComplete.)
   */
  const update = () => {
    if (loopFullCycle) return;
    if (!completeSpinActive || !assemblyComplete) return;

    // User drag (or anything else) kills idle spin — stay on finished suit.
    if (!controls.autoRotate) {
      stopCompleteSpinTracking();
      return;
    }

    const theta = cameraAzimuth();
    if (completeSpinLastTheta === null) {
      completeSpinLastTheta = theta;
      return;
    }

    let dTheta = theta - completeSpinLastTheta;
    // Unwrap so continuous spin does not flip sign at ±π
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    completeSpinLastTheta = theta;
    completeSpinAccum += Math.abs(dTheta);

    if (completeSpinAccum >= Math.PI * 2 - 1e-3) {
      stopCompleteSpinTracking();
      startSequence();
    }
  };

  return {
    startSequence,
    skipToEnd,
    togglePause,
    seek,
    update,
    assembly,
    isComplete: () => assemblyComplete,
    getHudElapsed,
    getClockStart: () => clockStart,
    setClockStart: (t: number) => {
      clockStart = t;
    },
    refreshHintCopy,
  };
}
