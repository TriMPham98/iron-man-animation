import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import { coastZ, type Heightfield } from '../world/heightfield';
import type { Round } from './drones';
import type { Explosions } from './explosions';
import type { Missiles } from './missiles';
import type { DamageKind, Hostile, PlayerTarget } from './types';

/**
 * The Hammer frigate: a 130 m warship steaming a slow circuit a few
 * kilometres off the coast, fought part by part.
 *  - Two CIWS mounts (on the bridge roof and the hangar) hose tracer at the
 *    suit inside 2 km. Flares do nothing to a gun: break line of sight
 *    behind the cliffs, out-turn the mount's slew, or skim the waves — under
 *    14 m it loses you in the sea clutter beyond 250 m.
 *  - A vertical launcher on the foredeck ripples heat seekers out of its
 *    cells, straight up and over onto the suit. Flares work on these.
 *  - The search radar on the mast cues both: shot away, the guns lose half
 *    their reach and spray wide, and the launcher can only fire on what the
 *    deck can see close in.
 *  - The hull is armoured while any weapon still fights (the unibeam bites
 *    through it better than anything); once the guns and cells are gone it
 *    opens up, and when it fails the ship burns, lists and goes down.
 */

const mats = {
  hull: new THREE.MeshStandardMaterial({ color: 0x737a82, metalness: 0.55, roughness: 0.55 }),
  boot: new THREE.MeshStandardMaterial({ color: 0x24262a, metalness: 0.4, roughness: 0.7 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x45494e, metalness: 0.4, roughness: 0.8 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x17191b, metalness: 0.6, roughness: 0.5 }),
  dome: new THREE.MeshStandardMaterial({ color: 0xd4d6d8, metalness: 0.2, roughness: 0.5 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x0b0e12, metalness: 0.9, roughness: 0.12 }),
  charred: new THREE.MeshStandardMaterial({ color: 0x0d0c0b, metalness: 0.3, roughness: 0.9 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0x220000, emissive: new THREE.Color(1, 0.08, 0.02), emissiveIntensity: 4 }),
};

/** Deck height above the waterline, and the hull's half-beam and ends (m, ship frame, +Z bow). */
const DECK = 6;
const STERN = -62;
const BOW = 64;

/** Steaming speed (m/s), the patrol circle (m), the deepest-water check. */
const SPEED = 9;
const PATROL_R = 1600;

/** CIWS: reach with / without the radar (m), slew (rad/s), round speed (m/s), rate (rounds/s), burst/pause (s). */
const CIWS_RANGE = 2000;
const CIWS_RANGE_BLIND = 1100;
const CIWS_SLEW = 0.75;
const CIWS_ROUND = 1100;
const CIWS_RATE = 20;
const CIWS_BURST = 2.4;
const CIWS_PAUSE = 1.6;
const CIWS_DAMAGE = 2;
/** Below this height over the sea, and beyond {@link CLUTTER_RANGE}, the gun radar can't hold the suit. */
const CLUTTER_HEIGHT = 14;
const CLUTTER_RANGE = 250;

/** VLS: reach with / without the radar (m), salvo size, gap (s), reload (s). */
const VLS_RANGE = 5000;
const VLS_RANGE_BLIND = 1600;
const VLS_SALVO = 4;
const VLS_GAP = 0.55;

type PartRole = 'radar' | 'ciws' | 'vls' | 'hull';

const PART_STATS: Record<PartRole, { hp: number; radius: number; label: string }> = {
  radar: { hp: 260, radius: 3.6, label: 'RADAR' },
  ciws: { hp: 300, radius: 3, label: 'CIWS' },
  vls: { hp: 450, radius: 5, label: 'VLS' },
  hull: { hp: 2600, radius: 9, label: 'HULL' },
};

let nextId = 5000;

/** One lockable, destructible piece of the ship. */
export class ShipPart implements Hostile {
  readonly id = nextId++;
  readonly kind = 'ship' as const;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius: number;
  readonly maxHp: number;
  hp: number;
  alive = true;
  threatened = 0;
  readonly span?: readonly [THREE.Vector3, THREE.Vector3];
  /** Burning since it was knocked out (s). */
  burnT = 0;

  constructor(
    readonly ship: Frigate,
    readonly role: PartRole,
    /** Hit centre in the ship's frame. */
    readonly local: THREE.Vector3,
    /** What gets hidden when it's shot away. */
    readonly visual: THREE.Object3D | null,
  ) {
    const s = PART_STATS[role];
    this.radius = s.radius;
    this.maxHp = this.hp = s.hp;
    if (role === 'hull') this.span = [new THREE.Vector3(), new THREE.Vector3()];
  }

  get label(): string {
    return this.role === 'hull' && this.ship.armed ? 'HULL ARMD' : PART_STATS[this.role].label;
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    void at;
    // Belt armour: a fighting ship shrugs off most of it; the beam cuts best
    if (this.role === 'hull' && this.ship.armed) amount *= kind === 'unibeam' ? 0.5 : 0.12;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;
    }
    return false;
  }
}

interface Ciws {
  part: ShipPart;
  /** Yaw and pitch groups, and the muzzle in the pitch group's frame. */
  yaw: THREE.Group;
  pitch: THREE.Group;
  /** Forward mount (it can't fire aft past the mast), or aft (can't fire forward past the bridge). */
  fwd: boolean;
  fireT: number;
  pauseT: number;
  roundAcc: number;
  soundT: number;
  track: number;
}

interface Cell {
  lid: THREE.Group;
  at: THREE.Vector3;
  open: number;
  firing: number;
}

export class Frigate {
  readonly mesh = new THREE.Group();
  readonly parts: ShipPart[] = [];
  readonly hull: ShipPart;
  readonly radar: ShipPart;
  readonly vls: ShipPart;
  /** Waterline origin, velocity and heading (rad, +Z = 0). */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  heading = 0;
  sinking = false;
  /** The hull's armour is open (announced once). */
  private opened = false;
  /** Gone under (the manager removes it). */
  sunk = false;
  private sinkT = 0;
  private speed = SPEED;
  private readonly centre = new THREE.Vector3();
  private readonly ciws: Ciws[] = [];
  private readonly cells: Cell[] = [];
  private readonly radarHead = new THREE.Group();
  private readonly lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), mats.lamp);
  private vlsReload = 6;
  private vlsSalvo = 0;
  private vlsT = 0;
  private nextCell = 0;
  private wakeT = 0;
  private burnT = 0;
  private list = 0;
  private trim = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _q2 = new THREE.Vector3();
  private readonly _qi = new THREE.Quaternion();

  constructor(field: Heightfield, near: THREE.Vector3) {
    this.build();
    this.hull = this.parts.find((p) => p.role === 'hull')!;
    this.radar = this.parts.find((p) => p.role === 'radar')!;
    this.vls = this.parts.find((p) => p.role === 'vls')!;
    // Patrol: a circle of deep water off the coast, entered at the point nearest the suit
    this.centre.set(near.x, 0, coastZ(near.x) + PATROL_R + 1100);
    for (let k = 0; k < 24 && !this.deep(field, this.centre, PATROL_R); k++) this.centre.z += 400;
    const a = Math.atan2(near.z - this.centre.z, near.x - this.centre.x);
    this.pos.set(this.centre.x + Math.cos(a) * PATROL_R, 0, this.centre.z + Math.sin(a) * PATROL_R);
    // Anticlockwise round the circle (seen from above, +X right, +Z down)
    this.heading = Math.atan2(-Math.sin(a), Math.cos(a));
    this.place(0);
  }

  /** The guns and cells still fight (the hull is armoured while they do). */
  get armed(): boolean {
    return this.parts.some((p) => p.alive && (p.role === 'ciws' || p.role === 'vls'));
  }

  private deep(field: Heightfield, c: THREE.Vector3, r: number): boolean {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      for (const f of [0.75, 1, 1.25]) if (field.heightAt(c.x + Math.cos(a) * r * f, c.z + Math.sin(a) * r * f) > -18) return false;
    }
    return true;
  }

  // ── Model ────────────────────────────────────────────────────────────
  private build(): void {
    const g = this.mesh;
    const box = (w: number, h: number, l: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
      b.position.set(x, y, z);
      parent.add(b);
      return b;
    };
    // Hull: a pointed plan extruded up; dark boot-topping below the waterline band
    const plan = new THREE.Shape();
    const pts: [number, number][] = [[-6.5, STERN], [6.5, STERN], [7.6, -30], [7.6, 18], [5.6, 42], [2.6, 56], [0, BOW], [-2.6, 56], [-5.6, 42], [-7.6, 18], [-7.6, -30]];
    pts.forEach(([x, z], i) => (i ? plan.lineTo(x, -z) : plan.moveTo(x, -z)));
    plan.closePath();
    const slab = (y0: number, y1: number, m: THREE.Material) => {
      const geo = new THREE.ExtrudeGeometry(plan, { depth: y1 - y0, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0);
      g.add(new THREE.Mesh(geo, m));
    };
    slab(-3.5, 0.7, mats.boot);
    slab(0.7, DECK, mats.hull);
    // Deck plating just proud of the hull top
    const deckGeo = new THREE.ShapeGeometry(plan).rotateX(-Math.PI / 2).translate(0, DECK + 0.03, 0);
    g.add(new THREE.Mesh(deckGeo, mats.deck));

    // Bow gun (dressing)
    const gun = new THREE.Group();
    gun.position.set(0, DECK, 45);
    box(3.4, 1.8, 4.2, mats.hull, 0, 0.9, 0, gun);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 6, 10).rotateX(Math.PI / 2), mats.dark);
    barrel.position.set(0, 1.1, 4.6);
    gun.add(barrel);
    g.add(gun);

    // VLS block on the foredeck: 2 × 4 cells under hinged lids
    const vlsBlock = new THREE.Group();
    vlsBlock.position.set(0, DECK, 30);
    box(5.4, 0.8, 8.4, mats.deck, 0, 0.4, 0, vlsBlock);
    for (let i = 0; i < 8; i++) {
      const x = i % 2 ? 1.2 : -1.2;
      const z = -3 + Math.floor(i / 2) * 2;
      box(1.9, 0.05, 1.7, mats.dark, x, 0.83, z, vlsBlock);
      const lid = new THREE.Group();
      lid.position.set(x + (i % 2 ? 0.95 : -0.95), 0.86, z);
      box(1.9, 0.12, 1.7, mats.hull, i % 2 ? -0.95 : 0.95, 0.06, 0, lid);
      vlsBlock.add(lid);
      this.cells.push({ lid, at: new THREE.Vector3(x, DECK + 1, 30 + z), open: 0, firing: 0 });
    }
    g.add(vlsBlock);
    this.parts.push(new ShipPart(this, 'vls', new THREE.Vector3(0, DECK + 1.2, 30), null));

    // Bridge superstructure, the mast and its radar
    box(12, 9, 22, mats.hull, 0, DECK + 4.5, -2);
    box(12.2, 1.1, 0.2, mats.glass, 0, DECK + 7.6, 9.05);
    box(9, 3, 9, mats.hull, 0, DECK + 10.5, -6);
    box(9.2, 0.9, 0.2, mats.glass, 0, DECK + 11.2, -1.45);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.4, 16, 8), mats.hull);
    mast.position.set(0, DECK + 12 + 8, -6);
    g.add(mast);
    box(8, 0.3, 0.3, mats.hull, 0, DECK + 24, -6);
    this.radarHead.position.set(0, DECK + 28.3, -6);
    box(5.2, 1.8, 0.35, mats.dark, 0, 0, 0.3, this.radarHead);
    box(0.6, 1.2, 0.6, mats.hull, 0, -1.2, 0, this.radarHead);
    this.lamp.position.set(0, 1.2, 0);
    this.radarHead.add(this.lamp);
    g.add(this.radarHead);
    this.parts.push(new ShipPart(this, 'radar', new THREE.Vector3(0, DECK + 28.3, -6), this.radarHead));

    // Funnel and hangar
    box(6, 7, 7, mats.hull, 0, DECK + 3.5, -18);
    box(5, 0.4, 6, mats.dark, 0, DECK + 7.1, -18);
    box(13, 7, 16, mats.hull, 0, DECK + 3.5, -30);
    box(9, 5.2, 0.2, mats.dark, 0, DECK + 2.6, -38.05);

    // CIWS mounts: forward on the bridge roof, aft on the hangar
    this.addCiws(new THREE.Vector3(0, DECK + 9, 6), true);
    this.addCiws(new THREE.Vector3(0, DECK + 7, -33), false);

    this.parts.push(new ShipPart(this, 'hull', new THREE.Vector3(0, DECK + 2, -2), null));
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
  }

  private addCiws(at: THREE.Vector3, fwd: boolean): void {
    const root = new THREE.Group();
    root.position.copy(at);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 1.2, 14), mats.hull);
    ped.position.y = 0.6;
    root.add(ped);
    const yaw = new THREE.Group();
    yaw.position.y = 1.2;
    yaw.rotation.y = fwd ? 0 : Math.PI;
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 1.7, 16), mats.dome);
    dome.position.y = 1.8;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.95, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats.dome);
    cap.position.y = 2.65;
    const mount = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1, 1.4), mats.dome);
    mount.position.y = 0.5;
    const pitch = new THREE.Group();
    pitch.position.set(0, 0.9, 0.5);
    const barrels = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 2.4, 10).rotateX(Math.PI / 2), mats.dark);
    barrels.position.z = 1.3;
    pitch.add(barrels);
    yaw.add(dome, cap, mount, pitch);
    root.add(yaw);
    this.mesh.add(root);
    const part = new ShipPart(this, 'ciws', at.clone().add(new THREE.Vector3(0, 2, 0)), yaw);
    this.parts.push(part);
    this.ciws.push({ part, yaw, pitch, fwd, fireT: 0, pauseT: 1 + Math.random(), roundAcc: 0, soundT: 0, track: 0 });
  }

  // ── Sim ──────────────────────────────────────────────────────────────
  update(dt: number, t: number, player: PlayerTarget, field: Heightfield, rounds: Round[], missiles: Missiles, particles: Particles, explosions: Explosions, events: EventBus): void {
    if (this.sunk) return;
    if (!this.sinking && !this.hull.alive) this.scuttle(explosions, events);
    this.steer(dt, field);
    this.place(t);
    if (this.sinking) {
      this.sink(dt, particles, explosions);
      return;
    }
    const radar = this.radar.alive;
    this.radarHead.rotation.y = radar ? t * 2.2 : this.radarHead.rotation.y;
    (this.lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = 3 + 2 * Math.sin(t * 6);
    for (const c of this.ciws) if (c.part.alive) this.updateCiws(c, dt, player, field, rounds, particles, events, radar);
    if (this.vls.alive) this.updateVls(dt, player, field, missiles, particles, explosions, events, radar);
    this.wake(dt, particles);
    this.burn(dt, particles);
  }

  /** Round the patrol circle, turning seaward off any shoal. */
  private steer(dt: number, field: Heightfield): void {
    if (this.sinking) this.speed = Math.max(0, this.speed - dt * 0.4);
    const rx = this.pos.x - this.centre.x;
    const rz = this.pos.z - this.centre.z;
    const r = Math.hypot(rx, rz);
    // Tangent (anticlockwise), pulled in or out onto the circle
    let wx = -rz / r - (rx / r) * ((r - PATROL_R) / PATROL_R) * 3;
    let wz = rx / r - (rz / r) * ((r - PATROL_R) / PATROL_R) * 3;
    const ax = this.pos.x + Math.sin(this.heading) * 300;
    const az = this.pos.z + Math.cos(this.heading) * 300;
    if (field.heightAt(ax, az) > -14) {
      wx = -rx;
      wz = -rz;
    }
    const want = Math.atan2(wx, wz);
    const turn = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
    this.heading += THREE.MathUtils.clamp(turn, -0.04 * dt, 0.04 * dt);
    this.vel.set(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
  }

  /** Ride the swell; carry every part's hit point along. */
  private place(t: number): void {
    const bob = Math.sin(t * 0.52) * 0.35 + Math.sin(t * 0.83 + 1.3) * 0.15;
    const pitch = Math.sin(t * 0.37) * 0.012 + this.trim;
    const roll = Math.sin(t * 0.29 + 1) * 0.028 + this.list;
    this.mesh.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.mesh.rotation.set(-pitch, this.heading, roll, 'YXZ');
    this.mesh.updateMatrixWorld();
    for (const p of this.parts) {
      p.pos.copy(p.local).applyMatrix4(this.mesh.matrixWorld);
      p.vel.copy(this.vel);
      if (p.span) {
        (p.span[0] as THREE.Vector3).set(0, DECK - 1, STERN + 6).applyMatrix4(this.mesh.matrixWorld);
        (p.span[1] as THREE.Vector3).set(0, DECK - 1, BOW - 8).applyMatrix4(this.mesh.matrixWorld);
      }
    }
  }

  private updateCiws(c: Ciws, dt: number, player: PlayerTarget, field: Heightfield, rounds: Round[], particles: Particles, events: EventBus, radar: boolean): void {
    const at = c.part.pos;
    const to = this._v.copy(player.pos).sub(at);
    const dist = to.length();
    const flat = Math.hypot(to.x, to.z);
    let can = player.alive && dist < (radar ? CIWS_RANGE : CIWS_RANGE_BLIND);
    // Lost in the sea clutter
    if (can && player.pos.y < CLUTTER_HEIGHT && flat > CLUTTER_RANGE) can = false;
    // Lead, in the ship's frame
    const tgo = dist / CIWS_ROUND;
    const lead = this._w.copy(player.pos).addScaledVector(player.vel, tgo).addScaledVector(this.vel, -tgo).sub(at);
    this._qi.copy(this.mesh.quaternion).invert();
    const local = lead.applyQuaternion(this._qi);
    const elev = Math.atan2(local.y, Math.hypot(local.x, local.z));
    // Arcs: the mast and funnel mask the forward mount aft, the bridge the aft one forward
    const ahead = local.z / Math.max(1e-3, Math.hypot(local.x, local.z));
    if (can && elev < 0.35 && (c.fwd ? ahead < -0.6 : ahead > 0.6)) can = false;
    if (can && field.raycast(at, this._v.copy(to).normalize(), dist - 5) >= 0) can = false;
    if (can) {
      c.track += dt;
      const wantYaw = Math.atan2(local.x, local.z);
      const wantPitch = THREE.MathUtils.clamp(elev, -0.15, 1.35);
      const dy = Math.atan2(Math.sin(wantYaw - c.yaw.rotation.y), Math.cos(wantYaw - c.yaw.rotation.y));
      c.yaw.rotation.y += THREE.MathUtils.clamp(dy, -CIWS_SLEW * dt, CIWS_SLEW * dt);
      const dp = -wantPitch - c.pitch.rotation.x;
      c.pitch.rotation.x += THREE.MathUtils.clamp(dp, -CIWS_SLEW * dt, CIWS_SLEW * dt);
      const err = Math.hypot(dy * Math.cos(elev), dp);
      // Bursts on, pauses off, while it has the suit in the barrels
      if (c.fireT > 0) c.fireT -= dt;
      else if (c.pauseT > 0) c.pauseT -= dt;
      else if (err < 0.06 && c.track > 0.8) {
        c.fireT = CIWS_BURST;
        c.pauseT = CIWS_PAUSE;
      }
    } else {
      c.track = 0;
      c.fireT = 0;
      c.pauseT = Math.max(c.pauseT, 0.6);
    }
    if (c.fireT <= 0) return;
    c.yaw.updateMatrixWorld();
    const muzzle = this._w.set(0, 0, 2.6).applyMatrix4(c.pitch.matrixWorld);
    const dir = this._v.set(0, 0, 1).transformDirection(c.pitch.matrixWorld);
    const spread = radar ? 0.004 : 0.012;
    c.roundAcc += dt * CIWS_RATE;
    while (c.roundAcc >= 1) {
      c.roundAcc--;
      const d = dir.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spread * 2)).normalize();
      rounds.push({ p: muzzle.clone(), v: d.multiplyScalar(CIWS_ROUND).add(this.vel), life: 1.9, dmg: CIWS_DAMAGE });
      if (Math.random() < 0.5) particles.emit('flash', muzzle, this.vel, { scale: 0.12 });
    }
    if (Math.random() < dt * 8) particles.emit('smoke', muzzle, this.vel, { scale: 0.35, life: 0.5 });
    c.soundT -= dt;
    if (c.soundT <= 0) {
      c.soundT = 0.24;
      events.emit('enemyFire', { at: muzzle.clone(), value: 3 });
    }
  }

  private updateVls(dt: number, player: PlayerTarget, field: Heightfield, missiles: Missiles, particles: Particles, explosions: Explosions, events: EventBus, radar: boolean): void {
    // Lids: open a beat before a round leaves, shut after
    for (const cell of this.cells) {
      cell.firing = Math.max(0, cell.firing - dt);
      cell.open += ((cell.firing > 0 ? 1 : 0) - cell.open) * Math.min(1, dt * 6);
      cell.lid.rotation.z = cell.open * (cell.lid.position.x > 0 ? -1.9 : 1.9);
    }
    this.vlsReload -= dt;
    const dist = player.pos.distanceTo(this.vls.pos);
    // Cued by the mast radar from its height, else only what the deck can see close in
    const eye = radar ? this.radar.pos : this.vls.pos;
    const range = radar ? VLS_RANGE : VLS_RANGE_BLIND;
    if (this.vlsSalvo === 0 && this.vlsReload <= 0 && player.alive && dist < range) {
      const to = this._v.copy(player.pos).sub(eye);
      const d = to.length();
      if (field.raycast(eye, to.normalize(), d - 5) < 0) {
        this.vlsSalvo = VLS_SALVO;
        this.vlsT = 0.35;
        this.vlsReload = 15 + Math.random() * 6;
        // The salvo's lids open first
        for (let k = 0; k < VLS_SALVO; k++) this.cells[(this.nextCell + k) % this.cells.length].firing = 0.35 + k * VLS_GAP + 0.6;
      }
    }
    if (this.vlsSalvo <= 0) return;
    this.vlsT -= dt;
    if (this.vlsT > 0) return;
    this.vlsSalvo--;
    this.vlsT = VLS_GAP;
    const cell = this.cells[this.nextCell++ % this.cells.length];
    const from = cell.at.clone().applyMatrix4(this.mesh.matrixWorld);
    const up = this._w.set(0, 1, 0).transformDirection(this.mesh.matrixWorld);
    missiles.launch({ team: 'enemy', from, vel: up.clone().multiplyScalar(42).add(this.vel), target: player, coast: 0.6 });
    explosions.muzzle(from, up, 2.2);
    particles.burst('smoke', from, 6, 6, up, 1.2, { scale: 0.9 });
    events.emit('enemyMissile', { at: from, value: 1 });
  }

  /** Bow wave down both sides and the white water of the screws. */
  private wake(dt: number, particles: Particles): void {
    if (this.speed < 1) return;
    this.wakeT += dt;
    while (this.wakeT > 0.09) {
      this.wakeT -= 0.09;
      for (const s of [-1, 1]) {
        const at = this._v.set(s * 3.5, 0.6, BOW - 10).applyMatrix4(this.mesh.matrixWorld);
        const out = this._w.set(s * 4, 2, 2).transformDirection(this.mesh.matrixWorld).multiplyScalar(5).add(this.vel);
        particles.emit('spray', at, out, { scale: 1.6 });
      }
      const stern = this._v.set((Math.random() - 0.5) * 8, 0.4, STERN - 2).applyMatrix4(this.mesh.matrixWorld);
      particles.emit('mist', stern, this._w.set(0, 0.6, 0), { scale: 1.6, life: 2.5 });
    }
  }

  /** Smoke and fire off anything shot away. */
  private burn(dt: number, particles: Particles): void {
    this.burnT += dt;
    if (this.burnT < 0.06) return;
    const step = this.burnT;
    this.burnT = 0;
    for (const p of this.parts) {
      if (p.alive || p.role === 'hull') continue;
      p.burnT += step;
      const k = Math.max(0.3, 1 - p.burnT / 40);
      particles.emit('darkSmoke', p.pos, this._v.set(0, 3, 0).add(this.vel), { scale: 0.7 * k });
      if (Math.random() < 0.7 * k) particles.emit('fire', p.pos, this._w.set(0, 2, 0).add(this.vel), { scale: 0.7 * k });
    }
  }

  /** A part was shot away: it blows, and what's left of it is scorched black. */
  partDestroyed(p: ShipPart, explosions: Explosions, events: EventBus): void {
    explosions.blast(p.pos, p.role === 'vls' ? 12 : 8, { debris: 12, vel: this.vel });
    if (p.visual) {
      p.visual.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mats.charred;
      });
      if (p.role === 'ciws') p.visual.rotation.z = 0.5;
      if (p.role === 'radar') p.visual.rotation.x = 0.8;
    }
    if (p.role === 'radar') events.emit('jarvis', { text: 'Their search radar is down. The guns are firing blind.' });
    else if (p.role !== 'hull' && !this.armed && !this.opened) {
      this.opened = true;
      events.emit('jarvis', { text: 'She is disarmed, sir. The hull armour is open.' });
    }
  }

  private scuttle(explosions: Explosions, events: EventBus): void {
    this.sinking = true;
    this.sinkT = 0;
    for (const p of this.parts) p.alive = false;
    explosions.blast(this.hull.pos, 22, { debris: 30, burn: false, vel: this.vel });
    events.emit('jarvis', { text: 'Her back is broken. The frigate is going down.' });
  }

  private sink(dt: number, particles: Particles, explosions: Explosions): void {
    this.sinkT += dt;
    const k = this.sinkT;
    // Lists to port, settles by the stern, and goes
    this.list = Math.min(0.42, k * 0.02);
    this.trim = -Math.min(0.14, k * 0.006);
    this.pos.y = -0.04 * k * k;
    // Secondaries along the deck while she still floats
    if (k < 14 && Math.random() < dt * 0.9) {
      const at = this._v.set((Math.random() - 0.5) * 10, DECK + 2, STERN + Math.random() * (BOW - STERN)).applyMatrix4(this.mesh.matrixWorld);
      explosions.blast(at, 6 + Math.random() * 6, { debris: 6, vel: this.vel });
    }
    this.burnT += dt;
    if (this.burnT > 0.05) {
      this.burnT = 0;
      const fade = Math.max(0, 1 - k / 40);
      for (let i = 0; i < 3; i++) {
        const at = this._v.set((Math.random() - 0.5) * 10, DECK + 3, STERN + Math.random() * (BOW - STERN)).applyMatrix4(this.mesh.matrixWorld);
        if (at.y < -1) continue;
        particles.emit('darkSmoke', at, this._w.set(0, 4, 0), { scale: 1.3 * fade + 0.3 });
        if (Math.random() < 0.6) particles.emit('fire', at, this._w.set(0, 2.5, 0), { scale: 1.2 });
      }
      if (this.pos.y > -12) {
        const at = this._v.set((Math.random() - 0.5) * 14, 0, STERN + Math.random() * (BOW - STERN)).applyMatrix4(this.mesh.matrixWorld).setY(0.3);
        particles.emit('mist', at, this._w.set(0, 1.5, 0), { scale: 2 });
      }
    }
    if (k > 42) {
      this.sunk = true;
      this.mesh.visible = false;
    }
  }

  // ── Contact ──────────────────────────────────────────────────────────
  /** Keep the suit out of the steel: push it clear of the hull and the blocks on deck. */
  collide(p: THREE.Vector3, v: THREE.Vector3): void {
    if (this.sunk || p.distanceToSquared(this.mesh.position) > 90 * 90) return;
    this._qi.copy(this.mesh.quaternion).invert();
    const local = this._v.copy(p).sub(this.mesh.position).applyQuaternion(this._qi);
    const boxes: [number, number, number, number, number, number][] = [
      // x half-width, y0, y1, z0, z1, extra pad
      [7.6, -4, DECK, STERN, BOW, 0],
      [6, DECK, DECK + 9, -13, 9, 0],
      [4.5, DECK + 9, DECK + 12, -10.5, -1.5, 0],
      [6.5, DECK, DECK + 7, -38, -22, 0],
    ];
    const pad = 1.2;
    for (const [hw, y0, y1, z0, z1] of boxes) {
      const pen = [
        local.x + hw + pad, hw + pad - local.x,
        local.y - (y0 - pad), y1 + pad - local.y,
        local.z - (z0 - pad), z1 + pad - local.z,
      ];
      if (pen.some((d) => d <= 0)) continue;
      let best = 0;
      for (let i = 1; i < 6; i++) if (pen[i] < pen[best]) best = i;
      const axis = this._w.set(0, 0, 0);
      const sign = best % 2 ? 1 : -1;
      axis.setComponent(Math.floor(best / 2), sign);
      local.addScaledVector(axis, pen[best]);
      // Back to the world; kill the speed into the steel (relative to the ship)
      const n = axis.applyQuaternion(this.mesh.quaternion);
      const into = this._q2.copy(v).sub(this.vel).dot(n);
      if (into < 0) v.addScaledVector(n, -into);
    }
    p.copy(local.applyQuaternion(this.mesh.quaternion).add(this.mesh.position));
  }
}
