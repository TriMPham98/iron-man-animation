import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FOUNDATION_WAVES,
  applyMirroredFlightStarts,
  assemblyScore,
  isTorsoAbsBand,
  isTorsoFrontUnderlayer,
  planSymmetricLaunchGroups,
  planWaveOrder,
  selectFoundation,
  sortPiecesInWave,
  torsoLayerRank,
} from './assemblyOrder';
import type { ArmorPiece, PieceWave } from './waves';

/** Minimal ArmorPiece fixture — only restPosition / wave / id are used by orderers. */
function piece(
  id: string,
  wave: PieceWave,
  x: number,
  y: number,
  z = 0,
): ArmorPiece {
  return {
    id,
    mesh: new THREE.Object3D(),
    wave,
    restPosition: new THREE.Vector3(x, y, z),
    restRotation: new THREE.Euler(),
    restScale: new THREE.Vector3(1, 1, 1),
    startPosition: new THREE.Vector3(),
    startRotation: new THREE.Euler(),
    startScale: new THREE.Vector3(1, 1, 1),
  };
}

describe('FOUNDATION_WAVES', () => {
  it('arms only seed from shoulders (never thighs)', () => {
    expect(FOUNDATION_WAVES.arms).toEqual(['shoulders']);
    expect(FOUNDATION_WAVES.arms).not.toContain('thighs');
    expect(FOUNDATION_WAVES.arms).not.toContain('hips');
    expect(FOUNDATION_WAVES.arms).not.toContain('torso');
  });

  it('helmet seeds from shoulders + torso, not gauntlets', () => {
    expect(FOUNDATION_WAVES.helmet).toEqual(['shoulders', 'torso']);
    expect(FOUNDATION_WAVES.helmet).not.toContain('gauntlets');
    expect(FOUNDATION_WAVES.helmet).not.toContain('arms');
  });

  it('boots have empty foundation (plant first)', () => {
    expect(FOUNDATION_WAVES.boots).toEqual([]);
  });

  it('gauntlets clamp onto arms only', () => {
    expect(FOUNDATION_WAVES.gauntlets).toEqual(['arms']);
  });
});

describe('selectFoundation', () => {
  const built = [
    piece('boot-L', 'boots', 0.1, 0.05),
    piece('calf-L', 'calves', 0.1, 0.35),
    piece('thigh-L', 'thighs', 0.18, 0.9),
    piece('thigh-R', 'thighs', -0.18, 0.9),
    piece('hip', 'hips', 0.02, 1.0),
    piece('torso', 'torso', 0.0, 1.3),
    piece('shoulder-L', 'shoulders', 0.22, 1.45),
    piece('shoulder-R', 'shoulders', -0.22, 1.45),
    piece('arm-L', 'arms', 0.28, 1.15),
    piece('gauntlet-L', 'gauntlets', 0.3, 0.95),
  ];

  it('returns empty foundation for boots', () => {
    expect(selectFoundation('boots', built)).toEqual([]);
  });

  it('arms use only shoulder pieces, not thighs at similar height', () => {
    const foundation = selectFoundation('arms', built);
    expect(foundation.map((p) => p.id).sort()).toEqual([
      'shoulder-L',
      'shoulder-R',
    ]);
    expect(foundation.every((p) => p.wave === 'shoulders')).toBe(true);
    expect(foundation.some((p) => p.wave === 'thighs')).toBe(false);
  });

  it('helmet uses shoulders + torso, not gauntlets', () => {
    const foundation = selectFoundation('helmet', built);
    const waves = new Set(foundation.map((p) => p.wave));
    expect(waves).toEqual(new Set(['shoulders', 'torso']));
    expect(foundation.some((p) => p.wave === 'gauntlets')).toBe(false);
  });

  it('calves only take boots', () => {
    const foundation = selectFoundation('calves', built);
    expect(foundation.every((p) => p.wave === 'boots')).toBe(true);
  });
});

describe('assemblyScore', () => {
  const bounds = { minY: 0, maxY: 2, maxRadial: 0.4 };

  it('prefers lower Y for upward-growing waves (boots/torso)', () => {
    const low = assemblyScore({ x: 0, y: 0.2, z: 0 }, 'boots', bounds);
    const high = assemblyScore({ x: 0, y: 1.5, z: 0 }, 'boots', bounds);
    expect(low).toBeLessThan(high);
  });

  it('prefers proximal (high Y) for downward limb waves (arms)', () => {
    const proximal = assemblyScore({ x: 0.2, y: 1.4, z: 0 }, 'arms', bounds);
    const distal = assemblyScore({ x: 0.3, y: 0.9, z: 0 }, 'arms', bounds);
    expect(proximal).toBeLessThan(distal);
  });

  it('prefers spine-near over outer radial at same height', () => {
    const core = assemblyScore({ x: 0.02, y: 1.2, z: 0 }, 'torso', bounds);
    const outer = assemblyScore({ x: 0.35, y: 1.2, z: 0 }, 'torso', bounds);
    expect(core).toBeLessThan(outer);
  });
});

describe('planWaveOrder / sortPiecesInWave', () => {
  it('returns single piece unchanged with seedCount 1', () => {
    const alone = [piece('only', 'boots', 0, 0.05)];
    const result = planWaveOrder(alone, 'boots');
    expect(result.ordered).toHaveLength(1);
    expect(result.seedCount).toBe(1);
    expect(result.ordered[0].id).toBe('only');
  });

  it('sorts upward wave bottom → top when no foundation', () => {
    const pieces = [
      piece('high', 'boots', 0.1, 0.12),
      piece('low', 'boots', 0.1, 0.02),
      piece('mid', 'boots', 0.1, 0.07),
    ];
    const ordered = sortPiecesInWave(pieces, 'boots');
    expect(ordered.map((p) => p.id)).toEqual(['low', 'mid', 'high']);
  });

  it('seeds arms from shoulder foundation, not from hanging hand height near thighs', () => {
    const armPieces = [
      piece('hand-L', 'arms', 0.3, 0.95),
      piece('forearm-L', 'arms', 0.26, 1.05),
      piece('upper-L', 'arms', 0.22, 1.25),
      piece('hand-R', 'arms', -0.3, 0.95),
      piece('upper-R', 'arms', -0.22, 1.25),
    ];
    const foundation = [
      piece('shoulder-L', 'shoulders', 0.22, 1.45),
      piece('shoulder-R', 'shoulders', -0.22, 1.45),
    ];

    const { ordered, seedCount } = planWaveOrder(
      armPieces,
      'arms',
      foundation,
    );

    // Seeds should be the upper arms nearest the shoulders
    expect(seedCount).toBe(2);
    const seedIds = ordered.slice(0, seedCount).map((p) => p.id);
    expect(seedIds).toContain('upper-L');
    expect(seedIds).toContain('upper-R');
    // Hands attach last-ish (after growth from shoulders)
    const handIdx = Math.min(
      ordered.findIndex((p) => p.id === 'hand-L'),
      ordered.findIndex((p) => p.id === 'hand-R'),
    );
    const upperIdx = Math.min(
      ordered.findIndex((p) => p.id === 'upper-L'),
      ordered.findIndex((p) => p.id === 'upper-R'),
    );
    expect(upperIdx).toBeLessThan(handIdx);
  });

  it('is stable for equal scores via id tie-break', () => {
    // Two pieces at identical rest positions — order by id
    const pieces = [
      piece('b-plate', 'torso', 0.1, 1.2),
      piece('a-plate', 'torso', 0.1, 1.2),
    ];
    const ordered = sortPiecesInWave(pieces, 'torso');
    // First seed is the better id when scores match
    expect(ordered[0].id).toBe('a-plate');
    expect(ordered[1].id).toBe('b-plate');
  });

  it('seats abs → under-shells (#235/#334) → outer reactor housing (#281)', () => {
    // Measured high-tier rests
    const under235 = piece('under-235', 'torso', -0.0264, 1.5426, 0.0917);
    const under334 = piece('under-334', 'torso', 0.1252, 1.523, 0.089);
    const under334L = piece('under-334-L', 'torso', -0.1252, 1.523, 0.089);
    // Abs / lower front torso
    const abs = piece('abs', 'torso', 0.11, 1.15, 0.1);
    const absL = piece('abs-L', 'torso', -0.09, 1.2, 0.11);
    // Exterior arc-reactor shell — sits *over* underlayer (must not clamp first)
    const outer281 = piece('outer-281', 'torso', -0.009, 1.441, 0.161);
    const outerHigh = piece('outer-high', 'torso', 0.2, 1.55, 0.12);
    const reactor = piece('reactor', 'torso', 0, 1.45, 0.15);

    expect(isTorsoFrontUnderlayer(under235)).toBe(true);
    expect(isTorsoFrontUnderlayer(under334)).toBe(true);
    expect(isTorsoAbsBand(abs)).toBe(true);
    expect(isTorsoAbsBand(outer281)).toBe(false);
    expect(isTorsoFrontUnderlayer(outer281)).toBe(false);
    expect(torsoLayerRank(abs)).toBe(0);
    expect(torsoLayerRank(under235)).toBe(1);
    expect(torsoLayerRank(outer281)).toBe(2);

    const ordered = sortPiecesInWave(
      [outerHigh, reactor, abs, under334, under235, absL, outer281],
      'torso',
    );
    const idx = (id: string) => ordered.findIndex((p) => p.id === id);

    // Abs band before underlayers
    expect(idx('abs')).toBeLessThan(idx('under-235'));
    expect(idx('abs')).toBeLessThan(idx('under-334'));
    expect(idx('abs-L')).toBeLessThan(idx('under-235'));
    // Underlayers before exterior reactor housing (clip-through guard)
    expect(idx('under-235')).toBeLessThan(idx('outer-281'));
    expect(idx('under-334')).toBeLessThan(idx('outer-281'));
    expect(idx('under-235')).toBeLessThan(idx('outer-high'));
    expect(idx('under-334')).toBeLessThan(idx('outer-high'));
    // Ignition housing still last among outer chest
    expect(ordered[ordered.length - 1].id).toBe('reactor');

    const groups = planSymmetricLaunchGroups(
      [outer281, under334, under334L, abs, absL],
      'torso',
    );
    // Layer order preserved in launch groups: abs first, under, then outer
    expect(groups[0].every((p) => isTorsoAbsBand(p))).toBe(true);
    const flat = groups.flat().map((p) => p.id);
    expect(flat.indexOf('abs')).toBeLessThan(flat.indexOf('under-334'));
    expect(flat.indexOf('under-334')).toBeLessThan(flat.indexOf('outer-281'));
  });
});

describe('planSymmetricLaunchGroups', () => {
  it('pairs opposite-side boots at the same height into one launch group', () => {
    const pieces = [
      piece('boot-L', 'boots', 0.12, 0.05),
      piece('boot-R', 'boots', -0.12, 0.05),
    ];
    const groups = planSymmetricLaunchGroups(pieces, 'boots');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
    const ids = groups[0].map((p) => p.id).sort();
    expect(ids).toEqual(['boot-L', 'boot-R']);
  });

  it('launches lower pair before higher pair (upward waves)', () => {
    const bootish = [
      piece('low-L', 'boots', 0.12, 0.05),
      piece('low-R', 'boots', -0.12, 0.05),
      piece('high-L', 'boots', 0.12, 0.15),
      piece('high-R', 'boots', -0.12, 0.15),
    ];
    const groups = planSymmetricLaunchGroups(bootish, 'boots');
    expect(groups).toHaveLength(2);
    expect(groups[0].map((p) => p.id).sort()).toEqual(['low-L', 'low-R']);
    expect(groups[1].map((p) => p.id).sort()).toEqual(['high-L', 'high-R']);
  });

  it('keeps centerline plates solo', () => {
    const pieces = [
      piece('spine', 'torso', 0.01, 1.2),
      piece('side-L', 'torso', 0.2, 1.2),
      piece('side-R', 'torso', -0.2, 1.2),
    ];
    const groups = planSymmetricLaunchGroups(pieces, 'torso');
    const spineGroup = groups.find((g) => g.some((p) => p.id === 'spine'));
    expect(spineGroup).toBeDefined();
    expect(spineGroup).toHaveLength(1);
    const sideGroup = groups.find((g) => g.some((p) => p.id === 'side-L'));
    expect(sideGroup?.map((p) => p.id).sort()).toEqual(['side-L', 'side-R']);
  });

  it('pairs arm laterals and prefers proximal groups first', () => {
    const pieces = [
      piece('hand-L', 'arms', 0.3, 0.95),
      piece('hand-R', 'arms', -0.3, 0.95),
      piece('upper-L', 'arms', 0.22, 1.25),
      piece('upper-R', 'arms', -0.22, 1.25),
    ];
    const groups = planSymmetricLaunchGroups(pieces, 'arms');
    expect(groups).toHaveLength(2);
    // Proximal (high Y) first for limb waves
    expect(groups[0].map((p) => p.id).sort()).toEqual(['upper-L', 'upper-R']);
    expect(groups[1].map((p) => p.id).sort()).toEqual(['hand-L', 'hand-R']);
  });

  it('applyMirroredFlightStarts mirrors +X plate from −X (lower rest X is source)', () => {
    // Convention: lower rest.x is the source; partner gets mirrored scatter
    const source = piece('boot-negX', 'boots', -0.12, 0.05);
    const partner = piece('boot-posX', 'boots', 0.12, 0.05);
    source.startPosition.set(1.5, 0.5, 2.0);
    source.startRotation.set(0.2, 0.4, -0.1);
    partner.startPosition.set(9, 9, 9); // will be overwritten
    partner.startRotation.set(0, 0, 0);

    applyMirroredFlightStarts([[source, partner]]);

    // offset from source rest = (1.62, 0.45, 2.0) → partner = restP + (−1.62, 0.45, 2.0)
    expect(partner.startPosition.x).toBeCloseTo(0.12 - 1.62);
    expect(partner.startPosition.y).toBeCloseTo(0.05 + 0.45);
    expect(partner.startPosition.z).toBeCloseTo(0 + 2.0);
    expect(partner.startRotation.x).toBeCloseTo(0.2);
    expect(partner.startRotation.y).toBeCloseTo(-0.4);
    expect(partner.startRotation.z).toBeCloseTo(0.1);
  });

  it('co-launches dual-layer helmet shells at the same socket (helmet#219/#220)', () => {
    // Same socket, stacked source meshes — must not seat on different beats
    const inner = piece('shell-a', 'helmet', -0.017, 1.655, 0.014);
    const outer = piece('shell-b', 'helmet', -0.009, 1.715, -0.004);
    const far = piece('cheek-L', 'helmet', 0.22, 1.56, 0.04);
    const farR = piece('cheek-R', 'helmet', -0.22, 1.56, 0.04);

    const groups = planSymmetricLaunchGroups(
      [inner, outer, far, farR],
      'helmet',
    );

    const shellGroup = groups.find((g) => g.some((p) => p.id === 'shell-a'));
    expect(shellGroup).toBeDefined();
    expect(shellGroup!.map((p) => p.id).sort()).toEqual([
      'shell-a',
      'shell-b',
    ]);
    // Cheeks remain a separate L/R pair
    const cheekGroup = groups.find((g) => g.some((p) => p.id === 'cheek-L'));
    expect(cheekGroup?.map((p) => p.id).sort()).toEqual(['cheek-L', 'cheek-R']);
  });

  it('does not fuse distant centerline helmet plates into one group', () => {
    const jaw = piece('jaw', 'helmet', 0.0, 1.52, 0.08);
    const crown = piece('crown', 'helmet', 0.0, 1.78, -0.02);
    const groups = planSymmetricLaunchGroups([jaw, crown], 'helmet');
    expect(groups).toHaveLength(2);
  });

  it('does not co-locate dual-layer pairing outside the helmet wave', () => {
    const a = piece('torso-a', 'torso', 0.0, 1.3, 0.1);
    const b = piece('torso-b', 'torso', 0.01, 1.32, 0.09);
    const groups = planSymmetricLaunchGroups([a, b], 'torso');
    // Torso keeps centerline solos — no dual-layer absorb
    expect(groups).toHaveLength(2);
  });
});
