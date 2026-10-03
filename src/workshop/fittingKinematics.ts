import * as THREE from 'three';
import type { PieceFrame } from '../animation/suitUpChoreography';
import { armorPieceDef, type ArmorPieceId, type PieceRotation } from '../suit/armorPieces';
import { boneSpec, type BoneName } from '../suit/rig';
import type { SuitRig } from '../suit/rigPose';
import { cradleFor, LIFT_DEPTH, type FitTask } from './fittingProgram';
import { toolQuaternion } from './robotArm';

/** Height of the lift arc over a carry (m) — parts clear the cradle lip. */
const CARRY_ARC = 0.1;

/**
 * Where every suit part is, given the posed rig and its fitting channels.
 *
 * All piece frames are rigid "bind → model" transforms: applied to a bind-
 * space vertex they give its model-space position. Docked, a frame equals
 * the anchor bone's skinning transform (Bm · Bm_bind⁻¹), so the piece mesh
 * matrix L = frame · dock⁻¹ is the identity and the part sits exactly where
 * the seamless suit would.
 */
export class FitKinematics {
  private readonly modelInv: THREE.Matrix4;
  private readonly _a = new THREE.Matrix4();
  private readonly _b = new THREE.Matrix4();
  private readonly _c = new THREE.Matrix4();
  private readonly _r = new THREE.Matrix4();
  private readonly _pa = new THREE.Vector3();
  private readonly _pb = new THREE.Vector3();
  private readonly _qa = new THREE.Quaternion();
  private readonly _qb = new THREE.Quaternion();
  private readonly _s = new THREE.Vector3();
  private readonly _o = new THREE.Vector3();
  private readonly _axis = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();

  constructor(
    private readonly rig: SuitRig,
    /** Suit model group world matrix (constant after bind). */
    readonly modelWorld: THREE.Matrix4,
  ) {
    this.modelInv = modelWorld.clone().invert();
  }

  /** Anchor bone skinning transform (bind → model) at the current pose. */
  dock(bone: BoneName, out: THREE.Matrix4): THREE.Matrix4 {
    const head = boneSpec(bone).head;
    out.multiplyMatrices(this.modelInv, this.rig.bones[bone].matrixWorld);
    return out.multiply(this._r.makeTranslation(-head[0], -head[1], -head[2]));
  }

  /** Part resting on its cradle: origin at the cradle point, upright in world. */
  cradle(task: FitTask, out: THREE.Matrix4): THREE.Matrix4 {
    const c = cradleFor(task);
    const o = task.origin;
    // World translation, expressed in the (slightly leaned) model frame
    out.makeTranslation(c[0], c[1], c[2]).premultiply(this.modelInv);
    this._v.setFromMatrixPosition(out);
    this._qa.setFromRotationMatrix(out);
    out.compose(this._v, this._qa, this._s.set(1, 1, 1));
    return out.multiply(this._r.makeTranslation(-o[0], -o[1], -o[2]));
  }

  /** out ← out · (T(p) R(axis, angle·k) T(−p)) about a bind-space pivot. */
  private rotateAbout(out: THREE.Matrix4, rot: PieceRotation, k: number, pivot: readonly number[]): void {
    if (Math.abs(k) < 1e-6) return;
    const p = rot.pivot ?? pivot;
    this._axis.set(rot.axis[0], rot.axis[1], rot.axis[2]).normalize();
    out
      .multiply(this._r.makeTranslation(p[0], p[1], p[2]))
      .multiply(this._c.makeRotationAxis(this._axis, rot.angle * k))
      .multiply(this._r.makeTranslation(-p[0], -p[1], -p[2]));
  }

  /** Staging / insertion frame: dock offset by the insert stroke (+ twist). */
  private seated(id: ArmorPieceId, n: number, twist: number, out: THREE.Matrix4): THREE.Matrix4 {
    const def = armorPieceDef(id);
    this.dock(def.anchor, out);
    const v = def.insert.v;
    if (def.insert.space === 'model') {
      out.premultiply(this._r.makeTranslation(v[0] * n, v[1] * n, v[2] * n));
    } else {
      out.multiply(this._r.makeTranslation(v[0] * n, v[1] * n, v[2] * n));
    }
    if (def.twist) this.rotateAbout(out, def.twist, twist, boneSpec(def.anchor).head);
    return out;
  }

  /** Blend two rigid frames about a bind-space origin, with a carry arc. */
  private blend(
    from: THREE.Matrix4,
    to: THREE.Matrix4,
    u: number,
    origin: readonly number[],
    out: THREE.Matrix4,
  ): THREE.Matrix4 {
    if (u <= 0) return out.copy(from);
    if (u >= 1) return out.copy(to);
    this._o.set(origin[0], origin[1], origin[2]);
    this._pa.copy(this._o).applyMatrix4(from);
    this._pb.copy(this._o).applyMatrix4(to);
    this._qa.setFromRotationMatrix(from);
    this._qb.setFromRotationMatrix(to);
    this._pa.lerp(this._pb, u);
    this._pa.y += CARRY_ARC * 4 * u * (1 - u);
    this._qa.slerp(this._qb, u);
    out.compose(this._pa, this._qa, this._s.set(1, 1, 1));
    return out.multiply(this._r.makeTranslation(-origin[0], -origin[1], -origin[2]));
  }

  /**
   * The frame the robot holds for a task (bind → model). For clamshells this
   * is the fixture frame (halves open around it); otherwise the lead part.
   */
  taskFrame(task: FitTask, lead: PieceFrame, out: THREE.Matrix4): THREE.Matrix4 {
    const id = task.pieces[0];
    const def = armorPieceDef(id);
    if (task.kind === 'lift') {
      this.seated(id, lead.insert, 0, out);
      return out.premultiply(this._r.makeTranslation(0, -LIFT_DEPTH * (1 - lead.carry), 0));
    }
    if (task.kind === 'pair') this.dock(def.anchor, this._b);
    else this.seated(id, lead.insert, lead.twist, this._b);
    this.cradle(task, this._a);
    return this.blend(this._a, this._b, lead.carry, task.origin, out);
  }

  /** A piece's frame inside its task frame. */
  pieceFrame(task: FitTask, taskFrame: THREE.Matrix4, pf: PieceFrame, out: THREE.Matrix4): THREE.Matrix4 {
    out.copy(taskFrame);
    const def = armorPieceDef(pf.id);
    if (task.kind === 'pair') {
      const v = def.insert.v;
      out.multiply(this._r.makeTranslation(v[0] * pf.insert, v[1] * pf.insert, v[2] * pf.insert));
    } else if (def.hinge) {
      this.rotateAbout(out, def.hinge, pf.hinge, boneSpec(def.anchor).head);
    }
    return out;
  }

  /** Mesh matrix that moves a skinned piece from its socket to `frame`. */
  meshMatrix(id: ArmorPieceId, frame: THREE.Matrix4, out: THREE.Matrix4): THREE.Matrix4 {
    this.dock(armorPieceDef(id).anchor, this._c);
    return out.copy(frame).multiply(this._c.invert());
  }

  /** World tool pose for a task frame (rigid grasp in the part's frame). */
  toolPose(
    task: FitTask,
    frame: THREE.Matrix4,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): void {
    const { dir, standoff, up } = task.grip;
    const o = task.origin;
    const d = this._v.set(dir[0], dir[1], dir[2]).normalize();
    this._pa.set(o[0] + d.x * standoff, o[1] + d.y * standoff, o[2] + d.z * standoff);
    toolQuaternion(this._pb.copy(d).negate(), this._o.set(up[0], up[1], up[2]), this._qb);
    this._a.compose(this._pa, this._qb, this._s.set(1, 1, 1));
    this._a.premultiply(frame).premultiply(this.modelWorld);
    this._a.decompose(outPos, outQuat, this._s);
  }
}

