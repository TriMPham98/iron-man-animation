import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createAssemblyTimeline,
  type AssemblyController,
} from '../animation/assemblyTimeline';
import type { Suit } from '../suit/Suit';
import type { OverlayHandles } from '../ui/overlay';

const VIEWER_HINT =
  'Drag to orbit · R replay · Space pause · S skip · ←→ scrub';
const DIRECTOR_HINT =
  'Drag to orbit · click plate (path) · ←→ scrub · R · Space · S';

export interface AssemblySessionOptions {
  suit: Suit;
  camera: THREE.PerspectiveCamera;
  lookTarget: THREE.Vector3;
  controls: OrbitControls;
  ui: OverlayHandles;
  clock: THREE.Clock;
  reducedMotion: boolean;
  onClearPick: () => void;
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
  } = options;

  let assemblyComplete = false;
  let clockStart = 0;

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

  const applyCompleteUi = (opts?: { preserveCamera?: boolean }) => {
    assemblyComplete = true;
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
    refreshHintCopy();
  };

  const applyAssemblyUi = (opts?: { preserveTarget?: boolean }) => {
    assemblyComplete = false;
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

  const clearPick = () => {
    onClearPick();
    ui.setDebugPickedPiece(null);
  };

  const finishInstantly = () => {
    clearPick();
    assembly.seek(1);
    applyCompleteUi();
    clockStart = clock.getElapsedTime();
  };

  const startSequence = () => {
    clearPick();

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
    assembly.play();
    clockStart = clock.getElapsedTime();
  };

  const skipToEnd = () => {
    if (assemblyComplete) return;
    clearPick();
    assembly.seek(1);
    applyCompleteUi();
  };

  const syncDebugPauseLabel = () => {
    ui.setDebugPaused(assembly.isPaused() || assemblyComplete);
  };

  const togglePause = () => {
    if (assembly.isPlaying()) {
      assembly.pause();
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
    }
    syncDebugPauseLabel();
  };

  const seek = (p: number) => {
    // Scrub invalidates overlay parents / visibility — drop selection
    clearPick();
    // After free-look orbit, scrub plates only — never steal framing
    const preserveCamera = assembly.userOwnsCamera();
    assembly.seek(p, { preserveCamera });
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
    }
    refreshHintCopy();
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
    getClockStart: () => clockStart,
    setClockStart: (t: number) => {
      clockStart = t;
    },
    refreshHintCopy,
  };
}
