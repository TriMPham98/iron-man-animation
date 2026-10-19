import * as THREE from 'three';
import { MINI_ROCKETS, ROCKETS_PER_POD } from '../../animation/flightCheck';
import { flareDrum } from '../../suit/flightFlaps';
import type { Suit } from '../../suit/Suit';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import { IDLE_ARMS, type ArmsState } from '../sim/suitDriver';
import type { Heightfield } from '../world/heightfield';
import type { Explosions } from './explosions';
import { paintLock } from './locks';
import type { Missiles } from './missiles';
import type { Decoy, Hostile } from './types';
import { UnibeamFx } from './unibeamFx';

/**
 * The Mark III's arsenal, flown from the suit's own hardware:
 *  - repulsors (hold LMB): the arm swings onto the aim line and the palm
 *    fires, alternating hands;
 *  - mini-rockets (hold RMB to paint, release to ripple them off): the
 *    trapezius pods rise and arm cell by cell; the paint takes one lock per
 *    enemy and each rocket leaves its own tube;
 *  - unibeam (hold Space): the suit pulls up into a stance, the arc reactor
 *    winds up and the chest fires a beam that cuts through everything in
 *    its line until it overheats;
 *  - flares (F): the hip drums push out and spin, spitting a fan of flares
 *    that pull heat seekers off the suit;
 *  - forearm launchers (hold G to paint, release to fire): both bays open,
 *    the paint takes one lock per enemy, then one round at a time leaves a
 *    forearm tube — alternating arms, each raised onto its target.
 *
 * Shots are queued by {@link update} and leave the hardware in
 * {@link afterPose}, once the suit has been posed for the frame: muzzles
 * read last frame's pose trail the suit by a frame's flight (metres at
 * speed).
 */

interface Bolt {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  side: 'L' | 'R';
  /** Where it left the palm, carried on with the suit: the streak never reaches back past it. */
  o: THREE.Vector3;
  /** The suit's velocity when it fired (the bolt carries it too). */
  vs: THREE.Vector3;
  /** Age (s) and path laid since the last wisp of ionised trail (m). */
  age: number;
  laid: number;
}

interface Flare extends Decoy {
  v: THREE.Vector3;
  life: number;
  sprite: THREE.Sprite;
  laid: number;
}

type Shot = { kind: 'bolt'; side: 'L' | 'R' } | { kind: 'rocket'; target: Hostile | null } | { kind: 'launcher'; side: 0 | 1; target: Hostile | null };

const BOLT_SPEED = 780;
const REPULSOR_DAMAGE = 50;
const REPULSOR_INTERVAL = 0.17;
/** Recoil of one shot on the suit (m/s) and the shove it gives what it hits (m/s). */
const REPULSOR_RECOIL = 0.9;
const REPULSOR_KNOCK = 9;
const MISSILE_CONE = Math.cos(THREE.MathUtils.degToRad(19));
const MISSILE_RANGE = 3200;
const LOCK_TIME = 0.24;
/** Rockets per pod (one per tube; {@link MINI_ROCKETS} in all) and the most targets one paint takes. */
export const POD_ROUNDS = ROCKETS_PER_POD;
const SALVO_MAX = MINI_ROCKETS;
const SALVO_INTERVAL = 0.1;
/** Rocket kick off the rail along its tube (m/s), and how long it coasts unguided. */
const ROCKET_KICK = 28;
const ROCKET_COAST = 0.16;
/** Forearm launchers: rounds per arm, the paint, the pace of the sequence. */
export const LAUNCHER_PER_ARM = 2;
const LAUNCHER_LOCK_TIME = 0.4;
const LAUNCHER_CONE = Math.cos(THREE.MathUtils.degToRad(10));
const LAUNCHER_RANGE = 4500;
const LAUNCHER_INTERVAL = 0.55;
const LAUNCHER_KICK = 45;
/** A bay stands empty this long before the arm's next round is up (s). */
const BAY_RELOAD = 0.9;
/** Unibeam: wind-up, seconds of beam from cold to overheat, cool-down, damage. */
const UNIBEAM_CHARGE = 0.85;
const UNIBEAM_MAX = 4;
const UNIBEAM_COOL = 7;
/** Overheated, it stays locked out until it has cooled to this. */
const UNIBEAM_RESET = 0.35;
const UNIBEAM_DPS = 160;
const UNIBEAM_REACH = 2600;
/** Bind-space points the weapons fire from (fallbacks when a bay is stowed). */
const REACTOR: [number, number, number] = [0, 1.436, 0.19];
const SILO: Array<[number, number, number]> = [
  [0.13, 1.52, -0.02],
  [-0.13, 1.52, -0.02],
];

let flareTex: THREE.Texture | null = null;
function flareTexture(): THREE.Texture {
  if (flareTex) return flareTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,235,190,0.95)');
  grad.addColorStop(0.55, 'rgba(255,150,50,0.35)');
  grad.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  flareTex = new THREE.CanvasTexture(c);
  flareTex.colorSpace = THREE.SRGBColorSpace;
  return flareTex;
}

const SIDES = ['L', 'R'] as const;

export class PlayerWeapons {
  readonly arms: ArmsState = IDLE_ARMS();
  readonly group = new THREE.Group();
  /** HUD-facing state. */
  locks: Hostile[] = [];
  lockProgress = 0;
  /** Rockets left in each pod (L, R). */
  readonly pods: [number, number] = [POD_ROUNDS, POD_ROUNDS];
  readonly rocketCapacity = POD_ROUNDS * 2;
  unibeamCharge = 0;
  unibeamOn = false;
  /** Reactor heat 0–1; at 1 the beam cuts out until it cools. */
  unibeamHeat = 0;
  unibeamOverheat = false;
  flares = 48;
  flareCooldown = 0;
  /** Forearm rounds left (L, R), the targets painted, the paint's progress. */
  readonly launcherRounds: [number, number] = [LAUNCHER_PER_ARM, LAUNCHER_PER_ARM];
  launcherLocks: Hostile[] = [];
  launcherLockProgress = 0;
  /** Targets still to be fired on in the current sequence (null: the aim point). */
  launcherQueue: Array<Hostile | null> = [];
  /** Arm (0 = L) the next round leaves from. */
  nextLauncher: 0 | 1 = 0;
  /** Where the pilot's aim meets the world (m) and the assisted target. */
  readonly aimPoint = new THREE.Vector3();
  assist: Hostile | null = null;

  private readonly bolts: Bolt[] = [];
  private readonly flareList: Flare[] = [];
  private readonly beam = new UnibeamFx();
  private readonly pending: Shot[] = [];
  private repulsorT = 0;
  private nextSide: 'L' | 'R' = 'R';
  private holdL = 0;
  private holdR = 0;
  /** Arm raised to put a forearm round on its target (s left). */
  private readonly launchHold: [number, number] = [0, 0];
  private chargeSide: 'L' | 'R' | null = null;
  private chargeT = 0;
  private missileHeld = false;
  private lockT = 0;
  private salvo: Array<Hostile | null> = [];
  private salvoT = 0;
  private siloOpen = 0;
  private siloHold = 0;
  private siloArming = 0;
  private reloadT = 0;
  private flareSalvo = 0;
  private flareT = 0;
  private flareSpin = 0;
  private flareHold = 0;
  private launcherOut = 0;
  private launcherHold = 0;
  private launcherHeld = false;
  private launcherLockT = 0;
  private launcherT = 0;
  private readonly bayEmpty: [number, number] = [0, 0];
  private launcherReloadT = 0;
  private unibeamHold = 0;
  private unibeamPower = 0;
  private ventT = 0;
  private readonly beamDir = new THREE.Vector3();
  private readonly beamFrom = new THREE.Vector3();
  private readonly beamEnd = new THREE.Vector3();
  private beamHitGround = false;
  private readonly eye = new THREE.Vector3();
  private readonly aimDir = new THREE.Vector3(0, 0, -1);
  private hostiles: readonly Hostile[] = [];
  private lastDt = 0;
  /** Set once the game calls {@link afterPose} itself. */
  private posedExternally = false;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();

  constructor(
    private readonly suit: Suit,
    private readonly model: FlightModel,
    private readonly field: Heightfield,
    private readonly particles: Particles,
    private readonly streaks: Streaks,
    private readonly missiles: Missiles,
    private readonly explosions: Explosions,
    private readonly events: EventBus,
  ) {
    this.group.name = 'player-weapons';
    this.group.add(this.beam.group);
  }

  /** Rockets left in both pods. */
  get rockets(): number {
    return this.pods[0] + this.pods[1];
  }

  /** Unibeam reserve 0–1 (1 − heat). */
  get unibeamEnergy(): number {
    return 1 - this.unibeamHeat;
  }

  /** Forearm rounds left on both arms. */
  get launcherAmmo(): number {
    return this.launcherRounds[0] + this.launcherRounds[1];
  }

  /** True while the unibeam wants the suit upright and slowed. */
  get stance(): boolean {
    return this.unibeamHold > 0;
  }

  get repulsorBusy(): boolean {
    return this.holdL > 0 || this.holdR > 0;
  }

  update(dt: number, c: Controls, aim: THREE.Vector3, eye: THREE.Vector3, hostiles: readonly Hostile[], enabled: boolean): void {
    const A = this.arms;
    this.lastDt = dt;
    this.hostiles = hostiles;
    this.eye.copy(eye);
    this.aimDir.copy(aim);
    this.findAim(aim, eye, hostiles);

    // ── Repulsors ───────────────────────────────────────────────────
    this.repulsorT -= dt;
    const fire = enabled && c.fire && !this.unibeamOn;
    if (fire && this.repulsorT <= 0 && !this.chargeSide) {
      // A target well off to one side (over the shoulder, behind) is shot
      // with the hand on that side (the suit driver's call); else alternate
      this.chargeSide = A.aimSide > 0 ? 'L' : A.aimSide < 0 ? 'R' : this.nextSide;
      this.chargeT = 0;
      this.nextSide = this.chargeSide === 'L' ? 'R' : 'L';
      this.repulsorT = REPULSOR_INTERVAL;
      this.events.emit('repulsorCharge', { side: this.chargeSide });
    }
    if (this.chargeSide) {
      const side = this.chargeSide;
      if (side === 'L') this.holdL = 0.45;
      else this.holdR = 0.45;
      this.chargeT += dt;
      const ready = (side === 'L' ? A.aimL : A.aimR) > 0.75;
      if (this.chargeT > 0.05 && ready) {
        this.pending.push({ kind: 'bolt', side });
        this.chargeSide = null;
      }
    }
    this.holdL = Math.max(0, this.holdL - dt);
    this.holdR = Math.max(0, this.holdR - dt);
    this.launchHold[0] = Math.max(0, this.launchHold[0] - dt);
    this.launchHold[1] = Math.max(0, this.launchHold[1] - dt);
    const rate = (on: boolean, cur: number) => cur + ((on ? 1 : 0) - cur) * (1 - Math.exp(-dt / (on ? 0.06 : 0.22)));
    A.aimL = rate(this.holdL > 0 || this.launchHold[0] > 0, A.aimL);
    A.aimR = rate(this.holdR > 0 || this.launchHold[1] > 0, A.aimR);
    A.flashL = Math.max(0, A.flashL - dt * 6);
    A.flashR = Math.max(0, A.flashR - dt * 6);
    A.chargeL = this.chargeSide === 'L' ? Math.min(1, this.chargeT * 10) : Math.max(0, A.chargeL - dt * 8);
    A.chargeR = this.chargeSide === 'R' ? Math.min(1, this.chargeT * 10) : Math.max(0, A.chargeR - dt * 8);
    this.updateBolts(dt, hostiles);

    // ── Mini-rockets ────────────────────────────────────────────────
    const wantMissile = enabled && c.missile && this.rockets > 0 && !this.unibeamOn;
    if (wantMissile && !this.missileHeld) {
      this.missileHeld = true;
      this.locks = [];
      this.lockT = 0;
      if (this.siloOpen < 0.1) this.events.emit('siloOpen');
    }
    if (this.missileHeld) {
      this.siloHold = 0.8;
      const cap = Math.min(SALVO_MAX, this.rockets);
      if (A.silos > 0.95) {
        this.lockT += dt;
        this.lockProgress = this.locks.length >= cap ? 1 : Math.min(1, this.lockT / LOCK_TIME);
        if (this.lockT >= LOCK_TIME) {
          // One lock per enemy: the paint never doubles up on a target
          const next = paintLock(this.locks, cap, eye, aim, hostiles, MISSILE_CONE, MISSILE_RANGE);
          if (next) this.events.emit(this.locks.length >= cap ? 'lockFull' : 'lockTick', { at: next.pos, value: this.locks.length });
          this.lockT = 0;
        }
      }
      this.locks = this.locks.filter((h) => h.alive);
      if (!wantMissile) {
        this.missileHeld = false;
        this.lockProgress = 0;
        // Release: one rocket per locked enemy; none locked fires a pair at the aim point
        this.salvo = this.locks.length ? [...this.locks] : [null, null].slice(0, Math.min(2, this.rockets));
        this.salvoT = A.silos > 0.9 ? 0 : 0.4;
        this.locks = [];
      }
    }
    if (this.salvo.length) {
      this.siloHold = 0.8;
      this.salvoT -= dt;
      if (this.salvoT <= 0 && A.silos > 0.9 && this.siloArming >= 1) {
        const target = this.salvo.shift() ?? null;
        // A target that died on the way gives its rocket to the aim point
        this.pending.push({ kind: 'rocket', target: target && target.alive ? target : null });
        this.salvoT = SALVO_INTERVAL;
      }
    }
    this.siloHold = Math.max(0, this.siloHold - dt);
    const siloGoal = this.siloHold > 0 ? 1 : 0;
    if (siloGoal === 0 && this.siloOpen > 0.99) this.events.emit('siloClose');
    this.siloOpen += THREE.MathUtils.clamp(siloGoal - this.siloOpen, -dt / 0.4, dt / 0.35);
    A.silos = this.siloOpen;
    // Cells arm one after another (alternating pods) once the pods are up
    this.siloArming = A.silos > 0.98 ? Math.min(MINI_ROCKETS, this.siloArming + dt * 16) : 0;
    A.siloArmed = this.siloArming;
    if (this.rockets < this.rocketCapacity && this.siloOpen < 0.05) {
      this.reloadT += dt;
      if (this.reloadT > 1.2) {
        this.pods[this.pods[0] <= this.pods[1] ? 0 : 1]++;
        this.reloadT = 0;
      }
    }

    // ── Unibeam ─────────────────────────────────────────────────────
    const canBeam = enabled && !this.unibeamOverheat;
    const wantBeam = canBeam && c.unibeam;
    if (wantBeam) {
      if (this.unibeamHold === 0) this.events.emit('unibeamCharge', { at: this.model.pos });
      this.unibeamHold = 0.3;
    }
    this.unibeamHold = Math.max(0, this.unibeamHold - dt);
    if (wantBeam) this.unibeamCharge = Math.min(1, this.unibeamCharge + dt / UNIBEAM_CHARGE);
    else this.unibeamCharge = Math.max(0, this.unibeamCharge - dt * 2.5);
    const beamNow = wantBeam && this.unibeamCharge >= 1;
    if (beamNow && !this.unibeamOn) {
      this.events.emit('unibeamFire', { at: this.model.pos });
      this.beamDir.copy(aim);
    }
    if (!beamNow && this.unibeamOn) this.events.emit('unibeamEnd', { at: this.model.pos });
    this.unibeamOn = beamNow;
    if (this.unibeamOn) {
      this.unibeamHeat = Math.min(1, this.unibeamHeat + dt / UNIBEAM_MAX);
      if (this.unibeamHeat >= 1) {
        // Overheat: the beam cuts, the chest vents, locked out until it cools
        this.unibeamOverheat = true;
        this.unibeamOn = false;
        this.unibeamCharge = 0;
        this.ventT = 1.4;
        this.events.emit('unibeamEnd', { at: this.model.pos, value: 1 });
        this.events.emit('jarvis', { text: 'Unibeam overheated, sir. Venting.' });
      }
    } else {
      this.unibeamHeat = Math.max(0, this.unibeamHeat - dt / UNIBEAM_COOL);
      if (this.unibeamOverheat && this.unibeamHeat <= UNIBEAM_RESET) this.unibeamOverheat = false;
    }
    // The beam swells in over a few frames and collapses as fast
    this.unibeamPower += ((this.unibeamOn ? 1 : 0) - this.unibeamPower) * (1 - Math.exp(-dt / (this.unibeamOn ? 0.05 : 0.04)));
    if (!this.unibeamOn && this.unibeamPower < 0.01) this.unibeamPower = 0;
    A.unibeam += ((this.unibeamHold > 0 ? 1 : 0) - A.unibeam) * (1 - Math.exp(-dt / 0.2));
    this.suit.setSystemsPower({ reactor: 1, eyes: 1, repulsors: 1 });

    // ── Flares ─────────────────────────────────────────────────────
    this.flareCooldown = Math.max(0, this.flareCooldown - dt);
    if (enabled && c.flares && this.flareCooldown <= 0 && this.flares > 0) {
      this.flareSalvo = Math.min(8, this.flares);
      this.flareT = 0.2;
      this.flareCooldown = 3;
      this.events.emit('flareSalvo', { at: this.model.pos });
    }
    if (this.flareSalvo > 0) {
      this.flareHold = 0.5;
      this.flareSpin += dt * 9;
      this.flareT -= dt;
      if (this.flareT <= 0 && A.flares > 0.85) {
        this.popFlare(this.flareSalvo % 2 ? 'L' : 'R');
        this.flareSalvo--;
        this.flares--;
        this.flareT = 0.075;
      }
    } else if (A.flares > 0.01) {
      this.flareSpin += dt * 2 * A.flares;
    }
    this.flareHold = Math.max(0, this.flareHold - dt);
    A.flares += THREE.MathUtils.clamp((this.flareHold > 0 ? 1 : 0) - A.flares, -dt / 0.35, dt / 0.2);
    A.flareSpin = this.flareSpin;
    this.updateFlares(dt);

    // ── Forearm launchers ──────────────────────────────────────────
    this.updateLaunchers(dt, c, aim, eye, hostiles, enabled);

    // The magazine as the hardware shows it: fired cells and bays stand empty
    this.suit.weaponHardware.fx.setLoadout({
      silo: [this.pods[0], this.pods[1]],
      launcher: [this.bayLoaded(0), this.bayLoaded(1)],
    });

    // Without the game's post-pose call, fire from last frame's pose
    if (!this.posedExternally) this.afterPose(true);
  }

  private bayLoaded(i: 0 | 1): boolean {
    return this.launcherRounds[i] > 0 && this.bayEmpty[i] <= 0;
  }

  private updateLaunchers(dt: number, c: Controls, aim: THREE.Vector3, eye: THREE.Vector3, hostiles: readonly Hostile[], enabled: boolean): void {
    const A = this.arms;
    for (const i of [0, 1] as const) this.bayEmpty[i] = Math.max(0, this.bayEmpty[i] - dt);
    const want = enabled && c.launcher && this.launcherAmmo > 0 && !this.unibeamOn && !this.launcherQueue.length;
    if (want) {
      if (!this.launcherHeld) {
        this.launcherHeld = true;
        this.launcherLocks = [];
        this.launcherLockT = 0;
        if (this.launcherOut < 0.1) this.events.emit('weaponDeploy');
      }
      this.launcherHold = 0.6;
      const cap = this.launcherAmmo;
      if (A.launchers > 0.95) {
        // The next arm up rides the aim line while the lasers range
        this.launchHold[this.nextReady()] = 0.3;
        this.launcherLockT += dt;
        this.launcherLockProgress = this.launcherLocks.length >= cap ? 1 : Math.min(1, this.launcherLockT / LAUNCHER_LOCK_TIME);
        if (this.launcherLockT >= LAUNCHER_LOCK_TIME) {
          const next = paintLock(this.launcherLocks, cap, eye, aim, hostiles, LAUNCHER_CONE, LAUNCHER_RANGE);
          if (next) this.events.emit(this.launcherLocks.length >= cap ? 'lockFull' : 'lockTick', { at: next.pos, value: this.launcherLocks.length });
          this.launcherLockT = 0;
        }
      }
      this.launcherLocks = this.launcherLocks.filter((h) => h.alive);
    } else if (this.launcherHeld) {
      // Release: one round per locked enemy, one at a time; none locked
      // sends one at the aim point
      this.launcherHeld = false;
      this.launcherLockProgress = 0;
      this.launcherQueue = this.launcherLocks.length ? [...this.launcherLocks] : [null];
      this.launcherLocks = [];
      this.launcherT = 0;
    }
    if (this.launcherQueue.length) {
      this.launcherHold = 0.6;
      this.launcherT -= dt;
      const side = this.nextReady();
      if (this.launcherAmmo <= 0) this.launcherQueue = [];
      else if (A.launchers > 0.95 && this.launcherT <= 0) {
        // Raise the arm onto the line; the round leaves once it's there
        this.launchHold[side] = 0.45;
        const up = side === 0 ? A.aimL : A.aimR;
        if (up > 0.8 && this.bayLoaded(side)) {
          const target = this.launcherQueue.shift() ?? null;
          this.pending.push({ kind: 'launcher', side, target: target && target.alive ? target : null });
          this.launcherRounds[side]--;
          this.bayEmpty[side] = BAY_RELOAD;
          this.nextLauncher = side === 0 ? 1 : 0;
          this.launcherT = LAUNCHER_INTERVAL;
          if (!this.launcherQueue.length) this.launcherHold = 0.9;
        }
      }
    }
    this.launcherHold = Math.max(0, this.launcherHold - dt);
    if (this.launcherHold === 0 && this.launcherOut > 0.99) this.events.emit('weaponStow');
    this.launcherOut += THREE.MathUtils.clamp((this.launcherHold > 0 ? 1 : 0) - this.launcherOut, -dt / 0.5, dt / 0.4);
    A.launchers = this.launcherOut;
    // Seeker lock pulses: the arm that fires next glows hot once it has a target
    const locked = this.launcherLocks.length > 0 || this.launcherQueue.some((t) => t);
    const nxt = this.nextReady();
    A.lockL = A.launchers > 0.95 ? (nxt === 0 && locked ? 1 : 0.25) : 0;
    A.lockR = A.launchers > 0.95 ? (nxt === 1 && locked ? 1 : 0.25) : 0;
    if (this.launcherHold === 0) {
      this.launcherLocks = [];
      this.launcherHeld = false;
    }
    // Rounds come back up from the forearm magazine while stowed
    if (this.launcherAmmo < LAUNCHER_PER_ARM * 2 && this.launcherOut < 0.05) {
      this.launcherReloadT += dt;
      if (this.launcherReloadT > 3) {
        this.launcherRounds[this.launcherRounds[0] <= this.launcherRounds[1] ? 0 : 1]++;
        this.launcherReloadT = 0;
      }
    }
  }

  /** The arm the next forearm round leaves from: alternating, skipping an empty one. */
  private nextReady(): 0 | 1 {
    const n = this.nextLauncher;
    const o = n === 0 ? 1 : 0;
    if (this.launcherRounds[n] > 0) return n;
    return this.launcherRounds[o] > 0 ? o : n;
  }

  /**
   * Once the suit is posed for the frame: shots leave their hardware, the
   * unibeam traces from the reactor, and the streaks are laid.
   */
  afterPose(fallback = false): void {
    if (!fallback) this.posedExternally = true;
    for (const s of this.pending) {
      if (s.kind === 'bolt') this.fireBolt(s.side, this.aimDir);
      else if (s.kind === 'rocket') this.fireRocket(s.target);
      else this.fireLauncher(s.side, s.target);
    }
    this.pending.length = 0;
    this.updateBeam(this.lastDt, this.hostiles);
    this.drawStreaks();
  }

  /** Aim point: the first thing along the pilot's line of sight; snaps to a target near it. */
  private findAim(aim: THREE.Vector3, eye: THREE.Vector3, hostiles: readonly Hostile[]): void {
    let best: Hostile | null = null;
    let bestDot = Math.cos(THREE.MathUtils.degToRad(2.6));
    for (const h of hostiles) {
      if (!h.alive) continue;
      const d = this._v.copy(h.pos).sub(eye);
      const dist = d.length();
      if (dist > 1800) continue;
      const dot = d.dot(aim) / dist;
      if (dot > bestDot) {
        bestDot = dot;
        best = h;
      }
    }
    this.assist = best;
    const hit = this.field.raycast(eye, aim, 3000);
    this.aimPoint.copy(eye).addScaledVector(aim, hit > 0 ? hit : 1500);
  }

  private palmWorld(side: 'L' | 'R', out: THREE.Vector3): THREE.Vector3 {
    const p = this.suit.palms[side === 'L' ? 0 : 1];
    this.suit.boneWorldPoint(p.bone, p.at, out);
    return out;
  }

  /** Just off the face of the palm, along its normal: where a shot is born. */
  private palmMuzzle(side: 'L' | 'R', out: THREE.Vector3): THREE.Vector3 {
    const p = this.suit.palms[side === 'L' ? 0 : 1];
    this.palmWorld(side, out);
    return out.addScaledVector(this.suit.boneWorldDir(p.bone, p.normal, this._b), 0.1);
  }

  private fireBolt(side: 'L' | 'R', aim: THREE.Vector3): void {
    const from = this.palmMuzzle(side, new THREE.Vector3());
    let target = this.aimPoint;
    if (this.assist) {
      // Lead the target
      const d = from.distanceTo(this.assist.pos);
      target = this._w.copy(this.assist.pos).addScaledVector(this.assist.vel, d / BOLT_SPEED);
    }
    const dir = target.clone().sub(from).normalize();
    // Never fire backward through the suit
    if (dir.dot(aim) < 0.5) dir.copy(aim);
    // Muzzle blast: a white flash in the palm and a cone of plasma thrown
    // down the line, riding the suit's own speed
    this.particles.emit('flash', from, this.model.vel, { scale: 0.09 });
    this.particles.emit('plasma', from, this.model.vel, { scale: 2.4 });
    for (let i = 0; i < 9; i++) {
      const v = this._w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(5).addScaledVector(dir, 10 + Math.random() * 26).add(this.model.vel);
      this.particles.emit('plasma', from, v, { scale: 0.9 + Math.random() * 0.6 });
    }
    // The kick goes back up the arm into the suit
    this.model.vel.addScaledVector(dir, -REPULSOR_RECOIL);
    // The bolt leaves the palm at its own speed on top of the suit's, so a
    // shot fired flat out still pulls ahead of the hand, never falls behind it
    const vs = this.model.vel.clone();
    const v = dir.clone().multiplyScalar(BOLT_SPEED).add(vs);
    this.bolts.push({ p: from.clone(), o: from, vs, v, life: 2.2, side, age: 0, laid: 0 });
    if (side === 'L') this.arms.flashL = 1;
    else this.arms.flashR = 1;
    this.events.emit('repulsorFire', { at: from, side });
  }

  private updateBolts(dt: number, hostiles: readonly Hostile[]): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const prev = this._a.copy(b.p);
      b.p.addScaledVector(b.v, dt);
      b.o.addScaledVector(b.vs, dt);
      b.life -= dt;
      b.age += dt;
      // Ionised air left hanging along the path: a wisp every few metres
      b.laid += BOLT_SPEED * dt;
      while (b.laid > 7) {
        b.laid -= 7;
        const at = this._b.copy(b.p).addScaledVector(b.v, -b.laid / BOLT_SPEED);
        this.particles.emit('plasma', at, undefined, { scale: 0.55, life: 0.22 });
      }
      let hit: THREE.Vector3 | null = null;
      // Against hostiles (segment vs sphere)
      const seg = this._v.copy(b.p).sub(prev);
      const len2 = seg.lengthSq();
      for (const h of hostiles) {
        if (!h.alive) continue;
        const t = THREE.MathUtils.clamp(this._w.copy(h.pos).sub(prev).dot(seg) / Math.max(len2, 1e-6), 0, 1);
        const c = this._w.copy(prev).addScaledVector(seg, t);
        if (c.distanceToSquared(h.pos) < h.radius * h.radius) {
          hit = c.clone();
          // A repulsor hits like a ram: the target is shoved off its line
          h.vel.addScaledVector(seg, REPULSOR_KNOCK / Math.sqrt(Math.max(len2, 1e-6)));
          const killed = h.damage(REPULSOR_DAMAGE, hit, 'repulsor');
          if (killed) this.onKill(h);
          break;
        }
      }
      const surf = this.field.surfaceAt(b.p.x, b.p.z);
      if (!hit && b.p.y < surf) hit = new THREE.Vector3(b.p.x, surf + 0.3, b.p.z);
      if (hit || b.life <= 0) {
        if (hit) {
          // A blue-white detonation: a hard flash, a shell of plasma
          // blown outward, sparks and a slower glowing core
          this.particles.emit('flash', hit, undefined, { scale: 0.4 });
          this.particles.burst('plasma', hit, 22, 16, undefined, 1, { scale: 1.8 });
          this.particles.burst('plasma', hit, 6, 2, undefined, 1, { scale: 3.2, life: 0.4 });
          this.particles.burst('spark', hit, 22, 18, undefined, 1);
          const water = this.field.heightAt(hit.x, hit.z) < 0 && hit.y < 1;
          if (water) this.particles.burst('spray', hit, 10, 6, new THREE.Vector3(0, 1.4, 0), 0.6);
          else if (hit.y < surf + 1) this.particles.burst('dust', hit, 5, 4, new THREE.Vector3(0, 0.8, 0), 0.8, { scale: 0.8 });
          this.events.emit('repulsorHit', { at: hit });
        }
        this.bolts.splice(i, 1);
      }
    }
  }

  /** World-space mouth and bore axis of a silo tube; false if the pod isn't up. */
  private siloTube(side: 0 | 1, cell: number, at: THREE.Vector3, dir: THREE.Vector3): number {
    const hw = this.suit.weaponHardware;
    const r = hw.fx.siloMuzzle(SIDES[side], cell, at, dir);
    if (!r.ok) return 0;
    at.applyMatrix4(hw.modelWorld);
    dir.transformDirection(hw.modelWorld);
    return r.caliber;
  }

  private fireRocket(target: Hostile | null): void {
    // Reverse of the arming order: alternating pods (the fuller one first,
    // the right on a tie), each firing its last-armed cell
    const side: 0 | 1 = this.pods[0] > this.pods[1] ? 0 : 1;
    if (this.pods[side] <= 0) return;
    const cell = this.pods[side] - 1;
    this.pods[side]--;
    const from = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let caliber = this.siloTube(side, cell, from, dir);
    if (!caliber) {
      this.suit.boneWorldPoint('chest', SILO[side], from);
      this.model.thrustAxis(dir);
      caliber = 0.005;
    }
    // Off the rail along the tube, carrying the suit's own velocity
    const v = this.model.vel.clone().addScaledVector(dir, ROCKET_KICK);
    this.missiles.launch({
      team: 'player',
      from,
      vel: v,
      target,
      aimPoint: target ? undefined : this.aimPoint,
      coast: ROCKET_COAST,
      caliber,
      length: caliber * 14,
    });
    this.explosions.muzzle(from, dir, 0.1);
    this.events.emit('missileLaunch', { at: from, side: SIDES[side] });
  }

  private fireLauncher(side: 0 | 1, target: Hostile | null): void {
    const hw = this.suit.weaponHardware;
    const from = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const r = hw.fx.launcherMuzzle(SIDES[side], from, dir);
    let caliber = r.caliber;
    let length = r.length;
    if (r.ok) {
      from.applyMatrix4(hw.modelWorld);
      dir.transformDirection(hw.modelWorld);
    } else {
      this.palmWorld(SIDES[side], from);
      dir.copy(this.aimDir);
      caliber = 0.007;
      length = 0.11;
    }
    const v = this.model.vel.clone().addScaledVector(dir, LAUNCHER_KICK);
    this.missiles.launch({
      team: 'player',
      from,
      vel: v,
      target,
      aimPoint: target ? undefined : this.aimPoint,
      heavy: true,
      coast: 0.1,
      caliber,
      length,
    });
    this.explosions.muzzle(from, dir, 0.45);
    this.particles.burst('smoke', from, 3, 4, dir.clone().negate(), 0.6, { scale: 0.25, life: 0.5 });
    this.events.emit('launcherFire', { at: from, side: SIDES[side] });
  }

  /** The beam: from the reactor along the (smoothed) aim, through everything to the ground. */
  private updateBeam(dt: number, hostiles: readonly Hostile[]): void {
    const from = this.suit.boneWorldPoint('chest', REACTOR, this.beamFrom);
    const power = this.unibeamPower;
    if (power > 0) {
      // Aim: the assisted target, else the point under the sight; the beam
      // sweeps onto it (heavy, never twitchy)
      const goal = this._a.copy(this.assist ? this.assist.pos : this.aimPoint).sub(from).normalize();
      if (goal.dot(this.aimDir) < 0.6) goal.copy(this.aimDir);
      this.beamDir.lerp(goal, 1 - Math.exp(-dt / 0.07)).normalize();
      const dir = this.beamDir;
      let reach = UNIBEAM_REACH;
      const ground = this.field.raycast(from, dir, reach);
      this.beamHitGround = ground > 0;
      if (ground > 0) reach = ground;
      this.beamEnd.copy(from).addScaledVector(dir, reach);
      // It cuts through everything along its line
      const P = this.particles;
      for (const h of hostiles) {
        if (!h.alive) continue;
        const rel = this._v.copy(h.pos).sub(from);
        const t = rel.dot(dir);
        if (t < 0 || t > reach) continue;
        if (rel.addScaledVector(dir, -t).lengthSq() < (h.radius + 1.2 + t * 0.002) ** 2) {
          const at = this._w.copy(from).addScaledVector(dir, Math.max(0, t - h.radius * 0.6));
          if (h.damage(UNIBEAM_DPS * dt * power, at, 'unibeam')) this.onKill(h);
          if (Math.random() < 0.8) P.burst('spark', at, 3, 22, this._n.copy(dir).negate(), 1.2);
          P.emit('plasma', at, h.vel, { scale: 3 });
        }
      }
      // Impact: white-hot splash, sparks, and the ground scorched and smoking
      const end = this.beamEnd;
      P.emit('plasma', end, undefined, { scale: 5 });
      if (Math.random() < 0.8) P.burst('spark', end, 4, 18, this._n.copy(dir).negate(), 1.3);
      if (this.beamHitGround) {
        const water = this.field.heightAt(end.x, end.z) < 0 && end.y < 1;
        if (water) {
          if (Math.random() < 0.6) P.burst('spray', end, 4, 8, new THREE.Vector3(0, 1.5, 0), 0.6);
          if (Math.random() < 0.5) P.emit('mist', end, new THREE.Vector3(0, 4, 0), { scale: 1.2 });
        } else {
          this.field.normalAt(end.x, end.z, this._n);
          this.beam.scorchAt(end, this._n, 6);
          if (Math.random() < 0.35) P.emit('smoke', end, new THREE.Vector3(0, 3, 0), { scale: 0.7 });
          if (Math.random() < 0.3) P.emit('fire', end, new THREE.Vector3(0, 2, 0), { scale: 0.5 });
          if (Math.random() < 0.3) P.burst('dust', end, 2, 5, this._n, 0.8, { scale: 0.8 });
        }
      }
      this.model.vel.addScaledVector(dir, -14 * dt * power);
    } else {
      this.beamEnd.copy(from).addScaledVector(this.aimDir, 1);
    }
    // Overheated: the chest vents steam a while
    if (this.ventT > 0) {
      this.ventT -= dt;
      const out = this.suit.boneWorldDir('chest', [0, 0.3, 1], this._n);
      if (Math.random() < 0.7) this.particles.emit('vapor', from, this._b.copy(out).multiplyScalar(4).add(this.model.vel), { scale: 0.8 });
    }
    this.beam.update(dt, from, this.beamEnd, this.unibeamCharge * (this.unibeamHold > 0 ? 1 : 0), power, this.beamHitGround, this.eye);
  }

  private popFlare(side: 'L' | 'R'): void {
    const drum = flareDrum(side);
    const at = this.suit.boneWorldPoint('hips', drum.center.toArray() as [number, number, number], new THREE.Vector3());
    const out = this.suit.boneWorldDir('hips', drum.normal.toArray() as [number, number, number], new THREE.Vector3());
    const back = this.model.vel.lengthSq() > 4 ? this.model.vel.clone().normalize().negate() : new THREE.Vector3(0, 0, 0);
    const v = this.model.vel
      .clone()
      .addScaledVector(out, 22 + Math.random() * 8)
      .addScaledVector(back, 12)
      .add(new THREE.Vector3((Math.random() - 0.5) * 6, 6 + Math.random() * 6, (Math.random() - 0.5) * 6));
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: flareTexture(), color: 0xfff1d8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    sprite.position.copy(at);
    this.group.add(sprite);
    const f: Flare = { pos: at, heat: 1, v, life: 3.6 + Math.random(), sprite, laid: 0 };
    this.flareList.push(f);
    this.missiles.offerDecoy(f, this.model.pos);
    this.particles.burst('spark', at, 8, 10, out, 0.6);
    this.particles.emit('flash', at, undefined, { scale: 0.12 });
    this.events.emit('flarePop', { at, side });
  }

  private updateFlares(dt: number): void {
    for (let i = this.flareList.length - 1; i >= 0; i--) {
      const f = this.flareList[i];
      f.life -= dt;
      const sp = f.v.length();
      f.v.multiplyScalar(1 / (1 + 0.02 * sp * dt));
      f.v.y -= 6 * dt;
      f.pos.addScaledVector(f.v, dt);
      const burn = Math.min(1, f.life / 0.8);
      f.heat = burn;
      const flick = 0.75 + 0.25 * Math.sin(f.life * 70 + i);
      f.sprite.position.copy(f.pos);
      f.sprite.scale.setScalar((1.6 + 0.8 * flick) * burn + 0.05);
      f.sprite.material.color.setRGB(4 * flick, 3.2 * flick, 2.2 * flick);
      f.laid += sp * dt;
      while (f.laid > 1.2) {
        f.laid -= 1.2;
        this.particles.emit('trail', f.pos, undefined, { scale: 1.1, life: 0.8 });
        if (Math.random() < 0.5) this.particles.emit('spark', f.pos, f.v.clone().multiplyScalar(-0.1), { scale: 1 });
      }
      if (f.life <= 0 || f.pos.y < this.field.surfaceAt(f.pos.x, f.pos.z)) {
        this.group.remove(f.sprite);
        f.sprite.material.dispose();
        this.flareList.splice(i, 1);
      }
    }
    // Slowly restock
    if (this.flares < 48) this.flareRestock += dt;
    if (this.flareRestock > 3) {
      this.flares++;
      this.flareRestock = 0;
    }
  }

  private flareRestock = 0;

  private onKill(h: Hostile): void {
    this.events.emit('kill', { at: h.pos, text: h.kind });
  }

  private drawStreaks(): void {
    const S = this.streaks;
    for (const b of this.bolts) {
      // A white-hot slug in a blue sheath, its tail stretched behind it —
      // but never back past the palm it left (it grows out of the hand)
      const len = Math.min(0.012, b.p.distanceTo(b.o) / b.v.length());
      const tail = this._a.copy(b.p).addScaledVector(b.v, -len);
      S.add(tail, b.p, 2.2, 4.5, 10, 0.7, 0.1, 0.55);
      const mid = this._b.copy(b.p).addScaledVector(b.v, -len * 0.45);
      S.add(mid, b.p, 9, 11, 14, 1, 0.05, 0.16);
    }
    // Launcher lock: each arm's laser ranges the targets it will take, the
    // next shot's line brightest
    if (this.arms.launchers > 0.95) {
      const targets = this.launcherHeld ? this.launcherLocks : this.launcherQueue;
      const hw = this.suit.weaponHardware;
      let side = this.nextReady();
      targets.forEach((t, i) => {
        if (!t || !t.alive) return;
        if (hw.fx.launcherMuzzle(SIDES[side], this._a, this._b).ok) {
          this._a.applyMatrix4(hw.modelWorld);
          S.add(this._a, t.pos, 6, 0.6, 0.3, i === 0 ? 0.9 : 0.35, 0.02, 0.6);
        }
        if (this.launcherRounds[side === 0 ? 1 : 0] > 0) side = side === 0 ? 1 : 0;
      });
    }
  }

  /** Enemy-facing flares (for missiles to chase). */
  get decoys(): readonly Decoy[] {
    return this.flareList;
  }
}
