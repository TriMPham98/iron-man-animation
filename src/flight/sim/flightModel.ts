import * as THREE from 'three';
import { GRAVITY, SPEED_OF_SOUND } from '../world/config';
import { BACK_SPEED, Gait, STRAFE_SPEED, WALK_SPEED } from './walkCycle';

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
 * looks; the body turns to the look on stepping feet), and the
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
/** Throttle airspeed range (m/s). */
export const CRUISE_MAX = 270;
/**
 * The Mk II's top speed on boost: a prototype, short of the Mk III that ran
 * with F-22s. Low down the thick air holds it to ~Mach 1.4; from a few
 * thousand metres up it makes the full figure.
 */
export const MAX_MACH = 1.5;
export const BOOST_SPEED = MAX_MACH * SPEED_OF_SOUND;
/** Max boot thrust (m/s² per kg) at full throttle and on boost. */
const THRUST_MAX = 30;
const THRUST_BOOST = 72;
/** Boots spooling up to the boost's authority (s): the kick builds over ~½ s, not a step. */
const BOOST_SPOOL = 0.15;
/** Boots' spool-up from near idle (s): wound up they answer in 0.12. */
const SPOOL_IDLE = 0.45;
/** Quadratic drag at sea level (1/m). */
const DRAG = 2.4e-4;
/**
 * Transonic drag rise: extra drag (× DRAG) that builds through the high
 * subsonic, peaks at the barrier and falls off to a residue once clear, so
 * the boost still punches but the last stretch to Mach 1 is a push.
 */
const WAVE_PEAK = 1.25;
const WAVE_RESIDUE = 0.3;
/** Body lift: how hard the velocity is pulled onto the nose (1/m). */
const LIFT = 0.028;
/**
 * The pull the Mk II will hold (g). No g-suit and no wing, just a pilot
 * strapped into a prototype: about what a fighter pilot grunts through.
 */
export const G_LIMIT = 9;
/** How fast the pull may build (g/s), as a fly-by-wire jet ramps it on for the pilot; it lets go three times as quick. */
const G_ONSET = 7;
/** Most it pushes (negative g) nose down. */
const G_PUSH = 3;
/**
 * Bank-to-turn: with no wing to skid round on, the suit rolls its back (the
 * lift) into the turn, then pulls. Steepest bank (rad), the pull it'll make
 * before the roll gets there (g), and the flat skid the boots can vector (g).
 */
const BANK_MAX = 1.45;
const ROLL_PULL_G = 2.5;
const SKID_G = 2;
/** Turn the bank is set for: rad/s of turn per radian the aim is off the travel. */
const TURN_GAIN = 1;
/** …and the climb it holds on the bank: per radian the aim is above or below the travel. */
const CLIMB_GAIN = 3;
/** Steepest angle of attack the body flies at before it just mushes (rad): its drag-due-to-lift tops out there. */
const AOA_MAX = 0.35;
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
/**
 * Most the flare's extra drag (brakes out, body broadside) adds (m/s²): the
 * flaps blow back against the dynamic pressure rather than stopping the suit
 * dead, so a stop from cruise takes seconds, not a 20 g slam.
 */
const FLARE_DRAG_MAX = 12;
/**
 * Most the brakes may slow the suit all told (m/s², ~6 g): from supersonic
 * the drag rise, the flaps, the palms and the boots leaning back stacked to
 * twice a subsonic stop.
 */
const BRAKE_DECEL_MAX = 6 * GRAVITY;
/**
 * Letting go of the boost, the boots ease the speed back to the throttle at
 * this rate (m/s², ~2 g) instead of cutting out and leaving the drag to slam it.
 */
const BOOST_BLEED = 2 * GRAVITY;
/** Flap share S cracks open as speed brakes (the full flare is 1). */
const SPEED_BRAKE = 0.5;
/** Under this airspeed (m/s) the brakes leave the throttle at idle, not on what's left. */
const BRAKE_IDLE = 5;
/** Hover computer's horizontal gain while braking (1/s; 1.6 otherwise): how firmly a stop settles. */
const BRAKE_SETTLE = 2.4;
/** Horizontal pull the hover computer gets well above hover speed (m/s²). */
const HOVER_BRAKE_FAST = 14;
/**
 * Momentum swing: pushing off again out of a flare with the aim well round
 * from the travel, the boots carry the speed round onto the new line instead
 * of fighting it to a stop and starting over. Peak swing rate (rad/s), and
 * how far off the travel (rad) the aim must be to start one.
 */
const SWING_RATE = 2.2;
const SWING_START = 1.0;
/** Flat out (no flare first) it takes the boost and the aim well astern (rad). */
const SWING_START_BOOST = 1.75;
/**
 * Most the swing carves the travel round (g): slow it's a pivot, flat out an
 * arc that takes seconds — the one move that had no g limit, ~95 g at boost.
 */
const SWING_G = 22;
/** Speed a swing spends per radian it carves (~40% across a full reversal): the boost earns it back. */
const SWING_COST = 0.16;
/** Easing into a swing (s): the carve builds, never snaps on. */
const SWING_ENTRY = 0.3;
/**
 * Attitude waypoint toward a far aim: at most this far round in heading from
 * where the body points, and this steep (rad) — never over the top.
 */
const GUIDE_TURN = 1.4;
const GUIDE_PITCH = 1.48;
/** Further round than this (rad), the aim is astern: the turn keeps its side. */
const GUIDE_ASTERN = 2.7;
/** Above this, the air is too thin and the suit starts icing (m). */
export const ICING_ALT = 9000;
export const CEILING = 11500;
/**
 * Pad capture: hovering hands-off over a landing pad (no stick, throttle at
 * idle), the hover computer holds the suit over its centre so a plain
 * descent sets it down there. Reach across (m) and above the deck (m), and
 * the hold's spring (1/s²), damping (1/s) and most it pushes (m/s²). Any
 * horizontal stick lets go at once; it never touches the climb or descent.
 */
export const PAD_CAPTURE_R = 16;
export const PAD_CAPTURE_H = 40;
const PAD_HOLD_K = 5;
const PAD_HOLD_D = 4.2;
const PAD_HOLD_MAX = 10;
/**
 * Auto-land (the pilot hands it over near the pad): the hover computer
 * flies the suit in over the centre and sets it down. Fastest it crosses
 * (m/s), the hardest push across it plans (m/s², the brakes and the air
 * included) and how fast that push may swing round (m/s³), the glide slope
 * down to the deck (m of height per m out), the clearance it keeps over
 * anything on the way (m), and the sink it touches down at (m/s).
 */
const AUTOLAND_SPEED = 70;
const AUTOLAND_PUSH = 40;
const AUTOLAND_JERK = 45;
/** Boot authority it flies on (× the full throttle; a hover holds 1.1). */
const AUTOLAND_THRUST = 1.7;
/** The stop it plans for coming down (m/s²). */
const AUTOLAND_SINK_DECEL = 7.2;
const AUTOLAND_SLOPE = 0.6;
const AUTOLAND_CLEAR = 6;
const AUTOLAND_SINK = 1.6;
/**
 * Quickest run-in it plans (s), the time-to-go it settles onto the mark over
 * at the end (s), and the snappier one it trims the last few centimetres on
 * (s: on the settle's it crept in and the pause before letting down dragged).
 */
const AUTOLAND_T_MIN = 1.5;
const AUTOLAND_T_END = 1.8;
const AUTOLAND_T_TRIM = 0.9;
/**
 * Auto-land's last look before it lets down: hovering just off the deck it
 * trims onto the centre until it's within this far (m), drifting no faster
 * than this (m/s), and holds that for this long (s), and only then sinks.
 * Pushed further than the slip (m) off the mark on the way down, it stops
 * and trims again.
 */
export const AUTOLAND_LOCK_R = 0.015;
const AUTOLAND_LOCK_V = 0.06;
const AUTOLAND_LOCK_T = 0.3;
const AUTOLAND_SLIP = 0.03;
/** How quickly the body's lean follows the thrust under auto-land (rad/s, critically damped). */
const AUTOLAND_LEAN = 6;
/** Least lift it keeps on the way down (× g): on next to none, the lean swung wild on every touch across. */
const AUTOLAND_LIFT = 0.5;
/**
 * Auto-land's boosted return: handed the suit on a fast pass that would
 * carry it further than {@link HOME_R} (m) out before it stopped, it doesn't
 * brake to a stop out there and crawl back at hover speed — it stays in
 * flight, boosts round onto the pad and back in, and only flares into the
 * run-in once a stop from where it is would leave it within
 * {@link HOME_LEAD} (m) short of the centre (and no more than
 * {@link HOME_PAST} past it). The stop it reckons on (m/s²), the height it
 * flies the leg at over the deck, and the least it keeps over anything
 * under or ahead of it (m).
 */
const HOME_R = 600;
const HOME_LEAD = 80;
const HOME_PAST = 150;
const HOME_DECEL = 42;
const HOME_ALT = 80;
const HOME_CLEAR = 40;

const UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Drag multiplier at a Mach number: 1 subsonic, rising to the barrier, a residue past it. */
const waveDrag = (mach: number) =>
  1 + WAVE_PEAK * smooth(0.8, 0.98, mach) - (WAVE_PEAK - WAVE_RESIDUE) * smooth(1.0, 1.12, mach);
/** Exponential approach: fraction of the gap closed in dt with time constant tau. */
const approach = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

/**
 * Minimum-jerk run-in across to a target: the jerk (m/s³) that starts the
 * smoothest path from offset (d, v, a) to rest on the target in T seconds.
 */
const runInJerk = (d: number, v: number, a: number, T: number) => (3 * (20 * d - 12 * v * T - 3 * a * T * T)) / (T * T * T);

/**
 * Shortest time (s) for a minimum-jerk run-in from offset (dx, dz) and
 * velocity (vx, vz), starting with no push, to rest on the target without
 * crossing faster than {@link AUTOLAND_SPEED}, pushing harder than
 * {@link AUTOLAND_PUSH} or swinging the push faster than {@link AUTOLAND_JERK}.
 */
function runInTime(dx: number, dz: number, vx: number, vz: number): number {
  for (let T = AUTOLAND_T_MIN; T < 40; T += 0.25) {
    // The quintic's coefficients (t² … t⁵) per axis
    const cx = [0, (20 * dx - 12 * vx * T) / (2 * T ** 3), (-30 * dx + 16 * vx * T) / (2 * T ** 4), (12 * dx - 6 * vx * T) / (2 * T ** 5)];
    const cz = [0, (20 * dz - 12 * vz * T) / (2 * T ** 3), (-30 * dz + 16 * vz * T) / (2 * T ** 4), (12 * dz - 6 * vz * T) / (2 * T ** 5)];
    let ok = true;
    for (let i = 0; i <= 24 && ok; i++) {
      const t = (i / 24) * T;
      const at = (c: number[], v0: number, k: number) =>
        k === 0 ? v0 + 2 * c[0] * t + 3 * c[1] * t * t + 4 * c[2] * t ** 3 + 5 * c[3] * t ** 4 : k === 1 ? 2 * c[0] + 6 * c[1] * t + 12 * c[2] * t * t + 20 * c[3] * t ** 3 : 6 * c[1] + 24 * c[2] * t + 60 * c[3] * t * t;
      ok =
        Math.hypot(at(cx, vx, 0), at(cz, vz, 0)) <= Math.max(AUTOLAND_SPEED, Math.hypot(vx, vz)) &&
        Math.hypot(at(cx, vx, 1), at(cz, vz, 1)) <= AUTOLAND_PUSH &&
        Math.hypot(at(cx, vx, 2), at(cz, vz, 2)) <= AUTOLAND_JERK;
    }
    if (ok) return T;
  }
  return 40;
}

export interface GroundProbe {
  /** Surface height under a point (ground or sea, m). */
  surface(x: number, z: number): number;
  /** True if the surface there is water. */
  isWater(x: number, z: number): boolean;
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
}

/** A landing pad the hover computer can capture over: centre (x, z) and deck height y. */
export interface LandingAid {
  x: number;
  z: number;
  y: number;
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
  /** Pitch rate the flight computer is asking for (rad/s, + = nose up): ramped, so the g builds. */
  private pitchCmd = 0;
  /** Diving onto an aim well below: rolled for a push, not a pull. */
  private pushOver = false;
  /** Lateral thrust trim for the HUD and the palms (−1…1). */
  trimRoll = 0;
  trimPitch = 0;
  /** Rate the airspeed is changing (m/s², + = speeding up), eased: the surge the camera and body ride. */
  surge = 0;
  /** Load factor (g) felt along the body this frame. */
  gLoad = 1;
  grounded = true;
  /** Air brake deployment 0–1 (flaps). */
  airbrake = 0;
  /** 0–1: how much of the body's lift the flare has spilled (leads the flaps). */
  liftSpill = 0;
  /** 0–1: carrying the speed round onto a new line (a momentum swing). */
  swing = 0;
  private swingOn = false;
  /** Way round (+1 left, −1 right) a turn onto an aim dead astern is going; 0 = not in one. */
  private guideSide = 0;
  /** Last step's flight-line lean (rad). */
  private leanPrev = 0;
  /** Which way the swing turns the travel (+ left, − right, × its strength). */
  swingTurn = 0;
  /** 0–1: boots cut and dropping (Q), eased in and out. */
  freefall = 0;
  /** 0–1: the palms firing against the travel (X), eased. */
  palmBrake = 0;
  /** The pad the hover computer captures over, if there is one. */
  landingAid: LandingAid | null = null;
  /** 0–1: how firmly the pad capture is holding the hover over its centre. */
  padPull = 0;
  /** The hover computer is flying the suit down onto the landing aid's centre. */
  autoLand = false;
  /** Auto-land is flying the boosted leg back to the pad (see {@link HOME_R}), not the run-in. */
  homing = false;
  /** The pilot's input as auto-land's boosted leg flies it. */
  private readonly homeIn = EMPTY_INPUT();
  /** The line the body leans to under auto-land, and how fast it's swinging (see {@link leanLine}). */
  private readonly lean = new THREE.Vector3(0, 1, 0);
  private readonly leanVel = new THREE.Vector3();
  private readonly _lp = new THREE.Vector3();
  /** Auto-land's planned push across (m/s², x/z), its time to go (s), and whether a run-in is under way. */
  readonly landPush = new THREE.Vector3();
  private landT = 0;
  private landOn = false;
  /** 0–1: auto-land's hold on the centre before it lets down (1: locked on, sinking). */
  landLock = 0;
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
  /** Speed the boots still hold after a boost, bleeding back to the throttle (m/s). */
  private boostCarry = 0;
  /** 0–1: the boots spooled up to the boost's authority. */
  private spool = 0;

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
  private readonly _aim = new THREE.Vector3();
  private readonly _swingAcc = new THREE.Vector3();

  constructor(readonly ground: GroundProbe) {}

  /** Stand on the ground at a point, facing a heading (rad, 0 = +Z). */
  placeOnGround(x: number, z: number, heading: number): void {
    this.pos.set(x, this.ground.surface(x, z) + this.hipHeight(), z);
    this.vel.set(0, 0, 0);
    this.q.setFromAxisAngle(UP, heading);
    this.omega.set(0, 0, 0);
    this.yawAcc = 0;
    this.pitchCmd = 0;
    this.pushOver = false;
    this.posture = 0;
    this.postureVel = 0;
    this.flightness = 0;
    this.speedCmd = 0;
    this.boostCarry = 0;
    this.spool = 0;
    this.thrust = 0;
    this.grounded = true;
    this.crouch = 0;
    this.freefall = 0;
    this.palmBrake = 0;
    this.liftSpill = 0;
    this.swing = 0;
    this.swingOn = false;
    this.swingTurn = 0;
    this.leanPrev = 0;
    this.guideSide = 0;
    this.padPull = 0;
    this.autoLand = false;
    this.homing = false;
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
  /** Airspeed the boots are flying to: the boost's, a boost still bleeding off, or the throttle's. */
  get speedTarget(): number {
    return this.boosting ? BOOST_SPEED : Math.max(this.speedCmd, this.boostCarry);
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
    input = this.homeInput(input);
    const landing = this.autoLand && !this.homing;
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
    if (input.stance || falling) {
      this.speedCmd = Math.max(0, this.speedCmd - 220 * dt);
    } else if (input.brake) {
      // The throttle rides the airspeed down with the brakes: let go and the
      // suit holds what it has left instead of coasting on down to idle
      // (all but stopped, it's idle: a let-go at a crawl held the crawl, and
      // the hover crept on forever at a few m/s)
      this.speedCmd = speed < BRAKE_IDLE ? 0 : Math.min(this.speedCmd, speed);
    } else if (this.airT > HOP_THROTTLE) {
      // (a W held through the hop waits for it to clear the deck; pushed up
      // from under the airspeed, it picks up from there, not from the idle)
      if (input.throttle > 0) this.speedCmd = Math.max(this.speedCmd, Math.min(speed, CRUISE_MAX));
      this.speedCmd = clamp(this.speedCmd + input.throttle * 85 * dt, 0, CRUISE_MAX);
    }
    // Off the boost, the target rides the airspeed down to the throttle; the
    // brakes, the stance, a fall or S drop it (they set their own pace)
    if (this.boosting) this.boostCarry = speed;
    else if (input.brake || input.stance || falling || input.throttle < 0) this.boostCarry = 0;
    else this.boostCarry = Math.min(speed, Math.max(this.speedCmd, this.boostCarry - BOOST_BLEED * dt));
    const carrying = !this.boosting && this.boostCarry > this.speedCmd;
    // In a hover, forward stick alone carries you into flight once you're quick
    // (a fall is not flight, however fast it gets)
    // X drops it out of flight at once (not once the throttle has run
    // down): the body is the brakes' now, free to swing round onto the aim
    const wantFlight = !falling && !input.brake && !landing && (this.boosting || this.speedCmd > 28 || (speed > 40 && !input.stance));
    const flightGoal = wantFlight && !this.grounded ? 1 : 0;
    // Already quick (out of a flare), the body swings straight back over
    const riseTau = THREE.MathUtils.lerp(0.55, 0.3, smooth(40, 120, speed));
    this.flightness += (flightGoal - this.flightness) * approach(dt, flightGoal > this.flightness ? riseTau : landing ? 0.2 : input.brake ? 0.6 : 0.4);
    if (this.grounded) this.flightness = 0;
    const fl = smooth(0.05, 0.95, this.flightness);

    // ── Attitude: mouse aim ──────────────────────────────────────────
    const aim = this._a.copy(input.aim).normalize();
    // Aim in the flight frame — in full flight, measured off the suit's long
    // axis (the line it flies along), not the frame's nose a few degrees
    // below it: the nose held on the aim left the path climbing off it
    const lean = (this.posture - Math.PI / 2) * smooth(0.85 * FLIGHT_POSTURE, FLIGHT_POSTURE, this.posture) * fl;
    // As that reference slides from the nose onto the axis the frame
    // counter-pitches, so the line it flies doesn't move: shifted under it,
    // the body's lift chased the new line and porpoised ±13 g swinging
    // back over out of a flare
    this.q.multiply(this._q2.setFromAxisAngle(this._n.set(1, 0, 0), this.leanPrev - lean));
    this.leanPrev = lean;
    this._q.copy(this.q).multiply(this._q2.setFromAxisAngle(this._n.set(1, 0, 0), lean));
    // Never over the top: steered at an aim far round behind (or past the
    // vertical), the shortest way there pitched the body up through the
    // vertical, a half loop that left it on its back — and the roll-out
    // flipped it over. Fly at a waypoint instead that leads the turn round
    // by heading, no more than a quarter turn off where the body points and
    // short of the vertical, so the body banks and carves round the long way,
    // head up, onto the aim
    if (!input.stance) this.guideAim(aim, this._q, fl);
    this._q.invert();
    const al = this._t.copy(aim).applyQuaternion(this._q);
    const yawErr = Math.atan2(al.x, al.z);
    const pitchErr = Math.atan2(al.y, Math.hypot(al.x, al.z)); // + = aim above the nose
    // The body only lifts with the nose held a little above its path, so a
    // nose on the aim left the path sagging under it — 0.3° at cruise, 2° at
    // 100 m/s, a steady sink below wherever the pilot looked. Fly the path
    // onto the aim instead: carry the nose the angle of attack the wing needs
    // to hold the path against gravity (as the lift below is reckoned)
    const fallK = input.vertical < 0 ? 1 + input.vertical : 1;
    const liftK = fl * (1 - 0.95 * this.liftSpill) * (1 - this.swing) * fallK;
    let aoa = 0;
    if (liftK > 0.2 && speed > 20) {
      const upL = this._v.copy(UP).applyQuaternion(this._q).y;
      const velL = this._n.copy(this.vel).applyQuaternion(this._q).y / speed;
      const need = GRAVITY * (upL - (this.vel.y / speed) * velL);
      const rhoNow = Math.exp(-Math.max(0, this.pos.y) / 8500);
      aoa = Math.asin(clamp(need / (LIFT * rhoNow * liftK * speed * speed), -0.12, 0.12)) * smooth(0.2, 0.5, liftK);
    }
    // Bank for the turn, as a jet sets it: the lift has to carry the turn the
    // aim asks for and hold the suit up against gravity, so the back rolls
    // toward their sum — tan(bank) = turn pull / 1 g — and the pull does
    // the turning, not a yaw skid. (A dive or a zoom is a pitch, no bank)
    const bank = Math.atan2(l.y, u.y); // + = right wing low (left wing up)
    let bankTurn = 0;
    // (climbing or diving steeply there's little gravity across the path to
    // bank against, and a bank that steep with the nose high rolled it past
    // the vertical onto its back; mid-swing the carve banks it, not the wing)
    let bankMax = THREE.MathUtils.lerp(BANK_MAX, 1.15, this.swing);
    if (speed > 20) {
      const vDir = this._v.copy(this.vel).divideScalar(speed);
      const levelL = this._n.crossVectors(UP, vDir);
      const flatK = levelL.length();
      bankMax = Math.min(bankMax, THREE.MathUtils.lerp(BANK_MAX, 1.15, smooth(0.35, 0.75, Math.abs(vDir.y))));
      if (flatK > 0.3) {
        levelL.divideScalar(flatK);
        // The aim off the travel, round (+ right) and up, as angles
        const ahead = aim.dot(vDir);
        const offRight = Math.atan2(-aim.dot(levelL), ahead);
        const offUp = Math.atan2((aim.y - ahead * vDir.y) / flatK, ahead);
        // (no steeper than the pull it's building to: banked past the g,
        // the lift can't hold it up and it sinks into the turn)
        const pulling = Math.min(G_LIMIT, Math.max(ROLL_PULL_G, (Math.abs(this.pitchCmd) * speed) / GRAVITY + 1.5)) * GRAVITY;
        // (a nudge of a few degrees the boots' skid takes, wings level: banked
        // for it, a roll-out a hair past the heading rolled hard the other way)
        const skid = SKID_G * GRAVITY * 0.5;
        const right = clamp(Math.sign(offRight) * Math.max(0, Math.abs(offRight) * TURN_GAIN * speed - skid), -pulling, pulling);
        // The climb is held on the bank: sinking under the aim, it rolls
        // a little out of the turn so the lift holds it up (the pull alone,
        // square to the horizon, can't). A hair above the aim it doesn't roll
        // in for it (a roll-out a hair past the heading and a hair high
        // flicked over into a steep bank the other way); well round, the turn
        // comes first and the climb waits (pulled straight up for an aim high
        // behind, it went up and over onto its back)
        const climbRoom = pulling * Math.max(0.2, 1 - Math.abs(offRight) / 0.9);
        const upward = clamp(offUp * CLIMB_GAIN * speed, -0.3 * GRAVITY, climbRoom);
        // Well below the aim and all but round onto it, it pushes over instead: the
        // back rolls away from the turn so the push (G_PUSH at most) carries
        // the nose down onto it. Banked into the turn, the aim sat off the
        // wing where neither the pull nor the push reached it, and it hung
        // (only all but round: it turns on the pull, never a push)
        if (offUp < -0.35 && Math.abs(offRight) < 0.35) this.pushOver = true;
        else if (offUp > -0.15 || Math.abs(offRight) > 0.6) this.pushOver = false;
        if (this.pushOver) {
          const down = Math.min(-offUp * CLIMB_GAIN * speed, (G_PUSH + 1) * GRAVITY) - GRAVITY * flatK;
          bankTurn = Math.atan2(-right, Math.max(down, 0.3 * GRAVITY));
        } else bankTurn = Math.atan2(right, GRAVITY * flatK + upward);
      }
    }
    // Slow, there's too little air on the body to bank against: it turns on
    // the boots' vectoring, banked over by the look like a hover; and
    // mid-swing the carve throws it round the same way
    const vectored = Math.max(this.swing, 1 - smooth(50, 100, speed));
    bankTurn = THREE.MathUtils.lerp(bankTurn, clamp(-yawErr * 2.4, -1.25, 1.25), vectored);
    const bankGoal = clamp(bankTurn * fl - this.swingTurn * 1.2, -bankMax, bankMax);
    // Turn limits: quick in a hover; in flight the g limit caps the rate at
    // speed, and until the back has rolled round into the turn it only pulls
    // a couple of g — roll, then pull
    const flTurn = input.stance ? 0 : fl * (1 - this.swing);
    const rolled = smooth(0.2, 0.7, Math.abs(bankGoal - bank) * flTurn);
    const gRate = (THREE.MathUtils.lerp(G_LIMIT, ROLL_PULL_G, rolled) * GRAVITY) / Math.max(60, speed);
    const maxPitch = THREE.MathUtils.lerp(2.6, Math.min(2.4, gRate), flTurn);
    const minPitch = THREE.MathUtils.lerp(2.6, Math.min(2.4, (G_PUSH * GRAVITY) / Math.max(60, speed)), flTurn);
    const skidYaw = THREE.MathUtils.lerp(SKID_G, G_LIMIT * 0.8, vectored);
    const maxYaw = THREE.MathUtils.lerp(3.2, Math.min(1.6, (skidYaw * GRAVITY) / Math.max(60, speed)), flTurn);
    // (in the stance the body stands upright whatever the aim: the beam
    // swings, not the suit)
    // The pull builds at the onset limit, not on the first frame: a
    // flight-path turn of rate ω pulls v·ω, so the pitch rate ramps at
    // G_ONSET·g / v (quicker letting go; a hover's not limited). Coming up
    // on the aim it lets go in time to stop on it (√(2·a·err), as the yaw):
    // still pulling hard as it got there, it ran past and zoomed
    // (slow, the nose is only pointing the boots — the body's not pulling
    // on the air — so it swings round as a hover's would)
    const onset = THREE.MathUtils.lerp(40, (G_ONSET * GRAVITY) / Math.max(60, speed), flTurn * (1 - vectored));
    const pitchStop = Math.sqrt(2 * onset * 3 * 0.75 * Math.abs(pitchErr + aoa));
    const pitchGoal = input.stance
      ? 0
      : clamp((pitchErr + aoa) * 5.5, -Math.min(minPitch, pitchStop), Math.min(maxPitch, pitchStop)) * THREE.MathUtils.lerp(0.25, 1, fl);
    const loading = Math.abs(pitchGoal) > Math.abs(this.pitchCmd) && pitchGoal * this.pitchCmd >= 0;
    const ramp = onset * (loading ? 1 : 3) * dt;
    this.pitchCmd += clamp(pitchGoal - this.pitchCmd, -ramp, ramp);
    const wantPitch = this.pitchCmd;
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
    const nearVertical = Math.abs(f.y) > 0.93;
    let wantRoll: number;
    if (input.stance) {
      // Stood up for the unibeam: no bank. (Upright, the flight roll axis
      // — the long axis — is the vertical: a bank into the turn there
      // spun the suit round away from the aim, onto its reciprocal)
      wantRoll = 0;
    } else if (fl > 0.2 && Math.abs(input.lateral) > 0.05) {
      wantRoll = input.lateral * 3.4 * fl;
    } else if (nearVertical) {
      wantRoll = 0;
    } else {
      // (swinging the speed round, it banks hard into the carve)
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
    // (keeping the heading); flight keeps the attitude it was flown into.
    // The unibeam stance stands it bolt upright, straight out of flight
    // (not once the flightness has run down): it fires from the stance
    if (fl < 0.999 || input.stance) {
      const fNow = this.forward(this._f);
      const heading = Math.atan2(fNow.x, fNow.z);
      const pitchNow = Math.asin(clamp(fNow.y, -1, 1));
      // Hover pitch: a gentle nod toward the aim (the head does the rest)
      const hoverPitch = input.stance ? 0 : clamp(pitchErr + pitchNow, -0.5, 0.5) * 0.25;
      this._q.setFromEuler(new THREE.Euler(-hoverPitch, heading, 0, 'YXZ'));
      this.q.slerp(this._q, input.stance ? approach(dt, 0.1) : approach(dt, 0.12) * (1 - fl));
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
    // (braking, it flies to a stop: the throttle riding the airspeed down
    // left it wanting most of the speed it was shedding, and the last few
    // m/s crept out over seconds)
    const vWant = new THREE.Vector3()
      .addScaledVector(fwdFlat, (input.forward + (input.brake ? 0 : this.speedCmd / 30)) * HOVER_SPEED)
      .addScaledVector(leftFlat, -input.lateral * HOVER_SPEED * 0.8);
    vWant.y = input.vertical * CLIMB_SPEED;
    // Just off the deck: keep climbing clear whatever the stick says
    if (this.airT < HOP_GUARD) vWant.y = Math.max(vWant.y, 4);
    // Height first, then what thrust is left goes to the horizontal (a real
    // VTOL computer never trades altitude for a stop)
    // (auto-land runs the boots hotter, as the boost does: it's in a hurry)
    const hoverMax = THRUST_MAX * (landing ? AUTOLAND_THRUST : 1.1) * ceilingK;
    const hoverAcc = vWant.sub(this.vel).multiplyScalar(1.6);
    // Braking, a firmer hold on the horizontal: the stop settles, not drifts
    if (input.brake) {
      hoverAcc.x *= BRAKE_SETTLE / 1.6;
      hoverAcc.z *= BRAKE_SETTLE / 1.6;
    }
    // Hands off over the pad: hold the hover over its centre
    this.padPull += (this.padCapture(input, fl, carrying) - this.padPull) * approach(dt, 0.2);
    const aid = this.landingAid;
    if (!landing) {
      this.landOn = false;
      this.landLock = 0;
    }
    if (aid && landing) {
      this.padPull = 1;
      this.autoLandAcc(aid, hoverAcc, dt);
    } else if (aid && this.padPull > 1e-3) {
      const ax = (aid.x - this.pos.x) * PAD_HOLD_K - this.vel.x * PAD_HOLD_D;
      const az = (aid.z - this.pos.z) * PAD_HOLD_K - this.vel.z * PAD_HOLD_D;
      const k = Math.min(1, PAD_HOLD_MAX / Math.max(1e-6, Math.hypot(ax, az)));
      hoverAcc.x = THREE.MathUtils.lerp(hoverAcc.x, ax * k, this.padPull);
      hoverAcc.z = THREE.MathUtils.lerp(hoverAcc.z, az * k, this.padPull);
    }
    hoverAcc.y = clamp(hoverAcc.y + GRAVITY, 0, hoverMax);
    // Well over hover speed (flaring out of flight) the boots only lean back
    // so far: the stop is a long, heavy bleed, not the VTOL's crisp one. And
    // only the brakes or the stance ask for that stop: let go of X at speed
    // and the hover computer doesn't pull against the travel while the body
    // swings back over into flight
    const hvNow = Math.hypot(this.vel.x, this.vel.z);
    const against = hoverAcc.x * this.vel.x + hoverAcc.z * this.vel.z < 0;
    // (auto-land has the boots' full authority sideways: it planned its stop)
    const fastPull = landing ? hoverMax : against ? HOVER_BRAKE_FAST * Math.max(this.airbrake, input.stance ? 1 : 0) : HOVER_BRAKE_FAST;
    // (braking, the palms already pull against the travel: the boots leave
    // them room, or the stop bit harder again as the boots got their full
    // authority back at the slow end)
    const slowPull = input.brake ? hoverMax - PALM_BRAKE * this.palmBrake : hoverMax;
    const side = Math.min(
      Math.sqrt(Math.max(0, hoverMax * hoverMax - hoverAcc.y * hoverAcc.y)),
      THREE.MathUtils.lerp(slowPull, fastPull, smooth(HOVER_SPEED * 1.5, HOVER_SPEED * 4, hvNow)),
    );
    const hl = Math.hypot(hoverAcc.x, hoverAcc.z);
    if (hl > side) {
      hoverAcc.x *= side / hl;
      hoverAcc.z *= side / hl;
    }
    const hoverThrust = Math.min(hoverAcc.length(), hoverMax);
    const hoverDir = hoverAcc.lengthSq() > 1e-6 ? hoverAcc.normalize() : hoverAcc.copy(UP);

    // Flight computer: hold the commanded airspeed with the boots
    const target = this.speedTarget;
    const along = this.vel.dot(axis);
    const wave = waveDrag(speed / SPEED_OF_SOUND);
    const dragHere = DRAG * wave * rho * speed * speed;
    const need = dragHere + GRAVITY * axis.y + (target - along) * 0.9;
    // (still carrying a boost, the boots keep the boost's authority to hold
    // the bleed against the drag rise)
    // (lit, they spool up to it from what they were giving rather than
    // stepping onto it: the kick builds from nothing, peaks, and holds)
    const boostOn = this.boosting || carrying;
    this.spool += ((boostOn ? 1 : 0) - this.spool) * approach(dt, BOOST_SPOOL);
    const tFrom = boostOn ? Math.min(this.thrust, THRUST_MAX) : THRUST_MAX;
    const tMax = THREE.MathUtils.lerp(tFrom, THRUST_BOOST, this.spool) * ceilingK;
    const flightThrust = clamp(need, 0, tMax);

    // Blend the regimes
    const thrustDir = new THREE.Vector3().copy(hoverDir).lerp(axis, fl).normalize();
    // Falling, the boots are cut
    const thrust = falling ? 0 : THREE.MathUtils.lerp(hoverThrust, flightThrust, fl);
    const grounded = this.grounded && thrust < GRAVITY * 1.02 && input.vertical <= 0;
    // The boots spool like turbines: wound down near idle they're slow to
    // take up the throttle again (a beat before the push builds), running
    // hot they answer at once
    const thrustGoal = grounded ? 0 : thrust * this.power;
    const spooled = smooth(0.1, 0.45, this.thrust / THRUST_MAX);
    const spoolTau = thrustGoal > this.thrust ? THREE.MathUtils.lerp(SPOOL_IDLE, 0.12, spooled) : 0.16;
    this.thrust += (thrustGoal - this.thrust) * approach(dt, spoolTau);
    this.throttle = clamp(this.thrust / THRUST_BOOST, 0, 1);
    acc.addScaledVector(thrustDir, this.thrust);

    // ── Momentum swing ───────────────────────────────────────────────
    // Out of a flare (or a hover at speed) with the aim swung well round
    // from the travel, pushing off again — or flat out, punching the boost
    // with the aim astern — doesn't stop the suit and start over: the boots and palms carve the velocity round onto the aim at a
    // steady rate under the g limit, paying for the turn in speed, the body banked hard into the carve
    const goingOn = !input.brake && !input.stance && !falling && wantFlight;
    const aimDir = this._aim.copy(input.aim).normalize();
    const offAim = speed > 1 ? Math.acos(clamp(this.vel.dot(aimDir) / speed, -1, 1)) : 0;
    // (on until it's carved round to within a few degrees, then done: the
    // wing settles the last of it)
    const swingStart = this.flightness < 0.6 ? SWING_START : this.boosting ? SWING_START_BOOST : Infinity;
    if (goingOn && speed > 30 && offAim > swingStart) this.swingOn = true;
    if (!goingOn || offAim < 0.08) this.swingOn = false;
    const swingGoal = this.swingOn ? 1 : 0;
    this.swing += (swingGoal - this.swing) * approach(dt, swingGoal ? SWING_ENTRY : 0.2);
    if (this.swing > 1e-3 && speed > 1) {
      const vDir = this._v.copy(this.vel).divideScalar(speed);
      // None of the boots' push goes into fighting the old travel, and what
      // they push sideways is the carve's (below), not on top of it
      const tAlong = thrustDir.dot(vDir);
      acc.addScaledVector(thrustDir, -this.thrust * this.swing);
      acc.addScaledVector(vDir, Math.max(0, tAlong) * this.thrust * this.swing);
      // Turn axis: travel × aim; dead astern, keep the way it was turning
      // (or the body's yaw) and swing round flat
      const n = this._n.crossVectors(vDir, aimDir);
      if (n.lengthSq() < 1e-4) n.set(0, this.swingTurn || Math.sign(this.omega.y) || 1, 0);
      n.normalize();
      // Eased in by the swing and settled onto the aim over the last ~20°
      // (capped at SWING_G: the faster it's going, the wider the arc)
      const rate = Math.min(SWING_RATE, (SWING_G * GRAVITY) / speed) * smooth(0, 1, this.swing) * Math.min(1, offAim / 0.35);
      this._swingAcc.copy(this.vel);
      const carve = Math.min(rate * dt, offAim);
      this.vel.applyAxisAngle(n, carve).multiplyScalar(Math.exp(-SWING_COST * carve));
      this._swingAcc.subVectors(this.vel, this._swingAcc).divideScalar(Math.max(dt, 1e-4));
      this.swingTurn = this.swing * clamp(n.y * 3, -1, 1);
      // With the wing out of it the boots hold the climb on the aim's (no
      // sag from the bank, no zoom off the half-tilted thrust)
      acc.y = THREE.MathUtils.lerp(acc.y, (aimDir.y * this.vel.length() - this.vel.y) * 3, this.swing);
    } else {
      this.swingTurn *= 1 - approach(dt, 0.2);
      this._swingAcc.set(0, 0, 0);
    }

    // In a hover the suit leans to its thrust: bring the frame's up toward it
    // (not in the stance: the boots vector under it to shed the speed)
    // (auto-land leans to a line swung smoothly round after the thrust, so
    // the body rolls from the run-in into the stop as one move: the plan
    // re-flown every step still trims the push in small quick corrections)
    const leanTo = this.leanLine(thrustDir, landing, dt);
    if (fl < 0.95 && !this.grounded && !falling && !input.stance) {
      const upNow = this.up(this._u);
      this._q.setFromUnitVectors(upNow, leanTo);
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
    // Holding S well over the setting cracks the flaps as speed brakes: a
    // firmer bleed than the drag alone, nothing like the full flare
    const speedBrake = !input.brake && input.throttle < 0 && fl > 0.5 && speed > this.speedCmd + 15;
    this.airbrake += ((input.brake ? 1 : speedBrake ? SPEED_BRAKE : 0) - this.airbrake) * approach(dt, 0.15);
    // The wing spills its lift ahead of the flaps: the body pitches up into
    // the flare at once, and a wing still flying then ballooned it 9 g up
    this.liftSpill += ((input.brake ? 1 : 0) - this.liftSpill) * approach(dt, input.brake ? 0.04 : 0.15);
    // (the cap opens with the flaps: at Mach 1 even a crack of flap would
    // hit it, and the brakes bit as a step on the first frame)
    const flareCap = FLARE_DRAG_MAX * smooth(0, 1, Math.max(this.airbrake, 1 - fl));
    const flareDrag = Math.min(DRAG * (this.airbrake * 5 + (1 - fl) * 3) * rho * speed * speed, flareCap) * (1 - this.swing);
    const dragK = rho * THREE.MathUtils.lerp(DRAG * wave, FALL_DRAG, this.freefall);
    acc.addScaledVector(this.vel, -(dragK * speed + (flareDrag * (1 - this.freefall)) / Math.max(speed, 1)));
    // Falling, the hands and legs steer it a little (forward / sideways)
    if (falling) {
      const hx = vWant.x - this.vel.x;
      const hz = vWant.z - this.vel.z;
      const hl2 = Math.hypot(hx, hz);
      if (hl2 > 1e-3) acc.add(this._v.set(hx, 0, hz).multiplyScalar(Math.min(FALL_STEER, hl2 * 1.5) / hl2));
    }
    // Palm jets against the travel: X
    const palmGoal = input.brake && !this.grounded ? smooth(2, 14, speed) : 0;
    this.palmBrake += (palmGoal - this.palmBrake) * approach(dt, palmGoal > this.palmBrake ? 0.3 : 0.12);
    // (along the ground: the boots hold the height)
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (this.palmBrake > 1e-3 && hv > 0.5) {
      const k = (-PALM_BRAKE * this.palmBrake * this.power * Math.min(1, hv / 3)) / hv;
      acc.x += this.vel.x * k;
      acc.z += this.vel.z * k;
    }

    // Body lift: pull the velocity onto the nose (flight only)
    if (fl > 0.01 && speed > 1) {
      // Onto the line the computer is flying (the long axis in full flight;
      // the nose while the body is still swinging over, or a nose-high
      // axis coming back out of a flare zoomed it 50 m up)
      const fNow = this._f.set(0, -Math.sin(lean), Math.cos(lean)).applyQuaternion(this.q);
      const perp = this._v.copy(this.vel).addScaledVector(fNow, -this.vel.dot(fNow));
      // Flared for the brakes the body is a parachute, not a wing: no balloon
      // Full down kills the wing so the body falls instead of gliding
      const fall = input.vertical < 0 ? 1 + input.vertical : 1;
      // and the pitch-up of the flare doesn't slam it (the load is capped low)
      const lift = perp.multiplyScalar(-LIFT * speed * rho * fl * (1 - 0.95 * this.liftSpill) * (1 - this.swing) * fall);
      // Lift works square to the travel: the part of it along the path made
      // a broadside body (swinging back out of a flare) a second airbrake
      lift.addScaledVector(this.vel, -lift.dot(this.vel) / (speed * speed));
      // (and swinging, the wing hands its share of the g to the carve: the
      // two never stack past the swing's limit)
      const gCap = THREE.MathUtils.lerp(G_LIMIT, 1, Math.min(1, this.liftSpill * 2)) * GRAVITY * (1 - this.swing);
      const ll = lift.length();
      if (ll > gCap) lift.multiplyScalar(gCap / ll);
      acc.add(lift);
      // Induced drag: the body's push on the air tilts back with the angle
      // it meets it at (L·tan α), so a hard pull slow, nose well up, mushes
      // and bleeds; quick, the same g barely costs (a floor for the flaps).
      // (Not while it swings back over out of a flare: broadside to the
      // stream it's the flaps' drag, already reckoned)
      const alpha = Math.min(AOA_MAX, Math.acos(clamp(this.vel.dot(fNow) / speed, -1, 1)));
      const tilt = 0.045 + Math.max(0, Math.tan(alpha) - 0.045) * smooth(0.85, 1, this.flightness);
      acc.addScaledVector(this.vel, -(Math.min(ll, gCap) * tilt) / Math.max(speed, 1));
    }
    // Strafe / climb trim from the palms in flight
    if (fl > 0.5) acc.addScaledVector(UP, Math.max(0, input.vertical) * 6 * fl);
    // However fast the brakes meet the air, the stop tops out at a hard 6 g
    if (this.airbrake > 1e-3 && speed > 1) {
      const vDir = this._v.copy(this.vel).divideScalar(speed);
      const over = -acc.dot(vDir) - BRAKE_DECEL_MAX;
      if (over > 0) acc.addScaledVector(vDir, over * this.airbrake);
    }

    this.vel.addScaledVector(acc, dt);
    this.surge += ((this.vel.length() - speed) / Math.max(dt, 1e-4) - this.surge) * approach(dt, 0.15);
    this.pos.addScaledVector(this.vel, dt);
    // Felt load, as a G meter reads it: the normal load factor — the
    // acceleration minus gravity along the lift axis (out of the back in
    // flight, square to the long axis; up the thrust line in a hover).
    // Thrust, drag and the brakes along the path don't count, and inverted
    // it reads negative (an aileron roll swings it +1 → −1 → +1)
    const felt = this._v.copy(this.vel).sub(this._prevVel).divideScalar(Math.max(dt, 1e-4));
    felt.y += GRAVITY;
    // (the suit's dampers soak up the top of a swing's carve: at its
    // hardest it reads as the wing's limit pull, not the full SWING_G)
    felt.addScaledVector(this._swingAcc, -(1 - G_LIMIT / SWING_G));
    const liftAxis = this._t.set(0, 1, 0).applyAxisAngle(this._n.set(1, 0, 0), lean).applyQuaternion(this.q);
    // (mid-swing the body isn't square to the carve — flared upright, it
    // read as a −8 g push — so the meter reads the pull's size, as felt)
    const pull = THREE.MathUtils.lerp(felt.dot(liftAxis), felt.length(), this.swing);
    this.gLoad += (pull / GRAVITY - this.gLoad) * approach(dt, 0.25);

    this.collide(input);
    this.syncGait(dt);
  }

  /**
   * Bend an aim (in place) into the waypoint the attitude flies at: within
   * {@link GUIDE_TURN} of the body's heading and {@link GUIDE_PITCH} of the
   * horizon, blended in with the flight regime (a hover pivots on the spot).
   */
  private guideAim(aim: THREE.Vector3, frame: THREE.Quaternion, fl: number): void {
    if (fl < 1e-3) return;
    const f = this._v.set(0, 0, 1).applyQuaternion(frame);
    const u = this._n.set(0, 1, 0).applyQuaternion(frame);
    // Heading off the nose — or, pointing up or down the vertical, off the
    // belly (where the nose is headed as it comes back over to the horizon)
    const hx = f.x - u.x * f.y;
    const hz = f.z - u.z * f.y;
    const heading = Math.atan2(hx, hz);
    const aimH = Math.hypot(aim.x, aim.z);
    let turn = aimH > 1e-4 ? Math.atan2(Math.sin(Math.atan2(aim.x, aim.z) - heading), Math.cos(Math.atan2(aim.x, aim.z) - heading)) : 0;
    // With the aim all but dead astern, stay on the way round it was already
    // going (or banked into): picked afresh each frame, the waypoint flicked
    // side to side across the seam and the body hung on it, turning neither way
    if (Math.abs(turn) > GUIDE_ASTERN) {
      if (!this.guideSide) {
        const upLeft = u.x * Math.cos(heading) - u.z * Math.sin(heading);
        this.guideSide = Math.sign(Math.abs(upLeft) > 0.05 ? upLeft : this.omega.y || turn) || 1;
      }
      turn = this.guideSide * Math.abs(turn);
    } else if (Math.abs(turn) < GUIDE_ASTERN - 0.2) this.guideSide = 0;
    const h = heading + clamp(turn, -GUIDE_TURN, GUIDE_TURN);
    const p = clamp(Math.atan2(aim.y, aimH), -GUIDE_PITCH, GUIDE_PITCH);
    const gx = Math.sin(h) * Math.cos(p);
    const gy = Math.sin(p);
    const gz = Math.cos(h) * Math.cos(p);
    aim.set(aim.x + (gx - aim.x) * fl, aim.y + (gy - aim.y) * fl, aim.z + (gz - aim.z) * fl).normalize();
  }

  /** Keep the legs' contacts in step with the ground state. */
  private syncGait(dt: number): void {
    const g = this.gait;
    if (this.grounded && !g.attached) g.attach(this.pos, this.heading, this.ground);
    else if (!this.grounded && g.attached) g.detach(this.pos, this.bodyQuaternion(this._q));
    if (!this.grounded) g.step(dt, this.pos, this.heading, this.vel, this.omega.y, this.crouch, this.ground);
  }

  /**
   * On foot: turn to the look on stepping feet, walk / sidestep
   * relative to it, step up kerbs and down ledges, stop at walls.
   */
  private stepWalk(dt: number, input: FlightInput): void {
    this._prevVel.copy(this.vel);
    const ground = this.ground;
    const stuck = this.crouch > 0 || this.power < 0.5;
    // Intent: W/S (or the stick) forward, A/D sideways
    let fwdIn = Math.abs(input.throttle) >= Math.abs(input.forward) ? input.throttle : input.forward;
    let latIn = input.lateral;
    if (stuck) fwdIn = latIn = 0;
    fwdIn = clamp(fwdIn, -1, 1);
    latIn = clamp(latIn, -1, 1);
    const moving = Math.hypot(fwdIn, latIn) > 0.08;

    // ── Heading: the body follows the look ──────────────────────────
    const aim = this._a.copy(input.aim);
    const aimHeading = Math.hypot(aim.x, aim.z) > 1e-3 ? Math.atan2(aim.x, aim.z) : this.heading;
    const heading = this.heading;
    const yawErrRaw = Math.atan2(Math.sin(aimHeading - heading), Math.cos(aimHeading - heading));
    if (moving || Math.abs(yawErrRaw) > 0.7) this.walkTurn = true;
    else if (Math.abs(yawErrRaw) < 0.03 && Math.abs(this.omega.y) < 0.2) this.walkTurn = false;
    const yawErr = this.walkTurn && !stuck ? yawErrRaw : 0;
    // The same eased S-curve as the air, at a walker's rates
    const maxYaw = 2.1;
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
    const vF = fwdIn >= 0 ? WALK_SPEED : BACK_SPEED;
    const vS = STRAFE_SPEED;
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
      // Ride the boots, easing over steps (the weight goes up a step with
      // the boot that's planted there)
      const ride = this.gait.attached ? this.gait.support() : there;
      this.pos.y += (ride + hip - this.pos.y) * approach(dt, 0.07);
    }

    // ── Flight state at rest ─────────────────────────────────────────
    this.speedCmd = 0;
    this.boostCarry = 0;
    this.surge *= 1 - approach(dt, 0.15);
    this.flightness = 0;
    this.boosting = false;
    this.thrust *= 1 - approach(dt, 0.12);
    this.throttle = clamp(this.thrust / THRUST_BOOST, 0, 1);
    this.airbrake *= 1 - approach(dt, 0.15);
    this.liftSpill *= 1 - approach(dt, 0.15);
    this.swing = 0;
    this.swingOn = false;
    this.leanPrev = 0;
    this.swingTurn = 0;
    this.palmBrake *= 1 - approach(dt, 0.12);
    this.freefall = 0;
    this.padPull = 0;
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

  /**
   * Auto-land guidance: across to the centre on a minimum-jerk run-in,
   * down a glide slope to the deck (clear of anything on the way), and onto
   * it only once over the mark, at a brisk but soft sink.
   *
   * The run-in is re-planned every step from where the suit really is, to
   * arrive at rest on the mark as the time to go runs out (holding a short
   * time to go at the end, so it settles on the centre rather than lunging
   * for it). The push only ever changes by the plan's jerk, so the lean
   * swings smoothly from the run-in into the stop instead of flicking over.
   */
  private autoLandAcc(aid: LandingAid, out: THREE.Vector3, dt: number): void {
    const ex = aid.x - this.pos.x;
    const ez = aid.z - this.pos.z;
    const d = Math.hypot(ex, ez);
    const p = this.landPush;
    if (!this.landOn) {
      this.landOn = true;
      p.set(0, 0, 0);
      this.landT = runInTime(ex, ez, this.vel.x, this.vel.z);
      this.landLock = 0;
    }
    this.landT = Math.max(THREE.MathUtils.lerp(AUTOLAND_T_TRIM, AUTOLAND_T_END, smooth(0.3, 1.5, d)), this.landT - dt);
    p.x += runInJerk(ex, this.vel.x, p.x, this.landT) * dt;
    p.z += runInJerk(ez, this.vel.z, p.z, this.landT) * dt;
    // (the air and the brakes' share is the plan's to take up: it's flown
    // again from where they've left the suit every step)
    out.x = p.x;
    out.z = p.z;
    const h = this.pos.y - this.hipHeight() - aid.y;
    // What's under it and coming up ahead (the house, the bluff), over the deck
    const g = this.ground;
    const ax = this.pos.x + this.vel.x * 2;
    const az = this.pos.z + this.vel.z * 2;
    const floor = Math.max(g.surface(this.pos.x, this.pos.z), g.surface(ax, az)) - aid.y;
    // (let go over the last few metres, not at a line: dropped all at once
    // it stepped the sink and jolted the lean)
    const clear = (floor + AUTOLAND_CLEAR) * smooth(4, 8, d);
    const hGoal = Math.max(Math.min(h, AUTOLAND_SLOPE * d), clear);
    let vy = clamp((hGoal - h) * 1.6, -20, 6);
    // Locked on: dead on the centre and all but still for a beat (and let
    // go of again if it's pushed off the mark on the way down)
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (this.landLock < 1) {
      const still = d < AUTOLAND_LOCK_R && hv < AUTOLAND_LOCK_V && h < 1.6;
      this.landLock = still ? Math.min(1, this.landLock + dt / AUTOLAND_LOCK_T) : Math.max(0, this.landLock - dt / AUTOLAND_LOCK_T);
    } else if (d > AUTOLAND_SLIP && h > 0.3) this.landLock = 0;
    // Over the mark: keep sinking to the deck; low and not yet locked on,
    // wait and trim (both eased in, not switched)
    if (h > hGoal - 0.05) vy = THREE.MathUtils.lerp(vy, Math.min(vy, -AUTOLAND_SINK), smooth(1, 0.5, d));
    if (this.landLock < 1) vy = THREE.MathUtils.lerp(vy, Math.max(vy, 0), smooth(2.5, 1.5, h));
    // (down no faster than it can stop, easing onto the touchdown sink)
    vy = Math.max(vy, -Math.max(AUTOLAND_SINK, Math.min(h * 1.8, Math.sqrt(2 * AUTOLAND_SINK_DECEL * Math.max(0, h)))));
    out.y = Math.max((vy - this.vel.y) * 4, -GRAVITY * (1 - AUTOLAND_LIFT));
  }

  /**
   * Auto-land's boosted leg home: decide whether it's flying one (see
   * {@link HOME_R}), and if so fly it as a pilot would — the boost lit,
   * looking at the pad, holding the leg's height — in place of the input.
   */
  private homeInput(input: FlightInput): FlightInput {
    const aid = this.landingAid;
    if (!this.autoLand || !aid || this.power < 0.5) {
      this.homing = false;
      return input;
    }
    const ex = aid.x - this.pos.x;
    const ez = aid.z - this.pos.z;
    const d = Math.hypot(ex, ez);
    const hv = Math.hypot(this.vel.x, this.vel.z);
    // Where a stop from here would leave it, and how far short of the
    // centre that is along the way in (− past it)
    const stop = (hv * hv) / (2 * HOME_DECEL);
    const sx = hv > 1e-3 ? this.pos.x + (this.vel.x / hv) * stop : this.pos.x;
    const sz = hv > 1e-3 ? this.pos.z + (this.vel.z / hv) * stop : this.pos.z;
    const closing = d > 1e-3 ? (ex * this.vel.x + ez * this.vel.z) / d : 0;
    if (!this.homing) this.homing = Math.hypot(aid.x - sx, aid.z - sz) > HOME_R;
    // (and lined up on it, so the flare comes out of straight flight, not the turn)
    else if (closing > 0.97 * hv && d - stop < HOME_LEAD && d - stop > -HOME_PAST) this.homing = false;
    if (!this.homing) return input;
    const i = this.homeIn;
    // At the leg's height, clear of what's under it and coming up ahead
    // (pitched for it over a few seconds' flying, never steeply)
    const g = this.ground;
    const floor = Math.max(g.surface(this.pos.x, this.pos.z), g.surface(this.pos.x + this.vel.x * 3, this.pos.z + this.vel.z * 3));
    const hGoal = Math.max(aid.y + HOME_ALT, floor + HOME_CLEAR);
    const dy = clamp((hGoal - this.pos.y) / Math.max(150, this.speed * 2), -0.35, 0.35);
    i.aim.set(ex / Math.max(d, 1e-3), dy, ez / Math.max(d, 1e-3)).normalize();
    i.boost = true;
    i.brake = i.stance = false;
    i.lateral = i.forward = i.vertical = i.throttle = 0;
    return i;
  }

  /**
   * The line the body leans to: the thrust itself, or under auto-land the
   * thrust followed through a critically damped spring ({@link AUTOLAND_LEAN}).
   */
  private leanLine(thrustDir: THREE.Vector3, landing: boolean, dt: number): THREE.Vector3 {
    const l = this.lean;
    const v = this.leanVel;
    if (!landing) {
      l.copy(thrustDir);
      v.set(0, 0, 0);
      return thrustDir;
    }
    v.addScaledVector(this._lp.subVectors(thrustDir, l), AUTOLAND_LEAN * AUTOLAND_LEAN * dt).multiplyScalar(Math.max(0, 1 - 2 * AUTOLAND_LEAN * dt));
    l.addScaledVector(v, dt);
    return l.lengthSq() > 1e-6 ? this._lp.copy(l).normalize() : thrustDir;
  }

  /** 0–1: how much the pad capture should hold this step (see {@link PAD_CAPTURE_R}). */
  private padCapture(input: FlightInput, fl: number, carrying: boolean): number {
    const aid = this.landingAid;
    if (!aid || this.power < 0.5) return 0;
    const handsOff =
      Math.abs(input.forward) < 0.05 && Math.abs(input.lateral) < 0.05 && input.throttle <= 0 && !input.stance && !this.boosting && !carrying && this.speedCmd < 3;
    if (!handsOff) return 0;
    const d = Math.hypot(aid.x - this.pos.x, aid.z - this.pos.z);
    const h = this.pos.y - this.hipHeight() - aid.y;
    if (h < -0.5) return 0;
    // (passing through quick it's not a landing: only a hover is caught)
    const hv = Math.hypot(this.vel.x, this.vel.z);
    return smooth(PAD_CAPTURE_R, PAD_CAPTURE_R * 0.6, d) * smooth(PAD_CAPTURE_H, PAD_CAPTURE_H * 0.7, h) * smooth(14, 8, hv) * (1 - fl);
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
      // Keep the way it was drifting as the first steps (no faster than a walk)
      this.vel.y = 0;
      const hv = Math.hypot(this.vel.x, this.vel.z);
      if (hv > WALK_SPEED) this.vel.multiplyScalar(WALK_SPEED / hv);
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
