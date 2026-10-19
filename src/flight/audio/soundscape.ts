import * as THREE from 'three';
import type { Combat } from '../combat/combat';
import type { SimEvent } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
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
  sonicNwave: `${KIT}sonic-nwave.mp3`,
  heroThud: `${KIT}hero-thud.mp3`,
  deepBoom: `${KIT}deep-boom.mp3`,
  rocket1: `${KIT}rocket-1.mp3`,
  rocket2: `${KIT}rocket-2.mp3`,
  flyby: `${KIT}flyby.mp3`,
  zip: `${KIT}zip.mp3`,
  charge: `${KIT}charge.mp3`,
  repulsorZap: `${KIT}repulsor-zap.mp3`,
  lockTick: `${KIT}lock-tick.mp3`,
  lockFull: `${KIT}lock-full.mp3`,
  warn: `${KIT}warn.mp3`,
  jarvisBlip: `${KIT}jarvis-blip.mp3`,
  waveTone: `${KIT}wave-tone.mp3`,
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
} as const;

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
  splash: 0.15,
  boostStart: 0.3,
};

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

export class Soundscape {
  private thrust: Loop | null = null;
  private boost: Loop | null = null;
  private wind: Loop | null = null;
  private beam: Loop | null = null;
  private engines: Array<{ loop: Loop; id: number }> = [];
  private warnT = 0;
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
    this.roar = A.loop(SFX.jetLoop, { out: this.air ? [this.air.input] : undefined });
  }

  /** Watching from a camera off the suit (flyby, planted, title). */
  private get outside(): boolean {
    return this.observer > 0.5;
  }

  /**
   * The double boom, as an outside ear gets it the moment the Mach cone
   * sweeps over it: a real recording of the N-wave — the bow shock's
   * crack, then ~0.11 s on the tail shock's — with a sub slam under each
   * crack and the whole thing thrown back off the hills.
   */
  private doubleBoom(at: THREE.Vector3): void {
    const A = this.audio;
    if (this.now - this.lastBoom < 1.5) return;
    this.lastBoom = this.now;
    const o = { at, ref: 60, propagate: false };
    // The cracks land 0.07 s and 0.18 s into the file
    A.play(SFX.sonicNwave, { ...o, gain: 1.5, echo: 0.6 });
    A.play(SFX.sonicNwave, { ...o, gain: 0.6, rate: 0.82, lowpass: 900, delay: 0.012 });
    A.play(SFX.explosionSub, { ...o, gain: 0.95, lowpass: 240, delay: 0.06 });
    A.play(SFX.deepBoom, { ...o, gain: 1.1, lowpass: 1600, delay: 0.17, echo: 0.5 });
    A.play(SFX.explosionHuge, { ...o, gain: 0.45, lowpass: 420, delay: 0.25 });
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
      case 'sonicBoom':
        // DCS-style: breaking the barrier is silent in the suit (the pilot
        // flies ahead of his own noise, he never hears a boom); an outside
        // ear hears it only when the Mach cone sweeps over it (update())
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
        A.play(SFX.lockTick, { ui: true, gain: 0.5, rate: 1 + 0.06 * (e.value ?? 1) });
        break;
      case 'lockFull':
        A.play(SFX.lockFull, { ui: true, gain: 0.6 });
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
        A.play(SFX.lockTick, { ui: true, gain: 0.35, rate: 0.8 });
        break;
      case 'waveStart':
        A.play(SFX.waveTone, { ui: true, gain: 0.55 });
        break;
      case 'waveClear':
        A.play(SFX.lockFull, { ui: true, gain: 0.45, rate: 0.9 });
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
        A.play(SFX.jarvisBlip, { ui: true, gain: 0.3 });
        break;
      default:
        break;
    }
  }

  update(dt: number, m: FlightModel, combat: Combat, cam: THREE.Camera, helmet: boolean, beamOn: boolean): void {
    const A = this.audio;
    if (!A.ready) return;
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
      if (inCone && this.coneArmed && this.outside) this.doubleBoom(m.pos);
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
    this.beam?.set(beamOn ? 0.6 / Math.max(0.3, near * 1.6) : 0, 1.9, beamOn ? 9000 : 2000);
    // Missile warning: a fast, insistent tone while a seeker is on us
    if (combat.incoming > 0) {
      this.warnT -= dt;
      if (this.warnT <= 0) {
        A.play(SFX.warn, { ui: true, gain: 0.32 });
        this.warnT = 0.24;
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
