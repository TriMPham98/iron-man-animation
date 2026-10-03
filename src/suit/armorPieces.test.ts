import { describe, expect, it } from 'vitest';
import { ARMOR_PIECES, CUT_TREES, cutArmor, pieceAt } from './armorPieces';
import { WAVE_ORDER } from './waves';

describe('ARMOR_PIECES', () => {
  it('has unique ids on known waves', () => {
    const ids = ARMOR_PIECES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of ARMOR_PIECES) expect(WAVE_ORDER).toContain(p.wave);
  });

  it('every cut-tree leaf is a defined piece', () => {
    const ids = new Set(ARMOR_PIECES.map((p) => p.id));
    const walk = (t: (typeof CUT_TREES)['core']): void => {
      if (typeof t === 'string') expect(ids.has(t)).toBe(true);
      else {
        walk(t.pos);
        walk(t.neg);
      }
    };
    Object.values(CUT_TREES).forEach(walk);
  });
});

describe('pieceAt', () => {
  it('maps landmarks to the film suit-up pieces', () => {
    expect(pieceAt('leg.L', [0.16, 0.05, 0.05])).toBe('boot.L');
    expect(pieceAt('leg.R', [-0.15, 0.3, 0.05])).toBe('shin.R.front');
    expect(pieceAt('leg.L', [0.14, 0.65, -0.08])).toBe('thigh.L.back');
    expect(pieceAt('arm.L', [0.4, 0.9, 0.04])).toBe('gauntlet.L');
    expect(pieceAt('arm.R', [-0.32, 1.15, 0])).toBe('forearm.R');
    expect(pieceAt('core', [0, 1.42, 0.15])).toBe('chest.core');
    expect(pieceAt('core', [0.13, 1.42, 0.12])).toBe('pec.L');
    expect(pieceAt('core', [-0.13, 1.42, 0.12])).toBe('pec.R');
    expect(pieceAt('core', [0, 1.4, -0.15])).toBe('back.upper');
    expect(pieceAt('core', [0, 1.12, -0.15])).toBe('back.lower');
    // Shoulder tops above the collar stay off the helmet
    expect(pieceAt('core', [0.14, 1.62, 0.0])).not.toMatch(/helmet|faceplate/);
    expect(pieceAt('core', [0.25, 1.5, 0])).toBe('pauldron.L');
    expect(pieceAt('core', [0, 1.74, 0.1])).toBe('faceplate');
    expect(pieceAt('core', [0, 1.78, -0.06])).toBe('helmet');
  });
});

describe('cutArmor', () => {
  const base = {
    normals: new Array(12).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    uvs: new Array(8).fill(0),
    island: [0, 0, 0, 0],
    islandLimb: ['leg.L' as const],
    skinIndex: new Array(16).fill(0),
    skinWeight: new Array(16).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)),
    weightsAt: (_x: number, _y: number, _z: number, _i: number, idx: number[], w: number[]) => {
      idx[0] = 0;
      w[0] = 1;
    },
  };
  const totalArea = (pieces: ReturnType<typeof cutArmor>) => {
    let area = 0;
    for (const p of pieces) {
      for (let t = 0; t < p.indices.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => {
          const o = p.indices[t + k] * 3;
          return [p.positions[o], p.positions[o + 1]];
        });
        area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }
    }
    return area;
  };

  it('keeps a panel whole when it sits mostly in one section', () => {
    // Quad on the shin front, poking 2.5 cm past the knee seam
    const pieces = cutArmor({
      ...base,
      positions: [0.12, 0.3, 0.05, 0.18, 0.3, 0.05, 0.18, 0.5, 0.05, 0.12, 0.5, 0.05],
      indices: [0, 1, 2, 0, 2, 3],
    });
    expect(pieces.map((p) => p.id)).toEqual(['shin.L.front']);
    expect(totalArea(pieces)).toBeCloseTo(0.06 * 0.2, 6);
  });

  it('clips a panel shared between sections on the seam plane', () => {
    // Quad split evenly across the knee seam
    const pieces = cutArmor({
      ...base,
      positions: [0.12, 0.375, 0.05, 0.18, 0.375, 0.05, 0.18, 0.575, 0.05, 0.12, 0.575, 0.05],
      indices: [0, 1, 2, 0, 2, 3],
    });
    expect(pieces.map((p) => p.id).sort()).toEqual(['shin.L.front', 'thigh.L.front']);
    expect(totalArea(pieces)).toBeCloseTo(0.06 * 0.2, 6);
    for (const p of pieces) {
      for (let i = 1; i < p.positions.length; i += 3) {
        const y = p.positions[i];
        expect([0.375, 0.575, 0.475].some((v) => Math.abs(y - v) < 1e-6)).toBe(true);
      }
    }
  });
});
