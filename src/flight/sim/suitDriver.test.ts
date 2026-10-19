import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { brakeAzimuth, shoulderOnto } from './suitDriver';

describe('suit driver arms', () => {
  it('lays a half-metre shoulder → palm offset onto a target out to the side', () => {
    const v = new THREE.Vector3(0.1, -0.43, 0.2);
    const t = new THREE.Vector3(0.65, -0.64, 0.4).normalize();
    const [abd, flex] = shoulderOnto(v, t);
    const got = v.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), abd).applyAxisAngle(new THREE.Vector3(1, 0, 0), flex).normalize();
    expect(got.angleTo(t)).toBeLessThan(0.02);
  });

  it('sweeps the braking reach round the body without a jump', () => {
    let prev = brakeAzimuth(-Math.PI);
    for (let i = 1; i <= 720; i++) {
      const a = brakeAzimuth(-Math.PI + (i / 720) * Math.PI * 2);
      expect(Math.abs(a - prev)).toBeLessThan(0.02);
      prev = a;
    }
    expect(brakeAzimuth(Math.PI)).toBeCloseTo(brakeAzimuth(-Math.PI), 6);
  });
});
