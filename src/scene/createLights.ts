import * as THREE from 'three';

export interface SceneLights {
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  front: THREE.DirectionalLight;
  kick: THREE.DirectionalLight;
  /** Chest arc reactor spill */
  reactor: THREE.PointLight;
  /** Face-mask eye slits */
  eyes: THREE.PointLight;
  /** Palm repulsors */
  leftHand: THREE.PointLight;
  rightHand: THREE.PointLight;
  /** Boot thrusters */
  leftFoot: THREE.PointLight;
  rightFoot: THREE.PointLight;
  /** All systems lights (reactor + eyes + hands + feet) */
  systems: THREE.PointLight[];
  group: THREE.Group;
}

/**
 * Readable dark metal with warm keys so gold specular stays gold (not pure white).
 * System point lights start at intensity 0 and ignite on power-up.
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

  // --- Suit systems (off until armor locked + power-up) ---
  // Positions match ~1.85 m normalized Mark III pose, facing +Z.
  const reactor = new THREE.PointLight(0x9ef0ff, 0, 2.4, 1.6);
  reactor.name = 'reactorLight';
  reactor.position.set(0, 1.22, 0.42);
  group.add(reactor);

  const eyes = new THREE.PointLight(0xfff0c8, 0, 1.1, 1.8);
  eyes.name = 'eyeLight';
  eyes.position.set(0, 1.62, 0.32);
  group.add(eyes);

  const leftHand = new THREE.PointLight(0x7ae8ff, 0, 1.0, 2.0);
  leftHand.name = 'leftHandRepulsor';
  leftHand.position.set(0.58, 0.82, 0.18);
  group.add(leftHand);

  const rightHand = new THREE.PointLight(0x7ae8ff, 0, 1.0, 2.0);
  rightHand.name = 'rightHandRepulsor';
  rightHand.position.set(-0.58, 0.82, 0.18);
  group.add(rightHand);

  const leftFoot = new THREE.PointLight(0x6ed8ff, 0, 0.9, 2.0);
  leftFoot.name = 'leftFootThruster';
  leftFoot.position.set(0.16, 0.05, 0.14);
  group.add(leftFoot);

  const rightFoot = new THREE.PointLight(0x6ed8ff, 0, 0.9, 2.0);
  rightFoot.name = 'rightFootThruster';
  rightFoot.position.set(-0.16, 0.05, 0.14);
  group.add(rightFoot);

  const systems = [reactor, eyes, leftHand, rightHand, leftFoot, rightFoot];

  return {
    ambient,
    hemi,
    key,
    rim,
    fill,
    front,
    kick,
    reactor,
    eyes,
    leftHand,
    rightHand,
    leftFoot,
    rightFoot,
    systems,
    group,
  };
}

/** Full-power intensities for each systems light (scaled by power 0–1). */
export const SYSTEM_LIGHT_MAX: Record<string, number> = {
  reactorLight: 1.8,
  eyeLight: 0.7,
  leftHandRepulsor: 0.9,
  rightHandRepulsor: 0.9,
  leftFootThruster: 0.65,
  rightFootThruster: 0.65,
};

export function setSystemsPower(lights: SceneLights, power: number): void {
  const p = THREE.MathUtils.clamp(power, 0, 1);
  for (const light of lights.systems) {
    const max = SYSTEM_LIGHT_MAX[light.name] ?? 2;
    light.intensity = p * max;
  }
}
