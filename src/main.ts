import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCamera, updateCameraAspect } from './scene/createCamera';
import { createEnvironment } from './scene/createEnvironment';
import { createLights } from './scene/createLights';
import { createPostProcessing } from './scene/postProcessing';
import { createRenderer } from './scene/createRenderer';
import { applyStudioEnvironment } from './scene/createStudioEnv';
import { createAssemblySession } from './session/assemblySession';
import { Suit } from './suit/Suit';
import { bindInput } from './ui/bindInput';
import { installButtonFocusRelease } from './ui/blurButtons';
import { cueAtSeedTime } from './audio/binaryInterfaceCues';
import { createAudioTimelinePanel } from './ui/audioTimelinePanel';
import {
  JARVIS_STARTUP_FILE,
  JARVIS_STARTUP_SEC,
  JARVIS_STARTUP_VOICE_ID,
} from './audio/jarvisStartup';
import { installJarvisCursor } from './ui/jarvisCursor';
import { createOverlay } from './ui/overlay';
import { createPickHighlight } from './ui/pickHighlight';
import { prefersReducedMotion } from './ui/viewerMode';

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('Canvas not found');

  // Don't leave buttons focused after a tap (Space would re-trigger them).
  installButtonFocusRelease();
  // Cyan holographic reticle (fine-pointer desktops only).
  installJarvisCursor();

  const ui = createOverlay();
  ui.setLoadingProgress(0.05);

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
  });
  ui.setLoadingProgress(0.85);

  // ── Phase 2: build scene off-screen (#app still hidden) ──────────
  // Full fidelity: max DPR 1.75, full-res bloom (software GL still skips bloom).
  const renderer = createRenderer(canvas, { maxPixelRatio: 1.75 });
  const scene = new THREE.Scene();
  const camera = createCamera();
  const lookTarget = new THREE.Vector3(0, 0.95, 0);

  createEnvironment(scene);
  const lights = createLights();
  scene.add(lights.group);
  applyStudioEnvironment(renderer, scene);
  scene.add(suit.group);

  const pick = createPickHighlight(scene);

  const post = createPostProcessing(renderer, scene, camera);

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
  // Showcase orbit is driven in assemblySession.update (not OrbitControls.autoRotate).
  controls.autoRotate = false;
  controls.autoRotateSpeed = 1.0;

  ui.setLoadingProgress(0.95);

  const clock = new THREE.Clock();

  const audioTimeline = createAudioTimelinePanel();

  const session = createAssemblySession({
    suit,
    camera,
    lookTarget,
    controls,
    ui,
    clock,
    reducedMotion,
    onClearPick: () => pick.clear(),
    audioTimeline,
  });

  bindInput({
    canvas,
    camera,
    suit,
    ui,
    controls,
    pick,
    session,
    audioTimeline,
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

    const delta = clock.getDelta();

    // Showcase orbit owns the camera on those frames — skip OrbitControls
    // so damping / spherical rebuild cannot fight or dilute the yaw.
    const showcaseOrbiting = session.update(delta);

    // Camera ownership (scrub ↔ orbit):
    // - Path mode while playing: OrbitControls keeps distance/angles so the
    //   composition tracks lookTarget (pure GSAP poses read differently).
    // - Path mode while paused/scrubbed: do NOT call controls.update —
    //   minDistance / polar clamps yank the camera off close ECU / early
    //   pullback poses (visible jerk on ←/→ after systems online).
    // - Free-look (userOwnsCamera): orbit owns target + position.
    // Scrub re-attaches to path; viewport drag detaches (bindInput).
    if (controls.enabled && !showcaseOrbiting) {
      const ownsCamera = session.assembly.userOwnsCamera();
      if (ownsCamera) {
        controls.update(delta);
        lookTarget.copy(controls.target);
      } else {
        controls.target.copy(lookTarget);
        if (session.assembly.isPlaying()) {
          controls.update(delta);
        }
      }
    }

    // Timeline-synced HUD clock (scrub-aware; keeps counting after complete).
    const seedSec = session.getHudElapsed();
    ui.updateClock(seedSec);
    // Bottom BCI ticker — always locked to the chirp/beep cue sheet (seed clock).
    // Top panel soft-leaves after SYSTEMS ONLINE independently.
    if (!reducedMotion) {
      const cue = cueAtSeedTime(seedSec);
      if (cue) ui.setTelemetry(cue.line, { kind: cue.kind });
      else ui.setTelemetry(null);
    }
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

  // Hangar idle until the user initiates (JARVIS cyan CTA).
  // Space / Enter / R / click all fire once; later loops use auto-replay.
  // Unlock audio in the gesture turn — assembly start is delayed for the
  // orb exit, and browsers drop autoplay permission across setTimeout.
  //
  // JARVIS startup VO is a one-shot on INITIATE (not the director timeline).
  // Fully warm the element before the gate appears so play() is not deferred
  // to canplay (which runs outside the user-gesture window and is intermittent).
  let jarvisStartupDur = JARVIS_STARTUP_SEC;
  await Promise.all([
    audioTimeline.engine.warm(JARVIS_STARTUP_FILE),
    audioTimeline.engine.probeDuration(JARVIS_STARTUP_FILE).then((d) => {
      if (d > 0.05) jarvisStartupDur = d;
    }),
  ]);

  ui.onStartGesture(() => {
    // Both calls stay synchronous in the gesture turn (no await).
    void audioTimeline.engine.unlock();
    audioTimeline.engine.play({
      id: JARVIS_STARTUP_VOICE_ID,
      file: JARVIS_STARTUP_FILE,
      offset: 0,
      duration: jarvisStartupDur,
      volume: 1,
      fadeIn: 0.02,
      fadeOut: 0.12,
    });
  });
  ui.onStart(() => {
    session.setClockStart(clock.getElapsedTime());
    session.startSequence();
  });
  ui.showStartGate();
  loop();
}

boot().catch((err) => {
  console.error(err);
  const loading = document.getElementById('loading');
  if (loading) {
    loading.setAttribute('aria-busy', 'false');
    const label = document.getElementById('loading-label');
    if (label) {
      label.textContent = 'FAILED TO INIT — SEE CONSOLE';
      label.classList.add('is-ready');
    } else {
      loading.innerHTML =
        '<p style="color:#c9a227;font-family:monospace;letter-spacing:0.15em">FAILED TO INIT — SEE CONSOLE</p>';
    }
  }
});
