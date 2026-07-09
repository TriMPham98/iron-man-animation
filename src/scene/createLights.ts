import * as THREE from 'three';

export interface SceneLights {
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  front: THREE.DirectionalLight;
  kick: THREE.DirectionalLight;
  reactor: THREE.PointLight;
  group: THREE.Group;
}

/**
 * Bright cool hangar lighting — armor must read clearly, not crush to black.
 */
export function createLights(): SceneLights {
  const group = new THREE.Group();
  group.name = 'lights';

  // Strong cool ambient — lifts black metal textures out of the void
  const ambient = new THREE.AmbientLight(0x6a7a98, 2.4);
  group.add(ambient);

  const hemi = new THREE.HemisphereLight(0xb0d0ff, 0x3a2030, 2.8);
  group.add(hemi);

  // Main key — bright cool daylight
  const key = new THREE.DirectionalLight(0xffffff, 5.5);
  key.position.set(3.2, 7, 5);
  group.add(key);

  // Cyan rim
  const rim = new THREE.DirectionalLight(0x88e0ff, 3.2);
  rim.position.set(-5, 3.5, -3.5);
  group.add(rim);

  // Soft violet fill
  const fill = new THREE.DirectionalLight(0xc0b0ff, 2.0);
  fill.position.set(-3, 2, 4);
  group.add(fill);

  // Front plate — primary readability light
  const front = new THREE.DirectionalLight(0xffffff, 4.5);
  front.position.set(0, 2.5, 6);
  group.add(front);

  // Second front-side light
  const frontSide = new THREE.DirectionalLight(0xe8f4ff, 2.8);
  frontSide.position.set(2.5, 1.5, 4);
  group.add(frontSide);

  // Floor bounce
  const kick = new THREE.DirectionalLight(0x80e8ff, 1.4);
  kick.position.set(0, -2, 3);
  group.add(kick);

  const reactor = new THREE.PointLight(0x9ef0ff, 0, 12, 1.4);
  reactor.position.set(0, 1.25, 0.5);
  group.add(reactor);

  return { ambient, hemi, key, rim, fill, front, kick, reactor, group };
}
