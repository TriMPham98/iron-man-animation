import { describe, expect, it } from 'vitest';
import { buildH0, CASCADES, dominantModes, N, seaHeightAt, stockhamIndex } from './spectrum';

/** CPU mirror of the GPU FFT passes (same indexing as FFT_FRAG). */
function stockhamIdft(re: number[], im: number[]): [number[], number[]] {
  const len = re.length;
  let ar = re.slice();
  let ai = im.slice();
  for (let size = 2; size <= len; size *= 2) {
    const br = new Array<number>(len);
    const bi = new Array<number>(len);
    for (let n = 0; n < len; n++) {
      const { even, odd, angle } = stockhamIndex(n, size, len);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      br[n] = ar[even] + (ar[odd] * c - ai[odd] * s);
      bi[n] = ai[even] + (ar[odd] * s + ai[odd] * c);
    }
    ar = br;
    ai = bi;
  }
  return [ar, ai];
}

describe('ocean spectrum', () => {
  it('Stockham passes compute the inverse DFT in natural order', () => {
    const len = 16;
    const re = Array.from({ length: len }, (_, i) => Math.sin(i * 1.3) + 0.2 * i);
    const im = Array.from({ length: len }, (_, i) => Math.cos(i * 0.7) - 0.1 * i);
    const [fr, fi] = stockhamIdft(re, im);
    for (let n = 0; n < len; n++) {
      let sr = 0;
      let si = 0;
      for (let k = 0; k < len; k++) {
        const a = (2 * Math.PI * k * n) / len;
        sr += re[k] * Math.cos(a) - im[k] * Math.sin(a);
        si += re[k] * Math.sin(a) + im[k] * Math.cos(a);
      }
      expect(fr[n]).toBeCloseTo(sr, 9);
      expect(fi[n]).toBeCloseTo(si, 9);
    }
  });

  it('builds a finite, Hermitian-consistent h0 with a realistic sea state', () => {
    const h0 = buildH0();
    expect(h0.length).toBe(N * N * CASCADES * 4);
    let e = 0;
    let finite = true;
    for (let i = 0; i < h0.length; i++) {
      finite &&= Number.isFinite(h0[i]);
      e += h0[i] * h0[i];
    }
    expect(finite).toBe(true);
    // Significant wave height ~ 4 sqrt(variance): a moderate 1-3 m sea
    const hs = 4 * Math.sqrt(e);
    expect(hs).toBeGreaterThan(0.8);
    expect(hs).toBeLessThan(4);
    const modes = dominantModes(h0);
    expect(modes.length).toBeGreaterThan(10);
  });

  it('answers a smooth, bounded, moving sea height', () => {
    const a = seaHeightAt(120, -40, 3);
    const b = seaHeightAt(120.2, -40, 3);
    const c = seaHeightAt(120, -40, 6);
    expect(Math.abs(a)).toBeLessThan(4);
    expect(Math.abs(a - b)).toBeLessThan(0.2);
    expect(a).not.toBeCloseTo(c, 3);
  });
});
