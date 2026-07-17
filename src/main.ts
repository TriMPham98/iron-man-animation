import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCamera, updateCameraAspect } from './scene/createCamera';
import { createEnvironment } from './scene/createEnvironment';
import { createLights } from './scene/createLights';
import { createPostProcessing } from './scene/postProcessing';
import { createRenderer } from './scene/createRenderer';
import { applyStudioEnvironment } from './scene/createStudioEnv';
import {
  halfResBloomForTier,
  maxPixelRatioForTier,
  preferBloomForTier,
  resolveQualityTier,
} from './scene/quality';
import { createAssemblySession } from './session/assemblySession';
import { Suit } from './suit/Suit';
import { bindInput } from './ui/bindInput';
import { createOverlay } from './ui/overlay';
import { createPickHighlight } from './ui/pickHighlight';
import { prefersReducedMotion } from './ui/viewerMode';

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('Canvas not found');

  const quality = resolveQualityTier();
  console.log(`[quality] tier=${quality}`);

  const ui = createOverlay();
  ui.setLoadingProgress(0.05);
  ui.setStatus('LOADING SUIT MESH…');

  const reducedMotion = prefersReducedMotion();
  if (reducedMotion) {
    document.body.classList.add('reduced-motion');
  }

  // ── Phase 1: HTML loader only ────────────────────────────────────
  // Do NOT create a WebGL context on the page canvas yet. On many GPUs the
  // hangar clear color + floor paint through the loader as a gray band that
  // grows with setSize — that is the “resizing gray section” on refresh.
  ui.setLoadingProgress(0.1);
  const suit = await Suit.create((r) => {
    ui.setLoadingProgress(0.1 + r * 0.7);
  }, quality);
  ui.setLoadingProgress(0.85);

  // ── Phase 2: build scene off-screen (#app still hidden) ──────────
  const renderer = createRenderer(canvas, {
    maxPixelRatio: maxPixelRatioForTier(quality),
  });
  const scene = new THREE.Scene();
  const camera = createCamera();
  const lookTarget = new THREE.Vector3(0, 0.95, 0);

  createEnvironment(scene);
  const lights = createLights();
  scene.add(lights.group);
  applyStudioEnvironment(renderer, scene);
  scene.add(suit.group);

  const pick = createPickHighlight();

  const post = createPostProcessing(renderer, scene, camera, {
    preferBloom: preferBloomForTier(quality),
    halfResBloom: halfResBloomForTier(quality),
  });

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

  ui.setLoadingProgress(0.95);

  const clock = new THREE.Clock();

  const session = createAssemblySession({
    suit,
    camera,
    lookTarget,
    controls,
    ui,
    clock,
    reducedMotion,
    onClearPick: () => pick.clear(),
  });

  bindInput({
    canvas,
    camera,
    suit,
    ui,
    controls,
    pick,
    session,
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

    if (session.isComplete()) {
      controls.update();
      lookTarget.copy(controls.target);
    }

    ui.updateClock(Math.max(0, t - session.getClockStart()));
    post.render(delta);
  };

  ui.setLoadingProgress(1);

  // ── Phase 3: crossfade HTML loader → scene ───────────────────────
  // Pre-render one frame while #app is still hidden so the first visible
  // frame is complete, then reveal and fade the loader.
  post.render();

  document.body.classList.add('scene-ready');
  ui.hideLoading();
  ui.showHud();
  ui.syncDirectorChrome();
  session.refreshHintCopy();

  await new Promise((r) => setTimeout(r, reducedMotion ? 80 : 200));

  session.setClockStart(clock.getElapsedTime());
  session.startSequence();
  loop();
}

boot().catch((err) => {
  console.error(err);
  const loading = document.getElementById('loading');
  if (loading) {
    loading.innerHTML = `<p style="color:#c9a227;font-family:monospace;letter-spacing:0.15em">FAILED TO INIT — SEE CONSOLE</p>`;
  }
});
