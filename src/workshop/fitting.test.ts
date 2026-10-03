import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildSuitUpPlan,
  evaluatePose,
  evaluateSuitUp,
} from '../animation/suitUpChoreography';
import { SUIT_GROUND_CLEARANCE } from '../suit/loadSuitModel';
import { applyPose, createRig } from '../suit/rigPose';
import { FitKinematics } from './fittingKinematics';
import { armDims, FIT_TASKS, ROBOTS, fitTask } from './fittingProgram';
import { createRobotMaterials, RobotArm } from './robotArm';

/** Rig placed exactly like Suit.create (lift + heroic lean). */
function placedRig() {
  const suitGroup = new THREE.Group();
  suitGroup.position.y = SUIT_GROUND_CLEARANCE;
  suitGroup.rotation.x = -0.03;
  const model = new THREE.Group();
  suitGroup.add(model);
  const rig = createRig();
  model.add(rig.root);
  suitGroup.updateMatrixWorld(true);
  return { rig, kin: new FitKinematics(rig, model.matrixWorld.clone()) };
}

describe('fitting program', () => {
  it('assigns every armor piece to exactly one task', () => {
    const all = FIT_TASKS.flatMap((t) => t.pieces);
    expect(new Set(all).size).toBe(all.length);
  });

  it('every robot-held job stays within reach for its whole hold', () => {
    const plan = buildSuitUpPlan();
    const { rig, kin } = placedRig();
    const mats = createRobotMaterials();
    const arms = new Map(ROBOTS.map((r) => [r.id, new RobotArm(r.id, r.base, r.mount, r.pedestal, mats, r.tool, armDims(r))]));
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    let worst = 0;
    for (const f of plan.fits) {
      if (!f.robot) continue;
      const task = fitTask(f.task);
      const arm = arms.get(f.robot)!;
      for (let t = f.grasp; t <= f.retreat; t += 0.04) {
        applyPose(rig, evaluatePose(plan, t));
        rig.root.updateWorldMatrix(true, true);
        const lead = evaluateSuitUp(plan, t).pieces.find((p) => p.id === task.pieces[0])!;
        kin.taskFrame(task, lead, m);
        kin.toolPose(task, m, pos, quat);
        worst = Math.max(worst, arm.reachWorld(pos, quat));
      }
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('docks parts exactly onto the skinned socket (identity mesh matrix)', () => {
    const plan = buildSuitUpPlan();
    const { rig, kin } = placedRig();
    const f = evaluateSuitUp(plan, 11.5);
    applyPose(rig, f.pose);
    rig.root.updateWorldMatrix(true, true);
    const tf = new THREE.Matrix4();
    const pf = new THREE.Matrix4();
    const mesh = new THREE.Matrix4();
    for (const task of FIT_TASKS.filter((t) => t.id !== 'helmet')) {
      const lead = f.pieces.find((p) => p.id === task.pieces[0])!;
      kin.taskFrame(task, lead, tf);
      for (const id of task.pieces) {
        kin.pieceFrame(task, tf, f.pieces.find((p) => p.id === id)!, pf);
        kin.meshMatrix(id, pf, mesh);
        expect(mesh.equals(new THREE.Matrix4()) || mesh.elements.every((v, i) => Math.abs(v - new THREE.Matrix4().elements[i]) < 1e-5)).toBe(true);
      }
    }
  });
});
