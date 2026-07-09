import * as THREE from 'three';
import type { SuitMaterials } from './materials';

/** Dark under-suit mannequin so gaps read during assembly. */
export function createCoreBody(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'coreBody';
  const m = mats.core;

  const add = (
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    sx = 1,
    sy = 1,
    sz = 1,
  ) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    g.add(mesh);
  };

  // Head
  add(new THREE.SphereGeometry(0.14, 16, 12), 0, 1.72, 0);
  // Neck
  add(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 12), 0, 1.56, 0);
  // Torso
  add(new THREE.CapsuleGeometry(0.22, 0.38, 6, 12), 0, 1.2, 0, 1, 1, 0.85);
  // Hips
  add(new THREE.SphereGeometry(0.18, 12, 10), 0, 0.88, 0, 1.15, 0.7, 0.9);
  // Upper legs
  add(new THREE.CapsuleGeometry(0.09, 0.28, 4, 10), -0.12, 0.55, 0);
  add(new THREE.CapsuleGeometry(0.09, 0.28, 4, 10), 0.12, 0.55, 0);
  // Lower legs
  add(new THREE.CapsuleGeometry(0.075, 0.28, 4, 10), -0.12, 0.22, 0);
  add(new THREE.CapsuleGeometry(0.075, 0.28, 4, 10), 0.12, 0.22, 0);
  // Feet stubs
  add(new THREE.BoxGeometry(0.12, 0.06, 0.2), -0.12, 0.03, 0.03);
  add(new THREE.BoxGeometry(0.12, 0.06, 0.2), 0.12, 0.03, 0.03);
  // Upper arms (slightly out)
  add(new THREE.CapsuleGeometry(0.065, 0.22, 4, 10), -0.38, 1.28, 0);
  add(new THREE.CapsuleGeometry(0.065, 0.22, 4, 10), 0.38, 1.28, 0);
  // Forearms
  add(new THREE.CapsuleGeometry(0.055, 0.22, 4, 10), -0.52, 0.95, 0.02);
  add(new THREE.CapsuleGeometry(0.055, 0.22, 4, 10), 0.52, 0.95, 0.02);

  return g;
}
