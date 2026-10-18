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

const UP = new THREE.Vector3(0, 1, 0);

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
  private fov = 62;
  private flybyAt = new THREE.Vector3();
  private flybyTimer = 0;
  private time = 0;
  private readonly _f = new THREE.Vector3();
  private readonly _u = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private initialized = false;
  /** A fixed camera (directed shots): stays put until released. */
  private planted: THREE.Vector3 | null = null;

  /** Hold the camera at a point, watching the suit (null releases it). */
  plant(at: THREE.Vector3 | null): void {
    this.planted = at ? at.clone() : null;
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
      if (!this.planted && (this.flybyTimer <= 0 || passed || rel.length() > 900)) {
        // Plant the next camera ahead of the path, off to one side
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
      lookAt = m.pos;
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
        this.initialized = true;
      }
      this.offset.lerp(ideal, 1 - Math.exp(-dt / 0.07));
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
  }
}
