import { describe, expect, it } from 'vitest';
import { floorCradlePorts } from './cradleStands';
import { ROBOTS } from './fittingProgram';
import {
  APERTURE_INNER,
  APERTURE_OUTER,
  APERTURE_SEGMENTS,
  APERTURE_UNDERSIDE,
  apertureBladeSpan,
  aperturePlatePoints,
} from './ringAperture';
import { PLATFORM_RADIUS } from './workshopEnvironment';

/** Floor arm pedestal flange radius (m). */
const FLANGE = 0.205;

describe('ring aperture', () => {
  it('takes every floor arm and parts stand with room to spare', () => {
    const footprints: Array<[number, number, number]> = [
      ...floorCradlePorts(),
      ...ROBOTS.filter((r) => r.mount === 'floor').map((r) => [r.base[0], r.base[2], FLANGE] as [number, number, number]),
    ];
    for (const [x, z, r] of footprints) {
      const d = Math.hypot(x, z);
      expect(d - r - APERTURE_INNER).toBeGreaterThan(0.05);
      expect(APERTURE_OUTER - (d + r)).toBeGreaterThan(0.05);
    }
  });

  it('opens just outside the platform lip', () => {
    expect(APERTURE_INNER - PLATFORM_RADIUS).toBeGreaterThan(0.05);
  });

  it('shuts into a deck over the whole ring', () => {
    // Every point of the opening lies under a plate (seams aside)
    for (let k = 0; k < 720; k++) {
      const a = ((k + 0.25) / 720) * Math.PI * 2;
      for (const r of [APERTURE_INNER, (APERTURE_INNER + APERTURE_OUTER) / 2, APERTURE_OUTER]) {
        const p: [number, number] = [r * Math.cos(a), r * Math.sin(a)];
        const covered = Array.from({ length: APERTURE_SEGMENTS }, (_, i) => aperturePlatePoints(i, 0)).some((poly) =>
          inside(p, poly),
        );
        expect(covered).toBe(true);
      }
    }
  });

  it('parks every plate under the outer deck when open', () => {
    for (let i = 0; i < APERTURE_SEGMENTS; i++) {
      for (const [x, z] of aperturePlatePoints(i, 1)) expect(Math.hypot(x, z)).toBeGreaterThan(APERTURE_OUTER + 0.02);
    }
  });

  it('laps each blade over the next without the two meeting', () => {
    for (const u of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (let k = 0; k < 2000; k++) {
        const a = ((k * 7.31) % 360) * (Math.PI / 180);
        const r = APERTURE_INNER - 0.01 + ((k * 0.618) % 1) * (APERTURE_OUTER - APERTURE_INNER + 1.5);
        const [x, z] = [r * Math.cos(a), r * Math.sin(a)];
        const spans = Array.from({ length: APERTURE_SEGMENTS }, (_, i) => [i, apertureBladeSpan(i, u, x, z)] as const).filter(
          ([, s]) => s,
        );
        // At most two blades over any point, neighbours, one clear above the other
        expect(spans.length).toBeLessThanOrEqual(2);
        if (spans.length === 2) {
          const [[i, a0], [j, b0]] = spans;
          expect(Math.min((j - i + APERTURE_SEGMENTS) % APERTURE_SEGMENTS, (i - j + APERTURE_SEGMENTS) % APERTURE_SEGMENTS)).toBe(1);
          const gap = Math.max(a0!.bottom - b0!.top, b0!.bottom - a0!.top);
          expect(gap).toBeGreaterThan(0.0005);
        }
      }
    }
  });

  it('stays under the deck', () => {
    expect(APERTURE_UNDERSIDE).toBeLessThan(0);
    expect(APERTURE_UNDERSIDE).toBeGreaterThan(-0.025);
  });
});

/** Point in polygon (even-odd). */
function inside([x, y]: [number, number], poly: Array<[number, number]>): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
