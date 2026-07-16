import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createAssemblyTimeline } from './animation/assemblyTimeline';
import { createCamera, updateCameraAspect } from './scene/createCamera';
import { createEnvironment } from './scene/createEnvironment';
import { createLights } from './scene/createLights';
import { createPostProcessing } from './scene/postProcessing';
import { createRenderer } from './scene/createRenderer';
import { Suit } from './suit/Suit';
import { createOverlay } from './ui/overlay';
import { prefersReducedMotion } from './ui/viewerMode';

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('Canvas not found');

  const ui = createOverlay();
  ui.setLoadingProgress(0.05);
  ui.setStatus('LOADING SUIT MESH…');

  const reducedMotion = prefersReducedMotion();
  if (reducedMotion) {
    document.body.classList.add('reduced-motion');
  }

  const renderer = createRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = createCamera();
  const lookTarget = new THREE.Vector3(0, 0.95, 0);

  createEnvironment(scene);
  const lights = createLights();
  scene.add(lights.group);

  // Studio env with warm keys so gold metal keeps color in reflections
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0a0e18);
  envScene.add(new THREE.HemisphereLight(0xc0d4f0, 0x1a1018, 1.8));
  const envKey = new THREE.DirectionalLight(0xfff2dc, 4.0);
  envKey.position.set(3, 8, 2);
  envScene.add(envKey);
  const envKey2 = new THREE.DirectionalLight(0xffe8c8, 2.4);
  envKey2.position.set(-2, 4, 5);
  envScene.add(envKey2);
  const envRim = new THREE.DirectionalLight(0x66d0e8, 2.2);
  envRim.position.set(-5, 3, -3);
  envScene.add(envRim);
  const envHot = new THREE.DirectionalLight(0xfff0e0, 2.8);
  envHot.position.set(0, 2, 6);
  envScene.add(envHot);
  const envMap = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 1.15;
  pmrem.dispose();

  ui.setLoadingProgress(0.15);

  const suit = await Suit.create((r) => {
    ui.setLoadingProgress(0.15 + r * 0.55);
  });
  scene.add(suit.group);

  // Fast raycast → piece lookup (mesh.uuid → piece)
  const pieceByMeshUuid = new Map<string, (typeof suit.pieces)[number]>();
  for (const piece of suit.pieces) {
    piece.mesh.userData.pieceId = piece.id;
    piece.mesh.traverse((obj) => {
      pieceByMeshUuid.set(obj.uuid, piece);
    });
  }

  /** Highlight overlays (shared materials → can't recolor source mats). */
  const pickHighlights: THREE.Object3D[] = [];

  const disposePickHighlight = (obj: THREE.Object3D) => {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry && mesh.userData.pickOwnedGeometry) {
        mesh.geometry.dispose();
      }
      const mats = mesh.material
        ? Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]
        : [];
      for (const m of mats) {
        if (m && (m as THREE.Material).userData?.pickOwnedMaterial) {
          m.dispose();
        }
      }
    });
  };

  const clearPickHighlight = () => {
    for (const h of pickHighlights) {
      h.parent?.remove(h);
      disposePickHighlight(h);
    }
    pickHighlights.length = 0;
  };

  const applyPickHighlight = (root: THREE.Object3D) => {
    clearPickHighlight();

    // Snapshot meshes first — adding children during traverse would re-enter
    // on the new shell/edge meshes and blow the call stack.
    const targets: THREE.Mesh[] = [];
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (mesh.userData.isPickHighlight) return;
      targets.push(mesh);
    });

    for (const mesh of targets) {
      // Cyan edge outline
      const edges = new THREE.EdgesGeometry(mesh.geometry, 28);
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x7ee8ff,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
      });
      edgeMat.userData.pickOwnedMaterial = true;
      const lines = new THREE.LineSegments(edges, edgeMat);
      lines.name = '__pickHighlight';
      lines.userData.isPickHighlight = true;
      lines.userData.pickOwnedGeometry = true;
      lines.renderOrder = 999;
      lines.raycast = () => {};
      mesh.add(lines);
      pickHighlights.push(lines);

      // Soft gold fill so the plate reads as selected
      const shellMat = new THREE.MeshBasicMaterial({
        color: 0xe8c547,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      shellMat.userData.pickOwnedMaterial = true;
      const shell = new THREE.Mesh(mesh.geometry, shellMat);
      shell.name = '__pickHighlightShell';
      shell.userData.isPickHighlight = true;
      shell.renderOrder = 998;
      shell.scale.setScalar(1.012);
      shell.raycast = () => {};
      mesh.add(shell);
      pickHighlights.push(shell);
    }
  };

  ui.setLoadingProgress(0.75);

  const post = createPostProcessing(renderer, scene, camera, true);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 1.8;
  controls.maxDistance = 6.5;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.target.copy(lookTarget);
  controls.enabled = false;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.6;

  ui.setLoadingProgress(0.9);

  let assemblyComplete = false;
  let clockStart = 0;
  const clock = new THREE.Clock();

  const viewerHint = 'Drag to orbit · R replay · Space pause · S skip';
  const directorHint =
    'Drag to orbit · click plate · R replay · Space pause · S skip';

  const refreshHintCopy = () => {
    const hintEl = document.getElementById('hint');
    if (hintEl) {
      hintEl.textContent = ui.isDirectorMode() ? directorHint : viewerHint;
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

  const finishInstantly = () => {
    clearPickHighlight();
    ui.setDebugPickedPiece(null);
    assembly.seek(1);
    applyCompleteUi();
    clockStart = clock.getElapsedTime();
  };

  const startSequence = () => {
    clearPickHighlight();
    ui.setDebugPickedPiece(null);

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
    clearPickHighlight();
    ui.setDebugPickedPiece(null);
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

  ui.onReplay(() => {
    startSequence();
  });

  ui.onSkip(() => {
    skipToEnd();
  });

  ui.onDirectorModeChange((enabled) => {
    if (!enabled) {
      clearPickHighlight();
      ui.setDebugPickedPiece(null);
    }
    refreshHintCopy();
  });

  ui.onDebugSeek((p) => {
    // Scrub invalidates overlay parents / visibility — drop selection
    clearPickHighlight();
    ui.setDebugPickedPiece(null);
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
  });

  ui.onDebugTogglePause(() => {
    togglePause();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      startSequence();
      return;
    }
    if (e.key === 's' || e.key === 'S') {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!assemblyComplete) {
        e.preventDefault();
        skipToEnd();
      }
      return;
    }
    // Space — pause / resume (ignore when typing in inputs)
    if (e.code === 'Space' || e.key === ' ') {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
      togglePause();
    }
  });

  controls.addEventListener('start', () => {
    if (assemblyComplete) controls.autoRotate = false;
  });

  // ── Director raycast pick (click plate → scrubber + highlight) ─
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  /** Ignore picks after drag so orbit doesn't select. */
  const CLICK_MAX_MOVE_PX = 5;
  let pointerDownPos: { x: number; y: number } | null = null;

  const resolvePiece = (
    obj: THREE.Object3D,
  ): (typeof suit.pieces)[number] | null => {
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
        applyPickHighlight(obj);
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
      clearPickHighlight();
      ui.setDebugPickedPiece(null);
      return;
    }

    const piece = resolvePiece(hits[0].object);
    if (!piece) {
      const obj = hits[0].object;
      applyPickHighlight(obj);
      ui.setDebugPickedPiece({
        id: obj.name || obj.uuid.slice(0, 8),
        wave: 'power',
        meshName: obj.name,
        visible: obj.visible,
        note: 'unmapped mesh',
      });
      return;
    }

    applyPickHighlight(piece.mesh);
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
    });
  });

  const onResize = () => {
    updateCameraAspect(camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    post.resize(w, h);
  };
  window.addEventListener('resize', onResize);

  let raf = 0;
  let visible = true;

  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState === 'visible';
    if (visible) {
      clock.getDelta();
      loop();
    } else {
      cancelAnimationFrame(raf);
    }
  });

  const loop = () => {
    if (!visible) return;
    raf = requestAnimationFrame(loop);

    const t = clock.getElapsedTime();
    const delta = clock.getDelta();

    if (assemblyComplete) {
      controls.update();
      lookTarget.copy(controls.target);
      // Suit systems stay at steady emissive once online (no light pulse)
    }

    ui.updateClock(Math.max(0, t - clockStart));
    post.render(delta);
  };

  ui.setLoadingProgress(1);

  post.render();
  await new Promise((r) => setTimeout(r, 280));

  ui.hideLoading();
  ui.showHud();
  ui.syncDirectorChrome();
  refreshHintCopy();
  await new Promise((r) => setTimeout(r, reducedMotion ? 120 : 400));

  clockStart = clock.getElapsedTime();
  startSequence();
  loop();
}

boot().catch((err) => {
  console.error(err);
  const loading = document.getElementById('loading');
  if (loading) {
    loading.innerHTML = `<p style="color:#c9a227;font-family:monospace;letter-spacing:0.15em">FAILED TO INIT — SEE CONSOLE</p>`;
  }
});
