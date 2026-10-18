import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { nextLock, paintLock, type Lockable } from './locks';

const eye = new THREE.Vector3(0, 0, 0);
const aim = new THREE.Vector3(0, 0, 1);
const CONE = Math.cos(THREE.MathUtils.degToRad(19));
const h = (x: number, y: number, z: number, alive = true): Lockable => ({ pos: new THREE.Vector3(x, y, z), alive });

/** Paint until nothing new comes up (as many ticks as there's ammo). */
function paintAll(hostiles: Lockable[], capacity: number): Lockable[] {
  const locks: Lockable[] = [];
  for (let i = 0; i < capacity + 4; i++) paintLock(locks, capacity, eye, aim, hostiles, CONE, 3200);
  return locks;
}

describe('one lock per enemy', () => {
  it('never locks the same enemy twice, even with ammunition to spare', () => {
    const hostiles = [h(-30, 0, 800), h(30, 0, 800), h(0, 40, 900)];
    const locks = paintAll(hostiles, 8);
    expect(locks).toHaveLength(3);
    expect(new Set(locks).size).toBe(3);
  });

  it('locks nearest the aim line first', () => {
    const near = h(5, 0, 800);
    const far = h(150, 0, 800);
    const locks = paintAll([far, near], 8);
    expect(locks[0]).toBe(near);
    expect(locks[1]).toBe(far);
  });

  it('stops at the magazine size', () => {
    const hostiles = Array.from({ length: 12 }, (_, i) => h(i * 10 - 60, 0, 900));
    const locks = paintAll(hostiles, 8);
    expect(locks).toHaveLength(8);
    expect(new Set(locks).size).toBe(8);
  });

  it('ignores dead, out-of-cone and out-of-range hostiles', () => {
    const dead = h(0, 0, 500, false);
    const behind = h(0, 0, -500);
    const wide = h(800, 0, 400);
    const far = h(0, 0, 5000);
    expect(paintAll([dead, behind, wide, far], 8)).toHaveLength(0);
  });

  it('drops a lock whose target died, freeing the slot', () => {
    const a = h(0, 0, 800);
    const b = h(20, 0, 800);
    const locks: Lockable[] = [];
    paintLock(locks, 1, eye, aim, [a, b], CONE, 3200);
    expect(locks).toEqual([a]);
    a.alive = false;
    paintLock(locks, 1, eye, aim, [a, b], CONE, 3200);
    expect(locks).toEqual([b]);
  });

  it('offers nothing once every enemy is taken', () => {
    const a = h(0, 0, 800);
    expect(nextLock(eye, aim, [a], [a], CONE, 3200)).toBeNull();
  });
});
