import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { armorPieceDef, type ArmorPieceId } from '../suit/armorPieces';
import type { ArmorPiece } from '../suit/waves';
import {
  entryFromPiece,
  formatReclassCard,
  shortPieceId,
} from './reclassCard';

function piece(
  id: ArmorPieceId,
  x: number,
  y: number,
  z: number,
): ArmorPiece {
  const def = armorPieceDef(id);
  const geo = new THREE.BufferGeometry();
  // Model-space verts around the rest centroid
  const local = [0.1, 0, 0, -0.05, 0.02, 0, 0.02, -0.01, 0.03];
  const positions = new Float32Array(
    local.map((v, i) => v + [x, y, z][i % 3]),
  );
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  return {
    id,
    label: def.label,
    mesh,
    wave: def.wave,
    anchor: def.anchor,
    restPosition: new THREE.Vector3(x, y, z),
    def,
  };
}

describe('reclassCard', () => {
  it('shortPieceId formats shard indices', () => {
    expect(shortPieceId('shard-392-helmet', 'helmet')).toBe('helmet#392');
  });

  it('entryFromPiece measures geometry in rest space', () => {
    const p = piece('helmet', 0.19, 1.525, 0.008);
    const e = entryFromPiece(p, 'shoulders', 'pauldron top');
    expect(e.short).toBe('helmet');
    expect(e.from).toBe('helmet');
    expect(e.to).toBe('shoulders');
    expect(e.rest.x).toBeCloseTo(0.19);
    expect(e.maxAbsX).toBeCloseTo(0.19 + 0.1, 2);
    expect(e.verts).toBe(3);
    expect(e.note).toBe('pauldron top');
  });

  it('formatReclassCard emits pasteable markdown + json', () => {
    const p = piece('pauldron.R', -0.1895, 1.5253, 0.0076);
    const card = formatReclassCard([entryFromPiece(p, 'helmet')]);
    expect(card).toContain('### RECLASS CARD');
    expect(card).toContain('shoulders/pauldron.R');
    expect(card).toContain('`shoulders` → `helmet`');
    expect(card).toContain('```json');
    expect(card).toContain('"to": "helmet"');
  });
});
