import * as THREE from 'three';
import { SUIT_GROUND_CLEARANCE } from '../suit/loadSuitModel';

export function createCamera(): THREE.PerspectiveCamera {
  // Slightly tighter FOV + closer start for armor detail
  const camera = new THREE.PerspectiveCamera(
    34,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  // Match assembly path height (suit feet sit at SUIT_GROUND_CLEARANCE)
  const g = SUIT_GROUND_CLEARANCE;
  camera.position.set(0, 1.25 + g, 4.6);
  camera.lookAt(0, 0.95 + g, 0);
  return camera;
}

export function updateCameraAspect(camera: THREE.PerspectiveCamera): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
