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
 * Per-wave fly-in bias — plates arrive from anatomically sensible directions
 * (boots from below, helmet from above/front, limbs from the sides).
 */
export interface ScatterBias {
  /** Extra world-Y offset added to the shell sample (negative = from below). */
  y: number;
  /** Push outward from spine in XZ (0 = pure sphere sample). */
  radial: number;
  /** Bias toward +Z (camera / front of suit). */
  front: number;
}

const WAVE_SCATTER: Record<string, ScatterBias> = {
  boots: { y: -2.8, radial: 0.35, front: 0.15 },
  calves: { y: -1.2, radial: 0.9, front: 0.1 },
  thighs: { y: -0.35, radial: 1.05, front: 0.15 },
  hips: { y: 0.15, radial: 0.7, front: 0.45 },
  torso: { y: 0.55, radial: 0.55, front: 0.95 },
  shoulders: { y: 1.7, radial: 1.15, front: 0.25 },
  arms: { y: 0.25, radial: 1.65, front: 0.05 },
  gauntlets: { y: 0.05, radial: 1.9, front: 0.35 },
  helmet: { y: 3.2, radial: 0.25, front: 1.35 },
  power: { y: 0.4, radial: 0.15, front: 2.1 },
};

const DEFAULT_BIAS: ScatterBias = { y: 1.2, radial: 0.4, front: 0.2 };

/**
 * Scatter a start position on a spherical shell around the rest pose,
 * biased by body region so each wave reads as a directional arrival.
 */
export function scatterStart(
  rest: THREE.Vector3,
  seed: string,
  radiusMin = 4.5,
  radiusMax = 9.5,
  wave?: string,
): THREE.Vector3 {
  const r1 = hashSeed(seed + ':a');
  const r2 = hashSeed(seed + ':b');
  const r3 = hashSeed(seed + ':c');
  const bias = (wave && WAVE_SCATTER[wave]) || DEFAULT_BIAS;

  const theta = r1 * Math.PI * 2;
  const phi = Math.acos(2 * r2 - 1);
  const radius = radiusMin + r3 * (radiusMax - radiusMin);

  const offset = new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta) * 0.75,
    radius * Math.cos(phi),
  );

  // Region bias
  offset.y += bias.y + r1 * 0.9;

  // Push away from spine so limbs don't spawn through the torso
  const lateral = Math.hypot(rest.x, rest.z) || 1e-4;
  offset.x += (rest.x / lateral) * bias.radial * radius * 0.22;
  offset.z += (rest.z / lateral) * bias.radial * radius * 0.22;

  // Front-of-suit bias (+Z in model space after normalize)
  offset.z += bias.front * (0.55 + r2 * 0.65);

  // Small lateral jitter so plates don't stack on one ray
  offset.x += (r3 - 0.5) * 1.1;
  offset.z += (r1 - 0.5) * 0.7;

  return rest.clone().add(offset);
}

export function scatterRotation(seed: string): THREE.Euler {
  const rx = (hashSeed(seed + ':rx') - 0.5) * Math.PI * 2.4;
  const ry = (hashSeed(seed + ':ry') - 0.5) * Math.PI * 2.4;
  const rz = (hashSeed(seed + ':rz') - 0.5) * Math.PI * 2.4;
  return new THREE.Euler(rx, ry, rz);
}

export interface MagneticPath {
  /** Curved mid-flight control point. */
  waypoint: THREE.Vector3;
  /** Point just shy of the socket (end of approach phase). */
  approach: THREE.Vector3;
  /** Slight past-rest overshoot for the clamp hit. */
  overshoot: THREE.Vector3;
}

/** Reflect a free vector across the YZ plane (left ↔ right). */
export function mirrorOffsetX(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(-v.x, v.y, v.z);
}

/**
 * Mirror `point` relative to `restSource` onto the frame of `restTarget`.
 * offset = point − restSource → (−ox, oy, oz) applied at restTarget.
 */
export function mirrorPointAroundRest(
  point: THREE.Vector3,
  restSource: THREE.Vector3,
  restTarget: THREE.Vector3,
): THREE.Vector3 {
  const o = point.clone().sub(restSource);
  return restTarget.clone().add(mirrorOffsetX(o));
}

/** Mirror start pose so L/R pairs share a bilateral scatter offset from rest. */
export function mirrorStartAroundRest(
  startSource: THREE.Vector3,
  restSource: THREE.Vector3,
  restTarget: THREE.Vector3,
): THREE.Vector3 {
  return mirrorPointAroundRest(startSource, restSource, restTarget);
}

/**
 * Mirror Euler for a left↔right plate (reflect across YZ).
 * Keep X (pitch), flip Y/Z (yaw/roll).
 */
export function mirrorEulerYZ(e: THREE.Euler): THREE.Euler {
  return new THREE.Euler(e.x, -e.y, -e.z, e.order);
}

/** Mirror every control point of a magnetic path around a new rest. */
export function mirrorPathAroundRest(
  path: MagneticPath,
  restSource: THREE.Vector3,
  restTarget: THREE.Vector3,
): MagneticPath {
  return {
    waypoint: mirrorPointAroundRest(path.waypoint, restSource, restTarget),
    approach: mirrorPointAroundRest(path.approach, restSource, restTarget),
    overshoot: mirrorPointAroundRest(path.overshoot, restSource, restTarget),
  };
}

/**
 * Build a two-phase magnetic path: arc in → near-socket approach → overshoot
 * past rest for a mechanical clamp. Deterministic per seed.
 */
export function magneticPath(
  start: THREE.Vector3,
  rest: THREE.Vector3,
  seed: string,
  options: { overshoot?: number; helmet?: boolean } = {},
): MagneticPath {
  const r1 = hashSeed(seed + ':mw');
  const r2 = hashSeed(seed + ':mw2');
  const r3 = hashSeed(seed + ':mw3');

  const dir = rest.clone().sub(start);
  const len = Math.max(dir.length(), 1e-4);
  const dirN = dir.clone().multiplyScalar(1 / len);

  // Arc waypoint ~55–65% along travel, offset perpendicular for a curve
  const waypoint = start.clone().lerp(rest, 0.55 + r1 * 0.1);
  const up = new THREE.Vector3(0, 1, 0);
  let side = new THREE.Vector3().crossVectors(dirN, up);
  if (side.lengthSq() < 1e-6) {
    side.crossVectors(dirN, new THREE.Vector3(1, 0, 0));
  }
  side.normalize();
  const lift = new THREE.Vector3().crossVectors(side, dirN).normalize();

  const amp = len * (0.07 + r2 * 0.11);
  waypoint.addScaledVector(side, (r3 - 0.5) * 2 * amp);
  waypoint.addScaledVector(lift, amp * (0.25 + r1 * 0.35));

  // Approach: slightly short of rest (helmet closer / gentler)
  const shy = options.helmet ? 0.022 : 0.04 + r2 * 0.02;
  const approach = rest.clone().addScaledVector(dirN, -shy * Math.min(len, 2.5));

  // Overshoot past socket — subtle clamp seat (helmet almost none)
  const oh =
    options.overshoot ??
    (options.helmet ? 0.005 + r1 * 0.003 : 0.014 + r1 * 0.01);
  const overshoot = rest.clone().addScaledVector(dirN, oh);

  return { waypoint, approach, overshoot };
}
