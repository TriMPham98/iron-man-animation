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
  LAUNCH_FROM,
  launchPlan,
  LENS_CEILING,
  roofAt,
  workshopLens,
} from './launchProfile';

/** Head (world y) in the hover, before the climb. */
const HOVER_HEAD = 0.05 + 1.72 + HOVER_HEIGHT;
const CLICKS = [LAUNCH_FROM, LAUNCH_FROM + 1.5, HOVER_HOLD[0] + 1, HOVER_HOLD[1] + 0.5, 34.9];

describe('launch profile', () => {
  it('runs the check into the settled hover and holds it there', () => {
    for (const from of CLICKS) {
      const p = launchPlan(from);
      expect(checkAt(p, 0)).toBeCloseTo(from, 6);
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
    const p = launchPlan(HOVER_HOLD[0] + 1);
    const v = (t: number) => (climbAt(p, t + 1e-3) - climbAt(p, t - 1e-3)) / 2e-3;
    expect(v(p.climb + 0.001)).toBeLessThan(0.05);
    expect(v(p.swap - 0.002)).toBeCloseTo(CLIMB_EXIT_V, 1);
    expect(v(p.swap + 0.002)).toBeCloseTo(CLIMB_EXIT_V, 1);
    for (let t = p.climb; t < p.swap; t += 0.02) expect(v(t)).toBeGreaterThanOrEqual(-1e-6);
  });

  it('has the iris open before the suit gets to it', () => {
    for (const from of CLICKS) {
      const p = launchPlan(from);
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
      const p = launchPlan(from);
      for (const yaw of [0, 1.1, Math.PI, -2.4]) {
        const start = { pos: new THREE.Vector3(Math.sin(yaw + 2.5) * 3.4, 1.6, Math.cos(yaw + 2.5) * 3.4), look: new THREE.Vector3(0, 1.5, 0), fov: 35 };
        let last: THREE.Vector3 | null = null;
        for (let t = 0; t <= p.swap + 0.5; t += 1 / 60) {
          head.set(0, HOVER_HEAD + climbAt(p, t), 0);
          workshopLens(p, t, head, yaw, start, out);
          const r = Math.hypot(out.pos.x, out.pos.z);
          if (out.pos.y > LENS_CEILING) expect(r).toBeLessThan(ROOF_IRIS_R - 0.1);
          if (last) expect(out.pos.distanceTo(last)).toBeLessThan(0.25);
          last = out.pos.clone();
          if (Math.abs(t - p.swap) < 1 / 120) {
            const want = new THREE.Vector3();
            followPose(head, yaw, want, new THREE.Vector3());
            expect(out.pos.distanceTo(want)).toBeLessThan(1e-3);
          }
        }
      }
    }
  });

  it('frames the follow inside the shaft', () => {
    expect(Math.hypot(FOLLOW_REL.x, FOLLOW_REL.z)).toBeLessThan(ROOF_IRIS_R - 0.2);
  });
});
