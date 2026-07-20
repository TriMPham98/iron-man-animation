import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  isUpperFaceplateShellRest,
  mergeUpperFaceplateShells,
} from './loadSuitModel';
import type { ArmorPiece } from './waves';

function piece(
  id: string,
  rest: THREE.Vector3,
  verts = 9,
): ArmorPiece {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(verts * 3);
  // Tiny local blob around origin (mesh sits at rest)
  for (let i = 0; i < verts; i++) {
    positions[i * 3] = (i % 3) * 0.001;
    positions[i * 3 + 1] = ((i + 1) % 3) * 0.001;
    positions[i * 3 + 2] = ((i + 2) % 3) * 0.001;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.position.copy(rest);
  return {
    id,
    mesh,
    wave: 'helmet',
    restPosition: rest.clone(),
    restRotation: new THREE.Euler(),
    restScale: new THREE.Vector3(1, 1, 1),
    startPosition: rest.clone().add(new THREE.Vector3(0, 0, 2)),
    startRotation: new THREE.Euler(),
    startScale: new THREE.Vector3(0.08, 0.08, 0.08),
  };
}

describe('isUpperFaceplateShellRest', () => {
  it('matches high-tier helmet#363 / #400 rest poses', () => {
    // Measured from high-tier split: dual front-center stack
    expect(
      isUpperFaceplateShellRest(new THREE.Vector3(-0.0054, 1.7244, 0.0919)),
    ).toBe(true);
    expect(
      isUpperFaceplateShellRest(new THREE.Vector3(-0.0098, 1.7677, 0.0977)),
    ).toBe(true);
  });

  it('rejects mid-face / cheek / cranial shells', () => {
    // helmet#333 mid-face (pairs with 363 without the merge)
    expect(
      isUpperFaceplateShellRest(new THREE.Vector3(0.0047, 1.6685, 0.0993)),
    ).toBe(false);
    // cheek
    expect(
      isUpperFaceplateShellRest(new THREE.Vector3(0.12, 1.61, 0.05)),
    ).toBe(false);
    // crown back
    expect(
      isUpperFaceplateShellRest(new THREE.Vector3(-0.009, 1.715, -0.004)),
    ).toBe(false);
  });
});

describe('mergeUpperFaceplateShells', () => {
  it('fuses 363+400-style shells into one piece', () => {
    const group = new THREE.Group();
    const a = piece('shard-363-helmet', new THREE.Vector3(-0.005, 1.724, 0.092), 12);
    const b = piece('shard-400-helmet', new THREE.Vector3(-0.01, 1.768, 0.098), 6);
    const cheek = piece('shard-338-helmet', new THREE.Vector3(0.12, 1.61, 0.05), 9);
    group.add(a.mesh, b.mesh, cheek.mesh);

    const out = mergeUpperFaceplateShells([a, b, cheek], group);

    expect(out).toHaveLength(2);
    expect(out.map((p) => p.id).sort()).toEqual([
      'shard-363-helmet', // larger vert count kept
      'shard-338-helmet',
    ].sort());
    expect(group.children).toHaveLength(2);
    // Combined geometry has verts from both shells
    const kept = out.find((p) => p.id === 'shard-363-helmet')!;
    const pos = (kept.mesh as THREE.Mesh).geometry.getAttribute('position');
    expect(pos.count).toBe(18);
  });

  it('is a no-op when only one upper shell exists', () => {
    const group = new THREE.Group();
    const a = piece('only', new THREE.Vector3(0, 1.74, 0.09));
    group.add(a.mesh);
    const out = mergeUpperFaceplateShells([a], group);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(a);
  });
});
