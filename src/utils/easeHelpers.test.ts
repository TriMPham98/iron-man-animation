import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  flightPathKeysFrom,
  hashSeed,
  isFaceplateRest,
  magneticPath,
  mirrorEulerYZ,
  mirrorOffsetX,
  mirrorPathAroundRest,
  mirrorStartAroundRest,
  sampleFlightPathLine,
  scatterStart,
} from './easeHelpers';

const WAVES = [
  'boots',
  'calves',
  'thighs',
  'hips',
  'torso',
  'shoulders',
  'arms',
  'gauntlets',
  'helmet',
  'power',
] as const;

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

describe('frontal scatter (whole suit)', () => {
  const sampleRest = (wave: string, side: -1 | 0 | 1): THREE.Vector3 => {
    const y: Record<string, number> = {
      boots: 0.08,
      calves: 0.4,
      thighs: 0.9,
      hips: 1.05,
      torso: 1.3,
      shoulders: 1.45,
      arms: 1.2,
      gauntlets: 0.95,
      helmet: 1.55,
      power: 1.28,
    };
    const x = side * (wave === 'helmet' || wave === 'torso' ? 0.02 : 0.22);
    return new THREE.Vector3(x, y[wave] ?? 1.0, 0.05);
  };

  it.each(WAVES)('%s starts in front of rest (+Z)', (wave) => {
    const rest = sampleRest(wave, 1);
    const start = scatterStart(rest, `front-${wave}`, 3.5, 8.5, wave);
    expect(start.z).toBeGreaterThan(rest.z + 0.75);
  });

  it('limb starts keep the same lateral side as rest', () => {
    for (const wave of ['arms', 'shoulders', 'gauntlets', 'thighs'] as const) {
      const restL = sampleRest(wave, 1);
      const restR = sampleRest(wave, -1);
      const startL = scatterStart(restL, `${wave}-L`, 3.5, 8.5, wave);
      const startR = scatterStart(restR, `${wave}-R`, 3.5, 8.5, wave);
      expect(startL.x).toBeGreaterThan(restL.x - 0.05);
      expect(startR.x).toBeLessThan(restR.x + 0.05);
    }
  });

  it('faceplate scatter starts well in front (+Z) of the rest pose', () => {
    const rest = new THREE.Vector3(0.02, 1.55, 0.12);
    expect(isFaceplateRest(rest)).toBe(true);
    const start = scatterStart(rest, 'faceplate-seed', 3.5, 8.5, 'helmet');
    expect(start.z).toBeGreaterThan(rest.z + 1.5);
    expect(start.y).toBeLessThan(rest.y + 0.6);
    expect(Math.abs(start.x - rest.x)).toBeLessThan(0.35);
  });

  it('cranial shell helmet scatter is above-front (not pure side)', () => {
    const rest = new THREE.Vector3(0.02, 1.62, -0.05);
    expect(isFaceplateRest(rest)).toBe(false);
    const start = scatterStart(rest, 'shell-seed', 3.5, 8.5, 'helmet');
    expect(start.z).toBeGreaterThan(rest.z + 0.75);
    expect(start.y).toBeGreaterThan(rest.y + 0.5);
  });

  it('boots scatter is front-and-below', () => {
    const rest = new THREE.Vector3(0.12, 0.08, 0.05);
    const start = scatterStart(rest, 'boot-front', 3.5, 8.5, 'boots');
    expect(start.z).toBeGreaterThan(rest.z + 0.75);
    expect(start.y).toBeLessThan(rest.y);
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

  it('sampleFlightPathLine starts at scatter and ends at rest', () => {
    const start = new THREE.Vector3(2, 1, 1);
    const rest = new THREE.Vector3(0.2, 1.1, 0);
    const path = magneticPath(start, rest, 'line-seed');
    const keys = flightPathKeysFrom(start, rest, path);
    const pts = sampleFlightPathLine(keys, 32);
    expect(pts.length).toBeGreaterThan(8);
    expect(pts[0].distanceTo(start)).toBeLessThan(1e-4);
    expect(pts[pts.length - 1].distanceTo(rest)).toBeLessThan(1e-4);
  });

  it('frontal magneticPath keeps waypoint in front of rest', () => {
    const rest = new THREE.Vector3(0.1, 1.2, 0.05);
    const start = scatterStart(rest, 'path-front', 3.5, 8.5, 'torso');
    const path = magneticPath(start, rest, 'path-front');
    expect(path.waypoint.z).toBeGreaterThan(rest.z);
  });
});
