import * as THREE from 'three';
import { flareDrum, forearmAxis, forearmNormal } from '../../suit/flightFlaps';
import type { Suit } from '../../suit/Suit';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import { IDLE_ARMS, type ArmsState } from '../sim/suitDriver';
import type { Heightfield } from '../world/heightfield';
import type { Explosions } from './explosions';
import type { Missiles } from './missiles';
import type { Decoy, Hostile } from './types';

/**
 * The Mark III's arsenal, flown from the suit's own hardware:
 *  - repulsors (hold LMB): the arm swings onto the aim line and the palm
 *    fires, alternating hands;
 *  - mini-rockets (hold RMB to paint up to six targets, release to ripple
 *    them off): the trapezius silos rise and arm cell by cell;
 *  - unibeam (hold Q): the suit pulls up into a stance, the arc reactor
 *    charges and the chest fires — it cuts through anything in its line;
 *  - flares (F): the hip drums push out and spin, spitting a fan of flares
 *    that pull heat seekers off the suit;
 *  - forearm launchers (hold G): a laser lock, then a heavy rocket off each
 *    forearm.
 */

interface Bolt {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  side: 'L' | 'R';
}

interface Flare extends Decoy {
  v: THREE.Vector3;
  life: number;
  sprite: THREE.Sprite;
  laid: number;
}

const BOLT_SPEED = 780;
const REPULSOR_DAMAGE = 50;
const REPULSOR_INTERVAL = 0.17;
const MISSILE_CONE = Math.cos(THREE.MathUtils.degToRad(19));
const MISSILE_RANGE = 3200;
const LOCK_TIME = 0.24;
const UNIBEAM_CHARGE = 0.75;
const UNIBEAM_MAX = 3.6;
const UNIBEAM_DPS = 150;
/** Bind-space points the weapons fire from. */
const REACTOR: [number, number, number] = [0, 1.436, 0.19];
const SILO_L: [number, number, number] = [0.13, 1.52, -0.02];
const SILO_R: [number, number, number] = [-0.13, 1.52, -0.02];

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

export class PlayerWeapons {
  readonly arms: ArmsState = IDLE_ARMS();
  readonly group = new THREE.Group();
  /** HUD-facing state. */
  locks: Hostile[] = [];
  lockProgress = 0;
  rockets = 6;
  unibeamEnergy = 1;
  unibeamCharge = 0;
  unibeamOn = false;
  flares = 48;
  flareCooldown = 0;
  launcherCooldown = 0;
  launcherLock: Hostile | null = null;
  launcherLockT = 0;
  /** Where the pilot's aim meets the world (m) and the assisted target. */
  readonly aimPoint = new THREE.Vector3();
  assist: Hostile | null = null;

  private readonly bolts: Bolt[] = [];
  private readonly flareList: Flare[] = [];
  private repulsorT = 0;
  private nextSide: 'L' | 'R' = 'R';
  private holdL = 0;
  private holdR = 0;
  private chargeSide: 'L' | 'R' | null = null;
  private chargeT = 0;
  private missileHeld = false;
  private lockT = 0;
  private salvo: Array<Hostile | null> = [];
  private salvoT = 0;
  private salvoSide = 0;
  private siloOpen = 0;
  private siloHold = 0;
  private reloadT = 0;
  private flareSalvo = 0;
  private flareT = 0;
  private flareSpin = 0;
  private flareHold = 0;
  private launcherOut = 0;
  private launcherHold = 0;
  private unibeamHold = 0;
  private beamEnd = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();

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
    this.findAim(aim, eye, hostiles);

    // ── Repulsors ───────────────────────────────────────────────────
    this.repulsorT -= dt;
    const fire = enabled && c.fire && !this.unibeamOn;
    if (fire && this.repulsorT <= 0 && !this.chargeSide) {
      this.chargeSide = this.nextSide;
      this.chargeT = 0;
      this.nextSide = this.nextSide === 'L' ? 'R' : 'L';
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
        this.fireBolt(side, aim);
        this.chargeSide = null;
      }
    }
    this.holdL = Math.max(0, this.holdL - dt);
    this.holdR = Math.max(0, this.holdR - dt);
    const rate = (on: boolean, cur: number) => cur + ((on ? 1 : 0) - cur) * (1 - Math.exp(-dt / (on ? 0.06 : 0.22)));
    A.aimL = rate(this.holdL > 0, A.aimL);
    A.aimR = rate(this.holdR > 0, A.aimR);
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
      if (A.silos > 0.95) {
        this.lockT += dt;
        this.lockProgress = Math.min(1, this.lockT / LOCK_TIME);
        if (this.lockT >= LOCK_TIME && this.locks.length < this.rockets) {
          const next = this.bestTarget(aim, eye, hostiles, this.locks);
          if (next) {
            this.locks.push(next);
            this.events.emit(this.locks.length >= Math.min(this.rockets, 6) ? 'lockFull' : 'lockTick', { at: next.pos, value: this.locks.length });
          }
          this.lockT = 0;
        }
      }
      this.locks = this.locks.filter((h) => h.alive);
      if (!wantMissile) {
        this.missileHeld = false;
        this.lockProgress = 0;
        // Release: one rocket per lock; none locked fires a pair at the aim point
        this.salvo = this.locks.length ? [...this.locks] : [null, null].slice(0, Math.min(2, this.rockets));
        this.salvoT = A.silos > 0.9 ? 0 : 0.4;
        this.locks = [];
      }
    }
    if (this.salvo.length) {
      this.siloHold = 0.8;
      this.salvoT -= dt;
      if (this.salvoT <= 0 && A.silos > 0.9) {
        const target = this.salvo.shift() ?? null;
        this.fireRocket(target, aim);
        this.salvoT = 0.085;
      }
    }
    this.siloHold = Math.max(0, this.siloHold - dt);
    const siloGoal = this.siloHold > 0 ? 1 : 0;
    if (siloGoal === 0 && this.siloOpen > 0.99) this.events.emit('siloClose');
    this.siloOpen += THREE.MathUtils.clamp(siloGoal - this.siloOpen, -dt / 0.4, dt / 0.35);
    A.silos = this.siloOpen;
    A.siloArmed = this.rockets;
    if (this.rockets < 6 && this.siloOpen < 0.05) {
      this.reloadT += dt;
      if (this.reloadT > 2.4) {
        this.rockets++;
        this.reloadT = 0;
      }
    }

    // ── Unibeam ─────────────────────────────────────────────────────
    // Hysteresis: it takes a quarter charge to start, and runs until empty
    const wantBeam = enabled && c.unibeam && this.unibeamEnergy > (this.unibeamOn ? 0 : 0.25);
    if (wantBeam) {
      if (this.unibeamHold === 0) this.events.emit('unibeamCharge');
      this.unibeamHold = 0.3;
    }
    this.unibeamHold = Math.max(0, this.unibeamHold - dt);
    if (this.unibeamHold > 0 && (wantBeam || this.unibeamOn)) {
      this.unibeamCharge = Math.min(1, this.unibeamCharge + dt / UNIBEAM_CHARGE);
    } else {
      this.unibeamCharge = Math.max(0, this.unibeamCharge - dt * 2);
    }
    const beamNow = wantBeam && this.unibeamCharge >= 1 && this.unibeamEnergy > 0;
    if (beamNow && !this.unibeamOn) this.events.emit('unibeamFire');
    if (!beamNow && this.unibeamOn) this.events.emit('unibeamEnd');
    this.unibeamOn = beamNow;
    if (this.unibeamOn) {
      this.unibeamEnergy = Math.max(0, this.unibeamEnergy - dt / UNIBEAM_MAX);
      this.fireBeam(dt, aim, hostiles);
    } else {
      this.unibeamEnergy = Math.min(1, this.unibeamEnergy + dt / 9);
    }
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
    this.launcherCooldown = Math.max(0, this.launcherCooldown - dt);
    if (enabled && c.launcher && this.launcherCooldown <= 0 && !this.unibeamOn) {
      if (this.launcherHold === 0) this.events.emit('weaponDeploy');
      this.launcherHold = 0.6;
      if (A.launchers > 0.95) {
        const t = this.bestTarget(aim, eye, hostiles, [], Math.cos(THREE.MathUtils.degToRad(7)), 4500);
        if (t !== this.launcherLock) {
          this.launcherLock = t;
          this.launcherLockT = 0;
        }
        this.launcherLockT += dt;
        A.lockL = A.lockR = this.launcherLock ? Math.min(1, this.launcherLockT / 0.5) : 0.25;
        if (this.launcherLock && this.launcherLockT > 0.5) this.fireLaunchers(this.launcherLock, aim);
      }
    } else if (this.launcherHold > 0 && !c.launcher && A.launchers > 0.95 && this.launcherCooldown <= 0) {
      // Released before a lock: fire at the aim point
      this.fireLaunchers(this.launcherLock && this.launcherLockT > 0.5 ? this.launcherLock : null, aim);
    }
    this.launcherHold = Math.max(0, this.launcherHold - dt);
    if (this.launcherHold === 0 && this.launcherOut > 0.99) this.events.emit('weaponStow');
    this.launcherOut += THREE.MathUtils.clamp((this.launcherHold > 0 ? 1 : 0) - this.launcherOut, -dt / 0.5, dt / 0.4);
    A.launchers = this.launcherOut;
    if (this.launcherHold === 0) {
      A.lockL = A.lockR = 0;
      this.launcherLock = null;
    }

    this.drawStreaks();
  }

  /** The hostile closest to the aim line within the cone, not already taken. */
  private bestTarget(aim: THREE.Vector3, eye: THREE.Vector3, hostiles: readonly Hostile[], taken: readonly Hostile[], cone = MISSILE_CONE, range = MISSILE_RANGE): Hostile | null {
    let best: Hostile | null = null;
    let bestDot = cone;
    for (const h of hostiles) {
      if (!h.alive) continue;
      // A second lock on the same target only once every other is taken
      const takenCount = taken.filter((t) => t === h).length;
      const d = this._v.copy(h.pos).sub(eye);
      const dist = d.length();
      if (dist > range) continue;
      const dot = d.divideScalar(dist).dot(aim) - takenCount * 0.02;
      if (dot > bestDot) {
        bestDot = dot;
        best = h;
      }
    }
    return best;
  }

  /** Aim point: the first thing along the pilot's line of sight; snaps to a target near it. */
  private findAim(aim: THREE.Vector3, eye: THREE.Vector3, hostiles: readonly Hostile[]): void {
    this.assist = this.bestTarget(aim, eye, hostiles, [], Math.cos(THREE.MathUtils.degToRad(2.6)), 1800);
    const hit = this.field.raycast(eye, aim, 3000);
    this.aimPoint.copy(eye).addScaledVector(aim, hit > 0 ? hit : 1500);
  }

  private palmWorld(side: 'L' | 'R', out: THREE.Vector3): THREE.Vector3 {
    const p = this.suit.palms[side === 'L' ? 0 : 1];
    this.suit.boneWorldPoint(p.bone, p.at, out);
    return out;
  }

  private fireBolt(side: 'L' | 'R', aim: THREE.Vector3): void {
    const from = this.palmWorld(side, new THREE.Vector3());
    let target = this.aimPoint;
    if (this.assist) {
      // Lead the target
      const d = from.distanceTo(this.assist.pos);
      target = this._w.copy(this.assist.pos).addScaledVector(this.assist.vel, d / BOLT_SPEED);
    }
    const dir = target.clone().sub(from).normalize();
    // Never fire backward through the suit
    if (dir.dot(aim) < 0.5) dir.copy(aim);
    // Energy bolts don't inherit the suit's speed: they fly where they're aimed
    const v = dir.multiplyScalar(BOLT_SPEED);
    this.bolts.push({ p: from, v, life: 2.2, side });
    if (side === 'L') this.arms.flashL = 1;
    else this.arms.flashR = 1;
    this.particles.emit('plasma', from, this.model.vel, { scale: 1.6 });
    this.events.emit('repulsorFire', { at: from, side });
  }

  private updateBolts(dt: number, hostiles: readonly Hostile[]): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const prev = this._a.copy(b.p);
      b.p.addScaledVector(b.v, dt);
      b.life -= dt;
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
          const killed = h.damage(REPULSOR_DAMAGE, hit, 'repulsor');
          if (killed) this.onKill(h);
          break;
        }
      }
      const surf = this.field.surfaceAt(b.p.x, b.p.z);
      if (!hit && b.p.y < surf) hit = new THREE.Vector3(b.p.x, surf + 0.3, b.p.z);
      if (hit || b.life <= 0) {
        if (hit) {
          this.particles.burst('plasma', hit, 10, 9, undefined, 1, { scale: 1.6 });
          this.particles.burst('spark', hit, 14, 14, undefined, 1);
          this.particles.emit('flash', hit, undefined, { scale: 0.22 });
          const water = this.field.heightAt(hit.x, hit.z) < 0 && hit.y < 1;
          if (water) this.particles.burst('spray', hit, 10, 6, new THREE.Vector3(0, 1.4, 0), 0.6);
          else if (hit.y < surf + 1) this.particles.burst('dust', hit, 5, 4, new THREE.Vector3(0, 0.8, 0), 0.8, { scale: 0.8 });
          this.events.emit('repulsorHit', { at: hit });
        }
        this.bolts.splice(i, 1);
      }
    }
  }

  private fireRocket(target: Hostile | null, aim: THREE.Vector3): void {
    if (this.rockets <= 0) return;
    this.rockets--;
    const side = this.salvoSide++ % 2 === 0 ? SILO_L : SILO_R;
    const from = this.suit.boneWorldPoint('chest', side, new THREE.Vector3());
    // Kick out along the suit's head line and up off its back
    const head = this.model.thrustAxis(new THREE.Vector3());
    const back = this.suit.boneWorldDir('chest', [0, 0, -1], new THREE.Vector3());
    const v = this.model.vel.clone().addScaledVector(head, 30).addScaledVector(back, 14).addScaledVector(aim, 20);
    this.missiles.launch({ team: 'player', from, vel: v, target, aimPoint: target ? undefined : this.aimPoint });
    this.explosions.muzzle(from, v.clone().normalize(), 0.6);
    this.events.emit('missileLaunch', { at: from });
  }

  private fireLaunchers(target: Hostile | null, aim: THREE.Vector3): void {
    for (const side of ['L', 'R'] as const) {
      const s = side === 'L' ? 1 : -1;
      const n = forearmNormal(side);
      const from = this.suit.boneWorldPoint(`forearm.${side}`, [s * 0.37 + n.x * 0.05, 1.08 + n.y * 0.05, 0.03 + n.z * 0.05], new THREE.Vector3());
      const along = this.suit.boneWorldDir(`forearm.${side}`, forearmAxis(side).toArray() as [number, number, number], new THREE.Vector3());
      const v = this.model.vel.clone().addScaledVector(aim, 120).addScaledVector(along, 10);
      this.missiles.launch({ team: 'player', from, vel: v, target, aimPoint: target ? undefined : this.aimPoint, heavy: true, coast: 0.08 });
      this.explosions.muzzle(from, aim, 1);
    }
    this.launcherCooldown = 7;
    this.launcherHold = 0.35;
    this.launcherLockT = 0;
    this.events.emit('launcherFire', { at: this.model.pos });
  }

  private fireBeam(dt: number, aim: THREE.Vector3, hostiles: readonly Hostile[]): void {
    const from = this.suit.boneWorldPoint('chest', REACTOR, this._b);
    const dir = this._a.copy(this.aimPoint).sub(from).normalize();
    if (dir.dot(aim) < 0.6) dir.copy(aim);
    let reach = 2600;
    const ground = this.field.raycast(from, dir, reach);
    if (ground > 0) reach = ground;
    let victim: Hostile | null = null;
    for (const h of hostiles) {
      if (!h.alive) continue;
      const rel = this._v.copy(h.pos).sub(from);
      const t = rel.dot(dir);
      if (t < 0 || t > reach) continue;
      if (rel.addScaledVector(dir, -t).lengthSq() < (h.radius + 4 + t * 0.004) ** 2) {
        reach = t;
        victim = h;
      }
    }
    this.beamEnd.copy(from).addScaledVector(dir, reach);
    if (victim && victim.damage(UNIBEAM_DPS * dt, this.beamEnd, 'unibeam')) this.onKill(victim);
    // Impact: white-hot splash, sparks, scorching dust where it digs in
    const P = this.particles;
    P.emit('plasma', this.beamEnd, undefined, { scale: 4 });
    if (Math.random() < 0.7) P.burst('spark', this.beamEnd, 3, 16, undefined, 1);
    if (ground > 0 && !victim && Math.random() < 0.4) P.emit('smoke', this.beamEnd, new THREE.Vector3(0, 3, 0), { scale: 0.6 });
    this.model.vel.addScaledVector(dir, -14 * dt);
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
      const tail = this._a.copy(b.p).addScaledVector(b.v, -0.006);
      S.add(tail, b.p, 3.5, 6.5, 10, 1, 0.16, 0.32);
    }
    if (this.unibeamOn) {
      const from = this.suit.boneWorldPoint('chest', REACTOR, this._b);
      const fl = 0.85 + 0.15 * Math.sin(performance.now() * 0.05);
      S.add(from, this.beamEnd, 6 * fl, 10 * fl, 14 * fl, 1, 0.3, 0.55);
      S.add(from, this.beamEnd, 1.2, 2.6, 4.5, 0.6, 1.1, 1.8);
    }
    // Launcher lock: the forearm lasers range the target
    if (this.arms.launchers > 0.95 && this.launcherLock) {
      for (const side of ['L', 'R'] as const) {
        const s = side === 'L' ? 1 : -1;
        const from = this.suit.boneWorldPoint(`forearm.${side}`, [s * 0.37, 1.08, 0.03], this._a);
        S.add(from, this.launcherLock.pos, 6, 0.6, 0.3, 0.5 + 0.5 * Math.min(1, this.launcherLockT * 2), 0.02);
      }
    }
  }

  /** Enemy-facing flares (for missiles to chase). */
  get decoys(): readonly Decoy[] {
    return this.flareList;
  }
}
