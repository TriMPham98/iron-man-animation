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

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('Canvas not found');

  const ui = createOverlay();
  ui.setLoadingProgress(0.05);
  ui.setStatus('LOADING SUIT MESH…');

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

  const applyCompleteUi = () => {
    assemblyComplete = true;
    suit.showFinal(); // seamless mesh — no grid-shard square blooms
    controls.target.copy(lookTarget);
    controls.enabled = true;
    controls.autoRotate = true;
    ui.setReplayEnabled(true);
    ui.setHintVisible(true);
    ui.fadeTitle(true);
    ui.setIntegrity('INTEGRITY 100%');
    ui.setStatus('SYSTEMS ONLINE', true);
    ui.setDebugProgress(1);
    ui.setDebugPaused(true);
    ui.setDebugActivePieces([]);
  };

  const applyAssemblyUi = () => {
    assemblyComplete = false;
    controls.enabled = false;
    controls.autoRotate = false;
    ui.setReplayEnabled(false);
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

  const startSequence = () => {
    applyAssemblyUi();
    ui.setIntegrity('INTEGRITY   0%');
    ui.setStatus('ASSEMBLY SEQUENCE INITIATED');
    ui.setDebugProgress(0);
    ui.setDebugPaused(false);
    assembly.rebuild();
    assembly.play();
    clockStart = clock.getElapsedTime();
  };

  const syncDebugPauseLabel = () => {
    ui.setDebugPaused(assembly.isPaused() || assemblyComplete);
  };

  ui.onReplay(() => {
    startSequence();
  });

  ui.onDebugSeek((p) => {
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
    if (assembly.isPlaying()) {
      assembly.pause();
    } else if (assemblyComplete || assembly.getProgress() >= 0.999) {
      // Restart from beginning when already finished
      startSequence();
      return;
    } else {
      applyAssemblyUi();
      assembly.resume();
    }
    syncDebugPauseLabel();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      startSequence();
      return;
    }
    // Space — pause / resume (ignore when typing in inputs)
    if (e.code === 'Space' || e.key === ' ') {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
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
    }
  });

  controls.addEventListener('start', () => {
    if (assemblyComplete) controls.autoRotate = false;
  });

  // ── Debug raycast pick (click plate → show in scrubber) ─────────
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
      hits = raycaster.intersectObject(suit.group, true);
      if (hits.length > 0) {
        const obj = hits[0].object;
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
      ui.setDebugPickedPiece(null);
      return;
    }

    const piece = resolvePiece(hits[0].object);
    if (!piece) {
      ui.setDebugPickedPiece({
        id: hits[0].object.name || hits[0].object.uuid.slice(0, 8),
        wave: 'power',
        meshName: hits[0].object.name,
        visible: hits[0].object.visible,
        note: 'unmapped mesh',
      });
      return;
    }

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
  ui.showDebugScrubber();
  await new Promise((r) => setTimeout(r, 400));

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
