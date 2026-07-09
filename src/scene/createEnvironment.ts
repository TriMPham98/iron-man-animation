import * as THREE from 'three';
import { COLORS } from '../utils/colors';

export function createEnvironment(scene: THREE.Scene): void {
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.FogExp2(COLORS.fog, 0.028);

  // Subtle ground disc for grounding the figure
  const groundGeo = new THREE.CircleGeometry(4.5, 64);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0e,
    metalness: 0.85,
    roughness: 0.55,
    transparent: true,
    opacity: 0.85,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.name = 'ground';
  scene.add(ground);

  // Thin gold ring on the floor
  const ringGeo = new THREE.RingGeometry(1.15, 1.2, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: COLORS.gold,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  // Soft outer glow ring
  const outerGeo = new THREE.RingGeometry(2.4, 2.45, 64);
  const outerMat = new THREE.MeshBasicMaterial({
    color: COLORS.red,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
  });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = 0.012;
  scene.add(outer);
}
