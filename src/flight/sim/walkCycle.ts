import * as THREE from 'three';
import type { LimbOffsets } from '../../suit/rigPose';
import { boneSpec } from '../../suit/rig';

/**
 * The suit on foot: a procedural gait for walking, sidestepping and turning
 * in place, with feet that are really planted.
 *
 * Each boot is a world-space contact. A stance boot stays exactly where it
 * came down while the body walks over it (the legs are solved onto it by
 * IK every frame, so it can't slide); a swing boot lifts off, arcs and lands
 * where the body will be half a stance later (Raibert placement), so the
 * stride always matches the speed. The rhythm is one cycle clock — the left
 * boot swings in its first part, the right half a cycle later — that runs
 * while the suit moves, turns, or still has a boot out of place, and stops
 * on both feet. It's a heavy suit's gait, not a catwalk: the boots stand
 * shoulder-wide and track apart (narrowing only a little on the move), the
 * hips barely roll, and the weight drives the stride. The pelvis rides an
 * inverted pendulum: it sits as low as the furthest stance boot needs
 * (that's the bob), dips on each heavy footfall and turns a little with the
 * stride while the shoulders carry the counter-turn. The arms hang off the
 * armour with loose fists and swing straight fore and aft against the legs
 * a beat behind them, and the body leans a little into the speed. Each boot
 * lands heel first and rolls flat.
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
/** Shortest hip → ankle a leg is folded to (m): any closer and the knee folds past the thigh. */
const FOLD = 0.5;
/** Toe → ankle (bind): the heel rises about the toe on push-off. */
const TOE_TO_ANKLE = new THREE.Vector3(0, ANKLE.y - 0.02, ANKLE.z - TOE.z);

/** Upper-arm twist on foot (rad): rolls the elbow in so it bends fore and aft, not out (the forearms would flare) */
const ARM_TWIST = -0.5;

/** Most a boot steps up or down from the ground under the body (m). */
const FOOT_STEP = 0.85;
/** Walking speeds (m/s). */
export const WALK_SPEED = 1.5;
export const BACK_SPEED = 1.0;
export const STRAFE_SPEED = 1.15;

/** The rig root channels of a frame's pose (rigPose: lift m; pitch, roll, yaw rad). */
export interface RootPose {
  lift: number;
  pitch: number;
  roll: number;
  yaw: number;
  /** Shoulders turned against the hips (spine yaw, rad): written by the gait. */
  twist?: number;
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
const _d = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

/**
 * How far each boot stands out past the bind-pose ankle (m): planted wide
 * at rest, a touch in on the move (the boots still track apart).
 */
const TRACK_STAND = 0.06;
const TRACK_WALK = 0.035;

/** Furthest a boot is kept from its rest spot when planted out of a landing (m). */
const PLANT_REACH = 0.32;

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

/**
 * Keep a boot target off wall tops and out of drops: if the ground there is
 * more than a step from the ground under the body, pull it back toward its
 * rest spot, then (hugging a wall, the rest spot can be on it) in under the
 * body itself, which is always good footing.
 */
function footing(to: THREE.Vector3, pos: THREE.Vector3, heading: number, side: number, track: number, ground: GroundSurface): void {
  const base = ground.surface(pos.x, pos.z);
  if (Math.abs(to.y - base) <= FOOT_STEP) return;
  const rest = rotY(restOffset(side, track, _a), heading, _b).add(_c.set(pos.x, 0, pos.z));
  const from = _a.copy(to);
  for (const goal of [rest, _c.set(pos.x, 0, pos.z).addScaledVector(rotY(_d.set(side, 0, 0), heading, _d), 0.04)]) {
    for (let k = 1; k <= 8; k++) {
      to.lerpVectors(from, goal, k / 8);
      to.y = ground.surface(to.x, to.z);
      if (Math.abs(to.y - base) <= FOOT_STEP) return;
    }
    from.copy(goal);
  }
  to.y = base;
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
  /** Share of the walk in the pose: 1 on the ground, 0 in the air. */
  weight = 0;
  /** Boots on the ground (false: flying, the legs are the driver's). */
  attached = false;
  /** Swing share of the cycle. */
  readonly swingFrac = 0.4;
  /** Boots' stance width past the bind ankle (m): wide at rest, narrower on the move. */
  track = TRACK_STAND;
  /** Pelvis bob spring (m) and its velocity. */
  private bob = 0;
  private bobVel = 0;
  /** Forward lean (rad), sprung. */
  private lean = 0;
  /** Is the cycle clock ticking (it stops on both feet)? */
  private ticking = false;
  /** Lowest pelvis lift that leaves every leg room to fold (m), from the last reach check. */
  private foldLift = -Infinity;
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
      rotY(restOffset(f.side, this.track, _a), heading, f.pos).add(_b.set(pos.x, 0, pos.z));
      f.pos.y = ground.surface(f.pos.x, f.pos.z);
      footing(f.pos, pos, heading, f.side, this.track, ground);
      f.yaw = heading;
      f.swinging = false;
      f.heel = 0;
    }
    this.bob = Math.min(this.bob, 0);
  }

  /**
   * Put a boot down about where it already is (world point under the
   * ankle): coming up out of a landing the legs stand from the stagger they
   * took it in. Kept within a short step of its rest spot and on its own
   * side of the body, so the rise is a stance, not a split or a cross.
   */
  plant(i: 0 | 1, at: THREE.Vector3, heading: number, ground: GroundSurface): void {
    const f = this.feet[i];
    // Body frame offset from the rest spot
    const rest = restOffset(f.side, this.track, _a);
    const d = rotY(_b.set(at.x - this.pos.x, 0, at.z - this.pos.z), -heading, _b).sub(rest);
    d.y = 0;
    if (d.length() > PLANT_REACH) d.setLength(PLANT_REACH);
    d.x = f.side * Math.max(f.side * d.x, -0.02);
    rotY(d.add(rest), heading, _c).add(_d.set(this.pos.x, 0, this.pos.z));
    f.pos.set(_c.x, ground.surface(_c.x, _c.z), _c.z);
    f.yaw = heading;
    f.swinging = false;
    f.heel = 0;
  }

  /** Leave the ground: the boots keep their place on the body and the flight pose takes over. */
  detach(pos: THREE.Vector3, q: THREE.Quaternion): void {
    if (!this.attached) return;
    this.attached = false;
    for (const f of this.feet) this.ankleRig(f, pos, q, { ...ZERO_ROOT, lift: this.bob }, f.local);
  }

  /**
   * One physics step on the ground. Returns the strength of a boot strike
   * this step (0 = none): ~0.3 settling, ~0.5 walking.
   */
  step(dt: number, pos: THREE.Vector3, heading: number, vel: THREE.Vector3, omega: number, crouch: number, ground: GroundSurface): number {
    this.pos.copy(pos);
    this.heading = heading;
    this.vel.copy(vel);
    const wGoal = this.attached && crouch <= 0 ? 1 : 0;
    this.weight += (wGoal - this.weight) * approach(dt, wGoal > this.weight ? 0.18 : 0.1);
    if (!this.attached) return 0;

    const speed = Math.hypot(vel.x, vel.z);
    const trackGoal = lerp(TRACK_STAND, TRACK_WALK, smooth(0.1, 0.8, speed));
    this.track += (trackGoal - this.track) * approach(dt, 0.3);
    // Stride (one step) grows with speed; shorter sideways (the legs would cross)
    const fwdBody = Math.sin(heading) * vel.x + Math.cos(heading) * vel.z;
    const side = speed > 1e-3 ? Math.abs(Math.cos(heading) * vel.x - Math.sin(heading) * vel.z) / speed : 0;
    void fwdBody;
    const stepLen = Math.min(0.85, 0.3 + 0.2 * speed) * (1 - 0.45 * side);
    const moving = speed > 0.12;
    const turning = Math.abs(omega) > 0.35;
    // How far out of place a planted boot is (distance + twist)
    let need = 0;
    for (const f of this.feet) {
      if (f.swinging) continue;
      rotY(restOffset(f.side, this.track, _a), heading, _b).add(_c.set(pos.x, 0, pos.z));
      const off = Math.hypot(f.pos.x - _b.x, f.pos.z - _b.z) + 0.3 * Math.abs(wrap(f.yaw - heading));
      need = Math.max(need, off);
    }
    const anySwing = this.feet[0].swinging || this.feet[1].swinging;
    const run = moving || turning || need > 0.07 || anySwing;
    this.active += ((moving || turning ? 1 : 0) - this.active) * approach(dt, 0.3);
    if (!run || crouch > 0) {
      this.ticking = false;
      this.updateBody(dt, 0);
      return 0;
    }
    if (!this.ticking) {
      // Starting off: the next boot lifts now, not up to half a cycle later
      // with the body already walking away from both planted boots
      this.ticking = true;
      this.phase = (this.phase < 0.5 ? 0.5 : 1) - 1e-6;
    }
    // Cadence (cycles/s): the stride matches the speed; turning and
    // settling steps at an easy pace
    const cadence = Math.max(moving ? clamp(speed / (2 * stepLen), 0.85, 2.9) : 1.05, 0.8 + Math.abs(omega) * 0.3);
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
        rotY(restOffset(f.side, this.track, _a), heading, _b).add(_c.set(pos.x, 0, pos.z));
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
        rotY(restOffset(f.side, this.track, _a), yawTo, f.to).add(_b.set(pos.x, 0, pos.z));
        f.to.addScaledVector(_c.set(vel.x, 0, vel.z), remain + (moving ? stance * 0.5 : 0));
        f.to.y = ground.surface(f.to.x, f.to.z);
        // Never onto a wall top or out over a drop the body isn't on: pull
        // the boot back toward its rest spot until the ground there is
        // within a step of the ground under the body
        footing(f.to, pos, heading, f.side, this.track, ground);
        f.toYaw = yawTo;
        if (!inWindow || f.t >= 1) {
          // Boot down
          f.swinging = false;
          f.pos.copy(f.to);
          f.yaw = f.toYaw;
          // Heel first: the toes are still up and roll down onto the ground
          f.heel = moving ? -0.16 : 0;
          const k = Math.hypot(f.to.x - f.from.x, f.to.z - f.from.z);
          const s = moving ? 0.5 : 0.3;
          strike = Math.max(strike, s * clamp(0.4 + k * 1.2, 0.4, 1));
          this.strikes++;
          // The weight drops into the knees
          this.bobVel -= 0.12 * (moving ? 1 : 0.4);
        } else {
          // In the air: the heel's pushed-off angle eases back flat
          f.heel *= 1 - approach(dt, 0.08);
        }
      } else {
        // Push-off: the trailing boot peels up onto its toe late in stance
        const other = this.feet[f.side === 1 ? 1 : 0];
        rotY(_a.copy(f.pos).sub(_b.set(pos.x, f.pos.y, pos.z)), -heading, _a);
        const behind = -_a.z - 0.05;
        const goal = moving && other.swinging ? clamp(behind / 0.35, 0, 1) * 0.3 * smooth(0.0, 0.6, other.t) : 0;
        // (a heel-strike's toes-up rolls down a little slower than a push-off rises)
        f.heel += (goal - f.heel) * approach(dt, f.heel < 0 ? 0.07 : 0.05);
      }
    }
    this.updateBody(dt, strike);
    return strike;
  }

  /** Pelvis bob, lean and sway springs. */
  private updateBody(dt: number, strike: number): void {
    void strike;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // (a soft knee even standing: the suit's weight is carried, not locked out)
    const base = -lerp(0.035, 0.06, this.active);
    const goal = Math.max(Math.min(base, this.reachLift(this.pos, null, { ...ZERO_ROOT, pitch: this.lean }) - 0.002), this.foldLift);
    const w = 14;
    this.bobVel += (w * w * (goal - this.bob) - 2 * 0.75 * w * this.bobVel) * dt;
    this.bob += this.bobVel * dt;
    // Forward lean with speed, and more into an acceleration
    const acc = (Math.hypot(this.vel.x, this.vel.z) - Math.hypot(this.prevVel.x, this.prevVel.z)) / Math.max(dt, 1e-4);
    this.prevVel.copy(this.vel);
    const leanGoal = clamp(0.015 * speed + 0.015 * clamp(acc, -3, 3), -0.05, 0.24);
    this.lean += (leanGoal - this.lean) * approach(dt, 0.25);
  }

  /**
   * Highest pelvis lift (m, ≤ 0 usually) at which every stance boot is
   * still within reach — the inverted pendulum's height. Also notes the
   * lowest lift that keeps every boot (stance or swing) at least a folded
   * leg's length below the hip (`foldLift`): over a step the pelvis rides
   * up rather than crushing the leg on the higher boot into a pretzel.
   */
  private reachLift(pos: THREE.Vector3, q: THREE.Quaternion | null, root: RootPose): number {
    let lift = 0.05;
    let fold = -Infinity;
    const quat = q ?? this._qh.setFromAxisAngle(_Y, this.heading);
    const a = this._ank;
    for (const f of this.feet) {
      // Ankle in the body frame at zero lift / tilt
      this.ankleRig(f, pos, quat, { ...root, lift: 0 }, a);
      const dx = a.x - f.side * HIP.x;
      const dz = a.z - HIP.z;
      const flat = dx * dx + dz * dz;
      fold = Math.max(fold, Math.sqrt(Math.max(0, FOLD * FOLD - flat)) - (HIP.y - a.y));
      if (f.swinging && f.t > 0.02) continue;
      const reach = LEG_MAX * REACH;
      const vert = Math.sqrt(Math.max(0.05, reach * reach - flat));
      lift = Math.min(lift, vert - (HIP.y - a.y));
    }
    this.foldLift = fold;
    return lift;
  }

  /**
   * Ground height the body rides at (world y): between the boots, so it
   * climbs onto a step as the weight goes onto the boot up there instead
   * of when the hips pass over the edge.
   */
  support(): number {
    let y = 0;
    for (const f of this.feet) {
      y += f.swinging ? lerp(f.from.y, f.to.y, f.t) : f.pos.y;
    }
    return y / 2;
  }

  /** A boot's ankle target in the rig frame for a body pose and root offsets. */
  private ankleRig(f: Foot, pos: THREE.Vector3, q: THREE.Quaternion, root: RootPose, out: THREE.Vector3): THREE.Vector3 {
    // Ground point of the boot this frame (in the air on a swing arc)
    const p = this._p;
    let heel = f.heel;
    if (f.swinging) {
      const s = f.t * f.t * (3 - 2 * f.t);
      p.lerpVectors(f.from, f.to, s);
      // Up a step the boot rises early and clears the edge before it comes
      // over it; down one it carries out level past the edge and drops late
      const rise = f.to.y - f.from.y;
      const clear = (0.07 + 0.15 * Math.abs(rise)) * Math.sin(Math.PI * Math.pow(f.t, 0.8));
      p.y = f.from.y + rise * (rise > 0 ? smooth(0, 0.55, f.t) : smooth(0.45, 1, f.t)) + clear;
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
   * are the body's as drawn this frame. `armsFree` (left, right; 0–1) is
   * how much of each arm the walk may have: an arm raised on a shot keeps
   * its line (the swing and the elbow roll laid on top bent it back across
   * the chest).
   */
  pose(pos: THREE.Vector3, q: THREE.Quaternion, limbs: Required<LimbOffsets>, root: RootPose = ZERO_ROOT, armsFree: readonly [number, number] = [1, 1]): RootPose {
    const w = this.weight;
    if (w <= 1e-3) return root;
    const sf = this.swingFrac;
    // Sway over the stance boot (the left boot swings around phase sf/2)
    const c = Math.cos(2 * Math.PI * (this.phase - sf / 2)) * this.active;
    // Stride: +1 with the left boot furthest forward (end of its swing), −1
    // with the right
    const stride = Math.cos(2 * Math.PI * (this.phase - sf)) * this.active;
    const out: RootPose = {
      lift: root.lift,
      pitch: root.pitch + this.lean * w,
      // (only a little: a hip that rolls over each step reads as a sashay)
      roll: root.roll + 0.014 * c * w,
      // The pelvis turns a little with the forward leg …
      yaw: root.yaw - 0.04 * stride * w,
      // … and the shoulders drive the other way, well past it
      twist: 0.1 * stride * w,
    };
    // Never ask a stance leg for more than it has
    const walkLift = this.attached ? Math.max(Math.min(this.bob, this.reachLift(pos, q, out)), this.foldLift) : this.bob;
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
    void zRel;
    // Arms: hanging off the armour, swung straight fore and aft against the
    // legs (left arm forward with the right boot) from the shoulder like
    // pendulums — a beat behind the legs, so they reverse soft instead of
    // on the footfall
    const armPh = 2 * Math.PI * (this.phase - sf - 0.07);
    const swingA = 0.22 * this.active;
    const swL = Math.cos(armPh) * swingA;
    const swR = -swL;
    const wL = w * armsFree[0];
    const wR = w * armsFree[1];
    limbs.armFlexL += swL * wL;
    limbs.armFlexR += swR * wR;
    const elbow = 0.22 + 0.06 * this.active;
    limbs.elbowL += (elbow + 0.3 * Math.max(0, -swL)) * wL;
    limbs.elbowR += (elbow + 0.3 * Math.max(0, -swR)) * wR;
    // In from the flight pose's spread, but clear of the body: the suit's
    // arms ride out on the bulk of the armour
    limbs.armL += -0.15 * wL;
    limbs.armR += -0.15 * wR;
    limbs.armTwistL += ARM_TWIST * wL;
    limbs.armTwistR += ARM_TWIST * wR;
    return out;
  }

  /** World ankle points the gait wants this frame (tests / debug): planted boots don't move. */
  footWorld(i: 0 | 1, out = new THREE.Vector3()): THREE.Vector3 {
    const f = this.feet[i];
    return out.copy(f.swinging ? f.to : f.pos);
  }
}
