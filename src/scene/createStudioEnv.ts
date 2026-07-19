import * as THREE from 'three';

/**
 * Bake a warm studio PMREM so gold metal keeps color in reflections.
 * Disposes the PMREM generator after use.
 */
export function applyStudioEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0a0e18);
  envScene.add(new THREE.HemisphereLight(0xc0d4f0, 0x1a1018, 1.8));
  const envKey = new THREE.DirectionalLight(0xfff2dc, 4.0);
  envKey.position.set(3, 8, 2);
  envScene.add(envKey);
  const envKey2 = new THREE.DirectionalLight(0xffe8c8, 2.4);
  envKey2.position.set(-2, 4, 5);
  envScene.add(envKey2);
  const envRim = new THREE.DirectionalLight(0x66d0e8, 2.2);
  envRim.position.set(-5, 3, -3);
  envScene.add(envRim);
  // Cool rear for env reflections when orbiting behind the suit
  const envBack = new THREE.DirectionalLight(0x7ec8e8, 2.0);
  envBack.position.set(1, 3.5, -5.5);
  envScene.add(envBack);
  const envHot = new THREE.DirectionalLight(0xfff0e0, 2.8);
  envHot.position.set(0, 2, 6);
  envScene.add(envHot);
  const envMap = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 1.15;
  pmrem.dispose();
}
