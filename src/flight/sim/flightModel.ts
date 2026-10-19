import * as THREE from 'three';
import { GRAVITY, SPEED_OF_SOUND } from '../world/config';
import { BACK_SPEED, Gait, RUN_SPEED, STRAFE_RUN, STRAFE_SPEED, WALK_SPEED } from './walkCycle';

/**
 * Flight dynamics of the suit. A point mass with a body attitude: the boots
 * push along the suit's long axis (straight up in a hover, straight ahead
 * when it lies flat in flight), the body carries a little aerodynamic lift
 * that bends the velocity toward the nose at speed, and drag squares with
 * airspeed and thins with altitude.
 *
 * The pilot doesn't fly the surfaces directly: like a fly-by-wire jet, a
 * flight computer turns intent into commands —
 *  - hover: hold the commanded climb rate and ground speed by tilting the
 *    thrust vector (the suit leans into the move);
 *  - flight: point the nose where the pilot looks (mouse aim) within the
 *    turn-rate and g limits, bank into turns, and hold the commanded
 *    airspeed with the throttle.
 * The two blend through the transition, so pushing forward from a hover
 * leans the suit over into flight, and pulling the throttle back flares it
 * upright into a hover again.
 *
 * On the ground the suit walks: the same keys mean something else there.
 * W/S walk forward and back and A/D sidestep (relative to where the pilot
 * looks; the body turns to the look on stepping feet), Shift jogs, and the
 * climb command (E) is the only way up — a jump-jet hop into a hover,
 * after which every key has its flight meaning again. Coming down slow and
 * upright onto ground sets the boots down and it walks again.
 *
 * Full down (Q) cuts the boots: the suit drops feet first to its terminal
 * speed and stays there. Anything that hits the ground hard (a fall, a
 * dive) arrives in a hero landing — the pilot does the braking. The ground
 * never hurts the suit.
 */

export interface FlightInput {
  /** World-space direction the pilot is looking / steering toward. */
  aim: THREE.Vector3;
  /** Strafe (hover) / roll (flight): −1 left … +1 right. */
  lateral: number;
  /** Forward/back translation in a hover: −1 … +1. */
  forward: number;
  /** Climb / descend command: −1 … +1. */
  vertical: number;
  /** Throttle target change this frame: −1 … +1 (held W / S). */
  throttle: number;
  boost: boolean;
  /** Air brake / flare to a hover. */
  brake: boolean;
  /** Hold the suit upright and slow (combat stance — unibeam). */
  stance: boolean;
}

export const EMPTY_INPUT = (): FlightInput => ({
  aim: new THREE.Vector3(0, 0, 1),
  lateral: 0,
  forward: 0,
  vertical: 0,
  throttle: 0,
  boost: false,
  brake: false,
  stance: false,
});

/** Long-axis tilt in full flight (rad): a touch nose-high of prone. */
export const FLIGHT_POSTURE = 1.42;
/** Throttle airspeed range (m/s) and the boost target. */
export const CRUISE_MAX = 270;
export const BOOST_SPEED = 430;
/** Max boot thrust (m/s² per kg) at full throttle and on boost. */
const THRUST_MAX = 30;
const THRUST_BOOST = 72;
/** Quadratic drag at sea level (1/m). */
const DRAG = 2.4e-4;
/** Body lift: how hard the velocity is pulled onto the nose (1/m), and the g cap. */
const LIFT = 0.028;
const G_LIMIT = 13;
/** Hover speed limits (m/s). */
const HOVER_SPEED = 22;
const CLIMB_SPEED = 16;
/** Time to build to the full yaw rate (s), and the ease on the yaw acceleration (s). */
const YAW_RAMP = 0.22;
const YAW_EASE = 0.05;
/** Walking: tallest step the suit takes in its stride, the drop it steps down (m). */
export const STEP_UP = 0.8;
export const STEP_DOWN = 1.0;
/** Seconds after leaving the ground before it can settle again / the throttle counts. */
const HOP_GUARD = 0.35;
const HOP_THROTTLE = 0.5;
/** Free fall: terminal speed at sea level (m/s), feet first in armour; quicker in thin air. */
export const FALL_TERMINAL = 72;
const FALL_DRAG = GRAVITY / (FALL_TERMINAL * FALL_TERMINAL);
/** Down past this much stick is a fall (boots cut); less is a controlled descent. */
const FALL_STICK = -0.5;
/** Palms and limbs steering a fall (m/s²). */
const FALL_STEER = 4;
/** Palm jets braking (X) against the travel (m/s²). */
const PALM_BRAKE = 9;
/** Above this, the air is too thin and the suit starts icing (m). */
export const ICING_ALT = 9000;
export const CEILING = 11500;

const UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Exponential approach: fraction of the gap closed in dt with time constant tau. */
const approach = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

export interface GroundProbe {
  /** Surface height under a point (ground or sea, m). */
  surface(x: number, z: number): number;
  /** True if the surface there is water. */
  isWater(x: number, z: number): boolean;
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
}

export type ContactKind = 'none' | 'landed' | 'touchdown' | 'heroLanding' | 'splash' | 'footstep';

export class FlightModel {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** Flight frame (forward +Z, up +Y, left +X). */
  readonly q = new THREE.Quaternion();
  /** Body rates in the flight frame (rad/s): x pitch-down, y yaw-left, z roll-right. */
  readonly omega = new THREE.Vector3();
  /** Long-axis tilt from upright (0) to prone ({@link FLIGHT_POSTURE}). */
  posture = 0;
  /** Rate of change of the posture (rad/s). */
  postureVel = 0;
  /** 0 = hover regime, 1 = flight regime. */
  flightness = 0;
  /** Commanded airspeed (m/s). */
  speedCmd = 0;
  /** Current boot thrust (m/s²) and its share of the max. */
  thrust = 0;
  throttle = 0;
  /** Yaw acceleration (rad/s², flight frame, + = left): eased, never stepped. */
  yawAcc = 0;
  /** Lateral thrust trim for the HUD and the palms (−1…1). */
  trimRoll = 0;
  trimPitch = 0;
  /** Load factor (g) felt along the body this frame. */
  gLoad = 1;
  grounded = true;
  /** Air brake deployment 0–1 (flaps). */
  airbrake = 0;
  /** 0–1: boots cut and dropping (Q), eased in and out. */
  freefall = 0;
  /** 0–1: the palms firing against the travel (X), eased. */
  palmBrake = 0;
  /** Last contact this step, and its impact speed (m/s). */
  contact: ContactKind = 'none';
  impactSpeed = 0;
  /** Seconds left in the hero-landing crouch. */
  crouch = 0;
  boosting = false;
  icing = 0;
  /** Suit power 0–1 (0 = rebooting: no thrust, the suit falls). */
  power = 1;
  /** The legs: gait, planted boots and footfalls while on the ground. */
  readonly gait = new Gait();
  /** Seconds since the boots left the ground. */
  airT = 0;
  /** Standing still, the body only turns to the look once it's well round (then all the way). */
  private walkTurn = false;
  /** Shift held through a take-off doesn't light the boost until it's pressed again. */
  private boostLatch = false;

  private readonly _f = new THREE.Vector3();
  private readonly _u = new THREE.Vector3();
  private readonly _l = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _t = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _prevVel = new THREE.Vector3();

  constructor(readonly ground: GroundProbe) {}

  /** Stand on the ground at a point, facing a heading (rad, 0 = +Z). */
  placeOnGround(x: number, z: number, heading: number): void {
    this.pos.set(x, this.ground.surface(x, z) + this.hipHeight(), z);
    this.vel.set(0, 0, 0);
    this.q.setFromAxisAngle(UP, heading);
    this.omega.set(0, 0, 0);
    this.yawAcc = 0;
    this.posture = 0;
    this.postureVel = 0;
    this.flightness = 0;
    this.speedCmd = 0;
    this.thrust = 0;
    this.grounded = true;
    this.crouch = 0;
    this.freefall = 0;
    this.palmBrake = 0;
    this.gait.attach(this.pos, heading, this.ground);
  }

  /** Heading of the body (rad, 0 = +Z). */
  get heading(): number {
    const f = this.forward(this._f);
    return Math.atan2(f.x, f.z);
  }

  /** Height of the centre of mass over the lowest point of the body. */
  hipHeight(): number {
    return THREE.MathUtils.lerp(1.0, 0.32, Math.sin(this.posture));
  }

  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.q);
  }
  up(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 1, 0).applyQuaternion(this.q);
  }
  /** The suit's long axis (head direction) — the boot thrust line. */
  thrustAxis(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, Math.cos(this.posture), Math.sin(this.posture)).applyQuaternion(this.q);
  }
  /** Suit model orientation: flight frame pitched over by the posture. */
  bodyQuaternion(out = new THREE.Quaternion()): THREE.Quaternion {
    return out.copy(this.q).multiply(this._q2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.posture));
  }

  get speed(): number {
    return this.vel.length();
  }
  get mach(): number {
    return this.speed / SPEED_OF_SOUND;
  }
  get altitude(): number {
    return this.pos.y;
  }
  /** Height of the lowest point of the body above the ground or sea. */
  get clearance(): number {
    return this.pos.y - this.hipHeight() - this.ground.surface(this.pos.x, this.pos.z);
  }

  step(dt: number, input: FlightInput): void {
    this.contact = 'none';
    this.crouch = Math.max(0, this.crouch - dt);
    // On the ground the suit walks; only the climb command takes it up
    if (this.grounded) {
      const takeoff = input.vertical > 0.05 && this.crouch <= 0 && this.power > 0.5;
      if (!takeoff) {
        this.stepWalk(dt, input);
        this.syncGait(dt);
        return;
      }
      // Jump-jet hop: the boots light already spooled to hold the weight and
      // kick it clear of the deck, so it never sits on the threshold
      this.grounded = false;
      this.airT = 0;
      this.vel.y = Math.max(this.vel.y, 3.2);
      this.thrust = Math.max(this.thrust, GRAVITY * 1.05);
      this.boostLatch = input.boost;
      this.speedCmd = 0;
    }
    this.airT += dt;
    if (!input.boost) this.boostLatch = false;
    const falling = input.vertical < FALL_STICK && this.power > 0.5;
    this.freefall += ((falling ? 1 : 0) - this.freefall) * approach(dt, falling ? 0.25 : 0.4);
    this._prevVel.copy(this.vel);
    const speed = this.vel.length();
    const f = this.forward(this._f);
    const u = this.up(this._u);
    const l = this._l.crossVectors(u, f); // left

    // ── Throttle / regime ────────────────────────────────────────────
    this.boosting = input.boost && !this.boostLatch && !this.grounded && this.power > 0.5 && !falling;
    if (input.brake || input.stance || falling) {
      this.speedCmd = Math.max(0, this.speedCmd - 220 * dt);
    } else if (this.airT > HOP_THROTTLE) {
      // (a W held through the hop waits for it to clear the deck)
      this.speedCmd = clamp(this.speedCmd + input.throttle * 85 * dt, 0, CRUISE_MAX);
    }
    // In a hover, forward stick alone carries you into flight once you're quick
    // (a fall is not flight, however fast it gets)
    // X drops it out of flight at once (not once the throttle has run
    // down): the body is the brakes' now, free to swing round onto the aim
    const wantFlight = !falling && !input.brake && (this.boosting || this.speedCmd > 28 || (speed > 40 && !input.stance));
    const flightGoal = wantFlight && !this.grounded ? 1 : 0;
    this.flightness += (flightGoal - this.flightness) * approach(dt, flightGoal > this.flightness ? 0.55 : input.brake ? 0.22 : 0.4);
    if (this.grounded) this.flightness = 0;
    const fl = smooth(0.05, 0.95, this.flightness);

    // ── Attitude: mouse aim ──────────────────────────────────────────
    const aim = this._a.copy(input.aim).normalize();
    // Aim in the flight frame — in full flight, measured off the suit's long
    // axis (the line it flies along), not the frame's nose a few degrees
    // below it: the nose held on the aim left the path climbing off it
    const lean = (this.posture - Math.PI / 2) * smooth(0.85 * FLIGHT_POSTURE, FLIGHT_POSTURE, this.posture) * fl;
    this._q.copy(this.q).multiply(this._q2.setFromAxisAngle(this._n.set(1, 0, 0), lean)).invert();
    const al = this._t.copy(aim).applyQuaternion(this._q);
    const yawErr = Math.atan2(al.x, al.z);
    const pitchErr = Math.atan2(al.y, Math.hypot(al.x, al.z)); // + = aim above the nose
    // Turn limits: quick in a hover; in flight the g limit caps the rate at speed
    const gRate = (G_LIMIT * GRAVITY) / Math.max(60, speed);
    const maxPitch = THREE.MathUtils.lerp(2.6, Math.min(2.4, gRate), fl);
    const maxYaw = THREE.MathUtils.lerp(3.2, Math.min(1.6, gRate * 0.8), fl);
    const wantPitch = clamp(pitchErr * 5.5, -maxPitch, maxPitch) * THREE.MathUtils.lerp(0.25, 1, fl);
    // Yaw is flown like a body with inertia, not a rate dial: the suit
    // builds into a turn over ~¼ s (the boots vector, then it swings),
    // carries it, and brakes smoothly onto the heading — a time-optimal
    // profile (√(2·a·err): never more rate than it can stop from) with the
    // acceleration itself eased so the start and the stop have no edge
    const yawAccMax = maxYaw / YAW_RAMP;
    const yawErrAbs = Math.abs(yawErr);
    const wantYaw = Math.sign(yawErr) * Math.min(maxYaw, yawErrAbs * 5, Math.sqrt(2 * yawAccMax * 0.75 * yawErrAbs));
    const yawAccGoal = clamp((wantYaw - this.omega.y) / 0.07, -yawAccMax, yawAccMax);
    this.yawAcc += (yawAccGoal - this.yawAcc) * approach(dt, YAW_EASE);
    // Bank: into the turn in flight (coordinated), level in a hover; A/D roll
    const bank = Math.atan2(l.y, u.y); // + = right wing low (left wing up)
    const nearVertical = Math.abs(f.y) > 0.93;
    let wantRoll: number;
    if (fl > 0.2 && Math.abs(input.lateral) > 0.05) {
      wantRoll = input.lateral * 3.4 * fl;
    } else if (nearVertical) {
      wantRoll = 0;
    } else {
      const bankGoal = clamp(-yawErr * 2.4, -1.25, 1.25) * fl;
      if (Math.abs(bank) > 2.4) {
        // Inverted: the bank angle flips ±π frame to frame — keep rolling the
        // way we already are rather than dithering on the seam
        wantRoll = Math.abs(this.omega.z) > 0.3 ? Math.sign(this.omega.z) * 3 : 3;
      } else {
        wantRoll = clamp((bankGoal - bank) * 4.5, -3, 3);
      }
    }
    // In a hover the pitch is the attitude computer's (below), not the aim's
    const rates = this._v.set(-wantPitch, this.omega.y, wantRoll);
    this.omega.lerp(rates, approach(dt, THREE.MathUtils.lerp(0.09, 0.14, fl)));
    this.omega.y += this.yawAcc * dt;
    // Integrate the rates in the body frame. In flight the roll goes round
    // the suit's long axis (where the velocity sits), not the frame's nose:
    // rolled round the nose, the few degrees between the two swung the
    // flight path about and an aileron roll pulled 7–9 g sideways
    const w = this.omega;
    const ra = this._t.set(0, Math.cos(this.posture), Math.sin(this.posture)).lerp(this._n.set(0, 0, 1), 1 - fl).normalize();
    const wEff = this._n.set(w.x, w.y, 0).addScaledVector(ra, w.z);
    const ang = wEff.length() * dt;
    if (ang > 1e-7) {
      this._q2.setFromAxisAngle(wEff.normalize(), ang);
      this.q.multiply(this._q2).normalize();
    }

    // Hover: the frame stays near upright — level it back toward world up
    // (keeping the heading); flight keeps the attitude it was flown into
    if (fl < 0.999) {
      const fNow = this.forward(this._f);
      const heading = Math.atan2(fNow.x, fNow.z);
      const pitchNow = Math.asin(clamp(fNow.y, -1, 1));
      // Hover pitch: a gentle nod toward the aim (the head does the rest)
      const hoverPitch = clamp(pitchErr + pitchNow, -0.5, 0.5) * 0.25;
      this._q.setFromEuler(new THREE.Euler(-hoverPitch, heading, 0, 'YXZ'));
      this.q.slerp(this._q, approach(dt, 0.12) * (1 - fl));
    }

    // ── Posture (long-axis tilt) ─────────────────────────────────────
    const postureGoal = fl * FLIGHT_POSTURE * (input.brake ? 0.55 : 1) * (input.stance ? 0 : 1);
    // A sprung swing, not an exponential: the body eases into the lean-over
    // and the flare (no kick on the first frame) and settles with a hair of
    // follow-through, about as quickly as before
    const pw = 2.15 / (input.brake ? 0.25 : 0.45);
    this.postureVel += (pw * pw * (postureGoal - this.posture) - 2 * 0.85 * pw * this.postureVel) * dt;
    this.posture += this.postureVel * dt;

    // ── Forces ───────────────────────────────────────────────────────
    const alt = Math.max(0, this.pos.y);
    const rho = Math.exp(-alt / 8500);
    this.icing = smooth(ICING_ALT, CEILING, alt);
    const ceilingK = 1 - this.icing * 0.85;
    const acc = this._a.set(0, -GRAVITY, 0);
    const axis = this.thrustAxis(this._t);

    // Hover computer: desired velocity → acceleration → tilted thrust
    const fwdFlat = this._n.set(f.x, 0, f.z).normalize();
    const leftFlat = this._v.set(fwdFlat.z, 0, -fwdFlat.x);
    const vWant = new THREE.Vector3()
      .addScaledVector(fwdFlat, (input.forward + this.speedCmd / 30) * HOVER_SPEED)
      .addScaledVector(leftFlat, -input.lateral * HOVER_SPEED * 0.8);
    vWant.y = input.vertical * CLIMB_SPEED;
    // Just off the deck: keep climbing clear whatever the stick says
    if (this.airT < HOP_GUARD) vWant.y = Math.max(vWant.y, 4);
    // Height first, then what thrust is left goes to the horizontal (a real
    // VTOL computer never trades altitude for a stop)
    const hoverMax = THRUST_MAX * 1.1 * ceilingK;
    const hoverAcc = vWant.sub(this.vel).multiplyScalar(1.6);
    hoverAcc.y = clamp(hoverAcc.y + GRAVITY, 0, hoverMax);
    const side = Math.sqrt(Math.max(0, hoverMax * hoverMax - hoverAcc.y * hoverAcc.y));
    const hl = Math.hypot(hoverAcc.x, hoverAcc.z);
    if (hl > side) {
      hoverAcc.x *= side / hl;
      hoverAcc.z *= side / hl;
    }
    const hoverThrust = Math.min(hoverAcc.length(), hoverMax);
    const hoverDir = hoverAcc.lengthSq() > 1e-6 ? hoverAcc.normalize() : hoverAcc.copy(UP);

    // Flight computer: hold the commanded airspeed with the boots
    const target = this.boosting ? BOOST_SPEED : this.speedCmd;
    const along = this.vel.dot(axis);
    const dragHere = DRAG * rho * speed * speed;
    const need = dragHere + GRAVITY * axis.y + (target - along) * 0.9;
    const tMax = (this.boosting ? THRUST_BOOST : THRUST_MAX) * ceilingK;
    const flightThrust = clamp(need, 0, tMax);

    // Blend the regimes
    const thrustDir = new THREE.Vector3().copy(hoverDir).lerp(axis, fl).normalize();
    // Falling, the boots are cut
    const thrust = falling ? 0 : THREE.MathUtils.lerp(hoverThrust, flightThrust, fl);
    const grounded = this.grounded && thrust < GRAVITY * 1.02 && input.vertical <= 0;
    this.thrust += ((grounded ? 0 : thrust * this.power) - this.thrust) * approach(dt, 0.12);
    this.throttle = clamp(this.thrust / THRUST_BOOST, 0, 1);
    acc.addScaledVector(thrustDir, this.thrust);

    // In a hover the suit leans to its thrust: bring the frame's up toward it
    if (fl < 0.95 && !this.grounded && !falling) {
      const upNow = this.up(this._u);
      this._q.setFromUnitVectors(upNow, thrustDir);
      this._q2.identity().slerp(this._q, approach(dt, 0.18) * (1 - fl));
      this.q.premultiply(this._q2).normalize();
    }
    // Stabilizer trim for the HUD / flaps: lean in the frame
    {
      const ul = thrustDir.clone().applyQuaternion(this._q.copy(this.q).invert());
      this.trimRoll = clamp(-ul.x * 3 + this.omega.z * 0.25, -1, 1);
      this.trimPitch = clamp(ul.z * 3 + this.omega.x * 0.25, -1, 1);
    }

    // Drag, thinner with height; the brakes add a lot. A
    // fall is the body's own drag: it settles on its terminal speed
    this.airbrake += ((input.brake ? 1 : 0) - this.airbrake) * approach(dt, 0.15);
    const dragK = rho * THREE.MathUtils.lerp(DRAG * (1 + this.airbrake * 5 + (1 - fl) * 3), FALL_DRAG, this.freefall);
    acc.addScaledVector(this.vel, -dragK * speed);
    // Falling, the hands and legs steer it a little (forward / sideways)
    if (falling) {
      const hx = vWant.x - this.vel.x;
      const hz = vWant.z - this.vel.z;
      const hl2 = Math.hypot(hx, hz);
      if (hl2 > 1e-3) acc.add(this._v.set(hx, 0, hz).multiplyScalar(Math.min(FALL_STEER, hl2 * 1.5) / hl2));
    }
    // Palm jets against the travel: X
    const palmGoal = input.brake && !this.grounded ? smooth(2, 14, speed) : 0;
    this.palmBrake += (palmGoal - this.palmBrake) * approach(dt, 0.12);
    // (along the ground: the boots hold the height)
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (this.palmBrake > 1e-3 && hv > 0.5) {
      const k = (-PALM_BRAKE * this.palmBrake * this.power * Math.min(1, hv / 3)) / hv;
      acc.x += this.vel.x * k;
      acc.z += this.vel.z * k;
    }

    // Body lift: pull the velocity onto the nose (flight only)
    if (fl > 0.01 && speed > 1) {
      const fNow = this.thrustAxis(this._f);
      const perp = this._v.copy(this.vel).addScaledVector(fNow, -this.vel.dot(fNow));
      // Flared for the brakes the body is a parachute, not a wing: no balloon
      // Full down kills the wing so the body falls instead of gliding
      const fall = input.vertical < 0 ? 1 + input.vertical : 1;
      const lift = perp.multiplyScalar(-LIFT * speed * rho * fl * (1 - 0.85 * this.airbrake) * fall);
      const ll = lift.length();
      if (ll > G_LIMIT * GRAVITY) lift.multiplyScalar((G_LIMIT * GRAVITY) / ll);
      acc.add(lift);
      // Induced drag: turning costs energy
      acc.addScaledVector(this.vel, -(Math.min(ll, G_LIMIT * GRAVITY) * 0.045) / Math.max(speed, 1));
    }
    // Strafe / climb trim from the palms in flight
    if (fl > 0.5) acc.addScaledVector(UP, Math.max(0, input.vertical) * 6 * fl);

    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    // Felt load, as a G meter reads it: the normal load factor — the
    // acceleration minus gravity along the lift axis (out of the back in
    // flight, square to the long axis; up the thrust line in a hover).
    // Thrust, drag and the brakes along the path don't count, and inverted
    // it reads negative (an aileron roll swings it +1 → −1 → +1)
    const felt = this._v.copy(this.vel).sub(this._prevVel).divideScalar(Math.max(dt, 1e-4));
    felt.y += GRAVITY;
    const liftAxis = this._t.set(0, 1, 0).applyAxisAngle(this._n.set(1, 0, 0), lean).applyQuaternion(this.q);
    this.gLoad += (felt.dot(liftAxis) / GRAVITY - this.gLoad) * approach(dt, 0.25);

    this.collide(input);
    this.syncGait(dt);
  }

  /** Keep the legs' contacts in step with the ground state. */
  private syncGait(dt: number): void {
    const g = this.gait;
    if (this.grounded && !g.attached) g.attach(this.pos, this.heading, this.ground);
    else if (!this.grounded && g.attached) g.detach(this.pos, this.bodyQuaternion(this._q));
    if (!this.grounded) g.step(dt, this.pos, this.heading, this.vel, this.omega.y, this.crouch, this.ground);
  }

  /**
   * On foot: turn to the look on stepping feet, walk / sidestep / jog
   * relative to it, step up kerbs and down ledges, stop at walls.
   */
  private stepWalk(dt: number, input: FlightInput): void {
    this._prevVel.copy(this.vel);
    const ground = this.ground;
    const stuck = this.crouch > 0 || this.power < 0.5;
    // Intent: W/S (or the stick) forward, A/D sideways, Shift jogs
    let fwdIn = Math.abs(input.throttle) >= Math.abs(input.forward) ? input.throttle : input.forward;
    let latIn = input.lateral;
    if (stuck) fwdIn = latIn = 0;
    fwdIn = clamp(fwdIn, -1, 1);
    latIn = clamp(latIn, -1, 1);
    const moving = Math.hypot(fwdIn, latIn) > 0.08;
    const run = input.boost && !input.stance;

    // ── Heading: the body follows the look ──────────────────────────
    const aim = this._a.copy(input.aim);
    const aimHeading = Math.hypot(aim.x, aim.z) > 1e-3 ? Math.atan2(aim.x, aim.z) : this.heading;
    const heading = this.heading;
    const yawErrRaw = Math.atan2(Math.sin(aimHeading - heading), Math.cos(aimHeading - heading));
    if (moving || Math.abs(yawErrRaw) > 0.7) this.walkTurn = true;
    else if (Math.abs(yawErrRaw) < 0.03 && Math.abs(this.omega.y) < 0.2) this.walkTurn = false;
    const yawErr = this.walkTurn && !stuck ? yawErrRaw : 0;
    // The same eased S-curve as the air, at a walker's rates
    const maxYaw = run ? 2.6 : 2.1;
    const yawAccMax = maxYaw / 0.3;
    const yawErrAbs = Math.abs(yawErr);
    const wantYaw = Math.sign(yawErr) * Math.min(maxYaw, yawErrAbs * 5, Math.sqrt(2 * yawAccMax * 0.75 * yawErrAbs));
    const yawAccGoal = clamp((wantYaw - this.omega.y) / 0.07, -yawAccMax, yawAccMax);
    this.yawAcc += (yawAccGoal - this.yawAcc) * approach(dt, YAW_EASE);
    this.omega.y += this.yawAcc * dt;
    this.omega.x *= 1 - approach(dt, 0.1);
    this.omega.z *= 1 - approach(dt, 0.1);
    const h = heading + this.omega.y * dt;
    // Upright on the boots (eases out of any landing lean)
    this._q.setFromAxisAngle(UP, h);
    this.q.slerp(this._q, approach(dt, 0.08));
    this.q.premultiply(this._q2.setFromAxisAngle(UP, h - this.heading)).normalize();

    // ── Velocity: heavy — it leans into a start and plants to stop ──
    const fwd = this._f.set(Math.sin(aimHeading), 0, Math.cos(aimHeading));
    const left = this._l.set(Math.cos(aimHeading), 0, -Math.sin(aimHeading));
    const vF = fwdIn >= 0 ? (run ? RUN_SPEED : WALK_SPEED) : BACK_SPEED * (run ? 1.4 : 1);
    const vS = run ? STRAFE_RUN : STRAFE_SPEED;
    const want = this._v.set(0, 0, 0).addScaledVector(fwd, fwdIn * vF).addScaledVector(left, -latIn * vS);
    // Diagonals no faster than straight
    const wl = Math.hypot(want.x, want.z);
    const cap = Math.max(Math.abs(fwdIn * vF), Math.abs(latIn * vS));
    if (wl > cap && wl > 1e-6) want.multiplyScalar(cap / wl);
    const speeding = Math.hypot(want.x, want.z) > Math.hypot(this.vel.x, this.vel.z);
    const k = approach(dt, speeding ? 0.32 : 0.2);
    this.vel.x += (want.x - this.vel.x) * k;
    this.vel.z += (want.z - this.vel.z) * k;
    this.vel.y = 0;

    // ── Ground: step up / down, walls stop it ────────────────────────
    const here = ground.surface(this.pos.x, this.pos.z);
    const blocked = (x: number, z: number) => {
      // Probe a body radius ahead along the move
      const dx = x - this.pos.x;
      const dz = z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const px = d > 1e-6 ? x + (dx / d) * 0.32 : x;
      const pz = d > 1e-6 ? z + (dz / d) * 0.32 : z;
      for (const [qx, qz] of [
        [x, z],
        [px, pz],
      ]) {
        if (ground.isWater(qx, qz)) return true;
        if (ground.surface(qx, qz) - here > STEP_UP) return true;
      }
      return false;
    };
    let nx = this.pos.x + this.vel.x * dt;
    let nz = this.pos.z + this.vel.z * dt;
    if (blocked(nx, nz)) {
      // Slide along the wall if one axis is free
      if (!blocked(nx, this.pos.z)) {
        nz = this.pos.z;
        this.vel.z = 0;
      } else if (!blocked(this.pos.x, nz)) {
        nx = this.pos.x;
        this.vel.x = 0;
      } else {
        nx = this.pos.x;
        nz = this.pos.z;
        this.vel.x = this.vel.z = 0;
      }
    }
    this.pos.x = nx;
    this.pos.z = nz;
    const there = ground.surface(nx, nz);
    const hip = this.hipHeight();
    if (here - there > STEP_DOWN && this.pos.y - hip - there > STEP_DOWN) {
      // Walked off an edge: the boots catch it in a hover
      this.grounded = false;
      this.airT = HOP_GUARD;
      this.walkTurn = false;
    } else {
      // Ride the ground, easing over steps
      this.pos.y += (there + hip - this.pos.y) * approach(dt, 0.07);
    }

    // ── Flight state at rest ─────────────────────────────────────────
    this.speedCmd = 0;
    this.flightness = 0;
    this.boosting = false;
    this.thrust *= 1 - approach(dt, 0.12);
    this.throttle = clamp(this.thrust / THRUST_BOOST, 0, 1);
    this.airbrake *= 1 - approach(dt, 0.15);
    this.palmBrake *= 1 - approach(dt, 0.12);
    this.freefall = 0;
    this.trimRoll *= 1 - approach(dt, 0.2);
    this.trimPitch *= 1 - approach(dt, 0.2);
    this.gLoad += (1 - this.gLoad) * approach(dt, 0.2);
    const pw = 2.15 / 0.45;
    this.postureVel += (pw * pw * (0 - this.posture) - 2 * 0.85 * pw * this.postureVel) * dt;
    this.posture += this.postureVel * dt;

    // ── Legs ─────────────────────────────────────────────────────────
    if (this.grounded) {
      const strike = this.gait.step(dt, this.pos, this.heading, this.vel, this.omega.y, this.crouch, ground);
      if (strike > 0) {
        this.contact = 'footstep';
        this.impactSpeed = strike;
      }
    }
  }

  private collide(input: FlightInput): void {
    const x = this.pos.x;
    const z = this.pos.z;
    const surf = this.ground.surface(x, z);
    const water = this.ground.isWater(x, z);
    const hip = this.hipHeight();
    const gap = this.pos.y - hip - surf;
    if (gap > 0.02) {
      if (this.grounded && gap > 0.25) this.grounded = false;
      return;
    }
    const n = water ? this._n.set(0, 1, 0) : this.ground.normal(x, z, this._n);
    const into = -this.vel.dot(n);
    this.pos.y = surf + hip;
    if (water) {
      // The sea: a hard slap at speed, a splash and a skip back up
      if (into > 1.5) {
        this.contact = 'splash';
        this.impactSpeed = into;
        this.vel.addScaledVector(n, into * 1.25);
        this.vel.multiplyScalar(into > 25 ? 0.7 : 0.9);
      }
      this.grounded = false;
      return;
    }
    const tangential = this._v.copy(this.vel).addScaledVector(n, -this.vel.dot(n)).length();
    const gentle = into < 7 && tangential < 9 && this.posture < 0.6;
    // Idle must be the exact complement of step()'s "moving" test: a throttle
    // press from a standstill puts speedCmd at 0.7 on the first step, which
    // lifts off (> 0.5) — if this called it idle (< 1) it would set the suit
    // straight back down, zero speedCmd and land again on every physics step
    // (a 'landed' event at 120 Hz: the grating touchdown machine-gun)
    // On foot the throttle and the side keys walk, so they don't hold it up:
    // anything slow and upright that isn't climbing sets down and walks.
    // Take-off is the climb command alone and settling needs it released
    // (plus a beat clear of the deck), so the two can never trade places on
    // alternate steps
    const idle = input.vertical <= 0.05 && this.airT > HOP_GUARD;
    if (gentle && idle) {
      // Settled on the deck: boots down, weight on the legs
      if (!this.grounded) {
        this.contact = into > 3.5 ? 'touchdown' : 'landed';
        this.impactSpeed = into;
      }
      this.grounded = true;
      // Keep the way it was drifting as the first steps (no faster than a jog)
      this.vel.y = 0;
      const hv = Math.hypot(this.vel.x, this.vel.z);
      if (hv > RUN_SPEED) this.vel.multiplyScalar(RUN_SPEED / hv);
      this.flightness = 0;
      this.speedCmd = 0;
      return;
    }
    if (into <= 0.5) return;
    if ((gentle || (into < 7 && tangential > 30))) {
      // Brushing the ground on the way up, or skimming it flat out: no
      // bounce, no event — the suit rides along the surface
      this.vel.addScaledVector(n, into);
      return;
    }
    // Anything harder is a hero landing — whatever it came in at, the
    // knees, a boot and a fist take it all (the ground never hurts the suit)
    this.contact = 'heroLanding';
    this.impactSpeed = Math.min(into, 45);
    this.vel.set(0, 0, 0);
    this.grounded = true;
    this.crouch = 0.95;
    this.flightness = 0;
    this.speedCmd = 0;
    this.freefall = 0;
  }
}
