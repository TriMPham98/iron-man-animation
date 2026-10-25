import * as THREE from 'three';
import type { Suit } from '../../suit/Suit';
import type { FlightModel, GroundProbe } from '../sim/flightModel';
import type { Particles } from './particles';

/**
 * The suit and the sea: what the water does when the suit meets it.
 *
 *  - Going in: a crown of spray and droplets thrown up round the hole, the
 *    column that shoots up out of it a beat later as the cavity closes, a
 *    mist, and a ring of white water spreading out across the swell.
 *  - Skipping off it: a rooster tail thrown on ahead and a smear of foam.
 *  - In it: a wake of white water laid down behind (the sea's own foam
 *    map, so it stays on the surface, drifts and breaks into streaks),
 *    sheets of spray off the bow at speed, and the sea boiling over the
 *    boots fired under it.
 *  - Out of it: water running off the armour in drops (blown off as a mist
 *    flying fast), the plates glossy until they dry.
 *
 * Cheap: a handful of particles a frame and a few foam stamps the ocean's
 * foam pass takes in with its own update (no extra draw or pass).
 */

interface Ring {
  x: number;
  z: number;
  t: number;
  /** Seconds it spreads for, the radius it reaches (m), its width (m). */
  dur: number;
  reach: number;
  width: number;
}

interface Column {
  at: THREE.Vector3;
  delay: number;
  k: number;
}

/** Wet plates are this much glossier (share of their roughness taken off). */
const WET_GLOSS = 0.45;

export class WaterFx {
  private readonly rings: Ring[] = [];
  private readonly columns: Column[] = [];
  /** Last frame's waterline point, for the wake's swept stamp. */
  private readonly wakeFrom = new THREE.Vector3();
  private waking = false;
  private sprayAcc = 0;
  private dripAcc = 0;
  private boilAcc = 0;
  private readonly plates: { m: THREE.MeshStandardMaterial; r: number }[] = [];
  private gloss = 0;
  private readonly _p = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();

  constructor(suit: Suit) {
    const seen = new Set<THREE.Material>();
    suit.forEachMesh((mesh) => {
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (seen.has(m) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial || m.transparent) continue;
        seen.add(m);
        this.plates.push({ m: m as THREE.MeshStandardMaterial, r: (m as THREE.MeshStandardMaterial).roughness });
      }
    });
  }

  /** Into the water at `speed` (m/s, closing on the surface) at the surface point `at`, travelling `vel`. */
  plunge(at: THREE.Vector3, speed: number, vel: THREE.Vector3, ground: GroundProbe, particles: Particles): void {
    const k = THREE.MathUtils.clamp((speed - 2) / 40, 0, 1);
    // (a shallow, fast entry throws its water on along the travel)
    const carry = this._a.set(vel.x, 0, vel.z).multiplyScalar(0.25);
    // The crown: a wall of water thrown up and out round the hole
    const n = Math.round(10 + 16 * k);
    const r0 = 0.5 + 0.8 * k;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const out = 2 + Math.random() * (3 + 6 * k);
      const up = 4 + Math.random() * (5 + 16 * k);
      this._p.set(at.x + c * r0, at.y + 0.1, at.z + s * r0);
      particles.emit('spray', this._p, this._v.set(c * out, up, s * out).add(carry), { scale: 0.6 + 0.9 * k });
    }
    for (let i = 0; i < 20 + 60 * k; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 1 + Math.random() * (4 + 8 * k);
      this._p.set(at.x + Math.cos(a) * r0, at.y + 0.1, at.z + Math.sin(a) * r0);
      particles.emit('droplet', this._p, this._v.set(Math.cos(a) * out, 5 + Math.random() * (6 + 20 * k), Math.sin(a) * out).add(carry), { scale: 0.8 + 0.8 * k });
    }
    particles.burst('mist', this._p.copy(at).setY(at.y + 0.6), Math.round(3 + 4 * k), 2 + 3 * k, this._v.set(0, 0.5, 0), 1, { scale: 0.8 + 1.2 * k });
    // The column, as the cavity behind it closes (only a body going in hard opens one)
    if (k > 0.15) this.columns.push({ at: at.clone(), delay: 0.22 + 0.2 * k, k });
    // White water over the hole, and a ring of it spreading out
    ground.foam?.(at.x, at.z, at.x, at.z, 1.2 + 2.3 * k, 1.3);
    this.rings.push({ x: at.x, z: at.z, t: 0, dur: 1.6 + 1.4 * k, reach: 4 + 10 * k, width: 0.5 + 0.8 * k });
  }

  /** Skipped off the water at `speed` (m/s, closing) at `at`, travelling `vel`. */
  skip(at: THREE.Vector3, speed: number, vel: THREE.Vector3, ground: GroundProbe, particles: Particles): void {
    const k = THREE.MathUtils.clamp((speed - 2) / 25, 0, 1);
    const vh = Math.hypot(vel.x, vel.z);
    if (vh < 1e-3) return;
    const fx = vel.x / vh;
    const fz = vel.z / vh;
    // A rooster tail: water torn up off the surface and flung on after the suit
    for (let i = 0; i < 12 + 22 * k; i++) {
      const side = (Math.random() - 0.5) * (4 + 6 * k);
      const on = vh * (0.25 + 0.3 * Math.random());
      const up = 3 + Math.random() * (4 + 9 * k);
      this._v.set(fx * on - fz * side, up, fz * on + fx * side);
      particles.emit(i % 3 ? 'droplet' : 'spray', this._p.copy(at).setY(at.y + 0.1), this._v, { scale: 0.8 + k });
    }
    particles.burst('mist', this._p.copy(at).setY(at.y + 0.5), 2, 3, this._v.set(fx * 2, 0.4, fz * 2), 1, { scale: 0.8 + k });
    // The streak of white it skidded on, and a ring off it
    ground.foam?.(at.x - fx * (2 + 4 * k), at.z - fz * (2 + 4 * k), at.x + fx * 2, at.z + fz * 2, 1 + 1.6 * k, 1.2);
    this.rings.push({ x: at.x, z: at.z, t: 0, dur: 1.2, reach: 3 + 5 * k, width: 0.6 + 0.6 * k });
  }

  update(dt: number, m: FlightModel, particles: Particles): void {
    const g = m.ground;
    // Rings spreading out across the water, thinning as they go
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const u = r.t / r.dur;
      if (u >= 1) {
        this.rings.splice(i, 1);
        continue;
      }
      const rad = r.reach * (1 - (1 - u) * (1 - u));
      g.foam?.(r.x, r.z, r.x, r.z, rad + r.width * 0.5, 0.4 * (1 - u), Math.max(0, rad - r.width * 0.5));
    }
    // The column: straight up out of the hole, falling back as rain
    for (let i = this.columns.length - 1; i >= 0; i--) {
      const c = this.columns[i];
      c.delay -= dt;
      if (c.delay > 0) continue;
      this.columns.splice(i, 1);
      const surf = g.surface(c.at.x, c.at.z);
      const h = 8 + 22 * c.k;
      for (let j = 0; j < 10 + 20 * c.k; j++) {
        const a = Math.random() * Math.PI * 2;
        const out = Math.random() * (0.8 + 1.5 * c.k);
        this._p.set(c.at.x + Math.cos(a) * 0.3, surf + 0.2, c.at.z + Math.sin(a) * 0.3);
        this._v.set(Math.cos(a) * out, h * (0.55 + 0.45 * Math.random()), Math.sin(a) * out);
        particles.emit(j % 2 ? 'droplet' : 'spray', this._p, this._v, { scale: 0.7 + 0.9 * c.k });
      }
      g.foam?.(c.at.x, c.at.z, c.at.x, c.at.z, 1 + 1.5 * c.k, 1.1);
    }

    this.wake(dt, m, particles);
    this.drip(dt, m, particles);

    // Wet plates catch the light
    const gloss = m.wetness > 0.01 ? m.wetness : 0;
    if (Math.abs(gloss - this.gloss) > 0.01 || (gloss === 0 && this.gloss !== 0)) {
      this.gloss = gloss;
      for (const p of this.plates) p.m.roughness = p.r * (1 - WET_GLOSS * gloss);
    }
  }

  /** In the water: the wake, the bow spray, the sea boiling over boots fired under it. */
  private wake(dt: number, m: FlightModel, particles: Particles): void {
    const g = m.ground;
    if (m.immersion <= 0) {
      this.waking = false;
      return;
    }
    const surf = g.surface(m.pos.x, m.pos.z);
    const at = this._s.set(m.pos.x, surf, m.pos.z);
    const vh = Math.hypot(m.vel.x, m.vel.z);
    const from = this.waking ? this.wakeFrom : at;
    // (sitting still the boots just churn a patch round it)
    const wide = 0.6 + 0.6 * m.immersion + Math.min(1.6, vh * 0.04);
    g.foam?.(from.x, from.z, at.x, at.z, wide, 0.55 + 0.5 * Math.min(1, vh / 12) + 0.3 * m.throttle);
    this.wakeFrom.copy(at);
    this.waking = true;
    // Spray off the bow, more and further the quicker it's cutting through
    this.sprayAcc += dt * Math.min(140, (vh > 1.5 ? 12 + vh * 3 : 0) * Math.min(1, m.immersion * 3));
    if (vh > 1e-3) {
      const fx = m.vel.x / vh;
      const fz = m.vel.z / vh;
      while (this.sprayAcc >= 1) {
        this.sprayAcc -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const out = 1.5 + vh * (0.08 + 0.1 * Math.random());
        const on = vh * (0.2 + 0.4 * Math.random());
        this._v.set(fx * on - fz * side * out, 1.5 + Math.random() * (2 + vh * 0.12), fz * on + fx * side * out);
        this._p.set(at.x - fz * side * 0.35, surf + 0.1, at.z + fx * side * 0.35);
        particles.emit(Math.random() < 0.6 ? 'droplet' : 'spray', this._p, this._v, { scale: 0.6 + Math.min(1, vh / 40) });
      }
    } else this.sprayAcc = 0;
    // Under, with the boots lit: the sea boils white over it
    const boil = m.immersion > 0.95 ? Math.min(1, m.thrust / 12) : 0;
    this.boilAcc += dt * 30 * boil;
    while (this.boilAcc >= 1) {
      this.boilAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.2;
      this._p.set(at.x + Math.cos(a) * r, surf + 0.15, at.z + Math.sin(a) * r);
      particles.emit(Math.random() < 0.7 ? 'spray' : 'mist', this._p, this._v.set(Math.cos(a) * 1.5, 2 + Math.random() * 4, Math.sin(a) * 1.5), { scale: 0.8 });
    }
    if (boil > 0) g.foam?.(at.x, at.z, at.x, at.z, 2 + 1.5 * boil, 0.9);
  }

  /** Out of the water: drops running off the armour, or blown off as a mist at speed. */
  private drip(dt: number, m: FlightModel, particles: Particles): void {
    if (m.immersion > 0 || m.wetness < 0.04) {
      this.dripAcc = 0;
      return;
    }
    const fast = THREE.MathUtils.smoothstep(m.speed, 15, 60);
    this.dripAcc += dt * 70 * m.wetness;
    const axis = m.thrustAxis(this._a);
    while (this.dripAcc >= 1) {
      this.dripAcc -= 1;
      // Somewhere on the body, boots to head
      this._p
        .copy(m.pos)
        .addScaledVector(axis, -0.9 + Math.random() * 1.7)
        .add(this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.45));
      if (Math.random() < fast) {
        // Torn off by the air: a fine mist left hanging behind
        particles.emit('vapor', this._p, this._v.copy(m.vel).multiplyScalar(0.6 + 0.2 * Math.random()), { scale: 0.6, alpha: 0.7 });
      } else {
        this._v.copy(m.vel).multiplyScalar(0.9 + 0.1 * Math.random());
        this._v.x += (Math.random() - 0.5) * 0.6;
        this._v.y -= 0.3 + Math.random() * 0.6;
        this._v.z += (Math.random() - 0.5) * 0.6;
        particles.emit('droplet', this._p, this._v, { scale: 0.6, life: 0.8 });
      }
    }
  }
}
