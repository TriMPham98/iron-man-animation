import { describe, expect, it } from 'vitest';
import {
  collectSnapTargets,
  snapClipStart,
  snapTime,
  type SnapTarget,
} from './snapping';
import type { TimelineClip } from './timelineModel';

function clip(over: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'c1',
    soundId: 'impact',
    label: 'Impact',
    file: 'impact.mp3',
    start: 0,
    cropIn: 0,
    cropOut: 1,
    sourceDuration: 1,
    lane: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    pitch: 1,
    ...over,
  };
}

describe('collectSnapTargets', () => {
  it('includes both timeline bounds', () => {
    const t = collectSnapTargets({ clips: [], assemblyDuration: 30 });
    const bounds = t.filter((x) => x.kind === 'bounds').map((x) => x.time);
    expect(bounds).toContain(0);
    expect(bounds).toContain(30);
  });

  it('walks the grid without drifting on fractional steps', () => {
    const t = collectSnapTargets({
      clips: [],
      assemblyDuration: 3,
      gridStep: 0.1,
    });
    const grid = t.filter((x) => x.kind === 'grid').map((x) => x.time);
    // Naive `t += 0.1` accumulates float error; multiplication does not.
    expect(grid[2]).toBeCloseTo(0.3, 12);
    expect(grid.some((x) => Math.abs(x - 2.9) < 1e-9)).toBe(true);
    expect(grid.every((x) => x < 3)).toBe(true);
  });

  it('omits grid targets when no step is given', () => {
    const t = collectSnapTargets({ clips: [], assemblyDuration: 30 });
    expect(t.some((x) => x.kind === 'grid')).toBe(false);
  });

  it('emits start and end for each clip', () => {
    const t = collectSnapTargets({
      clips: [clip({ start: 2, cropIn: 0, cropOut: 1.5 })],
    });
    const times = t.filter((x) => x.kind === 'clip').map((x) => x.time);
    expect(times).toEqual([2, 3.5]);
  });

  it('excludes the dragged clip from its own targets', () => {
    const clips = [clip({ id: 'a', start: 1 }), clip({ id: 'b', start: 5 })];
    const t = collectSnapTargets({ clips, excludeId: 'a' });
    const times = t.filter((x) => x.kind === 'clip').map((x) => x.time);
    expect(times).toEqual([5, 6]);
  });

  it('includes the playhead only when non-negative', () => {
    const withHead = collectSnapTargets({ clips: [], playheadSec: 4 });
    expect(withHead.some((x) => x.kind === 'playhead')).toBe(true);
    const without = collectSnapTargets({ clips: [], playheadSec: -1 });
    expect(without.some((x) => x.kind === 'playhead')).toBe(false);
  });
});

describe('snapTime', () => {
  const targets: SnapTarget[] = [
    { time: 1, kind: 'grid' },
    { time: 2, kind: 'grid' },
    { time: 5, kind: 'clip' },
  ];

  it('snaps to the nearest target inside the tolerance', () => {
    expect(snapTime(1.04, targets, 0.1)).toEqual({
      time: 1,
      target: { time: 1, kind: 'grid' },
    });
  });

  it('leaves the value alone when nothing is in range', () => {
    expect(snapTime(3.5, targets, 0.1)).toEqual({ time: 3.5, target: null });
  });

  it('is a no-op at zero tolerance (the Alt-bypass path)', () => {
    expect(snapTime(1.001, targets, 0)).toEqual({ time: 1.001, target: null });
  });

  it('prefers the playhead over an equidistant grid tick', () => {
    const tied: SnapTarget[] = [
      { time: 1, kind: 'grid' },
      { time: 1, kind: 'playhead' },
    ];
    expect(snapTime(1.05, tied, 0.1).target?.kind).toBe('playhead');
  });

  it('prefers a clip edge over an equidistant grid tick', () => {
    const tied: SnapTarget[] = [
      { time: 4, kind: 'grid' },
      { time: 4, kind: 'clip' },
    ];
    expect(snapTime(3.95, tied, 0.1).target?.kind).toBe('clip');
  });
});

describe('snapClipStart', () => {
  const targets: SnapTarget[] = [
    { time: 0, kind: 'bounds' },
    { time: 4, kind: 'clip' },
    { time: 10, kind: 'clip' },
  ];

  it('snaps by the leading edge when the head is closer', () => {
    const r = snapClipStart(3.95, 2, targets, 0.1);
    expect(r.time).toBeCloseTo(4, 6);
    expect(r.target?.time).toBe(4);
  });

  it('snaps by the trailing edge so clips butt together', () => {
    // start 1.95 + dur 2 = 3.95 tail, within 0.1 of the clip edge at 4
    const r = snapClipStart(1.95, 2, targets, 0.1);
    expect(r.time).toBeCloseTo(2, 6);
    expect(r.target?.time).toBe(4);
  });

  it('picks the closer of the two edges when both are in range', () => {
    // head 3.92 is 0.08 from the target at 4; tail 4.02 is only 0.02 → tail
    const r = snapClipStart(3.92, 0.1, targets, 0.09);
    expect(r.time).toBeCloseTo(3.9, 6);
    expect(r.target?.time).toBe(4);
  });

  it('never produces a negative start when snapping the tail', () => {
    const r = snapClipStart(0.1, 10, [{ time: 4, kind: 'clip' }], 6);
    expect(r.time).toBeGreaterThanOrEqual(0);
  });

  it('returns the raw start when neither edge is in range', () => {
    const r = snapClipStart(6, 1, targets, 0.1);
    expect(r).toEqual({ time: 6, target: null });
  });
});
