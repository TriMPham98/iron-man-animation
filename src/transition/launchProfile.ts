import * as THREE from 'three';
import { FLIGHT_CHECK_STEPS, HOVER_HOLD } from '../animation/flightCheck';
import { ROOF_IRIS_R, ROOF_IRIS_SEC, SHAFT_H } from '../workshop/roofIris';

/**
 * The launch out of the workshop, as pure functions of the seconds since
 * the FLY click, from anywhere in the cycle. The cycle is never run fast:
 * a few seconds short of the settled hover the launch is armed and the
 * check plays on at its own pace to the hover, the roof readying over it;
 * further out (the build, the early check, the doff) the picture dips to
 * black and cuts to the suit on the pad as the boots light for the hover
 * test. From the hover the mast heads run clear of the roof iris, the iris
 * opens on the shaft, daylight comes down it and the suit climbs out: the
 * lens low under it, then up after it into the shaft, where the flight sim
 * takes the picture.
 */

/** Climb: metres up from the hover to the swap, its time, and the speed it leaves at. */
export const CLIMB_M = 4.7;
export const CLIMB_SEC = 1.9;
export const CLIMB_EXIT_V = 3.5;
/** Mast heads running clear (s). */
export const MASTS_SEC = 0.5;
/** The hover test's first step (check s): from here on the suit is already on its way up. */
export const HOVER_TEST_AT = (FLIGHT_CHECK_STEPS.find((s) => /HOVER/.test(s.status)) ?? FLIGHT_CHECK_STEPS[0]).at;
/** Longest the launch waits on the check playing out to the hover (s); further and it cuts. */
export const WAIT_MAX = 9;
/** The dip to black before a cut (s from the click): the cut is on its darkest frame. */
export const CUT_AT = 0.45;
/** Check clock the cut lands on: palms set to the deck, just before the boots light. */
export const CUT_TO = HOVER_TEST_AT + 0.8;
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
/** First frame after a cut, round from the low framing (suit yaw frame): wider, lower, on the suit standing. */
const CUT_SHOT = { az: 0.35, dist: 5.1, y: 0.7, lookY: 2.0, fov: LOW_FOV + 6 };
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
/** How the launch gets to the hover: already in it, the check played out to it, or a cut. */
export type LaunchMode = 'now' | 'wait' | 'cut';

export interface LaunchPlan {
  /** Cycle clock at the click, and the build's length. */
  from: number;
  assembly: number;
  kind: LaunchFrom;
  mode: LaunchMode;
  /** The cut (s from the click), or null. */
  cut: number | null;
  /** Check clock when the launch takes the suit (at the click, or on the cut), and when (s from the click). */
  check0: number;
  t0: number;
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

/** Where in the cycle cycle-time `t` is, for the launch. */
export function launchFrom(t: number, assembly: number): LaunchFrom {
  const check = t - assembly;
  if (check < 0) return 'build';
  if (check < HOVER_TEST_AT) return 'check';
  return check <= HOVER_HOLD[1] ? 'hover' : 'after';
}

/** How a click at cycle time `t` gets to the hover. */
export function launchMode(t: number, assembly: number): LaunchMode {
  const check = t - assembly;
  if (check >= HOVER_HOLD[0] && check <= HOVER_HOLD[1]) return 'now';
  return check >= HOVER_HOLD[0] - WAIT_MAX && check < HOVER_HOLD[0] ? 'wait' : 'cut';
}

/**
 * The beats for a click at cycle time `from` (s), the build `assembly` s
 * long; `cut` forces a cut (the launch skipped on, mid wait).
 */
export function launchPlan(from: number, assembly: number, cut = false): LaunchPlan {
  const kind = launchFrom(from, assembly);
  const mode = cut ? 'cut' : launchMode(from, assembly);
  const t0 = mode === 'cut' ? CUT_AT : 0;
  const check0 = mode === 'cut' ? CUT_TO : from - assembly;
  const ready = t0 + Math.max(0, HOVER_HOLD[0] - check0);
  // The iris all but open as the hover settles; armed, the mast heads clear
  // at once (the launch is on its way), else just ahead of the iris
  const irisFrom = Math.max(t0 + 0.75, ready - ROOF_IRIS_SEC + 0.2);
  const masts = mode === 'cut' ? Math.max(t0 + 0.35, irisFrom - MASTS_SEC * 0.8 - 0.5) : 0.35;
  const irisOpen = irisFrom + ROOF_IRIS_SEC;
  const climb = Math.max(ready + 0.15, irisOpen - 0.55);
  return { from, assembly, kind, mode, cut: mode === 'cut' ? CUT_AT : null, check0, t0, ready, masts, irisFrom, irisOpen, climb, swap: climb + CLIMB_SEC };
}

/** What the FLY button will do from cycle time `t` (shown over it). */
export function flyHint(t: number, assembly: number): string {
  switch (launchMode(t, assembly)) {
    case 'now':
      return 'FLIGHT SYSTEMS READY · TAKE HER OUT';
    case 'wait':
      return 'ARMS THE LAUNCH · LIFTS OFF FROM THE HOVER';
  }
  switch (launchFrom(t, assembly)) {
    case 'build':
      return 'CUTS TO THE FINISHED SUIT · THEN TAKES HER OUT';
    case 'after':
      return 'CUTS BACK TO THE HOVER · THEN TAKES HER OUT';
    default:
      return 'CUTS TO THE HOVER TEST · THEN TAKES HER OUT';
  }
}

/** Cycle clock at `t` s from the click, before a cut (it plays on as the picture dips). */
export function cycleAt(p: Pick<LaunchPlan, 'from'>, t: number): number {
  return p.from + t;
}

/** Check clock at `t` s from the click, once the launch has the suit: on at its own pace, held at the hover's end. */
export function checkAt(p: LaunchPlan, t: number): number {
  return Math.min(HOVER_HOLD[1], p.check0 + Math.max(0, t - p.t0));
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
 * The workshop lens at `t`, from where it was at the click (`from*`), or
 * from the first shot after a cut: eased to the low framing under the hover, then (with the climb) in toward the
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
  // Low framing, round the suit (not through it) from the click pose — or,
  // on a cut, from a wider shot of the suit on the pad (the click pose held
  // as the picture dips)
  const lowPos = _a.set(Math.sin(yaw + LOW_AZ) * LOW_DIST, LOW_Y, Math.cos(yaw + LOW_AZ) * LOW_DIST);
  const lowLook = _b.set(0, LOW_LOOK_Y, 0);
  const t0 = p.cut ?? 0;
  let src = from;
  if (p.cut !== null && t >= p.cut) {
    const az = yaw + LOW_AZ + CUT_SHOT.az;
    src = _cut;
    src.pos.set(Math.sin(az) * CUT_SHOT.dist, CUT_SHOT.y, Math.cos(az) * CUT_SHOT.dist);
    src.look.set(0, CUT_SHOT.lookY, 0);
    src.fov = CUT_SHOT.fov;
  }
  const e = t < t0 ? 0 : smooth((t - t0) / Math.max(1.7, p.climb - t0 - 0.2));
  const pivot = _c.set(0, 1.4, 0);
  const sa = _sa.setFromVector3(_d.copy(src.pos).sub(pivot));
  const sb = _sb.setFromVector3(_d.copy(lowPos).sub(pivot));
  const dth = Math.atan2(Math.sin(sb.theta - sa.theta), Math.cos(sb.theta - sa.theta));
  out.pos.setFromSpherical(_s.set(THREE.MathUtils.lerp(sa.radius, sb.radius, e), THREE.MathUtils.lerp(sa.phi, sb.phi, e), sa.theta + dth * e)).add(pivot);
  out.look.lerpVectors(src.look, lowLook, e);
  out.fov = THREE.MathUtils.lerp(src.fov, LOW_FOV, e);

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
const _cut = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 0 };

/** Top of the shaft (world y) above a ceiling at `ceilingY`. */
export const shaftTop = (ceilingY: number) => ceilingY + SHAFT_H;
