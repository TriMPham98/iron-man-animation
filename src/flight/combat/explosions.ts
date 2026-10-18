import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';

/**
 * Blasts: a white flash, a rolling fireball that cools to soot, sparks and
 * burning debris arcing out on ballistic paths with their own smoke, and —
 * for the big ones — a ground shock and a column of smoke that hangs. A
 * small pool of point lights (always in the scene so no shader ever
 * recompiles) lights the surroundings for the first instants.
 */

const ZERO = new THREE.Vector3();

interface Debris {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  smoke: number;
  hot: boolean;
}

interface Burner {
  at: THREE.Vector3;
  life: number;
  rate: number;
  acc: number;
}

export interface SurfaceQuery {
  surface(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
}

export class Explosions {
  readonly group = new THREE.Group();
  private readonly lights: Array<{ light: THREE.PointLight; t: number; dur: number; peak: number }> = [];
  private readonly debris: Debris[] = [];
  private readonly burners: Burner[] = [];
  private next = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();

  constructor(
    private readonly particles: Particles,
    private readonly ground: SurfaceQuery,
    private readonly events: EventBus,
  ) {
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffa860, 0, 220, 1.8);
      this.lights.push({ light, t: 1, dur: 1, peak: 0 });
      this.group.add(light);
    }
    this.group.name = 'explosions';
  }

  private flashLight(at: THREE.Vector3, peak: number, dur: number): void {
    const l = this.lights[this.next++ % this.lights.length];
    l.light.position.copy(at);
    l.t = 0;
    l.dur = dur;
    l.peak = peak;
  }

  /** Air or surface blast. `size` ~ fireball radius (m). */
  blast(at: THREE.Vector3, size: number, opts: { debris?: number; burn?: boolean; vel?: THREE.Vector3 } = {}): void {
    const P = this.particles;
    const vel = opts.vel ?? ZERO;
    const surf = this.ground.surface(at.x, at.z);
    const nearGround = at.y - surf < size * 2.2;
    const water = nearGround && this.ground.isWater(at.x, at.z);
    P.emit('flash', at, undefined, { scale: size * 0.55 });
    const n = Math.round(10 + size * 3);
    for (let i = 0; i < n; i++) {
      const d = this._d.set(Math.random() - 0.5, Math.random() - 0.35, Math.random() - 0.5).normalize();
      const v = d.multiplyScalar(size * (1.5 + Math.random() * 3)).addScaledVector(vel, 0.5);
      P.emit('fire', this._v.copy(at).addScaledVector(d, 0.2), v, { scale: size * (0.25 + Math.random() * 0.2) });
    }
    for (let i = 0; i < Math.round(6 + size * 1.5); i++) {
      const d = this._d.set(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize();
      P.emit('darkSmoke', this._v.copy(at).addScaledVector(d, size * 0.4), d.multiplyScalar(size * 0.8).addScaledVector(vel, 0.25), {
        scale: size * 0.3,
        life: 0.7 + size * 0.04,
      });
    }
    P.burst('spark', at, Math.round(20 + size * 6), size * 9, undefined, 1, { scale: 1 + size * 0.05 });
    P.burst('ember', at, Math.round(8 + size * 2), size * 5, undefined, 1);
    if (water) {
      // Water column and a ring of spray
      const s = this._v.set(at.x, 0.2, at.z);
      for (let i = 0; i < 30 + size * 4; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random();
        P.emit('spray', s, this._d.set(Math.cos(a) * r * size * 2, size * (2 + Math.random() * 4), Math.sin(a) * r * size * 2), { scale: 1 + size * 0.15 });
      }
      P.burst('mist', s, 10, size * 1.2, new THREE.Vector3(0, 0.6, 0), 1, { scale: 1 + size * 0.2 });
    } else if (nearGround) {
      const s = this._v.set(at.x, surf + 0.5, at.z);
      for (let i = 0; i < 18 + size * 3; i++) {
        const a = (i / (18 + size * 3)) * Math.PI * 2;
        P.emit('dust', s, this._d.set(Math.cos(a) * size * 3, size * 0.4 + Math.random() * 2, Math.sin(a) * size * 3), { scale: 1 + size * 0.25 });
      }
    }
    for (let i = 0; i < (opts.debris ?? Math.round(size)); i++) {
      const d = this._d.set(Math.random() - 0.5, Math.random() * 0.8 + 0.1, Math.random() - 0.5).normalize();
      this.debris.push({
        p: at.clone(),
        v: d.multiplyScalar(12 + Math.random() * 18 * Math.sqrt(size)).addScaledVector(vel, 0.4),
        life: 2 + Math.random() * 2.5,
        smoke: 0,
        hot: Math.random() < 0.6,
      });
    }
    if (opts.burn) this.burners.push({ at: new THREE.Vector3(at.x, surf + 1, at.z), life: 25, rate: 6, acc: 0 });
    this.flashLight(at, 400 * size, 0.35 + size * 0.03);
    this.events.emit(size > 6 ? 'bigExplosion' : 'explosion', { at, value: size });
  }

  /** Launch back-blast / muzzle: a flash and a puff of propellant smoke. */
  muzzle(at: THREE.Vector3, dir: THREE.Vector3, size = 1): void {
    const P = this.particles;
    P.emit('flash', at, undefined, { scale: 0.25 * size });
    for (let i = 0; i < 6 * size; i++) {
      const v = this._d.copy(dir).multiplyScalar(-6 - Math.random() * 6).add(this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4));
      P.emit('smoke', at, v, { scale: 0.35 * size, life: 0.5 });
    }
  }

  /** A burning wreck keeps smoking where it lies. */
  burn(at: THREE.Vector3, seconds: number, rate = 5): void {
    this.burners.push({ at: at.clone(), life: seconds, rate, acc: 0 });
  }

  update(dt: number): void {
    for (const l of this.lights) {
      l.t += dt;
      const k = Math.max(0, 1 - l.t / l.dur);
      l.light.intensity = l.peak * k * k;
    }
    const P = this.particles;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.v.y -= 9.81 * dt;
      d.v.multiplyScalar(Math.exp(-0.25 * dt));
      d.p.addScaledVector(d.v, dt);
      d.smoke += dt;
      if (d.smoke > 0.03) {
        d.smoke = 0;
        P.emit(d.hot ? 'smoke' : 'darkSmoke', d.p, this._v.set(0, 0.5, 0), { scale: 0.35, life: 0.5 });
        if (d.hot) P.emit('ember', d.p, this._v.set(0, 0, 0), { scale: 1.6 });
      }
      const surf = this.ground.surface(d.p.x, d.p.z);
      if (d.p.y < surf || d.life <= 0) {
        if (d.p.y < surf + 1) P.burst(this.ground.isWater(d.p.x, d.p.z) ? 'spray' : 'dust', this._v.set(d.p.x, surf + 0.3, d.p.z), 4, 4, new THREE.Vector3(0, 1, 0), 0.8);
        this.debris.splice(i, 1);
      }
    }
    for (let i = this.burners.length - 1; i >= 0; i--) {
      const b = this.burners[i];
      b.life -= dt;
      b.acc += dt * b.rate * Math.min(1, b.life / 5);
      while (b.acc > 1) {
        b.acc -= 1;
        P.emit('darkSmoke', this._v.copy(b.at).add(this._d.set(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(3)), this._d.set(0.6, 3 + Math.random() * 2, 0.2), {
          scale: 0.8,
          life: 1.6,
        });
        if (Math.random() < 0.5) P.emit('fire', b.at, this._d.set(0, 2.5, 0), { scale: 0.4 });
      }
      if (b.life <= 0) this.burners.splice(i, 1);
    }
  }
}
