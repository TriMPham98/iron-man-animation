import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Suit } from '../suit/Suit';
import type { ArmorPiece } from '../suit/waves';
import type { AudioTimelinePanel } from './audioTimelinePanel';
import type { OverlayHandles } from './overlay';

export interface BindInputOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  suit: Suit;
  ui: OverlayHandles;
  controls: OrbitControls;
  pick: {
    clear: () => void;
    apply: (root: THREE.Object3D, piece?: ArmorPiece | null) => void;
  };
  session: {
    startSequence: () => void;
    skipToEnd: () => void;
    togglePause: () => void;
    seek: (progress01: number) => void;
    /** Wall-clock scrub across full GSAP cycle (incl. camera tail). */
    scrubBySeconds: (deltaSec: number) => void;
    isComplete: () => boolean;
    assembly?: {
      setUserOwnsCamera: (owns: boolean) => void;
      getProgress: () => number;
      getTime?: () => number;
    };
  };
  /** Assembly SFX mute (M) + full-cycle loop (L) hotkeys. */
  audioTimeline?: Pick<AudioTimelinePanel, 'toggleMute' | 'toggleLoop'> | null;
}

/**
 * ←/→ scrub step in wall-clock seconds (not integrity %).
 * Integrity plateaus at systems online; time steps keep moving through the
 * hero pullback. Shift = coarse.
 */
const SCRUB_STEP_SEC = 0.05;
const SCRUB_STEP_COARSE_SEC = 0.25;

/**
 * Keyboard (R / S / Space / ← →) + director pointer pick raycast.
 * Ignores picks after drag so orbit does not select a plate.
 */
export function bindInput(options: BindInputOptions): void {
  const { canvas, camera, suit, ui, controls, pick, session, audioTimeline } =
    options;

  // Fast raycast → piece lookup (mesh.uuid → piece)
  const pieceByMeshUuid = new Map<string, ArmorPiece>();
  for (const piece of suit.pieces) {
    piece.mesh.userData.pieceId = piece.id;
    piece.mesh.traverse((obj) => {
      pieceByMeshUuid.set(obj.uuid, piece);
    });
  }

  const isTypingTarget = (target: EventTarget | null): boolean => {
    const tag = (target as HTMLElement | null)?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON';
  };

  window.addEventListener('keydown', (e) => {
    // Browser / OS chords (⌘R refresh, ⌃S, ⌥←, etc.) must not steal hotkeys.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // M — toggle assembly SFX (allowed before INITIATE so hangar can stay quiet)
    if ((e.key === 'm' || e.key === 'M') && !e.repeat) {
      if (isTypingTarget(e.target)) return;
      if (!audioTimeline) return;
      e.preventDefault();
      const muted = audioTimeline.toggleMute();
      ui.showToast(muted ? 'AUDIO MUTED' : 'AUDIO ON');
      return;
    }

    // L — toggle full-cycle loop (preference can be set before INITIATE)
    if ((e.key === 'l' || e.key === 'L') && !e.repeat) {
      if (isTypingTarget(e.target)) return;
      if (!audioTimeline) return;
      e.preventDefault();
      const looping = audioTimeline.toggleLoop();
      ui.showToast(looping ? 'LOOP ON' : 'LOOP OFF');
      return;
    }

    // Until INITIATE, ignore transport hotkeys. R during load used to call
    // startSequence() while the gate was still pending, so assembly ran with
    // the INITIATE orb still on screen.
    if (!ui.hasInitiated()) return;

    // ← / → — scrub full sequence by wall-clock seconds (Shift = coarser).
    // Key-repeat is intentional so holding an arrow keeps scrubbing.
    // Must not use integrity progress: that hits 1.0 at systems online and
    // the next right-arrow used to jump to complete / end of timeline.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      const step = e.shiftKey ? SCRUB_STEP_COARSE_SEC : SCRUB_STEP_SEC;
      const delta = e.key === 'ArrowLeft' ? -step : step;
      session.scrubBySeconds(delta);
      return;
    }

    // Held keys re-fire keydown — would spam replay / pause / skip and wreck timing.
    if (e.repeat) return;

    if (e.key === 'r' || e.key === 'R') {
      if (isTypingTarget(e.target)) return;
      session.startSequence();
      return;
    }
    if (e.key === 's' || e.key === 'S') {
      if (isTypingTarget(e.target)) return;
      if (!session.isComplete()) {
        e.preventDefault();
        session.skipToEnd();
      }
      return;
    }
    // Space — pause / resume (ignore when typing in inputs)
    if (e.code === 'Space' || e.key === ' ') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      session.togglePause();
      return;
    }

    // Director reclass: A add · [ ] cycle target wave
    if (!ui.isDirectorMode()) return;
    if (isTypingTarget(e.target)) return;
    if (e.repeat) return;
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      ui.addReclassEntry();
      return;
    }
    if (e.key === ']' || e.key === '[') {
      e.preventDefault();
      ui.cycleReclassTargetWave(e.key === ']' ? 1 : -1);
    }
  });

  // Wheel dolly fires OrbitControls 'start' without a pointer-drag. Claiming
  // free-look on zoom used to yank the cinematic camera (and cancel the
  // showcase orbit) whenever the user scrolled.
  let pointerOrbitIntent = false;
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button === 0) pointerOrbitIntent = true;
    },
    true,
  );
  const clearPointerOrbitIntent = () => {
    pointerOrbitIntent = false;
  };
  window.addEventListener('pointerup', clearPointerOrbitIntent, true);
  window.addEventListener('pointercancel', clearPointerOrbitIntent, true);

  controls.addEventListener('start', () => {
    if (!pointerOrbitIntent) return;
    // User take-over stops idle spin (complete mode); free-look while paused has no spin
    if (controls.autoRotate) controls.autoRotate = false;
    // Orbit detaches from the cinematic path. Scrubbing the audio timeline
    // (or ←/→) re-attaches via session.seek → preserveCamera: false.
    session.assembly?.setUserOwnsCamera(true);
  });

  // ── Director raycast pick (click plate → scrubber + highlight) ─
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  /** Ignore picks after drag so orbit doesn't select. */
  const CLICK_MAX_MOVE_PX = 5;
  let pointerDownPos: { x: number; y: number } | null = null;

  const resolvePiece = (obj: THREE.Object3D): ArmorPiece | null => {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData.isPickHighlight) {
        cur = cur.parent;
        continue;
      }
      const hit = pieceByMeshUuid.get(cur.uuid);
      if (hit) return hit;
      cur = cur.parent;
    }
    return null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointerDownPos = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    pointerDownPos = null;
    if (dx * dx + dy * dy > CLICK_MAX_MOVE_PX * CLICK_MAX_MOVE_PX) return;

    // Plate pick is director-only (clean viewer surface)
    if (!ui.isDirectorMode()) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);

    // Prefer fly-in shards; fall back to seamless final mesh
    const shardRoots = suit.pieces
      .filter((p) => p.mesh.visible)
      .map((p) => p.mesh);
    let hits = raycaster.intersectObjects(shardRoots, true);

    if (hits.length === 0 && !suit.isAssemblyMode()) {
      hits = raycaster
        .intersectObject(suit.group, true)
        .filter((h) => !h.object.userData.isPickHighlight);
      if (hits.length > 0) {
        const obj = hits[0].object;
        // Final seamless mesh has no per-shard flight path
        pick.apply(obj, null);
        ui.setReclassPick(null);
        ui.setDebugPickedPiece({
          id: obj.name || 'final-mesh',
          wave: 'power',
          meshName: obj.name,
          visible: obj.visible,
          note: 'seamless final suit',
        });
        return;
      }
    }

    if (hits.length === 0) {
      // Clicked empty space — clear selection
      pick.clear();
      ui.setDebugPickedPiece(null);
      ui.setReclassPick(null);
      return;
    }

    const piece = resolvePiece(hits[0].object);
    if (!piece) {
      const obj = hits[0].object;
      pick.apply(obj, null);
      ui.setReclassPick(null);
      ui.setDebugPickedPiece({
        id: obj.name || obj.uuid.slice(0, 8),
        wave: 'power',
        meshName: obj.name,
        visible: obj.visible,
        note: 'unmapped mesh',
      });
      return;
    }

    pick.apply(piece.mesh, piece);
    ui.setReclassPick(piece);
    ui.setDebugPickedPiece({
      id: piece.id,
      wave: piece.wave,
      meshName: piece.mesh.name,
      visible: piece.mesh.visible,
      rest: {
        x: piece.restPosition.x,
        y: piece.restPosition.y,
        z: piece.restPosition.z,
      },
      note: piece.mesh.userData.flightPathKeys
        ? 'flight path shown'
        : undefined,
    });
  });
}
