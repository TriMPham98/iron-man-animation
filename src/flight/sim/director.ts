import * as THREE from 'three';
import type { Drone } from '../combat/drones';
import { PAD } from '../world/house';
import type { Game } from './game';
import type { Controls } from './input';

/**
 * Flies a short demo reel by itself — the same sim, the same controls a
 * pilot would use, only the hands are the director's: the suit on the
 * bluff at sunset, ignition, off the cliff and down onto the water, a
 * boost through the sound barrier, a climbing turn back toward the coast,
 * three drones (repulsors, then a rocket salvo), a seeker shaken off with
 * flares, the unibeam, and home to the pad in a three-point landing.
 *
 * Phases advance on what happens in the sky (a kill, the boom, distance
 * to the pad), with timeouts, so the reel holds together whatever the
 * frame rate. Every camera cut is announced as an event so the sound
 * layer can be cued from the picture.
 */

type Phase =
  | 'title'
  | 'takeoff'
  | 'dive'
  | 'boost'
  | 'flyby'
  | 'turn'
  | 'repulsors'
  | 'missiles'
  | 'flares'
  | 'unibeam'
  | 'home'
  | 'descend'
  | 'landed'
  | 'done';

const UP = new THREE.Vector3(0, 1, 0);

export class Director {
  phase: Phase = 'title';
  private t = 0;
  private phaseT = 0;
  /** Out to sea heading south, the low sun off the right shoulder. */
  private readonly heading0 = 0.7;
  private heading = this.heading0;
  private targets: Drone[] = [];
  private beamTarget: Drone | null = null;
  private seekerAt = -1;
  private readonly aim = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private cutKill = false;
  private cutSalvo = false;
  private cutBeam = false;
  /** HUD visibility the reel wants (0 title → 1 flying → 0 at the end). */
  hud = 0;
  /** Seconds the reel has run past its last beat (main stops it). */
  tail = 0;

  constructor(private readonly game: Game) {
    game.combat.autoWaves = false;
    game.rig.mode = 'attract';
    // Booms and kills cut the picture
    game.events.on((e) => {
      if (e.kind === 'sonicBoom' && this.phase === 'boost') this.go('flyby');
      // Cut on the impacts: the first repulsor kill, the first rocket strike,
      // the moment the unibeam fires
      const m = game.model;
      const side = () => new THREE.Vector3().crossVectors(m.vel.lengthSq() > 1 ? m.vel : m.forward(), UP).normalize();
      if (e.kind === 'kill' && this.phase === 'repulsors' && !this.cutKill) {
        // Side-on, low: the suit streaks through frame, the drone burning behind
        this.cutKill = true;
        game.rig.plant(m.pos.clone().addScaledVector(m.vel, 0.5).addScaledVector(side(), -28).add(new THREE.Vector3(0, -6, 0)));
        this.cut('kill');
      }
      if (e.kind === 'explosion' && this.phase === 'missiles' && !this.cutSalvo) {
        this.cutSalvo = true;
        game.rig.plant(null);
        game.rig.mode = 'chase';
        this.cut('salvo');
      }
      if (e.kind === 'unibeamFire' && this.phase === 'unibeam' && !this.cutBeam) {
        // Head on: the camera ahead of the suit, the beam coming past it
        this.cutBeam = true;
        const fwd = m.forward(new THREE.Vector3()).setY(0).normalize();
        game.rig.plant(m.pos.clone().addScaledVector(fwd, 26).addScaledVector(side(), 9).add(new THREE.Vector3(0, -3, 0)));
        this.cut('unibeam');
      }
    });
  }

  private go(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
    const g = this.game;
    const m = g.model;
    switch (p) {
      case 'takeoff':
        g.rig.mode = 'chase';
        g.rig.lookHeading(this.heading0, -0.04);
        this.cut('reveal');
        g.events.emit('jarvis', { text: 'All systems online. Good evening, sir.' });
        break;
      case 'flyby': {
        // Planted ahead and to the side: the suit streaks past it
        const side = new THREE.Vector3().crossVectors(m.vel, UP).normalize();
        const at = m.pos.clone().addScaledVector(m.vel, 0.9).addScaledVector(side, 22).add(new THREE.Vector3(0, 5, 0));
        at.y = Math.max(at.y, g.ground.surface(at.x, at.z) + 3);
        g.rig.plant(at);
        this.cut('boom');
        break;
      }
      case 'turn':
        g.rig.plant(null);
        g.rig.mode = 'chase';
        this.cut('chase');
        break;
      case 'unibeam':
        g.rig.mode = 'chase';
        break;
      case 'home':
        g.rig.plant(null);
        g.rig.mode = 'chase';
        this.cut('home');
        g.events.emit('jarvis', { text: 'Area clear. Setting you down, sir.' });
        break;
      case 'landed':
        // Cut in close on the landing: the slow turn round the suit, as at the start
        g.rig.plant(null);
        g.rig.mode = 'attract';
        this.cut('landed');
        break;
      case 'descend': {
        // A low camera off to the side of the landing site, the sun behind it
        const site = this.site ?? (this.site = this.findSite());
        // Off to the side of the approach, low, looking across the site
        const appr = site.clone().sub(m.pos).setY(0).normalize();
        const side = new THREE.Vector3(appr.z, 0, -appr.x);
        const at = site.clone().addScaledVector(side, 38).addScaledVector(appr, 22);
        at.y = Math.max(g.ground.surface(at.x, at.z), site.y) + 16;
        g.rig.plant(at);
        this.cut('landing');
        break;
      }
      default:
        break;
    }
  }

  private cut(name: string): void {
    this.game.events.emit('cameraCut', { text: name });
  }

  /** Point the pilot's aim along a world direction (eased). */
  private steer(dir: THREE.Vector3, dt: number, rate = 3): void {
    const rig = this.game.rig;
    this._m.lookAt(new THREE.Vector3(), dir, UP);
    this._q.setFromRotationMatrix(this._m);
    rig.aimQ.slerp(this._q, 1 - Math.exp(-dt * rate));
  }

  private dirFrom(heading: number, pitch: number): THREE.Vector3 {
    return this.aim.set(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), Math.cos(heading) * Math.cos(pitch));
  }

  /** Pitch that flies toward a target altitude. */
  private holdAlt(target: number, k = 1 / 140, lo = -0.35, hi = 0.3): number {
    const m = this.game.model;
    return THREE.MathUtils.clamp((target - m.pos.y) * k - m.vel.y * 0.004, lo, hi);
  }

  private site: THREE.Vector3 | null = null;

  /** Somewhere flat on land ahead to set down: the first gentle slope past the shore. */
  private findSite(): THREE.Vector3 {
    const g = this.game;
    const m = g.model;
    const n = new THREE.Vector3();
    const f = g.world.field;
    // Rings outward from the suit, ahead first: flat, dry, not too high
    const ahead = Math.atan2(m.vel.x, m.vel.z);
    for (let r = 260; r < 2400; r += 60) {
      for (let k = 0; k < 24; k++) {
        const a = ahead + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.26;
        const x = m.pos.x + Math.sin(a) * r;
        const z = m.pos.z + Math.cos(a) * r;
        const h = f.heightAt(x, z);
        if (h < 6 || h > 220) continue;
        if (f.normalAt(x, z, n).y < 0.975) continue;
        const ok = [0, 1, 2, 3].every((q) => Math.abs(f.heightAt(x + Math.cos(q * 1.57) * 7, z + Math.sin(q * 1.57) * 7) - h) < 0.8);
        if (ok) return new THREE.Vector3(x, h, z);
      }
    }
    return new THREE.Vector3(PAD.x, g.ground.surface(PAD.x, PAD.y), PAD.y);
  }

  private nearest(list: Drone[]): Drone | null {
    const p = this.game.model.pos;
    let best: Drone | null = null;
    for (const d of list) if (d.alive && (!best || d.pos.distanceTo(p) < best.pos.distanceTo(p))) best = d;
    return best;
  }

  update(dt: number, c: Controls): void {
    this.t += dt;
    this.phaseT += dt;
    const g = this.game;
    const m = g.model;
    c.aimYaw = c.aimPitch = 0;
    c.throttle = c.lateral = c.vertical = c.forward = 0;
    c.fire = c.missile = c.unibeam = c.flares = c.launcher = c.boost = c.brake = false;
    c.pressed.clear();
    this.hud = this.phase === 'title' || this.phase === 'done' ? 0 : 1;

    switch (this.phase) {
      case 'title':
        if (this.phaseT > 3.5) this.go('takeoff');
        break;
      case 'takeoff':
        c.vertical = this.phaseT < 1.2 ? 1 : 0.2;
        if (this.phaseT > 1.0) c.throttle = 1;
        this.steer(this.dirFrom(this.heading0, -0.05), dt);
        if (this.phaseT > 2.6) this.go('dive');
        break;
      case 'dive':
        c.throttle = 1;
        c.vertical = this.phaseT < 0.6 ? 0.4 : 0;
        this.steer(this.dirFrom(this.heading0, this.holdAlt(18, 1 / 110, -0.3, 0.2)), dt, 4);
        if (this.phaseT > 3.2 && m.pos.y < 40) this.go('boost');
        break;
      case 'boost':
        c.boost = true;
        this.steer(this.dirFrom(this.heading0, this.holdAlt(16, 1 / 80, -0.15, 0.15)), dt, 4);
        if (this.phaseT > 9) this.go('flyby');
        break;
      case 'flyby':
        c.boost = this.phaseT < 0.8;
        this.steer(this.dirFrom(this.heading0, this.holdAlt(30, 1 / 80, -0.1, 0.15)), dt, 4);
        if (this.phaseT > 2.3) this.go('turn');
        break;
      case 'turn': {
        // Climbing turn back toward the coast; the drones come off the ridge
        c.throttle = m.speedCmd > 190 ? -1 : 0;
        const k = Math.min(1, this.phaseT / 4.2);
        this.heading = this.heading0 + Math.PI * 0.92 * (k * k * (3 - 2 * k));
        this.steer(this.dirFrom(this.heading, this.holdAlt(240, 1 / 160, -0.15, 0.32)), dt, 3);
        if (this.phaseT > 3.6 && this.targets.length === 0) {
          const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
          const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
          for (let i = 0; i < 3; i++) {
            const at = m.pos.clone().addScaledVector(fwd, 1700 + i * 140).addScaledVector(side, (i - 1) * 150);
            at.y = Math.max(m.pos.y + 25 + i * 15, g.ground.surface(at.x, at.z) + 160);
            const d = g.combat.spawnDrone(at, fwd.clone().negate());
            d.passive = true;
            this.targets.push(d);
          }
          g.events.emit('jarvis', { text: 'Three bogeys off the ridge, sir.' });
        }
        if (this.phaseT > 4.4) this.go('repulsors');
        break;
      }
      case 'repulsors': {
        const d = this.nearest(this.targets);
        if (d) {
          const lead = d.pos.clone().addScaledVector(d.vel, d.pos.distanceTo(m.pos) / 900);
          this.steer(lead.sub(g.head).normalize(), dt, 14);
          c.fire = d.pos.distanceTo(m.pos) < 1250 && !!g.combat.weapons.assist;
        }
        const alive = this.targets.filter((x) => x.alive).length;
        if (alive < 3 || this.phaseT > 7) this.go('missiles');
        break;
      }
      case 'missiles': {
        // Paint the rest, then ripple the rockets off
        const live = this.targets.filter((x) => x.alive);
        if (live.length) {
          const mid = live.reduce((a, d) => a.add(d.pos), new THREE.Vector3()).divideScalar(live.length);
          this.steer(mid.sub(g.head).normalize(), dt, 5);
        }
        c.missile = this.phaseT < 0.35 + 0.26 * Math.max(1, live.length) + 0.25 && live.length > 0;
        if ((live.length === 0 && this.phaseT > 1.2) || this.phaseT > 6) this.go('flares');
        break;
      }
      case 'flares': {
        // A seeker from the flank, shaken off with a fan of flares
        this.steer(this.dirFrom(this.heading, this.holdAlt(220, 1 / 160, -0.1, 0.2)), dt, 3);
        if (this.seekerAt < 0) {
          this.seekerAt = this.phaseT;
          const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
          const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
          const from = m.pos.clone().addScaledVector(fwd, 600).addScaledVector(side, -700).add(new THREE.Vector3(0, -80, 0));
          g.combat.missiles.launch({ team: 'enemy', from, vel: m.pos.clone().sub(from).normalize().multiplyScalar(120), target: g.combat.playerTarget, coast: 0.1 });
          g.events.emit('enemyMissile', { at: from, value: 1 });
        }
        c.flares = this.phaseT > 1.6 && this.phaseT < 1.75;
        if (this.phaseT > 3.6) {
          // The last drone, head on, for the unibeam
          const fwd = m.vel.clone().setY(0).normalize();
          const at = m.pos.clone().addScaledVector(fwd, 950);
          at.y = Math.max(m.pos.y, g.ground.surface(at.x, at.z) + 60);
          this.beamTarget = g.combat.spawnDrone(at, fwd.clone().negate());
          this.beamTarget.passive = true;
          this.go('unibeam');
        }
        break;
      }
      case 'unibeam': {
        const d = this.beamTarget;
        if (d && d.alive) {
          this.steer(d.pos.clone().sub(g.head).normalize(), dt, 14);
          c.unibeam = true;
        }
        if ((!d || !d.alive) && this.phaseT > 1) this.go('home');
        if (this.phaseT > 6) this.go('home');
        break;
      }
      case 'home': {
        // Run in toward the site, brake hard into a hover over it
        if (!this.site) this.site = this.findSite();
        const to = this.site.clone().setY(0).sub(m.pos.clone().setY(0));
        const dist = to.length();
        const hdg = Math.atan2(to.x, to.z);
        c.throttle = m.speedCmd < (dist > 600 ? 130 : 60) ? 1 : -1;
        const ahead = m.pos.clone().addScaledVector(m.vel, 3);
        const floor = Math.max(this.site.y, g.ground.surface(m.pos.x, m.pos.z), g.ground.surface(ahead.x, ahead.z));
        this.steer(this.dirFrom(hdg, this.holdAlt(floor + 60, 1 / 100, -0.25, 0.3)), dt, 3);
        if (dist < 210 || this.phaseT > 14) this.go('descend');
        break;
      }
      case 'descend': {
        const site = this.site ?? this.findSite();
        const to = site.clone().setY(0).sub(m.pos.clone().setY(0));
        const dist = to.length();
        if (dist > 15) this.steer(this.dirFrom(Math.atan2(to.x, to.z), -0.2), dt, 3);
        c.brake = true;
        const fwd = g.model.forward(new THREE.Vector3()).setY(0).normalize();
        const left = new THREE.Vector3(fwd.z, 0, -fwd.x);
        c.forward = THREE.MathUtils.clamp(to.dot(fwd) / 40, -1, 1);
        c.lateral = THREE.MathUtils.clamp(-to.dot(left) / 40, -1, 1);
        const over = dist < 25 && Math.hypot(m.vel.x, m.vel.z) < 7;
        // Hold well clear of the ground on the way in (it rises under the
        // bluffs), drop only once settled over the site
        const ahead = m.pos.clone().addScaledVector(m.vel, 3);
        const floor = Math.max(site.y, g.ground.surface(m.pos.x, m.pos.z), g.ground.surface(ahead.x, ahead.z));
        c.vertical = over ? -1 : THREE.MathUtils.clamp((floor + (dist < 30 ? 30 : 50) - m.pos.y) / 10, -1, 1);
        if (m.grounded || this.phaseT > 14) this.go('landed');
        break;
      }
      case 'landed':
        if (this.phaseT > 4) this.go('done');
        break;
      case 'done':
        this.tail += dt;
        break;
    }
  }
}
