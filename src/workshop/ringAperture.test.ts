import { describe, expect, it } from 'vitest';
import { floorCradlePorts } from './cradleStands';
import { ROBOTS } from './fittingProgram';
import { APERTURE_INNER, APERTURE_OUTER, APERTURE_SEGMENTS, aperturePlatePoints } from './ringAperture';
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

  it('never runs one plate over another', () => {
    for (const u of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      for (let i = 0; i < APERTURE_SEGMENTS; i++) {
        const a = aperturePlatePoints(i, u);
        const b = aperturePlatePoints((i + 1) % APERTURE_SEGMENTS, u);
        // Sample the neighbour's interior (towards its centroid) and check none falls inside this plate
        const c = b.reduce((s, p) => [s[0] + p[0] / b.length, s[1] + p[1] / b.length], [0, 0]);
        for (const p of b) {
          const q: [number, number] = [p[0] + (c[0] - p[0]) * 0.02, p[1] + (c[1] - p[1]) * 0.02];
          expect(inside(q, a)).toBe(false);
        }
      }
    }
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
