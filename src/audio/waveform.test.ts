import { describe, expect, it } from 'vitest';
import { computePeaksFromBuffer, peaksForRegion } from './waveform';

/** Minimal AudioBuffer stand-in for peak computation tests. */
function fakeBuffer(samples: Float32Array, sampleRate = 44100): AudioBuffer {
  return {
    numberOfChannels: 1,
    length: samples.length,
    sampleRate,
    duration: samples.length / sampleRate,
    getChannelData: (ch: number) => {
      if (ch !== 0) throw new Error('channel');
      return samples;
    },
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}

describe('peaksForRegion', () => {
  it('maps crop window into outBins without leaving empty columns', () => {
    const full = new Float32Array([0.1, 0.5, 1, 0.2, 0.8, 0.3, 0.9, 0.4]);
    const out = peaksForRegion(full, 8, 2, 6, 4);
    expect(out).toHaveLength(4);
    expect(Math.max(...out)).toBeGreaterThan(0);
  });

  it('clamps inverted or out-of-range crops', () => {
    const full = new Float32Array([1, 0.5, 0.25, 0.1]);
    const out = peaksForRegion(full, 4, -1, 99, 4);
    expect(out).toHaveLength(4);
    expect(out[0]).toBeCloseTo(1, 5);
  });
});

describe('computePeaksFromBuffer', () => {
  it('normalizes so the loudest bin is 1', () => {
    const samples = new Float32Array(1000);
    samples[100] = 0.25;
    samples[500] = -0.5;
    samples[800] = 0.1;
    const peaks = computePeaksFromBuffer(fakeBuffer(samples), 10);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
    expect(peaks.some((p) => p > 0)).toBe(true);
  });
});
