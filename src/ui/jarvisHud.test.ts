import { describe, expect, it } from 'vitest';
import {
  appendLogLine,
  isPieceWave,
  isSystemsOnlineStatus,
  JARVIS_DISMISS_MS,
  JARVIS_LEAVE_MS,
  JARVIS_LOG_CAP,
  JARVIS_ONLINE_HOLD_MS,
} from './jarvisHud';

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

describe('isPieceWave', () => {
  it('accepts known waves', () => {
    expect(isPieceWave('boots')).toBe(true);
    expect(isPieceWave('nope')).toBe(false);
  });
});

describe('top leave after SYSTEMS ONLINE', () => {
  it('holds the cyan finish beat before soft leave', () => {
    expect(JARVIS_ONLINE_HOLD_MS).toBeGreaterThanOrEqual(700);
    expect(JARVIS_ONLINE_HOLD_MS).toBeLessThanOrEqual(1200);
    expect(JARVIS_DISMISS_MS).toBe(JARVIS_ONLINE_HOLD_MS);
    expect(JARVIS_LEAVE_MS).toBeGreaterThan(300);
    expect(JARVIS_LEAVE_MS).toBeLessThan(800);
  });
});

describe('isSystemsOnlineStatus', () => {
  it('accepts the final systems-online beat', () => {
    expect(isSystemsOnlineStatus('SYSTEMS ONLINE')).toBe(true);
    expect(isSystemsOnlineStatus('SYSTEMS ONLINE — REDUCED MOTION')).toBe(
      true,
    );
  });

  it('rejects intermediate ONLINE / STABLE lines mid-cascade', () => {
    expect(isSystemsOnlineStatus('J.A.R.V.I.S. ONLINE')).toBe(false);
    expect(isSystemsOnlineStatus('ARC REACTOR ONLINE')).toBe(false);
    expect(isSystemsOnlineStatus('REPULSORS ONLINE')).toBe(false);
    expect(isSystemsOnlineStatus('HELMET SEALED — HUD ONLINE…')).toBe(false);
    expect(isSystemsOnlineStatus('SYSTEMS ONLINE — ARC STABLE…')).toBe(false);
    expect(isSystemsOnlineStatus('ASSEMBLY SEQUENCE INITIATED')).toBe(false);
    expect(isSystemsOnlineStatus('STANDBY // HANGAR LOCK')).toBe(false);
  });
});
