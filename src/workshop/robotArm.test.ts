import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { armForward, createRobotMaterials, RobotArm, solveArmIK, toolQuaternion } from './robotArm';
import { armDims, ROBOTS } from './fittingProgram';
import { APERTURE_UNDERSIDE } from './ringAperture';

describe('solveArmIK', () => {
  const cases: Array<[number[], number[], number[]]> = [
    [[0.3, 0.6, 0.8], [0, -1, 0.2], [0, 0, 1]],
    [[-0.5, 0.2, 0.6], [0.3, -0.2, 1], [0, 1, 0]],
    [[0.7, 1.1, 0.2], [-1, 0, 0], [0, 1, 0]],
    [[0.1, -0.4, 0.9], [0, 0.4, 1], [1, 0, 0]],
  ];
  it('round-trips through forward kinematics', () => {
    for (const [p, a, u] of cases) {
      const tcp = new THREE.Vector3(...p);
      const q = toolQuaternion(new THREE.Vector3(...a), new THREE.Vector3(...u));
      const j = solveArmIK(tcp, q);
      expect(j.error).toBe(0);
      const fk = armForward(j);
      expect(fk.pos.distanceTo(tcp)).toBeLessThan(1e-6);
      expect(Math.abs(fk.quat.dot(q))).toBeCloseTo(1, 6);
    }
  });

  it('reports the miss for out-of-reach targets', () => {
    const q = toolQuaternion(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    const j = solveArmIK(new THREE.Vector3(0, 0.4, 3), q);
    expect(j.error).toBeGreaterThan(0.5);
  });
});

describe('RobotArm stow', () => {
  it('drops every floor arm’s whole fold under the aperture blades', () => {
    const mats = createRobotMaterials();
    for (const st of ROBOTS.filter((s) => s.mount === 'floor')) {
      const arm = new RobotArm(st.id, st.base, st.mount, st.pedestal, mats, st.tool, armDims(st));
      arm.setStow(0.998, arm.base.y + arm.foldedTop() - APERTURE_UNDERSIDE + 0.005);
      arm.group.updateMatrixWorld(true);
      expect(new THREE.Box3().setFromObject(arm.group, true).max.y).toBeLessThan(APERTURE_UNDERSIDE);
    }
  });
});
