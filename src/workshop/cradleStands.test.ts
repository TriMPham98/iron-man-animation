import { describe, expect, it } from 'vitest';
import { floorCradlePorts, lidDirections, lidRadius, lidTravel } from './cradleStands';
import { ROBOT_RING_RADIUS, ROBOTS } from './fittingProgram';
import { RING_HALF_WIDTH, WELL_RADIUS } from './workshopEnvironment';

describe('cradle ports', () => {
  const ports = floorCradlePorts();
  const holes: Array<[number, number, number]> = [
    ...ports,
    ...ROBOTS.filter((r) => r.mount === 'floor').map((r) => [r.base[0], r.base[2], WELL_RADIUS] as [number, number, number]),
  ];

  const ring: [number, number] = [ROBOT_RING_RADIUS - RING_HALF_WIDTH, ROBOT_RING_RADIUS + RING_HALF_WIDTH];

  it('puts every floor arm inside the one robot ring', () => {
    for (const r of ROBOTS.filter((s) => s.mount === 'floor')) {
      const d = Math.hypot(r.base[0], r.base[2]);
      expect(d - WELL_RADIUS).toBeGreaterThan(ring[0]);
      expect(d + WELL_RADIUS).toBeLessThan(ring[1]);
    }
  });

  it('keeps every port clear of the robot ring', () => {
    for (const [x, z, r] of ports) expect(Math.hypot(x, z) - r).toBeGreaterThan(ring[1] + 0.05);
  });

  it('never overlap each other or a robot well', () => {
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        const [ax, az, ar] = holes[i];
        const [bx, bz, br] = holes[j];
        expect(Math.hypot(ax - bx, az - bz)).toBeGreaterThan(ar + br + 0.01);
      }
    }
  });

  it('park their lids out of sight under the floor', () => {
    const dirs = lidDirections(holes, [ring]);
    ports.forEach(([x, z, r], i) => {
      const lx = x + dirs[i][0] * lidTravel(r);
      const lz = z + dirs[i][1] * lidTravel(r);
      holes.forEach(([hx, hz, hr], j) => {
        if (j === i) return;
        expect(Math.hypot(lx - hx, lz - hz)).toBeGreaterThan(lidRadius(r) + hr);
      });
      expect(Math.hypot(lx, lz) - lidRadius(r)).toBeGreaterThan(ring[1]);
    });
  });
});
