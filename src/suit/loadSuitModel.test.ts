import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  isHelmetFaceFloater,
  isUpperFaceplateShellRest,
  mergeHelmetFaceFloaters,
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

describe('isHelmetFaceFloater', () => {
  it('matches high-tier face/crown scraps (#318 / #353 / #364 / #378)', () => {
    expect(
      isHelmetFaceFloater(new THREE.Vector3(-0.0572, 1.6813, 0.0581), 21),
    ).toBe(true); // #318
    expect(
      isHelmetFaceFloater(new THREE.Vector3(-0.0369, 1.6637, 0.0994), 24),
    ).toBe(true); // #353
    expect(
      isHelmetFaceFloater(new THREE.Vector3(-0.048, 1.6871, 0.0903), 24),
    ).toBe(true); // #364
    expect(
      isHelmetFaceFloater(new THREE.Vector3(0.0511, 1.7936, 0.0396), 57),
    ).toBe(true); // #378
  });

  it('rejects large shells and lateral plates', () => {
    // Main faceplate host
    expect(
      isHelmetFaceFloater(new THREE.Vector3(0.005, 1.671, 0.101), 5664),
    ).toBe(false);
    // Lateral back scrap (too far out)
    expect(
      isHelmetFaceFloater(new THREE.Vector3(0.165, 1.585, -0.075), 60),
    ).toBe(false);
    // Mid-face plate with enough mass stays its own piece
    expect(
      isHelmetFaceFloater(new THREE.Vector3(0.005, 1.669, 0.099), 200),
    ).toBe(false);
  });
});

describe('mergeHelmetFaceFloaters', () => {
  it('absorbs #318/#353/#364/#378-style scraps into nearest large host', () => {
    const group = new THREE.Group();
    // Front faceplate host (~#347)
    const hostFace = piece(
      'shard-347-helmet',
      new THREE.Vector3(0.005, 1.671, 0.101),
      2000,
    );
    // Upper shell host (~#410)
    const hostUpper = piece(
      'shard-410-helmet',
      new THREE.Vector3(0, 1.744, 0.089),
      3000,
    );
    const f318 = piece(
      'shard-318-helmet',
      new THREE.Vector3(-0.057, 1.681, 0.058),
      21,
    );
    const f353 = piece(
      'shard-353-helmet',
      new THREE.Vector3(-0.037, 1.664, 0.099),
      24,
    );
    const f364 = piece(
      'shard-364-helmet',
      new THREE.Vector3(-0.048, 1.687, 0.09),
      24,
    );
    const f378 = piece(
      'shard-378-helmet',
      new THREE.Vector3(0.051, 1.794, 0.04),
      57,
    );
    // Unrelated large back shell must stay
    const back = piece(
      'shard-344-helmet',
      new THREE.Vector3(0.012, 1.669, -0.1),
      2500,
    );
    group.add(
      hostFace.mesh,
      hostUpper.mesh,
      f318.mesh,
      f353.mesh,
      f364.mesh,
      f378.mesh,
      back.mesh,
    );

    const out = mergeHelmetFaceFloaters(
      [hostFace, hostUpper, f318, f353, f364, f378, back],
      group,
    );

    expect(out.map((p) => p.id).sort()).toEqual(
      ['shard-347-helmet', 'shard-410-helmet', 'shard-344-helmet'].sort(),
    );
    expect(group.children).toHaveLength(3);

    const face = out.find((p) => p.id === 'shard-347-helmet')!;
    const faceVerts = (face.mesh as THREE.Mesh).geometry.getAttribute(
      'position',
    ).count;
    // host + #318 + #353 + #364
    expect(faceVerts).toBe(2000 + 21 + 24 + 24);

    const upper = out.find((p) => p.id === 'shard-410-helmet')!;
    const upperVerts = (upper.mesh as THREE.Mesh).geometry.getAttribute(
      'position',
    ).count;
    expect(upperVerts).toBe(3000 + 57);
  });

  it('is a no-op when no floaters match', () => {
    const group = new THREE.Group();
    const a = piece('big', new THREE.Vector3(0, 1.72, 0.09), 2000);
    group.add(a.mesh);
    const out = mergeHelmetFaceFloaters([a], group);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(a);
  });
});
