import { describe, expect, it } from 'vitest';
import { ease, monotoneCubic, sampleTrack } from './keyframes';

describe('sampleTrack', () => {
  const tr = [
    { t: 1, v: 0 },
    { t: 2, v: 10, ease: 'linear' as const },
    { t: 3, v: 0, ease: 'in2' as const },
  ];
  it('holds the ends and interpolates with the segment ease', () => {
    expect(sampleTrack(tr, 0)).toBe(0);
    expect(sampleTrack(tr, 1.5)).toBeCloseTo(5);
    expect(sampleTrack(tr, 2.5)).toBeCloseTo(10 - 10 * 0.25);
    expect(sampleTrack(tr, 9)).toBe(0);
  });
  it('eases map 0→0 and 1→1', () => {
    for (const e of ['in2', 'out3', 'inOut3', 'in4', 'outBack'] as const) {
      expect(ease(e, 0)).toBeCloseTo(0);
      expect(ease(e, 1)).toBeCloseTo(1);
    }
  });
});

describe('monotoneCubic', () => {
  it('passes through keys without overshoot', () => {
    const ts = [0, 1, 2, 3];
    const vs = [0, 1, 1, 5];
    for (let i = 0; i < ts.length; i++) expect(monotoneCubic(ts, vs, ts[i])).toBeCloseTo(vs[i]);
    for (let t = 1; t <= 2; t += 0.05) expect(monotoneCubic(ts, vs, t)).toBeCloseTo(1, 6);
    for (let t = 0; t <= 3; t += 0.05) {
      const v = monotoneCubic(ts, vs, t);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(5 + 1e-9);
    }
  });
});
