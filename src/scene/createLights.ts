import * as THREE from 'three';

export interface SceneLights {
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  reactor: THREE.PointLight;
  group: THREE.Group;
}

export function createLights(): SceneLights {
  const group = new THREE.Group();
  group.name = 'lights';

  const ambient = new THREE.AmbientLight(0x2a2a3a, 0.85);
  group.add(ambient);

  const hemi = new THREE.HemisphereLight(0x5577aa, 0x221018, 1.1);
  group.add(hemi);

  const key = new THREE.DirectionalLight(0xfff0e0, 2.4);
  key.position.set(3.5, 6, 4);
  group.add(key);

  const rim = new THREE.DirectionalLight(0xaaccff, 1.5);
  rim.position.set(-4, 2.5, -3);
  group.add(rim);

  const fill = new THREE.DirectionalLight(0xff8899, 0.7);
  fill.position.set(-2, 1, 3);
  group.add(fill);

  // Front bounce so the chest/face don't fall into shadow
  const front = new THREE.DirectionalLight(0xe8f0ff, 1.1);
  front.position.set(0.5, 2.2, 5);
  group.add(front);

  const reactor = new THREE.PointLight(0x7ee8ff, 0, 8, 1.8);
  reactor.position.set(0, 1.25, 0.35);
  group.add(reactor);

  return { ambient, hemi, key, rim, fill, reactor, group };
}
