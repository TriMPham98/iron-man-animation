import { describe, expect, it } from 'vitest';
import { classifyWave } from './classifyWave';
import type { PieceWave } from './waves';

/** Envelope matching comments / loadSuitModel GLB measurements. */
const MIN_Y = 0;
const Y_RANGE = 1.85;
const MAX_RADIAL = 0.37;

function at(
  x: number,
  y: number,
  z = 0,
): { x: number; y: number; z: number } {
  return { x, y, z };
}

function waveAt(x: number, y: number, z = 0): PieceWave {
  return classifyWave(at(x, y, z), MIN_Y, Y_RANGE, MAX_RADIAL);
}

describe('classifyWave', () => {
  it.each([
    // low yNorm → boots
    { name: 'foot plate', x: 0.08, y: 0.05, expect: 'boots' as const },
    { name: 'near sole', x: 0.1, y: 0.15, expect: 'boots' as const },

    // mid-low → calves
    { name: 'shin', x: 0.1, y: 0.35, expect: 'calves' as const },
    { name: 'upper calf', x: 0.12, y: 0.5, expect: 'calves' as const },

    // hanging hands → gauntlets (own wave after arms)
    // hands at hang pose: y ≈ 0.90–1.00, r ≈ 0.28–0.37
    {
      name: 'hanging hand L',
      x: 0.3,
      y: 0.95,
      expect: 'gauntlets' as const,
    },
    {
      name: 'hanging hand R',
      x: -0.32,
      y: 0.92,
      expect: 'gauntlets' as const,
    },
    {
      name: 'hand at yNorm ~0.5',
      x: 0.28,
      y: 0.9,
      expect: 'gauntlets' as const,
    },

    // outer thigh body: similar height but radial < 0.26 → thighs
    // outer thigh body armor: y ≈ 0.85–1.05, r ≈ 0.15–0.24
    {
      name: 'outer thigh body',
      x: 0.2,
      y: 0.95,
      expect: 'thighs' as const,
    },
    {
      name: 'inner thigh plate',
      x: 0.15,
      y: 0.9,
      expect: 'thighs' as const,
    },
    {
      name: 'mid thigh',
      x: 0.18,
      y: 0.8,
      expect: 'thighs' as const,
    },

    // hips — soft core at mid height
    {
      name: 'pelvis core',
      x: 0.05,
      y: 0.95,
      expect: 'hips' as const,
    },

    // high narrow → helmet
    {
      name: 'skull',
      x: 0.05,
      y: 1.65,
      expect: 'helmet' as const,
    },
    {
      name: 'faceplate',
      x: 0.02,
      y: 1.6,
      z: 0.08,
      expect: 'helmet' as const,
    },

    // sternum / torso band
    {
      name: 'sternum / reactor',
      x: 0.02,
      y: 1.3,
      z: 0.12,
      expect: 'torso' as const,
    },
    {
      name: 'abs / lower chest',
      x: 0.04,
      y: 1.15,
      z: 0.1,
      expect: 'torso' as const,
    },
    {
      name: 'upper chest core',
      x: 0.06,
      y: 1.35,
      expect: 'torso' as const,
    },
  ])('$name → $expect', ({ x, y, z, expect: expected }) => {
    expect(waveAt(x, y, z ?? 0)).toBe(expected);
  });

  it('does not classify outer thighs as arms (hand/thigh radial split)', () => {
    // Body outer-thigh surface stays thighs
    expect(waveAt(0.2, 0.95)).toBe('thighs');
    expect(waveAt(0.22, 0.95)).toBe('thighs');
    // Soft boundary / classic hang → gauntlets
    expect(waveAt(0.245, 0.95)).toBe('gauntlets');
    expect(waveAt(0.26, 0.95)).toBe('gauntlets');
    expect(waveAt(0.3, 0.95)).toBe('gauntlets');
  });

  it('tags strongly lateral hang-height plates as gauntlets', () => {
    // |x| ≳ 0.25 at hang height (true hand hang), not body thigh |x|≲0.22
    expect(waveAt(0.22, 0.95)).toBe('thighs');
    expect(waveAt(0.26, 0.92)).toBe('gauntlets');
    expect(
      classifyWave({ x: 0.26, y: 0.92, z: 0.04 }, MIN_Y, Y_RANGE, MAX_RADIAL),
    ).toBe('gauntlets');
  });

  it('classifies upper arms and shoulders by height + lateral position', () => {
    // upper arms: y ≈ 1.07–1.30, r ≈ 0.16–0.33
    expect(waveAt(0.22, 1.15)).toBe('arms');
    expect(waveAt(0.28, 1.2)).toBe('arms');

    // shoulders: y ≈ 1.41–1.50, high lateral
    // yNorm 1.45/1.85 ≈ 0.78, rNorm for r=0.2 ≈ 0.54
    expect(waveAt(0.2, 1.45)).toBe('shoulders');
  });

  it('keeps front medial lower-chest / reactor housing as torso (not arms)', () => {
    // Former arms#227 on the normalized GLB: centerline front plate under the
    // reactor — radial is high from +z protrusion, not from arm span.
    expect(
      classifyWave(
        { x: -0.038, y: 1.374, z: 0.177 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('torso');
    // Symmetric front-chest neighbor
    expect(
      classifyWave(
        { x: 0.049, y: 1.359, z: 0.17 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('torso');
    // Back center plate at the same band
    expect(
      classifyWave({ x: 0, y: 1.37, z: -0.178 }, MIN_Y, Y_RANGE, MAX_RADIAL),
    ).toBe('torso');
    // Still arms when truly lateral at chest height
    expect(waveAt(0.22, 1.25, 0.05)).toBe('arms');
  });

  it('uses absolute radial for hands so rNorm alone cannot fold thighs into arms', () => {
    // With maxRadial = 0.37, outer thigh r=0.22 → rNorm≈0.59 (high) but must stay thighs
    const thigh = classifyWave(at(0.22, 0.95), MIN_Y, Y_RANGE, MAX_RADIAL);
    expect(thigh).toBe('thighs');

    // Hand at similar yNorm with absolute r ≥ hang threshold → gauntlets
    const hand = classifyWave(at(0.3, 0.95), MIN_Y, Y_RANGE, MAX_RADIAL);
    expect(hand).toBe('gauntlets');
  });
});
