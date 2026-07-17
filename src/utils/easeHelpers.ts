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
 * Frontal scatter profile — every plate approaches from +Z (camera side)
 * with wave-specific height and limb lateral spread.
 */
export interface WaveScatterProfile {
  /** Base meters in front of rest (+Z). */
  frontDist: number;
  /** Extra meters added by seed (0–frontSpread). */
  frontSpread: number;
  /** World-Y bias (boots negative, helmet positive). */
  y: number;
  /** Push outward on ±X using sign(rest.x); 0 for centerline waves. */
  lateral: number;
  /** Seed jitter scale on X/Y (Z jitter stays small and front-safe). */
  jitter: number;
}

const WAVE_FRONTAL: Record<string, WaveScatterProfile> = {
  boots: { frontDist: 1.8, frontSpread: 0.9, y: -2.2, lateral: 0.45, jitter: 0.35 },
  calves: { frontDist: 2.0, frontSpread: 1.0, y: -1.0, lateral: 0.7, jitter: 0.4 },
  thighs: { frontDist: 2.1, frontSpread: 1.0, y: -0.25, lateral: 0.85, jitter: 0.4 },
  hips: { frontDist: 2.2, frontSpread: 0.9, y: 0.1, lateral: 0.35, jitter: 0.35 },
  torso: { frontDist: 2.4, frontSpread: 1.0, y: 0.35, lateral: 0.25, jitter: 0.4 },
  shoulders: { frontDist: 2.2, frontSpread: 1.0, y: 1.1, lateral: 1.05, jitter: 0.4 },
  arms: { frontDist: 2.0, frontSpread: 1.1, y: 0.2, lateral: 1.35, jitter: 0.45 },
  gauntlets: { frontDist: 2.1, frontSpread: 1.0, y: -0.55, lateral: 1.5, jitter: 0.45 },
  // Cranial shell — above-front (not pure crown drop)
  helmet: { frontDist: 1.9, frontSpread: 0.8, y: 1.6, lateral: 0.15, jitter: 0.3 },
  power: { frontDist: 2.6, frontSpread: 0.7, y: 0.25, lateral: 0.1, jitter: 0.25 },
};

const DEFAULT_FRONTAL: WaveScatterProfile = {
  frontDist: 2.2,
  frontSpread: 1.0,
  y: 0.4,
  lateral: 0.4,
  jitter: 0.4,
};

/**
 * Front faceplate / mask (Mark III slam) — rest sits on the face (+Z),
 * not the cranial shell. Comes straight from in front of the head.
 */
export function isFaceplateRest(rest: THREE.Vector3): boolean {
  // Front of skull, near centerline (not cheek/back/cranial shell)
  return rest.z > 0.04 && Math.abs(rest.x) < 0.16 && rest.y > 1.28;
}

/**
 * Scatter start in the **front hemisphere** (+Z toward camera).
 * Wave still owns height; limbs keep sign(rest.x) lateral for L/R mirrors.
 *
 * `radiusMin` / `radiusMax` are kept for API compatibility and scale frontDist
 * when callers pass non-defaults (loadSuitModel uses 3.5–8.5).
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

  // Faceplate: strong frontal slam near eye line
  if (wave === 'helmet' && isFaceplateRest(rest)) {
    const frontDist = 2.1 + r1 * 1.4;
    return new THREE.Vector3(
      rest.x + (r3 - 0.5) * 0.2,
      rest.y + 0.08 + (r2 - 0.5) * 0.25,
      rest.z + frontDist,
    );
  }

  const profile = (wave && WAVE_FRONTAL[wave]) || DEFAULT_FRONTAL;

  // Map legacy radius range → scale so front cloud stays readable
  const midR = (radiusMin + radiusMax) * 0.5;
  const scale = THREE.MathUtils.clamp(midR / 6.5, 0.65, 1.35);

  const frontDist =
    (profile.frontDist + r1 * profile.frontSpread) * scale;
  const sideSign = Math.abs(rest.x) < 0.04 ? 0 : Math.sign(rest.x);
  const lateral =
    sideSign * (profile.lateral * scale) * (0.75 + r2 * 0.5);
  const yOff = profile.y * scale + (r3 - 0.5) * profile.jitter * scale;

  // Front-safe jitter: never push start behind rest on Z
  const jx = (r1 - 0.5) * profile.jitter * scale;
  const jz = r2 * 0.35 * scale; // only further forward

  return new THREE.Vector3(
    rest.x + lateral + jx,
    rest.y + yOff,
    rest.z + frontDist + jz,
  );
}

export function scatterRotation(
  seed: string,
  opts?: { rest?: THREE.Vector3; wave?: string },
): THREE.Euler {
  const r1 = hashSeed(seed + ':rx');
  const r2 = hashSeed(seed + ':ry');
  const r3 = hashSeed(seed + ':rz');

  // Faceplate: mild pitch only — reads as a mask closing from the front
  if (
    opts?.wave === 'helmet' &&
    opts.rest &&
    isFaceplateRest(opts.rest)
  ) {
    return new THREE.Euler(
      (r1 - 0.5) * 0.55,
      (r2 - 0.5) * 0.2,
      (r1 - 0.5) * 0.12,
    );
  }

  // Frontal approach: moderate tumble (not full random cartwheels)
  return new THREE.Euler(
    (r1 - 0.5) * Math.PI * 0.9,
    (r2 - 0.5) * Math.PI * 0.9,
    (r3 - 0.5) * Math.PI * 0.7,
  );
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
 *
 * When the start is strongly in front of rest (+Z), arcs stay mild so the
 * whole suit reads as flying in from the camera (faceplate is the extreme).
 */
export function magneticPath(
  start: THREE.Vector3,
  rest: THREE.Vector3,
  seed: string,
  options: { overshoot?: number; helmet?: boolean; faceplate?: boolean } = {},
): MagneticPath {
  const r1 = hashSeed(seed + ':mw');
  const r2 = hashSeed(seed + ':mw2');
  const r3 = hashSeed(seed + ':mw3');

  const faceplate = options.faceplate === true || isFaceplateRest(rest);
  const frontDelta = start.z - rest.z;
  const stronglyFrontal = frontDelta > 0.8;

  const dir = rest.clone().sub(start);
  const len = Math.max(dir.length(), 1e-4);
  const dirN = dir.clone().multiplyScalar(1 / len);

  // Faceplate / strong frontal: nearly linear approach
  if (faceplate || stronglyFrontal) {
    const waypoint = start.clone().lerp(rest, 0.55 + r1 * 0.08);
    // Keep waypoint in front of rest; small height settle
    waypoint.y += (faceplate ? 0.06 : 0.03) + r1 * 0.04;
    waypoint.x += (r3 - 0.5) * (faceplate ? 0.08 : 0.14);
    // Never pull waypoint behind the rest on Z
    if (waypoint.z < rest.z + 0.05) {
      waypoint.z = rest.z + 0.05 + r2 * 0.1;
    }

    const shy = faceplate
      ? 0.03 + r2 * 0.01
      : options.helmet
        ? 0.025
        : 0.035 + r2 * 0.015;
    const approach = rest
      .clone()
      .addScaledVector(dirN, -shy * Math.min(len, 2.2));
    const oh =
      options.overshoot ??
      (faceplate
        ? 0.006 + r1 * 0.003
        : options.helmet
          ? 0.005 + r1 * 0.003
          : 0.012 + r1 * 0.008);
    const overshoot = rest.clone().addScaledVector(dirN, oh);

    return { waypoint, approach, overshoot };
  }

  // Fallback mild arc (rarely used once frontal scatter is default)
  const waypoint = start.clone().lerp(rest, 0.55 + r1 * 0.1);
  const up = new THREE.Vector3(0, 1, 0);
  let side = new THREE.Vector3().crossVectors(dirN, up);
  if (side.lengthSq() < 1e-6) {
    side.crossVectors(dirN, new THREE.Vector3(1, 0, 0));
  }
  side.normalize();
  const lift = new THREE.Vector3().crossVectors(side, dirN).normalize();

  const amp = len * (0.04 + r2 * 0.06);
  waypoint.addScaledVector(side, (r3 - 0.5) * 2 * amp);
  waypoint.addScaledVector(lift, amp * (0.2 + r1 * 0.25));

  const shy = options.helmet ? 0.022 : 0.04 + r2 * 0.02;
  const approach = rest
    .clone()
    .addScaledVector(dirN, -shy * Math.min(len, 2.5));

  const oh =
    options.overshoot ??
    (options.helmet ? 0.005 + r1 * 0.003 : 0.014 + r1 * 0.01);
  const overshoot = rest.clone().addScaledVector(dirN, oh);

  return { waypoint, approach, overshoot };
}

/** Keyframes stored on each plate for director path visualization. */
export interface FlightPathKeys {
  start: THREE.Vector3;
  waypoint: THREE.Vector3;
  approach: THREE.Vector3;
  overshoot: THREE.Vector3;
  rest: THREE.Vector3;
}

export function flightPathKeysFrom(
  start: THREE.Vector3,
  rest: THREE.Vector3,
  path: MagneticPath,
): FlightPathKeys {
  return {
    start: start.clone(),
    waypoint: path.waypoint.clone(),
    approach: path.approach.clone(),
    overshoot: path.overshoot.clone(),
    rest: rest.clone(),
  };
}

/**
 * Dense polyline through the magnetic control points (director debug line).
 * Uses a centripetal Catmull–Rom through start → waypoint → approach → overshoot → rest.
 */
export function sampleFlightPathLine(
  keys: FlightPathKeys,
  segments = 64,
): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(
    [keys.start, keys.waypoint, keys.approach, keys.overshoot, keys.rest],
    false,
    'catmullrom',
    0.35,
  );
  return curve.getPoints(Math.max(8, segments));
}
