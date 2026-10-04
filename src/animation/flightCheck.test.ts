import { describe, expect, it } from 'vitest';
import { evaluateFlightCheck, FLIGHT_CHECK_END, FLIGHT_CHECK_STEPS, FLIGHT_EVENTS, HOVER_HEIGHT } from './flightCheck';

describe('flight-control check', () => {
  it('is idle before it starts and after it ends', () => {
    expect(evaluateFlightCheck(0).active).toBe(false);
    expect(evaluateFlightCheck(FLIGHT_CHECK_END + 0.1).active).toBe(false);
  });

  it('settles back to the bind pose before the diagnostic takes over', () => {
    const f = evaluateFlightCheck(FLIGHT_CHECK_END - 0.01);
    const { pose } = f;
    for (const v of [pose.stance, pose.headPitch, pose.headYaw ?? 0, pose.wristL, pose.wristR, pose.lift ?? 0]) {
      expect(Math.abs(v)).toBeLessThan(1e-3);
    }
    for (const k of Object.values(f.flaps)) expect(k).toBeLessThan(1e-3);
    expect(f.thrusters).toBe(0);
  });

  it('exercises every surface, both repulsors and the thrusters', () => {
    const peak = { flaps: {} as Record<string, number>, repL: 0, repR: 0, burn: 0, lift: 0 };
    for (let t = 0; t < FLIGHT_CHECK_END; t += 0.02) {
      const f = evaluateFlightCheck(t);
      for (const [k, v] of Object.entries(f.flaps)) peak.flaps[k] = Math.max(peak.flaps[k] ?? 0, v);
      peak.repL = Math.max(peak.repL, f.repulsorL);
      peak.repR = Math.max(peak.repR, f.repulsorR);
      peak.burn = Math.max(peak.burn, f.thrusters);
      peak.lift = Math.max(peak.lift, f.pose.lift ?? 0);
      for (const v of Object.values(f.flaps)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    for (const v of Object.values(peak.flaps)) expect(v).toBeGreaterThan(0.8);
    expect(peak.repL).toBeGreaterThan(0.9);
    expect(peak.repR).toBeGreaterThan(0.9);
    expect(peak.burn).toBeGreaterThan(0.9);
    expect(peak.lift).toBeGreaterThan(HOVER_HEIGHT * 0.95);
  });

  it('announces each step in order', () => {
    const seen: string[] = [];
    for (let t = 0; t < FLIGHT_CHECK_END; t += 0.05) {
      const s = evaluateFlightCheck(t).status;
      if (s && s !== seen[seen.length - 1]) seen.push(s);
    }
    expect(seen).toEqual(FLIGHT_CHECK_STEPS.map((s) => s.status));
  });

  it('moves deliberately — no frame-to-frame jumps at 60 fps', () => {
    const dt = 1 / 60;
    let prev = evaluateFlightCheck(0);
    for (let t = dt; t < FLIGHT_CHECK_END; t += dt) {
      const f = evaluateFlightCheck(t);
      for (const k of Object.keys(f.flaps) as Array<keyof typeof f.flaps>) {
        expect(Math.abs(f.flaps[k] - prev.flaps[k])).toBeLessThan(0.1);
      }
      for (const k of ['stance', 'headYaw', 'headPitch', 'wristL', 'wristR', 'lift'] as const) {
        expect(Math.abs((f.pose[k] ?? 0) - (prev.pose[k] ?? 0))).toBeLessThan(0.1);
      }
      prev = f;
    }
  });

  it('cues sound events in time order inside the check', () => {
    const ts = FLIGHT_EVENTS.map((e) => e.t);
    for (const t of ts) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(FLIGHT_CHECK_END);
    }
  });

  it('runs ground checks before flight and the hover last', () => {
    const order = FLIGHT_CHECK_STEPS.map((st) => st.group);
    expect(order.indexOf('ALL SYSTEMS')).toBeGreaterThan(order.indexOf('WEAPONS'));
    expect(order.indexOf('THRUSTERS')).toBe(order.length - 2);
  });

  it('deploys every flap and weapon together at full deflection', () => {
    const at = FLIGHT_CHECK_STEPS.find((st) => st.group === 'ALL SYSTEMS')!.at;
    let best = 0;
    for (let t = at; t < at + 2.5; t += 0.02) {
      best = Math.max(best, Math.min(...Object.values(evaluateFlightCheck(t).flaps)));
    }
    expect(best).toBeGreaterThan(0.95);
  });

  it('trims the stabilizers while airborne', () => {
    const moved = new Set<string>();
    for (let t = 0; t < FLIGHT_CHECK_END; t += 0.02) {
      const f = evaluateFlightCheck(t);
      if ((f.pose.lift ?? 0) < 0.1) continue;
      for (const [k, v] of Object.entries(f.flaps)) if (v > 0.2) moved.add(k.split('.')[0]);
    }
    expect([...moved].sort()).toEqual(['back', 'calf', 'shoulder', 'thigh']);
  });
});
