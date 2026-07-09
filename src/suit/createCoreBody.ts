import * as THREE from 'three';
import type { SuitMaterials } from './materials';

/**
 * Dark under-suit / endoskeleton silhouette.
 * Visible in gaps during assembly; proportions match Mark-style armor.
 */
export function createCoreBody(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'coreBody';
  const m = mats.core;
  const joint = mats.darkMetal;

  const add = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    sx = 1,
    sy = 1,
    sz = 1,
    rx = 0,
    ry = 0,
    rz = 0,
  ) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.rotation.set(rx, ry, rz);
    g.add(mesh);
  };

  // Head / neck
  add(new THREE.SphereGeometry(0.125, 24, 18), m, 0, 1.72, 0, 1, 1.08, 1.02);
  add(new THREE.CylinderGeometry(0.055, 0.065, 0.09, 16), m, 0, 1.58, 0);

  // Torso (muscular taper)
  add(new THREE.CapsuleGeometry(0.2, 0.42, 8, 16), m, 0, 1.2, 0, 1.05, 1, 0.82);
  add(new THREE.SphereGeometry(0.2, 16, 12), m, 0, 0.9, 0, 1.2, 0.65, 0.95);

  // Legs
  add(new THREE.CapsuleGeometry(0.085, 0.3, 6, 12), m, -0.125, 0.55, 0);
  add(new THREE.CapsuleGeometry(0.085, 0.3, 6, 12), m, 0.125, 0.55, 0);
  add(new THREE.CapsuleGeometry(0.07, 0.3, 6, 12), m, -0.125, 0.22, 0);
  add(new THREE.CapsuleGeometry(0.07, 0.3, 6, 12), m, 0.125, 0.22, 0);

  // Feet
  add(new THREE.BoxGeometry(0.11, 0.05, 0.22), m, -0.125, 0.03, 0.04);
  add(new THREE.BoxGeometry(0.11, 0.05, 0.22), m, 0.125, 0.03, 0.04);

  // Arms — slightly open heroic stance
  add(
    new THREE.CapsuleGeometry(0.06, 0.24, 6, 12),
    m,
    -0.4,
    1.28,
    0,
    1,
    1,
    1,
    0,
    0,
    0.2,
  );
  add(
    new THREE.CapsuleGeometry(0.06, 0.24, 6, 12),
    m,
    0.4,
    1.28,
    0,
    1,
    1,
    1,
    0,
    0,
    -0.2,
  );
  add(
    new THREE.CapsuleGeometry(0.05, 0.24, 6, 12),
    m,
    -0.55,
    0.96,
    0.02,
    1,
    1,
    1,
    0.12,
    0,
    0.12,
  );
  add(
    new THREE.CapsuleGeometry(0.05, 0.24, 6, 12),
    m,
    0.55,
    0.96,
    0.02,
    1,
    1,
    1,
    0.12,
    0,
    -0.12,
  );

  // Joint rings (visible mechanical understructure)
  const joints: Array<[number, number, number, number]> = [
    [-0.125, 0.42, 0, 0.09],
    [0.125, 0.42, 0, 0.09],
    [-0.125, 0.72, 0, 0.095],
    [0.125, 0.72, 0, 0.095],
    [-0.4, 1.14, 0, 0.07],
    [0.4, 1.14, 0, 0.07],
    [-0.52, 0.82, 0.02, 0.06],
    [0.52, 0.82, 0.02, 0.06],
  ];
  for (const [x, y, z, r] of joints) {
    add(new THREE.TorusGeometry(r, 0.012, 8, 20), joint, x, y, z, 1, 1, 1, Math.PI / 2);
  }

  return g;
}
