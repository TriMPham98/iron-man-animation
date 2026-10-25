import * as THREE from 'three';
import { FLIGHT_CHECK_START, FLIGHT_CHECK_STEPS, HOVER_HOLD } from '../animation/flightCheck';
import { ROOF_IRIS_R, ROOF_IRIS_SEC, SHAFT_H } from '../workshop/roofIris';

/**
 * The launch out of the workshop, as pure functions of the seconds since
 * the FLY click, from anywhere in the cycle: first the cycle is run (fast,
 * eased in and out) to the settled hover — the build on to its end and the
 * check through its lift-off, or the doff and the landing back — then the
 * mast heads run clear of the roof iris, the iris opens on the shaft,
 * daylight comes down it and the suit climbs out: the lens low under it,
 * then up after it into the shaft, where the flight sim takes the picture.
 */

/** Climb: metres up from the hover to the swap, its time, and the speed it leaves at. */
export const CLIMB_M = 4.7;
export const CLIMB_SEC = 1.9;
export const CLIMB_EXIT_V = 3.5;
/** Mast heads running clear (s). */
export const MASTS_SEC = 0.5;
/** The hover test's first step (check s): from here on the suit is already on its way up. */
export const HOVER_TEST_AT = (FLIGHT_CHECK_STEPS.find((s) => /HOVER/.test(s.status)) ?? FLIGHT_CHECK_STEPS[0]).at;
/**
 * The cell is stowed through the check from just after the build to the doff
 * prep (the grippers come up as it reads nominal): the roof only moves then.
 */
const CELL_CLEAR: readonly [number, number] = [0.3, FLIGHT_CHECK_STEPS[FLIGHT_CHECK_STEPS.length - 1].at];
/** Lens under the climbing suit, in the suit's yaw frame (from its head). */
export const FOLLOW_REL = new THREE.Vector3(0.62, -1.7, 0.66);
/** …looking at this far over the head. */
export const FOLLOW_LOOK_UP = 0.35;
export const FOLLOW_FOV = 60;
/** Low framing under the hover, before the climb (suit yaw frame, from the platform axis). */
const LOW_AZ = Math.atan2(FOLLOW_REL.x, FOLLOW_REL.z);
const LOW_DIST = 4.3;
const LOW_Y = 0.95;
const LOW_LOOK_Y = 2.9;
export const LOW_FOV = 52;
/** Truss and pendant lamps hang from here down: the lens only goes higher inside this radius. */
export const LENS_CEILING = 3.8;
export const LENS_SHAFT_R = ROOF_IRIS_R - 0.12;

const smooth = (x: number) => {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const ramp = (t: number, a: number, len: number) => THREE.MathUtils.clamp((t - a) / len, 0, 1);

/** Where in the cycle the click came: the build, the check before the hover, the hover, or after it. */
export type LaunchFrom = 'build' | 'check' | 'hover' | 'after';

export interface LaunchPlan {
  /** Cycle clock at the click, the build's length, and the cycle time of the settled hover it runs to. */
  from: number;
  assembly: number;
  target: number;
  kind: LaunchFrom;
  /** Cycle span the run jumps (the check's standing steps, run from the build). */
  skip: readonly [number, number] | null;
  /** When the cycle is in the settled hover (s from the click). */
  ready: number;
  /** Mast heads start clearing; the iris starts and is fully open. */
  masts: number;
  irisFrom: number;
  irisOpen: number;
  /** Climb starts; the flight sim takes the picture. */
  climb: number;
  swap: number;
}

/** Where in the cycle cycle-time `t` is, for the launch. */
export function launchFrom(t: number, assembly: number): LaunchFrom {
  const check = t - assembly;
  if (check < 0) return 'build';
  if (check < HOVER_TEST_AT) return 'check';
  return check <= HOVER_HOLD[1] ? 'hover' : 'after';
}

/**
 * Seconds to run the cycle `dist` s: a couple of check seconds at about
 * twice speed, a whole build or doff in a few seconds.
 */
export function seekSeconds(dist: number): number {
  return dist <= 1e-3 ? 0 : THREE.MathUtils.clamp(0.3 + 0.55 * Math.sqrt(dist), 0.6, 4.2);
}

/** The beats for a click at cycle time `from` (s), the build `assembly` s long. */
export function launchPlan(from: number, assembly: number): LaunchPlan {
  const [h0, h1] = HOVER_HOLD;
  const check = from - assembly;
  const target = assembly + THREE.MathUtils.clamp(check, h0, h1);
  const kind = launchFrom(from, assembly);
  // From the build, the check's own steps (all done from a stand) are passed
  // over: finished, the suit goes straight into the hover test
  const skip: readonly [number, number] | null = kind === 'build' ? [assembly + FLIGHT_CHECK_START, assembly + HOVER_TEST_AT] : null;
  const ready = seekSeconds(Math.abs(target - from) - (skip ? skip[1] - skip[0] : 0));
  const p = { from, assembly, target, kind, skip, ready, masts: 0, irisFrom: 0, irisOpen: 0, climb: 0, swap: 0 };
  // The roof waits for the cell to be stowed (the run passes into the check)
  let clear = 0;
  for (let t = 0; t < ready; t += 1 / 120) {
    const c = cycleAt(p, t) - assembly;
    if (c >= CELL_CLEAR[0] && c <= CELL_CLEAR[1]) break;
    clear = t;
  }
  p.masts = Math.max(0.35, clear + 0.15, ready - 1.4);
  p.irisFrom = p.masts + MASTS_SEC * 0.8;
  p.irisOpen = p.irisFrom + ROOF_IRIS_SEC;
  p.climb = Math.max(ready + 0.15, p.irisOpen - 0.55);
  p.swap = p.climb + CLIMB_SEC;
  return p;
}

/** What the FLY button will do from cycle time `t` (shown over it). */
export function flyHint(t: number, assembly: number): string {
  switch (launchFrom(t, assembly)) {
    case 'build':
      return 'FINISHES THE SUIT-UP · THEN TAKES HER OUT';
    case 'check':
      return 'SKIPS TO THE HOVER TEST · THEN TAKES HER OUT';
    case 'hover':
      return 'FLIGHT SYSTEMS READY · TAKE HER OUT';
    case 'after':
      return 'PUTS HER BACK TOGETHER · THEN TAKES HER OUT';
  }
}

/** Cycle clock at `t` s from the click, while it runs to the hover (eased in and out). */
export function cycleAt(p: Pick<LaunchPlan, 'from' | 'target' | 'ready' | 'skip'>, t: number): number {
  if (p.ready <= 0) return p.target;
  const gap = p.skip ? p.skip[1] - p.skip[0] : 0;
  const c = THREE.MathUtils.lerp(p.from, p.target - gap, smooth(t / p.ready));
  return p.skip && c > p.skip[0] ? c + gap : c;
}

/** Check clock at `t` s from the click: the run to the hover, then on through it. */
export function checkAt(p: LaunchPlan, t: number): number {
  if (t < p.ready) return cycleAt(p, t) - p.assembly;
  return Math.min(HOVER_HOLD[1], p.target - p.assembly + (t - p.ready));
}

/** Metres climbed over the hover at `t`: eased off the hover, leaving at {@link CLIMB_EXIT_V}. */
export function climbAt(p: LaunchPlan, t: number): number {
  const s = (t - p.climb) / CLIMB_SEC;
  if (s <= 0) return 0;
  if (s >= 1) return CLIMB_M + CLIMB_EXIT_V * (t - p.swap);
  // Hermite: 0 → CLIMB_M, from rest to the exit speed
  const h01 = s * s * (3 - 2 * s);
  const h11 = s * s * (s - 1);
  return h01 * CLIMB_M + h11 * CLIMB_SEC * CLIMB_EXIT_V;
}

/** Roof state at `t`: mast heads, iris, daylight. */
export function roofAt(p: LaunchPlan, t: number): { masts: number; iris: number; daylight: number } {
  const iris = ramp(t, p.irisFrom, p.irisOpen - p.irisFrom);
  return { masts: ramp(t, p.masts, MASTS_SEC), iris, daylight: smooth((iris - 0.12) / 0.88) };
}

/** Boot burn floor at `t` (full for the climb). */
export function burnAt(p: LaunchPlan, t: number): number {
  return ramp(t, p.climb - 0.35, 0.35);
}

/** Lens under the suit for a head at `head`, suit yaw `yaw` (world). */
export function followPose(head: THREE.Vector3, yaw: number, pos: THREE.Vector3, look: THREE.Vector3): void {
  pos.copy(FOLLOW_REL).applyAxisAngle(UP, yaw).add(head);
  look.copy(head).y += FOLLOW_LOOK_UP;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The workshop lens at `t`, from where it was at the click (`from*`): eased
 * to the low framing under the hover, then (with the climb) in toward the
 * axis and up after the suit into the shaft. The platform axis is world
 * (0, y, 0).
 */
export function workshopLens(
  p: LaunchPlan,
  t: number,
  head: THREE.Vector3,
  yaw: number,
  from: { pos: THREE.Vector3; look: THREE.Vector3; fov: number },
  out: { pos: THREE.Vector3; look: THREE.Vector3; fov: number },
): void {
  // Low framing, round the suit (not through it) from the click pose
  const lowPos = _a.set(Math.sin(yaw + LOW_AZ) * LOW_DIST, LOW_Y, Math.cos(yaw + LOW_AZ) * LOW_DIST);
  const lowLook = _b.set(0, LOW_LOOK_Y, 0);
  const e = smooth(t / Math.max(1.7, p.climb - 0.2));
  const pivot = _c.set(0, 1.4, 0);
  const sa = _sa.setFromVector3(_d.copy(from.pos).sub(pivot));
  const sb = _sb.setFromVector3(_d.copy(lowPos).sub(pivot));
  const dth = Math.atan2(Math.sin(sb.theta - sa.theta), Math.cos(sb.theta - sa.theta));
  out.pos.setFromSpherical(_s.set(THREE.MathUtils.lerp(sa.radius, sb.radius, e), THREE.MathUtils.lerp(sa.phi, sb.phi, e), sa.theta + dth * e)).add(pivot);
  out.look.lerpVectors(from.look, lowLook, e);
  out.fov = THREE.MathUtils.lerp(from.fov, LOW_FOV, e);

  // With the climb: in toward the axis first, then up after the suit
  followPose(head, yaw, _fp, _fl);
  const wr = smooth((t - p.climb) / 0.95);
  const wy = smooth((t - p.climb - 0.25) / (CLIMB_SEC - 0.45));
  if (wr > 0) {
    const r0 = Math.hypot(out.pos.x, out.pos.z);
    const r1 = Math.hypot(_fp.x, _fp.z);
    const a0 = Math.atan2(out.pos.x, out.pos.z);
    const a1 = Math.atan2(_fp.x, _fp.z);
    const a = a0 + Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)) * wr;
    const r = THREE.MathUtils.lerp(r0, r1, wr);
    let y = THREE.MathUtils.lerp(out.pos.y, _fp.y, wy);
    // Under the truss until it is inside the opening
    if (r > LENS_SHAFT_R) y = Math.min(y, LENS_CEILING);
    out.pos.set(Math.sin(a) * r, y, Math.cos(a) * r);
    out.look.lerp(_fl, wr);
    out.fov = THREE.MathUtils.lerp(out.fov, FOLLOW_FOV, wr);
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _fp = new THREE.Vector3();
const _fl = new THREE.Vector3();
const _s = new THREE.Spherical();
const _sa = new THREE.Spherical();
const _sb = new THREE.Spherical();

/** Top of the shaft (world y) above a ceiling at `ceilingY`. */
export const shaftTop = (ceilingY: number) => ceilingY + SHAFT_H;
