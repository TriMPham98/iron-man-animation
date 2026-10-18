import * as THREE from 'three';
import type { FlapId, FlightCheckFrame } from '../../animation/flightCheck';
import type { LimbOffsets } from '../../suit/rigPose';
import type { Suit } from '../../suit/Suit';
import { FLIGHT_POSTURE, type FlightModel } from './flightModel';

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
  /** Palm discharge flash / charge 0–1. */
  flashL: number;
  flashR: number;
  chargeL: number;
  chargeR: number;
  /** Shoulder silos open 0–1 and rockets still in their cells (0–6). */
  silos: number;
  siloArmed: number;
  /** Forearm launchers out 0–1 and their lock pulses. */
  launchers: number;
  lockL: number;
  lockR: number;
  /** Hip flare drums out 0–1 and their turn (rad). */
  flares: number;
  flareSpin: number;
  /** Unibeam: 0–1, arms swept back, chest forward. */
  unibeam: number;
}

export const IDLE_ARMS = (): ArmsState => ({
  aimL: 0,
  aimR: 0,
  flashL: 0,
  flashR: 0,
  chargeL: 0,
  chargeR: 0,
  silos: 0,
  siloArmed: 6,
  launchers: 0,
  lockL: 0,
  lockR: 0,
  flares: 0,
  flareSpin: 0,
  unibeam: 0,
});

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const clamp01 = (x: number) => clamp(x, 0, 1);
/** Centre of mass in bind space (the rig tilts about the hips). */
const COM = new THREE.Vector3(0, 1.0, 0);

export interface SuitOutputs {
  bootL: number;
  bootR: number;
  palmL: number;
  palmR: number;
}

export class SuitDriver {
  private time = 0;
  private readonly carrier = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _qi = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();
  private readonly _t = new THREE.Matrix4();
  /** Smoothed visual channels (so the body never snaps). */
  private head = new THREE.Vector2();
  private dangle = 0;
  private headRoll = 0;
  readonly outputs: SuitOutputs = { bootL: 0, bootR: 0, palmL: 0, palmR: 0 };

  update(dt: number, suit: Suit, m: FlightModel, aim: THREE.Vector3, arms: ArmsState): void {
    this.time += dt;
    const t = this.time;
    const fl = m.flightness;
    const prone = Math.sin(m.posture) / Math.sin(FLIGHT_POSTURE);
    const air = m.grounded ? 0 : 1;
    this.dangle += (air - this.dangle) * (1 - Math.exp(-dt / 0.35));
    const crouch = m.crouch > 0 ? Math.sin(Math.min(1, m.crouch / 1.4) * Math.PI * 0.5) : 0;

    // Carrier: world ← body orientation about the centre of mass
    const bodyQ = m.bodyQuaternion(this._q);
    this.carrier.compose(m.pos, bodyQ, this._v.set(1, 1, 1)).multiply(this._t.makeTranslation(-COM.x, -COM.y, -COM.z));
    suit.setCarrier(this.carrier);

    // Aim in the body frame (X left, Y head, Z chest)
    const a = this._aim.copy(aim).applyQuaternion(this._qi.copy(bodyQ).invert());

    // ── Head: look where we're going / aiming ─────────────────────────
    const wantYaw = clamp(Math.atan2(a.x, Math.hypot(a.y, a.z)), -0.75, 0.75);
    const wantPitch = clamp(-Math.atan2(a.y, Math.max(0.05, a.z)), -1.05, 0.45);
    this.head.x += (wantYaw - this.head.x) * (1 - Math.exp(-dt / 0.16));
    this.head.y += (wantPitch - this.head.y) * (1 - Math.exp(-dt / 0.16));
    // Head counters a little of the bank (horizon reflex)
    const up = m.up(this._v);
    const bankNow = Math.atan2(new THREE.Vector3().crossVectors(up, m.forward()).y, up.y);
    this.headRoll += (clamp(-bankNow * 0.25, -0.3, 0.3) - this.headRoll) * (1 - Math.exp(-dt / 0.3));

    // ── Limbs ─────────────────────────────────────────────────────────
    const sway = (k: number, ph: number) => this.dangle * (1 - prone) * k * Math.sin(t * 1.9 + ph);
    const rollRate = m.omega.z;
    const pitchRate = m.omega.x;
    const limbs: Required<LimbOffsets> = {
      // Trailing arms in flight; the low wing's arm reaches out to steer
      armL: lerp(0.1, 0.16, prone) + clamp(-rollRate * 0.18, 0, 0.35) * prone + sway(0.015, 0.4),
      armR: lerp(0.1, 0.16, prone) + clamp(rollRate * 0.18, 0, 0.35) * prone + sway(0.015, 1.4),
      armFlexL: 0.05 * prone,
      armFlexR: 0.05 * prone,
      armTwistL: 0,
      armTwistR: 0,
      elbowL: lerp(0.18, 0.08, prone) * this.dangle + sway(0.03, 2),
      elbowR: lerp(0.18, 0.08, prone) * this.dangle + sway(0.03, 3),
      // Legs: soft knees dangling in a hover, straight and toes pointed in flight
      hipL: (0.08 + sway(0.02, 1.1)) * this.dangle * (1 - prone) + 0.08 * m.airbrake,
      hipR: (0.08 + sway(0.02, 2.3)) * this.dangle * (1 - prone) + 0.08 * m.airbrake,
      hipOutL: -0.3 * m.trimRoll * 0.2,
      hipOutR: 0.3 * m.trimRoll * 0.2,
      kneeL: (lerp(0.16, 0.05, prone) + sway(0.03, 0)) * this.dangle + 0.15 * m.airbrake,
      kneeR: (lerp(0.16, 0.05, prone) + sway(0.03, 0.7)) * this.dangle + 0.15 * m.airbrake,
      ankleL: lerp(0.14 + 0.25 * m.trimPitch, 0.55, prone) * this.dangle,
      ankleR: lerp(0.14 + 0.25 * m.trimPitch, 0.55, prone) * this.dangle,
      footRollL: 0.2 * m.trimRoll * this.dangle * (1 - prone),
      footRollR: 0.2 * m.trimRoll * this.dangle * (1 - prone),
    };
    // Palms to the feet (thrust aft in flight, down in a hover): wrists in an L
    const palmsDown = this.dangle;
    let wristL = 1.45 * palmsDown;
    let wristR = 1.45 * palmsDown;
    let fingersL: number[] = [0.08, 0.12, 0.15, 0.18, 0.2].map((r) => lerp(r, -0.25, palmsDown));
    let fingersR = fingersL.slice();

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

    // Repulsor aim: the arm swings onto the aim line, palm flat to it
    for (const [side, k] of [
      ['L', arms.aimL],
      ['R', arms.aimR],
    ] as const) {
      if (k <= 0.001) continue;
      const s = side === 'L' ? 1 : -1;
      // Shoulders sit ~19 cm off the centre line: aim from there a little
      // toward the centre so the shot converges
      const dx = a.x - s * 0.03;
      const abd = Math.asin(clamp(dx * s, -0.35, 0.95));
      let flex = Math.atan2(-a.z, -a.y);
      if (flex > 0.6) flex -= Math.PI * 2;
      flex = clamp(flex, -3.25, 0.4);
      const ka = k * k * (3 - 2 * k);
      if (side === 'L') {
        limbs.armL = lerp(limbs.armL, abd, ka);
        limbs.armFlexL = lerp(limbs.armFlexL, flex, ka);
        limbs.elbowL = lerp(limbs.elbowL, 0.04, ka);
        wristL = lerp(wristL, 1.38, ka);
        fingersL = fingersL.map((f) => lerp(f, -0.3, ka));
      } else {
        limbs.armR = lerp(limbs.armR, abd, ka);
        limbs.armFlexR = lerp(limbs.armFlexR, flex, ka);
        limbs.elbowR = lerp(limbs.elbowR, 0.04, ka);
        wristR = lerp(wristR, 1.38, ka);
        fingersR = fingersR.map((f) => lerp(f, -0.3, ka));
      }
    }

    // Hero landing: down on one knee, a fist on the ground
    let lift = 0;
    let pitch = 0;
    if (crouch > 0) {
      limbs.hipL = lerp(limbs.hipL, 1.45, crouch);
      limbs.kneeL = lerp(limbs.kneeL, 1.7, crouch);
      limbs.ankleL = lerp(limbs.ankleL, -0.1, crouch);
      limbs.hipR = lerp(limbs.hipR, 0.25, crouch);
      limbs.kneeR = lerp(limbs.kneeR, 1.95, crouch);
      limbs.ankleR = lerp(limbs.ankleR, 0.9, crouch);
      limbs.hipOutL = lerp(limbs.hipOutL, 0.25, crouch);
      limbs.armFlexR = lerp(limbs.armFlexR, -0.45, crouch);
      limbs.armR = lerp(limbs.armR, 0.08, crouch);
      limbs.elbowR = lerp(limbs.elbowR, 0.1, crouch);
      fingersR = fingersR.map((f) => lerp(f, 1, crouch));
      wristR = lerp(wristR, 0, crouch);
      limbs.armL = lerp(limbs.armL, 0.75, crouch);
      limbs.armFlexL = lerp(limbs.armFlexL, 0.5, crouch);
      limbs.elbowL = lerp(limbs.elbowL, 0.5, crouch);
      wristL = lerp(wristL, 0.4, crouch);
      lift = -0.55 * crouch;
      pitch = 0.42 * crouch;
    }

    // ── Control surfaces ──────────────────────────────────────────────
    const rollR = clamp01(rollRate * 0.6 + m.trimRoll * 0.5);
    const rollL = clamp01(-rollRate * 0.6 - m.trimRoll * 0.5);
    const pitchDn = clamp01(pitchRate * 0.7 + m.trimPitch * 0.4);
    const pitchUp = clamp01(-pitchRate * 0.7 - m.trimPitch * 0.4);
    const yawRate = m.omega.y;
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
      'flare.L': arms.flares,
      'flare.R': arms.flares,
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
    const boots = m.grounded ? 0 : clamp01(thr * 1.35 + 0.08);
    this.outputs.bootL = clamp01(boots * (1 - 0.18 * m.trimRoll));
    this.outputs.bootR = clamp01(boots * (1 + 0.18 * m.trimRoll));
    const palms = m.grounded ? 0 : lerp(0.55, 0.3, fl) * clamp01(thr * 2) + 0.1 * hoverShare * this.dangle;
    this.outputs.palmL = clamp01(Math.max(palms * (1 - 0.3 * m.trimRoll) * (1 - arms.aimL) * (1 - ub), arms.flashL));
    this.outputs.palmR = clamp01(Math.max(palms * (1 + 0.3 * m.trimRoll) * (1 - arms.aimR) * (1 - ub), arms.flashR));

    const frame: FlightCheckFrame = {
      pose: {
        stance: 0,
        chestRecoil: -0.4 * ub,
        headPitch: this.head.y,
        headYaw: this.head.x,
        headRoll: this.headRoll,
        limbs,
        wristL,
        wristR,
        lift,
        pitch,
        roll: 0,
        driftX: 0,
        driftZ: 0,
        breath: Math.sin(t * 1.7) * (1 - prone) * 0.6,
        legsIn: lerp(0.4, 1, prone) * this.dangle * (1 - crouch),
        fingersL,
        fingersR,
      },
      flaps: { ...this.flapState } as Record<FlapId, number>,
      spin: { 'flare.L': arms.flareSpin, 'flare.R': -arms.flareSpin },
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
  }

  private readonly flapState: Partial<Record<FlapId, number>> = {};
}
