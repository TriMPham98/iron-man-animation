import { describe, expect, it } from 'vitest';
import { SEQUENCE_SEED_DURATION } from '../animation/assemblyTimeline';
import {
  BINARY_INTERFACE_CLIP,
  BINARY_INTERFACE_CUES,
  BINARY_INTERFACE_DURATION,
  BINARY_INTERFACE_FINAL_HOLD_PAD,
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
    // Includes a 7-blip 1:1 stretch (~14.9–15.8s seed); still far below onset spam.
    expect(BINARY_INTERFACE_CUES.length).toBeGreaterThanOrEqual(12);
    expect(BINARY_INTERFACE_CUES.length).toBeLessThanOrEqual(24);
  });

  it('maps seven lines to the 14.93–15.82s blip train', () => {
    const seed0 = BINARY_INTERFACE_CLIP.seedStart;
    const inBand = BINARY_INTERFACE_CUES.filter((c) => {
      const seed = seed0 + c.t;
      return seed >= 14.93 - 0.02 && seed <= 15.82 + 0.02;
    });
    expect(inBand).toHaveLength(7);
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

  it('ends on AT YOUR SERVICE, SIR', () => {
    const last = BINARY_INTERFACE_CUES[BINARY_INTERFACE_CUES.length - 1]!;
    expect(last.line).toBe('AT YOUR SERVICE, SIR');
  });

  it('keeps IMPORTING PREFERENCES mid-stream', () => {
    expect(
      BINARY_INTERFACE_CUES.some((c) => c.line === 'IMPORTING PREFERENCES…'),
    ).toBe(true);
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
      'AT YOUR SERVICE, SIR',
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

  it('holds AT YOUR SERVICE, SIR through sequence end and pad', () => {
    const last = BINARY_INTERFACE_CUES[BINARY_INTERFACE_CUES.length - 1]!;
    const fireAt = BINARY_INTERFACE_CLIP.seedStart + last.t;
    expect(cueAtSeedTime(fireAt)?.line).toBe('AT YOUR SERVICE, SIR');
    // Past the audio crop (~18.0s) but still inside the 18.5s seed tail
    expect(cueAtSeedTime(18.2)?.line).toBe('AT YOUR SERVICE, SIR');
    expect(cueAtSeedTime(SEQUENCE_SEED_DURATION)?.line).toBe(
      'AT YOUR SERVICE, SIR',
    );
    expect(
      cueAtSeedTime(
        SEQUENCE_SEED_DURATION + BINARY_INTERFACE_FINAL_HOLD_PAD - 0.05,
      )?.line,
    ).toBe('AT YOUR SERVICE, SIR');
  });

  it('clears after the final hold pad', () => {
    expect(
      cueAtSeedTime(
        SEQUENCE_SEED_DURATION + BINARY_INTERFACE_FINAL_HOLD_PAD + 0.1,
      ),
    ).toBeNull();
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
