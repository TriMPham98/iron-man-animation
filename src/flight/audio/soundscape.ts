import * as THREE from 'three';
import type { Combat } from '../combat/combat';
import type { SimEvent } from '../sim/events';
import { G_LIMIT, type FlightModel } from '../sim/flightModel';
import { SPEED_OF_SOUND } from '../world/config';
import type { Emitter, GameAudio, Loop } from './gameAudio';

/**
 * What the sim sounds like: every event mapped to its recordings, and the
 * loops (boots, wind, beam, drone engines, the missile warning) steered from
 * the flight state each frame. One sonic family — metal and sub — over the
 * project's own suit library (thrusters, servos, repulsors) and the CC0
 * kit (see public/sounds/flight/CREDITS.md).
 */

const LIB = '/sounds/';
const KIT = '/sounds/flight/';

export const SFX = {
  // Suit (project library)
  thrusterBurn: `${LIB}thruster-burn.mp3`,
  thrusterIgnite: `${LIB}thruster-ignite.mp3`,
  touchdown: `${LIB}touchdown.mp3`,
  footstep: `${LIB}footstep.mp3`,
  repulsor: `${LIB}repulsor.mp3`,
  impact: `${LIB}impact.mp3`,
  metalClang: `${LIB}metal-clang.mp3`,
  servoWhir: `${LIB}servo-whir.mp3`,
  weaponDeploy: `${LIB}weapon-deploy.mp3`,
  weaponLock: `${LIB}weapon-lock.mp3`,
  weaponStow: `${LIB}weapon-stow.mp3`,
  sparkCrackle: `${LIB}spark-crackle.mp3`,
  steamRelease: `${LIB}steam-release.mp3`,
  electricMotor: `${LIB}electric-motor.mp3`,
  metalResonate: `${LIB}metal-resonate.mp3`,
  unclampDry: `${LIB}unclamp-dry.mp3`,
  // Combat and air (CC0 kit, picked by eye from their spectrograms)
  explosionNear: `${KIT}explosion-near.mp3`,
  explosionSub: `${KIT}explosion-sub.mp3`,
  explosionHuge: `${KIT}explosion-huge.mp3`,
  sonicBoomNear: `${KIT}sonic-boom-near.mp3`,
  sonicBoomFar: `${KIT}sonic-boom-far.mp3`,
  heroThud: `${KIT}hero-thud.mp3`,
  deepBoom: `${KIT}deep-boom.mp3`,
  rocket1: `${KIT}rocket-1.mp3`,
  rocket2: `${KIT}rocket-2.mp3`,
  flyby: `${KIT}flyby.mp3`,
  zip: `${KIT}zip.mp3`,
  charge: `${KIT}charge.mp3`,
  repulsorZap: `${KIT}repulsor-zap.mp3`,
  // HUD: a seeker's growl and lock tone, the RWR's pulse, the HUD's chimes
  lockTick: `${KIT}lock-tick.mp3`,
  lockTone: `${KIT}lock-tone.mp3`,
  seekerGrowl: `${KIT}seeker-growl.mp3`,
  rwrPulse: `${KIT}rwr-pulse.mp3`,
  killConfirm: `${KIT}kill-confirm.mp3`,
  jarvisBlip: `${KIT}jarvis-blip.mp3`,
  waveStart: `${KIT}wave-start.mp3`,
  waveClear: `${KIT}wave-clear.mp3`,
  ping1: `${KIT}ping-1.mp3`,
  ping2: `${KIT}ping-2.mp3`,
  ping3: `${KIT}ping-3.mp3`,
  ping4: `${KIT}ping-4.mp3`,
  flarePop: `${KIT}flare-pop.mp3`,
  gun: `${KIT}gun.mp3`,
  splash: `${KIT}splash.mp3`,
  splashBig: `${KIT}splash-big.mp3`,
  samLaunch: `${KIT}sam-launch.mp3`,
  wind: `${KIT}wind.mp3`,
  jet: `${KIT}jet.mp3`,
  jetLoop: `${KIT}jet-loop.mp3`,
  buffet: `${KIT}buffet.mp3`,
  // The world under a low pass: open sea, the coast's breakers, wind in the
  // trees on the hills, white water thrashed up by the boots
  sea: `${KIT}sea.mp3`,
  surf: `${KIT}surf.mp3`,
  trees: `${KIT}trees.mp3`,
  spray: `${KIT}spray.mp3`,
} as const;

/** Points on the ring sampled round the ear for sea vs land. */
const RING = 8;

/**
 * Where the suit has been (s, sim clock): an observer hears it from where it
 * *was* when the sound left it, so the ear needs the last few seconds.
 */
class Track {
  private readonly t: number[] = [];
  private readonly p: THREE.Vector3[] = [];
  private head = 0;
  private n = 0;
  constructor(private readonly size = 512) {
    for (let i = 0; i < size; i++) {
      this.t.push(0);
      this.p.push(new THREE.Vector3());
    }
  }

  push(t: number, at: THREE.Vector3): void {
    this.head = (this.head + 1) % this.size;
    this.t[this.head] = t;
    this.p[this.head].copy(at);
    this.n = Math.min(this.size, this.n + 1);
  }

  /** Position at time t (held at the ends of the record). */
  at(t: number, out: THREE.Vector3): THREE.Vector3 {
    if (!this.n) return out.set(0, 0, 0);
    let i = this.head;
    for (let k = 0; k < this.n - 1; k++) {
      const j = (i - 1 + this.size) % this.size;
      if (this.t[j] <= t) {
        const span = this.t[i] - this.t[j];
        const u = span > 1e-6 ? THREE.MathUtils.clamp((t - this.t[j]) / span, 0, 1) : 1;
        return out.copy(this.p[j]).lerp(this.p[i], u);
      }
      i = j;
    }
    return out.copy(this.p[i]);
  }
}

/** Least time between two plays of a state-change sound (s). */
const DEBOUNCE: Partial<Record<SimEvent['kind'], number>> = {
  takeoff: 0.4,
  footstep: 0.12,
  landed: 0.4,
  touchdown: 0.4,
  heroLanding: 0.4,
  padLanding: 0.4,
  splash: 0.15,
  boostStart: 0.3,
};

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

export class Soundscape {
  private thrust: Loop | null = null;
  private boost: Loop | null = null;
  private wind: Loop | null = null;
  private beam: Loop | null = null;
  /** The airstream shaking the flared brakes (X). */
  private buffet: Loop | null = null;
  private engines: Array<{ loop: Loop; id: number }> = [];
  /** The seeker painting targets (missiles, launchers): growl, then the solid tone. */
  private growl: Loop | null = null;
  private lockTone: Loop | null = null;
  private warnT = 0;
  private readonly _r = new THREE.Vector3();
  private readonly _c = new THREE.Vector3();
  private started = false;
  private rocketSide = 0;
  /** When each state-change sound last played (s, sim time). */
  private readonly lastAt = new Map<string, number>();
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  /** The air torn open by a fast pass (heard from outside only). */
  private roar: Loop | null = null;
  /** The suit's own loops, heard as the pilot (in the suit) … */
  private onboard: GainNode | null = null;
  /** … or through the air from a camera standing off (see {@link Emitter}). */
  private air: Emitter | null = null;
  private readonly track = new Track();
  /** Sound clock (s): the frames' dt summed. */
  private now = 0;
  /** 0 = the pilot's ears, 1 = the camera's (smoothed: views crossfade). */
  private observer = 0;
  /** An outside camera is ahead of a supersonic suit, outside its Mach cone. */
  private coneArmed = false;
  /** Where the ears were last frame. */
  private readonly ear = new THREE.Vector3();
  private lastBoom = -99;
  /** The helmet view is the pilot's own ears. */
  private helmet = false;
  /** The ground under the ears: open sea, breakers on the coast, wind in the trees. */
  private sea: Loop | null = null;
  private surf: Loop | null = null;
  private trees: Loop | null = null;
  /** The boots skimming the sea (the suit's own, like the thrust). */
  private spray: Loop | null = null;
  /** Share of the ground round the ears that is sea (0–1, smoothed). */
  private water = 0;
  /** The ears' height above the ground or sea (m, smoothed). */
  private earHeight = 100;
  /** Ridge passes: the clearance last frame, and the lowest since it began falling. */
  private lastClear = Infinity;
  private dipLow = Infinity;
  private lastRidge = -99;

  constructor(private readonly audio: GameAudio) {}

  static files(): string[] {
    return Object.values(SFX);
  }

  /** Start the loops (after unlock). */
  start(): void {
    if (this.started || !this.audio.ready) return;
    this.started = true;
    const A = this.audio;
    // The steady middle of the burn, looped
    this.thrust = A.loop(SFX.thrusterBurn, { start: 0.9, end: 4.4 });
    this.boost = A.loop(SFX.thrusterBurn, { start: 1.4, end: 3.9 });
    this.wind = A.loop(SFX.wind);
    // Everything the suit itself makes splits two ways: the pilot's mix
    // and the air path to an outside camera (crossfaded by view)
    this.onboard = A.bus();
    this.air = A.emitter(22);
    const out = this.onboard && this.air ? [this.onboard, this.air.input] : undefined;
    this.thrust = A.loop(SFX.thrusterBurn, { start: 0.9, end: 4.4, out });
    this.boost = A.loop(SFX.thrusterBurn, { start: 1.4, end: 3.9, out });
    this.wind = A.loop(SFX.wind);
    this.beam = A.loop(SFX.thrusterBurn, { start: 1.0, end: 3.0, out });
    this.buffet = A.loop(SFX.buffet, { out });
    this.roar = A.loop(SFX.jetLoop, { out: this.air ? [this.air.input] : undefined });
    this.spray = A.loop(SFX.spray, { out });
    this.sea = A.loop(SFX.sea);
    this.surf = A.loop(SFX.surf);
    this.trees = A.loop(SFX.trees);
    this.growl = A.loop(SFX.seekerGrowl, { ui: true });
    this.lockTone = A.loop(SFX.lockTone, { ui: true });
  }

  /** Watching from a camera off the suit (flyby, planted, title). */
  private get outside(): boolean {
    return this.observer > 0.5;
  }

  /**
   * The boom as a standing-off camera gets it the moment the Mach cone
   * sweeps over it: the DCS boom heard from far off — the bow and tail
   * cracks, then the long rumble rolling back off the hills — however
   * close the pass, so the cinematic shots sound like a jet heard from the ground.
   */
  private distantBoom(at: THREE.Vector3): void {
    const A = this.audio;
    if (this.now - this.lastBoom < 1.5) return;
    this.lastBoom = this.now;
    A.play(SFX.sonicBoomFar, { at, ref: 60, propagate: false, gain: 1.4, echo: 0.4 });
  }

  /** The sea: the slap, the body going in, spray coming down after. */
  private splash(at: THREE.Vector3, speed: number): void {
    const A = this.audio;
    const k = THREE.MathUtils.clamp((speed - 2) / 40, 0, 1);
    A.play(k > 0.5 ? SFX.splashBig : SFX.splash, { at, gain: Math.min(1.3, 0.45 + 0.9 * k), ref: 12, vary: 0.06 });
    if (k > 0.25) {
      // Weight hitting water is a thump under the slap
      A.play(SFX.heroThud, { at, gain: 0.25 + 0.6 * k, rate: 0.7, lowpass: 900, ref: 12 });
      A.play(SFX.explosionSub, { at, gain: 0.3 * k, lowpass: 220, ref: 14 });
    }
    // The spray falling back
    if (k > 0.15) A.play(SFX.splash, { at, gain: 0.2 + 0.35 * k, rate: 1.25, vary: 0.08, ref: 12, delay: 0.35 + 0.25 * k, lowpass: 9000 });
  }

  on(e: SimEvent, m: FlightModel): void {
    const A = this.audio;
    if (!A.ready) return;
    const at = e.at;
    // Contact and regime changes come from state edges; if a state ever
    // flaps (lift off / settle on alternate physics steps) these must not
    // machine-gun the same sample at 120 Hz
    const gap = DEBOUNCE[e.kind];
    if (gap !== undefined) {
      const last = this.lastAt.get(e.kind);
      if (last !== undefined && e.t >= last && e.t - last < gap) return;
      this.lastAt.set(e.kind, e.t);
    }
    switch (e.kind) {
      case 'takeoff':
        A.play(SFX.thrusterIgnite, { at, gain: 0.9, ref: 8 });
        break;
      case 'footstep': {
        // On foot: a heavy boot (the CC0 metal thud, lifted) with the
        // library footstep's clank from its loud middle on top
        const k = e.value ?? 0.5;
        A.play(SFX.heroThud, { at, gain: 0.22 + 0.4 * k, rate: 1.35 - 0.2 * k, vary: 0.06, ref: 6 });
        A.play(SFX.footstep, { at, gain: 0.12 + 0.2 * k, offset: 0.38, duration: 0.42, vary: 0.08, ref: 6 });
        break;
      }
      case 'landed':
      case 'touchdown':
        A.play(SFX.touchdown, { at, gain: e.kind === 'touchdown' ? 1 : 0.6, ref: 8 });
        break;
      case 'heroLanding':
        A.play(SFX.heroThud, { at, gain: 1.2, ref: 10 });
        A.play(SFX.deepBoom, { at, gain: 0.9, ref: 10, echo: 0.3 });
        A.play(SFX.impact, { at, gain: 0.7, ref: 8, delay: 0.02 });
        break;
      case 'splash':
        if (at) this.splash(at, e.value ?? 5);
        break;
      case 'autoLand':
        // Handed over: the HUD's lock and the boots trimming; handed back: a click
        if (e.value) {
          A.play(SFX.lockTone, { ui: true, gain: 0.25, duration: 0.35 });
          A.play(SFX.servoWhir, { at: m.pos, gain: 0.35, ref: 6, delay: 0.1 });
        } else A.play(SFX.lockTick, { ui: true, gain: 0.2, rate: 0.7 });
        break;
      case 'padCapture':
        // The pad has the suit: one soft tick (nothing when it lets go)
        if (e.value) A.play(SFX.lockTick, { ui: true, gain: 0.22, rate: 0.8 });
        break;
      case 'padLanding':
        // The pad's clamps take the boots; the closer to the mark, the
        // fuller the answer: the deck ringing under them, the HUD's chime
        if (e.text === 'onPad') {
          A.play(SFX.weaponLock, { at, gain: 0.3, ref: 6, delay: 0.06 });
        } else if (e.text === 'centred') {
          A.play(SFX.weaponLock, { at, gain: 0.55, ref: 6, delay: 0.06 });
          A.play(SFX.killConfirm, { ui: true, gain: 0.2, rate: 0.85, delay: 0.18 });
        } else {
          A.play(SFX.weaponLock, { at, gain: 0.7, ref: 6, delay: 0.06 });
          A.play(SFX.metalResonate, { at, gain: 0.4, ref: 8, delay: 0.1, duration: 2.2 });
          A.play(SFX.killConfirm, { ui: true, gain: 0.32, delay: 0.16 });
        }
        break;
      case 'sonicBoom':
        // DCS-style: silent in the helmet (the pilot flies ahead of his own
        // noise, he never hears a boom). The chase and shoulder cameras get
        // the DCS boom right on the jet as it breaks through; a standing-off
        // camera hears it only when the Mach cone sweeps over it (update())
        if (!this.helmet && !this.outside && this.now - this.lastBoom > 1.5) {
          this.lastBoom = this.now;
          A.play(SFX.sonicBoomNear, { gain: 1.1, echo: 0.3 });
        }
        break;
      case 'boostStart':
        A.play(SFX.rocket1, { at, gain: 0.8, rate: 0.7, ref: 10 });
        A.play(SFX.thrusterIgnite, { at, gain: 0.6, rate: 0.85, ref: 8 });
        break;
      case 'repulsorCharge':
        break;
      case 'repulsorFire':
        A.play(SFX.repulsor, { at, gain: 0.75, vary: 0.07, ref: 10, offset: 0.05 });
        A.play(SFX.repulsorZap, { at, gain: 0.22, vary: 0.08, ref: 10, rate: 0.85 });
        // The blast has weight: a short low punch under the whine
        A.play(SFX.heroThud, { at, gain: 0.3, rate: 1.7, vary: 0.06, lowpass: 900, ref: 10, duration: 0.25 });
        break;
      case 'repulsorHit':
        A.play(SFX.explosionNear, { at, gain: 0.28, rate: 1.5, vary: 0.08, ref: 25, duration: 0.6 });
        A.play(SFX.sparkCrackle, { at, gain: 0.5, vary: 0.1, ref: 25 });
        A.play(pick([SFX.ping1, SFX.ping2, SFX.ping3, SFX.ping4]), { at, gain: 0.35, vary: 0.1, ref: 25 });
        break;
      case 'siloOpen':
        A.play(SFX.servoWhir, { at: m.pos, gain: 0.6, ref: 6 });
        A.play(SFX.weaponDeploy, { at: m.pos, gain: 0.7, ref: 6, delay: 0.12 });
        break;
      case 'siloClose':
        A.play(SFX.weaponStow, { at: m.pos, gain: 0.55, ref: 6 });
        break;
      case 'lockTick':
      case 'lockFull':
        // One beep per target painted, each a step up; the last one hands
        // over to the solid lock tone (update())
        A.play(SFX.lockTick, { ui: true, gain: 0.42, rate: 1 + 0.05 * ((e.value ?? 1) - 1) });
        break;
      case 'missileLaunch':
        A.play(this.rocketSide++ % 2 ? SFX.rocket1 : SFX.rocket2, { at, gain: 1.1, vary: 0.08, ref: 10 });
        break;
      case 'launcherFire':
        A.play(SFX.weaponLock, { at, gain: 0.7, ref: 6 });
        A.play(SFX.rocket1, { at, gain: 1, rate: 0.75, ref: 10, delay: 0.03 });
        A.play(SFX.explosionSub, { at, gain: 0.35, ref: 10 });
        break;
      case 'weaponDeploy':
        A.play(SFX.weaponDeploy, { at: m.pos, gain: 0.7, ref: 6 });
        break;
      case 'weaponStow':
        A.play(SFX.weaponStow, { at: m.pos, gain: 0.55, ref: 6 });
        break;
      case 'unibeamCharge':
        A.play(SFX.charge, { at: m.pos, gain: 0.9, ref: 8, delay: 0.15 });
        break;
      case 'unibeamFire':
        A.play(SFX.explosionSub, { at: m.pos, gain: 0.55, ref: 8 });
        A.play(SFX.repulsor, { at: m.pos, gain: 0.9, rate: 0.6, ref: 8 });
        break;
      case 'unibeamEnd':
        A.play(SFX.steamRelease, { at: m.pos, gain: 0.35, ref: 6, duration: 1.4 });
        break;
      case 'flareSalvo':
        A.play(SFX.electricMotor, { at: m.pos, gain: 0.35, rate: 1.6, ref: 6, duration: 0.9 });
        break;
      case 'flarePop':
        A.play(SFX.flarePop, { at, gain: 0.6, vary: 0.12, ref: 8 });
        break;
      case 'explosion':
        A.play(SFX.explosionNear, { at, gain: 1, vary: 0.08, ref: 40, echo: 0.3 });
        A.play(SFX.explosionSub, { at, gain: 0.7, vary: 0.05, ref: 40 });
        break;
      case 'bigExplosion':
        A.play(SFX.explosionHuge, { at, gain: 1.15, vary: 0.05, ref: 60, echo: 0.6 });
        A.play(SFX.explosionSub, { at, gain: 0.9, ref: 60 });
        A.play(SFX.explosionNear, { at, gain: 0.6, ref: 60, delay: 0.05 });
        break;
      case 'hitArmor':
        if ((e.value ?? 0) > 15) {
          A.play(SFX.metalClang, { at, gain: 0.9, vary: 0.05, ref: 6 });
          A.play(SFX.impact, { at, gain: 0.7, ref: 6 });
        } else {
          A.play(pick([SFX.ping1, SFX.ping2, SFX.ping3, SFX.ping4]), { at, gain: 0.7, vary: 0.12, ref: 4 });
        }
        break;
      case 'ricochet':
        A.play(SFX.zip, { at, gain: 0.5, vary: 0.15, ref: 4 });
        break;
      case 'enemyFire':
        for (let i = 0; i < (e.value ?? 4); i++) A.play(SFX.gun, { at, gain: 0.7, vary: 0.06, ref: 40, delay: i * 0.07, duration: 0.35 });
        break;
      case 'enemyMissile':
        if (e.value === 1) A.play(SFX.samLaunch, { at, gain: 1, ref: 60, echo: 0.4 });
        else A.play(SFX.rocket2, { at, gain: 0.9, rate: 0.85, ref: 40 });
        break;
      case 'droneFlyby':
        A.play(SFX.flyby, { at, vel: this._v.set(0, 0, 0), gain: 0.9, ref: 25, vary: 0.05 });
        // The pass, from the loud middle of a real jet flyby
        A.play(SFX.jet, { at, gain: 0.8, ref: 30, offset: 2.5, duration: 4 });
        break;
      case 'kill':
        A.play(SFX.killConfirm, { ui: true, gain: 0.32 });
        break;
      case 'waveStart':
        A.play(SFX.waveStart, { ui: true, gain: 0.5 });
        break;
      case 'waveClear':
        A.play(SFX.waveClear, { ui: true, gain: 0.5 });
        break;
      case 'suitCritical':
        A.play(SFX.unclampDry, { ui: true, gain: 0.8 });
        A.play(SFX.metalResonate, { ui: true, gain: 0.5, rate: 0.8 });
        break;
      case 'reboot':
        // Systems spinning back up (no voice: the HUD carries the words)
        A.play(SFX.electricMotor, { ui: true, gain: 0.6 });
        A.play(SFX.thrusterIgnite, { ui: true, gain: 0.5, delay: 0.25 });
        break;
      case 'jarvis':
        A.play(SFX.jarvisBlip, { ui: true, gain: 0.22 });
        break;
      default:
        break;
    }
  }

  /**
   * What the land and sea sound like from low over them. Round the ears: the
   * open sea's wash, the breakers where it meets the coast, wind through the
   * trees on the hills — all fading with height (from a few hundred metres
   * up it's only the airstream) and under the pilot's own wind (`masked`).
   * Made by the suit: white water thrashed up when the boots skim the sea,
   * the treetops thrashing in a low hover's downwash, and the air slapping
   * back off a ridge crest taken fast and close.
   */
  private terrain(dt: number, m: FlightModel, cam: THREE.Camera, masked: number): void {
    const g = m.ground;
    const ear = cam.position;
    const floor = Math.max(g.surface(ear.x, ear.z), 0);
    const ease = 1 - Math.exp(-dt / 0.6);
    this.earHeight += (Math.max(0, ear.y - floor) - this.earHeight) * ease;
    const h = this.earHeight;
    // Sea vs land: the ground under the ears and a ring round it, wider the
    // higher the ears (the coast is heard from further off up there)
    const r = 90 + 1.5 * h;
    let wet = g.isWater(ear.x, ear.z) ? 2 : 0;
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2;
      if (g.isWater(ear.x + r * Math.cos(a), ear.z + r * Math.sin(a))) wet++;
    }
    this.water += (wet / (RING + 2) - this.water) * ease;
    const sea = this.water;
    // Breakers wherever sea and land share the ring
    const coast = 1 - Math.abs(2 * sea - 1);
    const quiet = 1 - 0.65 * masked;
    this.sea?.set(sea * (1 - 0.6 * coast) * quiet * 0.42 / (1 + h / 45), 1, 2500 + 9000 / (1 + h / 40));
    this.surf?.set(coast * quiet * 0.7 / (1 + h / 70), 1, 3000 + 14000 / (1 + h / 50));
    // Hills: wind in the trees, and the treetops thrashing under the boots
    // in a low hover (the downwash, so it's the throttle not the airspeed)
    const below = m.clearance;
    const overLand = !g.isWater(m.pos.x, m.pos.z);
    const wash = overLand && !m.grounded ? m.throttle * THREE.MathUtils.smoothstep(-below, -35, -4) * (1 - THREE.MathUtils.smoothstep(m.speed, 20, 70)) : 0;
    const leaves = (1 - sea) * quiet * 0.4 / (1 + h / 30);
    this.trees?.set(leaves + 0.55 * wash, 1 + 0.25 * wash, 5000 + 12000 * Math.min(1, leaves * 3 + wash));
    // Skimming the sea: the boots' jets tearing up white water, louder with
    // the throttle and the speed it's dragged across the surface at
    const skim = !overLand && !m.grounded ? THREE.MathUtils.smoothstep(-below, -18, -1.5) : 0;
    const fast = THREE.MathUtils.smoothstep(m.speed, 5, 140);
    this.spray?.set(skim * Math.min(1.2, 0.45 * m.throttle + 0.8 * fast), 0.85 + 0.35 * fast, 2500 + 15000 * skim);
    // A ridge crest taken fast and close: the air slaps back off the rock
    // as it flicks past under the boots
    if (below < this.lastClear) {
      this.dipLow = Math.min(this.dipLow, below);
    } else if (this.dipLow < 30 && this.lastClear < 30) {
      const k = THREE.MathUtils.smoothstep(m.speed, 50, 250) * (1 - this.dipLow / 30);
      if (overLand && k > 0.1 && this.now - this.lastRidge > 0.6) {
        this.lastRidge = this.now;
        const at = this._r.set(m.pos.x, g.surface(m.pos.x, m.pos.z), m.pos.z);
        this.audio.play(SFX.flyby, { at, gain: 0.35 + 0.75 * k, rate: 0.75 + 0.3 * k, vary: 0.06, ref: 12, offset: 0.15 });
        this.audio.play(SFX.heroThud, { at, gain: 0.25 * k, rate: 0.6, lowpass: 400, ref: 12 });
      }
      this.dipLow = Infinity;
    } else {
      this.dipLow = Infinity;
    }
    this.lastClear = below;
  }

  update(dt: number, m: FlightModel, combat: Combat, cam: THREE.Camera, helmet: boolean, beamOn: boolean): void {
    const A = this.audio;
    if (!A.ready) return;
    this.helmet = helmet;
    this.now += dt;
    // Whose ears: the pilot's in the suit views, the camera's when it
    // stands off (flyby, a directed shot, the title orbit)
    const outside = cam.userData.observer === true;
    this.observer += ((outside ? 1 : 0) - this.observer) * (1 - Math.exp(-dt / 0.18));
    if (Math.abs(this.observer - (outside ? 1 : 0)) < 1e-3) this.observer = outside ? 1 : 0;
    A.setListener(cam, helmet ? m.vel : this._v.set(0, 0, 0), dt);
    A.muffle(combat.down > 0 ? 0.65 : helmet ? 0.18 : 0);
    this.start();
    this.track.push(this.now, m.pos);
    const sup = THREE.MathUtils.smoothstep(m.mach, 0.95, 1.08);
    const camD = cam.position.distanceTo(m.pos);
    const near = 1 / (1 + camD / 12);
    // Equal-power crossfade between the two ways of hearing the suit
    const inside = Math.cos(this.observer * Math.PI * 0.5);
    const out = Math.sin(this.observer * Math.PI * 0.5);
    const ctx = A.ctx;
    if (ctx && this.onboard) this.onboard.gain.setTargetAtTime(inside * near * 1.6, ctx.currentTime, 0.05);
    // Supersonic: an observer ahead of the suit's Mach cone hears nothing of
    // it yet — then the shock front, then the roar from behind it
    let gate = 1;
    if (m.mach > 1.0 && m.speed > 1) {
      const r = this._w.copy(cam.position).sub(m.pos);
      const ahead = -r.dot(m.vel) / (r.length() * m.speed + 1e-6);
      const cone = Math.sqrt(1 - 1 / (m.mach * m.mach));
      const inCone = ahead > cone;
      if (!inCone) this.coneArmed = true;
      if (inCone && this.coneArmed && this.outside) this.distantBoom(m.pos);
      if (inCone) this.coneArmed = false;
      gate = inCone ? 1 : 0;
    } else {
      this.coneArmed = false;
    }
    this.ear.copy(cam.position);
    this.air?.update(this.track, this.now, cam.position, out, gate);
    // Boots: louder and higher with throttle; to the pilot, past Mach 1
    // they fall away behind (outside, the air path does that for real)
    const thr = m.throttle;
    const supIn = sup * (1 - this.observer);
    const lp = THREE.MathUtils.lerp(16000, 2200, supIn);
    this.thrust?.set((m.grounded ? 0 : 0.15 + 0.9 * thr) * (1 - 0.4 * supIn), 0.82 + 0.42 * thr, lp);
    this.boost?.set(m.boosting ? 0.55 * (1 - 0.5 * supIn) : 0, 1.35 + 0.2 * thr, lp * 0.7);
    // The air torn open behind a fast suit: only from outside it
    const tear = THREE.MathUtils.smoothstep(m.speed, 40, 320);
    this.roar?.set(tear * (0.9 + 0.5 * (m.boosting ? 1 : 0)), 0.85 + 0.3 * tear);
    // Wind: rises with the square of airspeed, opens up as it builds
    // (the pilot's, in the helmet — a camera on a hillside hears a breeze)
    const air = Math.min(1, (m.speed / 260) ** 2);
    this.wind?.set((0.05 + 0.85 * air) * inside + 0.04 * out, 0.9 + 0.3 * Math.min(1, m.speed / 400) * inside, 600 + 9000 * Math.min(1, m.speed / 300) * inside);
    // Air brake: the flared plates shake in the stream, a rumble that grows
    // with the air pressing on them (nothing to buffet in a hover); a hard
    // pull shakes the plates too, under it
    const q = THREE.MathUtils.smoothstep(m.speed, 6, 140);
    const pull = THREE.MathUtils.smoothstep(m.gLoad, 4, G_LIMIT);
    this.buffet?.set(Math.max(m.airbrake * 1.1, pull * 0.5) * q, 0.72 + 0.38 * q, 900 + 5000 * q);
    this.beam?.set(beamOn ? 0.6 / Math.max(0.3, near * 1.6) : 0, 1.9, beamOn ? 9000 : 2000);
    this.terrain(dt, m, cam, air * inside);
    // Seeker: a low growl while it searches, higher and louder once it has
    // heat, then the solid tone with every round locked
    const seek = combat.weapons.seeker;
    this.growl?.set(seek === 1 ? 0.16 : seek === 2 ? 0.24 : 0, seek === 2 ? 1.3 : 1, 2800);
    this.lockTone?.set(seek === 3 ? 0.3 : 0, 1, 8000);
    // Missile warning: the RWR pulse from the side the nearest seeker is
    // coming from, quickening as it closes — half a second apart at five
    // seconds out, near-continuous in the last one
    let tgo = Infinity;
    for (const t of combat.missiles.threats()) {
      const r = this._r.copy(t.pos).sub(m.pos);
      const d = r.length();
      const closing = -r.dot(this._c.copy(t.vel).sub(m.vel)) / Math.max(d, 1e-3);
      const go = d / Math.max(30, closing);
      if (go < tgo) {
        tgo = go;
        this._w.copy(t.pos);
      }
    }
    if (tgo < Infinity) {
      this.warnT -= dt;
      if (this.warnT <= 0) {
        this.warnT = THREE.MathUtils.clamp(0.1 * tgo, 0.11, 0.5);
        const at = this._w.sub(cam.position).normalize().multiplyScalar(3).add(cam.position);
        // Fast pulses are cut short so they stay separate beeps
        A.play(SFX.rwrPulse, { at, ref: 3, propagate: false, gain: 0.55, duration: Math.min(0.28, 0.75 * this.warnT) });
      }
    } else {
      this.warnT = 0;
    }
    // Engines on the nearest drones
    const near3 = combat.drones
      .filter((d) => d.alive)
      .map((d) => ({ d, dist: d.pos.distanceTo(cam.position) }))
      .filter((x) => x.dist < 2500)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);
    for (const e of this.engines) {
      if (!near3.some((x) => x.d.id === e.id)) {
        e.loop.stop();
        e.id = -1;
      }
    }
    this.engines = this.engines.filter((e) => e.id >= 0);
    for (const { d, dist } of near3) {
      let e = this.engines.find((x) => x.id === d.id);
      if (!e) {
        const loop = A.loop(SFX.jetLoop, { spatial: true, ref: 40 });
        if (!loop) continue;
        e = { loop, id: d.id };
        this.engines.push(e);
      }
      // Doppler from the closing speed
      const dir = this._v.copy(cam.position).sub(d.pos).normalize();
      const closing = d.vel.dot(dir);
      const rate = THREE.MathUtils.clamp(SPEED_OF_SOUND / Math.max(80, SPEED_OF_SOUND - closing), 0.6, 1.8);
      e.loop.place(d.pos);
      e.loop.set(0.9 * (1 - dist / 2500), rate, 20000 * Math.exp(-dist / 1400) + 400);
    }
  }
}
