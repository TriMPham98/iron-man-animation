import * as THREE from 'three';
import type { Combat } from '../combat/combat';
import type { SimEvent } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import { SPEED_OF_SOUND } from '../world/config';
import type { GameAudio, Loop } from './gameAudio';

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
  jarvisStartup: `${LIB}jarvis-startup.mp3`,
  metalResonate: `${LIB}metal-resonate.mp3`,
  unclampDry: `${LIB}unclamp-dry.mp3`,
  // Combat and air (CC0 kit, picked by eye from their spectrograms)
  explosionNear: `${KIT}explosion-near.mp3`,
  explosionSub: `${KIT}explosion-sub.mp3`,
  explosionHuge: `${KIT}explosion-huge.mp3`,
  sonicCrack: `${KIT}sonic-crack.mp3`,
  sonicBoom: `${KIT}sonic-boom.mp3`,
  heroThud: `${KIT}hero-thud.mp3`,
  deepBoom: `${KIT}deep-boom.mp3`,
  metalCrash: `${KIT}metal-crash.mp3`,
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

/** Least time between two plays of a state-change sound (s). */
const DEBOUNCE: Partial<Record<SimEvent['kind'], number>> = {
  takeoff: 0.4,
  landed: 0.4,
  touchdown: 0.4,
  heroLanding: 0.4,
  impact: 0.12,
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
    this.beam = A.loop(SFX.thrusterBurn, { start: 1.0, end: 3.0 });
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
      case 'landed':
      case 'touchdown':
        A.play(SFX.touchdown, { at, gain: e.kind === 'touchdown' ? 1 : 0.6, ref: 8 });
        break;
      case 'heroLanding':
        A.play(SFX.heroThud, { at, gain: 1.2, ref: 10 });
        A.play(SFX.deepBoom, { at, gain: 0.9, ref: 10, echo: 0.3 });
        A.play(SFX.impact, { at, gain: 0.7, ref: 8, delay: 0.02 });
        break;
      case 'impact': {
        const k = Math.min(1, (e.value ?? 10) / 60);
        A.play(SFX.metalCrash, { at, gain: 0.5 + 0.7 * k, ref: 10, vary: 0.05 });
        A.play(SFX.heroThud, { at, gain: 0.4 + 0.6 * k, ref: 10 });
        break;
      }
      case 'splash':
        A.play((e.value ?? 0) > 25 ? SFX.splashBig : SFX.splash, { at, gain: Math.min(1.3, 0.4 + (e.value ?? 5) / 25), ref: 12, vary: 0.06 });
        break;
      case 'sonicBoom':
        // Two cracks of the N-wave, then the weight of it
        A.play(SFX.sonicCrack, { ui: true, gain: 0.95 });
        A.play(SFX.sonicCrack, { ui: true, gain: 0.7, delay: 0.11, rate: 0.92 });
        A.play(SFX.sonicBoom, { ui: true, gain: 1.15, delay: 0.02 });
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
        break;
      case 'repulsorHit':
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
        A.play(this.rocketSide++ % 2 ? SFX.rocket1 : SFX.rocket2, { at, gain: 0.85, vary: 0.08, ref: 10 });
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
        A.play(SFX.jarvisStartup, { ui: true, gain: 0.8 });
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
    A.setListener(cam, helmet ? m.vel : this._v.set(0, 0, 0), dt);
    A.muffle(combat.down > 0 ? 0.65 : helmet ? 0.18 : 0);
    this.start();
    const sup = THREE.MathUtils.smoothstep(m.mach, 0.95, 1.08);
    const camD = cam.position.distanceTo(m.pos);
    const near = 1 / (1 + camD / 12);
    // Boots: louder and higher with throttle; past Mach 1 they fall away behind
    const thr = m.throttle;
    const lp = THREE.MathUtils.lerp(16000, 2200, sup);
    this.thrust?.set((m.grounded ? 0 : 0.15 + 0.9 * thr) * near * 1.6 * (1 - 0.4 * sup), 0.82 + 0.42 * thr, lp);
    this.boost?.set(m.boosting ? 0.55 * near * 1.6 * (1 - 0.5 * sup) : 0, 1.35 + 0.2 * thr, lp * 0.7);
    // Wind: rises with the square of airspeed, opens up as it builds
    const air = Math.min(1, (m.speed / 260) ** 2);
    this.wind?.set(0.05 + 0.85 * air, 0.9 + 0.3 * Math.min(1, m.speed / 400), 600 + 9000 * Math.min(1, m.speed / 300));
    this.beam?.set(beamOn ? 0.6 : 0, 1.9, beamOn ? 9000 : 2000);
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
