import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Particles } from '../fx/particles';
import type { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { Explosions, SurfaceQuery } from './explosions';
import type { Missiles } from './missiles';
import type { DamageKind, Hostile, PlayerTarget } from './types';

/**
 * Hostile drones: tailless jet UCAVs, gunmetal with a red sensor eye.
 * Each flies a simple fighter brain — find the suit, run in leading it,
 * fire short cannon bursts inside 900 m, overshoot and extend, come round
 * again — plus terrain avoidance, a hard break when a rocket is on it, and
 * the odd heat seeker from range. Shot down, it trails fire and smoke all
 * the way in and blows again where it hits.
 */

const mats = {
  hull: new THREE.MeshStandardMaterial({ color: 0x3a3e44, metalness: 0.75, roughness: 0.42 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x16181b, metalness: 0.6, roughness: 0.55 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x220000, emissive: new THREE.Color(1, 0.06, 0.02), emissiveIntensity: 6 }),
  hot: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(1, 0.45, 0.12), emissiveIntensity: 3 }),
};

let geoCache: { hull: THREE.BufferGeometry; dark: THREE.BufferGeometry; eye: THREE.BufferGeometry; hot: THREE.BufferGeometry } | null = null;

function droneGeometry() {
  if (geoCache) return geoCache;
  // Fuselage: a lathe along +Z (nose forward), flattened
  const prof: THREE.Vector2[] = [];
  const L = 4.2;
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    const r = 0.42 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.05)), 0.7) * (1 - 0.35 * u) + 0.02;
    prof.push(new THREE.Vector2(r, (u - 0.45) * L));
  }
  const body = new THREE.LatheGeometry(prof, 18).rotateX(Math.PI / 2);
  body.scale(1, 0.55, 1);
  // Swept flying wing
  const wing = new THREE.Shape();
  wing.moveTo(0, 0.9);
  wing.lineTo(2.1, -0.9);
  wing.lineTo(1.9, -1.25);
  wing.lineTo(0.9, -0.85);
  wing.lineTo(0, -1.35);
  wing.lineTo(-0.9, -0.85);
  wing.lineTo(-1.9, -1.25);
  wing.lineTo(-2.1, -0.9);
  wing.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wing, { depth: 0.08, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.02, bevelSegments: 1 });
  wingGeo.rotateX(-Math.PI / 2).translate(0, -0.04, 0);
  // Canted tail fins
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(0.55, 0);
  fin.lineTo(0.15, 0.55);
  fin.lineTo(-0.05, 0.55);
  fin.closePath();
  const finGeo = (s: number) =>
    new THREE.ExtrudeGeometry(fin, { depth: 0.04, bevelEnabled: false })
      .rotateY(-Math.PI / 2)
      .rotateZ(s * 0.45)
      .translate(s * 0.35, 0.12, -1.3);
  const hull = mergeGeometries([body, wingGeo, finGeo(1), finGeo(-1)].map((g) => (g.index ? g.toNonIndexed() : g)));
  hull.computeVertexNormals();
  // Intake and exhaust in dark metal
  const intake = new THREE.BoxGeometry(0.5, 0.16, 0.5).translate(0, 0.22, 0.5);
  const nozzle = new THREE.CylinderGeometry(0.2, 0.24, 0.35, 14, 1, true).rotateX(Math.PI / 2).translate(0, 0.02, -2.0);
  const dark = mergeGeometries([intake.toNonIndexed(), nozzle.toNonIndexed()]);
  const eye = new THREE.SphereGeometry(0.1, 12, 8).scale(1.6, 0.6, 1).translate(0, 0.02, 2.2);
  const hot = new THREE.CircleGeometry(0.19, 14).rotateY(Math.PI).translate(0, 0.02, -2.1);
  geoCache = { hull, dark, eye, hot };
  return geoCache;
}

let glowTex: THREE.Texture | null = null;
function exhaustTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,220,1)');
  grad.addColorStop(0.3, 'rgba(255,160,70,0.7)');
  grad.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

let nextId = 1;

interface Round {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
}

type Mode = 'patrol' | 'attack' | 'extend' | 'break' | 'dying';

export class Drone implements Hostile {
  readonly id = nextId++;
  readonly kind = 'drone' as const;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 2.6;
  readonly maxHp = 100;
  hp = 100;
  alive = true;
  threatened = 0;
  readonly mesh = new THREE.Group();
  mode: Mode = 'patrol';
  /** Scripted drones hold their course and don't shoot back. */
  passive = false;
  private modeT = 0;
  private gunT = 0;
  private burst = 0;
  private missileT = 14 + Math.random() * 16;
  private lockT = 0;
  private readonly q = new THREE.Quaternion();
  private roll = 0;
  private readonly exhaust: THREE.Sprite;
  private readonly cruise = 165 + Math.random() * 45;
  private readonly jink = Math.random() * 100;
  private smokeT = 0;
  private spin = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly patrolAt = new THREE.Vector3();
  /** Set when it hit the ground dying (the manager removes it). */
  crashed = false;
  flybyDone = false;

  constructor(at: THREE.Vector3, heading: THREE.Vector3) {
    const g = droneGeometry();
    this.mesh.add(
      new THREE.Mesh(g.hull, mats.hull),
      new THREE.Mesh(g.dark, mats.dark),
      new THREE.Mesh(g.eye, mats.eye),
      new THREE.Mesh(g.hot, mats.hot),
    );
    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
    this.exhaust = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: exhaustTexture(), color: 0xffc080, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.exhaust.scale.setScalar(1.6);
    this.mesh.add(this.exhaust);
    this.exhaust.position.set(0, 0.02, -2.4);
    this.pos.copy(at);
    this.vel.copy(heading).normalize().multiplyScalar(this.cruise);
    this.patrolAt.copy(at);
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    void at;
    void kind;
    if (this.hp <= 0) {
      this.alive = false;
      this.mode = 'dying';
      this.spin = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3);
      return true;
    }
    // Hit: it flinches into a break
    if (this.mode === 'attack' && Math.random() < 0.4) this.setMode('break');
    return false;
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.modeT = 0;
  }

  update(
    dt: number,
    t: number,
    player: PlayerTarget,
    ground: SurfaceQuery,
    rounds: Round[],
    missiles: Missiles,
    particles: Particles,
    explosions: Explosions,
    events: EventBus,
  ): void {
    this.modeT += dt;
    this.threatened = Math.max(0, this.threatened - dt);
    const speed = this.vel.length();
    const dir = this._v.copy(this.vel).divideScalar(Math.max(speed, 1));
    const toP = this._w.copy(player.pos).sub(this.pos);
    const dist = toP.length();

    if (this.mode === 'dying') {
      // Falling wreck: nose drops, it rolls, burns and smokes
      this.vel.y -= 9.81 * dt * 1.4;
      this.vel.multiplyScalar(Math.exp(-0.15 * dt));
      this.pos.addScaledVector(this.vel, dt);
      this.roll += this.spin * dt;
      this.smokeT += dt;
      while (this.smokeT > 0.025) {
        this.smokeT -= 0.025;
        particles.emit('darkSmoke', this.pos, this._w.set(0, 1, 0), { scale: 0.45, life: 0.6 });
        particles.emit('fire', this.pos, this._w.copy(this.vel).multiplyScalar(-0.05), { scale: 0.45 });
      }
      this.orient(dt, this.vel.clone().normalize(), 0);
      if (this.pos.y < ground.surface(this.pos.x, this.pos.z) + 1) {
        explosions.blast(this.pos, 7, { debris: 10, burn: !ground.isWater(this.pos.x, this.pos.z) });
        this.crashed = true;
      }
      return;
    }

    // ── Brain ──────────────────────────────────────────────────────────
    let want = new THREE.Vector3();
    const facing = dist > 1 ? dir.dot(toP) / dist : 0;
    if (this.passive) {
      want.copy(dir);
    } else switch (this.mode) {
      case 'patrol':
        // Orbit the patrol point until the suit comes near (or is seen firing)
        want.copy(this.patrolAt).sub(this.pos).setY(0);
        if (want.length() < 400) want.set(-dir.z, 0, dir.x);
        want.normalize();
        if (dist < 5500) this.setMode('attack');
        break;
      case 'attack': {
        // Lead pursuit
        const tgo = dist / Math.max(speed + 300, 200);
        want.copy(player.pos).addScaledVector(player.vel, tgo).sub(this.pos).normalize();
        if (dist < 160) this.setMode('extend');
        if (this.threatened > 0.5 && Math.random() < dt * 1.5) this.setMode('break');
        break;
      }
      case 'extend':
        // Run out past the suit, then come round
        want.copy(dir).addScaledVector(toP.clone().normalize(), -0.4).setY(dir.y * 0.5 + 0.15).normalize();
        if (this.modeT > 3.5 + Math.random() * 2) this.setMode('attack');
        break;
      case 'break': {
        // Hard jinking turn across the threat
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(Math.sin(t * 1.3 + this.jink) > 0 ? 1 : -1);
        want.copy(dir).addScaledVector(side, 1.6).add(new THREE.Vector3(0, Math.sin(t * 2.1 + this.jink) * 0.6, 0)).normalize();
        if (this.modeT > 2.5) this.setMode('attack');
        break;
      }
    }
    // Terrain avoidance: look ahead and pull up hard if low
    const ahead = this.pos.clone().addScaledVector(this.vel, 2.5);
    const floor = Math.max(ground.surface(ahead.x, ahead.z), ground.surface(this.pos.x, this.pos.z), 0);
    const clearance = this.pos.y - floor;
    const safe = this.passive ? 40 : 140;
    if (clearance < safe) want.y = Math.max(want.y, 0.25 + (safe - clearance) / safe);
    if (this.pos.y > 4000) want.y = Math.min(want.y, -0.2);
    want.normalize();

    // ── Fly: turn the velocity toward `want` within the g limit ───────
    const maxRate = (7.5 * 9.81) / Math.max(speed, 80);
    const ang = dir.angleTo(want);
    if (ang > 1e-4) {
      const axis = new THREE.Vector3().crossVectors(dir, want).normalize();
      dir.applyAxisAngle(axis, Math.min(ang, maxRate * dt));
    }
    const sp = speed + (this.cruise * (this.mode === 'extend' ? 1.25 : 1) - speed) * (1 - Math.exp(-dt * 0.8));
    // Bank into the turn: roll by the lateral acceleration
    const lateral = new THREE.Vector3().crossVectors(dir, want).y;
    this.roll += (THREE.MathUtils.clamp(-lateral * 4, -1.3, 1.3) - this.roll) * (1 - Math.exp(-dt * 3));
    this.vel.copy(dir).multiplyScalar(sp);
    this.pos.addScaledVector(this.vel, dt);
    this.orient(dt, dir, this.roll);
    this.exhaust.material.opacity = 0.75 + 0.25 * Math.sin(t * 50 + this.jink);

    // ── Guns: short bursts when the suit is in the cone and in range ──
    this.gunT -= dt;
    if (this.mode === 'attack' && !this.passive && player.alive && dist < 950 && facing > 0.985) {
      if (this.gunT <= 0 && this.burst <= 0) {
        this.burst = 4 + Math.floor(Math.random() * 3);
        this.gunT = 0.9 + Math.random() * 0.8;
        events.emit('enemyFire', { at: this.pos, value: this.burst });
      }
    }
    if (this.burst > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burstT = 0.07;
        this.burst--;
        const muzzle = this.pos.clone().addScaledVector(dir, 2.4);
        const tgo = dist / 900;
        const aim = player.pos.clone().addScaledVector(player.vel, tgo).sub(muzzle).normalize();
        // Spread: they're drones, not snipers
        aim.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.035)).normalize();
        rounds.push({ p: muzzle, v: aim.multiplyScalar(900).add(this.vel), life: 1.6 });
        particles.emit('flash', muzzle, undefined, { scale: 0.09 });
      }
    }

    // ── Heat seeker from range ───────────────────────────────────────
    this.missileT -= dt;
    if (this.mode === 'attack' && !this.passive && player.alive && dist > 700 && dist < 2800 && facing > 0.9) {
      this.lockT += dt;
      if (this.lockT > 1.6 && this.missileT <= 0) {
        missiles.launch({ team: 'enemy', from: this.pos.clone().addScaledVector(dir, -0.5).add(new THREE.Vector3(0, -0.5, 0)), vel: this.vel, target: player });
        events.emit('enemyMissile', { at: this.pos });
        this.missileT = 18 + Math.random() * 16;
        this.lockT = 0;
      }
    } else {
      this.lockT = Math.max(0, this.lockT - dt);
    }
  }

  private burstT = 0;

  private orient(dt: number, dir: THREE.Vector3, roll: number): void {
    void dt;
    this._m.lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0));
    this.q.setFromRotationMatrix(this._m);
    // lookAt points −Z at the target; the model's nose is +Z
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.q);
  }
}

/** Drone cannon rounds in flight: drawn as tracers, tested against the suit. */
export class Guns {
  readonly rounds: Round[] = [];
  private readonly _v = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();

  update(dt: number, player: PlayerTarget, ground: SurfaceQuery, particles: Particles, streaks: Streaks, events: EventBus): void {
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      const prev = this._a.copy(r.p);
      r.v.y -= 9.81 * dt;
      r.p.addScaledVector(r.v, dt);
      r.life -= dt;
      // Segment vs the suit's hit sphere
      if (player.alive) {
        const seg = this._v.copy(r.p).sub(prev);
        const len = seg.length();
        const t = THREE.MathUtils.clamp(this._b.copy(player.pos).sub(prev).dot(seg) / Math.max(len * len, 1e-6), 0, 1);
        const closest = this._b.copy(prev).addScaledVector(seg, t);
        if (closest.distanceToSquared(player.pos) < 1.15 ** 2) {
          player.hit(4, closest, 'bullet');
          particles.burst('spark', closest, 8, 12, seg.normalize().negate(), 0.9);
          this.rounds.splice(i, 1);
          continue;
        }
        // Near miss: a crack past the suit
        if (closest.distanceToSquared(player.pos) < 9 && Math.random() < 0.3) events.emit('ricochet', { at: closest });
      }
      const surf = ground.surface(r.p.x, r.p.z);
      if (r.p.y < surf || r.life <= 0) {
        if (r.p.y < surf + 2) {
          const at = this._b.set(r.p.x, surf + 0.2, r.p.z);
          particles.burst(ground.isWater(at.x, at.z) ? 'spray' : 'dust', at, 3, 5, new THREE.Vector3(0, 1, 0), 0.6, { scale: 0.6 });
        }
        this.rounds.splice(i, 1);
        continue;
      }
      // Tracer: a hot orange dash behind the round
      const tail = this._b.copy(r.p).addScaledVector(r.v, -0.018);
      streaks.add(tail, r.p, 6, 2.2, 0.6, 1, 0.07, 0.12);
    }
  }
}
