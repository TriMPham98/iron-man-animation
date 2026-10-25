import * as THREE from 'three';
import { Suit } from '../suit/Suit';
import { createAdaptiveResolution } from '../scene/adaptiveResolution';
import { GameAudio } from './audio/gameAudio';
import { SFX, Soundscape } from './audio/soundscape';
import { CONTEXT_ATTRIBUTES, canReverseDepth, useReversedDepth } from './render/depth';
import { FlightPost, type LensState } from './render/post';
import './render/shaderGuards';
import { portraitZoom, viewportSize, wideZoom } from './render/viewport';
import { Game } from './sim/game';
import { DEFAULT_CAMERA } from './sim/cameraRig';
import { Director } from './sim/director';
import { Input, type Controls } from './sim/input';
import { Hud } from './ui/hud';
import { SuitWireframe } from './ui/suitWireframe';
import { TouchControls } from './ui/touchControls';
import type { Screens } from './ui/screens';
import { bindFlightSettings } from './ui/flightSettings';
import { SUN_DIR } from './world/config';
import { World } from './world/world';
import { PAD, PAD_Y } from './world/house';

/**
 * The flight sim as an object the page can build, warm and start: on its
 * own (flight.html) or in the background of the workshop, which builds it
 * a step at a time while the suit-up plays and then flies its finished
 * suit straight out of the cell into it (see src/transition).
 */
export interface FlightAppOptions {
  canvas: HTMLCanvasElement;
  hudCanvas: HTMLCanvasElement;
  screens: Screens;
  /**
   * Awaited between the heavy build steps. Standalone it just yields a
   * frame to the boot screen; in the workshop it waits for idle time.
   */
  pace?: (step: string) => Promise<void>;
  /** Boot-screen progress (0–1) and a status line. */
  progress?: (p: number, line?: string) => void;
  /** Embedded in the workshop page (no boot screen, a handoff instead). */
  embedded?: boolean;
  /** Cap on the drawing-buffer pixel ratio. */
  maxPixelRatio?: number;
}

/** Main-thread cost of each build step (ms), for the boot log and the handoff stats. */
export type BuildTimings = Record<string, number>;

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 16));

export class FlightApp {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly audio = new GameAudio();
  readonly sounds = new Soundscape(this.audio);
  readonly timings: BuildTimings = {};
  readonly query = new URLSearchParams(location.search);
  readonly maxDpr: number;
  world!: World;
  suit!: Suit;
  game!: Game;
  post!: FlightPost;
  hud!: Hud;
  /**
   * Keyboard / mouse / pad. Created only once the sim is shown: its window
   * listeners swallow Space / Tab / F / G / Q, which the workshop still needs
   * while the sim is building behind it.
   */
  input: Input | null = null;
  /** On-screen controls (touch-first devices only; created with the input). */
  touch: TouchControls | null = null;
  /** Opens the pause menu (wired by src/flight/ui/flightSettings.ts). */
  pauseMenu: () => void = () => {};
  director: Director | null = null;
  lens!: LensState;
  /** The pilot has the stick (title / handoff are over). */
  engaged = false;
  paused = false;
  /** Test / capture hook: replaces live controls when set. */
  autopilot: ((t: number, c: Controls) => void) | null = null;
  /** Hands on the stick before the pilot's are: the handoff's lift-off and hover. */
  handoffPilot: ((dt: number, c: Controls) => void) | null = null;
  /** Runs after the rig has placed the camera: the handoff's matched framing. */
  cameraOverride: ((camera: THREE.PerspectiveCamera, dt: number) => void) | null = null;
  /** HUD visibility goal while not engaged (the handoff fades it up early). */
  hudGoal = 0;
  /** Settings volume, ramped in by the handoff's audio crossfade. */
  volumeScale = 1;
  /**
   * Keep the pixel ratio where it is (the handoff: two renderers share the
   * GPU for a moment, and a resize reallocates every target mid-shot).
   */
  holdResolution = false;
  readonly audioReady: Promise<void>;
  private readonly clock = new THREE.Clock();
  private adaptive!: ReturnType<typeof createAdaptiveResolution>;
  private baseExposure = 0.58;
  private raf = 0;
  private running = false;
  private visible = true;

  private readonly opts: FlightAppOptions;
  readonly screens: Screens;

  constructor(opts: FlightAppOptions) {
    this.opts = opts;
    this.screens = opts.screens;
    const { canvas } = opts;
    this.audioReady = this.audio.preload(Soundscape.files()).catch((e) => console.warn(e));
    // 0.1 m to 150 km without the near ground and the far ridges fighting:
    // reversed-Z where the GPU can, log depth where it can't (render/depth.ts)
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    const reversed = canReverseDepth(gl);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl ?? undefined,
      ...CONTEXT_ATTRIBUTES,
      reverseDepthBuffer: reversed,
      logarithmicDepthBuffer: !reversed,
    });
    const r = this.renderer;
    if (reversed) useReversedDepth(r);
    console.info(
      '[flight] depth',
      r.capabilities.reverseDepthBuffer ? 'reversed-z' : 'logarithmic',
      (() => {
        const gl = r.getContext();
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '';
      })(),
    );
    this.maxDpr = Math.min(window.devicePixelRatio, opts.maxPixelRatio ?? 1.5);
    r.setPixelRatio(this.maxDpr);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', display: 'block' });
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 150000);
    this.syncViewport(true);
    // Rotation, Chrome Android's toolbar and the keyboard move the visual
    // viewport, not always with a window 'resize' (and rotation's can carry
    // the old size): every frame checks too (syncViewport is a no-op then)
    window.addEventListener('resize', () => this.syncViewport(true));
    window.visualViewport?.addEventListener('resize', () => this.syncViewport());
    window.addEventListener('orientationchange', () => this.syncViewport());
  }

  /** The size everything is drawn at (CSS px; src/flight/render/viewport.ts). */
  private view = { w: 0, h: 0 };

  /**
   * Sizes the canvases, the drawing buffer, the camera and the HUD from the
   * one measure of the visible viewport, so the picture is never stretched.
   * `force`: the pixel ratio may have moved (the targets need a resize).
   */
  syncViewport(force = false): void {
    const { w, h } = viewportSize();
    if (!force && w === this.view.w && h === this.view.h) return;
    this.view = { w, h };
    for (const c of [this.opts.canvas, this.opts.hudCanvas]) Object.assign(c.style, { width: `${w}px`, height: `${h}px` });
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Ultra-wide phones: no wider across than 16:9 (desktop is left alone);
    // portrait: no narrower than the workshop's lens it's flown in from
    this.camera.zoom = (this.opts.screens.touch ? wideZoom(this.camera.aspect) : 1) * portraitZoom(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.post?.resize();
    this.hud?.resize(w, h);
    this.touch?.fit(w, h);
  }

  private async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    await (this.opts.pace ?? yieldFrame)(name);
    const t0 = performance.now();
    const out = await fn();
    this.timings[name] = Math.round(performance.now() - t0);
    return out;
  }

  /** Builds world, suit, sim and post, one paced step at a time. */
  async build(): Promise<void> {
    const progress = this.opts.progress ?? (() => {});
    const { screens } = this.opts;
    const suitLoad = Suit.create((r) => progress(0.1 + 0.5 * r));
    progress(0.08, 'MK III ARMOUR · LOADING');
    progress(0.12, 'TERRAIN · 32 KM · GROWING RELIEF');
    this.world = await this.step('world', () => new World(this.renderer, this.scene));
    console.info(`[flight] world built in ${this.timings.world} ms`);
    progress(0.3, 'LOW SUN · BAKING SHADOWS + SKY');
    this.suit = await suitLoad;
    progress(0.7, 'FLIGHT CONTROL · STABILIZERS · ARSENAL');
    this.game = await this.step('game', () => new Game(this.world, this.suit, this.scene, this.camera));
    console.info(`[flight] game built in ${this.timings.game} ms`);
    await this.step('post', () => {
      this.post = new FlightPost(this.renderer, this.scene, this.camera);
      this.hud = new Hud(this.opts.hudCanvas);
      // The helmet's suit diagram: the suit's own panel lines, flattened once
      const palm = (i: number) => this.suit.palms[i].at;
      this.hud.wireframe = new SuitWireframe(this.suit.finalGeometry, {
        palmL: palm(0),
        palmR: palm(1),
        bootL: [0.16, 0.02, 0.01],
        bootR: [-0.16, 0.02, 0.01],
      });
      if (!this.opts.embedded) this.attachInput();
    });
    const game = this.game;
    const { hud } = this;
    hud.pad = new THREE.Vector3(PAD.x, PAD_Y, PAD.y);
    hud.suitPos = game.model.pos;
    hud.onCue = (cue, n) => this.sounds.hud(cue, n);
    game.events.on((e) => {
      this.sounds.on(e, game.model);
      hud.event(e);
    });
    screens.onSettings = () => this.applySettings();
    this.applySettings();
    bindFlightSettings(this);

    const q = this.query;
    this.lens = {
      sunUv: new THREE.Vector2(),
      sunVis: 0,
      speed: 0,
      damage: 0,
      cloud: 0,
      exposure: Number(q.get('exp') ?? 0.58),
      helmet: 0,
    };
    this.baseExposure = this.lens.exposure;
    this.adaptive = createAdaptiveResolution(this.renderer, () => this.post.resize(), { min: 0.7, max: this.maxDpr });

    // ?demo plays the directed reel live; ?capture steps it frame by frame
    if (!this.opts.embedded) {
      const capture = q.has('capture');
      this.director = capture || q.has('demo') ? new Director(game) : null;
      this.engaged = q.has('fly') || !!this.director;
    }
    game.rig.mode = this.engaged && !this.director ? DEFAULT_CAMERA : 'attract';
    hud.alpha = this.engaged ? 1 : 0;
    this.syncViewport(true);
  }

  /**
   * Compiles every program the first frames need and runs a few of them
   * unseen, so the frame the handoff (or title) first shows is a steady one.
   * Parallel compile (KHR_parallel_shader_compile) keeps the main thread free.
   */
  async warm(frames = 3): Promise<void> {
    // Everything, including what is hidden now and shown later (boot jets,
    // flaps, weapons, sprites): three only compiles visible objects
    await this.step('compile', async () => {
      const hidden: THREE.Object3D[] = [];
      this.scene.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });
      // Into the target the scene really renders to (linear HDR, no tone
      // mapping): the programs for the canvas would be different variants
      const r = this.renderer;
      const prev = r.getRenderTarget();
      r.setRenderTarget((this.post as unknown as { rt: THREE.WebGLRenderTarget }).rt ?? null);
      try {
        await r.compileAsync(this.scene, this.camera);
      } finally {
        r.setRenderTarget(prev);
        for (const o of hidden) o.visible = false;
      }
    });
    // Upload every texture a few at a time (the first frame would otherwise
    // do them all at once)
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        for (const v of Object.values(m as unknown as Record<string, unknown>)) if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture);
        const u = (m as THREE.ShaderMaterial).uniforms;
        if (u) for (const x of Object.values(u)) if ((x?.value as THREE.Texture)?.isTexture) textures.add(x.value as THREE.Texture);
      }
    });
    const list = [...textures].filter((t) => !(t as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture);
    for (let i = 0; i < list.length; i += 4) {
      await this.step(`tex${i / 4}`, () => {
        for (const t of list.slice(i, i + 4)) this.renderer.initTexture(t);
      });
    }
    // One unseen draw of everything, hidden things included and nothing
    // culled: the GPU builds its pipeline state for each draw on first use
    // (ANGLE/Metal), which would otherwise land on the frame the boot jets
    // first light
    await this.step('pipelines', () => {
      const r = this.renderer;
      const touched: Array<[THREE.Object3D, boolean, boolean]> = [];
      this.scene.traverse((o) => {
        touched.push([o, o.visible, o.frustumCulled]);
        o.visible = true;
        o.frustumCulled = false;
      });
      const prev = r.getRenderTarget();
      try {
        r.setRenderTarget((this.post as unknown as { rt: THREE.WebGLRenderTarget }).rt ?? null);
        r.render(this.scene, this.camera);
      } finally {
        r.setRenderTarget(prev);
        for (const [o, v, c] of touched) {
          o.visible = v;
          o.frustumCulled = c;
        }
      }
    });
    // First sim tick builds its lazy state (pools, probes)
    await this.step('sim', () => {
      this.game.update(1 / 60);
      this.world.update(1 / 60, this.camera);
    });
    for (let i = 0; i < frames; i++) {
      await this.step(`settle${i}`, () => this.frame(1 / 60));
      console.info(`[flight] settle frame ${i}: ${this.timings[`settle${i}`]} ms`);
    }
    await this.step('gauge', () => this.gaugeResolution());
  }

  /**
   * Starts at the pixel ratio this GPU can hold, measured rather than found
   * by dropping frames: the first seconds are the handoff's lift-off shot,
   * which holds its resolution (a resize mid-shot is a stall), so whatever
   * ratio it starts at is the one it is seen at. Two timed full frames (each
   * waited out with a one-pixel read) fit cost = fixed + per-pixel × ratio².
   */
  private gaugeResolution(): void {
    const r = this.renderer;
    const gl = r.getContext();
    const px = new Uint8Array(4);
    const time = (dpr: number) => {
      r.setPixelRatio(dpr);
      this.post.resize();
      let best = Infinity;
      // The first draw at a size pays for its targets: best of three
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        this.post.render(0, this.lens);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    // GPU budget per frame, leaving the CPU's share and a margin of 60 fps
    const BUDGET = 11;
    const MIN = 0.7;
    const hi = this.adaptive.maxPixelRatio;
    const tHi = time(hi);
    let pick = hi;
    let log = `${hi.toFixed(2)}: ${tHi.toFixed(1)} ms`;
    if (tHi > BUDGET && hi > MIN) {
      const lo = Math.max(MIN, hi * 0.6);
      const tLo = time(lo);
      log += `, ${lo.toFixed(2)}: ${tLo.toFixed(1)} ms`;
      const perPx = (tHi - tLo) / (hi * hi - lo * lo);
      const fixed = tHi - perPx * hi * hi;
      if (perPx > 0 && BUDGET > fixed) pick = Math.sqrt((BUDGET - fixed) / perPx);
      else pick = tLo <= BUDGET ? lo : MIN;
      pick = THREE.MathUtils.clamp(Math.floor(pick * 20) / 20, MIN, hi);
    }
    // Back to the ratio the targets are tracked at, then on to the pick
    r.setPixelRatio(this.adaptive.pixelRatio);
    this.post.resize();
    this.adaptive.set(pick);
    console.info(`[flight] resolution gauge ${log} → ${this.adaptive.pixelRatio.toFixed(2)}`);
  }

  // Lens flare: where the sun is on screen and whether the land hides it
  private sunCheck = 0;
  private sunBlocked = 0;
  private readonly sunWorld = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private updateLens(dt: number): void {
    const { camera, lens, game, world } = this;
    this.sunWorld.copy(camera.position).addScaledVector(SUN_DIR, 5000);
    const p = this.sunWorld.project(camera);
    const inView = p.z < 1 && Math.abs(p.x) < 1.25 && Math.abs(p.y) < 1.25 && camera.getWorldDirection(this.camDir).dot(SUN_DIR) > 0;
    if (--this.sunCheck <= 0) {
      this.sunCheck = 6;
      this.sunBlocked = world.field.raycast(camera.position, SUN_DIR, 16000) > 0 ? 1 : 0;
    }
    const edge = inView ? 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(p.x), Math.abs(p.y)), 0.75, 1.25) : 0;
    const goal = edge * (1 - this.sunBlocked) * (game.rig.mode === 'helmet' ? 1.2 : 0.8);
    lens.sunVis += (goal - lens.sunVis) * (1 - Math.exp(-dt / 0.12));
    lens.sunUv.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    lens.helmet = game.rig.mode === 'helmet' ? 1 : 0;
    lens.speed = Math.min(1, Math.max(0, (game.model.speed - 120) / 300));
    lens.damage = game.combat.damageFlash;
    lens.cloud += (world.inCloud - lens.cloud) * (1 - Math.exp(-dt / 0.15));
    // Eye adaptation: stop down into the sun, open up away from it
    const sunward = Math.max(0, this.camDir.dot(SUN_DIR));
    const expGoal = this.baseExposure * THREE.MathUtils.lerp(1.18, 0.72, sunward * sunward);
    lens.exposure += (expGoal - lens.exposure) * (1 - Math.exp(-dt / 0.8));
  }

  /** Creates the controls (once). */
  attachInput(): Input {
    if (!this.input) {
      this.input = new Input(this.opts.canvas);
      if (this.opts.screens.touch) {
        // Touch screens: no pointer lock, the overlay drives the touch source
        this.input.touchMode = true;
        this.touch = new TouchControls(this.input, this.opts.canvas.parentElement ?? document.body, () => this.pauseMenu());
        this.hud.waveKey = 'WAVE';
        this.hud.landKey = 'LAND';
        this.syncViewport(true);
      }
    }
    this.applySettings();
    return this.input;
  }

  private applySettings(): void {
    const s = this.opts.screens.settings;
    if (this.input) {
      this.input.invertY = s.invertY;
      this.input.sensitivity = s.sensitivity;
    }
    this.touch?.setOpacity(s.touchOpacity);
    this.touch?.setLeftHanded(s.leftHanded);
    this.audio.setVolume(s.volume * this.volumeScale);
    if (this.hud) this.hud.glow = s.quality !== 'low';
  }

  /** Hands off: what the sim reads while there are no controls yet. */
  private idleControls(): Controls {
    return {
      aimYaw: 0,
      aimPitch: 0,
      throttle: 0,
      lateral: 0,
      vertical: 0,
      forward: 0,
      boost: false,
      brake: false,
      fire: false,
      missile: false,
      unibeam: false,
      flares: false,
      launcher: false,
      pressed: new Set(),
      zoom: 0,
    } as Controls;
  }

  /** One frame of sim + render. */
  frame(dt: number): void {
    const { input, game, world, hud, director, camera } = this;
    this.syncViewport();
    if (input?.touchMode) {
      // The touch take-off / hover-climb mapping reads what the suit is doing
      const sim = input.touch.sim;
      sim.grounded = game.model.grounded;
      sim.hover = 1 - game.model.flightness;
      sim.pitch = Math.asin(THREE.MathUtils.clamp(game.input.aim.y, -1, 1));
    }
    const c = input ? input.read(dt) : this.idleControls();
    if (director) director.update(dt, c);
    else this.autopilot?.(game.time, c);
    if (!this.engaged || this.paused) {
      // Title / pause: the world keeps living, the controls don't
      c.aimYaw = c.aimPitch = c.throttle = c.lateral = c.vertical = 0;
      c.fire = c.missile = c.unibeam = c.flares = c.launcher = c.boost = c.brake = false;
      c.pressed.clear();
      if (!this.paused) this.handoffPilot?.(dt, c);
    }
    for (const code of c.pressed) {
      if (code === 'KeyV') game.rig.cycle();
      // Once the suit is lost, R or the wave key (N, WAVE, D-pad up) redeploys
      if (game.combat.lost) {
        if ((code === 'KeyR' || code === 'KeyN') && game.combat.redeployReady) game.redeploy();
        continue;
      }
      if (code === 'KeyR') game.reset();
      if (code === 'KeyN') game.combat.callWave();
    }
    game.applyControls(c);
    if (!this.paused) game.update(dt);
    this.cameraOverride?.(camera, dt);
    world.update(dt, camera);
    this.updateLens(dt);
    // Cinematic shots are seen from outside the suit: no helmet HUD over them
    const cinematic = game.rig.mode === 'flyby';
    const hudGoal = director ? director.hud : cinematic ? 0 : this.engaged ? 1 : this.hudGoal;
    hud.alpha += (hudGoal - hud.alpha) * (1 - Math.exp(-dt / 0.6));
    if (this.touch) {
      this.touch.setActive(this.engaged && !this.paused && !director && !this.autopilot);
      this.touch.setWaveReady(game.combat.waveReady || game.combat.redeployReady);
      this.touch.setLandReady(game.autoLand || game.autoLandReady);
      hud.bottomInset = this.touch.bottomInset;
      hud.minScale = 0.55;
    }
    hud.jets = game.driver.outputs;
    const { w: vw, h: vh } = this.view;
    hud.sun.set(this.lens.sunUv.x * vw, (1 - this.lens.sunUv.y) * vh, this.lens.sunVis);
    hud.autoLand = !this.engaged || director ? null : game.autoLand ? 'active' : game.autoLandReady ? 'ready' : null;
    // TEMP: the take-off prompt (touch screens have their own stick mapping)
    hud.takeoff = this.engaged && !this.paused && !director && !this.autopilot && !this.touch && game.model.grounded && !game.autoLand && !game.autoLandReady;
    hud.draw(dt, camera, game.model, game.combat, game.ground, game.rig.mode === 'helmet');
    this.sounds.update(dt, game.model, game.combat, camera, game.rig.mode === 'helmet', game.combat.weapons.unibeamOn);
    this.post.render(dt, this.lens);
  }

  /** Optional per-frame observer (frame-time stats). */
  onFrame: ((dtMs: number) => void) | null = null;

  /** Runs the live loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running || !this.visible) return;
      this.raf = requestAnimationFrame(loop);
      const raw = this.clock.getDelta();
      this.onFrame?.(raw * 1000);
      const dt = Math.min(raw, 0.1);
      if (!this.holdResolution) this.adaptive.update(dt);
      this.frame(dt);
    };
    document.addEventListener('visibilitychange', () => {
      this.visible = document.visibilityState === 'visible';
      cancelAnimationFrame(this.raf);
      if (this.visible && this.running) {
        this.clock.getDelta();
        loop();
      }
    });
    loop();
  }

  /** A non-spatial one-shot from the sim's (library) sound set. */
  cue(name: keyof typeof SFX, gain = 1): void {
    this.audio.play(SFX[name], { ui: true, gain });
  }

  /** Volume the pilot set, times the handoff's fade. */
  applyVolume(): void {
    this.applySettings();
  }

  /** Pilot takes the stick: pointer lock, sound, the shoulder view. */
  engage(line = 'All systems online. Good evening, sir. The coast is yours.'): void {
    void this.audio.unlock().then(() => this.sounds.start());
    this.attachInput().requestLock();
    this.engaged = true;
    this.handoffPilot = null;
    this.cameraOverride = null;
    this.game.rig.mode = DEFAULT_CAMERA;
    if (line) this.game.events.emit('jarvis', { text: line });
  }

  /** Click-to-relock and Esc-to-pause, once the pilot is flying. */
  bindPointerLock(): void {
    const { canvas, screens } = this.opts;
    canvas.addEventListener('click', () => {
      if (this.engaged && !this.paused) this.input?.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      if (this.engaged && !locked && !this.autopilot && !this.director) {
        this.paused = true;
        this.audio.setPaused(true);
        screens.setPaused(true, () => this.input?.requestLock());
      } else if (locked) {
        this.paused = false;
        screens.setPaused(false, () => {});
        this.audio.setPaused(false);
        void this.audio.unlock();
      }
    });
  }

  /** Debug / test hooks (window.__flight). */
  hooks(): Record<string, unknown> {
    const { game } = this;
    return {
      THREE,
      app: this,
      post: this.post,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      world: this.world,
      game,
      suit: this.suit,
      hud: this.hud,
      audio: this.audio,
      lens: this.lens,
      setAutopilot: (fn: FlightApp['autopilot']) => {
        this.autopilot = fn;
        this.engaged = true;
        this.handoffPilot = null;
        this.cameraOverride = null;
        game.rig.mode = 'chase';
        this.opts.screens.hideTitle();
      },
      /** Drop the suit into flight somewhere (tests, captures). */
      teleport: (x: number, y: number, z: number, heading: number, speed: number) => {
        const m = game.model;
        m.pos.set(x, y, z);
        m.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
        m.vel.set(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(speed);
        m.grounded = false;
        m.flightness = speed > 30 ? 1 : 0;
        m.posture = speed > 30 ? 1.42 : 0;
        m.speedCmd = speed;
        game.rig.lookHeading(heading, -0.08);
      },
    };
  }
}
