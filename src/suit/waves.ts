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
  helmet: 'HELMET SEALING — FACEPLATE CLOSING…',
  power: 'SYSTEMS ONLINE — ARC STABLE…',
};
