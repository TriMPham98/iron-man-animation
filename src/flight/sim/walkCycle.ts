import * as THREE from 'three';
import type { LimbOffsets } from '../../suit/rigPose';
import { boneSpec } from '../../suit/rig';

/**
 * The suit on foot: a procedural gait for walking, jogging and turning in
 * place, with feet that are really planted.
 *
 * Each boot is a world-space contact. A stance boot stays exactly where it
 * came down while the body walks over it (the legs are solved onto it by
 * IK every frame, so it can't slide); a swing boot lifts off, arcs and lands
 * where the body will be half a stance later (Raibert placement), so the
 * stride always matches the speed. The rhythm is one cycle clock — the left
 * boot swings in its first part, the right half a cycle later — that runs
 * while the suit moves, turns, or still has a boot out of place, and stops
 * on both feet. The pelvis rides an inverted pendulum: it sits as low as
 * the furthest stance boot needs (that's the bob), dips on each heavy
 * footfall, and sways over the stance foot; the arms swing against the legs.
 *
 * Stepped at the physics rate by the flight model (which turns each boot
 * strike into a footstep); posed at the render rate by the suit driver.
 */

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

/** Centre of mass in bind space: the rig is carried (and tilts) about it. */
export const COM = new THREE.Vector3(0, 1.0, 0);
/** Leg joints of the left leg in bind space (the right mirrors x). */
const HIP = new THREE.Vector3(...boneSpec('thigh.L').head);
const KNEE = new THREE.Vector3(...boneSpec('shin.L').head);
const ANKLE = new THREE.Vector3(...boneSpec('foot.L').head);
const TOE = new THREE.Vector3(...boneSpec('foot.L').tail);
/** Ankle height over the sole. */
export const ANKLE_H = ANKLE.y;
const THIGH = KNEE.clone().sub(HIP);
const SHIN = ANKLE.clone().sub(KNEE);
const LEG_MAX = THIGH.length() + SHIN.length();
/** Most of the leg's length a stance leg is allowed to use (never locks straight). */
const REACH = 0.975;
/** Toe → ankle (bind): the heel rises about the toe on push-off. */
const TOE_TO_ANKLE = new THREE.Vector3(0, ANKLE.y - 0.02, ANKLE.z - TOE.z);

/** Walking speeds (m/s). */
export const WALK_SPEED = 1.5;
export const RUN_SPEED = 3.8;
export const BACK_SPEED = 1.0;
export const STRAFE_SPEED = 1.15;
export const STRAFE_RUN = 2.0;

/** The rig root channels of a frame's pose (rigPose: lift m; pitch, roll, yaw rad). */
export interface RootPose {
  lift: number;
  pitch: number;
  roll: number;
  yaw: number;
}
const ZERO_ROOT: RootPose = { lift: 0, pitch: 0, roll: 0, yaw: 0 };

interface Foot {
  side: 1 | -1;
  /** World point on the ground under the ankle. */
  pos: THREE.Vector3;
  /** Heading the boot was planted at. */
  yaw: number;
  swinging: boolean;
  from: THREE.Vector3;
  fromYaw: number;
  /** Where it's going (re-aimed while in the air). */
  to: THREE.Vector3;
  toYaw: number;
  /** Swing progress 0–1. */
  t: number;
  /** Heel lift about the toe (rad, + = heel up). */
  heel: number;
  /** In the air (detached): ankle in body space. */
  local: THREE.Vector3;
}

export interface GroundSurface {
  surface(x: number, z: number): number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

/** Body-frame rest spot of a boot's ground point (x left, z forward). */
function restOffset(side: number, wide: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(side * (ANKLE.x + wide), 0, ANKLE.z);
}

/** World offset of a body-frame vector at a heading. */
function rotY(v: THREE.Vector3, heading: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return out.set(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

// ── Leg kinematics (the same composition rigPose.applyPose uses) ──────

export interface LegAngles {
  hip: number;
  hipOut: number;
  knee: number;
}

/** Ankle position (rig space) for leg angles: thigh Rx(−hip)·Rz(s·out), shin Rx(knee). */
const _fk = new THREE.Vector3();
export function legFK(side: number, a: LegAngles, out = new THREE.Vector3()): THREE.Vector3 {
  const shin = _fk.set(side * SHIN.x, SHIN.y, SHIN.z).applyAxisAngle(_X, a.knee);
  out.set(side * THIGH.x, THIGH.y, THIGH.z).add(shin);
  out.applyAxisAngle(_Z, side * a.hipOut).applyAxisAngle(_X, -a.hip);
  return out.add(_fk.set(side * HIP.x, HIP.y, HIP.z));
}

/** Angle of a vector swung forward from straight down (in the y-z plane). */
const swingAngle = (v: THREE.Vector3) => Math.atan2(v.z, -v.y);

/** Leg angles that put the ankle on `target` (rig space): analytic, then refined on the FK. */
export function legIK(side: number, target: THREE.Vector3, out: LegAngles = { hip: 0, hipOut: 0, knee: 0 }): LegAngles {
  const T = new THREE.Vector3(side * THIGH.x, THIGH.y, THIGH.z);
  const S = new THREE.Vector3(side * SHIN.x, SHIN.y, SHIN.z);
  const H = new THREE.Vector3(side * HIP.x, HIP.y, HIP.z);
  const P = T.y * S.y + T.z * S.z;
  const Q = -T.y * S.z + T.z * S.y;
  const R2 = Math.hypot(P, Q);
  const om = Math.atan2(Q, P);
  const goal = target.clone();
  const D = new THREE.Vector3();
  const C = new THREE.Vector3();
  const fk = new THREE.Vector3();
  for (let i = 0; i < 4; i++) {
    D.copy(goal).sub(H);
    // Knee from the length (no hyperextension, never fully straight)
    const len = Math.min(D.length(), LEG_MAX * 0.999);
    const want = (len * len - T.lengthSq() - S.lengthSq()) / 2 - T.x * S.x;
    const knee = Math.max(0, om + Math.acos(clamp(want / R2, -1, 1)));
    C.copy(S).applyAxisAngle(_X, knee).add(T);
    // Abduction: Rz carries the chain's sideways reach onto the target's
    const R = Math.hypot(C.x, C.y);
    const psi = Math.atan2(C.y, C.x);
    let th = Math.acos(clamp(D.x / R, -1, 1)) - psi;
    th = wrap(th);
    const th2 = wrap(-Math.acos(clamp(D.x / R, -1, 1)) - psi);
    if (Math.abs(th2) < Math.abs(th)) th = th2;
    const hipOut = clamp(side * th, -0.8, 0.9);
    C.applyAxisAngle(_Z, side * hipOut);
    // Flexion: Rx(−hip) swings the chain forward onto the target
    const hip = wrap(swingAngle(D) - swingAngle(C));
    out.hip = hip;
    out.hipOut = hipOut;
    out.knee = knee;
    // Refine: aim off by whatever the coupled axes missed
    legFK(side, out, fk);
    goal.add(fk.sub(target).negate());
  }
  return out;
}

// ── The gait ─────────────────────────────────────────────────────────

export class Gait {
  /** Cycle clock 0–1: left boot swings first, right half a cycle later. */
  phase = 0;
  /** Is the clock running (moving, turning or settling)? */
  active = 0;
  /** 0 walk … 1 jog (smoothed). */
  run = 0;
  /** Share of the walk in the pose: 1 on the ground, 0 in the air. */
  weight = 0;
  /** Boots on the ground (false: flying, the legs are the driver's). */
  attached = false;
  /** Swing share of the cycle (walk 0.4, jog 0.58: a little float). */
  swingFrac = 0.4;
  /** Pelvis bob spring (m) and its velocity. */
  private bob = 0;
  private bobVel = 0;
  /** Forward lean (rad), sprung. */
  private lean = 0;
  private readonly prevVel = new THREE.Vector3();
  readonly feet: [Foot, Foot] = [this.foot(1), this.foot(-1)];
  /** Footfalls so far (tests / debugging). */
  strikes = 0;
  /** Body state the gait was last stepped with. */
  private readonly pos = new THREE.Vector3();
  private heading = 0;
  private readonly vel = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _t1 = new THREE.Vector3();
  private readonly _t2 = new THREE.Vector3();
  private readonly _ank = new THREE.Vector3();
  private readonly _ank2 = new THREE.Vector3();
  private readonly _qa = new THREE.Quaternion();
  private readonly _qb = new THREE.Quaternion();
  private readonly _qh = new THREE.Quaternion();

  private foot(side: 1 | -1): Foot {
    return {
      side,
      pos: new THREE.Vector3(),
      yaw: 0,
      swinging: false,
      from: new THREE.Vector3(),
      fromYaw: 0,
      to: new THREE.Vector3(),
      toYaw: 0,
      t: 0,
      heel: 0,
      local: restOffset(side, 0, new THREE.Vector3()).setY(ANKLE.y),
    };
  }

  /** Put both boots down at their rest spots under the body. */
  attach(pos: THREE.Vector3, heading: number, ground: GroundSurface): void {
    this.attached = true;
    this.pos.copy(pos);
    this.heading = heading;
    for (const f of this.feet) {
      rotY(restOffset(f.side, 0, _a), heading, f.pos).add(_b.set(pos.x, 0, pos.z));
      f.pos.y = ground.surface(f.pos.x, f.pos.z);
      f.yaw = heading;
      f.swinging = false;
      f.heel = 0;
    }
    this.bob = Math.min(this.bob, 0);
  }

  /** Leave the ground: the boots keep their place on the body and the flight pose takes over. */
  detach(pos: THREE.Vector3, q: THREE.Quaternion): void {
    if (!this.attached) return;
    this.attached = false;
    for (const f of this.feet) this.ankleRig(f, pos, q, { ...ZERO_ROOT, lift: this.bob }, f.local);
  }

  /**
   * One physics step on the ground. Returns the strength of a boot strike
   * this step (0 = none): ~0.3 settling, ~0.5 walking, 1 jogging.
   */
  step(dt: number, pos: THREE.Vector3, heading: number, vel: THREE.Vector3, omega: number, crouch: number, ground: GroundSurface): number {
    this.pos.copy(pos);
    this.heading = heading;
    this.vel.copy(vel);
    const wGoal = this.attached && crouch <= 0 ? 1 : 0;
    this.weight += (wGoal - this.weight) * approach(dt, wGoal > this.weight ? 0.18 : 0.1);
    if (!this.attached) return 0;

    const speed = Math.hypot(vel.x, vel.z);
    this.run += (smooth(2.0, 3.3, speed) - this.run) * approach(dt, 0.25);
    this.swingFrac = lerp(0.4, 0.58, this.run);
    // Stride (one step) grows with speed; shorter sideways (the legs would cross)
    const fwdBody = Math.sin(heading) * vel.x + Math.cos(heading) * vel.z;
    const side = speed > 1e-3 ? Math.abs(Math.cos(heading) * vel.x - Math.sin(heading) * vel.z) / speed : 0;
    void fwdBody;
    const stepLen = Math.min(0.95, 0.3 + 0.2 * speed) * (1 - 0.45 * side);
    const moving = speed > 0.12;
    const turning = Math.abs(omega) > 0.35;
    // How far out of place a planted boot is (distance + twist)
    let need = 0;
    for (const f of this.feet) {
      if (f.swinging) continue;
      rotY(restOffset(f.side, 0, _a), heading, _b).add(_c.set(pos.x, 0, pos.z));
      const off = Math.hypot(f.pos.x - _b.x, f.pos.z - _b.z) + 0.3 * Math.abs(wrap(f.yaw - heading));
      need = Math.max(need, off);
    }
    const anySwing = this.feet[0].swinging || this.feet[1].swinging;
    const run = moving || turning || need > 0.07 || anySwing;
    this.active += ((moving || turning ? 1 : 0) - this.active) * approach(dt, 0.3);
    if (!run || crouch > 0) {
      this.updateBody(dt, 0);
      return 0;
    }
    // Cadence (cycles/s): the stride matches the speed; turning and
    // settling steps at an easy pace
    const cadence = Math.max(moving ? clamp(speed / (2 * stepLen), 0.85, 2.1) : 1.05, 0.8 + Math.abs(omega) * 0.3);
    const sf = this.swingFrac;
    const prev = this.phase;
    this.phase = (this.phase + cadence * dt) % 1;
    let strike = 0;
    for (const f of this.feet) {
      const start = f.side === 1 ? 0 : 0.5;
      const local = (this.phase - start + 1) % 1;
      const localPrev = (prev - start + 1) % 1;
      const inWindow = local < sf;
      if (!f.swinging && inWindow && localPrev > local) {
        // The window opened this step: lift off if this boot has anywhere to go
        rotY(restOffset(f.side, 0, _a), heading, _b).add(_c.set(pos.x, 0, pos.z));
        const off = Math.hypot(f.pos.x - _b.x, f.pos.z - _b.z) + 0.3 * Math.abs(wrap(f.yaw - heading));
        if (moving || turning || off > 0.04) {
          f.swinging = true;
          f.from.copy(f.pos);
          f.fromYaw = f.yaw;
          f.t = 0;
        }
      }
      if (f.swinging) {
        f.t = clamp(local / sf, f.t, 1);
        // Land where the hips will be half a stance after touchdown
        const remain = (1 - f.t) * (sf / cadence);
        const stance = (1 - sf) / cadence;
        const yawTo = heading + clamp(omega * remain, -0.6, 0.6);
        rotY(restOffset(f.side, 0, _a), yawTo, f.to).add(_b.set(pos.x, 0, pos.z));
        f.to.addScaledVector(_c.set(vel.x, 0, vel.z), remain + (moving ? stance * 0.5 : 0));
        f.to.y = ground.surface(f.to.x, f.to.z);
        f.toYaw = yawTo;
        if (!inWindow || f.t >= 1) {
          // Boot down
          f.swinging = false;
          f.pos.copy(f.to);
          f.yaw = f.toYaw;
          f.heel = 0;
          const k = Math.hypot(f.to.x - f.from.x, f.to.z - f.from.z);
          const s = moving ? lerp(0.5, 1, this.run) : 0.3;
          strike = Math.max(strike, s * clamp(0.4 + k * 1.2, 0.4, 1));
          this.strikes++;
          // The weight drops into the knees
          this.bobVel -= lerp(0.12, 0.3, this.run) * (moving ? 1 : 0.4);
        } else {
          // In the air: the heel's pushed-off angle eases back flat
          f.heel *= 1 - approach(dt, 0.08);
        }
      } else {
        // Push-off: the trailing boot peels up onto its toe late in stance
        const other = this.feet[f.side === 1 ? 1 : 0];
        rotY(_a.copy(f.pos).sub(_b.set(pos.x, f.pos.y, pos.z)), -heading, _a);
        const behind = -_a.z - 0.05;
        const goal = moving && other.swinging ? clamp(behind / 0.35, 0, 1) * lerp(0.3, 0.55, this.run) * smooth(0.0, 0.6, other.t) : 0;
        f.heel += (goal - f.heel) * approach(dt, 0.05);
      }
    }
    this.updateBody(dt, strike);
    return strike;
  }

  /** Pelvis bob, lean and sway springs. */
  private updateBody(dt: number, strike: number): void {
    void strike;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const base = -lerp(0.025, lerp(0.05, 0.1, this.run), this.active);
    const goal = Math.min(base, this.reachLift(this.pos, null, { ...ZERO_ROOT, pitch: this.lean }) - 0.002);
    const w = 14;
    this.bobVel += (w * w * (goal - this.bob) - 2 * 0.75 * w * this.bobVel) * dt;
    this.bob += this.bobVel * dt;
    // Forward lean with speed, more into an acceleration
    const acc = (Math.hypot(this.vel.x, this.vel.z) - Math.hypot(this.prevVel.x, this.prevVel.z)) / Math.max(dt, 1e-4);
    this.prevVel.copy(this.vel);
    const leanGoal = clamp(0.012 * speed + 0.025 * this.run + 0.01 * clamp(acc, -3, 3), -0.04, 0.14);
    this.lean += (leanGoal - this.lean) * approach(dt, 0.25);
  }

  /**
   * Highest pelvis lift (m, ≤ 0 usually) at which every stance boot is
   * still within reach — the inverted pendulum's height.
   */
  private reachLift(pos: THREE.Vector3, q: THREE.Quaternion | null, root: RootPose): number {
    let lift = 0.05;
    const quat = q ?? this._qh.setFromAxisAngle(_Y, this.heading);
    const a = this._ank;
    for (const f of this.feet) {
      if (f.swinging && f.t > 0.02) continue;
      // Ankle in the body frame at zero lift / tilt
      this.ankleRig(f, pos, quat, { ...root, lift: 0 }, a);
      const dx = a.x - f.side * HIP.x;
      const dz = a.z - HIP.z;
      const reach = LEG_MAX * REACH;
      const vert = Math.sqrt(Math.max(0.05, reach * reach - dx * dx - dz * dz));
      lift = Math.min(lift, vert - (HIP.y - a.y));
    }
    return lift;
  }

  /** A boot's ankle target in the rig frame for a body pose and root offsets. */
  private ankleRig(f: Foot, pos: THREE.Vector3, q: THREE.Quaternion, root: RootPose, out: THREE.Vector3): THREE.Vector3 {
    // Ground point of the boot this frame (in the air on a swing arc)
    const p = this._p;
    let heel = f.heel;
    if (f.swinging) {
      const s = f.t * f.t * (3 - 2 * f.t);
      p.lerpVectors(f.from, f.to, s);
      const clear = lerp(0.07, 0.15, this.run) * Math.sin(Math.PI * Math.pow(f.t, 0.8));
      p.y = lerp(f.from.y, f.to.y, s) + clear;
      heel = 0;
    } else {
      p.copy(f.pos);
    }
    // World ankle: over the ground point, or rolled up about the toe
    const yaw = f.swinging ? lerp(f.fromYaw, f.fromYaw + wrap(f.toYaw - f.fromYaw), f.t) : this.heading;
    if (heel > 1e-4) {
      // Toe stays put; the ankle swings up and forward about it
      const toe = this._t1.set(0, ANKLE.y - TOE_TO_ANKLE.y, TOE.z - ANKLE.z); // ground point → toe
      const v = this._t2.copy(TOE_TO_ANKLE).applyAxisAngle(_X, heel).add(toe);
      out.copy(rotY(v, yaw, toe)).add(p);
    } else {
      out.set(p.x, p.y + ANKLE.y, p.z);
    }
    // World → body (bind) frame
    out.sub(pos).applyQuaternion(this._qa.copy(q).invert()).add(COM);
    // Body → rig: undo the root's tilt about the centre of mass and its offsets
    // (applyPose: root = Ry(yaw)·Rx(pitch)·Rz(roll) about the centre of mass, lifted)
    const r = this._qa.setFromAxisAngle(_X, root.pitch).multiply(this._qb.setFromAxisAngle(_Z, root.roll));
    r.premultiply(this._qb.setFromAxisAngle(_Y, root.yaw));
    const at = this._t1.copy(COM).applyQuaternion(r);
    at.set(COM.x - at.x, root.lift + COM.y - at.y, COM.z - at.z);
    out.sub(at).applyQuaternion(r.invert());
    return out;
  }

  /**
   * Write the walk into the limb channels at the gait's weight — legs
   * solved onto the boots, arms swung on top — given the root channels the
   * rest of the body language chose (`root`: hip yaw toward a shot, …);
   * returns the root to draw with (bob, lean and sway added). `pos` / `q`
   * are the body's as drawn this frame.
   */
  pose(pos: THREE.Vector3, q: THREE.Quaternion, limbs: Required<LimbOffsets>, root: RootPose = ZERO_ROOT): RootPose {
    const w = this.weight;
    if (w <= 1e-3) return root;
    const sf = this.swingFrac;
    // Sway over the stance boot (the left boot swings around phase sf/2)
    const c = Math.cos(2 * Math.PI * (this.phase - sf / 2)) * this.active;
    const out: RootPose = {
      lift: root.lift,
      pitch: root.pitch + this.lean * w,
      roll: root.roll + 0.03 * c * (1 - 0.4 * this.run) * w,
      yaw: root.yaw,
    };
    // Never ask a stance leg for more than it has
    const walkLift = this.attached ? Math.min(this.bob, this.reachLift(pos, q, out)) : this.bob;
    out.lift = lerp(root.lift, walkLift, w);
    const ang: LegAngles = { hip: 0, hipOut: 0, knee: 0 };
    const zRel = [0, 0];
    for (const f of this.feet) {
      const a = this.attached ? this.ankleRig(f, pos, q, out, this._ank2) : this._ank2.copy(f.local);
      legIK(f.side, a, ang);
      const L = f.side === 1;
      // Sole flat to the ground (the rig's pitch tips it), heel up on push-off,
      // toes pointed leaving the ground and pulled up reaching for the strike
      const toes = f.swinging ? -0.18 * smooth(0.5, 0.95, f.t) + 0.25 * (1 - smooth(0, 0.4, f.t)) * this.active : f.heel;
      const ankle = toes - out.pitch;
      zRel[L ? 0 : 1] = a.z - ANKLE.z;
      if (L) {
        limbs.hipL = lerp(limbs.hipL, ang.hip, w);
        limbs.hipOutL = lerp(limbs.hipOutL, ang.hipOut, w);
        limbs.kneeL = lerp(limbs.kneeL, ang.knee, w);
        limbs.ankleL = lerp(limbs.ankleL, ankle, w);
        limbs.footRollL = lerp(limbs.footRollL, 0, w);
      } else {
        limbs.hipR = lerp(limbs.hipR, ang.hip, w);
        limbs.hipOutR = lerp(limbs.hipOutR, ang.hipOut, w);
        limbs.kneeR = lerp(limbs.kneeR, ang.knee, w);
        limbs.ankleR = lerp(limbs.ankleR, ankle, w);
        limbs.footRollR = lerp(limbs.footRollR, 0, w);
      }
    }
    // Arms swing against the legs (left arm forward with the right boot),
    // elbows fold as the pace picks up
    const swingK = lerp(0.22, 0.34, this.run) * w;
    limbs.armFlexL += clamp(zRel[0] / 0.4, -1.3, 1.3) * swingK;
    limbs.armFlexR += clamp(zRel[1] / 0.4, -1.3, 1.3) * swingK;
    const elbow = (0.12 + lerp(0.1, 0.75, this.run) * this.active) * w;
    limbs.elbowL += elbow;
    limbs.elbowR += elbow;
    limbs.armL += 0.04 * w;
    limbs.armR += 0.04 * w;
    return out;
  }

  /** World ankle points the gait wants this frame (tests / debug): planted boots don't move. */
  footWorld(i: 0 | 1, out = new THREE.Vector3()): THREE.Vector3 {
    const f = this.feet[i];
    return out.copy(f.swinging ? f.to : f.pos);
  }
}
