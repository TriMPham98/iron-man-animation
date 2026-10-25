import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { coreDistance, segmentToCore } from './hitShape';
import type { Hostile } from './types';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function target(span?: [THREE.Vector3, THREE.Vector3]): Hostile {
  return { id: 1, kind: 'ship', pos: v(0, 0, 0), vel: v(0, 0, 0), radius: 2, hp: 1, maxHp: 1, alive: true, threatened: 0, span, damage: () => false };
}

describe('hit shapes', () => {
  it('measures a point to a sphere centre or a capsule spine', () => {
    expect(coreDistance(target(), v(3, 4, 0))).toBeCloseTo(5);
    const hull = target([v(0, 0, -50), v(0, 0, 50)]);
    expect(coreDistance(hull, v(3, 0, 40))).toBeCloseTo(3);
    expect(coreDistance(hull, v(0, 0, 54))).toBeCloseTo(4);
  });

  it('finds a shot crossing the spine of a long hull, far from its centre', () => {
    const hull = target([v(0, 0, -50), v(0, 0, 50)]);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const d2 = segmentToCore(hull, v(-10, 1, 30), v(10, 1, 30), a, b);
    expect(Math.sqrt(d2)).toBeCloseTo(1);
    expect(b.z).toBeCloseTo(30);
    // The same shot against a sphere at the middle misses by 30 m
    expect(Math.sqrt(segmentToCore(target(), v(-10, 1, 30), v(10, 1, 30), a, b))).toBeGreaterThan(30);
  });
});
