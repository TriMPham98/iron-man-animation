import * as THREE from 'three';
import { ARM_DIMS } from './fittingProgram';
import { mergeStaticTree } from './mergeStatic';
import { DECAL_RECTS, decalPlane, type RobotMaterials } from './robotMaterials';

/**
 * Six-axis industrial arm (yaw · shoulder · elbow · wrist roll/pitch/roll)
 * with a parallel gripper and an integrated nut runner.
 *
 * Link convention: every link points along its local +Y; pitch joints rotate
 * about local X (positive swings +Y toward +Z, the arm's forward); roll joints
 * rotate about local Y. The tool's +Y is the approach axis (into the part),
 * +Z its "up", and the jaws open along X.
 */

export interface ArmJoints {
  yaw: number;
  shoulder: number;
  elbow: number;
  wristRoll: number;
  wristPitch: number;
  flangeRoll: number;
  /** Distance the wrist centre missed by (0 when reachable). */
  error: number;
}

export interface ArmDims {
  shoulder: number;
  upper: number;
  fore: number;
  wristToTcp: number;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _w = new THREE.Vector3();
const _t = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** Tool orientation from an approach axis and an up hint (both arm-local). */
export function toolQuaternion(
  approach: THREE.Vector3,
  up: THREE.Vector3,
  out = new THREE.Quaternion(),
): THREE.Quaternion {
  _y.copy(approach).normalize();
  _z.copy(up).addScaledVector(_y, -up.dot(_y));
  if (_z.lengthSq() < 1e-8) {
    _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    if (_z.lengthSq() < 1e-8) _z.set(1, 0, 0);
  }
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Closed-form IK in the arm's mount frame: TCP position + tool orientation →
 * joint angles (either elbow branch). Unreachable targets stretch toward the
 * target and report the residual in `error`.
 */
export function solveArmIK(
  tcp: THREE.Vector3,
  toolQuat: THREE.Quaternion,
  dims: ArmDims = ARM_DIMS,
  out: ArmJoints = {
    yaw: 0,
    shoulder: 0,
    elbow: 0,
    wristRoll: 0,
    wristPitch: 0,
    flangeRoll: 0,
    error: 0,
  },
  /** +1 elbow toward the mount's +Y (up for floor arms), −1 the other branch. */
  elbowSign: 1 | -1 = 1,
): ArmJoints {
  // Wrist centre sits back along the approach axis
  _t.set(0, 1, 0).applyQuaternion(toolQuat);
  _w.copy(tcp).addScaledVector(_t, -dims.wristToTcp);

  out.yaw = Math.atan2(_w.x, _w.z);
  const r = Math.hypot(_w.x, _w.z);
  const h = _w.y - dims.shoulder;
  const L2 = dims.upper;
  const L3 = dims.fore;
  const dRaw = Math.hypot(r, h);
  const d = THREE.MathUtils.clamp(dRaw, Math.abs(L2 - L3) + 1e-4, L2 + L3 - 1e-4);
  out.error = Math.max(0, dRaw - d);

  // Elbow branch: +1 puts the upper arm above the shoulder→wrist line
  const alpha =
    Math.atan2(h, r) +
    elbowSign *
    Math.acos(THREE.MathUtils.clamp((L2 * L2 + d * d - L3 * L3) / (2 * L2 * d), -1, 1));
  const er = L2 * Math.cos(alpha);
  const eh = L2 * Math.sin(alpha);
  // Forearm aims at the (possibly clamped) wrist point on the same ray
  const wr = (r / (dRaw || 1)) * d;
  const wh = (h / (dRaw || 1)) * d;
  const beta = Math.atan2(wh - eh, wr - er);
  out.shoulder = Math.PI / 2 - alpha;
  out.elbow = alpha - beta;

  // Wrist: Qrel = F⁻¹·Qtool, decomposed roll(Y)·pitch(X)·roll(Y)
  _qa.setFromAxisAngle(Y, out.yaw);
  _qb.setFromAxisAngle(X, out.shoulder + out.elbow);
  _qf.multiplyQuaternions(_qa, _qb);
  _qr.copy(_qf).invert().multiply(toolQuat);
  _t.set(0, 1, 0).applyQuaternion(_qr);
  out.wristPitch = Math.acos(THREE.MathUtils.clamp(_t.y, -1, 1));
  const s = Math.sin(out.wristPitch);
  out.wristRoll = s < 1e-3 ? 0 : Math.atan2(_t.x, _t.z);
  _qa.setFromAxisAngle(Y, out.wristRoll);
  _qb.setFromAxisAngle(X, out.wristPitch);
  _qt.multiplyQuaternions(_qa, _qb).invert().multiply(_qr);
  out.flangeRoll = 2 * Math.atan2(_qt.y, _qt.w);
  return out;
}

/** Forward kinematics (mount frame) — TCP position + tool quaternion. */
export function armForward(
  j: ArmJoints,
  dims: ArmDims = ARM_DIMS,
  outPos = new THREE.Vector3(),
  outQuat = new THREE.Quaternion(),
): { pos: THREE.Vector3; quat: THREE.Quaternion } {
  const q = new THREE.Quaternion().setFromAxisAngle(Y, j.yaw);
  const p = new THREE.Vector3(0, dims.shoulder, 0);
  const step = (axis: THREE.Vector3, angle: number) =>
    q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  step(X, j.shoulder);
  p.add(new THREE.Vector3(0, dims.upper, 0).applyQuaternion(q));
  step(X, j.elbow);
  p.add(new THREE.Vector3(0, dims.fore, 0).applyQuaternion(q));
  step(Y, j.wristRoll);
  step(X, j.wristPitch);
  step(Y, j.flangeRoll);
  p.add(new THREE.Vector3(0, dims.wristToTcp, 0).applyQuaternion(q));
  outPos.copy(p);
  outQuat.copy(q);
  return { pos: outPos, quat: outQuat };
}

// ── Geometry ─────────────────────────────────────────────────────────────

export { createRobotMaterials } from './robotMaterials';
export type { RobotMaterials } from './robotMaterials';

const box = (w: number, h: number, d: number, m: THREE.Material, y = h / 2) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.y = y;
  return mesh;
};
/** Cylinder whose axis runs along local X (joint hubs). */
const hub = (r: number, len: number, m: THREE.Material) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 28), m);
  mesh.rotation.z = Math.PI / 2;
  return mesh;
};
const cyl = (r0: number, r1: number, h: number, m: THREE.Material, y = h / 2, seg = 28) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, h, seg), m);
  mesh.position.y = y;
  return mesh;
};

/** Folded transport pose the arm tucks into before it stows. */
const FOLDED: Omit<ArmJoints, 'error'> = {
  yaw: 0,
  shoulder: -0.32,
  elbow: 2.75,
  wristRoll: 0,
  wristPitch: 1.35,
  flangeRoll: 0,
};
/** Mast arms fold flat up under their trolley, away from the suit. */
const FOLDED_CEILING: Omit<ArmJoints, 'error'> = {
  yaw: 0,
  shoulder: -1.35,
  elbow: 2.7,
  wristRoll: 0,
  wristPitch: 1.2,
  flangeRoll: 0,
};

/**
 * One robot: round pedestal (floor) or trolley (mast), joint chain and an
 * end effector — gripper with nut runner, or rivet gun.
 * `group` sits at the mount point with +Z facing the suit (flipped for
 * ceiling arms so the arm hangs down).
 */
export class RobotArm {
  readonly group = new THREE.Group();
  readonly joints: ArmJoints = {
    yaw: 0,
    shoulder: 0,
    elbow: 0,
    wristRoll: 0,
    wristPitch: 0,
    flangeRoll: 0,
    error: 0,
  };
  /** Mount point when deployed (world). */
  readonly base: THREE.Vector3;
  private readonly turret = new THREE.Group();
  private readonly shoulderJ = new THREE.Group();
  private readonly elbowJ = new THREE.Group();
  private readonly wrist1 = new THREE.Group();
  private readonly wrist2 = new THREE.Group();
  private readonly flange = new THREE.Group();
  private fingerA: THREE.Mesh | null = null;
  private fingerB: THREE.Mesh | null = null;
  private spindle: THREE.Group | null = null;
  private barrel: THREE.Group | null = null;
  /** Counterbalance cylinder (turret → upper arm). */
  private readonly ramBody: THREE.Mesh;
  private readonly ramRod: THREE.Mesh;
  private readonly ramA = new THREE.Vector3(0, 0.2, -0.13);
  private readonly ramB = new THREE.Vector3(0, 0.26, -0.06);
  private readonly mountInv = new THREE.Matrix4();
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();

  constructor(
    readonly id: string,
    base: readonly [number, number, number],
    readonly mount: 'floor' | 'ceiling',
    readonly pedestal: number,
    mats: RobotMaterials,
    readonly tool: 'gripper' | 'riveter' = 'gripper',
    readonly dims: ArmDims = ARM_DIMS,
  ) {
    this.group.name = `robot-${id}`;
    this.base = new THREE.Vector3(base[0], base[1], base[2]);
    this.group.position.copy(this.base);
    const face = Math.atan2(-base[0], -base[2]);
    const q = new THREE.Quaternion().setFromAxisAngle(Y, face);
    if (mount === 'ceiling') {
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
    }
    this.group.quaternion.copy(q);

    // Round pedestal (rides an elevator in its floor well) or mast trolley
    if (mount === 'floor' && pedestal > 0) {
      this.group.add(cyl(0.19, 0.19, pedestal, mats.dark, -pedestal / 2, 36));
      this.group.add(cyl(0.192, 0.192, 0.025, mats.accent, -pedestal + 0.04, 36));
      this.group.add(cyl(0.2, 0.2, 0.02, mats.metal, -0.01, 36));
    } else if (mount === 'ceiling') {
      this.group.add(cyl(0.16, 0.16, 0.12, mats.dark, -0.06, 32));
      this.group.add(cyl(0.165, 0.165, 0.02, mats.accent, -0.1, 32));
    }
    this.group.add(cyl(0.17, 0.17, 0.06, mats.dark, 0.03, 32));

    // J1 turret
    this.group.add(this.turret);
    this.turret.add(cyl(0.14, 0.12, 0.26, mats.paint, 0.19, 32));
    this.turret.add(cyl(0.145, 0.145, 0.02, mats.accent, 0.07, 32));
    const motor = box(0.1, 0.13, 0.09, mats.dark, 0.22);
    motor.position.z = -0.14;
    this.turret.add(motor);
    const motorCap = box(0.104, 0.02, 0.094, mats.metal, 0.29);
    motorCap.position.z = -0.14;
    this.turret.add(motorCap);
    const led = box(0.03, 0.012, 0.006, mats.led, 0.27);
    led.position.z = 0.125;
    this.turret.add(led);
    const maker = decalPlane(mats, DECAL_RECTS.axes, 0.12);
    maker.position.set(0, 0.17, 0.142);
    this.turret.add(maker);

    // J2 shoulder + upper link
    this.shoulderJ.position.y = dims.shoulder;
    this.turret.add(this.shoulderJ);
    this.shoulderJ.add(hub(0.09, 0.22, mats.paint));
    this.shoulderJ.add(hub(0.094, 0.03, mats.accent));
    this.shoulderJ.add(hub(0.05, 0.235, mats.metal));
    this.shoulderJ.add(box(0.11, dims.upper, 0.095, mats.paint));
    const upperRib = box(0.125, dims.upper * 0.62, 0.03, mats.dark, dims.upper * 0.45);
    upperRib.position.z = -0.055;
    this.shoulderJ.add(upperRib);
    for (const side of [-1, 1]) {
      const plate = decalPlane(mats, DECAL_RECTS.maker, 0.24);
      plate.rotation.set(0, (side * Math.PI) / 2, Math.PI / 2);
      plate.position.set(side * 0.0565, dims.upper * 0.5, 0);
      this.shoulderJ.add(plate);
      const warn = decalPlane(mats, DECAL_RECTS.hazard, 0.2);
      warn.rotation.set(0, (side * Math.PI) / 2, Math.PI / 2);
      warn.position.set(side * 0.0565, dims.upper * 0.82, 0);
      this.shoulderJ.add(warn);
    }
    const loom = cyl(0.016, 0.016, dims.upper * 0.85, mats.rubber, dims.upper * 0.48, 10);
    loom.position.set(0.064, 0, 0.03);
    this.shoulderJ.add(loom);

    // J3 elbow + forearm
    this.elbowJ.position.y = dims.upper;
    this.shoulderJ.add(this.elbowJ);
    this.elbowJ.add(hub(0.07, 0.17, mats.paint));
    this.elbowJ.add(hub(0.074, 0.025, mats.accent));
    this.elbowJ.add(hub(0.04, 0.18, mats.metal));
    const elbowMotor = box(0.08, 0.11, 0.075, mats.dark, -0.02);
    elbowMotor.position.z = -0.08;
    this.elbowJ.add(elbowMotor);
    this.elbowJ.add(cyl(0.05, 0.038, dims.fore - 0.06, mats.paint, (dims.fore - 0.06) / 2));
    const rating = decalPlane(mats, DECAL_RECTS.payload, 0.15);
    rating.rotation.set(0, Math.PI / 2, Math.PI / 2);
    rating.position.set(0.046, dims.fore * 0.45, 0);
    this.elbowJ.add(rating);
    const cable = cyl(0.014, 0.014, dims.fore * 0.8, mats.rubber, dims.fore * 0.45, 8);
    cable.position.x = 0.045;
    cable.position.z = 0.02;
    this.elbowJ.add(cable);

    // J4–J6 wrist
    this.wrist1.position.y = dims.fore;
    this.elbowJ.add(this.wrist1);
    this.wrist1.add(cyl(0.042, 0.042, 0.05, mats.dark, -0.03));
    this.wrist1.add(this.wrist2);
    this.wrist2.add(hub(0.042, 0.1, mats.paint));
    this.wrist2.add(hub(0.045, 0.02, mats.accent));
    this.wrist2.add(this.flange);
    this.flange.add(cyl(0.04, 0.036, 0.08, mats.paint, 0.04));
    this.flange.add(cyl(0.045, 0.045, 0.012, mats.metal, 0.086));

    if (tool === 'gripper') this.buildGripper(mats);
    else this.buildRivetGun(mats);

    // Counterbalance ram from the turret to the upper arm (re-aimed per frame)
    this.ramBody = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 12), mats.dark);
    this.ramRod = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 1, 10), mats.chrome);
    this.ramBody.userData.dynamic = true;
    this.ramRod.userData.dynamic = true;
    this.turret.add(this.ramBody, this.ramRod);
    mergeStaticTree(this.group);

    this.setGripper(1);
    this.group.updateMatrixWorld(true);
  }

  /** Parallel gripper (jaws open along X) + integrated nut runner. */
  private buildGripper(mats: RobotMaterials): void {
    this.flange.add(box(0.11, 0.07, 0.06, mats.dark, 0.13));
    this.flange.add(box(0.22, 0.014, 0.024, mats.metal, 0.172));
    const a = box(0.016, 0.1, 0.034, mats.accent, 0.23);
    const b = box(0.016, 0.1, 0.034, mats.accent, 0.23);
    a.userData.dynamic = true;
    b.userData.dynamic = true;
    this.flange.add(a, b);
    this.fingerA = a;
    this.fingerB = b;
    const spindle = new THREE.Group();
    spindle.position.set(0, 0.17, 0.05);
    spindle.add(cyl(0.016, 0.016, 0.05, mats.chrome, 0.025, 12));
    const bit = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.03, 6), mats.dark);
    bit.position.y = 0.06;
    spindle.add(bit);
    this.flange.add(spindle);
    this.spindle = spindle;
  }

  /** Pneumatic rivet gun: body, feed magazine, recoiling barrel. */
  private buildRivetGun(mats: RobotMaterials): void {
    this.flange.add(box(0.075, 0.11, 0.085, mats.accent, 0.15));
    const mag = box(0.03, 0.08, 0.05, mats.dark, 0.15);
    mag.position.x = 0.052;
    this.flange.add(mag);
    const hose = cyl(0.01, 0.01, 0.12, mats.rubber, 0.12, 8);
    hose.position.z = -0.05;
    this.flange.add(hose);
    const barrel = new THREE.Group();
    barrel.add(cyl(0.02, 0.02, 0.06, mats.metal, 0.23, 16));
    barrel.add(cyl(0.012, 0.016, 0.02, mats.chrome, 0.27, 16));
    this.flange.add(barrel);
    this.barrel = barrel;
  }

  /** Jaw opening 0 (closed on the part) → 1 (open). */
  setGripper(open: number): void {
    if (!this.fingerA || !this.fingerB) return;
    const o = THREE.MathUtils.clamp(open, 0, 1);
    const half = 0.055 + o * 0.055;
    this.fingerA.position.x = -half;
    this.fingerB.position.x = half;
  }

  setSpindle(angle: number): void {
    if (this.spindle) this.spindle.rotation.y = angle;
  }

  /** Rivet gun barrel recoil 0–1. */
  setRecoil(r: number): void {
    if (this.barrel) this.barrel.position.y = -0.022 * THREE.MathUtils.clamp(r, 0, 1);
  }

  /**
   * World positions along the arm (shoulder, elbow, wrist, TCP) for
   * clearance checks against the suit.
   */
  linkPoints(): THREE.Vector3[] {
    this.group.updateMatrixWorld(true);
    return [
      this.shoulderJ.getWorldPosition(new THREE.Vector3()),
      this.elbowJ.getWorldPosition(new THREE.Vector3()),
      this.wrist1.getWorldPosition(new THREE.Vector3()),
      new THREE.Vector3(0, this.dims.wristToTcp, 0).applyMatrix4(this.flange.matrixWorld),
    ];
  }

  /** Point the TCP at a world-space pose; returns the residual reach error. */
  reachWorld(tcp: THREE.Vector3, toolQuat: THREE.Quaternion): number {
    this.group.updateWorldMatrix(true, false);
    this.mountInv.copy(this.group.matrixWorld).invert();
    this._p.copy(tcp).applyMatrix4(this.mountInv);
    this.group.getWorldQuaternion(this._q).invert().multiply(toolQuat);
    // Mast arms keep their elbows up toward the ceiling, clear of the suit
    solveArmIK(this._p, this._q, this.dims, this.joints, this.mount === 'ceiling' ? -1 : 1);
    this.applyJoints();
    return this.joints.error;
  }

  /**
   * Stow 0 → 1: blend the current joints into the folded transport pose
   * (first 35%), then ride the elevator down into the floor well — or up
   * the mast into the ceiling — for the rest.
   */
  setStow(u: number, depth: number): void {
    const s = THREE.MathUtils.clamp(u, 0, 1);
    // Mast arms climb while they fold (never swing down past the suit)
    const ceiling = this.mount === 'ceiling';
    const fold = THREE.MathUtils.smoothstep(s, 0, ceiling ? 0.5 : 0.35);
    if (fold > 0) {
      const j = this.joints;
      const target = ceiling ? FOLDED_CEILING : FOLDED;
      for (const k of Object.keys(target) as Array<keyof typeof target>) {
        j[k] = THREE.MathUtils.lerp(j[k], target[k], fold);
      }
      this.applyJoints();
    }
    const travel = (ceiling ? s : THREE.MathUtils.smoothstep(s, 0.35, 1)) * depth;
    this.group.position.copy(this.base);
    this.group.position.y += this.mount === 'floor' ? -travel : travel;
    this.group.visible = s < 0.999;
  }

  applyJoints(): void {
    const j = this.joints;
    this.turret.rotation.y = j.yaw;
    this.shoulderJ.rotation.x = j.shoulder;
    this.elbowJ.rotation.x = j.elbow;
    this.wrist1.rotation.y = j.wristRoll;
    this.wrist2.rotation.x = j.wristPitch;
    this.flange.rotation.y = j.flangeRoll;

    // Ram: fixed pivot on the turret, other end rides the upper arm
    this._a.copy(this.ramA);
    this._b
      .copy(this.ramB)
      .applyAxisAngle(X, j.shoulder)
      .add(this._p.set(0, this.dims.shoulder, 0));
    const len = this._a.distanceTo(this._b);
    const mid = this._p.addVectors(this._a, this._b).multiplyScalar(0.5);
    const dir = this._b.sub(this._a).normalize();
    this._q.setFromUnitVectors(Y, dir);
    this.ramBody.position.copy(mid).addScaledVector(dir, -len * 0.2);
    this.ramBody.quaternion.copy(this._q);
    this.ramBody.scale.set(1, len * 0.6, 1);
    this.ramRod.position.copy(mid).addScaledVector(dir, len * 0.25);
    this.ramRod.quaternion.copy(this._q);
    this.ramRod.scale.set(1, len * 0.5, 1);
  }
}
