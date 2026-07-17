import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createAssemblyTimeline,
  type AssemblyController,
} from '../animation/assemblyTimeline';
import type { Suit } from '../suit/Suit';
import type { OverlayHandles } from '../ui/overlay';

const VIEWER_HINT = 'Drag to orbit · R replay · Space pause · S skip';
const DIRECTOR_HINT =
  'Drag to orbit · click plate · R replay · Space pause · S skip';

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

  const applyCompleteUi = () => {
    assemblyComplete = true;
    suit.showFinal(); // seamless mesh — no grid-shard square blooms
    controls.target.copy(lookTarget);
    controls.enabled = true;
    controls.autoRotate = true;
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

  const applyAssemblyUi = () => {
    assemblyComplete = false;
    controls.enabled = false;
    controls.autoRotate = false;
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
    } else if (assemblyComplete || assembly.getProgress() >= 0.999) {
      startSequence();
      return;
    } else {
      applyAssemblyUi();
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
      applyAssemblyUi();
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
