import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { Explosions, SurfaceQuery } from './explosions';
import { coreDistance } from './hitShape';
import type { Decoy, Hostile, PlayerTarget } from './types';

/**
 * Guided rockets for both sides. Proportional navigation (N = 4) with a
 * turn limit and a burn time: the suit's mini-rockets kick up off the
 * shoulders before they pitch onto their targets; the drones' heat seekers
 * can be pulled off the suit by a flare. Each leaves a smoke trail laid by
 * distance, so it's continuous at any speed.
 */

type Team = 'player' | 'enemy';

interface Missile {
  team: Team;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  speed: number;
  accel: number;
  /** g limit on the turn. */
  turn: number;
  life: number;
  age: number;
  /** Delay before guidance takes over (rockets kick out first). */
  coast: number;
  target: Hostile | PlayerTarget | Decoy | null;
  aimPoint: THREE.Vector3 | null;
  /** Called where it goes off (a strike on the house). */
  onImpact: ((at: THREE.Vector3) => void) | null;
  damage: number;
  blast: number;
  mesh: THREE.Object3D;
  glow: THREE.Sprite;
  laid: number;
  heavy: boolean;
  decoyed: boolean;
}

const MATS = {
  player: {
    body: new THREE.MeshStandardMaterial({ color: 0x8a1218, metalness: 0.8, roughness: 0.35 }),
    nose: new THREE.MeshStandardMaterial({ color: 0xb8913c, metalness: 1, roughness: 0.25 }),
  },
  enemy: {
    body: new THREE.MeshStandardMaterial({ color: 0x2c2f33, metalness: 0.8, roughness: 0.35 }),
    nose: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.25 }),
  },
};

/**
 * One unit-calibre airframe (radius 1, nose forward along +Z, length
 * {@link UNIT_LEN} calibres), shared by every rocket; each is scaled to its
 * own tube. Built once: nothing to allocate or dispose per shot.
 */
const UNIT_LEN = 16;
let airframe: { body: THREE.BufferGeometry; nose: THREE.BufferGeometry; fins: THREE.BufferGeometry } | null = null;
function unitAirframe() {
  if (airframe) return airframe;
  const L = UNIT_LEN;
  const body = new THREE.CylinderGeometry(1, 1, L * 0.78, 10).rotateX(Math.PI / 2).translate(0, 0, -L * 0.11);
  const nose = new THREE.ConeGeometry(1, L * 0.22, 10).rotateX(Math.PI / 2).translate(0, 0, L * 0.39);
  const fin = new THREE.BoxGeometry(0.12, 2.6, L * 0.14).translate(0, 1.3, -L * 0.42);
  const fins = [0, 1, 2, 3].map((i) => fin.clone().rotateZ(Math.PI / 4 + (i * Math.PI) / 2));
  airframe = { body, nose, fins: mergeGeometries(fins) };
  return airframe;
}

function mergeGeometries(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const g of gs) {
    const ng = g.index ? g.toNonIndexed() : g;
    pos.push(...(ng.getAttribute('position').array as Float32Array));
    nrm.push(...(ng.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

/** A rocket `caliber` m in radius and `length` m long (nose along +Z). */
function missileMesh(team: Team, caliber: number, length: number): THREE.Group {
  const g = new THREE.Group();
  const { body, nose } = MATS[team];
  const a = unitAirframe();
  g.add(new THREE.Mesh(a.body, body), new THREE.Mesh(a.nose, nose), new THREE.Mesh(a.fins, body));
  g.scale.set(caliber, caliber, length / UNIT_LEN);
  return g;
}

/** Default airframes (m): enemy seekers; the suit's own come from their tubes. */
const ENEMY_CALIBER = 0.09;
const ENEMY_LENGTH = 1.5;

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,220,160,0.9)');
  grad.addColorStop(0.6, 'rgba(255,140,40,0.25)');
  grad.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** Squared distance from `p` to the segment a → b. */
function segDistSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2)) : 0;
  const dx = a.x + abx * t - p.x, dy = a.y + aby * t - p.y, dz = a.z + abz * t - p.z;
  return dx * dx + dy * dy + dz * dz;
}

const isHostile = (t: unknown): t is Hostile => !!t && typeof (t as Hostile).damage === 'function';
const isDecoy = (t: unknown): t is Decoy => !!t && typeof (t as Decoy).heat === 'number';
const isPlayer = (t: unknown): t is PlayerTarget => !!t && typeof (t as PlayerTarget).hit === 'function';

export class Missiles {
  readonly group = new THREE.Group();
  readonly live: Missile[] = [];
  private readonly _v = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _los = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Vector3();
  private readonly FWD = new THREE.Vector3(0, 0, 1);

  constructor(
    private readonly particles: Particles,
    private readonly explosions: Explosions,
    private readonly ground: SurfaceQuery,
    private readonly events: EventBus,
  ) {
    this.group.name = 'missiles';
  }

  launch(opts: {
    team: Team;
    from: THREE.Vector3;
    vel: THREE.Vector3;
    target: Hostile | PlayerTarget | null;
    aimPoint?: THREE.Vector3;
    onImpact?: (at: THREE.Vector3) => void;
    heavy?: boolean;
    coast?: number;
    /** Airframe radius and length (m): the tube it left. */
    caliber?: number;
    length?: number;
  }): void {
    const heavy = !!opts.heavy;
    const caliber = opts.caliber ?? ENEMY_CALIBER;
    const mesh = missileMesh(opts.team, caliber, opts.length ?? (opts.caliber ? caliber * UNIT_LEN : ENEMY_LENGTH));
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffd8a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    glow.visible = false;
    mesh.position.copy(opts.from);
    mesh.quaternion.setFromUnitVectors(this.FWD, this._d.copy(opts.vel).normalize());
    this.group.add(mesh, glow);
    const player = opts.team === 'player';
    const base = player ? (heavy ? 640 : 430) : 330;
    this.live.push({
      team: opts.team,
      pos: opts.from.clone(),
      vel: opts.vel.clone(),
      // A rocket off a fast suit still gains on it
      speed: Math.max(base, opts.vel.length() + (heavy ? 220 : 160)),
      accel: player ? 260 : 120,
      turn: player ? 34 : 22,
      // (a strike on the house flies the long way round, over the hills)
      life: player ? 9 : opts.onImpact ? 22 : 12,
      age: 0,
      coast: opts.coast ?? (player ? 0.22 : 0.4),
      target: opts.target,
      aimPoint: opts.aimPoint?.clone() ?? null,
      onImpact: opts.onImpact ?? null,
      damage: player ? (heavy ? 260 : 120) : 26,
      blast: player ? (heavy ? 7 : 4.5) : 4,
      mesh,
      glow,
      laid: 0,
      heavy,
      decoyed: false,
    });
  }

  /** Offer a flare to every enemy seeker near the suit. */
  offerDecoy(decoy: Decoy, suitPos: THREE.Vector3): void {
    for (const m of this.live) {
      if (m.team !== 'enemy' || m.decoyed || !isPlayer(m.target)) continue;
      if (m.pos.distanceTo(suitPos) > 900) continue;
      if (Math.random() < 0.62) {
        m.target = decoy;
        m.decoyed = true;
        this.events.emit('missileDecoyed', { at: m.pos });
      }
    }
  }

  /** Enemy seekers currently chasing the player (for the warning). */
  threats(): Missile[] {
    return this.live.filter((m) => m.team === 'enemy' && isPlayer(m.target));
  }

  /** Enemy rounds on their way to the house. */
  strikes(): Missile[] {
    return this.live.filter((m) => m.team === 'enemy' && m.onImpact !== null);
  }

  /** Every round in the air gone, without a bang (a fresh run). */
  clear(): void {
    for (const m of this.live) {
      this.group.remove(m.mesh, m.glow);
      m.glow.material.dispose();
    }
    this.live.length = 0;
  }

  update(dt: number, hostiles: readonly Hostile[], player: PlayerTarget): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const m = this.live[i];
      m.age += dt;
      // Motor: accelerate toward cruise along the body
      const sp = m.vel.length();
      const dir = this._d.copy(m.vel).divideScalar(Math.max(sp, 1e-3));
      const newSp = Math.min(m.speed, sp + m.accel * dt);
      // Guidance
      const tgt = m.target;
      let tp: THREE.Vector3 | null = null;
      let tv: THREE.Vector3 | null = null;
      // (a flare another seeker already ate is gone: fly on blind)
      if ((tgt && 'alive' in tgt && !(tgt as Hostile).alive) || (isDecoy(tgt) && tgt.eaten)) m.target = null;
      else if (tgt) {
        tp = tgt.pos;
        tv = 'vel' in tgt ? (tgt as Hostile).vel : null;
      }
      if (!tp && m.aimPoint) {
        tp = m.aimPoint;
        // A strike lobbed at the house flies at a point high over it, which
        // sinks as it closes: an arc over the hills that dives onto the roof
        if (m.onImpact) tp = this._aim.copy(tp).setY(tp.y + 0.45 * Math.max(0, Math.hypot(tp.x - m.pos.x, tp.z - m.pos.z) - 150));
      }
      if (tp && m.age > m.coast) {
        const los = this._los.copy(tp).sub(m.pos);
        const dist = los.length();
        // Lead the target: aim at where it will be
        const tgo = dist / Math.max(newSp, 50);
        if (tv) los.addScaledVector(tv, Math.min(tgo, 3));
        const want = los.normalize();
        const ang = dir.angleTo(want);
        const maxTurn = (m.turn * 9.81 * dt) / Math.max(newSp, 50);
        if (ang > 1e-4) {
          const axis = this._v.crossVectors(dir, want).normalize();
          this._q.setFromAxisAngle(axis, Math.min(ang, maxTurn * 4 * Math.min(1, (m.age - m.coast) * 3)));
          dir.applyQuaternion(this._q);
        }
      }
      // Coasting off the rail the round keeps the suit's speed plus its
      // kick (it never drops back onto the suit); the motor lights after
      if (m.age < m.coast) m.vel.y -= 9.81 * dt;
      else m.vel.copy(dir).multiplyScalar(newSp);
      const prev = this._v.copy(m.pos);
      m.pos.addScaledVector(m.vel, dt);

      // Orient + glow at the tail
      m.mesh.position.copy(m.pos);
      m.mesh.quaternion.setFromUnitVectors(this.FWD, this._q2.copy(m.vel).normalize());
      const lit = m.age > m.coast * 0.5;
      m.glow.visible = lit;
      // Motor plume at the nozzle: small at ignition (by the suit), then the
      // bright point that carries it across the sky
      const burn = Math.min(1, (m.age - m.coast * 0.5) / 0.35);
      const tail = m.mesh.scale.z * UNIT_LEN * 0.5;
      m.glow.position.copy(m.pos).addScaledVector(dir, -tail);
      m.glow.scale.setScalar(THREE.MathUtils.lerp(0.12, m.team === 'enemy' ? 2 : m.heavy ? 1.8 : 1.1, burn));
      m.glow.material.opacity = 0.85 + 0.15 * Math.sin(m.age * 60);

      // Trail: puffs laid by distance travelled
      if (lit) {
        m.laid += m.vel.length() * dt;
        const spacing = m.heavy ? 2.2 : 1.6;
        let k = 0;
        while (m.laid > spacing && k < 40) {
          m.laid -= spacing;
          k++;
          const p = this._los.copy(prev).lerp(m.pos, 1 - m.laid / Math.max(1e-3, m.vel.length() * dt));
          this.particles.emit('trail', p, undefined, { scale: m.heavy ? 1.4 : 1, life: m.team === 'enemy' ? 1.2 : 1 });
          if (Math.random() < 0.35) this.particles.emit('ember', p, undefined, { scale: 1.2 });
        }
      }

      // Hits: proximity fuse on the target, anything hostile in reach, or the ground
      let boom = false;
      if (m.team === 'player') {
        for (const h of hostiles) {
          if (!h.alive) continue;
          if (coreDistance(h, m.pos) < h.radius + 3.5) {
            h.damage(m.damage, m.pos, m.heavy ? 'launcher' : 'missile');
            boom = true;
            break;
          }
        }
        if (isHostile(m.target) && m.target.alive) m.target.threatened = 1;
      } else if (isPlayer(m.target)) {
        if (player.alive && player.pos.distanceToSquared(m.pos) < 3.2 ** 2) {
          player.hit(m.damage, m.pos, 'missile');
          boom = true;
        }
      } else if (isDecoy(m.target) && segDistSq(m.target.pos, prev, m.pos) < 4 ** 2) {
        // A decoyed seeker runs down its flare and goes off on it (swept, so
        // a fast one can't step past it between frames), taking it with it
        m.pos.copy(m.target.pos);
        m.target.eaten = true;
        boom = true;
      }
      const surf = this.ground.surface(m.pos.x, m.pos.z);
      if (m.pos.y < surf + 0.3) boom = true;
      if (m.aimPoint && !m.target && m.pos.distanceToSquared(m.aimPoint) < 9) boom = true;
      m.life -= dt;
      if (boom || m.life <= 0) {
        if (boom || m.team === 'player') this.explosions.blast(m.pos, m.blast, { vel: m.vel.clone().multiplyScalar(0.05) });
        if (boom) m.onImpact?.(m.pos);
        // Splash damage to anything else nearby
        if (m.team === 'player') {
          for (const h of hostiles) {
            if (!h.alive) continue;
            const d = Math.max(0, coreDistance(h, m.pos) - (h.span ? h.radius : 0));
            if (d < m.blast * 3) h.damage(m.damage * 0.5 * (1 - d / (m.blast * 3)), m.pos, 'missile');
          }
        } else if (player.alive) {
          const d = player.pos.distanceTo(m.pos);
          // (a strike on the house catches a suit standing by it)
          if ((!boom || m.onImpact) && d < 10) player.hit(m.damage * (1 - d / 10), m.pos, 'missile');
        }
        this.group.remove(m.mesh, m.glow);
        m.glow.material.dispose();
        this.live.splice(i, 1);
      }
    }
  }
}
