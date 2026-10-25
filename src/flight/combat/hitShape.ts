import * as THREE from 'three';
import type { Hostile } from './types';

/**
 * A hostile's hit shape: a sphere of {@link Hostile.radius} round its
 * centre, or — for something long, like a ship's hull — a capsule of that
 * radius round its {@link Hostile.span}.
 */

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/** The point of the hostile's core (its centre, or its spine) nearest `p`. */
export function coreNearest(h: Hostile, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (!h.span) return out.copy(h.pos);
  const [a, b] = h.span;
  const ab = _u.copy(b).sub(a);
  const t = THREE.MathUtils.clamp(_v.copy(p).sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return out.copy(a).addScaledVector(ab, t);
}

/** Distance from `p` to the hostile's core (0 at its centre or on its spine). */
export function coreDistance(h: Hostile, p: THREE.Vector3): number {
  return coreNearest(h, p, _w).distanceTo(p);
}

/**
 * Closest approach of the segment p0 → p1 to the hostile's core: the point
 * on the segment goes in `onSeg`, the one on the core in `onCore`; returns
 * the squared distance between them.
 */
export function segmentToCore(h: Hostile, p0: THREE.Vector3, p1: THREE.Vector3, onSeg: THREE.Vector3, onCore: THREE.Vector3): number {
  const d1 = _u.copy(p1).sub(p0);
  const a = d1.lengthSq();
  if (!h.span) {
    const t = THREE.MathUtils.clamp(_v.copy(h.pos).sub(p0).dot(d1) / Math.max(a, 1e-9), 0, 1);
    onSeg.copy(p0).addScaledVector(d1, t);
    onCore.copy(h.pos);
    return onSeg.distanceToSquared(onCore);
  }
  // Segment–segment closest points
  const [q0, q1] = h.span;
  const d2 = _v.copy(q1).sub(q0);
  const r = _w.copy(p0).sub(q0);
  const e = d2.lengthSq();
  const f = d2.dot(r);
  const c = d1.dot(r);
  const b = d1.dot(d2);
  const denom = a * e - b * b;
  let s = denom > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
  let t = (b * s + f) / Math.max(e, 1e-9);
  if (t < 0) {
    t = 0;
    s = THREE.MathUtils.clamp(-c / Math.max(a, 1e-9), 0, 1);
  } else if (t > 1) {
    t = 1;
    s = THREE.MathUtils.clamp((b - c) / Math.max(a, 1e-9), 0, 1);
  }
  onSeg.copy(p0).addScaledVector(d1, s);
  onCore.copy(q0).addScaledVector(d2, t);
  return onSeg.distanceToSquared(onCore);
}
