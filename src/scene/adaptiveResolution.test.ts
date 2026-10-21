import { describe, expect, it } from 'vitest';
import { createAdaptiveResolution } from './adaptiveResolution';

const fakeRenderer = (dpr: number) => {
  const r = {
    dpr,
    changes: 0,
    getPixelRatio: () => r.dpr,
    setPixelRatio: (v: number) => {
      r.dpr = v;
      r.changes++;
    },
  };
  return r;
};

/** Feed `seconds` of frames, each `ms(dpr)` long (a 60 Hz screen rounds up to vsync). */
const run = (a: ReturnType<typeof createAdaptiveResolution>, seconds: number, ms: (dpr: number) => number) => {
  let t = 0;
  while (t < seconds) {
    const d = ms(a.pixelRatio) / 1000;
    a.update(d);
    t += d;
  }
};
const vsync60 = (gpuMs: number) => Math.ceil(gpuMs / 16.667) * 16.667;

describe('createAdaptiveResolution', () => {
  it('sheds pixels when frames run long', () => {
    const r = fakeRenderer(1.5);
    const a = createAdaptiveResolution(r, () => {}, { min: 0.7 });
    run(a, 6, () => 33.3);
    expect(a.pixelRatio).toBeLessThan(1.5);
  });

  it('gives resolution back on a 60 Hz screen once frames hold vsync', () => {
    const r = fakeRenderer(1.5);
    const a = createAdaptiveResolution(r, () => {}, { min: 0.7 });
    // A heavy moment drops it...
    run(a, 6, () => 33.3);
    const low = a.pixelRatio;
    expect(low).toBeLessThan(1.5);
    // ...then the load goes and every frame is on vsync again
    run(a, 60, () => 16.667);
    expect(a.pixelRatio).toBeCloseTo(1.5);
    expect(low).toBeLessThan(a.pixelRatio);
  });

  it('undoes a step up that drops frames, and backs off before trying again', () => {
    const r = fakeRenderer(1);
    const a = createAdaptiveResolution(r, () => {}, { min: 0.7, max: 1.5 });
    // Holds 60 at 1.0, misses vsync above it
    const gpu = (dpr: number) => vsync60(dpr > 1.05 ? 18 : 12);
    run(a, 120, gpu);
    expect(a.pixelRatio).toBeCloseTo(1);
    // Each failed probe is two changes; backing off keeps them rare
    // (3 + 6 + 12 + 24 + 48 s of waiting covers the two minutes)
    expect(r.changes).toBeLessThanOrEqual(10);
  });

  it('judges headroom against a 120 Hz refresh too', () => {
    const r = fakeRenderer(1);
    const a = createAdaptiveResolution(r, () => {}, { min: 0.7, max: 1.5 });
    // 60 fps on a 120 Hz screen: fine, not headroom
    let n = 0;
    run(a, 20, () => (++n % 30 === 0 ? 8.333 : 16.667));
    expect(a.pixelRatio).toBeCloseTo(1);
    run(a, 30, () => 8.333);
    expect(a.pixelRatio).toBeCloseTo(1.5);
  });

  it('jumps to a set ratio within its range', () => {
    const r = fakeRenderer(1.5);
    const a = createAdaptiveResolution(r, () => {}, { min: 0.7 });
    a.set(0.9);
    expect(r.dpr).toBeCloseTo(0.9);
    a.set(3);
    expect(r.dpr).toBeCloseTo(1.5);
  });
});
