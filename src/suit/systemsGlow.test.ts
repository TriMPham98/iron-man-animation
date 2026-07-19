import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { classifySystemPoint } from './systemsGlow';

/** Envelope matching normalized suit (~1.85m). */
const MIN_Y = 0;
const Y_RANGE = 1.85;

function sys(x: number, y: number, z = 0) {
  return classifySystemPoint(new THREE.Vector3(x, y, z), MIN_Y, Y_RANGE);
}

describe('classifySystemPoint', () => {
  it('packs hang-pose palms as repulsors, not reactor', () => {
    // Former gauntlets#246 — L palm at hang pose (r≈0.35)
    expect(sys(-0.35, 0.998, 0.038)).toBe('repulsors');
    // Symmetric R palm
    expect(sys(0.35, 0.998, 0.038)).toBe('repulsors');
    // Outer finger / palm tips
    expect(sys(0.4, 0.88, 0.1)).toBe('repulsors');
    expect(sys(-0.4, 0.88, 0.1)).toBe('repulsors');
  });

  it('keeps sternum / reactor housing as reactor', () => {
    expect(sys(0.02, 1.3, 0.12)).toBe('reactor');
    expect(sys(-0.04, 1.37, 0.18)).toBe('reactor');
  });

  it('keeps helmet eyes and boot thrusters', () => {
    expect(sys(0.02, 1.65, 0.08)).toBe('eyes');
    expect(sys(0.08, 0.05, 0.1)).toBe('repulsors');
  });
});
