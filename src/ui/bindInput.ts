import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Suit } from '../suit/Suit';
import type { ArmorPiece } from '../suit/waves';
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
    isComplete: () => boolean;
    assembly?: {
      setUserOwnsCamera: (owns: boolean) => void;
    };
  };
}

/**
 * Keyboard (R / S / Space) + director pointer pick raycast.
 * Ignores picks after drag so orbit does not select a plate.
 */
export function bindInput(options: BindInputOptions): void {
  const { canvas, camera, suit, ui, controls, pick, session } = options;

  // Fast raycast → piece lookup (mesh.uuid → piece)
  const pieceByMeshUuid = new Map<string, ArmorPiece>();
  for (const piece of suit.pieces) {
    piece.mesh.userData.pieceId = piece.id;
    piece.mesh.traverse((obj) => {
      pieceByMeshUuid.set(obj.uuid, piece);
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      session.startSequence();
      return;
    }
    if (e.key === 's' || e.key === 'S') {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!session.isComplete()) {
        e.preventDefault();
        session.skipToEnd();
      }
      return;
    }
    // Space — pause / resume (ignore when typing in inputs)
    if (e.code === 'Space' || e.key === ' ') {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
      session.togglePause();
    }
  });

  controls.addEventListener('start', () => {
    // User take-over stops idle spin (complete mode); free-look while paused has no spin
    if (controls.autoRotate) controls.autoRotate = false;
    // Free-look orbit claims the camera — scrub/resume must not snap to cinematic path
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
      return;
    }

    const piece = resolvePiece(hits[0].object);
    if (!piece) {
      const obj = hits[0].object;
      pick.apply(obj, null);
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
