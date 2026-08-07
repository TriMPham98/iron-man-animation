import type { Euler, Object3D, Vector3 } from 'three';

/**
 * Body-region waves for Mark III–style suit-up (bottom → top cascade).
 * Macro order: boots/legs → hips → torso → shoulders → arms → helmet → power.
 */
export type PieceWave =
  | 'boots'
  | 'calves'
  | 'thighs'
  | 'hips'
  | 'torso'
  | 'shoulders'
  | 'arms'
  | 'gauntlets'
  | 'helmet'
  | 'power';

export interface ArmorPiece {
  id: string;
  mesh: Object3D;
  wave: PieceWave;
  restPosition: Vector3;
  restRotation: Euler;
  restScale: Vector3;
  startPosition: Vector3;
  startRotation: Euler;
  startScale: Vector3;
}

/**
 * Mark III–style suit-up (Iron Man 2008): workshop clamp order, bottom → top.
 * Boots/legs first, then hips → torso → shoulders → arms → gauntlets → helmet.
 * Arc reactor ignites when torso seats; eyes/HUD after helmet seal.
 */
export const WAVE_ORDER: PieceWave[] = [
  'boots',
  'calves',
  'thighs',
  'hips',
  'torso',
  'shoulders',
  'arms',
  'gauntlets',
  'helmet',
  'power',
];

export const WAVE_STATUS: Record<PieceWave, string> = {
  boots: 'DEPLOYING FOOT UNITS…',
  calves: 'LOCKING LOWER LEG PLATES…',
  thighs: 'SECURING FEMORAL ARMOR…',
  hips: 'WAIST MODULE ENGAGED…',
  torso: 'CHEST PLATES ALIGNING…',
  shoulders: 'SHOULDER PODS ATTACHING…',
  arms: 'ARM SERVOS CALIBRATING…',
  gauntlets: 'GAUNTLETS CLAMPING…',
  helmet: 'HELMET SEALING…',
  power: 'SYSTEMS ONLINE — ARC STABLE…',
};

/**
 * Status line for a scrubbed integrity progress (wave-paced 0–1).
 * Matches the pipeline order so ←/→ shows the active assembly phase
 * instead of a debug placeholder.
 */
export function statusForIntegrityProgress(progress01: number): string {
  const p = Number.isFinite(progress01) ? progress01 : 0;
  if (p <= 0.001) return 'STANDBY // HANGAR LOCK';
  if (p >= 0.999) return 'SYSTEMS ONLINE';
  const n = WAVE_ORDER.length;
  if (n === 0) return 'ASSEMBLY SEQUENCE INITIATED';
  const idx = Math.min(n - 1, Math.max(0, Math.floor(p * n - 1e-12)));
  return WAVE_STATUS[WAVE_ORDER[idx]!] ?? 'ASSEMBLY SEQUENCE INITIATED';
}

/** Fired when the front mask begins its late hydraulic slam (after skull seats). */
export const FACEPLATE_STATUS = 'FACEPLATE CLOSING…';

/** Fired when palm / boot thrusters ignite after gauntlets seat. */
export const REPULSOR_STATUS = 'PALM REPULSORS IGNITION…';
