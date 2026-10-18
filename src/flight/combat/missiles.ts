import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { Explosions, SurfaceQuery } from './explosions';
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

function missileMesh(team: Team, heavy: boolean): THREE.Group {
  const g = new THREE.Group();
  const { body, nose } = MATS[team];
  const s = heavy ? 1.6 : team === 'player' ? 0.6 : 1.4;
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.06 * s, 0.9 * s, 10).rotateX(Math.PI / 2), body);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06 * s, 0.22 * s, 10).rotateX(Math.PI / 2).translate(0, 0, 0.56 * s), nose);
  g.add(cyl, tip);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.004 * s * 10, 0.16 * s, 0.14 * s), body);
    fin.position.set(0, 0, -0.38 * s);
    fin.rotation.z = (i * Math.PI) / 2;
    fin.translateY(0.08 * s);
    g.add(fin);
  }
  return g;
}

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

const isHostile = (t: unknown): t is Hostile => !!t && typeof (t as Hostile).damage === 'function';
const isPlayer = (t: unknown): t is PlayerTarget => !!t && typeof (t as PlayerTarget).hit === 'function';

export class Missiles {
  readonly group = new THREE.Group();
  readonly live: Missile[] = [];
  private readonly _v = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _los = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
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
    heavy?: boolean;
    coast?: number;
  }): void {
    const heavy = !!opts.heavy;
    const mesh = missileMesh(opts.team, heavy);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffd8a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    glow.scale.setScalar(heavy ? 2.4 : 1.4);
    this.group.add(mesh, glow);
    const player = opts.team === 'player';
    this.live.push({
      team: opts.team,
      pos: opts.from.clone(),
      vel: opts.vel.clone(),
      speed: player ? (heavy ? 640 : 430) : 330,
      accel: player ? 260 : 120,
      turn: player ? 34 : 22,
      life: player ? 9 : 12,
      age: 0,
      coast: opts.coast ?? (player ? 0.22 : 0.4),
      target: opts.target,
      aimPoint: opts.aimPoint?.clone() ?? null,
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
      if (tgt && 'alive' in tgt && !(tgt as Hostile).alive) m.target = null;
      else if (tgt) {
        tp = tgt.pos;
        tv = 'vel' in tgt ? (tgt as Hostile).vel : null;
      }
      if (!tp && m.aimPoint) tp = m.aimPoint;
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
      m.vel.copy(dir).multiplyScalar(m.age < m.coast ? sp * Math.exp(-dt * 1.5) : newSp);
      const prev = this._v.copy(m.pos);
      m.pos.addScaledVector(m.vel, dt);

      // Orient + glow at the tail
      m.mesh.position.copy(m.pos);
      m.mesh.quaternion.setFromUnitVectors(this.FWD, dir);
      const lit = m.age > m.coast * 0.5;
      m.glow.visible = lit;
      m.glow.position.copy(m.pos).addScaledVector(dir, m.heavy ? -0.8 : -0.4);
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
          if (h.pos.distanceToSquared(m.pos) < (h.radius + 3.5) ** 2) {
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
      } else if (m.target && m.pos.distanceToSquared(m.target.pos) < 4 ** 2) {
        boom = true;
      }
      const surf = this.ground.surface(m.pos.x, m.pos.z);
      if (m.pos.y < surf + 0.3) boom = true;
      if (m.aimPoint && !m.target && m.pos.distanceToSquared(m.aimPoint) < 9) boom = true;
      m.life -= dt;
      if (boom || m.life <= 0) {
        if (boom || m.team === 'player') this.explosions.blast(m.pos, m.blast, { vel: m.vel.clone().multiplyScalar(0.05) });
        // Splash damage to anything else nearby
        if (m.team === 'player') {
          for (const h of hostiles) {
            if (!h.alive) continue;
            const d = h.pos.distanceTo(m.pos);
            if (d < m.blast * 3) h.damage(m.damage * 0.5 * (1 - d / (m.blast * 3)), m.pos, 'missile');
          }
        } else if (player.alive) {
          const d = player.pos.distanceTo(m.pos);
          if (!boom && d < 10) player.hit(m.damage * (1 - d / 10), m.pos, 'missile');
        }
        this.group.remove(m.mesh, m.glow);
        m.glow.material.dispose();
        this.live.splice(i, 1);
      }
    }
  }
}
