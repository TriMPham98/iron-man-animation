import { describe, expect, it } from 'vitest';
import {
  diagnosticStatusForProgress,
  SCAN_RING_PAD_CLEARANCE,
  scanBandOpacity,
  scanFrontY,
  scanWireOpacity,
} from './diagnosticScan';

describe('scanFrontY', () => {
  it('starts at head immediately (head → feet close-out)', () => {
    const y0 = scanFrontY(0, 0, 2);
    expect(y0).toBeCloseTo(2.06, 5);
    // First frames already descend — no dead zone at t≈0
    expect(scanFrontY(0.05, 0, 2)).toBeLessThan(y0);
  });

  it('settles at pad clearance, never below the hangar floor', () => {
    expect(scanFrontY(0.9, 0, 2)).toBeCloseTo(SCAN_RING_PAD_CLEARANCE, 5);
    expect(scanFrontY(1, 0, 2)).toBeCloseTo(SCAN_RING_PAD_CLEARANCE, 5);
    expect(scanFrontY(1, -0.2, 2)).toBeGreaterThanOrEqual(
      SCAN_RING_PAD_CLEARANCE - 1e-9,
    );
  });

  it('is monotonically decreasing through the sweep window', () => {
    let prev = scanFrontY(0, 0, 2);
    for (let t = 0.05; t <= 0.9; t += 0.05) {
      const y = scanFrontY(t, 0, 2);
      expect(y).toBeLessThanOrEqual(prev + 1e-9);
      prev = y;
    }
  });
});

describe('scanWireOpacity', () => {
  it('is full strength immediately then softs out', () => {
    expect(scanWireOpacity(0)).toBe(1);
    expect(scanWireOpacity(0.5)).toBe(1);
    expect(scanWireOpacity(1)).toBeCloseTo(0, 10);
  });
});

describe('scanBandOpacity', () => {
  it('is full strength immediately then softs out', () => {
    expect(scanBandOpacity(0)).toBe(1);
    expect(scanBandOpacity(0.5)).toBe(1);
    expect(scanBandOpacity(1)).toBeCloseTo(0, 10);
  });
});

describe('diagnosticStatusForProgress', () => {
  it('stages structural → power → systems → complete', () => {
    expect(diagnosticStatusForProgress(0)).toContain('INIT');
    expect(diagnosticStatusForProgress(0.2)).toContain('STRUCTURAL');
    expect(diagnosticStatusForProgress(0.5)).toContain('POWER');
    expect(diagnosticStatusForProgress(0.75)).toContain('SYSTEMS');
    expect(diagnosticStatusForProgress(0.95)).toContain('COMPLETE');
  });
});
