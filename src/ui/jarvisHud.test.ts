import { describe, expect, it } from 'vitest';
import {
  appendLogLine,
  isPieceWave,
  lampsForProgress,
  waveNodeStates,
  JARVIS_DISMISS_MS,
  JARVIS_LOG_CAP,
} from './jarvisHud';

describe('waveNodeStates', () => {
  it('marks all idle when no active wave', () => {
    const s = waveNodeStates(null, false);
    expect(s.boots).toBe('idle');
    expect(s.power).toBe('idle');
  });

  it('marks prior waves done and current active', () => {
    const s = waveNodeStates('torso', false);
    expect(s.boots).toBe('done');
    expect(s.hips).toBe('done');
    expect(s.torso).toBe('active');
    expect(s.shoulders).toBe('idle');
    expect(s.power).toBe('idle');
  });

  it('marks all done when complete', () => {
    const s = waveNodeStates('helmet', true);
    expect(s.boots).toBe('done');
    expect(s.power).toBe('done');
  });
});

describe('appendLogLine', () => {
  it('de-dupes consecutive identical lines', () => {
    const a = appendLogLine([], 'HELLO');
    const b = appendLogLine(a, 'HELLO');
    expect(b).toEqual(['HELLO']);
  });

  it('caps buffer length', () => {
    let lines: string[] = [];
    for (let i = 0; i < JARVIS_LOG_CAP + 3; i++) {
      lines = appendLogLine(lines, `L${i}`);
    }
    expect(lines).toHaveLength(JARVIS_LOG_CAP);
    expect(lines[0]).toBe(`L${3}`);
    expect(lines[lines.length - 1]).toBe(`L${JARVIS_LOG_CAP + 2}`);
  });
});

describe('lampsForProgress', () => {
  it('lights all when systems online', () => {
    const lit = lampsForProgress(0.1, true);
    expect(lit.has('arc')).toBe(true);
    expect(lit.has('hud')).toBe(true);
    expect(lit.has('rep')).toBe(true);
  });

  it('thresholds mid-sequence', () => {
    expect(lampsForProgress(0.2, false).size).toBe(0);
    expect(lampsForProgress(0.5, false).has('arc')).toBe(true);
    expect(lampsForProgress(0.5, false).has('hud')).toBe(false);
    expect(lampsForProgress(0.9, false).has('rep')).toBe(true);
  });
});

describe('isPieceWave', () => {
  it('accepts known waves', () => {
    expect(isPieceWave('boots')).toBe(true);
    expect(isPieceWave('nope')).toBe(false);
  });
});

describe('JARVIS_DISMISS_MS', () => {
  it('is a positive dismiss delay', () => {
    expect(JARVIS_DISMISS_MS).toBeGreaterThan(500);
  });
});
