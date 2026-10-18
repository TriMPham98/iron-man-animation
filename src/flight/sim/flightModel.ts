import * as THREE from 'three';
import { GRAVITY, SPEED_OF_SOUND } from '../world/config';

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

export type ContactKind = 'none' | 'landed' | 'touchdown' | 'heroLanding' | 'impact' | 'splash';

export class FlightModel {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** Flight frame (forward +Z, up +Y, left +X). */
  readonly q = new THREE.Quaternion();
  /** Body rates in the flight frame (rad/s): x pitch-down, y yaw-left, z roll-right. */
  readonly omega = new THREE.Vector3();
  /** Long-axis tilt from upright (0) to prone ({@link FLIGHT_POSTURE}). */
  posture = 0;
  /** 0 = hover regime, 1 = flight regime. */
  flightness = 0;
  /** Commanded airspeed (m/s). */
  speedCmd = 0;
  /** Current boot thrust (m/s²) and its share of the max. */
  thrust = 0;
  throttle = 0;
  /** Lateral thrust trim for the HUD and the palms (−1…1). */
  trimRoll = 0;
  trimPitch = 0;
  /** Load factor (g) felt along the body this frame. */
  gLoad = 1;
  grounded = true;
  /** Air brake deployment 0–1 (flaps). */
  airbrake = 0;
  /** Last contact this step, and its impact speed (m/s). */
  contact: ContactKind = 'none';
  impactSpeed = 0;
  /** Seconds left in the hero-landing crouch. */
  crouch = 0;
  boosting = false;
  icing = 0;
  /** Suit power 0–1 (0 = rebooting: no thrust, the suit falls). */
  power = 1;

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

  constructor(private readonly ground: GroundProbe) {}

  /** Stand on the ground at a point, facing a heading (rad, 0 = +Z). */
  placeOnGround(x: number, z: number, heading: number): void {
    this.pos.set(x, this.ground.surface(x, z) + this.hipHeight(), z);
    this.vel.set(0, 0, 0);
    this.q.setFromAxisAngle(UP, heading);
    this.omega.set(0, 0, 0);
    this.posture = 0;
    this.flightness = 0;
    this.speedCmd = 0;
    this.thrust = 0;
    this.grounded = true;
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
    this._prevVel.copy(this.vel);
    const speed = this.vel.length();
    const f = this.forward(this._f);
    const u = this.up(this._u);
    const l = this._l.crossVectors(u, f); // left

    // ── Throttle / regime ────────────────────────────────────────────
    this.boosting = input.boost && !this.grounded && this.power > 0.5;
    if (input.brake || input.stance) {
      this.speedCmd = Math.max(0, this.speedCmd - 220 * dt);
    } else {
      this.speedCmd = clamp(this.speedCmd + input.throttle * 85 * dt, 0, CRUISE_MAX);
    }
    // In a hover, forward stick alone carries you into flight once you're quick
    const wantFlight = this.boosting || this.speedCmd > 28 || (speed > 40 && !input.brake && !input.stance);
    const flightGoal = wantFlight && !this.grounded ? 1 : 0;
    this.flightness += (flightGoal - this.flightness) * approach(dt, flightGoal > this.flightness ? 0.55 : 0.4);
    if (this.grounded) this.flightness = 0;
    const fl = smooth(0.05, 0.95, this.flightness);

    // ── Attitude: mouse aim ──────────────────────────────────────────
    const aim = this._a.copy(input.aim).normalize();
    // Aim in the flight frame
    this._q.copy(this.q).invert();
    const al = this._t.copy(aim).applyQuaternion(this._q);
    const yawErr = Math.atan2(al.x, al.z);
    const pitchErr = Math.atan2(al.y, Math.hypot(al.x, al.z)); // + = aim above the nose
    // Turn limits: quick in a hover; in flight the g limit caps the rate at speed
    const gRate = (G_LIMIT * GRAVITY) / Math.max(60, speed);
    const maxPitch = THREE.MathUtils.lerp(2.6, Math.min(2.4, gRate), fl);
    const maxYaw = THREE.MathUtils.lerp(3.2, Math.min(1.6, gRate * 0.8), fl);
    const wantPitch = clamp(pitchErr * 5.5, -maxPitch, maxPitch) * THREE.MathUtils.lerp(0.25, 1, fl);
    const wantYaw = clamp(yawErr * 5, -maxYaw, maxYaw);
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
    const rates = this._v.set(-wantPitch, wantYaw, wantRoll);
    this.omega.lerp(rates, approach(dt, THREE.MathUtils.lerp(0.09, 0.14, fl)));
    // Integrate the rates in the body frame
    const w = this.omega;
    const ang = w.length() * dt;
    if (ang > 1e-7) {
      this._q2.setFromAxisAngle(this._n.copy(w).normalize(), ang);
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
    this.posture += (postureGoal - this.posture) * approach(dt, input.brake ? 0.25 : 0.45);

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
    // Off the deck: any command to move hops the suit up first
    const moving = this.speedCmd > 0.5 || Math.abs(input.lateral) > 0.1 || Math.abs(input.forward) > 0.1;
    if (this.grounded && (moving || input.vertical > 0.05)) {
      this.grounded = false;
      vWant.y = Math.max(vWant.y, 6);
    } else if (this.grounded) {
      vWant.set(0, -1, 0);
    }
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
    const hoverDir = hoverAcc.normalize();

    // Flight computer: hold the commanded airspeed with the boots
    const target = this.boosting ? BOOST_SPEED : this.speedCmd;
    const along = this.vel.dot(axis);
    const dragHere = DRAG * rho * speed * speed;
    const need = dragHere + GRAVITY * axis.y + (target - along) * 0.9;
    const tMax = (this.boosting ? THRUST_BOOST : THRUST_MAX) * ceilingK;
    const flightThrust = clamp(need, 0, tMax);

    // Blend the regimes
    const thrustDir = new THREE.Vector3().copy(hoverDir).lerp(axis, fl).normalize();
    const thrust = THREE.MathUtils.lerp(hoverThrust, flightThrust, fl);
    const grounded = this.grounded && thrust < GRAVITY * 1.02 && input.vertical <= 0;
    this.thrust += ((grounded ? 0 : thrust * this.power) - this.thrust) * approach(dt, 0.12);
    this.throttle = clamp(this.thrust / THRUST_BOOST, 0, 1);
    acc.addScaledVector(thrustDir, this.thrust);

    // In a hover the suit leans to its thrust: bring the frame's up toward it
    if (fl < 0.95 && !this.grounded) {
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

    // Drag, thinner with height; the brakes and the flare add a lot
    this.airbrake += ((input.brake ? 1 : 0) - this.airbrake) * approach(dt, 0.15);
    const dragK = DRAG * rho * (1 + this.airbrake * 5 + (1 - fl) * 3);
    acc.addScaledVector(this.vel, -dragK * speed);

    // Body lift: pull the velocity onto the nose (flight only)
    if (fl > 0.01 && speed > 1) {
      const fNow = this.thrustAxis(this._f);
      const perp = this._v.copy(this.vel).addScaledVector(fNow, -this.vel.dot(fNow));
      // Flared for the brakes the body is a parachute, not a wing: no balloon
      const lift = perp.multiplyScalar(-LIFT * speed * rho * fl * (1 - 0.85 * this.airbrake));
      const ll = lift.length();
      if (ll > G_LIMIT * GRAVITY) lift.multiplyScalar((G_LIMIT * GRAVITY) / ll);
      acc.add(lift);
      // Induced drag: turning costs energy
      acc.addScaledVector(this.vel, -(Math.min(ll, G_LIMIT * GRAVITY) * 0.045) / Math.max(speed, 1));
    }
    // Strafe / climb trim from the palms in flight
    if (fl > 0.5) acc.addScaledVector(UP, input.vertical * 6 * fl);

    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    // Felt load: acceleration minus gravity, along the body's "up" (out of the back in flight)
    const felt = this._v.copy(this.vel).sub(this._prevVel).divideScalar(Math.max(dt, 1e-4));
    felt.y += GRAVITY;
    this.gLoad += (felt.length() / GRAVITY - this.gLoad) * approach(dt, 0.2);

    this.collide(dt, input);
  }

  private collide(dt: number, input: FlightInput): void {
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
    const idle = input.vertical <= 0.05 && this.speedCmd < 1 && Math.abs(input.lateral) < 0.1 && Math.abs(input.forward) < 0.1;
    if (gentle && idle) {
      // Settled on the deck: boots down, weight on the legs
      if (!this.grounded) {
        this.contact = into > 3.5 ? 'touchdown' : 'landed';
        this.impactSpeed = into;
      }
      this.grounded = true;
      this.vel.set(0, 0, 0);
      this.flightness = 0;
      this.speedCmd = 0;
      return;
    }
    if (into > 0) {
      const heroic = this.posture < 0.9 && into >= 7 && into < 45 && tangential < 30;
      if (heroic) {
        // Three-point landing: absorb it all in the knees and a fist
        this.contact = 'heroLanding';
        this.impactSpeed = into;
        this.vel.set(0, 0, 0);
        this.grounded = true;
        this.crouch = 1.4;
        this.flightness = 0;
        this.speedCmd = 0;
        return;
      }
      if (into > 3) {
        this.contact = 'impact';
        this.impactSpeed = Math.hypot(into, tangential * 0.35);
      }
      // Bounce off with a little restitution and scrape along
      this.vel.addScaledVector(n, into * 1.25);
      this.vel.multiplyScalar(0.82);
    }
    void dt;
  }
}
