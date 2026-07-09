import * as THREE from 'three';

/** Deterministic pseudo-random from a string seed (mulberry-ish). */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Scatter a start position on a spherical shell around the rest pose,
 * biased outward so pieces fly in from off-screen.
 */
export function scatterStart(
  rest: THREE.Vector3,
  seed: string,
  radiusMin = 4.5,
  radiusMax = 9.5,
): THREE.Vector3 {
  const r1 = hashSeed(seed + ':a');
  const r2 = hashSeed(seed + ':b');
  const r3 = hashSeed(seed + ':c');

  const theta = r1 * Math.PI * 2;
  const phi = Math.acos(2 * r2 - 1);
  const radius = radiusMin + r3 * (radiusMax - radiusMin);

  const offset = new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta) * 0.85 + radius * 0.15,
    radius * Math.cos(phi),
  );

  // Bias slightly upward/outward for a more dramatic drop-in feel
  offset.y += 1.2 + r1 * 2.5;

  return rest.clone().add(offset);
}

export function scatterRotation(seed: string): THREE.Euler {
  const rx = (hashSeed(seed + ':rx') - 0.5) * Math.PI * 2.4;
  const ry = (hashSeed(seed + ':ry') - 0.5) * Math.PI * 2.4;
  const rz = (hashSeed(seed + ':rz') - 0.5) * Math.PI * 2.4;
  return new THREE.Euler(rx, ry, rz);
}
