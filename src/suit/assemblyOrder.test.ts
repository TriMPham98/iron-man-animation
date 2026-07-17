import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FOUNDATION_WAVES,
  assemblyScore,
  planWaveOrder,
  selectFoundation,
  sortPiecesInWave,
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
});
