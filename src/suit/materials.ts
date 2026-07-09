import * as THREE from 'three';
import { COLORS } from '../utils/colors';

export type ArmorMaterialKind = 'red' | 'gold' | 'dark' | 'core';

export interface SuitMaterials {
  red: THREE.MeshPhysicalMaterial;
  gold: THREE.MeshPhysicalMaterial;
  dark: THREE.MeshPhysicalMaterial;
  core: THREE.MeshStandardMaterial;
  reactorRing: THREE.MeshPhysicalMaterial;
  reactorCore: THREE.MeshPhysicalMaterial;
  eye: THREE.MeshPhysicalMaterial;
  dispose: () => void;
}

export function createSuitMaterials(): SuitMaterials {
  const red = new THREE.MeshPhysicalMaterial({
    color: COLORS.red,
    metalness: 0.92,
    roughness: 0.28,
    clearcoat: 0.55,
    clearcoatRoughness: 0.25,
    envMapIntensity: 1.45,
  });

  const gold = new THREE.MeshPhysicalMaterial({
    color: COLORS.gold,
    metalness: 0.95,
    roughness: 0.22,
    clearcoat: 0.6,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.55,
  });

  const dark = new THREE.MeshPhysicalMaterial({
    color: COLORS.dark,
    metalness: 0.75,
    roughness: 0.45,
    envMapIntensity: 1.0,
  });

  const core = new THREE.MeshStandardMaterial({
    color: COLORS.core,
    metalness: 0.2,
    roughness: 0.85,
  });

  const reactorRing = new THREE.MeshPhysicalMaterial({
    color: COLORS.gold,
    metalness: 0.9,
    roughness: 0.2,
    emissive: COLORS.reactor,
    emissiveIntensity: 0,
  });

  const reactorCore = new THREE.MeshPhysicalMaterial({
    color: COLORS.reactorCore,
    metalness: 0.3,
    roughness: 0.15,
    emissive: COLORS.reactor,
    emissiveIntensity: 0,
    transparent: true,
    opacity: 0.95,
  });

  const eye = new THREE.MeshPhysicalMaterial({
    color: COLORS.eye,
    metalness: 0.4,
    roughness: 0.2,
    emissive: COLORS.eye,
    emissiveIntensity: 0,
  });

  return {
    red,
    gold,
    dark,
    core,
    reactorRing,
    reactorCore,
    eye,
    dispose: () => {
      red.dispose();
      gold.dispose();
      dark.dispose();
      core.dispose();
      reactorRing.dispose();
      reactorCore.dispose();
      eye.dispose();
    },
  };
}

export function pickMaterial(
  mats: SuitMaterials,
  kind: ArmorMaterialKind,
): THREE.Material {
  switch (kind) {
    case 'red':
      return mats.red;
    case 'gold':
      return mats.gold;
    case 'dark':
      return mats.dark;
    case 'core':
      return mats.core;
  }
}
