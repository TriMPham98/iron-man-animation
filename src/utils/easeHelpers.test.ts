import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  hashSeed,
  magneticPath,
  mirrorEulerYZ,
  mirrorOffsetX,
  mirrorPathAroundRest,
  mirrorStartAroundRest,
  scatterStart,
} from './easeHelpers';

describe('scatterStart determinism', () => {
  it('same seed → same start position', () => {
    const rest = new THREE.Vector3(0.2, 1.2, 0.05);
    const a = scatterStart(rest, 'shard-0-arms', 3.5, 8.5, 'arms');
    const b = scatterStart(rest, 'shard-0-arms', 3.5, 8.5, 'arms');
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });

  it('different seeds → different positions', () => {
    const rest = new THREE.Vector3(0, 1, 0);
    const a = scatterStart(rest, 'seed-a', 4, 9, 'torso');
    const b = scatterStart(rest, 'seed-b', 4, 9, 'torso');
    expect(a.equals(b)).toBe(false);
  });

  it('hashSeed is deterministic', () => {
    expect(hashSeed('hello')).toBe(hashSeed('hello'));
    expect(hashSeed('hello')).not.toBe(hashSeed('world'));
  });
});

describe('mirror helpers (bilateral flight)', () => {
  it('mirrorOffsetX flips X only', () => {
    const m = mirrorOffsetX(new THREE.Vector3(1.5, 2, -0.3));
    expect(m.x).toBeCloseTo(-1.5);
    expect(m.y).toBeCloseTo(2);
    expect(m.z).toBeCloseTo(-0.3);
  });

  it('mirrorStartAroundRest maps scatter offset to opposite rest', () => {
    const restL = new THREE.Vector3(0.2, 1.0, 0.1);
    const restR = new THREE.Vector3(-0.2, 1.0, 0.1);
    const startL = new THREE.Vector3(1.5, 2.0, 3.0);
    const startR = mirrorStartAroundRest(startL, restL, restR);
    // offset L = (1.3, 1.0, 2.9) → mirror (-1.3, 1.0, 2.9) at restR
    expect(startR.x).toBeCloseTo(-0.2 + -1.3);
    expect(startR.y).toBeCloseTo(1.0 + 1.0);
    expect(startR.z).toBeCloseTo(0.1 + 2.9);
  });

  it('mirrorPathAroundRest reflects control points in rest-local space', () => {
    const restL = new THREE.Vector3(0.25, 1.1, 0);
    const restR = new THREE.Vector3(-0.25, 1.1, 0);
    const startL = new THREE.Vector3(2, 1.5, 1);
    const pathL = magneticPath(startL, restL, 'pair-seed', { helmet: false });
    const pathR = mirrorPathAroundRest(pathL, restL, restR);

    const check = (pl: THREE.Vector3, pr: THREE.Vector3) => {
      const oL = pl.clone().sub(restL);
      const oR = pr.clone().sub(restR);
      expect(oR.x).toBeCloseTo(-oL.x, 5);
      expect(oR.y).toBeCloseTo(oL.y, 5);
      expect(oR.z).toBeCloseTo(oL.z, 5);
    };
    check(pathL.waypoint, pathR.waypoint);
    check(pathL.approach, pathR.approach);
    check(pathL.overshoot, pathR.overshoot);
  });

  it('mirrorEulerYZ flips yaw and roll', () => {
    const e = new THREE.Euler(0.5, 1.2, -0.3);
    const m = mirrorEulerYZ(e);
    expect(m.x).toBeCloseTo(0.5);
    expect(m.y).toBeCloseTo(-1.2);
    expect(m.z).toBeCloseTo(0.3);
  });
});
