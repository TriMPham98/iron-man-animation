import * as THREE from 'three';
import type { FlightModel } from './flightModel';

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
  private flybyTimer = 0;
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
    }
  }

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
    this.flybyTimer = 0;
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
      this.flybyTimer -= dt;
      const rel = this._v.copy(m.pos).sub(this.flybyAt);
      const passed = rel.dot(m.vel) > 0 && rel.length() > 40;
      // Gone off into the distance? (Scaled with the lead: a fixed 900 m had
      // a camera planted 2.5 s ahead at boost speed replanting — at random
      // either side — every single frame)
      const far = Math.max(900, speed * Math.max(2.5, Math.min(5, 220 / Math.max(speed, 20))) * 1.6);
      if (!this.planted && (this.flybyTimer <= 0 || passed || rel.length() > far)) {
        // Plant the next camera ahead of the path, off to one side: a cut
        this.cut = true;
        const lead = Math.max(2.5, Math.min(5, 220 / Math.max(speed, 20)));
        const side = this._v.crossVectors(m.vel.lengthSq() > 1 ? m.vel : fwd, UP).normalize();
        if (side.lengthSq() < 0.5) side.set(1, 0, 0);
        this.flybyAt
          .copy(m.pos)
          .addScaledVector(m.vel, lead)
          .addScaledVector(side, (Math.random() < 0.5 ? -1 : 1) * (10 + speed * 0.06))
          .add(new THREE.Vector3(0, 3 + Math.random() * 6, 0));
        this.flybyAt.y = Math.max(this.flybyAt.y, ground.surface(this.flybyAt.x, this.flybyAt.z) + 2.5);
        this.flybyTimer = lead * 2.2 + 1.5;
      }
      this.pos.copy(this.flybyAt);
      // The operator pans after the suit on a critically damped head that
      // tracks its position and velocity: no lag on a steady pass, but no
      // physics-step or contact judder in the pan either. A cut starts clean
      if (this.cut || this.lastMode !== 'flyby') {
        this.look.copy(m.pos);
        this.lookVel.copy(m.vel);
        this.fov = 50;
        this.cut = false;
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
      lookAt = this.look;
      fovGoal = 50;
    } else {
      const close = this.mode === 'shoulder';
      const pull = Math.min(1, speed / 300);
      const dist = (close ? 3.2 : 7 + 4 * pull) * this.zoom;
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
      fovGoal = 62 + 14 * pull + (m.boosting ? 6 : 0);
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

    // Shake: impacts, boost, the air at speed
    const transonic = Math.exp(-Math.pow((m.mach - 1) / 0.06, 2));
    const s = this.shake + Math.max(0, speed - 150) / 1500 + (m.boosting ? 0.04 : 0) + transonic * 0.12;
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
    this.lastMode = this.mode;
  }
}
