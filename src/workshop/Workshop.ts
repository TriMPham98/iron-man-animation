import * as THREE from 'three';
import {
  evaluatePose,
  evaluateSuitUp,
  type FitTiming,
  type PieceFrame,
  type SuitUpFrame,
  type SuitUpPlan,
  type ToolTiming,
} from '../animation/suitUpChoreography';
import type { Suit } from '../suit/Suit';
import type { ArmorPieceId } from '../suit/armorPieces';
import { ease } from '../animation/keyframes';
import { BONE_SPECS } from '../suit/rig';
import {
  cradleFor,
  armDims,
  FIT_TASKS,
  fitTask,
  ROBOTS,
  ROBOT_RING_RADIUS,
  taskForPiece,
  toolJob,
  type FitTask,
  type RobotId,
  type ToolJob,
} from './fittingProgram';
import { mergeStaticTree } from './mergeStatic';
import { SuitScanView } from './suitScanView';
import { createWorkshopDetail, type WorkshopDetail } from './workshopDetail';
import { CRADLE_PORT_RADIUS, CradleStands, floorCradlePorts } from './cradleStands';
import { createRobotMaterials, RobotArm, toolQuaternion, type ArmJoints } from './robotArm';

const JOINT_KEYS = ['yaw', 'shoulder', 'elbow', 'wristRoll', 'wristPitch', 'flangeRoll'] as const;
import {
  createWorkshopEnvironment,
  ROOM_HEIGHT,
  RING_HALF_WIDTH,
  type WorkshopEnvironment,
} from './workshopEnvironment';

interface ToolPose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

interface ToolPass {
  timing: ToolTiming;
  spec: ToolJob;
  /** Sites snapped onto the part surface (bind space). */
  sites: THREE.Vector3[];
  /** Outward surface normal at each site (bind). */
  normals: THREE.Vector3[];
}

type Segment =
  | { t0: number; t1: number; kind: 'hold'; pose: ToolPose }
  | {
      t0: number;
      t1: number;
      kind: 'move';
      from: ToolPose;
      to: ToolPose;
      arc: number;
      /**
       * Transits (arc > 0) run in joint space between these continuous IK
       * solutions — every joint moves smoothly from start to end, so the
       * path is always reachable with no wrist flips. Straight approaches
       * (arc 0) stay Cartesian.
       */
      jFrom?: ArmJoints;
      jTo?: ArmJoints;
    }
  | { t0: number; t1: number; kind: 'attached'; task: FitTask }
  | { t0: number; t1: number; kind: 'tool'; pass: ToolPass };

/** Hover height above a cradle before the straight descent (m). */
const PRE_GRASP = 0.12;
/** Back-off distance after release (m). */
const RETREAT = 0.15;
/** Idle longer than this between jobs → fold back home. */
const GO_HOME_GAP = 0.75;
/** Rivet gun hover over a site (m). */
const RIVET_HOVER = 0.06;
/** Elevator travel so a folded arm clears the floor / ceiling. */
const FLOOR_STOW_EXTRA = 1.35;
const CEILING_STOW_EXTRA = 1.3;

/**
 * The robot cell: environment, thirteen arms and their parts cradles.
 *
 * Each arm runs a baked program of hold / move / attached / tool segments.
 * Grippers ride the part they carry; riveters ride the seated
 * part's frame while they work its seams. After its last job an arm folds
 * and drops into its floor well (or climbs its mast into the ceiling) so
 * the finished suit stands alone, as in the film. Parts stands sink
 * through flush floor ports (hangers into the ceiling) once emptied. Everything is a function
 * of the seed-clock time, so scrubbing is exact.
 */
export class Workshop {
  readonly group = new THREE.Group();
  private readonly env: WorkshopEnvironment;
  /** Live suit diagnostic feed shown on the workshop monitors. */
  private readonly scanView: SuitScanView;
  private readonly detail: WorkshopDetail;
  private readonly arms = new Map<RobotId, RobotArm>();
  private readonly programs = new Map<RobotId, Segment[]>();
  private readonly homes = new Map<RobotId, ToolPose>();
  private readonly passes = new Map<string, ToolPass>();
  private readonly masts = new Map<RobotId, THREE.Mesh>();
  private stands!: CradleStands;
  private readonly standRetract = new Map<string, number>();
  private readonly mats = createRobotMaterials();
  private readonly liftTasks: FitTask[];
  private lastT = Number.NaN;
  private readonly _m = new THREE.Matrix4();
  private readonly _m2 = new THREE.Matrix4();
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();
  private readonly _n2 = new THREE.Vector3();
  private readonly _j: ArmJoints = { yaw: 0, shoulder: 0, elbow: 0, wristRoll: 0, wristPitch: 0, flangeRoll: 0, error: 0 };
  /** Worst IK miss on the last applied frame (m) — diagnostics/tests. */
  maxReachError = 0;

  constructor(
    private readonly suit: Suit,
    private readonly plan: SuitUpPlan,
  ) {
    this.group.name = 'workshop';
    this.liftTasks = FIT_TASKS.filter((t) => t.kind === 'lift');
    this.scanView = new SuitScanView(suit.finalGeometry);
    this.env = createWorkshopEnvironment(
      this.liftTasks.map((t) => {
        const w = this.toWorld(t.origin[0], 0, t.origin[2]);
        return [w.x, w.z] as [number, number];
      }),
      ROBOTS.filter((r) => r.mount === 'floor').map((r) => ({ id: r.id, x: r.base[0], z: r.base[2] })),
      this.scanView.target.texture,
    );
    this.group.add(this.env.group);
    this.detail = createWorkshopDetail(suit.finalGeometry, this.mats);
    mergeStaticTree(this.detail.group);
    this.group.add(this.detail.group);

    for (const st of ROBOTS) {
      const arm = new RobotArm(st.id, st.base, st.mount, st.pedestal, this.mats, st.tool, armDims(st));
      this.arms.set(st.id, arm);
      this.group.add(arm.group);
      if (st.mount === 'ceiling') {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1, 20), this.mats.metal);
        this.masts.set(st.id, mast);
        this.group.add(mast);
        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.5, 24), this.mats.dark);
        sleeve.position.set(st.base[0], ROOM_HEIGHT - 0.25, st.base[2]);
        this.group.add(sleeve);
      }
    }

    // Rivet sites snap onto the part surfaces (the gun rides them)
    this.prepareToolPasses();

    this.group.updateMatrixWorld(true);
    this.buildCradles();
    // Static props: one draw per material
    mergeStaticTree(this.env.group);
    this.bake();
    this.applyHome();
  }

  /** Moving hardware that grounds itself with a contact shadow: arms, masts, parts stands. */
  shadowCasters(): THREE.Object3D[] {
    return [...[...this.arms.values()].map((a) => a.group), ...this.masts.values(), this.stands.group];
  }

  private toWorld(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.suit.kin.modelWorld);
  }

  private buildCradles(): void {
    const bounds = (task: FitTask) => {
      const c = cradleFor(task);
      let minY = Infinity;
      let maxY = -Infinity;
      for (const id of task.pieces) {
        const box = this.suit.pieceBounds(id);
        if (!box) continue;
        minY = Math.min(minY, box.min.y);
        maxY = Math.max(maxY, box.max.y);
      }
      return { bottom: c[1] - (task.origin[1] - minY), top: c[1] + (maxY - task.origin[1]) };
    };
    // A stand starts down once its part is lifted clear
    for (const track of this.plan.robots) {
      for (const job of track.jobs) this.standRetract.set(job.task, job.lift + 0.35);
    }
    const holes: Array<[number, number, number]> = [
      ...floorCradlePorts().map(([x, z]) => [x, z, CRADLE_PORT_RADIUS] as [number, number, number]),
    ];
    const rings: Array<[number, number]> = [[ROBOT_RING_RADIUS - RING_HALF_WIDTH, ROBOT_RING_RADIUS + RING_HALF_WIDTH]];
    this.stands = new CradleStands(this.mats, bounds, ROOM_HEIGHT, holes, rings);
    mergeStaticTree(this.stands.group);
    this.group.add(this.stands.group);
  }

  /**
   * Place every rivet site. With a seam partner, each hint snaps to the
   * nearest point of the joint line where the two parts meet (vertices of
   * this part within a few mm of the partner's), using that point's own
   * normal — so the gun works the actual join. Otherwise the hint is
   * projected onto the part along the job normal.
   */
  private prepareToolPasses(): void {
    const ray = new THREE.Raycaster();
    const probeMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    for (const timing of this.plan.tools) {
      const spec = toolJob(timing.job);
      const geoOf = (id: ArmorPieceId | undefined) =>
        id ? ((this.suit.pieces.find((p) => p.id === id)?.mesh as THREE.Mesh | undefined)?.geometry ?? null) : null;
      const geo = geoOf(spec.piece);
      const n = new THREE.Vector3(...spec.normal).normalize();
      const seam = geo ? seamPoints(geo, geoOf(spec.seamWith)) : [];
      const used: THREE.Vector3[] = [];
      const sites: THREE.Vector3[] = [];
      const normals: THREE.Vector3[] = [];
      for (const p of spec.points) {
        const hint = new THREE.Vector3(...p);
        // Nearest seam point to the hint, kept ≥ 4 cm from the others
        let best: { p: THREE.Vector3; n: THREE.Vector3 } | null = null;
        let bestD = Infinity;
        for (const sp of seam) {
          if (used.some((u) => u.distanceTo(sp.p) < 0.04)) continue;
          const d = sp.p.distanceToSquared(hint);
          if (d < bestD) {
            bestD = d;
            best = sp;
          }
        }
        if (best && bestD < 0.12 * 0.12) {
          used.push(best.p);
          sites.push(best.p.clone().addScaledVector(best.n, 0.002));
          normals.push(best.n.clone());
          continue;
        }
        const probe = geo ? new THREE.Mesh(geo, probeMat) : null;
        ray.set(hint.clone().addScaledVector(n, 0.3), n.clone().negate());
        ray.far = 0.6;
        const hit = probe ? ray.intersectObject(probe, false)[0] : undefined;
        sites.push(hit ? hit.point.clone() : hint);
        normals.push(n.clone());
      }
      this.passes.set(timing.job, { timing, spec, sites, normals });
    }
    probeMat.dispose();
  }

  /** Home: floor arms fold upright; mast arms tuck up and swing aside. */
  private homePose(arm: RobotArm): ToolPose {
    const m = arm.group.matrixWorld;
    const ceiling = arm.mount === 'ceiling';
    const pos = (ceiling ? new THREE.Vector3(0, 0.36, 0.04) : new THREE.Vector3(0, 0.82, 0.3)).applyMatrix4(m);
    const local = ceiling
      ? toolQuaternion(new THREE.Vector3(0, 1, 0.5), new THREE.Vector3(0, 0, 1))
      : toolQuaternion(new THREE.Vector3(0, -0.7, 1), new THREE.Vector3(0, 1, 0));
    const quat = arm.group.getWorldQuaternion(new THREE.Quaternion()).multiply(local);
    return { pos, quat };
  }

  // ── Part frames ───────────────────────────────────────────────────

  private leadAt(task: FitTask, t: number): PieceFrame {
    return evaluateSuitUp(this.plan, t).pieces.find((p) => p.id === task.pieces[0])!;
  }

  /** Tool pose for a carry job at time t, with the rig posed for that time. */
  private attachedPoseAt(task: FitTask, t: number): ToolPose {
    this.suit.setPose(evaluatePose(this.plan, t));
    const frame = this.suit.kin.taskFrame(task, this.leadAt(task, t), this._m);
    const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.suit.kin.toolPose(task, frame, pose.pos, pose.quat);
    return pose;
  }

  /** A part's frame (bind → model) from piece channels (rig already posed). */
  private partFrame(
    id: ArmorPieceId,
    pieces: readonly PieceFrame[],
    out: THREE.Matrix4,
    seated = !this.suit.isAssemblyMode(),
  ): THREE.Matrix4 {
    if (seated) return this.suit.kin.dock(this.suit.pieces.find((p) => p.id === id)!.anchor, out);
    const task = taskForPiece(id);
    const lead = pieces.find((p) => p.id === task.pieces[0])!;
    const pf = pieces.find((p) => p.id === id)!;
    this.suit.kin.taskFrame(task, lead, this._m2);
    return this.suit.kin.pieceFrame(task, this._m2, pf, out);
  }

  /** World point + outward normal of a bind-space site on a framed part. */
  private siteWorld(
    frame: THREE.Matrix4,
    site: THREE.Vector3,
    normal: readonly number[],
    outP: THREE.Vector3,
    outN: THREE.Vector3,
  ): void {
    outP.copy(site).applyMatrix4(frame).applyMatrix4(this.suit.kin.modelWorld);
    this._m2.multiplyMatrices(this.suit.kin.modelWorld, frame);
    outN.set(normal[0], normal[1], normal[2]).transformDirection(this._m2);
  }

  /** Rivet gun pose at time t given the part frame: hover, strike, recoil. */
  private passPose(
    pass: ToolPass,
    frame: THREE.Matrix4,
    t: number,
    out: ToolPose,
  ): { recoil: number } {
    const { timing, sites } = pass;
    const s = timing.strikes;
    let recoil = 0;
    let standoff = RIVET_HOVER;
    let k = 0;
    while (k < s.length - 1 && t > s[k] + 0.08) k++;
    if (t >= s[k] - 0.06 && t < s[k]) {
      standoff = RIVET_HOVER * (1 - ease('in2', (t - (s[k] - 0.06)) / 0.06));
    } else if (t >= s[k] && t < s[k] + 0.08) {
      standoff = RIVET_HOVER * ease('out2', (t - s[k]) / 0.08);
      recoil = 1 - (t - s[k]) / 0.08;
    }
    let a = k;
    let mix = 0;
    // Slide hover k−1 → k between strikes
    if (k > 0 && t < s[k] - 0.06 && t > s[k - 1] + 0.08) {
      a = k - 1;
      mix = ease('inOut2', (t - (s[k - 1] + 0.08)) / Math.max(1e-3, s[k] - 0.06 - (s[k - 1] + 0.08)));
    }
    this._v.copy(sites[a]).lerp(sites[k], mix);
    // Normal blends between neighbouring sites as the gun slides along
    this._n2.copy(pass.normals[a]).lerp(pass.normals[k], mix).normalize();
    this.siteWorld(frame, this._v, [this._n2.x, this._n2.y, this._n2.z], out.pos, this._n);
    out.pos.addScaledVector(this._n, standoff);
    // The gun keeps its feed magazine up
    toolQuaternion(this._n.clone().negate(), new THREE.Vector3(0, 1, 0), out.quat);
    return { recoil };
  }

  private passPoseAt(pass: ToolPass, t: number): ToolPose {
    this.suit.setPose(evaluatePose(this.plan, t));
    const pieces = evaluateSuitUp(this.plan, t).pieces;
    const frame = this.partFrame(pass.spec.piece, pieces, new THREE.Matrix4(), false);
    const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.passPose(pass, frame, t, pose);
    return pose;
  }

  /** Same pose backed off along the tool's approach axis. */
  private backOff(p: ToolPose, dist: number): ToolPose {
    const a = new THREE.Vector3(0, 1, 0).applyQuaternion(p.quat);
    return { pos: p.pos.clone().addScaledVector(a, -dist), quat: p.quat.clone() };
  }

  // ── Programs ──────────────────────────────────────────────────────

  private bake(): void {
    const start = this.plan.preRoll - 1;
    for (const st of ROBOTS) {
      const arm = this.arms.get(st.id)!;
      const home = this.homePose(arm);
      this.homes.set(st.id, home);
      const track = this.plan.robots.find((r) => r.id === st.id);
      type Item =
        | { kind: 'carry'; job: FitTiming; depart: number }
        | { kind: 'tool'; pass: ToolPass; depart: number };
      const items: Item[] = [
        ...(track?.jobs ?? []).map((job) => ({ kind: 'carry' as const, job, depart: job.depart })),
        ...(track?.tools ?? []).map((t) => ({
          kind: 'tool' as const,
          pass: this.passes.get(t.job)!,
          depart: t.depart,
        })),
      ].sort((a, b) => a.depart - b.depart);

      const segs: Segment[] = [];
      let cur = home;
      let t = start;
      items.forEach((item, k) => {
        const next = items[k + 1];
        if (item.depart > t) segs.push({ t0: t, t1: item.depart, kind: 'hold', pose: cur });
        let done: ToolPose;
        let doneAt: number;
        let clearAt: number;
        if (item.kind === 'carry') {
          const job = item.job;
          const task = fitTask(job.task);
          const grasp = this.attachedPoseAt(task, job.grasp);
          const hover = this.backOff(grasp, PRE_GRASP);
          segs.push({ t0: item.depart, t1: job.preGrasp, kind: 'move', from: cur, to: hover, arc: 0.12 });
          segs.push({ t0: job.preGrasp, t1: job.grasp, kind: 'move', from: hover, to: grasp, arc: 0 });
          segs.push({ t0: job.grasp, t1: job.retreat, kind: 'attached', task });
          done = this.attachedPoseAt(task, job.retreat);
          doneAt = job.retreat;
          clearAt = job.clear;
        } else {
          const { pass } = item;
          const tm = pass.timing;
          const entry = this.passPoseAt(pass, tm.arrive);
          segs.push({ t0: Math.max(item.depart, t), t1: tm.arrive, kind: 'move', from: cur, to: entry, arc: 0.06 });
          segs.push({ t0: tm.arrive, t1: tm.end, kind: 'tool', pass });
          done = this.passPoseAt(pass, tm.end);
          doneAt = tm.end;
          clearAt = tm.clear;
        }
        // Back-to-back passes hop straight across; otherwise back off
        if (next && next.depart < clearAt) {
          cur = done;
          t = doneAt;
          return;
        }
        // Mast arms lift well clear before the next move or their stow
        const backed = this.backOff(done, st.mount === 'ceiling' ? RETREAT * 2.4 : RETREAT);
        segs.push({ t0: doneAt, t1: clearAt, kind: 'move', from: done, to: backed, arc: 0 });
        cur = backed;
        t = clearAt;
        // Mast arms stow straight from the back-off (no trip home)
        if (!next && st.mount === 'ceiling') return;
        if (!next || next.depart - clearAt > GO_HOME_GAP) {
          segs.push({ t0: t, t1: t + 0.65, kind: 'move', from: cur, to: home, arc: 0.1 });
          cur = home;
          t += 0.65;
        }
      });
      segs.push({ t0: t, t1: Infinity, kind: 'hold', pose: cur });
      // Chain IK through every boundary so neighbouring segments share one
      // continuous joint branch; transits get their joint-space endpoints
      let ref = arm.solveWorld(home.pos, home.quat);
      for (const seg of segs) {
        if (seg.kind === 'hold') ref = arm.solveWorld(seg.pose.pos, seg.pose.quat, undefined, ref);
        else if (seg.kind === 'move') {
          const jFrom = arm.solveWorld(seg.from.pos, seg.from.quat, undefined, ref);
          const jTo = arm.solveWorld(seg.to.pos, seg.to.quat, undefined, jFrom);
          if (seg.arc > 0) {
            seg.jFrom = jFrom;
            seg.jTo = jTo;
          }
          ref = jTo;
        }
      }
      this.programs.set(st.id, segs);
    }
  }

  private segmentAt(id: RobotId, t: number): Segment {
    const segs = this.programs.get(id)!;
    if (t < segs[0].t0) return segs[0];
    for (const s of segs) if (t < s.t1) return s;
    return segs[segs.length - 1];
  }

  // ── Per-frame ─────────────────────────────────────────────────────

  /** Drive every arm, lift, mast, well and tool effect (rig already posed). */
  apply(frame: SuitUpFrame): void {
    const t = frame.t;
    const live = Number.isFinite(this.lastT) && t > this.lastT && t - this.lastT < 0.25;
    const tool = { pos: this._p, quat: this._q };
    let worst = 0;

    for (const r of frame.robots) {
      const arm = this.arms.get(r.id)!;
      const seg = this.segmentAt(r.id, t);
      let recoil = 0;
      if (r.stow > 0) {
        // Stow from wherever the program parked the tool
        const park = this.parkPose(r.id);
        tool.pos.copy(park.pos);
        tool.quat.copy(park.quat);
      } else if (seg.kind === 'hold') {
        tool.pos.copy(seg.pose.pos);
        tool.quat.copy(seg.pose.quat);
      } else if (seg.kind === 'move' && seg.jFrom && seg.jTo && r.stow <= 0) {
        // Joint-space transit
        const u = ease('inOut2', (t - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0));
        const j = this._j;
        for (const k of JOINT_KEYS) j[k] = THREE.MathUtils.lerp(seg.jFrom[k], seg.jTo[k], u);
        j.error = 0;
        arm.group.position.copy(arm.base);
        arm.setJoints(j);
        arm.setStow(r.stow, this.stowDepth(arm));
        arm.setGripper(this.jawFor(seg, frame, r.gripper));
        arm.setSpindle(r.spindle);
        arm.setRecoil(0);
        this.updateMast(r.id, arm);
        this.env.setWell(r.id, r.stow);
        continue;
      } else if (seg.kind === 'move') {
        const u = ease('inOut2', (t - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0));
        tool.pos.lerpVectors(seg.from.pos, seg.to.pos, u);
        tool.pos.y += seg.arc * 4 * u * (1 - u);
        tool.quat.slerpQuaternions(seg.from.quat, seg.to.quat, u);
      } else if (seg.kind === 'attached') {
        const lead = frame.pieces.find((p) => p.id === seg.task.pieces[0])!;
        const tf = this.suit.kin.taskFrame(seg.task, lead, this._m);
        this.suit.kin.toolPose(seg.task, tf, tool.pos, tool.quat);
      } else {
        const pf = this.partFrame(seg.pass.spec.piece, frame.pieces, new THREE.Matrix4());
        recoil = this.passPose(seg.pass, pf, t, tool).recoil;
      }

      // Solve at the deployed mount, then fold + ride the elevator / mast
      arm.group.position.copy(arm.base);
      arm.group.updateMatrixWorld(true);
      const err = arm.reachWorld(tool.pos, tool.quat);
      if (r.stow <= 0) worst = Math.max(worst, err);
      arm.setStow(r.stow, this.stowDepth(arm));
      arm.setGripper(this.jawFor(seg, frame, r.gripper));
      arm.setSpindle(r.spindle);
      arm.setRecoil(recoil);

      // Rivet strike sparks (live playback only)
      if (seg.kind === 'tool' && live) {
        for (const s of seg.pass.timing.strikes) {
          if (s > this.lastT && s <= t) this.suit.emitWorld('sparks', tool.pos, 12);
        }
      }
      this.updateMast(r.id, arm);
      this.env.setWell(r.id, r.stow);
    }
    this.maxReachError = worst;
    this.lastT = t;

    // Boot lifts
    this.liftTasks.forEach((task, i) => {
      const lead = frame.pieces.find((p) => p.id === task.pieces[0]);
      const plate = this.env.liftPlates[i];
      if (!lead || !plate) return;
      const tf = this.suit.kin.taskFrame(task, lead, this._m);
      this._v.set(task.origin[0], 0, task.origin[2]).applyMatrix4(tf).applyMatrix4(this.suit.kin.modelWorld);
      plate.position.y = Math.min(this._v.y, 0.05);
    });

    this.stands.apply((task) => this.standRetract.get(task.id) ?? Infinity, t);
  }

  /** Final parked pose of an arm's program (where it starts stowing). */
  private parkPose(id: RobotId): ToolPose {
    const segs = this.programs.get(id)!;
    const last = segs[segs.length - 1];
    return last.kind === 'hold' ? last.pose : this.homes.get(id)!;
  }

  private stowDepth(arm: RobotArm): number {
    return arm.mount === 'floor'
      ? arm.pedestal + FLOOR_STOW_EXTRA
      : ROOM_HEIGHT - arm.base.y + CEILING_STOW_EXTRA;
  }

  private updateMast(id: RobotId, arm: RobotArm): void {
    const mast = this.masts.get(id);
    if (!mast) return;
    const top = arm.group.position.y + 0.12;
    const len = ROOM_HEIGHT - top;
    mast.visible = len > 0.01;
    mast.scale.set(1, Math.max(0.01, len), 1);
    mast.position.set(arm.base.x, top + len / 2, arm.base.z);
  }

  /** Jaw opening: clamshell fixtures follow the held pair's closing stroke. */
  private jawFor(seg: Segment, frame: SuitUpFrame, track: number): number {
    if (seg.kind !== 'attached' || seg.task.kind !== 'pair') return track;
    const lead = frame.pieces.find((p) => p.id === seg.task.pieces[0]);
    return lead ? Math.max(track, THREE.MathUtils.clamp(lead.insert * 1.15, 0, 1)) : track;
  }

  /**
   * Reset handoff: 0 = every arm stowed (end of a cycle), 1 = deployed at
   * home ready for the next one.
   */
  setRedeployProgress(u: number): void {
    const stow = 1 - THREE.MathUtils.clamp(u, 0, 1);
    for (const st of ROBOTS) {
      const arm = this.arms.get(st.id)!;
      const h = this.homes.get(st.id)!;
      arm.group.position.copy(arm.base);
      arm.group.updateMatrixWorld(true);
      arm.reachWorld(h.pos, h.quat);
      arm.setStow(stow, this.stowDepth(arm));
      arm.setGripper(1);
      this.updateMast(st.id, arm);
      this.env.setWell(st.id, stow);
    }
    this.stands.setDeployed(THREE.MathUtils.clamp(u, 0, 1));
    this.lastT = Number.NaN;
  }

  /** Background animation (screens, racks, holo table, scan feed). */
  update(dt: number, renderer?: THREE.WebGLRenderer): void {
    this.env.update(dt);
    this.detail.update(dt);
    if (renderer) this.scanView.update(dt, renderer);
  }

  /** Every arm deployed at home. */
  applyHome(): void {
    this.setRedeployProgress(1);
  }

  /**
   * Smallest clearance (m) between any deployed arm link and the posed body
   * capsules. Negative = the link passes through the suit. Diagnostics.
   */
  clearance(): { min: number; robot: string; bone: string } {
    const caps = BONE_SPECS.filter((b) => b.deform).map((b) => {
      const [a, c] = b.capsule ?? [b.head, b.tail];
      const m = this.suit.rig.bones[b.name].matrixWorld;
      const toWorld = (p: readonly number[]) =>
        new THREE.Vector3(p[0] - b.head[0], p[1] - b.head[1], p[2] - b.head[2]).applyMatrix4(m);
      return { name: b.name, line: new THREE.Line3(toWorld(a), toWorld(c)), r: b.radius };
    });
    let best = { min: Infinity, robot: '', bone: '' };
    const sa = new THREE.Vector3();
    const sb = new THREE.Vector3();
    for (const [id, arm] of this.arms) {
      if (!arm.group.visible || arm.group.position.distanceTo(arm.base) > 0.05) continue;
      const pts = arm.linkPoints();
      const tip = pts[3].clone().lerp(pts[2], 0.06 / Math.max(1e-6, pts[3].distanceTo(pts[2])));
      for (const [p0, p1] of [
        [pts[0], pts[1]],
        [pts[1], pts[2]],
        [pts[2], tip],
      ] as const) {
        for (const c of caps) {
          for (let k = 0; k <= 8; k++) {
            sa.lerpVectors(p0, p1, k / 8);
            c.line.closestPointToPoint(sa, true, sb);
            const d = sa.distanceTo(sb) - c.r;
            if (d < best.min) best = { min: d, robot: id, bone: c.name };
          }
        }
      }
    }
    return best;
  }
}

/**
 * Joint line between two parts: vertices of `geo` lying within 4 mm of a
 * vertex of `partner` (bind space), with their outward normals.
 */
function seamPoints(
  geo: THREE.BufferGeometry,
  partner: THREE.BufferGeometry | null,
): Array<{ p: THREE.Vector3; n: THREE.Vector3 }> {
  if (!partner) return [];
  const cell = 0.004;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map<string, number[]>();
  const pp = partner.getAttribute('position');
  for (let i = 0; i < pp.count; i++) {
    const k = key(pp.getX(i), pp.getY(i), pp.getZ(i));
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const out: Array<{ p: THREE.Vector3; n: THREE.Vector3 }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Keep only outward-ish surface points (skip inner shell faces)
    const nx = nor ? nor.getX(i) : 0;
    const ny = nor ? nor.getY(i) : 0;
    const nz = nor ? nor.getZ(i) : 1;
    // Outward-facing, roughly horizontal surface points only (skip the
    // inner shell and the rolled edges)
    const radial = x * nx + z * nz;
    if (radial < 0 || Math.abs(ny) > 0.6) continue;
    let near = false;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1 && !near; dx++) {
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dz = -1; dz <= 1 && !near; dz++) {
          const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            const ex = pp.getX(j) - x;
            const ey = pp.getY(j) - y;
            const ez = pp.getZ(j) - z;
            if (ex * ex + ey * ey + ez * ez < cell * cell) {
              near = true;
              break;
            }
          }
        }
      }
    }
    if (!near) continue;
    const k = key(x, y, z);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ p: new THREE.Vector3(x, y, z), n: new THREE.Vector3(nx, ny, nz).normalize() });
  }
  return out;
}
