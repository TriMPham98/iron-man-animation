import { describe, expect, it } from 'vitest';
import {
  AUDIO_SEED_ORIGIN,
  audioTimelineOffset,
  integrityProgressAtTime,
  OPENING_HOLD,
  SEQUENCE_SEED_DURATION,
  sequenceGsapDuration,
  timeAtIntegrityProgress,
} from './assemblyTimeline';

describe('OPENING_HOLD + audioTimelineOffset', () => {
  it('pre-roll stays under 1.2s before the first SFX', () => {
    expect(OPENING_HOLD).toBeGreaterThan(0.5);
    expect(OPENING_HOLD).toBeLessThan(1.2);
  });

  it('keeps SFX on the pre-hold seed clock', () => {
    expect(audioTimelineOffset()).toBeCloseTo(
      OPENING_HOLD - AUDIO_SEED_ORIGIN,
      5,
    );
    expect(audioTimelineOffset()).toBeGreaterThan(0);
  });
});

describe('SEQUENCE_SEED_DURATION (18.5s director span)', () => {
  it('maps seed end to GSAP end via the hangar offset', () => {
    expect(SEQUENCE_SEED_DURATION).toBe(18.5);
    expect(sequenceGsapDuration()).toBeCloseTo(
      SEQUENCE_SEED_DURATION + audioTimelineOffset(),
      5,
    );
  });
});

describe('integrityProgressAtTime (wave-paced bar)', () => {
  const starts = [1, 2, 3, 4, 5];
  const end = 10;

  it('stays at 0 through the hangar hold before the first wave', () => {
    expect(integrityProgressAtTime(0, starts, end)).toBe(0);
    expect(integrityProgressAtTime(0.99, starts, end)).toBe(0);
  });

  it('matches pipeline dots: wave i start ≈ i/n done', () => {
    const n = starts.length;
    expect(integrityProgressAtTime(1, starts, end)).toBeCloseTo(0 / n, 5);
    expect(integrityProgressAtTime(2, starts, end)).toBeCloseTo(1 / n, 5);
    expect(integrityProgressAtTime(3, starts, end)).toBeCloseTo(2 / n, 5);
    // Midway through wave index 2 (starts[2]=3 → starts[3]=4)
    expect(integrityProgressAtTime(3.5, starts, end)).toBeCloseTo(2.5 / n, 5);
  });

  it('reaches 1 at systems online', () => {
    expect(integrityProgressAtTime(end, starts, end)).toBe(1);
    expect(integrityProgressAtTime(end + 2, starts, end)).toBe(1);
  });

  it('round-trips with timeAtIntegrityProgress', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      const t = timeAtIntegrityProgress(p, starts, end);
      const back = integrityProgressAtTime(t, starts, end);
      expect(back).toBeCloseTo(Math.min(p, 0.999) >= 0.999 ? 1 : p, 4);
    }
  });
});
