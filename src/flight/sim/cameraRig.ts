import * as THREE from 'three';
import type { FlightModel } from './flightModel';
import { GRAVITY } from '../world/config';

/**
 * The pilot's eye. The mouse moves an aim frame freely (through loops and
 * over the top — it's rotated in its own frame, with a gentle pull back to
 * the horizon when it's not pointing straight up or down); the suit
 * steers itself onto it. Views: chase (it pulls back and widens with speed),
 * close shoulder, helmet (JARVIS's view), and a cinematic flyby that plants
 * a camera ahead of the suit's path and lets it streak past.
 */
export type CameraMode = 'chase' | 'shoulder' | 'helmet' | 'flyby' | 'attract';
export const CAMERA_MODES: CameraMode[] = ['chase', 'shoulder', 'helmet', 'flyby'];
/** The view a flight starts in: the close one, between chase and helmet. */
export const DEFAULT_CAMERA: CameraMode = 'shoulder';

const UP = new THREE.Vector3(0, 1, 0);
/** Kinds of cinematic set-up the flyby camera cuts between. */
type Shot = 'side' | 'low' | 'high' | 'close' | 'orbit';
/** The suit's length and breadth (m): side-on it reads its length, nose-on its shoulders. */
const SUIT_SIZE = 1.9;
const SUIT_BREADTH = 0.8;
/** The longest lens the operator has (vertical FOV, deg), and the widest. */
const FOV_TELE = 3;
const FOV_WIDE = 58;
const IDENTITY = new THREE.Quaternion();
/** Most the chase camera trails its ideal spot round the suit (rad). */
const MAX_SWING = 0.3;

export interface CameraGround {
  surface(x: number, z: number): number;
}

export class CameraRig {
  readonly aimQ = new THREE.Quaternion();
  mode: CameraMode = 'chase';
  /** Screen shake energy (decays). */
  shake = 0;
  zoom = 1;
  private readonly pos = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  /** Velocity of the chase offset (it swings on a spring, not a lerp). */
  private readonly offsetVel = new THREE.Vector3();
  /** Camera bank into the suit's yaw (rad), and its rate. */
  private bank = 0;
  private bankVel = 0;
  /** Chase distance the operator gives up to the suit's surge (m), and its rate. */
  private surgeLag = 0;
  private surgeLagVel = 0;
  /** Cinematic look target (smoothed suit position) and its velocity. */
  private readonly look = new THREE.Vector3();
  private readonly lookVel = new THREE.Vector3();
  private readonly _w2 = new THREE.Vector3();
  /** Next cinematic frame is a cut: start the pan clean, no smoothing across it. */
  private cut = true;
  private lastMode: CameraMode = 'chase';
  /** Natural frequency of the chase camera's swing (rad/s). */
  swing = 20;
  private fov = 62;
  private flybyAt = new THREE.Vector3();
  /** The shot being held: its kind, age, when the suit went by. */
  private shot: Shot = 'side';
  private shotAge = 0;
  private passedAt = -1;
  /** Hold this long after the pass before cutting (s, varies per shot). */
  private holdAfter = 2;
  /** Share of the frame's height the operator keeps the suit at. */
  private frac = 0.11;
  private needPlant = true;
  private time = 0;
  private readonly _f = new THREE.Vector3();
  private readonly _u = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _s = new THREE.Vector3();
  private initialized = false;
  /** A fixed camera (directed shots): stays put until released. */
  private planted: THREE.Vector3 | null = null;

  /** Hold the camera at a point, watching the suit (null releases it). */
  plant(at: THREE.Vector3 | null): void {
    this.planted = at ? at.clone() : null;
    this.cut = true;
    if (at) {
      this.mode = 'flyby';
      this.flybyAt.copy(at);
      this.frac = 0.1;
      this.passedAt = -1;
      this.shotAge = 0;
    } else {
      this.needPlant = true;
    }
  }

  /** The cinematic camera's current shot (debug, captures). */
  readonly shotInfo = { shot: 'side' as Shot, age: 0, passed: -1, frac: 0, dist: 0, fov: 50, cuts: 0 };

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Direction the pilot is aiming (world, unit). */
  aim(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.aimQ);
  }

  /** Face the aim along a heading (rad, 0 = +Z) and pitch. */
  lookHeading(heading: number, pitch = 0): void {
    this.aimQ.setFromEuler(new THREE.Euler(pitch, heading + Math.PI, 0, 'YXZ'));
  }

  turn(yaw: number, pitch: number): void {
    // Yaw about world up near level; about the aim's own up when steep
    const f = this.aim(this._f);
    const steep = Math.abs(f.y);
    const localUp = this._u.set(0, 1, 0).applyQuaternion(this.aimQ);
    const yawAxis = steep > 0.9 ? localUp : UP;
    this._q.setFromAxisAngle(yawAxis, yaw);
    this.aimQ.premultiply(this._q);
    const right = this._v.set(1, 0, 0).applyQuaternion(this.aimQ);
    this._q.setFromAxisAngle(right, pitch);
    this.aimQ.premultiply(this._q).normalize();
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.needPlant = true;
    return this.mode;
  }

  update(dt: number, m: FlightModel, head: THREE.Vector3, ground: CameraGround): void {
    this.time += dt;
    // Level the aim's roll back to the horizon (not when looking straight up/down)
    const f = this.aim(this._f);
    if (Math.abs(f.y) < 0.92) {
      const up = this._u.set(0, 1, 0).applyQuaternion(this.aimQ);
      const want = this._v.copy(UP).addScaledVector(f, -f.y).normalize();
      // Signed angle from up to want about f
      const ang = Math.atan2(this._w.crossVectors(up, want).dot(f), up.dot(want));
      this._q.setFromAxisAngle(f, ang * (1 - Math.exp(-dt / 0.35)));
      this.aimQ.premultiply(this._q).normalize();
    }

    const speed = m.speed;
    const cam = this.camera;
    const aimUp = this._u.set(0, 1, 0).applyQuaternion(this.aimQ);
    const fwd = this.aim(this._f);
    const ideal = this._w;
    let fovGoal = 62;
    let lookAt: THREE.Vector3 | null = null;

    if (this.mode === 'attract') {
      // Title: a slow turn round the suit standing on the bluff
      const a = this.time * 0.11 + 0.75;
      this.pos.set(m.pos.x + Math.sin(a) * 6.5, m.pos.y + 0.9 + 0.5 * Math.sin(this.time * 0.07), m.pos.z + Math.cos(a) * 6.5);
      // Frame the suit on the right third, the sea beyond it
      const side = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      lookAt = this._v.copy(m.pos).add(new THREE.Vector3(0, 0.45, 0)).addScaledVector(side, -1.5);
      fovGoal = 40;
    } else if (this.mode === 'helmet') {
      ideal.copy(head).addScaledVector(fwd, 0.22);
      this.pos.copy(ideal);
      fovGoal = 74;
    } else if (this.mode === 'flyby') {
      this.flybyFrame(dt, m, fwd, ground);
      lookAt = this.look;
      fovGoal = this.fov;
    } else {
      const close = this.mode === 'shoulder';
      const pull = Math.min(1, speed / 300);
      // The operator rides the surge a beat behind: a boost's kick pulls
      // the suit away down the lens, a hard bleed closes on it, and it
      // drifts back to station with a hair of overshoot
      const surgeG = THREE.MathUtils.clamp(m.surge / GRAVITY, -6, 7);
      const sw = 3.2;
      this.surgeLagVel += (sw * sw * (surgeG * 0.28 - this.surgeLag) - 2 * 0.7 * sw * this.surgeLagVel) * Math.min(dt, 0.05);
      this.surgeLag += this.surgeLagVel * Math.min(dt, 0.05);
      const dist = (close ? 3.2 : 7 + 4 * pull) * this.zoom + this.surgeLag * (close ? 0.35 : 1);
      const height = close ? 0.75 : 2.1 + 1.2 * pull;
      const side = close ? 0.85 : 0;
      const right = this._v.set(1, 0, 0).applyQuaternion(this.aimQ);
      // The offset from the suit is smoothed, not the position: the suit
      // holds its place in frame at any speed, swinging a little in turns
      ideal.set(0, 0, 0).addScaledVector(fwd, -dist).addScaledVector(aimUp, height).addScaledVector(right, side);
      if (!this.initialized) {
        this.offset.copy(ideal);
        this.offsetVel.set(0, 0, 0);
        this.initialized = true;
      }
      // A near-critically damped spring: a quick swing round in a hard turn
      // that eases in and out (no lock-step with the mouse), still well
      // under a quarter second to settle
      const w = this.swing;
      const n = Math.min(32, Math.max(1, Math.ceil(dt * w * 4)));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        const acc = this._s.copy(ideal).sub(this.offset).multiplyScalar(w * w).addScaledVector(this.offsetVel, -2 * 0.9 * w);
        this.offsetVel.addScaledVector(acc, h);
        this.offset.addScaledVector(this.offsetVel, h);
      }
      // Swing round the suit, never cut in across it: keep the distance
      const len = this.offset.length();
      if (len > 1e-3) this.offset.multiplyScalar(ideal.length() / len);
      // …and however hard the flick, never trail so far the suit leaves the frame
      const lag = this.offset.angleTo(ideal);
      if (lag > MAX_SWING) {
        this._q.setFromUnitVectors(this._s.copy(this.offset).normalize(), this._v.copy(ideal).normalize());
        this.offset.applyQuaternion(this._q.slerp(IDENTITY, MAX_SWING / lag));
      }
      this.pos.copy(m.pos).add(this.offset);
      // (and the lens punches wide on the kick, a touch tight on a bleed)
      fovGoal = 62 + 14 * pull + (m.boosting ? 3 : 0) + surgeG * (surgeG > 0 ? 1.1 : 0.4);
    }

    // Never under the ground or the sea
    const floor = Math.max(ground.surface(this.pos.x, this.pos.z), 0) + 0.8;
    if (this.pos.y < floor) this.pos.y = floor;

    cam.position.copy(this.pos);
    if (lookAt) {
      cam.up.copy(UP);
      cam.lookAt(lookAt.clone());
    } else {
      cam.quaternion.copy(this.aimQ);
      // The operator leans into the suit's turns a touch (lagging it on a
      // soft spring): the frame breathes with a pivot instead of staying
      // bolted to the horizon. Roll about the view axis only — the aim
      // point at the centre of the screen never moves
      const chase = this.mode === 'chase' || this.mode === 'shoulder';
      const bankGoal = chase ? THREE.MathUtils.clamp(m.omega.y * 0.022, -0.075, 0.075) : 0;
      const bw = 7;
      this.bankVel += (bw * bw * (bankGoal - this.bank) - 2 * 0.85 * bw * this.bankVel) * Math.min(dt, 0.05);
      this.bank += this.bankVel * Math.min(dt, 0.05);
      if (Math.abs(this.bank) > 1e-5) cam.quaternion.multiply(this._q.setFromAxisAngle(this._s.set(0, 0, 1), this.bank));
    }

    // Shake: impacts and boost. Supersonic flight itself does not shake the picture
    const s = this.shake + (m.boosting ? 0.04 : 0);
    if (s > 0.0005 && this.mode !== 'flyby') {
      const t = this.time;
      const n = (a: number, b: number) => Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.3) * 0.4;
      const amp = Math.min(0.06, s * 0.05);
      this._q.setFromEuler(new THREE.Euler(n(37, 53) * amp, n(41, 29) * amp, n(23, 47) * amp * 0.5));
      cam.quaternion.multiply(this._q);
    }
    this.shake *= Math.exp(-dt * 4);

    this.fov += (fovGoal - this.fov) * (1 - Math.exp(-dt / 0.4));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    // Who's listening: a camera standing off hears the suit from where it
    // stands (soundscape reads this)
    cam.userData.observer = this.mode === 'flyby' || this.mode === 'attract';
    this.lastMode = this.mode;
  }

  /**
   * The cinematic flyby: an operator on a long lens, planted ahead of the
   * suit's path, zooming to keep it a steady size in frame as it closes,
   * whipping round as it goes by, then holding while it tears away and
   * shrinks into the distance — only then a cut to the next set-up.
   */
  private flybyFrame(dt: number, m: FlightModel, fwd: THREE.Vector3, ground: CameraGround): void {
    const enter = this.lastMode !== 'flyby';
    this.shotAge += dt;
    const speed = m.speed;
    if (!this.planted) {
      if (enter) this.needPlant = true;
      const dist = this._v.copy(m.pos).sub(this.flybyAt).length();
      const closing = this._v.dot(m.vel) < 0;
      const hover = speed < 12;
      if (this.passedAt < 0 && !closing && !hover && this.shotAge > 0.15) this.passedAt = this.shotAge;
      const frac = this.apparentSize(m) / (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.fov) / 2));
      const since = this.passedAt < 0 ? 0 : this.shotAge - this.passedAt;
      // Let it go: hold while it tears away and shrinks, cut once it's a speck
      const gone = this.passedAt >= 0 && (since > this.holdAfter || (since > 1.2 && frac < 0.02));
      const stale = this.shotAge > (hover ? 6.5 : 9);
      if (this.needPlant || gone || stale) this.plantShot(m, fwd, ground);
    }
    this.pos.copy(this.flybyAt);
    // The operator pans after the suit on a critically damped head that
    // tracks its position and velocity: no lag on a steady pass, but no
    // physics-step or contact judder in the pan either. A cut starts clean
    const snap = this.cut || enter;
    if (snap) {
      this.look.copy(m.pos);
      this.lookVel.copy(m.vel);
    } else {
      const w = 14;
      const n = Math.min(16, Math.max(1, Math.ceil(dt * w * 4)));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        // Track the suit's motion (velocity feed-forward), spring onto
        // where it was at this sub-step of the frame
        const behind = dt - (i + 1) * h;
        const acc = this._s.copy(m.pos).addScaledVector(m.vel, -behind).sub(this.look).multiplyScalar(w * w);
        acc.add(this._w2.copy(m.vel).sub(this.lookVel).multiplyScalar(2 * w));
        this.lookVel.addScaledVector(acc, h);
        this.look.addScaledVector(this.lookVel, h);
      }
    }
    // Zoom: the lens that keeps the suit at `frac` of the frame. Judged a
    // beat ahead (the nearer of now and 0.35 s on), so on a fast close pass
    // the lens is already opening as it arrives; eased in log space (a
    // focal length change feels even that way), slower once it's gone by —
    // the operator lets it shrink away rather than chasing it to a dot
    const d = Math.max(1, Math.min(m.pos.distanceTo(this.pos), this._s.copy(m.pos).addScaledVector(m.vel, 0.35).distanceTo(this.pos)));
    const size = this.apparentSize(m);
    const passed = this.passedAt >= 0;
    const want = passed ? this.frac * 0.7 : this.frac;
    const tele = this.planted ? 12 : FOV_TELE;
    const goal = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(size / (2 * d * want))), tele, FOV_WIDE);
    if (snap) this.fov = goal;
    else {
      const tau = passed ? 0.45 : goal > this.fov ? 0.16 : 0.25;
      this.fov = Math.exp(Math.log(this.fov) + (Math.log(goal) - Math.log(this.fov)) * (1 - Math.exp(-dt / tau)));
    }
    this.cut = false;
    const info = this.shotInfo;
    info.shot = this.shot;
    info.age = this.shotAge;
    info.passed = this.passedAt;
    info.dist = m.pos.distanceTo(this.pos);
    info.fov = this.fov;
    info.frac = size / (2 * info.dist * Math.tan(THREE.MathUtils.degToRad(this.fov) / 2));
  }

  /** How big the flying suit reads from the camera (m): its length side-on, its shoulders nose- or tail-on. */
  private apparentSize(m: FlightModel): number {
    if (m.speed < 12) return SUIT_SIZE;
    const c = Math.abs(this._s.copy(m.pos).sub(this.pos).normalize().dot(this._v.copy(m.vel).normalize()));
    return Math.max(SUIT_BREADTH, SUIT_SIZE * Math.sqrt(1 - c * c) + SUIT_BREADTH * c);
  }

  /** Pick and place the next set-up ahead of the suit: a cut. */
  private plantShot(m: FlightModel, fwd: THREE.Vector3, ground: CameraGround): void {
    const speed = m.speed;
    const hover = speed < 12;
    const dir = this._f.copy(speed > 1 ? m.vel : fwd).normalize();
    const side = this._u.crossVectors(dir, UP);
    if (side.lengthSq() < 0.01) side.set(1, 0, 0);
    side.normalize();
    // Where the suit will be when the shot pays off: far enough out for an
    // approach on the long lens, not so far it's a speck
    const lead = THREE.MathUtils.clamp(240 / Math.max(speed, 20), 1.5, 4.5);
    const p = this._w2.copy(m.pos).addScaledVector(m.vel, hover ? 0 : lead);
    const floorAt = (x: number, z: number) => Math.max(ground.surface(x, z), 0);
    const agl = p.y - floorAt(p.x, p.z);
    const kinds: Shot[] = hover ? ['orbit'] : ['side', 'low', 'high', 'close', 'side', 'low'];
    const at = this.flybyAt;
    let kind: Shot = 'side';
    for (let tries = 0; tries < 6; tries++) {
      kind = kinds[Math.floor(Math.random() * kinds.length)];
      if (kind === this.shot && !hover && tries < 4) continue;
      const s = Math.random() < 0.5 ? -1 : 1;
      const r = Math.random();
      if (kind === 'orbit') {
        const a = Math.random() * Math.PI * 2;
        at.copy(m.pos).add(this._s.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(10 + 6 * r)).add(this._s.set(0, 1 + 3 * Math.random(), 0));
      } else if (kind === 'side') {
        at.copy(p).addScaledVector(side, s * (5 + Math.min(10, speed * 0.02))).addScaledVector(UP, -1.5 + 3.5 * r);
      } else if (kind === 'low') {
        if (agl < 60) {
          // On the deck, looking up as it goes over
          at.copy(p).addScaledVector(side, s * (3.5 + Math.min(8, speed * 0.015)));
          at.y = floorAt(at.x, at.z) + 1.2;
        } else {
          at.copy(p).addScaledVector(UP, -(9 + Math.min(15, speed * 0.03))).addScaledVector(side, s * (3 + 3 * r));
        }
      } else if (kind === 'high') {
        at.copy(p).addScaledVector(UP, 9 + Math.min(18, speed * 0.035)).addScaledVector(side, s * (3 + Math.min(6, speed * 0.01)));
      } else {
        // A near miss: it whips past an arm's length off the lens
        at.copy(p).addScaledVector(side, s * (2.8 + Math.min(4, speed * 0.008))).addScaledVector(UP, 0.3 + 0.9 * r);
      }
      at.y = Math.max(at.y, floorAt(at.x, at.z) + 1.2);
      // No set-up behind a ridge: the path and the suit must both be in sight
      if (this.clearView(at, p, ground) && this.clearView(at, m.pos, ground)) break;
    }
    this.shot = kind;
    this.shotAge = 0;
    this.passedAt = -1;
    this.holdAfter = 1.9 + Math.random() * 0.9;
    this.frac = hover ? 0.16 : kind === 'close' ? 0.14 : kind === 'high' ? 0.095 : 0.115;
    this.needPlant = false;
    this.cut = true;
    this.shotInfo.cuts++;
  }

  /** Nothing of the ground between two points (sampled). */
  private clearView(a: THREE.Vector3, b: THREE.Vector3, ground: CameraGround): boolean {
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (ground.surface(x, z) > a.y + (b.y - a.y) * t - 0.5) return false;
    }
    return true;
  }
}
