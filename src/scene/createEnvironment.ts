import * as THREE from 'three';
import { COLORS } from '../utils/colors';

export function createEnvironment(scene: THREE.Scene): void {
  // Cool hangar void — lighter so the figure doesn't sink into pure black
  scene.background = new THREE.Color(0x0c1220);
  scene.fog = new THREE.FogExp2(0x0c1220, 0.014);

  // Subtle ground disc for grounding the figure
  const groundGeo = new THREE.CircleGeometry(4.5, 64);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x080a12,
    metalness: 0.9,
    roughness: 0.42,
    transparent: true,
    opacity: 0.9,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.name = 'ground';
  scene.add(ground);

  // Cool cyan inner ring
  const ringGeo = new THREE.RingGeometry(1.15, 1.2, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x5ec8ff,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  // Soft outer ring — muted red so armor still anchors
  const outerGeo = new THREE.RingGeometry(2.4, 2.45, 64);
  const outerMat = new THREE.MeshBasicMaterial({
    color: COLORS.red,
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide,
  });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = 0.012;
  scene.add(outer);
}
