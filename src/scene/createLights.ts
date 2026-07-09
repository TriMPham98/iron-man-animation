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
 * Readable dark metal with warm keys so gold specular stays gold (not pure white).
 */
export function createLights(): SceneLights {
  const group = new THREE.Group();
  group.name = 'lights';

  const ambient = new THREE.AmbientLight(0x4a5570, 1.25);
  group.add(ambient);

  const hemi = new THREE.HemisphereLight(0xa8c4e8, 0x2a1820, 1.55);
  group.add(hemi);

  // Warm-white key — gold F0 * warm light keeps yellow specular
  const key = new THREE.DirectionalLight(0xfff0dd, 3.6);
  key.position.set(4, 7.5, 3.5);
  group.add(key);

  // Cool cyan rim for red plate edges (lower so it doesn't bleach gold)
  const rim = new THREE.DirectionalLight(0x7ad4f0, 2.2);
  rim.position.set(-5, 3.8, -3.2);
  group.add(rim);

  const fill = new THREE.DirectionalLight(0xb0a0e0, 1.15);
  fill.position.set(-2.8, 1.8, 3.5);
  group.add(fill);

  // Soft warm front — readable face/chest without white clipping
  const front = new THREE.DirectionalLight(0xfff5ea, 2.6);
  front.position.set(0.4, 2.8, 5.5);
  group.add(front);

  const frontSide = new THREE.DirectionalLight(0xffe8d0, 1.6);
  frontSide.position.set(3.2, 2, 4.5);
  group.add(frontSide);

  const kick = new THREE.DirectionalLight(0x5ec8d8, 0.7);
  kick.position.set(0.2, -1.8, 2.8);
  group.add(kick);

  const reactor = new THREE.PointLight(0x9ef0ff, 0, 11, 1.5);
  reactor.position.set(0, 1.25, 0.5);
  group.add(reactor);

  return { ambient, hemi, key, rim, fill, front, kick, reactor, group };
}
