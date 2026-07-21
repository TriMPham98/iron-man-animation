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

  it('keeps hip side-flare plates as hips, not arms (former arms#180/#193)', () => {
    // Measured L/R waist side plates: centroid |x|≈0.15, y≈1.22, thin on the
    // body (max|x|≲0.23). Previously ax>0.14 tagged them as arms.
    const left180 = classifyWave(
      { x: -0.154, y: 1.222, z: 0.012, maxAbsX: 0.225 },
      MIN_Y,
      Y_RANGE,
      MAX_RADIAL,
    );
    const left193 = classifyWave(
      { x: -0.148, y: 1.216, z: 0.082, maxAbsX: 0.181 },
      MIN_Y,
      Y_RANGE,
      MAX_RADIAL,
    );
    const right177 = classifyWave(
      { x: 0.153, y: 1.21, z: 0.015, maxAbsX: 0.186 },
      MIN_Y,
      Y_RANGE,
      MAX_RADIAL,
    );
    const right181 = classifyWave(
      { x: 0.148, y: 1.191, z: 0.081, maxAbsX: 0.176 },
      MIN_Y,
      Y_RANGE,
      MAX_RADIAL,
    );
    expect(left180).toBe('hips');
    expect(left193).toBe('hips');
    expect(right177).toBe('hips');
    expect(right181).toBe('hips');

    // Neighbor true arm at same height with outward span stays arms
    expect(
      classifyWave(
        { x: 0.161, y: 1.22, z: 0.01, maxAbsX: 0.288 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('arms');
    expect(
      classifyWave(
        { x: -0.166, y: 1.22, z: 0.008, maxAbsX: 0.288 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('arms');
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

  it('keeps lateral chest plates as torso, not arms (former arms#251/#252)', () => {
    // Front pec / lateral chest wall: modest |x|, no free-arm span, front z.
    expect(
      classifyWave(
        { x: -0.161, y: 1.338, z: 0.107, maxAbsX: 0.189 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('torso');
    expect(
      classifyWave(
        { x: 0.161, y: 1.338, z: 0.107, maxAbsX: 0.189 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('torso');
    // Free arm at same height with outward span stays arms
    expect(
      classifyWave(
        { x: -0.191, y: 1.354, z: 0.044, maxAbsX: 0.292 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('arms');
  });

  it('keeps upper sternum / reactor collar as torso, not helmet (former helmet#270)', () => {
    // Tall reactor housing: centerline, front z≳0.09, yNorm just above 0.82
    // so the old helmet gate (yNorm>0.82 && rNorm≤HEAD) swallowed it.
    expect(
      classifyWave(
        { x: 0, y: 1.45, z: 0.153, maxAbsX: 0.145 },
        MIN_Y,
        Y_RANGE,
        MAX_RADIAL,
      ),
    ).toBe('torso');
    // True skull still helmet
    expect(waveAt(0.05, 1.65)).toBe('helmet');
    expect(waveAt(0.02, 1.6, 0.08)).toBe('helmet');
  });

  it('tags high pauldron / shoulder pads (reclass card stack)', () => {
    // Runtime-like envelope: yNorm≈0.88 would hit blanket helmet gate
    const rtMin = 0;
    const rtRange = 1.713;
    const rtMaxR = 0.41;
    const rt = (
      p: { x: number; y: number; z: number; maxAbsX?: number },
    ) => classifyWave(p, rtMin, rtRange, rtMaxR);

    // Outer stack
    expect(
      rt({ x: -0.1895, y: 1.5253, z: 0.0076, maxAbsX: 0.232 }),
    ).toBe('shoulders'); // #392
    expect(
      rt({ x: 0.1816, y: 1.5375, z: 0.0755, maxAbsX: 0.2144 }),
    ).toBe('shoulders'); // #409
    expect(
      rt({ x: -0.1556, y: 1.6053, z: 0.0121, maxAbsX: 0.2347 }),
    ).toBe('shoulders'); // #395
    expect(
      rt({ x: 0.2165, y: 1.5869, z: -0.0368, maxAbsX: 0.2731 }),
    ).toBe('shoulders'); // #438
    expect(
      rt({ x: -0.2165, y: 1.5869, z: -0.0368, maxAbsX: 0.2731 }),
    ).toBe('shoulders'); // #439
    expect(
      rt({ x: 0.2901, y: 1.5228, z: 0.0043, maxAbsX: 0.3174 }),
    ).toBe('shoulders'); // #449

    // Mid-lateral
    expect(
      rt({ x: 0.15, y: 1.4861, z: 0.0698, maxAbsX: 0.1606 }),
    ).toBe('shoulders'); // #318
    expect(
      rt({ x: 0.1484, y: 1.5355, z: 0.0833, maxAbsX: 0.1703 }),
    ).toBe('shoulders'); // #364
    expect(
      rt({ x: 0.1477, y: 1.5336, z: -0.0964, maxAbsX: 0.1633 }),
    ).toBe('shoulders'); // #376
    expect(
      rt({ x: 0.1401, y: 1.4786, z: -0.0552, maxAbsX: 0.1441 }),
    ).toBe('shoulders'); // #299
    expect(
      rt({ x: 0.144, y: 1.5529, z: 0.084, maxAbsX: 0.152 }),
    ).toBe('shoulders'); // #371

    // #405 high back-lateral trap
    expect(
      rt({ x: 0.122, y: 1.6418, z: -0.0856, maxAbsX: 0.1445 }),
    ).toBe('shoulders');

    // Rear mid-lateral trap / back pauldron (reclass card stack)
    expect(
      rt({ x: 0.1509, y: 1.6266, z: -0.0847, maxAbsX: 0.1563 }),
    ).toBe('shoulders'); // #441
    expect(
      rt({ x: -0.1509, y: 1.6266, z: -0.0847, maxAbsX: 0.1563 }),
    ).toBe('shoulders'); // #442
    expect(
      rt({ x: 0.1651, y: 1.5852, z: -0.0749, maxAbsX: 0.1781 }),
    ).toBe('shoulders'); // #430
    expect(
      rt({ x: -0.1651, y: 1.5852, z: -0.0749, maxAbsX: 0.1781 }),
    ).toBe('shoulders'); // #431
    expect(
      rt({ x: 0.1514, y: 1.6088, z: -0.1075, maxAbsX: 0.1656 }),
    ).toBe('shoulders'); // #446
    expect(
      rt({ x: -0.1517, y: 1.6087, z: -0.1074, maxAbsX: 0.1656 }),
    ).toBe('shoulders'); // #447 mirror
    expect(
      rt({ x: -0.1208, y: 1.6218, z: -0.125, maxAbsX: 0.1504 }),
    ).toBe('shoulders'); // #439
    expect(
      rt({ x: 0.1208, y: 1.6218, z: -0.125, maxAbsX: 0.1504 }),
    ).toBe('shoulders'); // #439 L/R mirror
    expect(
      rt({ x: 0.1192, y: 1.5492, z: -0.1609, maxAbsX: 0.151 }),
    ).toBe('shoulders'); // #434
    expect(
      rt({ x: -0.1192, y: 1.5492, z: -0.1609, maxAbsX: 0.151 }),
    ).toBe('shoulders'); // #434 L/R mirror
    // Medial rear shell stays helmet (not this band)
    expect(
      rt({ x: 0.012, y: 1.669, z: -0.1, maxAbsX: 0.15 }),
    ).toBe('helmet');

    // Near-centerline wide collar (#244, #254)
    expect(
      rt({ x: 0, y: 1.6002, z: 0.074, maxAbsX: 0.1409 }),
    ).toBe('shoulders');
    expect(
      rt({ x: -0.0296, y: 1.6063, z: 0.0709, maxAbsX: 0.1393 }),
    ).toBe('shoulders'); // #254

    // #352 near-centerline wide rear collar / upper-back trap
    expect(
      rt({ x: -0.0171, y: 1.6076, z: -0.1286, maxAbsX: 0.1445 }),
    ).toBe('shoulders');
    // #344 trap half after nape peel (slight |x| bias, wide maxAbsX)
    expect(
      rt({ x: 0.0553, y: 1.6183, z: -0.1382, maxAbsX: 0.1502 }),
    ).toBe('shoulders');
    // #344 nape half stays helmet (high, narrow laterality)
    expect(
      rt({ x: 0, y: 1.6817, z: -0.0903, maxAbsX: 0.0625 }),
    ).toBe('helmet');
    // Narrow rear skull plate stays helmet
    expect(
      rt({ x: -0.001, y: 1.629, z: -0.092, maxAbsX: 0.073 }),
    ).toBe('helmet');
    // Higher crown / back-of-head shell stays helmet
    expect(
      rt({ x: 0.012, y: 1.669, z: -0.1, maxAbsX: 0.15 }),
    ).toBe('helmet');

    // #315 high mid-collar / trap pad (reclass card)
    expect(
      rt({ x: -0.0957, y: 1.6147, z: 0.0476, maxAbsX: 0.1474 }),
    ).toBe('shoulders');
    // L/R mirror of the same pad
    expect(
      rt({ x: 0.0957, y: 1.6147, z: 0.0476, maxAbsX: 0.1474 }),
    ).toBe('shoulders');
    // More lateral upper pec at same height stays torso (#349 band)
    expect(
      rt({ x: 0.1172, y: 1.6147, z: 0.0457, maxAbsX: 0.1474 }),
    ).toBe('torso');

    // Neck collar peeled from cranial shell (helmet#220 chest half) → torso
    expect(
      rt({ x: -0.049, y: 1.626, z: 0.01, maxAbsX: 0.148 }),
    ).toBe('torso');
    // True mid-face / crown stays helmet
    expect(rt({ x: 0.005, y: 1.669, z: 0.099 })).toBe('helmet');
    expect(
      rt({ x: 0.038, y: 1.701, z: 0.02, maxAbsX: 0.08 }),
    ).toBe('helmet');
  });

  it('tags upper chest / collar plates as torso (former helmet#216–#343)', () => {
    // Runtime-like envelope: skull raises maxY so yRange ≈ 1.71 and these
    // plates sit at yNorm≈0.90 — past the yNorm≤0.85 collar gate.
    const rtMin = 0;
    const rtRange = 1.713;
    const rtMaxR = 0.41;
    const rt = (
      p: { x: number; y: number; z: number; maxAbsX?: number },
    ) => classifyWave(p, rtMin, rtRange, rtMaxR);

    // #216 / #218: shallow front centerline above the reactor disk
    expect(rt({ x: 0, y: 1.556, z: 0.044 })).toBe('torso');
    expect(rt({ x: -0.003, y: 1.566, z: 0.046 })).toBe('torso');
    // #241: deeper upper chest (same band as reactor top)
    expect(rt({ x: -0.024, y: 1.547, z: 0.094 })).toBe('torso');
    // #335: upper front pec beside the collar
    expect(rt({ x: 0.121, y: 1.543, z: 0.099, maxAbsX: 0.15 })).toBe(
      'torso',
    );
    // #336 / #343: lateral collar / trap side plates
    expect(rt({ x: -0.148, y: 1.559, z: 0.018, maxAbsX: 0.18 })).toBe(
      'torso',
    );
    expect(rt({ x: 0.119, y: 1.635, z: -0.005, maxAbsX: 0.15 })).toBe(
      'torso',
    );
    // #333 chest-pad fragments after faceplate split (lower lateral lobes)
    expect(rt({ x: 0.095, y: 1.602, z: 0.074, maxAbsX: 0.13 })).toBe(
      'torso',
    );
    expect(rt({ x: -0.094, y: 1.602, z: 0.074, maxAbsX: 0.13 })).toBe(
      'torso',
    );

    // True mid-face / skull faceplate stays helmet
    expect(rt({ x: 0.005, y: 1.669, z: 0.099 })).toBe('helmet');
    expect(rt({ x: 0.007, y: 1.67, z: 0.102 })).toBe('helmet');
    // Higher left lobe (former torso#311) is helmet, not upper chest
    expect(rt({ x: -0.082, y: 1.622, z: 0.057, maxAbsX: 0.14 })).toBe(
      'helmet',
    );
    // Wider / deeper cheek not collar
    expect(rt({ x: 0.148, y: 1.535, z: 0.083, maxAbsX: 0.2 })).not.toBe(
      'torso',
    );
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
