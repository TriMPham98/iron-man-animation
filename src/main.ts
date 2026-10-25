import './styles.css';
import * as THREE from 'three';
import gsap from 'gsap';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCamera, updateCameraAspect } from './scene/createCamera';
import { createEnvironment } from './scene/createEnvironment';
import { createLights } from './scene/createLights';
import { createPostProcessing } from './scene/postProcessing';
import { CONTACT_SHADOW_LAYER, createContactShadow } from './scene/contactShadow';
import { createAdaptiveResolution } from './scene/adaptiveResolution';
import { warmUp } from './scene/warmUp';
import { createRenderer } from './scene/createRenderer';
import { deviceProfile } from './scene/deviceProfile';
import { applyStudioEnvironment } from './scene/createStudioEnv';
import { createAssemblySession } from './session/assemblySession';
import { buildSuitUpPlan } from './animation/suitUpChoreography';
import { Workshop } from './workshop/Workshop';
import { FOOT_HATCH_RADIUS } from './workshop/workshopEnvironment';
import { APERTURE_INNER, APERTURE_OUTER } from './workshop/ringAperture';
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
import { createCycleScrubber } from './ui/cycleScrubber';
import { createPickHighlight } from './ui/pickHighlight';
import { prefersReducedMotion } from './ui/viewerMode';
import { SOUNDS } from './audio/sounds';
import { simplifierReady } from './utils/simplify';
import { HERO_END_CAM } from './animation/sequenceClock';
import { FLIGHT_CHECK_STEPS } from './animation/flightCheck';
import { createFlightHandoff, type FlightHandoff } from './transition/flightHandoff';
import { flyHint } from './transition/launchProfile';

/** Releases every geometry, material and texture under `root`. */
function disposeTree(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture);
      }
      const uniforms = (mat as THREE.ShaderMaterial).uniforms;
      if (uniforms) for (const u of Object.values(uniforms)) if ((u?.value as THREE.Texture)?.isTexture) textures.add(u.value as THREE.Texture);
      mat.dispose();
    }
  });
  for (const t of textures) t.dispose();
}

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
  const teardownCursor = installJarvisCursor();

  // Phones / tablets: touch chrome (no key hints, tap transport) and a
  // drawing buffer sized for their GPUs (styles.css: body.is-touch)
  const device = deviceProfile();
  document.body.classList.toggle('is-touch', device.touch);
  document.body.dataset.tier = device.tier;

  const ui = createOverlay();
  const reducedMotion = prefersReducedMotion();
  // The flight sim builds behind the workshop (see src/transition): started
  // now so its long one-off bakes run under this loader, overlapping the
  // downloads, and the rest in idle time once the hangar is up.
  // ?noflight skips it (the FLY link then just navigates).
  const flightPreload = !new URLSearchParams(location.search).has('noflight');
  const handoff: FlightHandoff = createFlightHandoff({ reducedMotion });
  if (flightPreload) void handoff.preload().catch(() => undefined);
  const flying = () => handoff.isActive();

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
  // Full fidelity on desktop: max DPR 1.75 (phones / tablets: deviceProfile)
  const renderer = createRenderer(canvas, { maxPixelRatio: device.maxPixelRatio });
  const scene = new THREE.Scene();
  const camera = createCamera();
  // Match suit feet clearance + HERO_END / OPEN_WIDE look height
  const lookTarget = new THREE.Vector3(0, 0.95 + SUIT_GROUND_CLEARANCE, 0);

  createEnvironment(
    scene,
    [
      // Centre boot hatch
      [0, 0, FOOT_HATCH_RADIUS + 0.005],
    ],
    // The ring aperture the floor arms and parts stands rise through
    [[APERTURE_INNER, APERTURE_OUTER]],
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


  // Dev-only handle for poking the scene from the console / test drivers
  if (import.meta.env.DEV) {
    (window as unknown as { __suit: unknown }).__suit = { suit, camera, lookTarget, controls, session, workshop, scene, renderer, post, contact, lights };
  }

  // One scrub bar across assembly → flight check → disassembly
  const scrubber = createCycleScrubber({
    getCycle: session.getCycle,
    seekCycle: session.seekCycle,
    setCyclePlaying: session.setCyclePlaying,
    isEnabled: () => ui.hasInitiated() && !reducedMotion,
    touch: device.touch ? { toggleMute: () => audioTimeline.toggleMute(), isMuted: () => audioTimeline.isMuted() } : undefined,
  });

  bindInput({
    canvas,
    scrubber,
    camera,
    suit,
    // Transport hotkeys go quiet once the suit has flown out
    ui: { ...ui, hasInitiated: () => !flying() && ui.hasInitiated() },
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
  const adaptive = createAdaptiveResolution(renderer, () => post.resize(window.innerWidth, window.innerHeight), {
    min: device.minPixelRatio,
  });

  let raf = 0;
  let visible = true;
  let retired = false;

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
      done: () => t < 0,
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
    if (retired) return;
    if (visible) {
      clock.getDelta();
      loop();
    } else {
      cancelAnimationFrame(raf);
    }
  });

  const flyButton = document.getElementById('fly-link');
  /** The fly prompt is up (from the hover test until the doff starts). */
  let flyOffered = false;
  const FLY_OFFER_AT = (FLIGHT_CHECK_STEPS.find((s) => /HOVER/.test(s.status)) ?? FLIGHT_CHECK_STEPS[FLIGHT_CHECK_STEPS.length - 1]).at;

  const loop = () => {
    if (!visible || retired) return;
    raf = requestAnimationFrame(loop);

    const delta = clock.getDelta();
    const handing = flying();
    // Resolution holds through the handoff (a resize would stall the shot)
    if (!handing) adaptive.update(delta);
    if (!handing) introCam.update(delta);

    // Showcase orbit owns the camera on those frames — skip OrbitControls
    // so damping / spherical rebuild cannot fight or dilute the yaw.
    // (The handoff owns the lens and holds the cycle once it starts.)
    const showcaseOrbiting = handing ? true : session.update(delta);

    // Camera ownership (scrub ↔ orbit):
    // - Path mode while playing: OrbitControls keeps distance/angles so the
    //   composition tracks lookTarget (pure GSAP poses read differently).
    // - Path mode while paused/scrubbed: do NOT call controls.update —
    //   minDistance / polar clamps yank the camera off close ECU / early
    //   pullback poses (visible jerk on ←/→ after systems online).
    // - Free-look (userOwnsCamera): orbit owns target + position.
    // Scrub re-attaches to path; viewport drag detaches (bindInput).
    if (controls.enabled && !showcaseOrbiting && !handing) {
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
      (drawingBuffer.y * camera.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)),
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
    scrubber.update();

    // The natural end of the suit-up: once the suit is up on its boot jets in
    // the hover test, offer to take it out (until the doff starts taking it
    // apart — the loop carries on as ever for anyone who doesn't)
    if (!handing && !reducedMotion) {
      const c = session.getCycle();
      const offer = c.phase === 'flight' && c.t - c.phases.assembly >= FLY_OFFER_AT;
      if (offer !== flyOffered) {
        flyOffered = offer;
        document.body.classList.toggle('fly-offered', offer);
      }
      // Anywhere else it still flies: it says what it will do first
      const hint = flyHint(c.t, c.phases.assembly);
      if (flyButton && flyButton.dataset.hint !== hint) flyButton.dataset.hint = hint;
    }
    contact.update();
    post.render(delta);
  };

  // ── Flight handoff ───────────────────────────────────────────────
  /** Workshop gone for good: stop its loop, free its GPU and audio. */
  const idleTick = () =>
    new Promise<void>((r) => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(() => r(), { timeout: 1000 });
      else setTimeout(r, 30);
    });
  const retireWorkshop = () => {
    if (retired) return;
    retired = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    gsap.globalTimeline.clear();
    audioTimeline.engine.stop();
    teardownCursor();
    controls.dispose();
    document.body.classList.add('workshop-retired');
    void (async () => {
      // GPU memory back a slice at a time: the GPU process is shared with the
      // flight sim now on screen, so one big teardown would stall its frames
      for (const root of [...scene.children]) {
        await idleTick();
        disposeTree(root);
      }
      await idleTick();
      scene.environment?.dispose();
      (scene.background as THREE.Texture | null)?.dispose?.();
      post.composer?.dispose();
      suit.dispose();
      scene.clear();
      renderer.renderLists.dispose();
      renderer.dispose();
      // Last the context itself, with its drawing buffer (both waits on the
      // GPU: a stall of a few frames, even shrinking the buffer), only where
      // that can't be seen: the pause menu or a hidden tab, never the lift-off
      // or the pilot's first moments on the stick
      await new Promise<void>((r) => {
        const unseen = (e: Event) => {
          // An unlock is the pilot letting go of the stick: the pause menu
          const unlocked = e.type === 'pointerlockchange' && !document.pointerLockElement;
          if (!unlocked && document.visibilityState !== 'hidden') return;
          document.removeEventListener('pointerlockchange', unseen);
          document.removeEventListener('visibilitychange', unseen);
          r();
        };
        document.addEventListener('pointerlockchange', unseen);
        document.addEventListener('visibilitychange', unseen);
      });
      const t0 = performance.now();
      renderer.forceContextLoss();
      console.info(`[handoff] workshop context released in ${Math.round(performance.now() - t0)} ms`);
    })();
  };
  suit.group.updateMatrixWorld(true);
  const headRest = suit.boneWorldPoint('head', [0, 1.72, 0.04], new THREE.Vector3());
  let launchCues = 0;
  handoff.attach({
    camera,
    suitRoot: suit.group,
    headPoint: (out) => suit.boneWorldPoint('head', [0, 1.72, 0.04], out),
    reducedMotion,
    freeze: () => {
      // Hold the cycle where it is: timelines frozen, the lens is the handoff's
      gsap.globalTimeline.pause();
      controls.enabled = false;
      document.body.classList.remove('fly-offered');
      ui.retire();
      // The helmet HUD booting: the library's interface chatter, briefly
      audioTimeline.engine.play({
        id: 'handoff-hud',
        file: 'binary-code-interface.mp3',
        offset: 0,
        duration: 1.8,
        volume: 0.7,
        fadeIn: 0.02,
        fadeOut: 0.6,
      });
    },
    setVolume: (v) => audioTimeline.engine.setMasterVolume(v),
    retire: retireWorkshop,
    // Long one-off steps only where nobody sees a frame drop: under the boot
    // loader (not its last beat, the reveal), at the INITIATE gate once the
    // intro dolly has settled, in a background tab or on a held frame
    isQuiet: () =>
      !document.body.classList.contains('scene-ready') ||
      document.visibilityState === 'hidden' ||
      (!ui.hasInitiated() && introCam.done()) ||
      // Held on a frame (Space): nothing moving to stutter
      (ui.hasInitiated() && !session.getCycle().playing),
    // From anywhere in the cycle the suit flies itself out through the roof
    // (reduced motion: no check or doff to run through, a plain dissolve)
    cycle: () => {
      if (reducedMotion) return null;
      const c = session.getCycle();
      return { t: c.t, assembly: c.phases.assembly };
    },
    seekCycle: (t) => session.seekCycle(t),
    muteFx: (m) => suit.muteFx(m),
    poseLaunch: (check, climb, burn, fx) => session.poseLaunch(check, climb, burn, fx),
    setRoof: (s) => workshop.setRoof(s),
    cue: (file, o) =>
      audioTimeline.engine.play({ id: `launch-${++launchCues}`, file, offset: o.offset ?? 0, duration: o.duration, volume: o.volume, fadeIn: o.fadeIn ?? 0.02, fadeOut: o.fadeOut ?? 0.3 }),
  });
  handoff.setHeroFraming(
    new THREE.Vector3(HERO_END_CAM.x, HERO_END_CAM.y, HERO_END_CAM.z),
    new THREE.Vector3(HERO_END_CAM.lx, HERO_END_CAM.ly, HERO_END_CAM.lz),
    HERO_END_CAM.fov,
    headRest,
  );
  const flyLink = document.getElementById('fly-link') as HTMLAnchorElement | null;
  flyLink?.addEventListener('click', (e) => {
    // New tab / window: let the browser have it
    if (!flightPreload || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    handoff.begin();
  });

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
