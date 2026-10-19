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

  it('walks on W from a standstill: stays on its boots, steps, never lifts off', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    const kinds = new Set<string>();
    let steps = 0;
    run(m, 4, (i) => {
      i.throttle = 1;
      if (m.contact === 'footstep') steps++;
      else if (m.contact !== 'none') kinds.add(m.contact);
    });
    expect(kinds.size).toBe(0);
    expect(m.grounded).toBe(true);
    expect(m.speedCmd).toBe(0);
    expect(m.thrust).toBeLessThan(0.01);
    expect(m.pos.z).toBeGreaterThan(4);
    expect(m.speed).toBeGreaterThan(1.2);
    expect(m.speed).toBeLessThan(2);
    // A footfall per step at a heavy walking cadence
    expect(steps).toBeGreaterThan(6);
    expect(steps).toBeLessThan(14);
  });

  it('jogs with Shift, backs up on S and sidesteps on A/D relative to the look', () => {
    const go = (set: (i: ReturnType<typeof EMPTY_INPUT>) => void) => {
      const m = new FlightModel(flat());
      m.placeOnGround(0, 0, 0);
      run(m, 3, (i) => set(i));
      expect(m.grounded).toBe(true);
      return m;
    };
    const jog = go((i) => {
      i.throttle = 1;
      i.boost = true;
    });
    expect(jog.speed).toBeGreaterThan(3);
    expect(jog.boosting).toBe(false);
    const back = go((i) => (i.throttle = -1));
    expect(back.pos.z).toBeLessThan(-1.5);
    // D: strafe to the suit's right (−X when facing +Z), still facing ahead
    const side = go((i) => (i.lateral = 1));
    expect(side.pos.x).toBeLessThan(-1.5);
    expect(Math.abs(side.heading)).toBeLessThan(0.05);
  });

  it('turns in place to the look on stepping feet', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    let steps = 0;
    run(m, 2.5, (i) => {
      i.aim.set(1, 0, 0);
      if (m.contact === 'footstep') steps++;
    });
    expect(Math.abs(m.heading - Math.PI / 2)).toBeLessThan(0.05);
    expect(m.grounded).toBe(true);
    expect(Math.hypot(m.pos.x, m.pos.z)).toBeLessThan(0.3);
    expect(steps).toBeGreaterThan(1);
    // …and a small look round doesn't swivel the body
    const before = m.heading;
    run(m, 1, (i) => i.aim.set(1, 0, 0.4).normalize());
    expect(Math.abs(m.heading - before)).toBeLessThan(0.01);
  });

  it('stops at a wall but steps up a kerb', () => {
    const wall: GroundProbe = { ...flat(), surface: (_x, z) => (z > 3 ? 3 : z > 1.5 ? 0.4 : 0) };
    const m = new FlightModel(wall);
    m.placeOnGround(0, 0, 0);
    let highestBoot = 0;
    run(m, 6, (i) => {
      i.throttle = 1;
      i.boost = true; // jogging into it: long strides reach past the wall face
      for (const f of m.gait.feet) highestBoot = Math.max(highestBoot, f.pos.y);
    });
    expect(highestBoot).toBeLessThan(0.5); // never a boot on the wall top
    expect(m.grounded).toBe(true);
    expect(m.pos.z).toBeGreaterThan(1.6);
    expect(m.pos.z).toBeLessThan(3);
    expect(m.pos.y).toBeCloseTo(1.4, 1);
  });

  it('takes off on Space from a walk, then W is the throttle again — no re-landing', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    let landings = 0;
    let takeoffs = 0;
    let was = true;
    run(m, 5, (i, t) => {
      i.throttle = 1;
      i.boost = true; // jogging, Shift held through the hop
      i.vertical = t > 1 && t < 1.8 ? 1 : 0;
      if (was && !m.grounded) takeoffs++;
      if (['landed', 'touchdown', 'heroLanding'].includes(m.contact)) landings++;
      was = m.grounded;
      // Shift held from the ground doesn't fire the boost
      if (t < 4) expect(m.boosting).toBe(false);
    });
    expect(takeoffs).toBe(1);
    expect(landings).toBe(0);
    expect(m.grounded).toBe(false);
    expect(m.speedCmd).toBeGreaterThan(100);
    expect(m.pos.y).toBeGreaterThan(3);
  });

  it('a tap of Space hops and settles back once, never flapping', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    let flips = 0;
    let was = true;
    run(m, 6, (i, t) => {
      i.vertical = t > 0.5 && t < 0.62 ? 1 : 0;
      if (m.grounded !== was) flips++;
      was = m.grounded;
    });
    expect(flips).toBeLessThanOrEqual(2);
  });

  it('lands from a hover and walks again', () => {
    const m = new FlightModel(flat());
    m.placeOnGround(0, 0, 0);
    let contacts = 0;
    run(m, 12, (i, t) => {
      i.vertical = t < 1 ? 1 : t < 7 ? -0.35 : 0;
      // Drifting forward in the hover on the way down, then W once down: a walk
      i.forward = t > 3 && t < 7 ? 0.15 : 0;
      i.throttle = t > 9 ? 1 : 0;
      if (m.contact !== 'none' && m.contact !== 'footstep') contacts++;
    });
    expect(contacts).toBe(1);
    expect(m.grounded).toBe(true);
    expect(m.flightness).toBe(0);
    expect(m.speed).toBeGreaterThan(0.1);
    expect(m.speed).toBeLessThan(2);
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

  it('falls feet first to its terminal speed on full down, and holds it', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1500, 0);
    m.grounded = false;
    m.airT = 5;
    let maxFl = 0;
    run(m, 18, (i) => {
      i.vertical = -1;
      maxFl = Math.max(maxFl, m.flightness);
    });
    expect(maxFl).toBeLessThan(0.05); // never tips over into flight
    expect(m.thrust).toBeLessThan(0.5); // boots cut
    expect(-m.vel.y).toBeGreaterThan(68);
    expect(-m.vel.y).toBeLessThan(80);
  });

  it('flares at the last second out of a terminal fall into a hero landing', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 400, 0);
    m.vel.set(0, -72, 0);
    m.grounded = false;
    m.airT = 5;
    let flareAt = -1;
    let contact = 'none';
    let touch = 0;
    run(m, 10, (i) => {
      i.vertical = -1; // still held: the flight computer overrides it
      if (m.flare && flareAt < 0) flareAt = m.clearance;
      if (m.contact !== 'none' && contact === 'none') {
        contact = m.contact;
        touch = m.impactSpeed;
      }
    });
    expect(flareAt).toBeGreaterThan(30);
    expect(flareAt).toBeLessThan(80);
    expect(contact).toBe('heroLanding');
    expect(touch).toBeGreaterThan(6);
    expect(touch).toBeLessThan(20);
  });

  it('skims low over the ground without the flare taking over', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 12, 0);
    m.vel.set(0, -4, 150);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 150;
    let flared = false;
    run(m, 3, (i) => {
      i.aim.set(0, 0.02, 1).normalize();
      flared ||= m.flare;
    });
    expect(flared).toBe(false);
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
