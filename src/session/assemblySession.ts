import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createAssemblyTimeline,
  type AssemblyController,
} from '../animation/assemblyTimeline';
import type { Suit } from '../suit/Suit';
import type { OverlayHandles } from '../ui/overlay';

const VIEWER_HINT =
  'Drag to orbit (pause/end) · R replay · Space pause · S skip';
const DIRECTOR_HINT =
  'Drag to orbit (pause/end) · click plate (path) · R replay · Space · S skip';

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

  const refreshHintCopy = () => {
    const hintEl = document.getElementById('hint');
    if (hintEl) {
      hintEl.textContent = ui.isDirectorMode() ? DIRECTOR_HINT : VIEWER_HINT;
    }
  };

  /** Free-look when finished or paused/scrubbed; locked while GSAP drives the camera. */
  const setOrbitMode = (mode: 'locked' | 'free' | 'complete') => {
    if (mode === 'locked') {
      controls.enabled = false;
      controls.autoRotate = false;
      return;
    }
    controls.target.copy(lookTarget);
    controls.enabled = true;
    controls.autoRotate = mode === 'complete';
  };

  const applyCompleteUi = () => {
    assemblyComplete = true;
    suit.showFinal(); // seamless mesh — no grid-shard square blooms
    setOrbitMode('complete');
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

  const applyAssemblyUi = (opts?: { freeLook?: boolean }) => {
    assemblyComplete = false;
    setOrbitMode(opts?.freeLook ? 'free' : 'locked');
    ui.setReplayEnabled(false);
    ui.setSkipEnabled(true);
    ui.setHintVisible(false);
    ui.fadeTitle(false);
  };

  const assembly = createAssemblyTimeline(suit, camera, lookTarget, {
    onStatus: (text) => {
      const online = text.includes('ONLINE') || text.includes('STABLE');
      ui.setStatus(text, online);
    },
    onProgress: (t) => {
      const pct = Math.round(t * 100);
      ui.setIntegrity(`INTEGRITY ${String(pct).padStart(3, ' ')}%`);
      ui.setDebugProgress(t);
      if (t < 0.999 && assemblyComplete) {
        // Scrubbed back from the end
        applyAssemblyUi();
      }
    },
    onActivePieces: (pieces) => {
      ui.setDebugActivePieces(pieces);
    },
    onComplete: () => {
      applyCompleteUi();
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
      // Inspect mid-assembly: free orbit while paused
      setOrbitMode('free');
    } else if (assemblyComplete || assembly.getProgress() >= 0.999) {
      startSequence();
      return;
    } else {
      // Resume cinematic camera path (drops free-look offset)
      applyAssemblyUi({ freeLook: false });
      assembly.resume();
    }
    syncDebugPauseLabel();
  };

  const seek = (p: number) => {
    // Scrub invalidates overlay parents / visibility — drop selection
    clearPick();
    assembly.seek(p);
    syncDebugPauseLabel();
    if (p >= 0.999) {
      applyCompleteUi();
    } else {
      // Scrub pauses the timeline — allow look-around at that frame
      applyAssemblyUi({ freeLook: true });
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

  return {
    startSequence,
    skipToEnd,
    togglePause,
    seek,
    assembly,
    isComplete: () => assemblyComplete,
    getClockStart: () => clockStart,
    setClockStart: (t: number) => {
      clockStart = t;
    },
    refreshHintCopy,
  };
}
