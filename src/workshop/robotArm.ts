import * as THREE from 'three';
import { ARM_DIMS } from './fittingProgram';
import { mergeStaticTree } from './mergeStatic';
import { DECAL_RECTS, decalPlane, type RobotMaterials } from './robotMaterials';
import { block, boltCircle, cable, capsuleOutline, drum, hubX, hull, lathe, roundedRect, slabX, slabY } from './robotParts';

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

const TAU = Math.PI * 2;
const wrapNear = (a: number, ref: number) => a + TAU * Math.round((ref - a) / TAU);

/**
 * Make an IK solution continuous with a reference configuration: pick the
 * wrist branch (roll, pitch, roll) vs (roll+π, −pitch, roll+π) nearest the
 * reference and unwrap the revolute joints by whole turns, so a moving
 * target never makes a joint jump.
 */
export function continueFrom(j: ArmJoints, ref: Readonly<ArmJoints>): ArmJoints {
  const cost = (r: number, p: number, f: number) =>
    Math.abs(wrapNear(r, ref.wristRoll) - ref.wristRoll) +
    Math.abs(p - ref.wristPitch) +
    Math.abs(wrapNear(f, ref.flangeRoll) - ref.flangeRoll);
  const a = cost(j.wristRoll, j.wristPitch, j.flangeRoll);
  const b = cost(j.wristRoll + Math.PI, -j.wristPitch, j.flangeRoll + Math.PI);
  if (b < a) {
    j.wristRoll += Math.PI;
    j.wristPitch = -j.wristPitch;
    j.flangeRoll += Math.PI;
  }
  j.yaw = wrapNear(j.yaw, ref.yaw);
  j.wristRoll = wrapNear(j.wristRoll, ref.wristRoll);
  j.flangeRoll = wrapNear(j.flangeRoll, ref.flangeRoll);
  return j;
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
  private fingerA: THREE.Object3D | null = null;
  private fingerB: THREE.Object3D | null = null;
  private spindle: THREE.Group | null = null;
  private barrel: THREE.Group | null = null;
  /** Counterbalance cylinder (turret → upper arm). */
  private readonly ramBody: THREE.Mesh;
  private readonly ramRod: THREE.Mesh;
  private readonly ramA = new THREE.Vector3(0, 0.2, -0.13);
  private readonly ramB = new THREE.Vector3(0, 0.26, -0.06);
  private readonly mountInv = new THREE.Matrix4();
  private readonly mountMatrix = new THREE.Matrix4();
  private readonly _one = new THREE.Vector3(1, 1, 1);
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

    // ── Mount: pedestal on its elevator (floor) or mast trolley ──────
    if (mount === 'floor' && pedestal > 0) {
      // Column runs on below the floor so a rising elevator never shows its foot
      this.group.add(drum(0.18, -pedestal - 0.3, -0.03, mats.dark, 0.004, 40));
      this.group.add(drum(0.183, -pedestal + 0.05, -pedestal + 0.075, mats.accent, 0.002, 40));
      if (pedestal > 0.3) {
        this.group.add(block(0.11, pedestal * 0.45, 0.03, mats.paint, 0, -pedestal * 0.5, 0.168));
      }
      this.group.add(
        lathe([[0, -0.03], [0.2, -0.03], [0.205, -0.025], [0.205, -0.009], [0.2, -0.004], [0, -0.004]], mats.metal, 40),
      );
      this.group.add(...boltCircle(12, 0.19, [0, -0.004, 0], 'y', mats.metal, 0.008));
      this.group.add(cable([[0, 0.03, -0.165], [0, 0.025, -0.225], [0, -0.03, -0.25], [0, -0.2, -0.25]], 0.014, mats.rubber, 16));
    } else if (mount === 'ceiling') {
      this.group.add(drum(0.16, -0.13, -0.004, mats.dark, 0.006, 36));
      this.group.add(drum(0.163, -0.1, -0.086, mats.accent, 0.002, 36));
      this.group.add(...boltCircle(8, 0.145, [0, -0.13, 0], '-y', mats.metal, 0.007));
    }
    // Fixed J1 housing
    this.group.add(
      lathe([[0, 0], [0.17, 0], [0.175, 0.006], [0.175, 0.045], [0.165, 0.058], [0, 0.058]], mats.dark, 40),
    );

    // ── J1 turret: carousel, shoulder yoke, A2 motor ─────────────────
    const S = dims.shoulder;
    this.group.add(this.turret);
    this.turret.add(
      lathe([[0, 0.062], [0.155, 0.062], [0.16, 0.068], [0.16, 0.1], [0.13, 0.14], [0.115, 0.2], [0, 0.2]], mats.paint, 40),
    );
    this.turret.add(drum(0.163, 0.075, 0.087, mats.accent, 0.002, 40));
    const cheekPts: Array<[number, number]> = [
      [-0.12, 0.13],
      [0.12, 0.13],
    ];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      cheekPts.push([Math.cos(a) * 0.095, S + Math.sin(a) * 0.095]);
    }
    const cheek = hull(cheekPts);
    this.turret.add(slabX(cheek, 0.088, 0.118, mats.paint, 0.006));
    this.turret.add(slabX(cheek, -0.118, -0.088, mats.paint, 0.006));
    // A2 servo with cooling fins (+X), bearing cap (−X)
    const atS = (m: THREE.Mesh) => {
      m.position.y = S;
      return m;
    };
    this.turret.add(atS(hubX(0.07, 0.118, 0.19, mats.dark)));
    for (const x of [0.13, 0.145, 0.16, 0.175]) this.turret.add(atS(hubX(0.077, x, x + 0.005, mats.metal, 0.001)));
    this.turret.add(atS(hubX(0.05, 0.19, 0.204, mats.metal, 0.003)));
    this.turret.add(...boltCircle(6, 0.036, [0.204, S, 0], 'x', mats.metal, 0.006));
    this.turret.add(atS(hubX(0.062, -0.134, -0.118, mats.metal, 0.003)));
    this.turret.add(...boltCircle(6, 0.045, [-0.134, S, 0], '-x', mats.metal, 0.006));
    // J1 servo + ram clevis at the back
    const j1 = drum(0.04, 0.07, 0.2, mats.dark);
    j1.position.z = -0.19;
    this.turret.add(j1);
    const j1Cap = drum(0.043, 0.2, 0.214, mats.metal, 0.002);
    j1Cap.position.z = -0.19;
    this.turret.add(j1Cap);
    this.turret.add(block(0.05, 0.03, 0.05, mats.dark, 0, 0.2, -0.135));
    this.turret.add(block(0.03, 0.01, 0.006, mats.led, 0, 0.18, 0.124));
    const axes = decalPlane(mats, DECAL_RECTS.axes, 0.12);
    axes.rotation.y = Math.PI / 2;
    axes.position.set(0.1195, 0.24, 0);
    this.turret.add(axes);

    // ── J2 shoulder + upper link: twin side plates (the forearm folds
    // between them), axle, crossbars, covers ─────────────────────────
    const L = dims.upper;
    this.shoulderJ.position.y = S;
    this.turret.add(this.shoulderJ);
    const plate = capsuleOutline(0.085, 0, 0.068, L);
    this.shoulderJ.add(slabX(plate, 0.05, 0.074, mats.paint, 0.006));
    this.shoulderJ.add(slabX(plate, -0.074, -0.05, mats.paint, 0.006));
    this.shoulderJ.add(hubX(0.065, -0.049, 0.049, mats.dark));
    this.shoulderJ.add(hubX(0.03, -0.122, 0.122, mats.chrome, 0.002));
    const ramPin = hubX(0.02, -0.049, 0.049, mats.metal, 0.002);
    ramPin.position.set(0, 0.26, -0.06);
    this.shoulderJ.add(ramPin);
    const cross = hubX(0.03, -0.049, 0.049, mats.dark, 0.003);
    cross.position.set(0, L * 0.55, 0.03);
    this.shoulderJ.add(cross);
    const cover = capsuleOutline(0.05, 0.16, 0.042, L - 0.14);
    for (const side of [-1, 1]) {
      const x0 = side > 0 ? 0.074 : -0.08;
      this.shoulderJ.add(slabX(cover, x0, x0 + 0.006, mats.dark, 0.002));
      const maker = decalPlane(mats, DECAL_RECTS.maker, 0.2);
      maker.rotation.set(0, (side * Math.PI) / 2, Math.PI / 2);
      maker.position.set(side * 0.0815, L * 0.58, 0);
      this.shoulderJ.add(maker);
      const warn = decalPlane(mats, DECAL_RECTS.hazard, 0.16);
      warn.rotation.set(0, (side * Math.PI) / 2, Math.PI / 2);
      warn.position.set(side * 0.0815, L * 0.3, 0);
      this.shoulderJ.add(warn);
      this.shoulderJ.add(
        cable([[side * 0.09, 0.06, -0.075], [side * 0.09, L * 0.4, -0.078], [side * 0.09, L * 0.8, -0.062], [side * 0.088, L - 0.02, -0.03]], 0.011, mats.rubber, 20),
      );
    }

    // ── J3 elbow + forearm ───────────────────────────────────────────
    const F = dims.fore;
    this.elbowJ.position.y = L;
    this.shoulderJ.add(this.elbowJ);
    this.elbowJ.add(hubX(0.062, -0.044, 0.044, mats.paint));
    this.elbowJ.add(hubX(0.025, -0.082, 0.082, mats.chrome, 0.002));
    this.elbowJ.add(hubX(0.035, 0.0745, 0.08, mats.metal, 0.002));
    this.elbowJ.add(hubX(0.035, -0.08, -0.0745, mats.metal, 0.002));
    this.elbowJ.add(slabX(roundedRect(0.08, 0.12, 0.015, -0.085, -0.01), -0.04, 0.04, mats.dark, 0.005));
    const rating = decalPlane(mats, DECAL_RECTS.payload, 0.07);
    rating.rotation.y = Math.PI / 2;
    rating.position.set(0.0415, -0.01, -0.085);
    this.elbowJ.add(rating);
    this.elbowJ.add(
      lathe(
        [[0, 0.03], [0.05, 0.03], [0.054, 0.05], [0.05, 0.2], [0.042, F - 0.12], [0.046, F - 0.1], [0.046, F - 0.05], [0.04, F - 0.045], [0, F - 0.045]],
        mats.paint,
        32,
      ),
    );
    this.elbowJ.add(drum(0.049, F - 0.094, F - 0.084, mats.accent, 0.001));
    this.elbowJ.add(cable([[0.03, 0.06, -0.062], [0.05, F * 0.4, -0.048], [0.046, F * 0.75, -0.044], [0.03, F - 0.07, -0.045]], 0.009, mats.rubber, 20));

    // ── J4–J6 wrist ──────────────────────────────────────────────────
    this.wrist1.position.y = F;
    this.elbowJ.add(this.wrist1);
    this.wrist1.add(drum(0.044, -0.04, -0.012, mats.dark, 0.003));
    const wcheek = roundedRect(0.07, 0.06, 0.02, 0, -0.012);
    this.wrist1.add(slabX(wcheek, 0.048, 0.062, mats.dark, 0.003));
    this.wrist1.add(slabX(wcheek, -0.062, -0.048, mats.dark, 0.003));
    this.wrist1.add(this.wrist2);
    this.wrist2.add(hubX(0.04, -0.045, 0.045, mats.paint));
    this.wrist2.add(hubX(0.042, -0.006, 0.006, mats.accent, 0.001));
    this.wrist2.add(hubX(0.022, 0.062, 0.068, mats.metal, 0.002));
    this.wrist2.add(hubX(0.022, -0.068, -0.062, mats.metal, 0.002));
    this.wrist2.add(this.flange);
    this.flange.add(drum(0.036, 0.03, 0.075, mats.paint));
    this.flange.add(drum(0.046, 0.075, 0.085, mats.metal, 0.002));
    this.flange.add(...boltCircle(6, 0.038, [0, 0.085, 0], 'y', mats.metal, 0.005));
    // Tool changer
    this.flange.add(drum(0.044, 0.089, 0.1, mats.dark, 0.003));

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

  /**
   * Servo parallel gripper (jaws open along X): force/torque sensor, body
   * with valve block and air lines, guide rail, two-piece fingers with
   * ribbed rubber pads, camera/light pod and an integrated nut runner.
   */
  private buildGripper(mats: RobotMaterials): void {
    const f = this.flange;
    f.add(drum(0.04, 0.1, 0.118, mats.chrome, 0.002));
    f.add(drum(0.042, 0.106, 0.11, mats.accent, 0.001));
    f.add(slabY(roundedRect(0.13, 0.075, 0.012), 0.118, 0.19, mats.dark, 0.004));
    f.add(slabY(roundedRect(0.134, 0.079, 0.014), 0.165, 0.172, mats.accent, 0.001));
    // Guide rail + end stops
    f.add(block(0.23, 0.012, 0.026, mats.metal, 0, 0.1955, 0));
    f.add(block(0.008, 0.02, 0.03, mats.dark, 0.119, 0.199, 0));
    f.add(block(0.008, 0.02, 0.03, mats.dark, -0.119, 0.199, 0));
    // Valve block + air lines back to the wrist
    f.add(block(0.04, 0.035, 0.02, mats.metal, -0.04, 0.145, 0.0475));
    for (const x of [-0.05, -0.03]) {
      f.add(cable([[x, 0.15, 0.057], [x, 0.11, 0.07], [x * 0.8, 0.05, 0.062], [x * 0.6, -0.02, 0.05]], 0.0055, mats.rubber, 14));
    }
    // Camera / light pod
    f.add(block(0.04, 0.03, 0.03, mats.dark, 0.035, 0.155, -0.05));
    const lens = drum(0.009, 0, 0.012, mats.chrome, 0.001, 16);
    lens.rotation.x = -Math.PI / 2;
    lens.position.set(0.035, 0.155, -0.065);
    f.add(lens);
    f.add(block(0.03, 0.006, 0.004, mats.led, 0.035, 0.172, -0.0655));

    const jaw = (side: 1 | -1) => {
      const g = new THREE.Group();
      g.userData.dynamic = true;
      g.add(block(0.042, 0.022, 0.04, mats.dark, 0, 0.2128, 0));
      g.add(block(0.018, 0.044, 0.034, mats.accent, 0, 0.246, 0));
      g.add(slabX([[-0.017, 0.267], [0.017, 0.267], [0.012, 0.285], [-0.012, 0.285]], -0.009, 0.009, mats.accent, 0.002));
      // Pad on the inner face (toward the part)
      const ix = side * 0.011;
      g.add(block(0.004, 0.04, 0.03, mats.rubber, ix, 0.262, 0));
      for (const y of [0.25, 0.262, 0.274]) g.add(block(0.002, 0.004, 0.03, mats.rubber, side * 0.0138, y, 0));
      f.add(g);
      return g;
    };
    // A sits on −X (its pad faces +X), B on +X
    this.fingerA = jaw(1);
    this.fingerB = jaw(-1);

    // Nut runner: fixed housing + rotating spindle
    const housing = drum(0.02, 0.12, 0.17, mats.dark, 0.003, 20);
    housing.position.z = 0.055;
    f.add(housing);
    const spindle = new THREE.Group();
    spindle.userData.dynamic = true;
    spindle.position.set(0, 0.17, 0.055);
    spindle.add(drum(0.014, 0, 0.05, mats.chrome, 0.002, 16));
    const bit = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6), mats.dark);
    bit.position.y = 0.065;
    spindle.add(bit);
    f.add(spindle);
    this.spindle = spindle;
  }

  /** Pneumatic rivet gun: finned body, feed magazine, hose, recoiling barrel. */
  private buildRivetGun(mats: RobotMaterials): void {
    const f = this.flange;
    f.add(lathe([[0, 0.1], [0.038, 0.1], [0.042, 0.106], [0.042, 0.2], [0.034, 0.215], [0, 0.215]], mats.accent, 28));
    for (const y of [0.12, 0.135, 0.15, 0.165, 0.18]) f.add(drum(0.048, y, y + 0.005, mats.dark, 0.001, 28));
    f.add(lathe([[0, 0.212], [0.03, 0.212], [0.018, 0.235], [0, 0.235]], mats.metal, 24));
    f.add(block(0.026, 0.09, 0.05, mats.dark, 0.058, 0.16, 0));
    for (let i = 0; i < 6; i++) {
      const r = drum(0.005, 0, 0.004, mats.chrome, 0.001, 10);
      r.rotation.z = -Math.PI / 2;
      r.position.set(0.071, 0.125 + i * 0.013, 0.012);
      f.add(r);
    }
    f.add(cable([[0.058, 0.205, 0], [0.045, 0.225, 0], [0.02, 0.232, 0]], 0.005, mats.rubber, 10));
    f.add(cable([[0, 0.13, -0.042], [0, 0.08, -0.07], [0, 0.0, -0.06], [0, -0.05, -0.05]], 0.009, mats.rubber, 16));
    const barrel = new THREE.Group();
    barrel.userData.dynamic = true;
    barrel.add(drum(0.013, 0.225, 0.265, mats.chrome, 0.002, 16));
    barrel.add(lathe([[0, 0.265], [0.013, 0.265], [0.008, 0.278], [0, 0.278]], mats.chrome, 16));
    f.add(barrel);
    this.barrel = barrel;
  }

  /** Carry a prop in the gripper (set dressing). */
  hold(obj: THREE.Object3D): void {
    obj.position.y = this.dims.wristToTcp - 0.02;
    this.flange.add(obj);
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
    this.solveWorld(tcp, toolQuat, this.joints, this.joints);
    this.applyJoints();
    return this.joints.error;
  }

  /**
   * IK for a world tool pose at the deployed mount, continuous with `ref`
   * (defaults to the current joints). Does not move the arm.
   */
  solveWorld(
    tcp: THREE.Vector3,
    toolQuat: THREE.Quaternion,
    out: ArmJoints = { yaw: 0, shoulder: 0, elbow: 0, wristRoll: 0, wristPitch: 0, flangeRoll: 0, error: 0 },
    ref: Readonly<ArmJoints> = this.joints,
  ): ArmJoints {
    const r = { ...ref };
    this.mountMatrix.compose(this.base, this.group.quaternion, this._one);
    this.mountInv.copy(this.mountMatrix).invert();
    this._p.copy(tcp).applyMatrix4(this.mountInv);
    this._q.copy(this.group.quaternion).invert().multiply(toolQuat);
    // Mast arms keep their elbows up toward the ceiling, clear of the suit
    solveArmIK(this._p, this._q, this.dims, out, this.mount === 'ceiling' ? -1 : 1);
    return continueFrom(out, r);
  }

  /** Drive the arm to a joint configuration. */
  setJoints(j: Readonly<ArmJoints>): void {
    Object.assign(this.joints, j);
    this.applyJoints();
  }

  private foldedTopCache: number | null = null;

  /**
   * Height of the folded transport pose's highest point above the mount
   * (m, measured off the geometry once): how far a floor arm has to drop
   * to get its whole fold under the ring aperture.
   */
  foldedTop(): number {
    if (this.foldedTopCache !== null) return this.foldedTopCache;
    const saved = { ...this.joints };
    const pos = this.group.position.clone();
    Object.assign(this.joints, this.mount === 'ceiling' ? FOLDED_CEILING : FOLDED);
    this.applyJoints();
    this.group.position.set(0, 0, 0);
    this.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.group, true);
    this.foldedTopCache = this.mount === 'ceiling' ? -box.min.y : box.max.y;
    this.group.position.copy(pos);
    this.setJoints(saved);
    this.group.updateMatrixWorld(true);
    return this.foldedTopCache;
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
