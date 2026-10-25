import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { LimbOffsets } from '../../suit/rigPose';
import { EMPTY_INPUT, FlightModel, type GroundProbe } from './flightModel';
import { COM, legFK, legIK } from './walkCycle';

const flat: GroundProbe = {
  surface: () => 0,
  isWater: () => false,
  normal: (_x, _z, out: THREE.Vector3) => out.set(0, 1, 0),
};

const zeroLimbs = (): Required<LimbOffsets> => ({
  armL: 0, armR: 0, armFlexL: 0, armFlexR: 0, armTwistL: 0, armTwistR: 0, elbowL: 0, elbowR: 0,
  hipL: 0, hipR: 0, hipOutL: 0, hipOutR: 0, kneeL: 0, kneeR: 0, ankleL: 0, ankleR: 0, footRollL: 0, footRollR: 0,
});

/** World ankle of a leg as the rig would draw it (applyPose's root + leg chain). */
function ankleWorld(m: FlightModel, limbs: Required<LimbOffsets>, root: { lift: number; pitch: number; roll: number; yaw: number }, side: 1 | -1) {
  const L = side === 1;
  const a = legFK(side, { hip: L ? limbs.hipL : limbs.hipR, hipOut: L ? limbs.hipOutL : limbs.hipOutR, knee: L ? limbs.kneeL : limbs.kneeR });
  const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), root.pitch).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), root.roll));
  r.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), root.yaw));
  const c = COM.clone().applyQuaternion(r);
  a.applyQuaternion(r).add(new THREE.Vector3(COM.x - c.x, root.lift + COM.y - c.y, COM.z - c.z));
  return a.sub(COM).applyQuaternion(m.bodyQuaternion()).add(m.pos);
}

describe('walk cycle', () => {
  it('solves the leg onto a target and back (IK ∘ FK)', () => {
    for (const side of [1, -1] as const) {
      for (const want of [
        { hip: 0.3, hipOut: 0.05, knee: 0.4 },
        { hip: -0.35, hipOut: -0.03, knee: 0.15 },
        { hip: 0.8, hipOut: 0.15, knee: 1.1 },
      ]) {
        const target = legFK(side, want);
        const got = legFK(side, legIK(side, target));
        expect(got.distanceTo(target)).toBeLessThan(0.002);
      }
    }
  });

  it('keeps planted boots planted: no foot slide walking, strafing and turning', () => {
    const m = new FlightModel(flat);
    m.placeOnGround(0, 0, 0);
    const input = EMPTY_INPUT();
    const dt = 1 / 120;
    const planted: Array<THREE.Vector3 | null> = [null, null];
    let worst = 0;
    let stances = 0;
    let lowest = Infinity;
    for (let t = 0; t < 14; t += dt) {
      input.throttle = t < 4 ? 1 : t < 6 ? 0 : t < 9 ? 1 : 0;
      input.lateral = t > 10 && t < 12 ? 1 : 0;
      const turn = t > 4.5 && t < 6 ? 2 : t > 12.5 ? -1.5 : 0;
      input.aim.set(Math.sin(turn), 0, Math.cos(turn));
      m.step(dt, input);
      const limbs = zeroLimbs();
      const root = m.gait.pose(m.pos, m.bodyQuaternion(), limbs, { lift: 0, pitch: 0, roll: 0, yaw: t > 12 ? 0.3 * Math.sin(t * 3) : 0 });
      if (m.gait.weight < 0.999) continue;
      m.gait.feet.forEach((f, i) => {
        const w = ankleWorld(m, limbs, root, f.side);
        lowest = Math.min(lowest, w.y);
        if (f.swinging || f.heel > 1e-3) {
          planted[i] = null;
          return;
        }
        if (!planted[i]) {
          planted[i] = w.clone();
          stances++;
        } else {
          worst = Math.max(worst, Math.hypot(w.x - planted[i]!.x, w.z - planted[i]!.z), Math.abs(w.y - planted[i]!.y));
        }
      });
    }
    expect(stances).toBeGreaterThan(20);
    expect(worst).toBeLessThan(0.006); // m
    // Never through the deck (ankle stays over the sole)
    expect(lowest).toBeGreaterThan(0.09);
  });

  it('walks onto and off a raised deck without folding a leg', () => {
    for (const rise of [0.35, 0.7]) {
      const deck: GroundProbe = { ...flat, surface: (x, z) => (Math.hypot(x, z - 5) < 3 ? rise : 0) };
      const m = new FlightModel(deck);
      m.placeOnGround(0, 0, 0);
      const input = EMPTY_INPUT();
      let knee = 0;
      let hip = 0;
      let maxY = 0;
      for (let t = 0; t < 10; t += 1 / 120) {
        input.throttle = 1;
        m.step(1 / 120, input);
        const limbs = zeroLimbs();
        m.gait.pose(m.pos, m.bodyQuaternion(), limbs, { lift: 0, pitch: 0, roll: 0, yaw: 0 });
        knee = Math.max(knee, limbs.kneeL, limbs.kneeR);
        hip = Math.max(hip, Math.abs(limbs.hipL), Math.abs(limbs.hipR));
        maxY = Math.max(maxY, m.pos.y);
      }
      expect(m.grounded).toBe(true);
      expect(m.pos.z).toBeGreaterThan(10); // over the deck and off the far side
      expect(maxY).toBeGreaterThan(0.95 + rise);
      expect(knee).toBeLessThan(2); // rad: a high step, never a knee folded flat
      expect(hip).toBeLessThan(2);
    }
  });

  it('lays the soles along a slope and carries the swing over a hump', () => {
    // Uphill ahead (+z) and rising to the suit's left (+x), with a ridge across the path
    const ridge = (z: number) => 0.25 * Math.exp(-(((z - 3) / 0.5) ** 2));
    const hill: GroundProbe = { ...flat, surface: (x, z) => 0.3 * z + 0.15 * x + ridge(z) };
    const m = new FlightModel(hill);
    m.placeOnGround(0, 0, 0);
    const input = EMPTY_INPUT();
    let checked = 0;
    let deepest = 0;
    for (let t = 0; t < 8; t += 1 / 120) {
      input.throttle = 1;
      m.step(1 / 120, input);
      for (const f of m.gait.feet) {
        if (f.swinging || Math.abs(f.pos.z - 3) < 1.5) continue;
        expect(f.tilt.x).toBeCloseTo(Math.atan(0.3), 1);
        expect(f.tilt.y).toBeCloseTo(Math.atan(0.15), 1);
        checked++;
      }
      // Toe and heel of every planted boot on or over the ground
      for (const f of m.gait.feet) {
        if (f.swinging) continue;
        for (const d of [0.2, -0.08]) {
          const x = f.pos.x + Math.sin(f.yaw) * d;
          const z = f.pos.z + Math.cos(f.yaw) * d;
          const sole = f.pos.y + Math.tan(f.tilt.x) * d;
          deepest = Math.max(deepest, hill.surface(x, z) - sole);
        }
      }
    }
    expect(m.pos.z).toBeGreaterThan(5); // walked over the ridge
    expect(checked).toBeGreaterThan(100);
    expect(deepest).toBeLessThan(0.03);
  });

  it('matches the stride to the speed', () => {
    const lengths: number[] = [];
    for (const throttle of [1, 0.5]) {
      const m = new FlightModel(flat);
      m.placeOnGround(0, 0, 0);
      const input = EMPTY_INPUT();
      input.throttle = throttle;
      let s0 = 0;
      let z0 = 0;
      for (let t = 0; t < 6; t += 1 / 120) {
        m.step(1 / 120, input);
        if (t > 2 && !s0) {
          s0 = m.gait.strikes;
          z0 = m.pos.z;
        }
      }
      lengths.push((m.pos.z - z0) / (m.gait.strikes - s0));
    }
    expect(lengths[0]).toBeGreaterThan(0.5);
    expect(lengths[0]).toBeLessThan(0.75);
    expect(lengths[1]).toBeLessThan(lengths[0] * 0.85);
  });
});
