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
  taskForPiece,
  toolJob,
  type FitTask,
  type RobotId,
  type ToolJob,
} from './fittingProgram';
import { mergeStaticChildren, mergeStaticTree } from './mergeStatic';
import { SuitScanView } from './suitScanView';
import { createRobotMaterials, RobotArm, toolQuaternion } from './robotArm';
import {
  createCradleStand,
  createWorkshopEnvironment,
  ROOM_HEIGHT,
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
}

type Segment =
  | { t0: number; t1: number; kind: 'hold'; pose: ToolPose }
  | { t0: number; t1: number; kind: 'move'; from: ToolPose; to: ToolPose; arc: number }
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
 * The robot cell: environment, fourteen arms and their parts cradles.
 *
 * Each arm runs a baked program of hold / move / attached / tool segments.
 * Grippers ride the part they carry; riveters ride the seated
 * part's frame while they work its seams. After its last job an arm folds
 * and drops into its floor well (or climbs its mast into the ceiling) so
 * the finished suit stands alone, as in the film. Everything is a function
 * of the seed-clock time, so scrubbing is exact.
 */
export class Workshop {
  readonly group = new THREE.Group();
  private readonly env: WorkshopEnvironment;
  /** Live suit diagnostic feed shown on the workshop monitors. */
  private readonly scanView: SuitScanView;
  private readonly arms = new Map<RobotId, RobotArm>();
  private readonly programs = new Map<RobotId, Segment[]>();
  private readonly homes = new Map<RobotId, ToolPose>();
  private readonly passes = new Map<string, ToolPass>();
  private readonly masts = new Map<RobotId, THREE.Mesh>();
  private readonly mats = createRobotMaterials();
  private readonly liftTasks: FitTask[];
  private readonly rivetSites: Array<{ pass: ToolPass; k: number }> = [];
  private readonly rivets: THREE.InstancedMesh;
  private readonly hot: THREE.InstancedMesh;
  private lastT = Number.NaN;
  private readonly _m = new THREE.Matrix4();
  private readonly _m2 = new THREE.Matrix4();
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
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

    // Rivet heads (+ their heat glow) ride the parts
    this.prepareToolPasses();
    const rivetGeo = new THREE.SphereGeometry(0.0075, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const glowGeo = new THREE.SphereGeometry(0.012, 10, 8);
    this.rivets = new THREE.InstancedMesh(rivetGeo, this.mats.metal, Math.max(1, this.rivetSites.length));
    this.hot = new THREE.InstancedMesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      Math.max(1, this.rivetSites.length),
    );
    this.hot.setColorAt(0, new THREE.Color(0, 0, 0));
    for (const im of [this.rivets, this.hot]) {
      im.frustumCulled = false;
      im.count = 0;
      this.group.add(im);
    }

    this.group.updateMatrixWorld(true);
    this.buildCradles();
    // Static props: one draw per material
    mergeStaticTree(this.env.group);
    this.bake();
    this.applyHome();
  }

  private toWorld(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.suit.kin.modelWorld);
  }

  private buildCradles(): void {
    const stands = new THREE.Group();
    stands.name = 'cradles';
    for (const task of FIT_TASKS) {
      if (!task.robot) continue;
      const c = cradleFor(task);
      let minY = Infinity;
      let maxY = -Infinity;
      for (const id of task.pieces) {
        const box = this.suit.pieceBounds(id);
        if (!box) continue;
        minY = Math.min(minY, box.min.y);
        maxY = Math.max(maxY, box.max.y);
      }
      const bottom = c[1] - (task.origin[1] - minY);
      const top = c[1] + (maxY - task.origin[1]);
      const hanging = ROBOTS.find((r) => r.id === task.robot)!.mount === 'ceiling';
      const stand = createCradleStand(new THREE.Vector3(c[0], c[1], c[2]), bottom, top, hanging, {
        steel: this.mats.paint,
        accent: this.mats.accent,
      });
      stands.add(...stand.children);
    }
    mergeStaticChildren(stands);
    this.group.add(stands);
  }

  /** Snap every rivet site onto its part's surface. */
  private prepareToolPasses(): void {
    const ray = new THREE.Raycaster();
    const probeMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    for (const timing of this.plan.tools) {
      const spec = toolJob(timing.job);
      const piece = this.suit.pieces.find((p) => p.id === spec.piece);
      const geo = (piece?.mesh as THREE.Mesh | undefined)?.geometry;
      const probe = geo ? new THREE.Mesh(geo, probeMat) : null;
      const n = new THREE.Vector3(...spec.normal).normalize();
      const sites = spec.points.map((p) => {
        const site = new THREE.Vector3(...p);
        if (!probe) return site;
        ray.set(site.clone().addScaledVector(n, 0.3), n.clone().negate());
        ray.far = 0.6;
        const hit = ray.intersectObject(probe, false)[0];
        return hit ? hit.point.clone() : site;
      });
      const pass: ToolPass = { timing, spec, sites };
      this.passes.set(timing.job, pass);
      sites.forEach((_, k) => this.rivetSites.push({ pass, k }));
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
    const { timing, sites, spec } = pass;
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
    this.siteWorld(frame, this._v, spec.normal, out.pos, this._n);
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

    this.updateMarks(frame);
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

  /** Rivet heads: appear when struck, glow hot, then seat flush. */
  private updateMarks(frame: SuitUpFrame): void {
    const t = frame.t;
    let nr = 0;
    let nh = 0;
    const color = new THREE.Color();
    const frameCache = new Map<ArmorPieceId, THREE.Matrix4>();
    const frameOf = (id: ArmorPieceId) => {
      let f = frameCache.get(id);
      if (!f) {
        f = this.partFrame(id, frame.pieces, new THREE.Matrix4());
        frameCache.set(id, f);
      }
      return f;
    };
    const up = new THREE.Vector3(0, 1, 0);
    const place = (im: THREE.InstancedMesh, i: number, p: THREE.Vector3, n: THREE.Vector3, s: number) => {
      this._q.setFromUnitVectors(up, n);
      this._m.compose(p, this._q, this._s.set(s, s, s));
      im.setMatrixAt(i, this._m);
    };
    const heat = (age: number, tau: number) => Math.exp(-age / tau);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();

    // Animation-only: rivet heads seat flush, so the finished suit carries
    // no extra geometry.
    const fade = (age: number, hold: number, out: number) =>
      1 - THREE.MathUtils.smoothstep(age, hold, hold + out);
    for (const { pass, k } of this.rivetSites) {
      const struck = pass.timing.strikes[k];
      if (struck === undefined || t < struck) continue;
      const age = t - struck;
      const keep = fade(age, 0.7, 0.5);
      if (keep <= 0.01) continue;
      this.siteWorld(frameOf(pass.spec.piece), pass.sites[k], pass.spec.normal, p, n);
      place(this.rivets, nr++, p, n, keep);
      const h = heat(age, 0.3);
      if (h > 0.02) {
        place(this.hot, nh, p, n, 0.6 + h);
        this.hot.setColorAt(nh++, color.setRGB(h, 0.45 * h * h, 0.12 * h * h * h));
      }
    }
    this.rivets.count = nr;
    this.hot.count = nh;
    for (const im of [this.rivets, this.hot]) im.instanceMatrix.needsUpdate = true;
    if (this.hot.instanceColor) this.hot.instanceColor.needsUpdate = true;
  }

  /**
   * Reset handoff: 0 = every arm stowed (end of a cycle), 1 = deployed at
   * home ready for the next one. Rivet marks are cleared.
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
    this.rivets.count = 0;
    this.hot.count = 0;
    this.lastT = Number.NaN;
  }

  /** Background animation (screens, racks, holo table, scan feed). */
  update(dt: number, renderer?: THREE.WebGLRenderer): void {
    this.env.update(dt);
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
