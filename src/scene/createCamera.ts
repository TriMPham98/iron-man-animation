import * as THREE from 'three';

export function createCamera(): THREE.PerspectiveCamera {
  // Slightly tighter FOV + closer start for armor detail
  const camera = new THREE.PerspectiveCamera(
    34,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.position.set(0, 1.25, 4.6);
  camera.lookAt(0, 0.95, 0);
  return camera;
}

export function updateCameraAspect(camera: THREE.PerspectiveCamera): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
