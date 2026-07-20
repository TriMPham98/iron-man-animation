import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ArmorPiece } from '../suit/waves';
import {
  entryFromPiece,
  formatReclassCard,
  shortPieceId,
} from './reclassCard';

function piece(
  id: string,
  wave: ArmorPiece['wave'],
  x: number,
  y: number,
  z: number,
): ArmorPiece {
  const geo = new THREE.BufferGeometry();
  // Rest-local verts; world = local + rest
  const positions = new Float32Array([
    0.1, 0, 0, -0.05, 0.02, 0, 0.02, -0.01, 0.03,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  return {
    id,
    mesh,
    wave,
    restPosition: new THREE.Vector3(x, y, z),
    restRotation: new THREE.Euler(),
    restScale: new THREE.Vector3(1, 1, 1),
    startPosition: new THREE.Vector3(),
    startRotation: new THREE.Euler(),
    startScale: new THREE.Vector3(1, 1, 1),
  };
}

describe('reclassCard', () => {
  it('shortPieceId formats shard indices', () => {
    expect(shortPieceId('shard-392-helmet', 'helmet')).toBe('helmet#392');
  });

  it('entryFromPiece measures geometry in rest space', () => {
    const p = piece('shard-392-helmet', 'helmet', 0.19, 1.525, 0.008);
    const e = entryFromPiece(p, 'shoulders', 'pauldron top');
    expect(e.short).toBe('helmet#392');
    expect(e.from).toBe('helmet');
    expect(e.to).toBe('shoulders');
    expect(e.rest.x).toBeCloseTo(0.19);
    expect(e.maxAbsX).toBeCloseTo(0.19 + 0.1, 2);
    expect(e.verts).toBe(3);
    expect(e.note).toBe('pauldron top');
  });

  it('formatReclassCard emits pasteable markdown + json', () => {
    const p = piece('shard-392-helmet', 'helmet', -0.1895, 1.5253, 0.0076);
    const card = formatReclassCard([entryFromPiece(p, 'shoulders')]);
    expect(card).toContain('### RECLASS CARD');
    expect(card).toContain('helmet#392');
    expect(card).toContain('`helmet` → `shoulders`');
    expect(card).toContain('```json');
    expect(card).toContain('"to": "shoulders"');
  });
});
