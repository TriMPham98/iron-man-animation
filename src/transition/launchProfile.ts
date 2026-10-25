import * as THREE from 'three';
import { FLIGHT_CHECK_STEPS, HOVER_HOLD } from '../animation/flightCheck';
import { ROOF_IRIS_R, ROOF_IRIS_SEC, SHAFT_H } from '../workshop/roofIris';

/**
 * The launch out of the workshop, as pure functions of the seconds since
 * the FLY click: the flight check runs on (or back) into its settled hover,
 * the mast heads run clear of the roof iris, the iris opens on the shaft,
 * daylight comes down it and the suit climbs out — the lens low under it,
 * then up after it into the shaft, where the flight sim takes the picture.
 */

/** Check-clock speed while it heads for the hover (either way). */
export const SEEK_RATE = 2;
/** Mast heads running clear (s). */
export const MASTS_SEC = 0.5;
/** Climb: metres up from the hover to the swap, its time, and the speed it leaves at. */
export const CLIMB_M = 4.7;
export const CLIMB_SEC = 1.9;
export const CLIMB_EXIT_V = 3.5;
/** The earliest check time (s) the launch runs from: the hover test. */
export const LAUNCH_FROM = (FLIGHT_CHECK_STEPS.find((s) => /HOVER/.test(s.status)) ?? FLIGHT_CHECK_STEPS[0]).at;
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

export interface LaunchPlan {
  /** Check clock at the click. */
  from: number;
  /** When the check is in the settled hover (s from the click). */
  ready: number;
  /** Mast heads start clearing; the iris starts and is fully open. */
  masts: number;
  irisFrom: number;
  irisOpen: number;
  /** Climb starts; the flight sim takes the picture. */
  climb: number;
  swap: number;
}

/** The beats for a click at check time `from` (s). */
export function launchPlan(from: number): LaunchPlan {
  const [h0, h1] = HOVER_HOLD;
  const ready = from < h0 ? (h0 - from) / SEEK_RATE : from > h1 ? (from - h1) / SEEK_RATE : 0;
  const masts = Math.max(0.35, ready - 1.4);
  const irisFrom = masts + MASTS_SEC * 0.8;
  const irisOpen = irisFrom + ROOF_IRIS_SEC;
  const climb = Math.max(ready + 0.15, irisOpen - 0.55);
  return { from, ready, masts, irisFrom, irisOpen, climb, swap: climb + CLIMB_SEC };
}

/** Check clock at `t` s from the click: on (or back) into the hover, then on through it. */
export function checkAt(p: LaunchPlan, t: number): number {
  const [h0, h1] = HOVER_HOLD;
  if (t < p.ready) return p.from + Math.sign(THREE.MathUtils.clamp(p.from, h0, h1) - p.from) * SEEK_RATE * t;
  return Math.min(h1, THREE.MathUtils.clamp(p.from, h0, h1) + (t - p.ready));
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
