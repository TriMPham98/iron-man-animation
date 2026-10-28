import * as THREE from 'three';
import type { Frigate, ShipPart } from '../combat/frigate';
import { coastZ } from '../world/heightfield';
import type { Reel } from './director';
import type { Game } from './game';
import type { Controls } from './input';

/**
 * A directed reel of the frigate fight, flown with the pilot's controls:
 * off the bluff and down the coast on the boost, through the sound
 * barrier, onto the waves under the guns' sea clutter, a pop-up onto the
 * mast radar, strafing runs on the guns and the launcher (flares for the
 * seekers, a rocket ripple, the forearm launchers), then the unibeam into
 * the opened hull from a hover, and the ship going down by the stern.
 *
 * The hands are a pilot's: the aim is eased, never snapped, and wanders a
 * little the way a mouse hand does; runs are flown at the target and
 * broken off, not orbited on rails. Phases advance on what happens to the
 * ship, with timeouts, so the reel holds together whatever goes wrong.
 */

type Phase = 'title' | 'takeoff' | 'dash' | 'skim' | 'popup' | 'dive' | 'extend' | 'run' | 'beam' | 'sink' | 'done';

const UP = new THREE.Vector3(0, 1, 0);
/** Where down the coast the frigate patrols (m along x). */
const SHIP_X = 4500;

export class FrigateReel implements Reel {
  phase: Phase = 'title';
  hud = 0;
  tail = 0;
  private t = 0;
  private phaseT = 0;
  private readonly ship: Frigate;
  private heading = 0;
  /** The part the current run is on. */
  private target: ShipPart | null = null;
  private runs = 0;
  private flaredAt = -99;
  private salvoAt = -99;
  private cutRadar = false;
  private cutBoom = false;
  private climbing = false;
  private paintAt = -99;
  private boomAt = -99;
  /** Launcher presses left on this run (one round per press: the VLS is one target). */
  private presses = 0;
  private pressAt = -99;
  private cutSink = false;
  private sinkCam = 0;
  /** Strafe side round the ship in the hover (±1). */
  private orbit = 1;
  private readonly aim = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();

  constructor(private readonly game: Game) {
    const g = game;
    g.combat.wavesEnabled = false;
    g.rig.mode = 'attract';
    this.ship = g.combat.spawnFrigate(new THREE.Vector3(SHIP_X, 0, coastZ(SHIP_X)));
    const m = g.model;
    this.heading = this.bearing(this.ship.pos);
    g.events.on((e) => {
      if (e.kind === 'sonicBoom' && this.phase === 'dash' && !this.cutBoom) {
        // Ahead and low on the water, off the line: the suit comes at the
        // lens and past it, its Mach cone sweeping over (the boom)
        this.cutBoom = true;
        this.boomAt = this.t;
        const side = new THREE.Vector3().crossVectors(m.vel, UP).normalize();
        const at = m.pos.clone().addScaledVector(m.vel, 1.5).addScaledVector(side, 18);
        at.y = Math.max(0, g.ground.surface(at.x, at.z)) + 3;
        g.rig.plant(at);
        this.cut('boom');
      }
      if (e.kind === 'destroyed' || e.kind === 'kill') {
        if (!this.cutRadar && !this.ship.radar.alive) {
          // Side-on behind the suit: the mast burning past its shoulder
          this.cutRadar = true;
          this.plantBeyond(150, 9, 0.004);
          this.cut('radar');
        }
      }
    });
    void m;
  }

  private go(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
    const g = this.game;
    switch (p) {
      case 'takeoff':
        g.rig.mode = 'chase';
        g.rig.lookHeading(this.heading, -0.04);
        this.cut('reveal');
        g.events.emit('jarvis', { text: 'A warship off the coast, sir. Guns fore and aft, a missile launcher on the foredeck. Take the radar first.' });
        break;
      case 'skim':
      case 'run':
        this.release();
        break;
      case 'beam':
        g.rig.plant(null);
        g.rig.mode = 'chase';
        this.cut('beam');
        break;
      default:
        break;
    }
  }

  /** Back to the chase camera from a planted shot. */
  private release(): void {
    const g = this.game;
    if (g.rig.mode !== 'flyby') return;
    g.rig.plant(null);
    g.rig.mode = 'chase';
    this.cut('chase');
  }

  private cut(name: string): void {
    this.game.events.emit('cameraCut', { text: name });
  }

  /** A camera planted behind and beside the suit, looking past it at the ship. */
  private plantBehind(back: number, side: number, up: number, frac = 0.1): void {
    const g = this.game;
    const m = g.model;
    const away = m.pos.clone().sub(this.ship.pos).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(away, UP).normalize();
    const at = m.pos.clone().addScaledVector(away, back).addScaledVector(right, side).add(new THREE.Vector3(0, up, 0));
    at.y = Math.max(at.y, g.ground.surface(at.x, at.z) + 2);
    g.rig.plant(at, frac);
  }

  /** A camera on the water beyond the ship, looking back over it at the suit coming in. */
  private plantBeyond(past: number, up: number, frac: number): void {
    const g = this.game;
    const f = this.ship;
    const away = f.pos.clone().sub(g.model.pos).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(away, UP).normalize();
    g.rig.plant(f.pos.clone().addScaledVector(away, past).addScaledVector(right, 30).setY(up), frac);
  }

  private bearing(p: THREE.Vector3): number {
    const m = this.game.model;
    return Math.atan2(p.x - m.pos.x, p.z - m.pos.z);
  }

  private flatDist(p: THREE.Vector3): number {
    const m = this.game.model;
    return Math.hypot(p.x - m.pos.x, p.z - m.pos.z);
  }

  /** A hand on the mouse: slow drift of a few tenths of a degree. */
  private wander(dir: THREE.Vector3, k = 1): THREE.Vector3 {
    const t = this.t;
    const a = 0.0045 * k;
    dir.x += a * (Math.sin(t * 1.7) + 0.6 * Math.sin(t * 4.3 + 1.1));
    dir.y += a * (Math.sin(t * 2.3 + 0.4) + 0.5 * Math.sin(t * 5.1 + 2));
    dir.z += a * Math.sin(t * 1.3 + 2.7);
    return dir.normalize();
  }

  /** Ease the pilot's aim onto a world direction. */
  private steer(dir: THREE.Vector3, dt: number, rate = 3, wander = 1): void {
    this._m.lookAt(new THREE.Vector3(), this.wander(dir.clone().normalize(), wander), UP);
    this._q.setFromRotationMatrix(this._m);
    this.game.rig.aimQ.slerp(this._q, 1 - Math.exp(-dt * rate));
  }

  private dirFrom(heading: number, pitch: number): THREE.Vector3 {
    return this.aim.set(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), Math.cos(heading) * Math.cos(pitch));
  }

  /** Pitch that flies toward a height over whatever is under (and ahead of) the suit. */
  private holdAlt(target: number, k = 1 / 140, lo = -0.35, hi = 0.3, damp = 0.004): number {
    const g = this.game;
    const m = g.model;
    let floor = Math.max(0, g.ground.surface(m.pos.x, m.pos.z));
    for (const s of [1, 2, 3]) {
      const x = m.pos.x + m.vel.x * s;
      const z = m.pos.z + m.vel.z * s;
      floor = Math.max(floor, g.ground.surface(x, z));
    }
    return THREE.MathUtils.clamp((floor + target - m.pos.y) * k - m.vel.y * damp, lo, hi);
  }

  /** Throttle toward an airspeed. */
  private pace(c: Controls, speed: number): void {
    const cmd = this.game.model.speedCmd;
    c.throttle = THREE.MathUtils.clamp((speed - cmd) / 20, -1, 1);
  }

  /** Point at a part, leading it, from the head (where the shots are aimed from). */
  private aimAt(p: ShipPart, dt: number, rate: number): number {
    const g = this.game;
    const lead = p.pos.clone().addScaledVector(this.ship.vel, p.pos.distanceTo(g.head) / 900);
    const to = lead.sub(g.head);
    const d = to.length();
    this.steer(to, dt, rate, 0.6);
    return d;
  }

  /** Seekers closing on the suit: a fan of flares inside 900 m. */
  private defend(c: Controls): void {
    const g = this.game;
    const close = g.combat.missiles.threats().some((x) => x.pos.distanceTo(g.model.pos) < 900);
    if (close && this.t - this.flaredAt > 2.6) this.flaredAt = this.t;
    c.flares = this.t - this.flaredAt < 0.15;
  }

  /** What the next run goes for: the radar, then the guns, then the cells. */
  private pick(): ShipPart | null {
    const f = this.ship;
    if (f.radar.alive) return f.radar;
    const guns = f.parts.filter((p) => p.alive && p.role === 'ciws');
    if (guns.length) {
      const m = this.game.model;
      return guns.reduce((a, b) => (a.pos.distanceTo(m.pos) < b.pos.distanceTo(m.pos) ? a : b));
    }
    if (f.vls.alive) return f.vls;
    return null;
  }

  update(dt: number, c: Controls): void {
    this.t += dt;
    this.phaseT += dt;
    const g = this.game;
    const m = g.model;
    const f = this.ship;
    c.aimYaw = c.aimPitch = 0;
    c.throttle = c.lateral = c.vertical = c.forward = 0;
    c.fire = c.missile = c.unibeam = c.flares = c.launcher = c.boost = c.brake = false;
    c.pressed.clear();
    this.hud = this.phase === 'title' || this.phase === 'done' || g.rig.mode === 'flyby' ? 0 : 1;
    if (this.phase !== 'title' && this.phase !== 'takeoff') this.defend(c);
    const shipDist = this.flatDist(f.pos);

    switch (this.phase) {
      case 'title':
        if (this.phaseT > 3) this.go('takeoff');
        break;
      case 'takeoff':
        c.vertical = this.phaseT < 1.2 ? 1 : 0.2;
        if (this.phaseT > 1.0) c.throttle = 1;
        this.steer(this.dirFrom(this.heading, -0.05), dt);
        if (this.phaseT > 2.6) this.go('dash');
        break;
      case 'dash': {
        // Down off the bluff onto the water and the boost down the coast,
        // through the sound barrier
        this.heading = this.bearing(f.pos);
        c.throttle = 1;
        const boomed = this.boomAt > 0;
        c.boost = this.phaseT > 1.2 && shipDist > 2300 && (!boomed || this.t - this.boomAt < 1.2);
        this.steer(this.dirFrom(this.heading, this.holdAlt(c.boost ? 14 : 20, 1 / 70, -0.16, 0.2, 0.012)), dt, 3);
        if (boomed && this.t - this.boomAt > 2.4) this.release();
        if ((shipDist < 2300 || (boomed && this.t - this.boomAt > 2.4)) && this.phaseT > 3) this.go('skim');
        break;
      }
      case 'skim':
        // Under the gun radar's sea clutter, right on the waves
        this.heading = this.bearing(f.pos);
        this.pace(c, 240);
        this.steer(this.dirFrom(this.heading, this.holdAlt(9, 1 / 30, -0.07, 0.1, 0.03)), dt, 4, 0.4);
        if (shipDist < 2100) this.go('popup');
        break;
      case 'popup': {
        // Pull up hard off the water, nose over, paint the whole ship and
        // ripple the rockets off
        this.pace(c, 190);
        if (this.phaseT < 0.1) this.climbing = true;
        if (this.climbing && (m.pos.y > 100 || this.phaseT > 3)) {
          this.climbing = false;
          this.paintAt = this.t;
        }
        if (this.climbing) this.steer(this.dirFrom(this.bearing(f.pos), 0.38), dt, 3.5, 0.5);
        else this.aimAt(f.radar, dt, 4);
        const painting = !this.climbing && this.t - this.paintAt > 0.5;
        const painted = g.combat.weapons.locks.length >= f.parts.filter((x) => x.alive).length;
        c.missile = painting && !painted && this.t - this.paintAt < 3;
        if (painting && !c.missile) this.go('dive');
        break;
      }
      case 'dive': {
        // Rolled in on the mast, the palms on it
        this.pace(c, 160);
        const d = this.aimAt(f.radar.alive ? f.radar : this.pick() ?? f.hull, dt, this.phaseT < 0.6 ? 3 : 7);
        c.fire = d < 1300 && this.phaseT > 0.5;
        if (shipDist < 280 || d < 260 || this.phaseT > 7) {
          this.runs++;
          this.go('extend');
        }
        break;
      }
      case 'extend': {
        // Over the ship and out the far side, climbing, then the turn back in
        this.pace(c, 200);
        if (this.phaseT > 2.4) this.release();
        if (this.phaseT < 0.1) this.heading = Math.atan2(m.vel.x, m.vel.z);
        const back = this.phaseT > 1.6 || shipDist > 1000;
        const want = back ? this.bearing(f.pos) : this.heading;
        if (back) {
          // Ease round: the heading swings toward the ship a bit at a time
          const dh = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
          this.heading += THREE.MathUtils.clamp(dh, -1.4 * dt, 1.4 * dt);
        }
        this.steer(this.dirFrom(this.heading, this.holdAlt(shipDist > 500 ? 55 : 70, 1 / 80, -0.15, 0.3, 0.01)), dt, 3);
        const facing = Math.abs(Math.atan2(Math.sin(this.bearing(f.pos) - this.heading), Math.cos(this.bearing(f.pos) - this.heading))) < 0.25;
        if (back && facing && shipDist > 600) {
          this.target = this.pick();
          this.go(this.target ? 'run' : 'beam');
        }
        if (this.phaseT > 12) this.go(this.pick() ? 'run' : 'beam');
        break;
      }
      case 'run': {
        // In on the part, guns on it inside 1.3 km; rockets onto what's left
        this.pace(c, 150);
        let p = this.target;
        if (!p || !p.alive) p = this.target = this.pick();
        if (!p) {
          this.go('beam');
          break;
        }
        const d = this.aimAt(p, dt, 6);
        c.fire = d < 1300 && this.phaseT > 0.4;
        // The VLS sits down in the hull (the palms hit the plating): the
        // forearm launchers for it, a press per round, and a fresh ripple
        if (p === f.vls && this.presses === 0 && this.phaseT < 0.2) this.presses = 2;
        if (this.presses > 0 && d < 2200 && this.t - this.pressAt > 1.4) {
          this.pressAt = this.t;
          this.presses--;
        }
        c.launcher = this.t - this.pressAt < 0.55;
        if (p === f.vls && this.t - this.salvoAt > 6 && d < 1500 && d > 700) this.salvoAt = this.t;
        c.missile = this.t - this.salvoAt < 0.4;
        c.fire = c.fire && !c.launcher;
        if (d < 300 || shipDist < 220) {
          this.runs++;
          this.go('extend');
        }
        if (this.phaseT > 9) {
          this.runs++;
          this.go('extend');
        }
        break;
      }
      case 'beam': {
        // Disarmed: off her beam in a hover, the unibeam into the hull
        const to = f.hull.pos.clone().sub(m.pos);
        const flat = Math.hypot(to.x, to.z);
        c.brake = flat < 700;
        if (!c.brake) this.pace(c, 120);
        this.steer(to.clone().normalize(), dt, 5, 0.5);
        const fwd = m.forward(new THREE.Vector3()).setY(0).normalize();
        c.forward = THREE.MathUtils.clamp((flat - 300) / 80, -1, 1);
        c.lateral = 0.35 * this.orbit;
        c.vertical = THREE.MathUtils.clamp((f.hull.pos.y + 24 - m.pos.y) / 12, -1, 1);
        void fwd;
        const W = g.combat.weapons;
        if (flat < 650) {
          // The beam while it runs cool, the palms and the launchers between
          // Held until it overheats and vents; the palms while it cools
          c.unibeam = !W.unibeamOverheat && this.phaseT > 1.5;
          c.fire = !W.unibeamOn && !c.unibeam;
          if (this.t - this.pressAt > 3) this.pressAt = this.t;
          c.launcher = !W.unibeamOn && this.t - this.pressAt < 0.55;
        }
        if (f.sinking) this.go('sink');
        if (this.phaseT > 30) this.go('sink');
        break;
      }
      case 'sink': {
        // Holding off her as she goes: a long lens behind the suit, the
        // burning ship filling the frame beyond it, then round the suit
        const to = f.hull.pos.clone().sub(m.pos);
        const flat = Math.hypot(to.x, to.z);
        c.brake = true;
        this.steer(to.setY(0).normalize(), dt, 2, 0.3);
        c.forward = THREE.MathUtils.clamp((flat - 170) / 60, -1, 1);
        c.vertical = THREE.MathUtils.clamp((22 - m.pos.y) / 8, -1, 1);
        if (!this.cutSink && this.phaseT > 1.8) {
          this.cutSink = true;
          this.plantBehind(34, 7, -2, 0.2);
          this.cut('sink');
        }
        if (this.sinkCam === 0 && this.phaseT > 8.5) {
          this.sinkCam = 1;
          g.rig.plant(null);
          g.rig.mode = 'attract';
          this.cut('orbit');
        }
        if (this.phaseT > 12.5) this.go('done');
        break;
      }
      case 'done':
        c.brake = true;
        this.tail += dt;
        break;
    }
  }
}
