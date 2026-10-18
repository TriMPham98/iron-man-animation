import * as THREE from 'three';
import type { EventBus } from '../sim/events';
import type { Heightfield } from '../world/heightfield';
import type { Explosions } from './explosions';
import type { Missiles } from './missiles';
import type { DamageKind, Hostile, PlayerTarget } from './types';

/**
 * Surface-to-air launchers dug in on the ridgelines: a slewing four-tube box
 * on a turntable with a search radar spinning beside it. They track the
 * suit inside 4 km when they can see it (line of sight over the terrain)
 * and ripple heat seekers at it; flares and the hills are your friends.
 */

const mats = {
  olive: new THREE.MeshStandardMaterial({ color: 0x3b3d30, metalness: 0.4, roughness: 0.7 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.8, roughness: 0.4 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.5, roughness: 0.6 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0x220000, emissive: new THREE.Color(1, 0.08, 0.02), emissiveIntensity: 5 }),
};

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
  private readonly turret = new THREE.Group();
  private readonly pod = new THREE.Group();
  private readonly radar = new THREE.Group();
  private readonly lamp: THREE.Mesh;
  private reload = 4 + Math.random() * 4;
  private track = 0;
  private salvo = 0;
  private salvoT = 0;
  private readonly _v = new THREE.Vector3();

  constructor(at: THREE.Vector3) {
    this.pos.copy(at).add(new THREE.Vector3(0, 2.2, 0));
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.8, 1.2, 20), mats.olive);
    base.position.y = 0.6;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.5, 20), mats.steel);
    ring.position.y = 1.45;
    this.turret.position.y = 1.7;
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), mats.olive);
    cradle.position.y = 0.8;
    this.turret.add(cradle);
    this.pod.position.y = 1.7;
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.5, 4.2), mats.olive);
    this.pod.add(box);
    for (let i = 0; i < 4; i++) {
      const tube = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), mats.dark);
      tube.position.set((i % 2 ? 0.55 : -0.55), i < 2 ? 0.35 : -0.35, 2.11);
      this.pod.add(tube);
    }
    this.turret.add(this.pod);
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), mats.lamp);
    this.lamp.position.set(0, 0.95, 1.6);
    this.pod.add(this.lamp);
    // Radar mast + dish
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4, 8), mats.steel);
    mast.position.set(4.5, 2, 0);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.35), mats.steel);
    dish.rotation.x = Math.PI / 2;
    this.radar.position.set(4.5, 4.2, 0);
    this.radar.add(dish);
    const radarBase = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.6, 12), mats.olive);
    radarBase.position.set(4.5, 0.3, 0);
    this.mesh.add(base, ring, this.turret, mast, this.radar, radarBase);
    this.mesh.position.copy(at);
    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    void at;
    void kind;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  update(dt: number, t: number, player: PlayerTarget, field: Heightfield, missiles: Missiles, events: EventBus, explosions: Explosions): void {
    if (!this.alive) return;
    this.radar.rotation.y = t * 1.8;
    const to = this._v.copy(player.pos).sub(this.pos);
    const dist = to.length();
    const visible = player.alive && dist < 4200 && field.raycast(this.pos.clone().add(new THREE.Vector3(0, 3, 0)), to.clone().normalize(), dist - 5) < 0;
    // Slew the launcher onto the suit
    if (visible) {
      const yaw = Math.atan2(to.x, to.z);
      const pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
      this.turret.rotation.y += Math.atan2(Math.sin(yaw - this.turret.rotation.y), Math.cos(yaw - this.turret.rotation.y)) * Math.min(1, dt * 1.6);
      this.pod.rotation.x += (-Math.max(0.15, pitch) - this.pod.rotation.x) * Math.min(1, dt * 1.6);
      this.track += dt;
    } else {
      this.track = Math.max(0, this.track - dt * 2);
    }
    (this.lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = this.track > 0.5 ? 5 + 4 * Math.sin(t * 18) : 1;
    this.reload -= dt;
    if (this.track > 2.2 && this.reload <= 0 && this.salvo === 0) {
      this.salvo = 2;
      this.salvoT = 0;
      this.reload = 13 + Math.random() * 8;
    }
    if (this.salvo > 0) {
      this.salvoT -= dt;
      if (this.salvoT <= 0) {
        this.salvo--;
        this.salvoT = 0.9;
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.pod.getWorldQuaternion(new THREE.Quaternion()));
        const from = this.pod.getWorldPosition(new THREE.Vector3()).addScaledVector(fwd, 2.6);
        missiles.launch({ team: 'enemy', from, vel: fwd.clone().multiplyScalar(60), target: player, coast: 0.15 });
        explosions.muzzle(from, fwd, 1.6);
        events.emit('enemyMissile', { at: from, value: 1 });
      }
    }
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
