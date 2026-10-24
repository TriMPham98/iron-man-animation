import * as THREE from 'three';
import { MINI_ROCKETS, type FlapId, type FlightCheckFrame } from '../../animation/flightCheck';
import { applyPose, createRig, type FlightPose, type LimbOffsets, type SuitRig } from '../../suit/rigPose';
import { boneSpec, type BoneName } from '../../suit/rig';
import type { Suit } from '../../suit/Suit';
import { FLIGHT_POSTURE, type FlightModel } from './flightModel';
import { GRAVITY } from '../world/config';

/**
 * Turns the flight state into the suit's body language, one frame at a
 * time, through the same frame the workshop's flight check plays: the pose
 * (arms trailing in flight, legs dangling in a hover, the head up to look
 * where it's going), every stabilizer flap working as a real control
 * surface, the weapons deployed on their own armor panels, and the
 * thruster outputs. The suit is flown as a whole by a world transform on
 * its rig.
 */

export interface ArmsState {
  /** 0–1: how far each arm is raised onto the aim line (repulsor shot). */
  aimL: number;
  aimR: number;
  /**
   * Which hand the body prefers for the next shot (written by the suit
   * driver): +1 left, −1 right, 0 either. A target well off to one side —
   * over the shoulder, behind — is shot with the hand on that side.
   */
  aimSide: number;
  /** Palm discharge flash / charge 0–1. */
  flashL: number;
  flashR: number;
  chargeL: number;
  chargeR: number;
  /** Shoulder silos open 0–1 and rockets still in their cells (0–{@link MINI_ROCKETS}). */
  silos: number;
  siloArmed: number;
  /** Forearm launchers out 0–1 and their lock pulses. */
  launchers: number;
  lockL: number;
  lockR: number;
  /**
   * Hip flare drums out 0–1, each drum's turn (rad: it indexes a fresh
   * port onto the station per round) and the knock of its last round 0–1.
   */
  flares: number;
  flareSpinL: number;
  flareSpinR: number;
  flareKickL: number;
  flareKickR: number;
  /** Unibeam: 0–1, arms swept back, chest forward. */
  unibeam: number;
}

export const IDLE_ARMS = (): ArmsState => ({
  aimL: 0,
  aimR: 0,
  aimSide: 0,
  flashL: 0,
  flashR: 0,
  chargeL: 0,
  chargeR: 0,
  silos: 0,
  siloArmed: MINI_ROCKETS,
  launchers: 0,
  lockL: 0,
  lockR: 0,
  flares: 0,
  flareSpinL: 0,
  flareSpinR: 0,
  flareKickL: 0,
  flareKickR: 0,
  unibeam: 0,
});

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const clamp01 = (x: number) => clamp(x, 0, 1);
const smooth01 = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
/** Centre of mass in bind space (the rig tilts about the hips). */
const COM = new THREE.Vector3(0, 1.0, 0);
/**
 * Repulsor shot: the forearm rolls the palm down (pronation, carried on the
 * upper-arm twist) so the wrist bend that faces the palm down the arm lifts
 * the fingers skyward — the flat "stop" hand — rather than out to the side.
 */
const AIM_TWIST = -Math.PI / 2;
/** Turn assist: the arm rolled so the palm faces forward (into the hand's sweep). */
const ASSIST_TWIST = Math.PI / 2;
/** Forearm roll for the braking arms (palms to the travel, elbows soft). */
const BRAKE_TWIST = -0.5;
const BRAKE_ELBOW = 0.25;

/**
 * A braking arm's bearing in the chest frame (rad, + out to its own side)
 * for the travel's bearing `phi` (same sense): out wide when the
 * travel is dead ahead, out to the side with it, back past the hip when
 * it's behind — and from the far side it stays forward, then swings back
 * round its own side as the travel comes round behind. Continuous all the
 * way round (±π meet at the same reach).
 */
export function brakeAzimuth(phi: number): number {
  const FWD = 0.5;
  const ACROSS = -0.3;
  const BACK = 1.9;
  if (phi >= 0) return lerp(FWD, BACK, smooth01(phi / Math.PI));
  if (phi >= -Math.PI / 2) return lerp(FWD, ACROSS, -phi / (Math.PI / 2));
  return lerp(ACROSS, BACK, smooth01((-phi - Math.PI / 2) / (Math.PI / 2)));
}
/** Hover yaw limits from the flight model (rad/s, rad/s²): turn channels are normalised by them. */
const HOVER_YAW_RATE = 3.2;
const HOVER_YAW_ACC = HOVER_YAW_RATE / 0.22;
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _z = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler();
/** Left arm joints (bind): shoulder, elbow, wrist. */
const ARM_JOINTS = (['upperArm.L', 'forearm.L', 'hand.L'] as const).map((b) => new THREE.Vector3(...boneSpec(b).head));

/** Shoulder angles (abduction, flexion) taking the shoulder-frame vector `v` onto `t`: upper arm Rx(flex)·Rz(abd). */
export function shoulderOnto(v: THREE.Vector3, t: THREE.Vector3): [number, number] {
  // Rz(abd) takes v's sideways component onto t.x … (both as unit
  // directions: v is the shoulder → palm offset, half a metre, and measured
  // raw a target out to the side saturated the abduction)
  const rho = Math.max(1e-4, Math.hypot(v.x, v.y) / Math.max(1e-4, v.length()));
  const abd = clamp(Math.asin(clamp(t.x / rho, -1, 1)) - Math.atan2(v.x, -v.y), -0.6, 1.5);
  _ax.copy(v).applyAxisAngle(_Z, abd);
  // … and Rx(flex) swings what's left onto t in the sagittal plane
  let flex = Math.atan2(t.z, t.y) - Math.atan2(_ax.z, _ax.y);
  flex = Math.atan2(Math.sin(flex), Math.cos(flex));
  // The arm never goes over the top to reach behind (that path sweeps the
  // forearm through the helmet): a shoulder swings back only so far, a
  // little further once the arm is out to the side
  const back = 0.45 + 1.2 * Math.sin(clamp(abd, 0, 1.5)) ** 2;
  if (flex > back) flex = back;
  return [abd, clamp(flex, -3.0, back)];
}

/**
 * The left arm's comfortable reach, as a direction in the chest frame (X
 * left, Y up, Z forward): a little across the chest, out to the side and
 * round behind the shoulder, never across the face or over the helmet. A
 * target outside it is clamped to the nearest reachable line (the body
 * twists toward it first, so the residual is small).
 */
export function clampReach(t: THREE.Vector3): THREE.Vector3 {
  const ACROSS = -0.45;
  const BEHIND = 2.05;
  let phi = Math.atan2(t.x, t.z);
  let theta = Math.asin(clamp(t.y, -1, 1));
  if (phi < ACROSS || phi > BEHIND) {
    // Outside the arc: go to whichever end is nearer round the circle
    const toAcross = phi < ACROSS ? ACROSS - phi : ACROSS + Math.PI * 2 - phi;
    const toBehind = phi > BEHIND ? phi - BEHIND : phi + Math.PI * 2 - BEHIND;
    phi = toAcross < toBehind ? ACROSS : BEHIND;
  }
  // Raised across the chest or back past the shoulder the arm stays below
  // the helmet; out front and to the side it may go near overhead
  const up = phi < 0 ? lerp(1.2, 0.8, -phi / -ACROSS) : phi > 1.35 ? lerp(1.2, 0.72, (phi - 1.35) / (BEHIND - 1.35)) : 1.2;
  const down = phi > 1.35 ? lerp(-1.3, -1.0, (phi - 1.35) / (BEHIND - 1.35)) : -1.3;
  theta = clamp(theta, down, up);
  const c = Math.cos(theta);
  return t.set(c * Math.sin(phi), Math.sin(theta), c * Math.cos(phi));
}

/**
 * Left arm onto the aim `t` (body frame; the right arm is the left
 * mirrored) through the rig's own channels (rigPose): upper arm
 * Rx(flex)·Rz(abd)·Ry(twist), forearm Rx(−elbow), hand Rz(wrist). The
 * shoulder lays the palm on the line out of the shoulder, then the wrist
 * squares the palm's face to it — a few rounds settle both.
 */
export function aimArm(at: readonly number[], normal: readonly number[], t: THREE.Vector3, twist: number, elbow: number, wrist: number): [number, number, number] {
  const [S, E, W] = ARM_JOINTS;
  let abd = 0;
  let flex = 0;
  for (let i = 0; i < 3; i++) {
    // Shoulder → palm in the shoulder frame
    _p.set(at[0], at[1], at[2]).sub(W).applyAxisAngle(_Z, wrist).add(W).sub(E).applyAxisAngle(_X, -elbow).add(E).sub(S).applyAxisAngle(_Y, twist);
    [abd, flex] = shoulderOnto(_p, t);
    // Palm normal and the wrist's hinge axis in the body frame
    _n.set(normal[0], normal[1], normal[2]).normalize().applyAxisAngle(_Z, wrist);
    _z.copy(_Z);
    for (const q of [_n, _z]) q.applyAxisAngle(_X, -elbow).applyAxisAngle(_Y, twist).applyAxisAngle(_Z, abd).applyAxisAngle(_X, flex);
    // Turn the palm about the hinge onto the aim
    const err = Math.atan2(_ax.crossVectors(_n, t).dot(_z), _n.dot(t));
    wrist = clamp(wrist + err, 0.6, 1.9);
  }
  return [abd, flex, wrist];
}

/**
 * Advance a damped spring (value, velocity in `s`) toward a goal: natural
 * frequency `w` (rad/s), damping ratio `z` (<1 swings past and settles).
 */
function springStep(x: number, v: number, goal: number, w: number, z: number, dt: number): [number, number] {
  // Semi-implicit Euler in sub-steps: stable for any frame time
  const n = Math.min(64, Math.max(1, Math.ceil(dt * w * 4)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    v += (w * w * (goal - x) - 2 * z * w * v) * h;
    x += v * h;
  }
  return [x, v];
}
/** One spring stored as (x = value, y = velocity). */
function springTo(s: THREE.Vector2, goal: number, w: number, z: number, dt: number): void {
  [s.x, s.y] = springStep(s.x, s.y, goal, w, z, dt);
}
/** Two springs: values in `x`, velocities in `v`. */
function spring(x: THREE.Vector2, v: THREE.Vector2, gx: number, gy: number, w: number, z: number, dt: number): void {
  [x.x, v.x] = springStep(x.x, v.x, gx, w, z, dt);
  [x.y, v.y] = springStep(x.y, v.y, gy, w, z, dt);
}

/** Chest frame ← body frame for the torso channels (as rigPose lays them on the spine and chest). */
function torsoQuaternion(out: THREE.Quaternion, yaw: number, pitch: number, roll: number, twist: number, bend: number, side: number): THREE.Quaternion {
  out.setFromAxisAngle(_Y, yaw).multiply(_qa.setFromAxisAngle(_X, pitch)).multiply(_qa.setFromAxisAngle(_Z, roll));
  for (const k of [0.45, 0.55]) out.multiply(_qb.setFromEuler(_e.set(k * bend, k * twist, k * side, 'YXZ')));
  return out;
}

/** Arm / hand / leg channels the pose springs carry, in order. */
const LIMB_KEYS = [
  'armL',
  'armR',
  'armFlexL',
  'armFlexR',
  'armTwistL',
  'armTwistR',
  'elbowL',
  'elbowR',
  'hipL',
  'hipR',
  'hipOutL',
  'hipOutR',
  'kneeL',
  'kneeR',
  'ankleL',
  'ankleR',
  'footRollL',
  'footRollR',
] as const satisfies readonly (keyof LimbOffsets)[];
const ARM_CHANNELS = 8;
/** Bank layout: limbs, then wrists L/R, then 5 + 5 fingers. */
const N_SPRINGS = LIMB_KEYS.length + 2 + 10;

// ── Hero landing ─────────────────────────────────────────────────────
/** Timeline (s from touchdown): slam into the three-point, hold, rise. */
const LAND_IN = 0.16;
const LAND_LOOK_UP = 0.5;
const LAND_RISE = 0.85;
const LAND_UP = 1.45;
/**
 * Forward lean of the whole body (rad) and the torso channels in the
 * three-point. The suit's arms are short, so the shoulders must come right
 * down for the fist to reach: most of the lean is the whole body about the
 * hips (a flat back) rather than a hunch, and the torso stays square.
 */
const LAND_LEAN = 0.95;
const LAND_TORSO = { twist: -0.1, bend: 0.5, side: 0.15 };
/** Bind-space contact points: kneecap (right knee goes down), sole heel / toe, fist. */
const KNEE_R: Array<[BoneName, [number, number, number]]> = [
  ['shin.R', [-0.14, 0.5, 0.075]],
  ['shin.R', [-0.142, 0.44, 0.07]],
];
const SOLE = (s: 'L' | 'R'): Array<[BoneName, [number, number, number]]> => {
  const x = s === 'L' ? 1 : -1;
  return [
    [`foot.${s}`, [x * 0.155, 0.005, -0.09]],
    [`foot.${s}`, [x * 0.165, 0.005, 0.17]],
  ];
};
const TOE_R: Array<[BoneName, [number, number, number]]> = [['foot.R', [-0.165, 0.01, 0.17]]];
/** Knuckles of the curled right hand: the middle joints of the fingers, armour outside them. */
const FIST_R: Array<[BoneName, [number, number, number]]> = (['index', 'middle', 'ring', 'pinky'] as const).map((f) => {
  const h = boneSpec(`${f}2.R` as BoneName).head;
  return [`${f}2.R` as BoneName, [h[0], h[1], h[2]]];
});
/** Armour thickness outside the measured joints (m). */
const KNUCKLE_PAD = 0.022;
const KNEE_PAD = 0.0;

export interface SuitOutputs {
  bootL: number;
  bootR: number;
  palmL: number;
  palmR: number;
  /** 0–1: the palms burning as full thrusters (boost). */
  palmBoost: number;
}

/** One frame of hero-landing contact, for the sim's impact FX (world space). */
export interface FistStrike {
  at: THREE.Vector3;
  speed: number;
}

export class SuitDriver {
  private time = 0;
  private readonly carrier = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _qi = new THREE.Quaternion();
  private readonly _qt = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();
  private readonly _t = new THREE.Matrix4();
  /** Smoothed visual channels (so the body never snaps). */
  private head = new THREE.Vector2();
  private dangle = 0;
  private headRoll = 0;
  /** Sprung follow-through channels for turns: [value, velocity]. */
  private readonly headVel = new THREE.Vector2();
  private readonly lean = new THREE.Vector2();
  private readonly legSwing = new THREE.Vector2();
  private readonly armSwing = new THREE.Vector2();
  /** Full-body turn: shoulders over the hips, hips under them, the knees, arms and legs. */
  private readonly twist = new THREE.Vector2();
  private readonly hipYaw = new THREE.Vector2();
  private readonly bend = new THREE.Vector2();
  private readonly tuck = new THREE.Vector2();
  private readonly armOut = new THREE.Vector2();
  private readonly spread = new THREE.Vector2();
  /** Braking (X) and free fall, sprung: [value, velocity]. */
  private readonly brakeK = new THREE.Vector2();
  /** The braking legs and hips (they lead the arms in), how hard the air is stopping the suit, and the settle as the boots take back over. */
  private readonly flareK = new THREE.Vector2();
  private readonly effortK = new THREE.Vector2();
  private readonly settle = new THREE.Vector2();
  private flaring = false;
  /** The braking torso's own springs (pitch, bend, side, twist offsets): looser than the limbs'. */
  private readonly torsoPitch = new THREE.Vector2();
  private readonly torsoBend = new THREE.Vector2();
  private readonly torsoSide = new THREE.Vector2();
  private readonly torsoYaw = new THREE.Vector2();
  /** Stopping a sideways slide: the hips turn into it and the body leans off it, sprung (yaw, roll). */
  private readonly slideYaw = new THREE.Vector2();
  private readonly slideRoll = new THREE.Vector2();
  /** Breathing phase (it quickens with the effort of a hard stop). */
  private breathPh = 0;
  private readonly swingK = new THREE.Vector2();
  private readonly fallK = new THREE.Vector2();
  /** Riding the surge in flight (+ speeding up, − slowing), sprung loose for follow-through. */
  private readonly surgeK = new THREE.Vector2();
  /** Travel direction in the body frame, smoothed (what the braking palms push against). */
  private readonly travel = new THREE.Vector3(0, -1, 0);
  readonly outputs: SuitOutputs = { bootL: 0, bootR: 0, palmL: 0, palmR: 0, palmBoost: 0 };
  /** Palm turn-assist per hand, sprung: [value, velocity]. */
  private readonly palmAssistL = new THREE.Vector2();
  private readonly palmAssistR = new THREE.Vector2();
  /** Roll rate, slowly followed (its gap to the live rate is the roll starting or stopping). */
  private rollSlow = 0;
  /** Palm roll flick per hand, sprung: [value, velocity]. */
  private readonly rollFlickL = new THREE.Vector2();
  private readonly rollFlickR = new THREE.Vector2();
  /** Aim line in the body frame, smoothed, and the side it last sat on (for targets dead astern). */
  private readonly aimBody = new THREE.Vector3(0, 0, 1);
  private aimSign = 1;
  /** Every arm, hand and leg channel rides a spring: [values, velocities]. */
  private readonly sx = new Float64Array(N_SPRINGS);
  private readonly sv = new Float64Array(N_SPRINGS);
  private primed = false;
  /** Hero landing: time since touchdown (−1 = none), its weight, and the solved pose. */
  private landT = -1;
  private landW = 0;
  private landAbort = false;
  private prevCrouch = 0;
  private struck = false;
  /** The boots have been handed to the walk where the landing left them. */
  private stood = false;
  private landImpact = 0;
  private landPose: { limbs: Required<LimbOffsets>; wristL: number; wristR: number; fingersL: number[]; fingersR: number[] } | null = null;
  private landBend = LAND_TORSO.bend;
  /** Set on the frame the fist hits the ground; the sim clears it after the FX. */
  strike: FistStrike | null = null;
  /** Scratch skeleton for contact solving (model space, no carrier). */
  private readonly fk: SuitRig = createRig();
  /** Last frame's pose (debug / tests). */
  lastPose: FlightPose | null = null;

  update(dt: number, suit: Suit, m: FlightModel, aim: THREE.Vector3, arms: ArmsState): void {
    this.time += dt;
    const t = this.time;
    const fl = m.flightness;
    const prone = Math.sin(m.posture) / Math.sin(FLIGHT_POSTURE);
    const air = m.grounded ? 0 : 1;
    this.dangle += (air - this.dangle) * (1 - Math.exp(-dt / 0.35));
    this.updateLanding(dt, m);
    const crouch = this.landW;
    // Coming up out of a landing the boots stay where they hit: the walk
    // takes them from there (rising off the lunge, then stepping in square)
    if (this.landT >= LAND_RISE - 0.1 && !this.stood && !this.landAbort && m.grounded) {
      this.stood = true;
      for (const [i, s] of [[0, 'L'], [1, 'R']] as const) {
        const bone = `foot.${s}` as const;
        m.gait.plant(i, suit.boneWorldPoint(bone, boneSpec(bone).head, this._v), m.heading, m.ground);
      }
    }

    // Carrier: world ← body orientation about the centre of mass
    const bodyQ = m.bodyQuaternion(this._q);
    this.carrier.compose(m.pos, bodyQ, this._v.set(1, 1, 1)).multiply(this._t.makeTranslation(-COM.x, -COM.y, -COM.z));
    suit.setCarrier(this.carrier);

    // Aim in the body frame (X left, Y head, Z chest), eased so a fast
    // rotation of the suit sweeps the arms round rather than snapping them
    const a = this._aim.copy(aim).applyQuaternion(this._qi.copy(bodyQ).invert()).normalize();
    this.aimBody.lerp(a, 1 - Math.exp(-dt / 0.05)).normalize();
    const ab = this.aimBody;
    // Bearing of the aim off the chest; dead astern it stays on the side
    // it came round on (no flip-flopping between the shoulders)
    let psi = Math.atan2(ab.x, ab.z);
    if (Math.abs(psi) < 2.7) this.aimSign = Math.sign(psi) || 1;
    else if (Math.sign(psi) !== this.aimSign) psi += Math.PI * 2 * this.aimSign;
    const elev = Math.asin(clamp(ab.y, -1, 1));
    // Any shot clearly off to one side goes from that side's hand: the far
    // hand reached across in front of the visor (alternating hands only
    // near dead ahead, or steeply up or down where the bearing means little)
    arms.aimSide = Math.abs(psi) > 0.2 && Math.hypot(ab.x, ab.z) > 0.35 ? Math.sign(psi) : 0;
    const aimK = smooth01(Math.max(arms.aimL, arms.aimR)) * (1 - crouch);

    // ── Turns: the whole body ─────────────────────────────────────────
    // Low and slow the suit pivots on its boots, and the body throws itself
    // into the turn: the head snaps round first, the shoulders lead over
    // the hips (which wind the other way: anticipation), the knees bend
    // and the legs swing out and tuck, the arms go out for balance. When
    // the turn brakes the hips plant, the shoulders carry on past, the legs
    // spread and the palms push against the spin; then it all swings back
    // and settles. Flat out the frame banks for real, so these fade
    const yawRate = m.omega.y;
    const hoverish = (1 - 0.7 * prone) * this.dangle * (1 - crouch);
    const upright = (1 - prone) * this.dangle * (1 - crouch);
    const wN = clamp(yawRate / HOVER_YAW_RATE, -1.2, 1.2);
    const aN = clamp(m.yawAcc / HOVER_YAW_ACC, -1.2, 1.2);
    // 0 spinning up … 1 braking (the acceleration opposes the spin)
    const brakeK = clamp01((-aN * wN) / 0.12);
    const brakeAmt = brakeK * Math.abs(aN);
    springTo(this.lean, clamp(-yawRate * 0.12, -0.42, 0.42) * upright, 9, 0.55, dt);
    springTo(this.legSwing, clamp(-yawRate * 0.1 - m.yawAcc * 0.016, -0.45, 0.45) * hoverish, 5.5, 0.38, dt);
    // Shoulders lead too: the outside arm swings forward, the inside one back
    springTo(this.armSwing, clamp(yawRate * 0.09 + m.yawAcc * 0.006, -0.45, 0.45) * hoverish, 9, 0.5, dt);
    const turnTwist = (0.36 * wN + aN * lerp(0.2, -0.42, brakeK)) * hoverish;
    const turnHips = (-0.2 * wN - aN * lerp(0.14, -0.1, brakeK)) * hoverish;
    // Aiming: the hips and shoulders turn the body toward the shot (and
    // lean back for a high one, over for a low one) so the arm only
    // finishes the line
    const aimTwist = clamp(psi * 0.5, -0.66, 0.66);
    const aimHips = clamp(psi * 0.3, -0.4, 0.4);
    const aimBend = elev > 0.85 ? -Math.min(0.28, (elev - 0.85) * 0.6) : elev < -0.7 ? Math.min(0.3, (-0.7 - elev) * 0.5) : 0;
    springTo(this.twist, clamp(lerp(turnTwist, aimTwist, aimK), -0.8, 0.8), 8, 0.45, dt);
    springTo(this.hipYaw, clamp(lerp(turnHips, aimHips, aimK), -0.5, 0.5), 6, 0.42, dt);
    springTo(this.tuck, clamp01(0.55 * Math.abs(aN) + 0.35 * Math.abs(wN)) * hoverish * (1 - aimK), 9, 0.55, dt);
    springTo(this.armOut, clamp01(0.4 * Math.abs(wN) + 0.75 * brakeAmt) * hoverish, 8, 0.5, dt);
    springTo(this.spread, clamp01(1.1 * brakeAmt) * hoverish, 7, 0.45, dt);
    springTo(this.bend, lerp(0.22 * this.tuck.x, aimBend, aimK), 8, 0.6, dt);
    // Flat out the body rides the surge: a boost's kick streamlines it (arms
    // in tight, chin down), a bleed off the boost lets the limbs float
    // forward and the head come up. The brakes have their own pose
    springTo(this.surgeK, clamp(m.surge / (5 * GRAVITY), -1, 1.2) * prone * (1 - m.airbrake), 7, 0.45, dt);
    const surgeOn = Math.max(0, this.surgeK.x);
    const surgeOff = Math.max(0, -this.surgeK.x);

    // ── Head: look where we're going / aiming ─────────────────────────
    // The head leads every turn: it snaps round onto the new line first (a
    // quick, slightly underdamped spring — a glance that lands and settles),
    // and the body follows it round. Its yaw rides on the twisted chest
    // (an aim behind the chest pins the head round to that side)
    const bodyYaw = this.hipYaw.x + this.twist.x;
    const aimYaw = Math.atan2(a.x, a.z < 0 && Math.abs(a.y) < 0.8 ? a.z : Math.hypot(a.y, a.z));
    const wantYaw = clamp(aimYaw - bodyYaw, -0.85, 0.85);
    const wantPitch = clamp(-Math.atan2(a.y, Math.max(0.05, a.z)) - this.bend.x * 0.6 + 0.12 * this.surgeK.x, -1.05, 0.45);
    spring(this.head, this.headVel, wantYaw, wantPitch, 13, 0.72, dt);
    // Boots vector against each other to drive the yaw (toes down on the
    // outside boot push that side round); eased off the yaw acceleration
    const yawVector = clamp(m.yawAcc * 0.022 + yawRate * 0.05, -0.3, 0.3) * hoverish;
    // Head counters a little of the bank and the lean (horizon reflex)
    const up = m.up(this._v);
    const bankNow = Math.atan2(new THREE.Vector3().crossVectors(up, m.forward()).y, up.y);
    const headRollGoal = clamp(-bankNow * 0.25 - this.lean.x * 0.35, -0.3, 0.3);
    this.headRoll += (headRollGoal - this.headRoll) * (1 - Math.exp(-dt / 0.22));

    // ── Limbs ─────────────────────────────────────────────────────────
    const sway = (k: number, ph: number) => this.dangle * (1 - prone) * k * Math.sin(t * 1.9 + ph);
    const rollRate = m.omega.z;
    const pitchRate = m.omega.x;
    const tuck = this.tuck.x;
    const armOut = this.armOut.x;
    const spread = this.spread.x;
    // The inside leg (the side the suit turns to) tucks up more, the outside one reaches out
    const inside = clamp(wN * 2.5, -1, 1);
    const limbs: Required<LimbOffsets> = {
      // Trailing arms in flight; the low wing's arm reaches out to steer
      armL: lerp(0.1, 0.16, prone) + clamp(-rollRate * 0.18, 0, 0.35) * prone + sway(0.015, 0.4) + 0.8 * armOut - 0.07 * surgeOn + 0.14 * surgeOff,
      armR: lerp(0.1, 0.16, prone) + clamp(rollRate * 0.18, 0, 0.35) * prone + sway(0.015, 1.4) + 0.8 * armOut - 0.07 * surgeOn + 0.14 * surgeOff,
      armFlexL: 0.05 * prone + this.armSwing.x - 0.15 * armOut,
      armFlexR: 0.05 * prone - this.armSwing.x - 0.15 * armOut,
      armTwistL: 0,
      armTwistR: 0,
      elbowL: lerp(0.18, 0.08, prone) * this.dangle + sway(0.03, 2) + 0.4 * armOut + 0.14 * surgeOff,
      elbowR: lerp(0.18, 0.08, prone) * this.dangle + sway(0.03, 3) + 0.4 * armOut + 0.14 * surgeOff,
      // Legs: soft knees dangling in a hover, straight and toes pointed in flight
      hipL: (0.08 + sway(0.02, 1.1)) * this.dangle * (1 - prone) + 0.08 * m.airbrake + 0.6 * tuck * (1 + 0.45 * inside) + 0.08 * surgeOff,
      hipR: (0.08 + sway(0.02, 2.3)) * this.dangle * (1 - prone) + 0.08 * m.airbrake + 0.6 * tuck * (1 - 0.45 * inside) + 0.08 * surgeOff,
      hipOutL: -0.3 * m.trimRoll * 0.2 + this.legSwing.x + 0.32 * spread + 0.1 * tuck * Math.max(0, -inside),
      hipOutR: 0.3 * m.trimRoll * 0.2 - this.legSwing.x + 0.32 * spread + 0.1 * tuck * Math.max(0, inside),
      kneeL: (lerp(0.16, 0.05, prone) + sway(0.03, 0)) * this.dangle + 0.15 * m.airbrake + 1.05 * tuck * (1 + 0.4 * inside) + 0.3 * spread + 0.18 * surgeOff,
      kneeR: (lerp(0.16, 0.05, prone) + sway(0.03, 0.7)) * this.dangle + 0.15 * m.airbrake + 1.05 * tuck * (1 - 0.4 * inside) + 0.3 * spread + 0.18 * surgeOff,
      ankleL: lerp(0.14 + 0.25 * m.trimPitch, 0.55, prone) * this.dangle - yawVector + 0.3 * tuck,
      ankleR: lerp(0.14 + 0.25 * m.trimPitch, 0.55, prone) * this.dangle + yawVector + 0.3 * tuck,
      footRollL: 0.2 * m.trimRoll * this.dangle * (1 - prone),
      footRollR: 0.2 * m.trimRoll * this.dangle * (1 - prone),
    };
    // Palms to the feet (thrust aft in flight, down in a hover): wrists in an L
    const palmsDown = this.dangle;
    let wristL = 1.45 * palmsDown;
    let wristR = 1.45 * palmsDown;
    // (on the ground: a loose, half-curled hand, closing to a fist on the
    // move)
    const fist = m.gait.weight * m.gait.active * 0.6;
    let fingersL: number[] = [0.3, 0.5, 0.6, 0.65, 0.7].map((r, i) => lerp(lerp(r, i === 0 ? 0.65 : 1, fist), -0.25, palmsDown));
    let fingersR = fingersL.slice();

    // Coming in hot for a hero landing: knees come up and the right fist
    // cocks back for the punch into the ground
    const pre = this.preLanding(m);
    if (pre > 0) {
      limbs.hipL = lerp(limbs.hipL, 0.95, pre);
      limbs.kneeL = lerp(limbs.kneeL, 1.25, pre);
      limbs.hipR = lerp(limbs.hipR, 0.45, pre);
      limbs.kneeR = lerp(limbs.kneeR, 1.0, pre);
      limbs.hipOutL = lerp(limbs.hipOutL, 0.2, pre);
      limbs.hipOutR = lerp(limbs.hipOutR, 0.15, pre);
      limbs.armR = lerp(limbs.armR, 1.0, pre);
      limbs.armFlexR = lerp(limbs.armFlexR, 0.2, pre);
      limbs.elbowR = lerp(limbs.elbowR, 1.8, pre);
      limbs.armL = lerp(limbs.armL, 0.9, pre);
      limbs.armFlexL = lerp(limbs.armFlexL, 0.4, pre);
      limbs.elbowL = lerp(limbs.elbowL, 0.3, pre);
      wristR = lerp(wristR, 0, pre);
      wristL = lerp(wristL, 0.6, pre);
      fingersR = fingersR.map((f, i) => lerp(f, i === 0 ? 0.7 : 1, pre));
    }

    // Unibeam stance: arms swept back and out, chest thrown forward
    const ub = arms.unibeam;
    if (ub > 0) {
      limbs.armL = lerp(limbs.armL, 0.55, ub);
      limbs.armR = lerp(limbs.armR, 0.55, ub);
      limbs.armFlexL = lerp(limbs.armFlexL, 0.45, ub);
      limbs.armFlexR = lerp(limbs.armFlexR, 0.45, ub);
      limbs.elbowL = lerp(limbs.elbowL, 0.25, ub);
      limbs.elbowR = lerp(limbs.elbowR, 0.25, ub);
      fingersL = fingersL.map((f) => lerp(f, 0.85, ub));
      fingersR = fingersR.map((f) => lerp(f, 0.85, ub));
      wristL = lerp(wristL, 0.2, ub);
      wristR = lerp(wristR, 0.2, ub);
    }

    // Palm assist in hover turns: a hand pushing back against the air
    // swings the suit round it. Braking, the hand on the outside of the turn
    // (it sweeps forward) reaches out and back with the palm turned flat
    // into its sweep and fires to arrest the spin; spinning up, the inside
    // hand does the same, gentler. Sprung in and out, and the repulsor aim
    // takes the arm over whenever it's raised
    {
      const acc = m.yawAcc / 14;
      // Braking (the push opposes the spin) fires harder than spinning up
      const brakeShare = clamp01((-Math.sign(acc) * m.omega.y) / 0.6);
      const gain = lerp(0.6, 2.2, brakeShare);
      const turnOnly = (1 - prone) * this.dangle * (1 - crouch) * (1 - ub);
      springTo(this.palmAssistL, clamp01(Math.max(0, acc) * gain) * turnOnly, 16, 0.8, dt);
      springTo(this.palmAssistR, clamp01(Math.max(0, -acc) * gain) * turnOnly, 16, 0.8, dt);
      const pa = clamp01(this.palmAssistL.x) * (1 - arms.aimL);
      const pb = clamp01(this.palmAssistR.x) * (1 - arms.aimR);
      // Arm out and back, rolled so the palm faces forward; wrist cocked in
      limbs.armL = lerp(limbs.armL, 0.42 + 0.3 * armOut, pa);
      limbs.armR = lerp(limbs.armR, 0.42 + 0.3 * armOut, pb);
      limbs.armFlexL = lerp(limbs.armFlexL, 0.3, pa);
      limbs.armFlexR = lerp(limbs.armFlexR, 0.3, pb);
      limbs.armTwistL = lerp(limbs.armTwistL, ASSIST_TWIST, pa);
      limbs.armTwistR = lerp(limbs.armTwistR, ASSIST_TWIST, pb);
      limbs.elbowL = lerp(limbs.elbowL, 0.18, pa);
      limbs.elbowR = lerp(limbs.elbowR, 0.18, pb);
      wristL = lerp(wristL, -0.3, pa);
      wristR = lerp(wristR, -0.3, pb);
      fingersL = fingersL.map((f) => lerp(f, 0.05, pa));
      fingersR = fingersR.map((f) => lerp(f, 0.05, pb));
    }

    // Body (whole-suit) attitude this frame, before the landing takes over
    let pitch = 0;
    let roll = this.lean.x;
    let yaw = this.hipYaw.x;
    let spineYaw = this.twist.x;
    let spineBend = this.bend.x;
    let spineSide = 0;
    let lift = -0.06 * tuck * hoverish;

    // ── Braking: the whole body throws itself against the travel ──────
    // X (or the flight computer's own flare): like a bird landing the suit
    // rears back — chest up, hips under, the legs swung forward with the
    // knees bent to meet the ground — and both arms punch out ahead into
    // the oncoming air, palms flat to it, the repulsors firing forward to
    // kill the speed. Sprung in (a beat of anticipation) and out
    const sp = m.speed;
    // (only while there's real speed in it: the last m/s and the boots
    // holding the height swung it about, and the palms chased it)
    if (sp > 0.5) this.travel.lerp(this._v.copy(m.vel).applyQuaternion(this._qi.copy(bodyQ).invert()).divideScalar(sp), (1 - Math.exp(-dt / 0.08)) * smooth01((sp - 1) / 5)).normalize();
    // (out quicker than in: the hands drop to their trim first)
    const bkGoal = clamp01(m.palmBrake) * this.dangle * (1 - crouch) * (1 - ub) * (1 - pre);
    const bkOut = bkGoal < this.brakeK.x;
    springTo(this.brakeK, bkGoal, bkOut ? 12 : 9, bkOut ? 0.75 : 0.6, dt);
    const bk = clamp01(this.brakeK.x);
    // The legs and hips lead the flare: they come forward the instant the
    // wing spills, while the body is still swinging up out of the dive, so
    // it rears like a bird landing (driven off the palms, they came late
    // and it stood up in the air, then sat down). Out after the arms
    const flareGoal = clamp01(m.liftSpill) * smooth01((sp - 2) / 12) * this.dangle * (1 - crouch) * (1 - ub) * (1 - pre);
    springTo(this.flareK, flareGoal, flareGoal < this.flareK.x ? 6 : 16, 0.75, dt);
    const fk = clamp01(this.flareK.x);
    // A beat of anticipation as it starts: chin in, shoulders round
    const windup = clamp01(this.flareK.y / 8);
    // How hard the air is stopping it: at 6 g the whole body strains
    // against it; easing off as the speed bleeds away, it settles into
    // the calm flare by the time it's down to a hover
    const decelG = Math.max(0, -m.surge) / GRAVITY;
    springTo(this.effortK, smooth01((decelG - 1.5) / 4) * smooth01((sp - 10) / 50) * fk, 7, 0.6, dt);
    const eff = clamp01(this.effortK.x);
    // (and the chest heaves with it)
    this.breathPh += dt * lerp(1.7, 3.6, eff);
    // The stop done (or X let go) the boots take back over: the body
    // pitches through a little past upright and settles
    const flaring = flareGoal > (this.flaring ? 0.4 : 0.6);
    // Sideways share of the travel (+ toward the left)
    const lat = clamp(this.travel.x, -1, 1);
    const latK = Math.abs(lat);
    if (this.flaring && !flaring) this.settle.y += 2.2 * fk * (1 - 0.7 * latK);
    this.flaring = flaring;
    springTo(this.settle, 0, 6, 0.45, dt);
    // Carving the speed round onto a new line (a momentum swing) the palms
    // throw out against the old travel too and sweep round with it as it
    // comes onto the new line; the legs stay long for the flight
    springTo(this.swingK, clamp01(m.swing) * this.dangle * (1 - crouch) * (1 - ub) * (1 - pre), 9, 0.6, dt);
    const swk = clamp01(this.swingK.x);
    // ── Free fall: boots cut, dropping feet first ─────────────────────
    // Arms thrown up and out against the rush of air, elbows soft, hands
    // open; legs long, a little apart, toes pointed; head down to watch
    // the ground come. The wind worries at every limb
    springTo(this.fallK, clamp01(m.freefall) * (1 - crouch) * (1 - bk), 6, 0.55, dt);
    const ff = clamp01(this.fallK.x);
    if (ff > 1e-3) {
      const gust = (k: number, ph: number) => ff * k * (Math.sin(t * 11.3 + ph) * 0.6 + Math.sin(t * 17.9 + ph * 2.1) * 0.4) * clamp01(sp / 40);
      for (const [s, ph] of [
        ['L', 0],
        ['R', 1.7],
      ] as const) {
        limbs[`arm${s}`] = lerp(limbs[`arm${s}`], 1.2 + gust(0.06, ph), ff);
        limbs[`armFlex${s}`] = lerp(limbs[`armFlex${s}`], 0.25 + gust(0.05, ph + 1), ff);
        limbs[`armTwist${s}`] = lerp(limbs[`armTwist${s}`], 0, ff);
        limbs[`elbow${s}`] = lerp(limbs[`elbow${s}`], 0.6 + gust(0.08, ph + 2), ff);
        limbs[`hip${s}`] = lerp(limbs[`hip${s}`], 0.12 + gust(0.04, ph + 3), ff);
        limbs[`hipOut${s}`] = lerp(limbs[`hipOut${s}`], 0.16, ff);
        limbs[`knee${s}`] = lerp(limbs[`knee${s}`], 0.22 + gust(0.05, ph + 4), ff);
        limbs[`ankle${s}`] = lerp(limbs[`ankle${s}`], 0.45, ff);
      }
      wristL = lerp(wristL, 0.25, ff);
      wristR = lerp(wristR, 0.25, ff);
      fingersL = fingersL.map((f) => lerp(f, -0.15, ff));
      fingersR = fingersR.map((f) => lerp(f, -0.15, ff));
      spineBend = lerp(spineBend, -0.12, ff);
    }
    const pitch0 = pitch;
    const bend0 = spineBend;
    const side0 = spineSide;
    const yaw0 = spineYaw;
    if (fk > 1e-3) {
      // How much of the travel is ahead of the chest (forward braking) vs
      // below the boots (the flare onto the ground): the legs come forward
      // for the first and gather under for the second. Travel up the body
      // (still half prone) reads as ahead
      const ahead = clamp01((this.travel.z + 0.8 * Math.max(0, this.travel.y)) * 1.4);
      // Never quite a mirror: one knee rides a touch higher, the legs not square
      for (const [s, odd] of [
        ['L', 1],
        ['R', -1],
      ] as const) {
        // Sliding sideways (a hockey stop) the leg on the travel's side
        // reaches out long into it and the other gathers under
        const lead = clamp01(lat * odd);
        const trail = clamp01(-lat * odd);
        limbs[`hip${s}`] = lerp(limbs[`hip${s}`], 0.35 + 0.45 * ahead + 0.2 * eff + 0.04 * odd - 0.1 * lead + 0.15 * trail, fk);
        limbs[`hipOut${s}`] = lerp(limbs[`hipOut${s}`], 0.12 + 0.03 * odd + 0.06 * eff + 0.3 * lead - 0.06 * trail, fk);
        limbs[`knee${s}`] = lerp(limbs[`knee${s}`], 0.55 + 0.25 * ahead + 0.3 * eff - 0.06 * odd - 0.3 * lead + 0.35 * trail, fk);
        limbs[`ankle${s}`] = lerp(limbs[`ankle${s}`], 0.05, fk);
      }
      // The hips rear back; the chest stays over them (a backward arch put
      // the arms above the shoulders' line and hunched them) and curls
      // over them against a hard stop
      pitch = lerp(pitch, -(0.2 + 0.25 * eff) * ahead, fk);
      spineBend = lerp(spineBend, 0.06 * ahead + 0.12 * (1 - ahead) + 0.16 * eff, fk);
      // Travel off to one side: the shoulders turn on past the hips into it
      // and the body leans away, bracing (and a touch off square even dead
      // ahead). Square to a sideways travel, one palm reached across the chest
      spineYaw += (0.35 * lat + 0.03) * fk;
      spineSide += (0.3 * lat - 0.04) * fk;
    }
    // The hips lead the turn into a sideways stop and the whole body leans
    // off it, on firm springs (a slide braced, not swaying)
    springTo(this.slideYaw, 0.45 * lat * fk, 6, 1, dt);
    springTo(this.slideRoll, 0.12 * lat * fk, 6, 1, dt);
    yaw += this.slideYaw.x;
    roll += this.slideRoll.x;
    // The torso rides its own springs into the flare, looser than the
    // limbs': it lags the legs coming forward, swings past and settles
    // (set straight onto the pose it sat like a post while the limbs
    // worked round it)
    springTo(this.torsoPitch, pitch - pitch0, 6, 0.45, dt);
    springTo(this.torsoBend, spineBend - bend0, 8, 0.5, dt);
    // (side to side and round it's braced, near critically damped: loose
    // there, a sideways stop wobbled on top of the slide)
    springTo(this.torsoSide, spineSide - side0, 7, 0.9, dt);
    springTo(this.torsoYaw, spineYaw - yaw0, 7, 0.9, dt);
    // Held in the flare it never quite sits still: a slow hunt for
    // balance between the palms and the boots, side to side and fore-aft
    const hunt = (k: number, w: number, ph: number) => fk * k * Math.sin(t * w + ph);
    pitch = pitch0 + this.torsoPitch.x + 0.8 * this.settle.x + hunt(0.035, 3.7, 0);
    spineBend = bend0 + this.torsoBend.x + 0.1 * windup;
    spineSide = side0 + this.torsoSide.x + hunt(0.04 * (1 - 0.8 * latK), 2.3, 1.1);
    spineYaw = yaw0 + this.torsoYaw.x;

    // Repulsor aim: the arm punches out onto the aim line, palm flat to it.
    // The body has already turned toward the shot (hips, then shoulders);
    // the arm solves in the twisted chest's frame and never leaves its
    // comfortable reach — an aim beyond it is fired from the nearest line
    // the arm can make (the bolt still flies true from the palm). The
    // elbow folds on the way up and drives straight at the end (a punch,
    // not a stiff swing from the shoulder)
    const chestQ = torsoQuaternion(this._qt, yaw, pitch, roll, spineYaw, spineBend, spineSide).invert();
    for (const [side, k] of [
      ['L', arms.aimL],
      ['R', arms.aimR],
    ] as const) {
      if (k <= 0.001) continue;
      const s = side === 'L' ? 1 : -1;
      const ka = k * k * (3 - 2 * k);
      const punch = 4 * ka * (1 - ka);
      // Rolled, the elbow folds across the chest rather than up: keep the
      // fold small and let the shoulder carry the recoil
      const elbow = 0.08 + 0.45 * punch;
      // Shoulders sit ~19 cm off the centre line: aim from there a little
      // toward the centre so the shot converges; a low or high shot swings
      // out to the arm's own side instead (straight down the front, the
      // flat hand pressed down under the chin read as chest compressions;
      // straight up, both hands met over the visor, cross-eyed). The
      // forearm rolls palm-down on the way up and the wrist bends right
      // back, so the flat hand stands fingers-up with the palm square to
      // the shot; solved on the left arm (the right is its mirror image)
      const tc = _tgt.copy(ab).applyQuaternion(chestQ);
      const out = 0.5 * smooth01((Math.abs(tc.y) - 0.3) / 0.6);
      const tgt = clampReach(tc.set(s * tc.x - 0.03 + out, tc.y, tc.z).normalize());
      const palm = suit.palms[0] ?? { at: [0.35, 0.96, 0.03], normal: [-0.94, -0.34, -0.04] };
      const [abd, flex, aimWrist] = aimArm(palm.at, palm.normal, tgt, AIM_TWIST, elbow, 1.4);
      // Flat, firm hand: fingers straight and together, a slight natural splay
      const hand = [-0.1, -0.06, -0.04, -0.02, 0.02];
      if (side === 'L') {
        limbs.armL = lerp(limbs.armL, abd, ka);
        limbs.armFlexL = lerp(limbs.armFlexL, flex, ka);
        limbs.armTwistL = lerp(limbs.armTwistL, AIM_TWIST, ka);
        limbs.elbowL = lerp(limbs.elbowL, elbow, ka);
        wristL = lerp(wristL, aimWrist, ka);
        fingersL = fingersL.map((f, i) => lerp(f, hand[i], ka));
      } else {
        limbs.armR = lerp(limbs.armR, abd, ka);
        limbs.armFlexR = lerp(limbs.armFlexR, flex, ka);
        limbs.armTwistR = lerp(limbs.armTwistR, AIM_TWIST, ka);
        limbs.elbowR = lerp(limbs.elbowR, elbow, ka);
        wristR = lerp(wristR, aimWrist, ka);
        fingersR = fingersR.map((f, i) => lerp(f, hand[i], ka));
      }
    }

    // Braking arms: thrown out low like a skydiver's flare, palms flat to
    // the oncoming air so their jets fire against the motion. The reach
    // follows the travel round the body without a seam: ahead, both arms
    // push forward and down; to one side, that arm swings out to it and
    // the other stays forward; behind (the suit spun round on the aim),
    // both sweep down past the hips and push back from there. Always below
    // the shoulders' line (raised, it shrugged the pauldrons into the
    // helmet and flung an arm up over the back). A raised repulsor arm
    // keeps its shot
    const palmK = Math.max(bk, swk);
    if (palmK > 1e-3) {
      // (and leaned back on the flare, pulled toward the ground with it)
      const down = this._v.set(0, -1, 0).applyQuaternion(this._qi.copy(bodyQ).invert()).applyQuaternion(chestQ);
      for (const side of ['L', 'R'] as const) {
        const k = palmK * (1 - (side === 'L' ? arms.aimL : arms.aimR));
        if (k <= 1e-3) continue;
        const s = side === 'L' ? 1 : -1;
        const tc = _tgt.copy(this.travel).applyQuaternion(chestQ);
        // Travel up the body (still half prone) reads as ahead of the chest
        const phi = Math.atan2(s * tc.x, tc.z + 0.6 * Math.max(0, tc.y));
        // Out in the stream where they show, a little off a mirror (the
        // momentum swing keeps its low reach)
        const odd = side === 'L' ? 1 : -0.8;
        const az = brakeAzimuth(phi) + 0.05 * odd;
        const behind = clamp01(-Math.cos(phi));
        const el = -lerp(lerp(0.7, 0.35, bk / palmK) - 0.04 * odd, 1.05, Math.max(behind, clamp01(-tc.y)));
        tc.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
        // (fast, the air holds them up: the pull to the ground is for the hover)
        const pull = lerp(0.45, 0.12, smooth01((sp - 5) / 30));
        tc.x += pull * s * down.x;
        tc.y += pull * down.y;
        tc.z += pull * down.z;
        const tgt = clampReach(tc.normalize());
        const palm = suit.palms[0] ?? { at: [0.35, 0.96, 0.03], normal: [-0.94, -0.34, -0.04] };
        // Only half the aim's forearm roll: the full roll bent the elbow
        // across the body and the solver hiked the shoulder to make up for it
        // A hard stop forces the elbows softer and splays the fingers
        const elbow = BRAKE_ELBOW + 0.22 * eff;
        const [abd, flex, w] = aimArm(palm.at, palm.normal, tgt, BRAKE_TWIST, elbow, 1.4);
        const hand = [-0.05, -0.1, -0.05, 0, 0.05].map((f, i) => lerp(f, [-0.2, -0.25, -0.18, -0.12, -0.05][i], eff));
        limbs[`arm${side}`] = lerp(limbs[`arm${side}`], abd, k);
        limbs[`armFlex${side}`] = lerp(limbs[`armFlex${side}`], flex, k);
        limbs[`armTwist${side}`] = lerp(limbs[`armTwist${side}`], BRAKE_TWIST, k);
        limbs[`elbow${side}`] = lerp(limbs[`elbow${side}`], elbow, k);
        if (side === 'L') {
          wristL = lerp(wristL, w, k);
          fingersL = fingersL.map((f, i) => lerp(f, hand[i], k));
        } else {
          wristR = lerp(wristR, w, k);
          fingersR = fingersR.map((f, i) => lerp(f, hand[i], k));
        }
      }
    }

    // The air worries at the flared limbs: a tremor that grows with the
    // stream on them (the buffet you hear), nothing in a hover
    const buffet = Math.max(fk, palmK) * m.airbrake * THREE.MathUtils.smoothstep(sp, 6, 140) * (0.5 + 0.5 * eff);
    if (buffet > 1e-3) {
      const shake = (k: number, ph: number) => buffet * k * (Math.sin(t * 13.7 + ph) * 0.6 + Math.sin(t * 21.1 + ph * 2.3) * 0.4);
      for (const [s, ph] of [
        ['L', 0],
        ['R', 2.1],
      ] as const) {
        limbs[`arm${s}`] += shake(0.05, ph);
        limbs[`elbow${s}`] += shake(0.06, ph + 1);
        limbs[`knee${s}`] += shake(0.05, ph + 2);
        limbs[`hipOut${s}`] += shake(0.03, ph + 3);
      }
      // The torso shakes too, slower and smaller (heavier, and unsprung):
      // the arms, solved in the chest's frame, ride it
      const heavy = (k: number, ph: number) => buffet * k * (Math.sin(t * 8.9 + ph) * 0.6 + Math.sin(t * 14.3 + ph * 1.9) * 0.4);
      pitch += heavy(0.02, 0.5);
      spineSide += heavy(0.035 * (1 - 0.6 * latK), 1.7);
      spineYaw += heavy(0.025 * (1 - 0.6 * latK), 3.1);
    }

    // ── Springs: every arm, hand and leg channel ──────────────────────
    // Whatever drives a channel (hover trim, the turn, palm assist, the
    // aim) it reaches the joint through a near-critically damped spring, so
    // a fast rotation of the suit sweeps the palms round instead of
    // snapping them. Raised to shoot, the arm's spring stiffens (the shot
    // still lands on the line); the legs are heavier
    {
      const goals: number[] = [...LIMB_KEYS.map((k) => limbs[k]), wristL, wristR, ...fingersL, ...fingersR];
      if (!this.primed) {
        this.sx.set(goals);
        this.sv.fill(0);
        this.primed = true;
      }
      const armW = lerp(15, 26, aimK) + 10 * pre;
      for (let i = 0; i < N_SPRINGS; i++) {
        const leg = i >= ARM_CHANNELS && i < LIMB_KEYS.length;
        [this.sx[i], this.sv[i]] = springStep(this.sx[i], this.sv[i], goals[i], leg ? 12 : armW, 0.85, dt);
      }
      LIMB_KEYS.forEach((k, i) => (limbs[k] = this.sx[i]));
      wristL = this.sx[LIMB_KEYS.length];
      wristR = this.sx[LIMB_KEYS.length + 1];
      fingersL = Array.from(this.sx.subarray(LIMB_KEYS.length + 2, LIMB_KEYS.length + 7));
      fingersR = Array.from(this.sx.subarray(LIMB_KEYS.length + 7, LIMB_KEYS.length + 12));
    }

    // Each shot kicks the hand up and back off a soft elbow and rocks the
    // chest: a snap on top of the sprung pose
    let kick = 0;
    for (const [side, flash] of [
      ['L', arms.flashL],
      ['R', arms.flashR],
    ] as const) {
      const recoil = flash * flash;
      if (recoil <= 0) continue;
      kick = Math.max(kick, recoil);
      const k = side === 'L' ? arms.aimL : arms.aimR;
      if (side === 'L') {
        limbs.armFlexL -= 0.16 * recoil * k;
        limbs.elbowL += 0.12 * recoil * k;
        wristL += 0.1 * recoil * k;
      } else {
        limbs.armFlexR -= 0.16 * recoil * k;
        limbs.elbowR += 0.12 * recoil * k;
        wristR += 0.1 * recoil * k;
      }
    }

    // ── Walk hook (ground locomotion blends its pose in here) ─────────
    // After the springs: the legs are solved onto planted boots (walkCycle.ts)
    if (m.gait.weight > 1e-3) {
      let twist = 0;
      const free = [1 - smooth01(arms.aimL), 1 - smooth01(arms.aimR)] as const;
      ({ lift, pitch, roll, yaw, twist = 0 } = m.gait.pose(m.pos, bodyQ, limbs, { lift, pitch, roll, yaw }, free));
      spineYaw += twist;
    }

    let strikeNow = false;
    // Falling, the head tips down to watch the ground come
    // (braking hard the chin tucks in, bracing against the stop)
    let headPitch = lerp(this.head.y, 0.55, ff) + 0.18 * eff + 0.15 * windup;
    let headYaw = this.head.x * (1 - 0.6 * ff);
    let headRoll = this.headRoll;

    // ── Hero landing: owns the whole pose from touchdown until it rises ─
    if (crouch > 0 && this.landPose) {
      const L = this.landPose;
      const w = crouch;
      const lt = this.landT;
      // Impact compression: the torso slams on down over the fist and the
      // arm gives, then it all springs back and settles
      const c = lt < 0 ? 0 : lt < LAND_IN + 0.04 ? smooth01((lt - LAND_IN + 0.06) / 0.1) : Math.exp(-(lt - LAND_IN - 0.04) / 0.12) * Math.cos((lt - LAND_IN - 0.04) * 13);
      const comp = this.landImpact * c;
      for (const k of LIMB_KEYS) limbs[k] = lerp(limbs[k], L.limbs[k], w);
      wristL = lerp(wristL, L.wristL, w);
      wristR = lerp(wristR, L.wristR, w);
      fingersL = fingersL.map((f, i) => lerp(f, L.fingersL[i], w));
      fingersR = fingersR.map((f, i) => lerp(f, L.fingersR[i], w));
      // Level the body whatever attitude it came in at, then lean into the three-point
      const ub0 = this._v.set(0, 1, 0).applyQuaternion(this._qi.copy(bodyQ).invert());
      const levelPitch = Math.atan2(ub0.z, ub0.y);
      const levelRoll = -Math.asin(clamp(ub0.x, -1, 1));
      pitch = lerp(pitch, levelPitch + LAND_LEAN, w);
      roll = lerp(roll, levelRoll, w);
      yaw = lerp(yaw, 0, w);
      spineYaw = lerp(spineYaw, LAND_TORSO.twist, w);
      spineBend = lerp(spineBend, this.landBend + 0.12 * comp, w);
      spineSide = lerp(spineSide, LAND_TORSO.side, w);
      // Head down through the impact, then it comes up to look ahead
      const look = smooth01((lt - LAND_LOOK_UP) / 0.35);
      headPitch = lerp(headPitch, lerp(0.55, -0.25, look) + 0.2 * comp, w);
      headYaw = lerp(headYaw, lerp(0.05, -0.1, look), w);
      headRoll = lerp(headRoll, 0, w);
      // Contact: the lowest of the knee, the boots and the fist sits on the
      // ground (the solved pose puts all three there at once)
      // Measured in the levelled frame (the carrier's tilt taken back out)
      const pose: FlightPose = { stance: 0, chestRecoil: 0, headPitch: 0, wristL, wristR, limbs, fingersL, fingersR, pitch: pitch - levelPitch * w, roll: roll - levelRoll * w, yaw, spineYaw, spineBend, spineSide };
      const low = this.lowest(pose, w);
      const groundY = COM.y - m.hipHeight();
      lift = lerp(lift, groundY - low, w);
      if (!this.struck && lt >= LAND_IN) {
        this.struck = true;
        strikeNow = true;
      }
    }

    // ── Control surfaces ──────────────────────────────────────────────
    const rollR = clamp01(rollRate * 0.6 + m.trimRoll * 0.5);
    const rollL = clamp01(-rollRate * 0.6 - m.trimRoll * 0.5);
    const pitchDn = clamp01(pitchRate * 0.7 + m.trimPitch * 0.4);
    const pitchUp = clamp01(-pitchRate * 0.7 - m.trimPitch * 0.4);
    const brake = m.airbrake;
    const flaps: Record<FlapId, number> = {
      'shoulder.L': Math.max(0.6 * rollL, 0.5 * pitchUp, 0.85 * brake),
      'shoulder.R': Math.max(0.6 * rollR, 0.5 * pitchUp, 0.85 * brake),
      'back.L': Math.max(rollL, clamp01(yawRate * 0.5), 0.7 * brake),
      'back.R': Math.max(rollR, clamp01(-yawRate * 0.5), 0.7 * brake),
      'calf.L': Math.max(pitchDn, 0.5 * rollL, 0.9 * brake),
      'calf.R': Math.max(pitchDn, 0.5 * rollR, 0.9 * brake),
      'thigh.L': Math.max(0.8 * pitchDn, 0.4 * rollL, brake),
      'thigh.R': Math.max(0.8 * pitchDn, 0.4 * rollR, brake),
      'launcher.L': arms.launchers,
      'launcher.R': arms.launchers,
      'trap.L': arms.silos,
      'trap.R': arms.silos,
      // (a round leaving knocks its drum back into the seat a touch)
      'flare.L': arms.flares * (1 - 0.3 * arms.flareKickL),
      'flare.R': arms.flares * (1 - 0.3 * arms.flareKickR),
    };
    // Surfaces move like servos: never more than ~3 strokes a second
    for (const id of Object.keys(flaps) as FlapId[]) {
      const prev = this.flapState[id] ?? 0;
      const goal = clamp01(flaps[id]);
      const rate = id.startsWith('launcher') || id.startsWith('trap') || id.startsWith('flare') ? 99 : 3.2;
      this.flapState[id] = prev + clamp(goal - prev, -rate * dt, rate * dt);
    }

    // ── Thrusters ─────────────────────────────────────────────────────
    const thr = m.throttle;
    const hoverShare = 1 - fl;
    // (cut in a fall: not even the idle flicker)
    const boots = m.grounded ? 0 : clamp01(thr * 1.35 + 0.08 * (1 - ff));
    this.outputs.bootL = clamp01(boots * (1 - 0.18 * m.trimRoll));
    this.outputs.bootR = clamp01(boots * (1 + 0.18 * m.trimRoll));
    const palms = m.grounded ? 0 : lerp(0.55, 0.3, fl) * clamp01(thr * 2) + 0.1 * hoverShare * this.dangle * (1 - ff);
    // Braking: both palms burn hard into the travel
    const brakeL = 0.95 * bk * (1 - arms.aimL);
    const brakeR = 0.95 * bk * (1 - arms.aimR);
    // Turn assist: the pushing palm's jet rises with the push, never snaps
    const assistL = 0.85 * clamp01(this.palmAssistL.x) * (1 - arms.aimL);
    const assistR = 0.85 * clamp01(this.palmAssistR.x) * (1 - arms.aimR);
    // Rolling into a bank (or out of one) the palm on the rising side
    // flicks up and kicks the roll off, then settles as the pull takes
    // over; the other one catches the roll as it stops. Keyed off the roll
    // rate's change, not the rate, so a held bank leaves both at their trim
    this.rollSlow += (rollRate - this.rollSlow) * (1 - Math.exp(-dt / 0.3));
    const rollKick = (rollRate - this.rollSlow) * prone * this.dangle * (1 - ub);
    springTo(this.rollFlickL, clamp01(rollKick * 0.45), 14, 0.75, dt);
    springTo(this.rollFlickR, clamp01(-rollKick * 0.45), 14, 0.75, dt);
    const flickL = 0.7 * clamp01(this.rollFlickL.x) * (1 - arms.aimL);
    const flickR = 0.7 * clamp01(this.rollFlickR.x) * (1 - arms.aimR);
    // On boost the palms are thrusters as much as the boots: trailing aft,
    // they burn at the boots' level (a raised arm keeps its shot)
    this.outputs.palmBoost += ((m.boosting ? 1 : 0) - this.outputs.palmBoost) * (1 - Math.exp(-dt / 0.15));
    const pb = this.outputs.palmBoost;
    const palmsL = lerp(palms, this.outputs.bootL, pb);
    const palmsR = lerp(palms, this.outputs.bootR, pb);
    this.outputs.palmL = clamp01(Math.max(palmsL * (1 - 0.3 * m.trimRoll * (1 - pb)) * (1 - arms.aimL) * (1 - ub), assistL, flickL, brakeL, arms.flashL));
    this.outputs.palmR = clamp01(Math.max(palmsR * (1 + 0.3 * m.trimRoll * (1 - pb)) * (1 - arms.aimR) * (1 - ub), assistR, flickR, brakeR, arms.flashR));

    const pose: FlightPose = {
      stance: 0,
      // (the braking palms drive the shoulders back against the curl)
      chestRecoil: -0.4 * ub + 0.35 * kick + 0.2 * bk * (0.5 + 0.5 * eff),
      headPitch,
      headYaw,
      headRoll,
      limbs,
      wristL,
      wristR,
      lift,
      pitch,
      roll,
      yaw,
      spineYaw,
      spineBend,
      spineSide,
      driftX: 0,
      driftZ: 0,
      breath: Math.sin(this.breathPh) * (1 - prone) * lerp(0.6, 0.9, eff) * (1 - crouch),
      legsIn: lerp(0.4, 1, prone) * this.dangle * (1 - crouch),
      fingersL,
      fingersR,
    };
    this.lastPose = pose;
    const frame: FlightCheckFrame = {
      pose,
      flaps: { ...this.flapState } as Record<FlapId, number>,
      spin: { 'flare.L': arms.flareSpinL, 'flare.R': -arms.flareSpinR },
      // Thruster / palm visuals are drawn in world space by the sim
      repulsorL: 0,
      repulsorR: 0,
      chargeL: arms.chargeL,
      chargeR: arms.chargeR,
      lockL: arms.lockL,
      lockR: arms.lockR,
      siloArmed: arms.silos > 0.98 ? arms.siloArmed : 0,
      trimRoll: m.trimRoll,
      trimPitch: m.trimPitch,
      thrusters: 0,
      thrusterL: 0,
      thrusterR: 0,
      status: '',
      active: true,
    };
    // Flare pops are the sim's (world space): keep the check's own clock
    // clear of its salvo window
    suit.setFlightCheck(frame, t % 8);
    if (strikeNow) {
      // The fist's knuckles, in the world, for the impact FX
      let best: THREE.Vector3 | null = null;
      for (const [bone, p] of FIST_R) {
        const v = suit.boneWorldPoint(bone, p, new THREE.Vector3());
        if (!best || v.y < best.y) best = v;
      }
      if (best) this.strike = { at: best, speed: m.impactSpeed };
    }
  }

  private readonly flapState: Partial<Record<FlapId, number>> = {};

  // ── Hero landing ────────────────────────────────────────────────────

  /** 0–1: wind-up for a hero landing in the last instants before a hard touchdown. */
  private preLanding(m: FlightModel): number {
    if (m.grounded || m.posture > 0.9) return 0;
    const sink = -m.vel.y;
    if (sink < 7) return 0;
    const tti = Math.max(0, m.clearance) / sink;
    return smooth01((0.5 - tti) / 0.35) * smooth01((sink - 7) / 3);
  }

  /** Touchdown → slam → hold → rise, and the solved three-point pose. */
  private updateLanding(dt: number, m: FlightModel): void {
    if (m.crouch > this.prevCrouch + 0.05) {
      this.landT = 0;
      this.landAbort = false;
      this.struck = false;
      this.stood = false;
      this.landImpact = clamp01((m.impactSpeed - 5) / 20) * 0.6 + 0.4;
      this.landPose ??= this.solveLanding();
    }
    this.prevCrouch = m.crouch;
    if (this.landT < 0) {
      this.landW = Math.max(0, this.landW - dt / 0.25);
      return;
    }
    this.landT += dt;
    // Flying off before the rise: let go of the pose quickly
    if (!m.grounded) this.landAbort = true;
    if (this.landAbort) {
      this.landW = Math.max(0, this.landW - dt / 0.22);
      if (this.landW <= 0) this.landT = -1;
      return;
    }
    const lt = this.landT;
    // In: fast and decelerating (the knees take it). Out: deliberate
    const win = 1 - (1 - clamp01(lt / LAND_IN)) ** 3;
    const wout = 1 - smooth01((lt - LAND_RISE) / (LAND_UP - LAND_RISE));
    // Blend from wherever the body is (never a jump back up)
    this.landW = lt < LAND_IN ? Math.max(this.landW, win) : wout;
    if (lt >= LAND_UP) {
      this.landT = -1;
      this.landW = 0;
    }
  }

  /**
   * The three-point pose, solved once on the scratch skeleton: right knee
   * down with the shin trailing back and out, left leg lunged out and
   * forward with the boot flat, right fist driven down to the same ground,
   * left arm thrown back. The lunge knee, the punching arm and the tucked
   * toe are each found by bisection so every contact sits on one plane.
   */
  private solveLanding(): NonNullable<SuitDriver['landPose']> {
    const limbs: Required<LimbOffsets> = {
      // Left arm swept back along the body and out, fist clenched
      armL: 0.35,
      armR: 0.05,
      armFlexL: 0.35,
      armFlexR: 0.4,
      armTwistL: 0,
      armTwistR: 0.6,
      elbowL: 0.1,
      elbowR: 0.02,
      // Forward lean swings the legs back: the hip flexion carries it.
      // Left: lunged forward with the knee up by the chest (its knee bend
      // is solved to plant the boot). Right: the thigh back, the knee on
      // the ground, the shin trailing
      hipL: 2.0 + LAND_LEAN,
      hipR: -0.75 + LAND_LEAN,
      hipOutL: 0.35,
      hipOutR: 0.15,
      kneeL: 1.55,
      kneeR: 1.0,
      ankleL: 0,
      ankleR: 0.5,
      footRollL: -0.35,
      footRollR: 0.15,
    };
    const L = {
      limbs,
      wristL: 0.1,
      wristR: -0.1,
      fingersL: [0.6, 0.9, 1, 1, 1],
      fingersR: [0.75, 1, 1, 1, 1],
      bend: LAND_TORSO.bend,
    };
    const pose = (): FlightPose => ({
      stance: 0,
      chestRecoil: 0,
      headPitch: 0,
      wristL: L.wristL,
      wristR: L.wristR,
      limbs,
      fingersL: L.fingersL,
      fingersR: L.fingersR,
      pitch: LAND_LEAN,
      spineYaw: LAND_TORSO.twist,
      spineBend: L.bend,
      spineSide: LAND_TORSO.side,
    });
    const at = (pts: Array<[BoneName, [number, number, number]]>, out = _p) => {
      applyPose(this.fk, pose());
      this.fk.root.updateWorldMatrix(true, true);
      return this.contactMin(pts, out);
    };
    const kneeY = () => at(KNEE_R).y - KNEE_PAD;
    /** Scan [lo, hi] for the root of f nearest `from`, then refine it; no root → the closest miss. */
    const solve = (set: (x: number) => void, lo: number, hi: number, from: number, f: () => number): number => {
      const N = 32;
      let best = from;
      let bestErr = Infinity;
      let prevX = lo;
      set(lo);
      let prevF = f();
      for (let i = 1; i <= N; i++) {
        const x = lo + ((hi - lo) * i) / N;
        set(x);
        const fx = f();
        if (prevF * fx <= 0) {
          // Bracketed: bisect it
          let a = prevX;
          let b = x;
          let fa = prevF;
          for (let k = 0; k < 20; k++) {
            const mid = (a + b) / 2;
            set(mid);
            const fm = f();
            if (fa * fm <= 0) b = mid;
            else {
              a = mid;
              fa = fm;
            }
          }
          const root = (a + b) / 2;
          if (bestErr !== 0 || Math.abs(root - from) < Math.abs(best - from)) {
            best = root;
            bestErr = 0;
          }
        } else if (bestErr !== 0 && Math.abs(fx) < bestErr) {
          best = x;
          bestErr = Math.abs(fx);
        }
        prevX = x;
        prevF = fx;
      }
      set(best);
      return bestErr;
    };
    // Lunge: the knee bend that plants the left boot (flat) on the ground.
    // Boot flat: the foot's pitch in the world is the body's lean + the ankle channel
    limbs.ankleL = -LAND_LEAN;
    solve((x) => (limbs.kneeL = x), 0.6, 2.6, limbs.hipL - LAND_LEAN, () => at(SOLE('L')).y - kneeY());
    // Toes of the kneeling leg tucked onto the ground
    solve((x) => (limbs.kneeR = x), 0.4, 1.8, 1.0, () => at(TOE_R).y - kneeY());
    // Fist down: the arm swings onto the ground; if it can't reach, the
    // torso folds further over it
    for (let i = 0; i < 10; i++) {
      // The shoulder brings the arm in under the chest as far as it helps
      let best = { abd: 0, flex: 0, miss: Infinity };
      for (const abd of [0.05, -0.1, -0.25, -0.4, -0.55]) {
        limbs.armR = abd;
        const miss = solve((x) => (limbs.armFlexR = x), -2.2, 1.2, -1.2, () => at(FIST_R).y - KNUCKLE_PAD - kneeY());
        if (miss < best.miss - 1e-3) best = { abd, flex: limbs.armFlexR, miss };
      }
      limbs.armR = best.abd;
      limbs.armFlexR = best.flex;
      if (best.miss < 0.004) break;
      L.bend += 0.04;
    }
    this.landBend = L.bend;
    return L;
  }

  /** Lowest contact (y, model space at lift 0) of the pose on the scratch skeleton. */
  private lowest(pose: FlightPose, w: number): number {
    applyPose(this.fk, { ...pose, lift: 0 });
    this.fk.root.updateWorldMatrix(true, true);
    const soles = Math.min(this.contactMin(SOLE('L'), _p).y, this.contactMin(SOLE('R'), _p).y);
    // Knee and fist only bear as the body comes right down into the crouch
    const late = 0.6 * (1 - w);
    return Math.min(soles, this.contactMin(KNEE_R, _p).y - KNEE_PAD + late, this.contactMin(FIST_R, _p).y - KNUCKLE_PAD + late);
  }

  /** The lowest of a set of bone-carried bind points on the scratch skeleton (model space). */
  private contactMin(pts: Array<[BoneName, [number, number, number]]>, out: THREE.Vector3): THREE.Vector3 {
    let best = Infinity;
    const v = _n;
    for (const [bone, p] of pts) {
      const h = boneSpec(bone).head;
      v.set(p[0] - h[0], p[1] - h[1], p[2] - h[2]).applyMatrix4(this.fk.bones[bone].matrixWorld);
      if (v.y < best) {
        best = v.y;
        out.copy(v);
      }
    }
    return out;
  }
}
