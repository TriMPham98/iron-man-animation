import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT, FlightModel, type GroundProbe } from './flightModel';

/** Flat ground at y = 0 (or sea, for the water tests). */
const flat = (water = false): GroundProbe => ({
  surface: () => 0,
  isWater: () => water,
  normal: (_x, _z, out: THREE.Vector3) => out.set(0, 1, 0),
});

function run(m: FlightModel, seconds: number, set: (i: ReturnType<typeof EMPTY_INPUT>, t: number) => void) {
  const input = EMPTY_INPUT();
  const dt = 1 / 120;
  for (let t = 0; t < seconds; t += dt) {
    set(input, t);
    m.step(dt, input);
  }
}

describe('FlightModel', () => {
  it('stands still on the ground with no input', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    run(m, 2, () => {});
    expect(m.grounded).toBe(true);
    expect(m.speed).toBeLessThan(0.01);
  });

  it('lifts off and climbs on the climb command', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    run(m, 2, (i) => (i.vertical = 1));
    expect(m.grounded).toBe(false);
    expect(m.pos.y).toBeGreaterThan(10);
  });

  it('moves off on the throttle alone from a standstill without re-landing every step', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    let contacts = 0;
    run(m, 3, (i) => {
      i.throttle = 1;
      if (m.contact !== 'none') contacts++;
    });
    expect(contacts).toBeLessThan(3);
    expect(m.grounded).toBe(false);
    expect(m.speedCmd).toBeGreaterThan(100);
    expect(m.speed).toBeGreaterThan(10);
  });

  it('leans over into flight on the throttle and holds the commanded speed', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    run(m, 12, (i, t) => {
      i.vertical = t < 1.5 ? 1 : 0;
      i.throttle = t > 1 && t < 3 ? 1 : 0;
      i.aim.set(0, 0.05, 1).normalize();
    });
    expect(m.flightness).toBeGreaterThan(0.9);
    expect(m.speed).toBeGreaterThan(m.speedCmd * 0.85);
  });

  it('breaks the sound barrier on boost', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 500, 0);
    m.vel.set(0, 0, 150);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 150;
    run(m, 8, (i) => {
      i.boost = true;
      i.aim.set(0, 0, 1);
    });
    expect(m.mach).toBeGreaterThan(1);
  });

  it('keeps its height while braking hard into a hover', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 200, 0);
    m.vel.set(0, 0, 130);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 130;
    run(m, 6, (i) => {
      i.brake = true;
      i.aim.set(0, 0, 1);
    });
    expect(m.speed).toBeLessThan(15);
    expect(m.pos.y).toBeGreaterThan(150);
  });

  it('comes down fast in a hover as a three-point landing, not a crash', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 60, 0);
    m.grounded = false;
    let contact = 'none';
    run(m, 8, (i) => {
      i.vertical = -1;
      if (m.contact !== 'none' && contact === 'none') contact = m.contact;
    });
    expect(contact).toBe('heroLanding');
    expect(m.grounded).toBe(true);
  });

  it('rolls out of inverted flight instead of dithering on the ±π seam', () => {
    const m = new FlightModel(flat(true));
    m.pos.set(0, 300, 0);
    m.vel.set(0, 0, 200);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 200;
    m.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    run(m, 3, (i) => i.aim.set(0, 0, 1));
    expect(m.up().y).toBeGreaterThan(0.5);
  });

  it('turns on a dime in a hover smoothly: eased yaw, no snap, no overshoot', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 50, 0);
    m.grounded = false;
    const dt = 1 / 120;
    const input = EMPTY_INPUT();
    let heading = 0;
    let prevRate = 0;
    let maxStep = 0;
    let peak = 0;
    let t90 = -1;
    let overshoot = 0;
    for (let t = 0; t < 3; t += dt) {
      // Flick the aim 90° to the left
      input.aim.set(t > 0.1 ? 1 : 0, 0, t > 0.1 ? 0 : 1);
      const before = m.forward();
      m.step(dt, input);
      const after = m.forward();
      heading += Math.atan2(after.x, after.z) - Math.atan2(before.x, before.z);
      const rate = m.omega.y;
      // Yaw acceleration per frame never jumps: the turn eases in
      maxStep = Math.max(maxStep, Math.abs(rate - prevRate) / dt);
      prevRate = rate;
      peak = Math.max(peak, rate);
      overshoot = Math.max(overshoot, heading - Math.PI / 2);
      if (t90 < 0 && heading > Math.PI / 2 * 0.9) t90 = t;
    }
    expect(maxStep).toBeLessThan(16); // rad/s² (it used to step ~34)
    expect(peak).toBeGreaterThan(2.5); // still a quick pivot
    expect(t90).toBeGreaterThan(0);
    expect(t90).toBeLessThan(1); // responsive
    expect(overshoot).toBeLessThan(0.03);
    expect(Math.abs(heading - Math.PI / 2)).toBeLessThan(0.02);
  });

  it('eases the lean-over into flight instead of kicking it', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 200, 0);
    m.grounded = false;
    let peakRate = 0;
    run(m, 0.05, (i) => (i.throttle = 1));
    const early = m.postureVel;
    run(m, 4, (i) => {
      i.throttle = 1;
      peakRate = Math.max(peakRate, Math.abs(m.postureVel));
    });
    // Slow off the mark, swinging through the middle, landing near prone
    expect(Math.abs(early)).toBeLessThan(peakRate * 0.25);
    expect(m.posture).toBeGreaterThan(1.3);
    expect(m.posture).toBeLessThan(1.5);
  });
});
