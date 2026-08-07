import { describe, expect, it } from 'vitest';
import { SEQUENCE_SEED_DURATION } from '../animation/assemblyTimeline';
import {
  BINARY_INTERFACE_CLIP,
  BINARY_INTERFACE_CUES,
  BINARY_INTERFACE_DURATION,
  binaryInterfaceProgress,
  cueAtCropTime,
  cueAtSeedTime,
} from './binaryInterfaceCues';

describe('BINARY_INTERFACE_CLIP (seed v5)', () => {
  it('matches the promoted director crop window', () => {
    expect(BINARY_INTERFACE_CLIP.seedStart).toBe(12.075);
    expect(BINARY_INTERFACE_CLIP.cropIn).toBe(0);
    expect(BINARY_INTERFACE_CLIP.cropOut).toBe(5.925);
    expect(BINARY_INTERFACE_DURATION).toBeCloseTo(5.925, 5);
  });
});

describe('BINARY_INTERFACE_CUES', () => {
  it('sits mid-density (between full onset spam and one-per-phrase)', () => {
    // Original was ~28; sparse was 6 — target a readable middle.
    expect(BINARY_INTERFACE_CUES.length).toBeGreaterThanOrEqual(12);
    expect(BINARY_INTERFACE_CUES.length).toBeLessThanOrEqual(18);
  });

  it('is sorted by crop time and stays inside the crop', () => {
    let prev = -1;
    for (const c of BINARY_INTERFACE_CUES) {
      expect(c.t).toBeGreaterThanOrEqual(0);
      expect(c.t).toBeLessThan(BINARY_INTERFACE_DURATION);
      expect(c.t).toBeGreaterThanOrEqual(prev);
      expect(c.line.trim().length).toBeGreaterThan(0);
      prev = c.t;
    }
  });

  it('ends on AWAITING ORDERS, SIR', () => {
    const last = BINARY_INTERFACE_CUES[BINARY_INTERFACE_CUES.length - 1]!;
    expect(last.line).toBe('AWAITING ORDERS, SIR');
  });
});

describe('cueAtCropTime', () => {
  it('returns null before the first onset', () => {
    expect(cueAtCropTime(0)).toBeNull();
    expect(cueAtCropTime(0.05)).toBeNull();
  });

  it('holds the latest cue until the next onset', () => {
    const first = BINARY_INTERFACE_CUES[0]!;
    const second = BINARY_INTERFACE_CUES[1]!;
    expect(cueAtCropTime(first.t)?.line).toBe(first.line);
    expect(cueAtCropTime((first.t + second.t) / 2)?.line).toBe(first.line);
    expect(cueAtCropTime(second.t)?.line).toBe(second.line);
  });

  it('returns the final cue near crop end', () => {
    expect(cueAtCropTime(BINARY_INTERFACE_DURATION - 0.01)?.line).toBe(
      'AWAITING ORDERS, SIR',
    );
  });
});

describe('cueAtSeedTime', () => {
  it('is silent before the clip window', () => {
    expect(cueAtSeedTime(0)).toBeNull();
    expect(cueAtSeedTime(12.0)).toBeNull();
  });

  it('maps seed time onto crop-relative cues', () => {
    const first = BINARY_INTERFACE_CUES[0]!;
    const seedT = BINARY_INTERFACE_CLIP.seedStart + first.t;
    expect(cueAtSeedTime(seedT)?.line).toBe(first.line);
  });

  it('holds AWAITING ORDERS, SIR through sequence end', () => {
    const last = BINARY_INTERFACE_CUES[BINARY_INTERFACE_CUES.length - 1]!;
    const fireAt = BINARY_INTERFACE_CLIP.seedStart + last.t;
    expect(cueAtSeedTime(fireAt)?.line).toBe('AWAITING ORDERS, SIR');
    // Past the audio crop (~18.0s) but still inside the 18.5s seed tail
    expect(cueAtSeedTime(18.2)?.line).toBe('AWAITING ORDERS, SIR');
    expect(cueAtSeedTime(SEQUENCE_SEED_DURATION)?.line).toBe(
      'AWAITING ORDERS, SIR',
    );
  });

  it('clears after the animation ends', () => {
    expect(cueAtSeedTime(SEQUENCE_SEED_DURATION + 0.2)).toBeNull();
  });
});

describe('binaryInterfaceProgress', () => {
  it('clamps 0–1 across the crop', () => {
    expect(binaryInterfaceProgress(0)).toBe(0);
    expect(binaryInterfaceProgress(BINARY_INTERFACE_CLIP.seedStart)).toBe(0);
    expect(
      binaryInterfaceProgress(
        BINARY_INTERFACE_CLIP.seedStart + BINARY_INTERFACE_DURATION / 2,
      ),
    ).toBeCloseTo(0.5, 5);
    expect(
      binaryInterfaceProgress(
        BINARY_INTERFACE_CLIP.seedStart + BINARY_INTERFACE_DURATION,
      ),
    ).toBe(1);
  });
});
