import * as THREE from 'three';
import { Suit } from '../suit/Suit';
import { createAdaptiveResolution } from '../scene/adaptiveResolution';
import { GameAudio } from './audio/gameAudio';
import { Soundscape } from './audio/soundscape';
import { supportsReversedZ } from './render/depth';
import { FlightPost, type LensState } from './render/post';
import { Game } from './sim/game';
import { Director } from './sim/director';
import { Input, type Controls } from './sim/input';
import { Hud } from './ui/hud';
import { Screens } from './ui/screens';
import { SUN_DIR } from './world/config';
import { World } from './world/world';

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 16));

async function boot(): Promise<void> {
  // A captured reel is repeatable: one seeded random stream for everything
  if (new URLSearchParams(location.search).has('capture')) {
    let seed = 0x9e3779b9;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const screens = new Screens();
  screens.progress(0.02, 'J.A.R.V.I.S. // FLIGHT SYSTEMS');
  const audio = new GameAudio();
  const sounds = new Soundscape(audio);
  const audioLoad = audio.preload(Soundscape.files()).catch((e) => console.warn(e));

  const canvas = document.getElementById('flight-canvas') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    stencil: false,
    powerPreference: 'high-performance',
    ...(supportsReversedZ() ? { reverseDepthBuffer: true } : { logarithmicDepthBuffer: true }),
  });
  const maxDpr = Math.min(window.devicePixelRatio, 1.5);
  renderer.setPixelRatio(maxDpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', display: 'block' });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 150000);
  const suitLoad = Suit.create((r) => screens.progress(0.1 + 0.5 * r));
  screens.progress(0.08, 'MK III ARMOUR · LOADING');
  await nextFrame();
  screens.progress(0.12, 'TERRAIN · 32 KM · GROWING RELIEF');
  await nextFrame();
  const world = new World(renderer, scene);
  screens.progress(0.3, 'LOW SUN · BAKING SHADOWS + SKY');
  const suit = await suitLoad;
  screens.progress(0.7, 'FLIGHT CONTROL · STABILIZERS · ARSENAL');
  const game = new Game(world, suit, scene, camera);
  const post = new FlightPost(renderer, scene, camera);
  const hud = new Hud(document.getElementById('flight-hud') as HTMLCanvasElement);
  const input = new Input(canvas);
  game.events.on((e) => {
    sounds.on(e, game.model);
    if (e.kind === 'jarvis' && e.text) hud.say(e.text);
    if (e.kind === 'kill') hud.kill();
    if (e.kind === 'repulsorHit') hud.hit();
  });
  const applySettings = () => {
    input.invertY = screens.settings.invertY;
    input.sensitivity = screens.settings.sensitivity;
    audio.setVolume(screens.settings.volume);
  };
  screens.onSettings = applySettings;
  applySettings();

  const q = new URLSearchParams(location.search);
  const lens: LensState = {
    sunUv: new THREE.Vector2(),
    sunVis: 0,
    speed: 0,
    damage: 0,
    cloud: 0,
    exposure: Number(q.get('exp') ?? 0.58),
    helmet: 0,
  };
  const baseExposure = lens.exposure;
  const adaptive = createAdaptiveResolution(renderer, () => post.resize(), { min: 0.7, max: maxDpr });

  /** Test / capture hook: replaces live controls when set. */
  let autopilot: ((t: number, c: Controls) => void) | null = null;
  // ?demo plays the directed reel live; ?capture steps it frame by frame
  const capture = q.has('capture');
  const director = capture || q.has('demo') ? new Director(game) : null;
  const captureDt: number | null = capture ? 1 / Number(q.get('fps') ?? 30) : null;
  let engaged = q.has('fly') || !!director;
  let paused = false;
  game.rig.mode = engaged && !director ? 'chase' : 'attract';
  hud.alpha = engaged ? 1 : 0;
  const hooks = {
    THREE,
    post,
    renderer,
    scene,
    camera,
    world,
    game,
    suit,
    hud,
    audio,
    lens,
    setAutopilot: (fn: typeof autopilot) => {
      autopilot = fn;
      engaged = true;
      game.rig.mode = 'chase';
      screens.hideTitle();
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
  (window as unknown as Record<string, unknown>).__flight = hooks;

  // Lens flare: where the sun is on screen and whether the land hides it
  let sunCheck = 0;
  let sunBlocked = 0;
  const sunWorld = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const updateLens = (dt: number) => {
    sunWorld.copy(camera.position).addScaledVector(SUN_DIR, 5000);
    const p = sunWorld.project(camera);
    const inView = p.z < 1 && Math.abs(p.x) < 1.25 && Math.abs(p.y) < 1.25 && camera.getWorldDirection(camDir).dot(SUN_DIR) > 0;
    if (--sunCheck <= 0) {
      sunCheck = 6;
      sunBlocked = world.field.raycast(camera.position, SUN_DIR, 16000) > 0 ? 1 : 0;
    }
    const edge = inView ? 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(p.x), Math.abs(p.y)), 0.75, 1.25) : 0;
    const goal = edge * (1 - sunBlocked) * (game.rig.mode === 'helmet' ? 1.2 : 0.8);
    lens.sunVis += (goal - lens.sunVis) * (1 - Math.exp(-dt / 0.12));
    lens.sunUv.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    lens.helmet = game.rig.mode === 'helmet' ? 1 : 0;
    lens.speed = Math.min(1, Math.max(0, (game.model.speed - 120) / 300));
    lens.damage = game.combat.damageFlash;
    lens.cloud += (world.inCloud - lens.cloud) * (1 - Math.exp(-dt / 0.15));
    // Eye adaptation: stop down into the sun, open up away from it
    const sunward = Math.max(0, camDir.dot(SUN_DIR));
    const expGoal = baseExposure * THREE.MathUtils.lerp(1.18, 0.72, sunward * sunward);
    lens.exposure += (expGoal - lens.exposure) * (1 - Math.exp(-dt / 0.8));
  };

  const clock = new THREE.Clock();
  const frame = (dt: number) => {
    const c = input.read(dt);
    if (director) director.update(dt, c);
    else autopilot?.(game.time, c);
    if (!engaged || paused) {
      // Title / pause: the world keeps living, the controls don't
      c.aimYaw = c.aimPitch = c.throttle = c.lateral = c.vertical = 0;
      c.fire = c.missile = c.unibeam = c.flares = c.launcher = c.boost = c.brake = false;
      c.pressed.clear();
    }
    for (const code of c.pressed) {
      if (code === 'KeyV') game.rig.cycle();
      if (code === 'KeyR') game.reset();
      if (code === 'KeyN') game.combat.callWave();
    }
    game.applyControls(c);
    if (!paused) game.update(dt);
    world.update(dt, camera);
    updateLens(dt);
    hud.alpha += ((director ? director.hud : engaged ? 1 : 0) - hud.alpha) * (1 - Math.exp(-dt / 0.6));
    hud.draw(dt, camera, game.model, game.combat, game.ground, game.rig.mode === 'helmet');
    sounds.update(dt, game.model, game.combat, camera, game.rig.mode === 'helmet', game.combat.weapons.unibeamOn);
    post.render(dt, lens);
  };
  const loop = () => {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);
    adaptive.update(dt);
    frame(dt);
  };
  // Settle a few frames under the boot screen (shader compiles, first bakes)
  for (let i = 0; i < 3; i++) {
    frame(1 / 60);
    screens.progress(0.75 + i * 0.07);
    await nextFrame();
  }
  await audioLoad;
  screens.progress(1, 'SYSTEMS NOMINAL');
  clock.getDelta();
  if (capture) {
    // Frame-stepped capture: the page renders one frame per call and hands
    // back everything that happened on it (the sound layer is cued from this)
    screens.hideTitle();
    const log: Array<Record<string, unknown>> = [];
    let frameNo = 0;
    const right = new THREE.Vector3();
    game.events.on((e) => {
      const entry: Record<string, unknown> = { frame: frameNo, t: +(frameNo * captureDt!).toFixed(4), kind: e.kind, value: e.value, side: e.side, text: e.text };
      if (e.at) {
        const rel = e.at.clone().sub(camera.position);
        right.set(1, 0, 0).applyQuaternion(camera.quaternion);
        entry.dist = +rel.length().toFixed(1);
        entry.pan = +(rel.normalize().dot(right)).toFixed(3);
      }
      log.push(entry);
    });
    (window as unknown as Record<string, unknown>).__capture = {
      frame: () => {
        frame(captureDt!);
        frameNo++;
        return { frame: frameNo, phase: director!.phase, done: director!.tail > 1.5 };
      },
      log: () => log,
      state: () => ({ phase: director!.phase, pos: game.model.pos.toArray(), speed: game.model.speed }),
    };
  } else {
    loop();
  }
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    post.resize();
  });

  const engage = () => {
    void audio.unlock().then(() => sounds.start());
    input.requestLock();
    engaged = true;
    game.rig.mode = 'chase';
    game.events.emit('jarvis', { text: 'All systems online. Good evening, sir. The coast is yours.' });
  };
  screens.showTitle(engage, engaged);
  canvas.addEventListener('click', () => {
    if (engaged && !paused) input.requestLock();
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (engaged && !locked && !autopilot && !director) {
      paused = true;
      screens.setPaused(true, () => input.requestLock());
    } else if (locked) {
      paused = false;
      screens.setPaused(false, () => {});
      void audio.unlock();
    }
  });
}

boot().catch((e) => {
  console.error(e);
  const lines = document.querySelector('#flight-ui .boot .lines');
  if (lines) lines.innerHTML += '<div style="color:#ff6a5a">FAILED TO INIT — SEE CONSOLE</div>';
});
