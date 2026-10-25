import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { Heightfield } from '../world/heightfield';
import type { Explosions } from './explosions';
import type { Missiles } from './missiles';
import { beam, box, frustum, merge, paint, panelOn, type V3 } from './modelKit';
import type { DamageKind, Hostile, PlayerTarget } from './types';

/**
 * Surface-to-air launchers on six-wheeled trucks that shoot and scoot. A
 * truck parks on high ground, drops its outrigger jacks, raises the search
 * radar and stands the four-tube box up off the bed; it tracks the suit
 * inside 4 km when it can see it (line of sight over the terrain) and
 * ripples heat seekers at it. After a salvo — or a long wait, or a beating
 * — it folds everything back down and drives off cross-country to another
 * hilltop, picking its way round the steep ground. Flares and the hills are
 * your friends; catching one on the move, folded and blind, is better.
 */

const mats = {
  paint: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.72 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x0c1014, metalness: 0.9, roughness: 0.15 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0x220000, emissive: new THREE.Color(1, 0.08, 0.02), emissiveIntensity: 5 }),
};

const C = {
  olive: 0x4f5240,
  oliveDark: 0x3c3e31,
  oliveLight: 0x5d604b,
  steel: 0x6a6d70,
  dark: 0x18191b,
  rubber: 0x141414,
  lens: 0xd6d3c4,
  tail: 0x5a0e0a,
  array: 0x8b8e84,
};

/** Driving speed (m/s), the steepest grade it will take, and how long it takes to set up or pack up (s). */
const DRIVE_SPEED = 13;
const MAX_GRADE = 0.42;
const DEPLOY_TIME = 3.2;
const WHEEL_R = 0.55;
/** Axle positions along the chassis (m, +Z forward). */
const AXLES = [2.6, -0.9, -2.5];

interface SamGeometry {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  jack: THREE.BufferGeometry;
  turret: THREE.BufferGeometry;
  pod: THREE.BufferGeometry;
  mast: THREE.BufferGeometry;
  radar: THREE.BufferGeometry;
}

let geoCache: SamGeometry | null = null;

/** Height of the chassis rails' centre, the pod's pivot over the turntable, and where the tube cluster sits on it. */
const LIFT = WHEEL_R + 0.35;
const POD_PIVOT = new THREE.Vector3(0, 0.75, -1.2);
const TUBES_Y = 0.5;
const TUBES_FRONT = 3.9;

/** The truck in its moving parts (+Z forward), built once and shared. */
function samGeometry(): SamGeometry {
  if (geoCache) return geoCache;
  const body: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];

  // Frame rails, the bed and its skirts
  for (const s of [-1, 1]) body.push(box(0.22, 0.32, 8.2, C.dark, s * 0.55, LIFT - 0.12, 0));
  body.push(box(2.5, 0.18, 5.6, C.olive, 0, LIFT + 0.34, -1.5));
  for (const s of [-1, 1]) body.push(box(0.06, 0.34, 5.6, C.oliveDark, s * 1.24, LIFT + 0.12, -1.5));
  // Cab-over: a sloped windscreen, grille, bumper, lamps, mirrors
  const cabLow = { hw0: 1.25, z0: 2.3, z1: 4.3, y0: LIFT + 0.25, hw1: 1.25, z2: 2.3, z3: 4.36, y1: LIFT + 1.1 };
  const cabHigh = { hw0: 1.25, z0: 2.3, z1: 4.36, y0: LIFT + 1.1, hw1: 1.12, z2: 2.4, z3: 3.76, y1: LIFT + 1.95 };
  body.push(frustum(cabLow, C.olive), frustum(cabHigh, (e) => (e === 0 ? C.oliveDark : C.olive)));
  glass.push(panelOn(cabHigh, 'f', -0.9, -0.04, 0.12, 0.85, 0, 0.02), panelOn(cabHigh, 'f', 0.04, 0.9, 0.12, 0.85, 0, 0.02));
  for (const f of ['l', 'r'] as const) glass.push(panelOn(cabHigh, f, -0.15, 0.75, 0.15, 0.8, 0, 0.02));
  body.push(
    panelOn(cabLow, 'f', -0.6, 0.6, 0.15, 0.75, C.dark, 0.02),
    box(2.62, 0.28, 0.3, C.dark, 0, LIFT - 0.05, 4.42),
    box(0.32, 0.18, 0.05, C.lens, 0.85, LIFT + 0.42, 4.33),
    box(0.32, 0.18, 0.05, C.lens, -0.85, LIFT + 0.42, 4.33),
  );
  for (const s of [-1, 1]) {
    body.push(beam([s * 1.25, LIFT + 1.6, 4.0], [s * 1.5, LIFT + 1.6, 4.1], 0.025, C.dark), box(0.06, 0.4, 0.2, C.dark, s * 1.52, LIFT + 1.55, 4.1));
  }
  // Wheel arches over all six wheels
  for (const z of AXLES) {
    for (const s of [-1, 1]) {
      const pts: V3[] = [];
      for (let k = 0; k <= 5; k++) {
        const a = 0.35 + (k / 5) * (Math.PI - 0.7);
        pts.push([s * 1.25, WHEEL_R + Math.sin(a) * 0.72, z + Math.cos(a) * 0.72]);
      }
      for (let k = 0; k < 5; k++) {
        const [a, b] = [pts[k], pts[k + 1]];
        const len = Math.hypot(b[1] - a[1], b[2] - a[2]);
        const g = new THREE.BoxGeometry(0.52, 0.05, len + 0.02).rotateX(Math.atan2(-(b[1] - a[1]), b[2] - a[2]));
        body.push(paint(g.translate(a[0], (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), C.oliveDark));
      }
    }
  }
  // Fuel tank to port, toolbox to starboard, an exhaust stack behind the cab
  body.push(paint(new THREE.CylinderGeometry(0.3, 0.3, 1.25, 12).rotateX(Math.PI / 2).translate(-0.98, LIFT - 0.15, 0.65), C.oliveLight));
  body.push(box(0.45, 0.5, 1.25, C.oliveDark, 0.98, LIFT - 0.15, 0.65));
  body.push(paint(new THREE.CylinderGeometry(0.07, 0.07, 1.9, 8).translate(1.05, LIFT + 1.25, 2.18), C.dark));
  // Tail: light bar, red lamps, mud flaps
  body.push(box(2.5, 0.2, 0.15, C.dark, 0, LIFT - 0.1, -4.2));
  for (const s of [-1, 1]) {
    body.push(box(0.25, 0.12, 0.04, C.tail, s * 0.95, LIFT - 0.1, -4.29), box(0.45, 0.5, 0.03, C.rubber, s * 1.25, 0.5, -3.15));
  }
  // Mast hinge on the cab roof
  body.push(box(0.5, 0.22, 0.32, C.steel, 0, LIFT + 2.0, 2.35));

  // Wheel: lugged tyre round a hub, axle along X
  const tyre = new THREE.LatheGeometry(
    [[0.3, -0.22], [0.47, -0.225], [0.535, -0.19], [0.55, -0.1], [0.55, 0.1], [0.535, 0.19], [0.47, 0.225], [0.3, 0.22]].map(([r, y]) => new THREE.Vector2(r, y)),
    18,
  );
  const wheel = [paint(tyre, C.rubber), paint(new THREE.CylinderGeometry(0.3, 0.3, 0.4, 12), C.oliveDark), paint(new THREE.CylinderGeometry(0.11, 0.11, 0.48, 8), C.dark)];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    wheel.push(paint(new THREE.BoxGeometry(0.08, 0.4, 0.12).translate(0.54, 0, 0).rotateY(a), C.rubber));
  }

  // Outrigger jack: sleeve, ram, foot, hinge
  const jack = [box(0.32, 0.22, 0.32, C.oliveDark, 0, 0, 0), box(0.26, 0.6, 0.26, C.olive, 0, -0.35, 0), box(0.16, 0.5, 0.16, C.steel, 0, -0.85, 0), box(0.62, 0.08, 0.62, C.dark, 0, -1.1, 0)];

  // Turret: race ring, turntable, the trunnion cheeks either side of the pod
  const turret = [
    paint(new THREE.CylinderGeometry(1.0, 1.1, 0.3, 18), C.steel),
    paint(new THREE.CylinderGeometry(1.2, 1.2, 0.1, 18).translate(0, 0.2, 0), C.oliveDark),
  ];
  for (const s of [-1, 1]) {
    turret.push(
      frustum({ hw0: 0.07, z0: -2.0, z1: -0.4, y0: 0.25, hw1: 0.07, z2: -1.5, z3: -0.9, y1: POD_PIVOT.y + 0.2, x: s * 1.18 }, C.olive),
      paint(new THREE.CylinderGeometry(0.13, 0.13, 0.2, 10).rotateZ(Math.PI / 2).translate(s * 1.3, POD_PIVOT.y, POD_PIVOT.z), C.dark),
    );
  }
  turret.push(box(0.7, 0.45, 0.5, C.oliveDark, 0, 0.47, 0.75));

  // Launcher pod: four canisters 2 × 2 in a banded frame, pivot at its foot
  const pod: THREE.BufferGeometry[] = [];
  const len = 4.2;
  const zc = TUBES_FRONT - len / 2;
  for (const x of [-0.44, 0.44]) {
    for (const y of [TUBES_Y - 0.44, TUBES_Y + 0.44]) {
      pod.push(
        paint(new THREE.CylinderGeometry(0.4, 0.4, len, 14, 1, true).rotateX(Math.PI / 2).translate(x, y, zc), C.olive),
        paint(new THREE.RingGeometry(0.33, 0.41, 14).translate(x, y, TUBES_FRONT + 0.01), C.oliveDark),
        paint(new THREE.CircleGeometry(0.34, 14).translate(x, y, TUBES_FRONT - 0.12), C.dark),
        paint(new THREE.CircleGeometry(0.4, 14).rotateY(Math.PI).translate(x, y, TUBES_FRONT - len), C.oliveDark),
      );
    }
  }
  for (const z of [TUBES_FRONT - len + 0.2, zc, TUBES_FRONT - 0.2]) {
    pod.push(
      box(1.96, 0.1, 0.22, C.oliveDark, 0, TUBES_Y + 0.9, z),
      box(1.96, 0.1, 0.22, C.oliveDark, 0, TUBES_Y - 0.9, z),
      box(0.1, 1.9, 0.22, C.oliveDark, 0.93, TUBES_Y, z),
      box(0.1, 1.9, 0.22, C.oliveDark, -0.93, TUBES_Y, z),
    );
  }
  pod.push(box(0.3, 0.12, 0.3, C.dark, 0, TUBES_Y + 0.98, TUBES_FRONT - 0.5));

  // Mast: a telescoping pole; the radar on top is a tilted flat array
  const mast = [
    box(0.32, 0.25, 0.3, C.oliveDark, 0, 0.1, 0),
    paint(new THREE.CylinderGeometry(0.15, 0.17, 1.4, 8).translate(0, 0.7, 0), C.olive),
    paint(new THREE.CylinderGeometry(0.1, 0.1, 1.8, 8).translate(0, 2.2, 0), C.steel),
  ];
  const radar = [
    paint(new THREE.CylinderGeometry(0.16, 0.2, 0.3, 10).translate(0, -0.05, 0), C.dark),
    paint(new THREE.BoxGeometry(2.1, 1.1, 0.14).rotateX(-0.25).translate(0, 0.62, 0.05), C.oliveDark),
    paint(new THREE.BoxGeometry(1.96, 0.98, 0.04).translate(0, 0, 0.08).rotateX(-0.25).translate(0, 0.62, 0.05), C.array),
    box(0.3, 0.5, 0.3, C.olive, 0, 0.3, -0.12),
  ];
  for (const x of [-0.5, 0, 0.5]) radar.push(paint(new THREE.BoxGeometry(0.03, 0.98, 0.02).translate(x, 0, 0.105).rotateX(-0.25).translate(0, 0.62, 0.05), C.dark));

  geoCache = {
    body: merge(body),
    glass: merge(glass),
    wheel: merge(wheel).rotateZ(Math.PI / 2),
    jack: merge(jack),
    turret: merge(turret),
    pod: merge(pod),
    mast: merge(mast),
    radar: merge(radar),
  };
  return geoCache;
}

type Mode = 'ready' | 'stow' | 'drive' | 'deploy';

let nextId = 1000;

export class SamSite implements Hostile {
  readonly id = nextId++;
  readonly kind = 'sam' as const;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 4.5;
  readonly maxHp = 220;
  hp = 220;
  alive = true;
  threatened = 0;
  readonly mesh = new THREE.Group();
  mode: Mode = 'ready';
  /** Where it stands on the ground (the mesh origin). */
  private readonly ground = new THREE.Vector3();
  private heading = Math.random() * Math.PI * 2;
  /** 0 = packed for the road, 1 = set up to fire. */
  private deployed = 1;
  private readonly goal = new THREE.Vector3();
  private modeT = 0;
  /** Time parked and set up, and damage taken since it last moved. */
  private parked = 0;
  private hurt = 0;
  private rolled = 0;
  private stuck = 0;
  private readonly lastGoalDist = { d: Infinity, t: 0 };
  private readonly body = new THREE.Group();
  private readonly turret = new THREE.Group();
  private readonly pod = new THREE.Group();
  private readonly mast = new THREE.Group();
  private readonly radar = new THREE.Group();
  private readonly jacks: THREE.Object3D[] = [];
  private readonly wheels: THREE.Object3D[] = [];
  private readonly lamp: THREE.Mesh;
  private reload = 4 + Math.random() * 4;
  /** Seconds it has held the suit in its radar (the RWR's lock warning). */
  track = 0;
  private salvo = 0;
  private salvoT = 0;
  private dustT = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();

  constructor(at: THREE.Vector3) {
    const g = samGeometry();
    this.body.add(new THREE.Mesh(g.body, mats.paint), new THREE.Mesh(g.glass, mats.glass));
    for (const z of AXLES) {
      for (const sx of [-1, 1]) {
        const w = new THREE.Mesh(g.wheel, mats.paint);
        w.position.set(sx * 1.25, WHEEL_R, z);
        this.wheels.push(w);
        this.body.add(w);
      }
    }
    // Outrigger jacks at the corners of the bed: they swing down to the ground
    for (const [x, z] of [[-1.35, 1.6], [1.35, 1.6], [-1.35, -3.8], [1.35, -3.8]]) {
      const j = new THREE.Mesh(g.jack, mats.paint);
      j.position.set(x, LIFT, z);
      this.jacks.push(j);
      this.body.add(j);
    }
    // The launcher: turntable on the bed, the canisters on an elevating cradle
    this.turret.position.set(0, LIFT + 0.6, -1.6);
    this.turret.add(new THREE.Mesh(g.turret, mats.paint));
    this.pod.position.copy(POD_PIVOT);
    this.pod.add(new THREE.Mesh(g.pod, mats.paint));
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), mats.lamp);
    this.lamp.position.set(0, TUBES_Y + 1.12, TUBES_FRONT - 0.5);
    this.pod.add(this.lamp);
    this.turret.add(this.pod);
    // Search radar on a mast hinged at the back of the cab roof: it folds down flat over the cab
    this.mast.position.set(0, LIFT + 1.95, 2.35);
    this.radar.position.y = 3.1;
    this.radar.add(new THREE.Mesh(g.radar, mats.paint));
    this.mast.add(new THREE.Mesh(g.mast, mats.paint), this.radar);
    this.body.add(this.turret, this.mast);
    this.mesh.add(this.body);
    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
    this.ground.copy(at);
    this.goal.copy(at);
    this.pose(null);
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    void at;
    void kind;
    this.hp -= amount;
    this.hurt += amount;
    if (this.hp <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.modeT = 0;
  }

  update(dt: number, t: number, player: PlayerTarget, field: Heightfield, missiles: Missiles, events: EventBus, explosions: Explosions, particles: Particles): void {
    if (!this.alive) return;
    this.modeT += dt;
    const before = this._n.copy(this.pos);
    switch (this.mode) {
      case 'ready':
        this.parked += dt;
        // Shoot and scoot: after the salvo, after a long wait, or when it's being hurt
        if (this.salvo === 0 && (this.hurt > 70 || this.parked > 32 + (this.id % 7) * 3 || (this.reload > 6 && this.parked > 8))) {
          this.setMode('stow');
        }
        break;
      case 'stow':
        this.deployed = Math.max(0, this.deployed - dt / DEPLOY_TIME);
        if (this.deployed <= 0) {
          this.pickGoal(field);
          this.setMode('drive');
        }
        break;
      case 'drive':
        if (this.drive(dt, field, particles)) this.setMode('deploy');
        break;
      case 'deploy':
        this.deployed = Math.min(1, this.deployed + dt / DEPLOY_TIME);
        if (this.deployed >= 1) {
          this.parked = 0;
          this.hurt = 0;
          this.setMode('ready');
        }
        break;
    }
    this.pose(field);
    // Velocity from where it went this frame (a repulsor's shove can't move a truck)
    this.vel.copy(this.pos).sub(before).divideScalar(Math.max(dt, 1e-4));

    const to = this._v.copy(player.pos).sub(this.pos);
    const dist = to.length();
    const ready = this.mode === 'ready';
    const visible = ready && player.alive && dist < 4200 && field.raycast(this.pos.clone().add(new THREE.Vector3(0, 3, 0)), to.clone().normalize(), dist - 5) < 0;
    // Slew the launcher onto the suit (in the truck's own frame)
    if (visible) {
      const local = to.clone().applyQuaternion(this.mesh.quaternion.clone().invert());
      const yaw = Math.atan2(local.x, local.z);
      const pitch = Math.atan2(local.y, Math.hypot(local.x, local.z));
      this.turret.rotation.y += Math.atan2(Math.sin(yaw - this.turret.rotation.y), Math.cos(yaw - this.turret.rotation.y)) * Math.min(1, dt * 1.6);
      this.pod.rotation.x += (-Math.max(0.15, pitch) - this.pod.rotation.x) * Math.min(1, dt * 1.6);
      this.track += dt;
    } else {
      this.track = Math.max(0, this.track - dt * 2);
      if (!ready) {
        // Packing up: the box swings back over the bed and lies down
        const k = Math.min(1, dt * 2.5);
        this.turret.rotation.y += Math.atan2(Math.sin(-this.turret.rotation.y), Math.cos(-this.turret.rotation.y)) * k;
        this.pod.rotation.x = THREE.MathUtils.lerp(0, -0.3, this.deployed);
      }
    }
    this.radar.rotation.y = this.deployed > 0.95 ? t * 1.8 : this.radar.rotation.y;
    (this.lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = this.track > 0.5 ? 5 + 4 * Math.sin(t * 18) : 1;
    this.reload -= dt;
    if (ready && this.track > 2.2 && this.reload <= 0 && this.salvo === 0) {
      this.salvo = 2;
      this.salvoT = 0;
      this.reload = 13 + Math.random() * 8;
    }
    if (this.salvo > 0 && ready) {
      this.salvoT -= dt;
      if (this.salvoT <= 0) {
        this.salvo--;
        this.salvoT = 0.9;
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.pod.getWorldQuaternion(new THREE.Quaternion()));
        const from = this.pod.localToWorld(new THREE.Vector3(0, TUBES_Y, TUBES_FRONT + 0.3));
        missiles.launch({ team: 'enemy', from, vel: fwd.clone().multiplyScalar(60), target: player, coast: 0.15 });
        explosions.muzzle(from, fwd, 1.6);
        events.emit('enemyMissile', { at: from, value: 1 });
      }
    }
  }

  /** A new hilltop 400–1000 m off: the highest of a handful of drivable spots. */
  private pickGoal(field: Heightfield): void {
    let best: THREE.Vector3 | null = null;
    let bestH = -Infinity;
    for (let k = 0; k < 24; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = 400 + Math.random() * 600;
      const x = this.ground.x + Math.cos(a) * r;
      const z = this.ground.z + Math.sin(a) * r;
      const h = field.heightAt(x, z);
      if (h < 40 || this.grade(field, x, z) > MAX_GRADE * 0.6) continue;
      if (h > bestH) {
        bestH = h;
        best = new THREE.Vector3(x, h, z);
      }
    }
    this.goal.copy(best ?? this.ground);
    this.lastGoalDist.d = Infinity;
    this.lastGoalDist.t = 0;
    this.stuck = 0;
  }

  private grade(field: Heightfield, x: number, z: number): number {
    const e = 4;
    return Math.hypot(field.heightAt(x + e, z) - field.heightAt(x - e, z), field.heightAt(x, z + e) - field.heightAt(x, z - e)) / (2 * e);
  }

  /** One step along the way; true once it has arrived. */
  private drive(dt: number, field: Heightfield, particles: Particles): boolean {
    const dx = this.goal.x - this.ground.x;
    const dz = this.goal.z - this.ground.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 12) return true;
    // Give up on a spot it can't reach and settle for where it is, if that's any good
    this.lastGoalDist.t += dt;
    if (this.lastGoalDist.t > 8) {
      if (dist > this.lastGoalDist.d - 20) this.stuck++;
      this.lastGoalDist.d = dist;
      this.lastGoalDist.t = 0;
      if (this.stuck >= 2) return true;
    }
    // Steer: of a fan of headings, the one closest to the goal that isn't too steep or wet
    const want = Math.atan2(dx, dz);
    let bestH = this.heading;
    let bestCost = Infinity;
    for (let k = -4; k <= 4; k++) {
      const h = this.heading + k * 0.22;
      const x = this.ground.x + Math.sin(h) * 22;
      const z = this.ground.z + Math.cos(h) * 22;
      const g = Math.max(this.grade(field, x, z), Math.abs(field.heightAt(x, z) - this.ground.y) / 22);
      const off = Math.abs(Math.atan2(Math.sin(want - h), Math.cos(want - h)));
      const cost = off + (g > MAX_GRADE ? 10 : g * 2) + (field.heightAt(x, z) < 3 ? 20 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        bestH = h;
      }
    }
    const turn = Math.atan2(Math.sin(bestH - this.heading), Math.cos(bestH - this.heading));
    this.heading += THREE.MathUtils.clamp(turn, -0.5 * dt, 0.5 * dt);
    // Slow for the turns and the climbs
    const speed = DRIVE_SPEED * (1 - Math.min(0.6, Math.abs(turn))) * Math.min(1, this.modeT / 3);
    const step = speed * dt;
    this.ground.x += Math.sin(this.heading) * step;
    this.ground.z += Math.cos(this.heading) * step;
    this.rolled += step;
    // Dust off the wheels
    this.dustT += dt * speed;
    while (this.dustT > 4) {
      this.dustT -= 4;
      const at = this._v.set(-Math.sin(this.heading) * 3.5, 0.4, -Math.cos(this.heading) * 3.5).add(this.ground);
      particles.emit('dust', at, new THREE.Vector3(0, 1, 0), { scale: 0.7 });
    }
    return false;
  }

  /** Sit the truck on the ground under it and fold its gear to `deployed`. */
  private pose(field: Heightfield | null): void {
    const d = this.deployed;
    if (field) {
      // Ride the terrain: height and tilt from under the corners
      const s = Math.sin(this.heading);
      const c = Math.cos(this.heading);
      const at = (f: number, r: number) => field.surfaceAt(this.ground.x + s * f + c * r, this.ground.z + c * f - s * r);
      const fl = at(3, -1.2);
      const fr = at(3, 1.2);
      const bl = at(-3, -1.2);
      const br = at(-3, 1.2);
      this.ground.y = (fl + fr + bl + br) / 4;
      const fwd = this._v.set(s, ((fl + fr) - (bl + br)) / 2 / 6, c).normalize();
      const right = new THREE.Vector3(c, ((fr + br) - (fl + bl)) / 2 / 2.4, -s).normalize();
      const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
      right.crossVectors(up, fwd);
      this._m.makeBasis(right, up, fwd);
      this.mesh.quaternion.setFromRotationMatrix(this._m);
    } else {
      this.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
    }
    this.mesh.position.copy(this.ground);
    // Set up, the jacks take the weight and lift it a touch off its tyres
    this.body.position.y = d * 0.15;
    for (const j of this.jacks) j.rotation.x = (1 - d) * (j.position.z > 0 ? -1.4 : 1.4);
    this.mast.rotation.x = (1 - d) * 1.5;
    for (const w of this.wheels) w.rotation.x = this.rolled / WHEEL_R;
    this.pos.copy(this.ground).add(new THREE.Vector3(0, 2.2, 0).applyQuaternion(this.mesh.quaternion));
  }
}

/** Ridge-top sites in a ring round the house, chosen from the heightfield. */
export function samSites(field: Heightfield, home: THREE.Vector2, count: number, seed = 1): THREE.Vector3[] {
  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const out: THREE.Vector3[] = [];
  let guard = 0;
  while (out.length < count && guard++ < 4000) {
    const a = rand() * Math.PI * 2;
    const r = 2500 + rand() * 6500;
    const x = home.x + Math.cos(a) * r;
    const z = home.y + Math.sin(a) * r;
    const h = field.heightAt(x, z);
    if (h < 80) continue;
    // A local high point, reasonably flat on top
    const around = [0, 1, 2, 3, 4, 5].map((k) => field.heightAt(x + Math.cos(k) * 60, z + Math.sin(k) * 60));
    if (Math.max(...around) > h + 2) continue;
    if (Math.abs(h - field.heightAt(x + 6, z)) > 2.5 || Math.abs(h - field.heightAt(x, z + 6)) > 2.5) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 1500)) continue;
    out.push(new THREE.Vector3(x, h, z));
  }
  return out;
}
