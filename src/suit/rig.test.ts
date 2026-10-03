import { describe, expect, it } from 'vitest';
import {
  BONE_NAMES,
  BONE_SPECS,
  boneIndex,
  classifyIslandLimb,
  computeIslands,
  computeSkinWeights,
  skinWeightsAt,
} from './rig';

const dominantAt = (x: number, y: number, z: number, limb: Parameters<typeof skinWeightsAt>[3]) => {
  const idx = [0, 0, 0, 0];
  const w = [0, 0, 0, 0];
  return BONE_NAMES[skinWeightsAt(x, y, z, limb, idx, w)];
};

describe('rig skeleton', () => {
  it('lists every bone once with a known parent', () => {
    expect(BONE_SPECS.map((s) => s.name).sort()).toEqual([...BONE_NAMES].sort());
    for (const s of BONE_SPECS) {
      if (s.parent) expect(BONE_NAMES).toContain(s.parent);
    }
  });

  it('mirrors .R limbs across X', () => {
    const l = BONE_SPECS.find((s) => s.name === 'forearm.L')!;
    const r = BONE_SPECS.find((s) => s.name === 'forearm.R')!;
    expect(r.head).toEqual([-l.head[0], l.head[1], l.head[2]]);
  });
});

describe('island limb classification', () => {
  it('splits hanging arms, legs and core', () => {
    expect(classifyIslandLimb([0.37, 0.98, 0.04])).toBe('arm.L');
    expect(classifyIslandLimb([-0.3, 1.2, 0])).toBe('arm.R');
    expect(classifyIslandLimb([0.15, 0.3, 0])).toBe('leg.L');
    expect(classifyIslandLimb([0, 1.4, 0])).toBe('core');
  });
});

describe('skinWeightsAt', () => {
  it('binds limb points to the nearest bone of their limb', () => {
    expect(dominantAt(0.4, 0.9, 0.04, 'arm.L')).toBe('hand.L');
    expect(dominantAt(0.31, 1.15, 0, 'arm.L')).toBe('forearm.L');
    expect(dominantAt(0.15, 0.3, -0.03, 'leg.L')).toBe('shin.L');
    expect(dominantAt(0.16, 0.03, 0.1, 'leg.L')).toBe('foot.L');
    expect(dominantAt(0, 1.75, 0, 'core')).toBe('head');
  });

  it('never binds a torso point to a hanging forearm', () => {
    // Torso side at elbow height, closer to the forearm axis than the spine
    expect(dominantAt(0.17, 1.2, 0, 'core')).not.toMatch(/arm|hand/);
  });

  it('normalizes weights', () => {
    const idx = [0, 0, 0, 0];
    const w = [0, 0, 0, 0];
    skinWeightsAt(0.27, 1.27, -0.03, 'arm.L', idx, w);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });
});

describe('computeSkinWeights', () => {
  // Two disjoint quads: a forearm plate and a shin plate
  const quad = (x: number, y: number, h: number) => [x, y, 0, x + 0.02, y, 0, x + 0.02, y + h, 0, x, y + h, 0];
  const positions = new Float32Array([...quad(0.3, 1.1, 0.06), ...quad(0.14, 0.25, 0.05)]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  it('finds islands', () => {
    const island = computeIslands(positions, indices);
    expect(new Set(island).size).toBe(2);
  });

  it('snaps single-bone plates rigid', () => {
    const r = computeSkinWeights(positions, indices);
    for (let i = 0; i < 4; i++) {
      expect(r.skinIndex[i * 4]).toBe(boneIndex('forearm.L'));
      expect(r.skinWeight[i * 4]).toBe(1);
    }
    expect(r.skinIndex[4 * 4]).toBe(boneIndex('shin.L'));
  });
});
