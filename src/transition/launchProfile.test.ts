import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HOVER_HEIGHT, HOVER_HOLD } from '../animation/flightCheck';
import { ROOF_IRIS_R } from '../workshop/roofIris';
import { ROOM_HEIGHT } from '../workshop/workshopEnvironment';
import {
  checkAt,
  CLIMB_EXIT_V,
  climbAt,
  FOLLOW_REL,
  followPose,
  HOVER_TEST_AT,
  CUT_AT,
  cycleAt,
  launchPlan,
  LENS_CEILING,
  roofAt,
  WAIT_MAX,
  workshopLens,
} from './launchProfile';

/** Head (world y) in the hover, before the climb. */
const HOVER_HEAD = 0.05 + 1.72 + HOVER_HEIGHT;
/** Build length (s), and clicks across the cycle: build start, mid build, the check, the hover, the landing, the doff. */
const BUILD = 96;
const CLICKS = [0, 40, BUILD + 8, BUILD + HOVER_TEST_AT, BUILD + HOVER_HOLD[0] + 1, BUILD + HOVER_HOLD[1] + 0.5, BUILD + 34.9, BUILD + 35 + 50];

describe('launch profile', () => {
  it('reaches the settled hover by waiting or by a cut, and holds it there', () => {
    for (const from of CLICKS) {
      const p = launchPlan(from, BUILD);
      expect(cycleAt(p, 0)).toBeCloseTo(from, 6);
      if (p.mode === 'now') expect(p.ready).toBe(0);
      else if (p.mode === 'wait') expect(p.ready).toBeLessThanOrEqual(WAIT_MAX);
      else expect(p.cut).toBe(CUT_AT);
      const at = checkAt(p, p.ready);
      expect(at).toBeGreaterThanOrEqual(HOVER_HOLD[0] - 1e-6);
      expect(at).toBeLessThanOrEqual(HOVER_HOLD[1] + 1e-6);
      for (let t = p.ready; t < p.swap + 1; t += 0.1) {
        expect(checkAt(p, t)).toBeGreaterThanOrEqual(HOVER_HOLD[0] - 1e-6);
        expect(checkAt(p, t)).toBeLessThanOrEqual(HOVER_HOLD[1] + 1e-6);
      }
      // Never climbs before the hover has settled or the iris is open enough
      expect(p.climb).toBeGreaterThan(p.ready);
    }
  });

  it('leaves the climb smoothly at the exit speed', () => {
    const p = launchPlan(BUILD + HOVER_HOLD[0] + 1, BUILD);
    const v = (t: number) => (climbAt(p, t + 1e-3) - climbAt(p, t - 1e-3)) / 2e-3;
    expect(v(p.climb + 0.001)).toBeLessThan(0.05);
    expect(v(p.swap - 0.002)).toBeCloseTo(CLIMB_EXIT_V, 1);
    expect(v(p.swap + 0.002)).toBeCloseTo(CLIMB_EXIT_V, 1);
    for (let t = p.climb; t < p.swap; t += 0.02) expect(v(t)).toBeGreaterThanOrEqual(-1e-6);
  });

  it('has the iris open before the suit gets to it', () => {
    for (const from of CLICKS) {
      const p = launchPlan(from, BUILD);
      for (let t = p.climb; t < p.swap; t += 0.02) {
        // Boots under the ceiling until the blades have gone (head − 1.72 m)
        if (HOVER_HEAD + climbAt(p, t) + 0.2 > ROOM_HEIGHT) expect(roofAt(p, t).iris).toBe(1);
      }
    }
  });

  it('keeps the lens under the truss until it is inside the opening, and on the suit at the swap', () => {
    const head = new THREE.Vector3();
    const out = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 0 };
    for (const from of CLICKS) {
      const p = launchPlan(from, BUILD);
      for (const yaw of [0, 1.1, Math.PI, -2.4]) {
        const start = { pos: new THREE.Vector3(Math.sin(yaw + 2.5) * 3.4, 1.6, Math.cos(yaw + 2.5) * 3.4), look: new THREE.Vector3(0, 1.5, 0), fov: 35 };
        let last: THREE.Vector3 | null = null;
        let lastT = -1;
        for (let t = 0; t <= p.swap + 0.5; t += 1 / 60) {
          head.set(0, HOVER_HEAD + climbAt(p, t), 0);
          workshopLens(p, t, head, yaw, start, out);
          const r = Math.hypot(out.pos.x, out.pos.z);
          if (out.pos.y > LENS_CEILING) expect(r).toBeLessThan(ROOF_IRIS_R - 0.1);
          // The cut is a dip to black: the lens may jump once, onto the suit
          const jumped = p.cut !== null && lastT < p.cut && t >= p.cut;
          if (last && !jumped) expect(out.pos.distanceTo(last)).toBeLessThan(0.25);
          last = out.pos.clone();
          lastT = t;
          if (Math.abs(t - p.swap) < 1 / 120) {
            const want = new THREE.Vector3();
            followPose(head, yaw, want, new THREE.Vector3());
            expect(out.pos.distanceTo(want)).toBeLessThan(1e-3);
          }
        }
      }
    }
  });

  it('waits for the cell to be stowed before the roof moves', () => {
    for (const from of CLICKS) {
      const p = launchPlan(from, BUILD);
      for (let t = p.masts; t < p.ready; t += 0.01) {
        const c = checkAt(p, t);
        expect(c).toBeGreaterThan(0.2);
        expect(c).toBeLessThan(33);
      }
    }
  });

  it('frames the follow inside the shaft', () => {
    expect(Math.hypot(FOLLOW_REL.x, FOLLOW_REL.z)).toBeLessThan(ROOF_IRIS_R - 0.2);
  });
});
