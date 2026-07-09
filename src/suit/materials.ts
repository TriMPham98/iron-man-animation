import * as THREE from 'three';
import { COLORS } from '../utils/colors';

export type ArmorMaterialKind = 'red' | 'gold' | 'dark' | 'core';

export interface SuitMaterials {
  red: THREE.MeshPhysicalMaterial;
  redDeep: THREE.MeshPhysicalMaterial;
  gold: THREE.MeshPhysicalMaterial;
  goldDeep: THREE.MeshPhysicalMaterial;
  dark: THREE.MeshPhysicalMaterial;
  darkMetal: THREE.MeshPhysicalMaterial;
  core: THREE.MeshStandardMaterial;
  reactorRing: THREE.MeshPhysicalMaterial;
  reactorCore: THREE.MeshPhysicalMaterial;
  reactorGlow: THREE.MeshPhysicalMaterial;
  eye: THREE.MeshPhysicalMaterial;
  repulsor: THREE.MeshPhysicalMaterial;
  dispose: () => void;
}

/** Subtle brushed-metal roughness variation via canvas noise. */
function makeNoiseTexture(
  size = 256,
  base = 180,
  variance = 50,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = base + (Math.random() - 0.5) * variance;
    const v = Math.max(0, Math.min(255, n));
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Soft brushed streaks
  ctx.globalAlpha = 0.15;
  for (let y = 0; y < size; y += 2) {
    ctx.fillStyle = y % 4 === 0 ? '#fff' : '#000';
    ctx.fillRect(0, y, size, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeMetalFlakeNormal(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8080ff';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.5 + Math.random() * 1.5;
    const nx = 120 + Math.random() * 40;
    const ny = 120 + Math.random() * 40;
    ctx.fillStyle = `rgb(${nx | 0},${ny | 0},255)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export function createSuitMaterials(): SuitMaterials {
  const roughnessMap = makeNoiseTexture(256, 160, 70);
  const normalMap = makeMetalFlakeNormal(256);
  const goldRough = makeNoiseTexture(256, 140, 40);

  const red = new THREE.MeshPhysicalMaterial({
    color: COLORS.red,
    metalness: 0.96,
    roughness: 0.22,
    roughnessMap: roughnessMap,
    normalMap,
    normalScale: new THREE.Vector2(0.18, 0.18),
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    reflectivity: 1,
    envMapIntensity: 1.65,
    sheen: 0.15,
    sheenColor: new THREE.Color(COLORS.redHighlight),
    sheenRoughness: 0.4,
  });

  const redDeep = new THREE.MeshPhysicalMaterial({
    color: COLORS.redDeep,
    metalness: 0.94,
    roughness: 0.32,
    roughnessMap,
    normalMap,
    normalScale: new THREE.Vector2(0.12, 0.12),
    clearcoat: 0.5,
    clearcoatRoughness: 0.25,
    envMapIntensity: 1.3,
  });

  const gold = new THREE.MeshPhysicalMaterial({
    color: COLORS.gold,
    metalness: 0.98,
    roughness: 0.16,
    roughnessMap: goldRough,
    normalMap,
    normalScale: new THREE.Vector2(0.22, 0.22),
    clearcoat: 0.9,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.85,
    sheen: 0.25,
    sheenColor: new THREE.Color(COLORS.goldBright),
    sheenRoughness: 0.3,
  });

  const goldDeep = new THREE.MeshPhysicalMaterial({
    color: COLORS.goldDeep,
    metalness: 0.95,
    roughness: 0.28,
    roughnessMap: goldRough,
    clearcoat: 0.4,
    clearcoatRoughness: 0.3,
    envMapIntensity: 1.4,
  });

  const dark = new THREE.MeshPhysicalMaterial({
    color: COLORS.dark,
    metalness: 0.7,
    roughness: 0.55,
    roughnessMap,
    envMapIntensity: 0.85,
  });

  const darkMetal = new THREE.MeshPhysicalMaterial({
    color: COLORS.darkMetal,
    metalness: 0.88,
    roughness: 0.38,
    roughnessMap,
    normalMap,
    normalScale: new THREE.Vector2(0.15, 0.15),
    envMapIntensity: 1.15,
  });

  const core = new THREE.MeshStandardMaterial({
    color: COLORS.core,
    metalness: 0.35,
    roughness: 0.78,
  });

  const reactorRing = new THREE.MeshPhysicalMaterial({
    color: COLORS.gold,
    metalness: 0.95,
    roughness: 0.12,
    emissive: COLORS.reactor,
    emissiveIntensity: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.1,
  });

  const reactorCore = new THREE.MeshPhysicalMaterial({
    color: COLORS.reactorCore,
    metalness: 0.2,
    roughness: 0.08,
    emissive: COLORS.reactor,
    emissiveIntensity: 0,
    transparent: true,
    opacity: 0.92,
    transmission: 0.15,
    thickness: 0.4,
  });

  const reactorGlow = new THREE.MeshPhysicalMaterial({
    color: COLORS.reactor,
    metalness: 0.1,
    roughness: 0.2,
    emissive: COLORS.reactor,
    emissiveIntensity: 0,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });

  const eye = new THREE.MeshPhysicalMaterial({
    color: COLORS.eye,
    metalness: 0.35,
    roughness: 0.12,
    emissive: COLORS.eye,
    emissiveIntensity: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });

  const repulsor = new THREE.MeshPhysicalMaterial({
    color: COLORS.reactorCore,
    metalness: 0.4,
    roughness: 0.15,
    emissive: COLORS.reactor,
    emissiveIntensity: 0,
  });

  return {
    red,
    redDeep,
    gold,
    goldDeep,
    dark,
    darkMetal,
    core,
    reactorRing,
    reactorCore,
    reactorGlow,
    eye,
    repulsor,
    dispose: () => {
      roughnessMap.dispose();
      normalMap.dispose();
      goldRough.dispose();
      red.dispose();
      redDeep.dispose();
      gold.dispose();
      goldDeep.dispose();
      dark.dispose();
      darkMetal.dispose();
      core.dispose();
      reactorRing.dispose();
      reactorCore.dispose();
      reactorGlow.dispose();
      eye.dispose();
      repulsor.dispose();
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
