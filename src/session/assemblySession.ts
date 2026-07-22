import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createAssemblyTimeline,
  type AssemblyController,
} from '../animation/assemblyTimeline';
import type { Suit } from '../suit/Suit';
import type { AudioTimelinePanel } from '../ui/audioTimelinePanel';
import type { OverlayHandles } from '../ui/overlay';

const VIEWER_HINT =
  'Drag to orbit · R replay · Space pause · S skip · ←→ scrub';
const DIRECTOR_HINT =
  'Drag to orbit · plate · RECLASS · AUDIO timeline · A add · [ ] wave · ←→ scrub · R · Space · S';

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

  const asmDuration = () => Math.max(assembly.getDuration(), 1e-6);

  const syncAudioDuration = () => {
    if (!audioTimeline) return;
    const dur = assembly.getDuration();
    if (dur > 0) audioTimeline.setAssemblyDuration(dur);
  };

  const audioPlayFromProgress = (p: number) => {
    // Play in viewer and director — panel is authoring UI only.
    if (!audioTimeline) return;
    audioTimeline.onTransportPlay(p * asmDuration());
  };

  const audioStop = () => {
    audioTimeline?.onTransportStop();
  };

  const audioPlayhead = (p: number) => {
    if (!audioTimeline) return;
    audioTimeline.setPlayhead(p * asmDuration());
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
    const p = assembly.getProgress();
    if (assemblyComplete || p >= 0.999) {
      const base = Math.max(dur, 0);
      const anchor = completeAnchor ?? clock.getElapsedTime();
      return base + Math.max(0, clock.getElapsedTime() - anchor);
    }
    return Math.max(0, p * Math.max(dur, 0));
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
    ui.setDebugProgress(1);
    ui.setDebugPaused(true);
    ui.setDebugActivePieces([]);
    audioStop();
    audioPlayhead(1);
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
  };

  assembly = createAssemblyTimeline(suit, camera, lookTarget, {
    onStatus: (text) => {
      const online = text.includes('ONLINE') || text.includes('STABLE');
      ui.setStatus(text, online);
    },
    onProgress: (t) => {
      const pct = Math.round(t * 100);
      ui.setIntegrity(`INTEGRITY ${String(pct).padStart(3, ' ')}%`);
      ui.setDebugProgress(t);
      audioPlayhead(t);
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
      applyCompleteUi({ preserveCamera: assembly.userOwnsCamera() });
      ui.setDebugActivePieces([]);
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

    if (reducedMotion) {
      finishInstantly();
      ui.setStatus('SYSTEMS ONLINE — REDUCED MOTION', true);
      return;
    }

    applyAssemblyUi();
    ui.setIntegrity('INTEGRITY   0%');
    ui.setStatus('ASSEMBLY SEQUENCE INITIATED');
    ui.setDebugProgress(0);
    ui.setDebugPaused(false);
    assembly.rebuild();
    syncAudioDuration();
    audioStop();
    assembly.play();
    audioPlayFromProgress(0);
    audioPlayhead(0);
    clockStart = clock.getElapsedTime();
  };

  const skipToEnd = () => {
    if (assemblyComplete) return;
    clearPick();
    audioStop();
    assembly.seek(1);
    applyCompleteUi();
  };

  const syncDebugPauseLabel = () => {
    ui.setDebugPaused(assembly.isPaused() || assemblyComplete);
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
      // Free-look / director: keep framing while assembly continues.
      // No prior orbit: resume snaps back onto the cinematic path.
      const preserveCamera =
        ui.isDirectorMode() || assembly.userOwnsCamera();
      applyAssemblyUi({ preserveTarget: preserveCamera });
      assembly.resume({ preserveCamera });
      audioPlayFromProgress(assembly.getProgress());
    }
    syncDebugPauseLabel();
  };

  const seek = (p: number) => {
    // Scrub invalidates overlay parents / visibility — drop selection
    clearPick();
    // After free-look orbit, scrub plates only — never steal framing
    const preserveCamera = assembly.userOwnsCamera();
    audioStop();
    assembly.seek(p, { preserveCamera });
    audioPlayhead(p);
    syncDebugPauseLabel();
    if (p >= 0.999) {
      applyCompleteUi({ preserveCamera });
    } else {
      // Scrub pauses the timeline — allow look-around at that frame
      applyAssemblyUi({ preserveTarget: preserveCamera });
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
      audioPlayhead(assembly.getProgress());
    }
    audioTimeline?.setVisible(enabled);
    refreshHintCopy();
  });

  // Panel chrome follows director preference; audio duration always tracked.
  audioTimeline?.setVisible(ui.isDirectorMode());
  syncAudioDuration();

  audioTimeline?.onSeek((p) => {
    seek(p);
  });

  ui.onDebugSeek((p) => {
    seek(p);
  });

  ui.onDebugTogglePause(() => {
    togglePause();
  });

  /**
   * Call each frame after controls.update(). Accumulates yaw while the
   * finished suit auto-rotates; after a full turn, replays the assembly.
   */
  const update = () => {
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
