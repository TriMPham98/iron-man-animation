import * as THREE from 'three';

/**
 * Target painting for the suit's guided weapons (shoulder mini-rockets and
 * the forearm launchers): one lock per enemy. A paint pass offers the
 * hostile nearest the aim line that isn't locked yet; once every enemy in
 * the cone is taken it offers nothing, so a salvo never doubles up on one
 * target.
 */

export interface Lockable {
  readonly pos: THREE.Vector3;
  alive: boolean;
}

const _d = new THREE.Vector3();

/**
 * The live hostile closest to the aim line inside the cone (cosine) and
 * range, skipping anything in `taken`. Null when there is nothing left.
 */
export function nextLock<T extends Lockable>(
  eye: THREE.Vector3,
  aim: THREE.Vector3,
  hostiles: readonly T[],
  taken: readonly T[],
  cone: number,
  range: number,
): T | null {
  let best: T | null = null;
  let bestDot = cone;
  for (const h of hostiles) {
    if (!h.alive || taken.includes(h)) continue;
    const d = _d.copy(h.pos).sub(eye);
    const dist = d.length();
    if (dist > range || dist < 1e-3) continue;
    const dot = d.dot(aim) / dist;
    if (dot > bestDot) {
      bestDot = dot;
      best = h;
    }
  }
  return best;
}

/**
 * One paint tick: adds the next distinct target (if any) to the lock list
 * while there is ammunition for it. Returns the new lock, or null.
 */
export function paintLock<T extends Lockable>(
  locks: T[],
  capacity: number,
  eye: THREE.Vector3,
  aim: THREE.Vector3,
  hostiles: readonly T[],
  cone: number,
  range: number,
): T | null {
  // Drop anything that died while it was painted
  for (let i = locks.length - 1; i >= 0; i--) if (!locks[i].alive) locks.splice(i, 1);
  if (locks.length >= capacity) return null;
  const next = nextLock(eye, aim, hostiles, locks, cone, range);
  if (next) locks.push(next);
  return next;
}
