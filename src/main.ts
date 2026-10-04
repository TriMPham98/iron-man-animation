import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCamera, updateCameraAspect } from './scene/createCamera';
import { createEnvironment } from './scene/createEnvironment';
import { createLights } from './scene/createLights';
import { createPostProcessing } from './scene/postProcessing';
import { CONTACT_SHADOW_LAYER, createContactShadow } from './scene/contactShadow';
import { createAdaptiveResolution } from './scene/adaptiveResolution';
import { warmUp } from './scene/warmUp';
import { createRenderer } from './scene/createRenderer';
import { applyStudioEnvironment } from './scene/createStudioEnv';
import { createAssemblySession } from './session/assemblySession';
import { buildSuitUpPlan } from './animation/suitUpChoreography';
import { CRADLE_PORT_RADIUS, floorCradlePorts } from './workshop/cradleStands';
import { Workshop } from './workshop/Workshop';
import { ROBOT_RING_RADIUS } from './workshop/fittingProgram';
import { FOOT_HATCH_RADIUS, RING_HALF_WIDTH } from './workshop/workshopEnvironment';
import { Suit } from './suit/Suit';
import { SUIT_GROUND_CLEARANCE } from './suit/loadSuitModel';
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
import { SOUNDS } from './audio/sounds';
import { simplifierReady } from './utils/simplify';

/** Lit, opaque surfaces only — glows, holograms and FX cast no shadow. */
function isLitOpaque(mesh: THREE.Mesh): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.every((m) => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true && !m.transparent);
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('Canvas not found');

  // Don't leave buttons focused after a tap (Space would re-trigger them).
  installButtonFocusRelease();
  // Cyan holographic reticle (fine-pointer desktops only).
  installJarvisCursor();

  const ui = createOverlay();

  const reducedMotion = prefersReducedMotion();
  if (reducedMotion) {
    document.body.classList.add('reduced-motion');
  }

  // ── Phase 1: fetch everything in parallel (HTML loader only) ──────
  // Do NOT create a WebGL context on the page canvas yet. On many GPUs the
  // hangar clear color + floor paint through the loader as a gray band that
  // grows with setSize — that is the “resizing gray section” on refresh.
  //
  // Boot progress is a weighted sum of every task, so the eased bar moves
  // steadily from 0 to 100 instead of jumping between phases.
  const WEIGHTS = { fonts: 0.03, suit: 0.5, audio: 0.17, hangar: 0.1, gpu: 0.2 } as const;
  const done: Record<keyof typeof WEIGHTS, number> = { fonts: 0, suit: 0, audio: 0, hangar: 0, gpu: 0 };
  const report = (task: keyof typeof WEIGHTS, r: number, stage?: Parameters<typeof ui.setLoadingProgress>[1]) => {
    done[task] = Math.max(done[task], Math.min(1, r));
    let p = 0;
    for (const k of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) p += WEIGHTS[k] * done[k];
    ui.setLoadingProgress(p, stage);
  };
  report('fonts', 0, 'core');

  // HUD fonts first: the INITIATE label is fitted to its nucleus and would
  // jump when a late webfont swaps in mid-handoff
  const fonts = (async () => {
    try {
      await Promise.race([
        Promise.all([
          document.fonts.load('400 1em Michroma'),
          document.fonts.load('400 1em "JetBrains Mono"'),
          document.fonts.load('600 1em "JetBrains Mono"'),
        ]).then(() => document.fonts.ready),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {
      /* fall back to system fonts */
    }
    report('fonts', 1);
  })();

  // Every SFX clip buffered into the engine's warm pool alongside the mesh
  // download, so no cue in the sequence waits on the network
  const audioTimeline = createAudioTimelinePanel();
  let jarvisStartupDur = JARVIS_STARTUP_SEC;
  const audioFiles = [...new Set([JARVIS_STARTUP_FILE, ...SOUNDS.map((snd) => snd.file)])];
  let audioDone = 0;
  const audio = Promise.all([
    ...audioFiles.map((file) =>
      audioTimeline.engine.warm(file).then(() => report('audio', ++audioDone / audioFiles.length)),
    ),
    audioTimeline.engine.probeDuration(JARVIS_STARTUP_FILE).then((d) => {
      if (d > 0.05) jarvisStartupDur = d;
    }),
  ]);

  const suit = await Suit.create((r) => report('suit', r, r < 0.7 ? 'mesh' : undefined));
  await simplifierReady.catch(() => undefined);
  await fonts;
  report('hangar', 0, done.audio < 1 ? 'audio' : 'hangar');
  await audio;
  report('hangar', 0, 'hangar');

  // ── Phase 2: build scene off-screen (#app still hidden) ──────────
  // Full fidelity: max DPR 1.75, full-res bloom (software GL still skips bloom).
  const renderer = createRenderer(canvas, { maxPixelRatio: 1.75 });
  const scene = new THREE.Scene();
  const camera = createCamera();
  // Match suit feet clearance + HERO_END / OPEN_WIDE look height
  const lookTarget = new THREE.Vector3(0, 0.95 + SUIT_GROUND_CLEARANCE, 0);

  createEnvironment(
    scene,
    [
      // Centre boot hatch
      [0, 0, FOOT_HATCH_RADIUS + 0.005],
      // Flush ports the parts stands retract through
      ...floorCradlePorts().map(([x, z]) => [x, z, CRADLE_PORT_RADIUS] as [number, number, number]),
    ],
    // The concentric trench the floor arms rise from
    [[ROBOT_RING_RADIUS - RING_HALF_WIDTH, ROBOT_RING_RADIUS + RING_HALF_WIDTH]],
  );
  const lights = createLights();
  scene.add(lights.group);
  applyStudioEnvironment(renderer, scene);
  scene.add(suit.group);

  // Robot cell (arms, gantry, cradles, platform) shares the suit-up plan
  const plan = buildSuitUpPlan();
  const workshop = new Workshop(suit, plan);
  scene.add(workshop.group);

  // Contact shadow on the deck under the suit, the arms and the stands
  const contact = createContactShadow(renderer, scene, {
    y: SUIT_GROUND_CLEARANCE + 0.002,
    size: 5.6,
    height: 1.1,
    opacity: 0.95,
  });
  scene.add(contact.mesh);
  for (const root of [suit.group, ...workshop.shadowCasters()]) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && isLitOpaque(m)) m.layers.enable(CONTACT_SHADOW_LAYER);
    });
  }

  const pick = createPickHighlight(scene);

  // Half-res bloom mips: same soft glint, a fraction of the fill cost
  const post = createPostProcessing(renderer, scene, camera, { halfResBloom: true });

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

  report('hangar', 0.6);

  const clock = new THREE.Clock();
  const drawingBuffer = new THREE.Vector2();

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
    workshop,
    plan,
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
  // Trim / restore pixel ratio with the measured frame time
  const adaptive = createAdaptiveResolution(renderer, () => post.resize(window.innerWidth, window.innerHeight));

  let raf = 0;
  let visible = true;

  /** Opening dolly into the hangar framing (cancelled once INITIATE runs). */
  const introCam = (() => {
    let t = -1;
    const endPos = new THREE.Vector3();
    const startPos = new THREE.Vector3();
    const look = new THREE.Vector3();
    const DUR = 2.4;
    return {
      begin() {
        endPos.copy(camera.position);
        look.copy(lookTarget);
        const back = endPos.clone().sub(look).normalize();
        startPos.copy(endPos).addScaledVector(back, 0.9).add(new THREE.Vector3(0, 0.35, 0));
        camera.position.copy(startPos);
        camera.lookAt(look);
        t = 0;
      },
      update(dt: number) {
        if (t < 0) return;
        // INITIATE / camera ownership take over immediately
        if (session.assembly.isPlaying() || session.isComplete()) {
          t = -1;
          return;
        }
        t = Math.min(DUR, t + Math.min(dt, 0.05));
        const u = t / DUR;
        const e = 1 - Math.pow(1 - u, 3);
        camera.position.lerpVectors(startPos, endPos, e);
        camera.lookAt(look);
        if (t >= DUR) t = -1;
      },
    };
  })();

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
    adaptive.update(delta);
    introCam.update(delta);

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

    // Sparks / steam + hologram scanlines (pixel scale tracks lens + DPR)
    workshop.update(delta, renderer);
    renderer.getDrawingBufferSize(drawingBuffer);
    suit.update(
      delta,
      drawingBuffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)),
    );

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
    contact.update();
    post.render(delta);
  };

  // Compile every shader and upload every texture now (incl. the ones the
  // fitting / flight check / diagnostic use later) so nothing stalls mid-run
  report('hangar', 1, 'hud');
  suit.prepareDiagnosticScan();
  await warmUp(renderer, scene, camera, () => {
    // Also the workshop's off-screen scan view (its own scene)
    workshop.update(0, renderer);
    contact.update();
    post.render(0);
  });
  report('gpu', 0.75);

  // ── Phase 3: scene ready under the loader ────────────────────────
  // Show #app beneath an opaque veil and run the real loop for a few
  // frames: post-processing targets, adaptive resolution and the first
  // shadow / bloom passes all settle before anything is seen, so the
  // reveal's first visible frame is already a steady one.
  document.body.classList.add('scene-ready');
  ui.syncDirectorChrome();
  session.refreshHintCopy();
  loop();
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => setTimeout(r, 34));
    report('gpu', 0.75 + (i + 1) * 0.0625);
  }
  // Let the eased bar land on 100% and read SYSTEMS READY for a beat
  await ui.loadingFilled();
  await new Promise<void>((r) => setTimeout(r, reducedMotion ? 0 : 260));

  // Hangar idle until the user initiates (JARVIS cyan CTA).
  // Space / Enter / R / click all fire once; later loops use auto-replay.
  // Unlock audio in the gesture turn — assembly start is delayed for the
  // orb exit, and browsers drop autoplay permission across setTimeout.
  //
  // JARVIS startup VO is a one-shot on INITIATE (not the director timeline);
  // it was fully warmed above so play() stays inside the gesture window.
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
  // Coordinated handoff: loader chrome collapses, reactor → large INITIATE,
  // and in the same frame the veil lifts off the hangar as the lens settles
  // in from a little higher and further back.
  ui.showStartGate();
  ui.showHud();
  introCam.begin();
  document.body.classList.add('scene-revealed');
}

boot().catch((err) => {
  console.error(err);
  // The reticle is held back until the reveal — give the native cursor back
  document.body.classList.remove('jarvis-cursor-active');
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
