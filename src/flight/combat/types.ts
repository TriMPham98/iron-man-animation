import type * as THREE from 'three';

export type HostileKind = 'drone' | 'sam';

/** Anything the suit can lock, shoot and blow up. */
export interface Hostile {
  readonly id: number;
  readonly kind: HostileKind;
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  /** Hit sphere (m). */
  readonly radius: number;
  hp: number;
  readonly maxHp: number;
  alive: boolean;
  /** Seconds a player missile has been tracking it (it breaks hard). */
  threatened: number;
  /** Apply damage at a point; returns true if this killed it. */
  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean;
}

export type DamageKind = 'repulsor' | 'missile' | 'unibeam' | 'launcher' | 'ram';

/** The player as hostiles see it. */
export interface PlayerTarget {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  alive: boolean;
  /** Apply a hit; `at` is where it struck. */
  hit(amount: number, at: THREE.Vector3, kind: 'bullet' | 'missile'): void;
}

/** Something a heat seeker may chase instead of its target. */
export interface Decoy {
  pos: THREE.Vector3;
  heat: number;
}
