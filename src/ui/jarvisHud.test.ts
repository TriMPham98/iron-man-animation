import { describe, expect, it } from 'vitest';
import {
  appendLogLine,
  isPieceWave,
  isSystemsOnlineStatus,
  JARVIS_DISMISS_MS,
  JARVIS_HANDOFF_INTEGRITY,
  JARVIS_LEAVE_MS,
  JARVIS_LOG_CAP,
  shouldHandoffJarvisPanel,
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

describe('JARVIS dismiss timing', () => {
  it('fallback hold is used only when BCI never takes over', () => {
    expect(JARVIS_DISMISS_MS).toBeGreaterThan(500);
    expect(JARVIS_DISMISS_MS).toBeLessThan(3000);
    expect(JARVIS_LEAVE_MS).toBeGreaterThan(300);
    expect(JARVIS_LEAVE_MS).toBeLessThan(800);
  });
});

describe('shouldHandoffJarvisPanel (BCI → top panel)', () => {
  it('hands off when telemetry is live and systems are online', () => {
    expect(
      shouldHandoffJarvisPanel({
        telemetryActive: true,
        panelVisible: true,
        systemsOnline: true,
        integrity01: 1,
      }),
    ).toBe(true);
  });

  it('hands off at full integrity even before the online flag', () => {
    expect(
      shouldHandoffJarvisPanel({
        telemetryActive: true,
        panelVisible: true,
        systemsOnline: false,
        integrity01: JARVIS_HANDOFF_INTEGRITY,
      }),
    ).toBe(true);
  });

  it('does not collapse mid-cascade (telemetry early, integrity low)', () => {
    expect(
      shouldHandoffJarvisPanel({
        telemetryActive: true,
        panelVisible: true,
        systemsOnline: false,
        integrity01: 0.72,
      }),
    ).toBe(false);
  });

  it('is a no-op when the panel is already gone or telemetry is off', () => {
    expect(
      shouldHandoffJarvisPanel({
        telemetryActive: false,
        panelVisible: true,
        systemsOnline: true,
        integrity01: 1,
      }),
    ).toBe(false);
    expect(
      shouldHandoffJarvisPanel({
        telemetryActive: true,
        panelVisible: false,
        systemsOnline: true,
        integrity01: 1,
      }),
    ).toBe(false);
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
