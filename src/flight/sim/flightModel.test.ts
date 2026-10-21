import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT, FlightModel, MAX_MACH, type GroundProbe } from './flightModel';

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

  it("walks on W (Shift doesn't run), backs up on S and sidesteps on A/D relative to the look", () => {
    const go = (set: (i: ReturnType<typeof EMPTY_INPUT>) => void) => {
      const m = new FlightModel(flat());
      m.placeOnGround(0, 0, 0);
      run(m, 3, (i) => set(i));
      expect(m.grounded).toBe(true);
      return m;
    };
    const walk = go((i) => {
      i.throttle = 1;
      i.boost = true;
    });
    expect(walk.speed).toBeGreaterThan(1.2);
    expect(walk.speed).toBeLessThan(1.6);
    expect(walk.boosting).toBe(false);
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
      i.boost = true; // Shift held through the hop
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

  it('tops out at MAX_MACH on boost up high, and the thick air holds it short low down', () => {
    const top = (alt: number) => {
      const m = new FlightModel(flat());
      m.pos.set(0, alt, 0);
      m.vel.set(0, 0, 250);
      m.grounded = false;
      m.flightness = 1;
      m.posture = 1.42;
      m.speedCmd = 250;
      run(m, 25, (i) => {
        i.boost = true;
        i.aim.set(0, 0, 1);
      });
      return m.mach;
    };
    expect(top(5000)).toBeCloseTo(MAX_MACH, 2);
    const low = top(300);
    expect(low).toBeGreaterThan(1.35);
    expect(low).toBeLessThan(MAX_MACH - 0.04);
  });

  it('spools the boost up over a beat instead of stepping onto it', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1500, 0);
    m.vel.set(0, 0, 200);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 200;
    m.airT = 5;
    run(m, 2, (i) => i.aim.set(0, 0, 1));
    const dt = 1 / 120;
    let last = m.speed;
    let early = 0;
    let peak = 0;
    run(m, 1.5, (i, t) => {
      i.aim.set(0, 0, 1);
      i.boost = true;
      const a = (m.speed - last) / dt;
      last = m.speed;
      if (t < 0.06) early = Math.max(early, a);
      peak = Math.max(peak, a);
    });
    expect(peak).toBeGreaterThan(3 * 9.81);
    expect(early).toBeLessThan(peak * 0.15);
  });

  it('bleeds a boost back to the throttle at about 2 g when it lets go, not a slam', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1000, 0);
    m.vel.set(0, 0, 430);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 270;
    m.airT = 5;
    let prev = m.speed;
    let peak = 0;
    let at3 = 0;
    run(m, 12, (i, t) => {
      i.aim.set(0, 0, 1);
      i.boost = t < 1;
      if (t > 1.2) peak = Math.max(peak, (prev - m.speed) * 120);
      prev = m.speed;
      if (t < 4) at3 = m.speed;
    });
    expect(peak / 9.81).toBeLessThan(2.5);
    // Still carrying most of it three seconds on, settled on the throttle by the end
    expect(at3).toBeGreaterThan(350);
    expect(m.speed).toBeGreaterThan(260);
    expect(m.speed).toBeLessThan(285);
  });

  it('brakes from supersonic at no more than about 6 g', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1000, 0);
    m.vel.set(0, 0, 430);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 270;
    m.airT = 5;
    let prev = m.speed;
    let peak = 0;
    run(m, 6, (i, t) => {
      i.aim.set(0, 0, 1);
      i.brake = true;
      if (t > 0.05) peak = Math.max(peak, (prev - m.speed) * 120);
      prev = m.speed;
    });
    expect(peak / 9.81).toBeLessThan(6.3);
    expect(peak / 9.81).toBeGreaterThan(4.5);
  });

  it('brakes from cruise at an even pull and settles the last few m/s, not drifts them', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1000, 0);
    m.vel.set(0, 0, 120);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 120;
    m.airT = 5;
    let prev = m.speed;
    let lo = Infinity;
    let hi = 0;
    let t10 = 0;
    let tStop = 0;
    run(m, 8, (i, t) => {
      i.aim.set(0, 0, 1);
      i.brake = true;
      const d = (prev - m.speed) * 120;
      prev = m.speed;
      // Between 80 and 15 m/s: no second bite as the boots take over
      if (m.speed < 80 && m.speed > 15) {
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      if (!t10 && m.speed < 10) t10 = t;
      if (!tStop && m.speed < 0.5) tStop = t;
    });
    expect(hi - lo).toBeLessThan(0.6 * 9.81);
    expect(tStop - t10).toBeLessThan(1.6);
  });

  it('cracks the flaps as speed brakes on S well over the setting', () => {
    const fly = (s: number) => {
      const m = new FlightModel(flat());
      m.pos.set(0, 1000, 0);
      m.vel.set(0, 0, 270);
      m.grounded = false;
      m.flightness = 1;
      m.posture = 1.42;
      m.speedCmd = 270;
      m.airT = 5;
      let flaps = 0;
      run(m, 3, (i) => {
        i.aim.set(0, 0, 1);
        i.throttle = s;
        flaps = Math.max(flaps, m.airbrake);
      });
      return { m, flaps };
    };
    const held = fly(-1);
    expect(held.flaps).toBeGreaterThan(0.4);
    expect(held.flaps).toBeLessThan(0.6);
    expect(held.m.flightness).toBeGreaterThan(0.9);
    expect(held.m.surge).toBeLessThan(-1.2 * 9.81);
    expect(held.m.surge).toBeGreaterThan(-3 * 9.81);
    expect(fly(0).flaps).toBeLessThan(0.01);
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

  it('pushes straight back off a supersonic flare: no slump, no zoom, holds the speed it kept', () => {
    const fly = (after: 'boost' | 'none') => {
      const m = new FlightModel(flat());
      m.pos.set(0, 1500, 0);
      m.vel.set(0, 0, 400);
      m.grounded = false;
      m.flightness = 1;
      m.posture = 1.42;
      m.speedCmd = 270;
      m.airT = 5;
      let atRelease = 0;
      let low = Infinity;
      let yMax = 0;
      run(m, 5, (i, t) => {
        i.aim.set(0, 0, 1);
        i.brake = t >= 1 && t < 2.5;
        i.boost = t < 1 || (after === 'boost' && t >= 2.5);
        if (t < 2.5) atRelease = m.speed;
        else low = Math.min(low, m.speed);
        yMax = Math.max(yMax, m.pos.y);
      });
      return { m, atRelease, low, yMax };
    };
    const boost = fly('boost');
    expect(boost.low).toBeGreaterThan(boost.atRelease - 25);
    // (released just under Mach 1, the boost is pushing through the drag rise)
    expect(boost.m.speed).toBeGreaterThan(boost.atRelease + 15);
    expect(boost.yMax).toBeLessThan(1530);
    // Let go of X and the throttle holds what's left (not a coast to idle)
    const coast = fly('none');
    expect(coast.m.speed).toBeGreaterThan(250);
    expect(coast.m.speedCmd).toBeGreaterThan(250);
  });

  it('swings its speed round onto the aim when it pushes off the other way, paying for the turn', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1500, 0);
    m.vel.set(0, 0, 400);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 270;
    m.airT = 5;
    let atRelease = 0;
    let low = Infinity;
    let swung = 0;
    let reversed = Infinity;
    // (the brakes top out at 6 g: a long enough flare to come out subsonic)
    run(m, 8, (i, t) => {
      i.aim.set(0, 0, t < 1 ? 1 : -1);
      i.brake = t >= 1 && t < 3;
      i.boost = t < 1 || t >= 3;
      if (t < 3) atRelease = m.speed;
      else low = Math.min(low, m.speed);
      if (t >= 3 && reversed === Infinity && m.vel.z < -0.98 * m.speed) reversed = t - 3;
      swung = Math.max(swung, m.swing);
    });
    expect(swung).toBeGreaterThan(0.9);
    // Carried round, not killed and rebuilt — but the carve costs speed
    expect(low).toBeGreaterThan(atRelease * 0.45);
    expect(low).toBeLessThan(atRelease * 0.75);
    // An arc of seconds at speed, not a flick
    expect(reversed).toBeGreaterThan(2);
    expect(reversed).toBeLessThan(4.5);
    // …and the boost earns the speed back on the new line
    expect(m.vel.z).toBeLessThan(-0.98 * m.speed);
    expect(m.speed).toBeGreaterThan(low + 60);
    expect(Math.abs(m.pos.y - 1500)).toBeLessThan(60);
  });

  it('carves a flat-out reversal under the swing g limit, the meter reading no more than a hard pull', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1500, 0);
    m.vel.set(0, 0, 420);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 270;
    m.airT = 5;
    const dt = 1 / 120;
    const prev = new THREE.Vector3().copy(m.vel);
    const acc = new THREE.Vector3();
    let peak = 0;
    let gMax = -Infinity;
    let gMin = Infinity;
    let swung = 0;
    run(m, 7, (i, t) => {
      i.aim.set(0, 0, t < 1 ? 1 : -1);
      i.boost = true;
      // Acceleration square to the travel, last step
      acc.copy(m.vel).sub(prev).divideScalar(dt);
      prev.copy(m.vel);
      acc.addScaledVector(m.vel, -acc.dot(m.vel) / m.vel.lengthSq());
      if (t > 1) {
        peak = Math.max(peak, acc.length() / 9.81);
        gMax = Math.max(gMax, m.gLoad);
        gMin = Math.min(gMin, m.gLoad);
      }
      swung = Math.max(swung, m.swing);
    });
    expect(swung).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(24);
    expect(gMax).toBeLessThan(16);
    expect(gMin).toBeGreaterThan(-1);
    expect(m.vel.z).toBeLessThan(-0.98 * m.speed);
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

  it('takes a terminal fall straight into the ground as a hero landing', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 400, 0);
    m.vel.set(0, -72, 0);
    m.grounded = false;
    m.airT = 5;
    let contact = 'none';
    let touch = 0;
    run(m, 10, (i) => {
      i.vertical = -1;
      if (m.contact !== 'none' && contact === 'none') {
        contact = m.contact;
        touch = m.impactSpeed;
      }
    });
    expect(contact).toBe('heroLanding');
    expect(touch).toBeGreaterThan(40); // no flight computer braking it
  });

  it('flies an aileron roll at about 1 g: the meter swings +1 → −1, the path stays put', () => {
    const m = new FlightModel(flat());
    m.pos.set(0, 1000, 0);
    m.vel.set(0, 0, 200);
    m.grounded = false;
    m.flightness = 1;
    m.posture = 1.42;
    m.speedCmd = 200;
    run(m, 1.5, (i) => i.aim.set(0, 0, 1));
    let gMax = -Infinity;
    let gMin = Infinity;
    const y0 = m.pos.y;
    run(m, 1.9, (i) => {
      i.aim.set(0, 0, 1);
      i.lateral = 1;
      gMax = Math.max(gMax, m.gLoad);
      gMin = Math.min(gMin, m.gLoad);
    });
    expect(gMax).toBeLessThan(1.6);
    expect(gMin).toBeLessThan(-0.3);
    expect(Math.abs(m.pos.y - y0)).toBeLessThan(15);
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

  it('turns onto an aim far round behind it head up, never over the top onto its back', () => {
    // Body roll off the horizon about its long axis (rad): past π/2 it's on its back
    const roll = (m: FlightModel) => {
      const a = m.thrustAxis();
      if (Math.abs(a.y) > 0.97) return 0;
      const level = new THREE.Vector3(0, 1, 0).addScaledVector(a, -a.y).normalize();
      return new THREE.Vector3(0, 0, -1).applyQuaternion(m.bodyQuaternion()).angleTo(level);
    };
    const aims = [
      new THREE.Vector3(0, Math.sin(1.05), -Math.cos(1.05)), // astern, 60° up
      new THREE.Vector3(0, Math.sin(0.5), -Math.cos(0.5)), // astern, 30° up
      new THREE.Vector3(0, -Math.sin(1.05), -Math.cos(1.05)), // astern, 60° down
      new THREE.Vector3(0.17, 0.98, -0.1), // up past the vertical
    ];
    for (const [speed, boost] of [[60, false], [120, false], [250, false], [450, true]] as const) {
      for (const aim of aims) {
        const m = new FlightModel(flat());
        m.pos.set(0, 3000, 0);
        m.vel.set(0, 0, speed);
        m.grounded = false;
        m.flightness = 1;
        m.posture = 1.42;
        m.speedCmd = Math.min(speed, 270);
        run(m, 1, (i) => i.aim.set(0, 0, 1));
        let worst = 0;
        run(m, 8, (i) => {
          i.aim.copy(aim).normalize();
          i.boost = boost;
          worst = Math.max(worst, roll(m));
        });
        expect(THREE.MathUtils.radToDeg(worst)).toBeLessThan(95);
        // and it still gets there
        expect(THREE.MathUtils.radToDeg(m.thrustAxis().angleTo(aim.clone().normalize()))).toBeLessThan(8);
      }
    }
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

  it('stands upright for the unibeam out of flight, whatever the aim', () => {
    for (const aimY of [-0.35, 0, 0.35]) {
      const m = new FlightModel(flat());
      m.pos.set(0, 300, 0);
      m.grounded = false;
      m.vel.set(0, 0, 150);
      m.flightness = 1;
      m.posture = 1.42;
      m.speedCmd = 150;
      // Stance held through the charge and on through the shot
      let worst = 0;
      run(m, 4, (i, t) => {
        i.aim.set(0, aimY, 1).normalize();
        i.stance = true;
        if (t > 1) worst = Math.max(worst, new THREE.Vector3(0, 1, 0).applyQuaternion(m.bodyQuaternion()).angleTo(new THREE.Vector3(0, 1, 0)));
      });
      // Still shedding the speed, but on the boots' vectoring, not a lean
      expect(m.speed).toBeLessThan(110);
      expect(THREE.MathUtils.radToDeg(worst)).toBeLessThan(5);
    }
  });

  it('turns the stance onto the aim, not its reciprocal, even on the boost', () => {
    for (const boost of [false, true]) {
      for (const aim of [new THREE.Vector3(1, 0, 0.2), new THREE.Vector3(0.1, 0, -1)]) {
        const m = new FlightModel(flat());
        m.pos.set(0, 300, 0);
        m.grounded = false;
        m.vel.set(0, 0, 160);
        m.flightness = 1;
        m.posture = 1.42;
        m.speedCmd = 160;
        let wrongWay = 0;
        run(m, 3, (i) => {
          i.aim.copy(aim).normalize();
          i.stance = true;
          i.boost = boost;
          // (the turn never starts off the far way round)
          const err = Math.atan2(Math.sin(Math.atan2(aim.x, aim.z) - m.heading), Math.cos(Math.atan2(aim.x, aim.z) - m.heading));
          wrongWay = Math.max(wrongWay, Math.abs(err) - Math.PI * 0.99);
        });
        const off = Math.abs(Math.atan2(aim.x, aim.z) - m.heading) % (Math.PI * 2);
        expect(THREE.MathUtils.radToDeg(Math.min(off, Math.PI * 2 - off))).toBeLessThan(3);
        expect(wrongWay).toBeLessThan(0.05);
      }
    }
  });
});
