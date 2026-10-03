import type { Object3D, Vector3 } from 'three';
import type { ArmorPieceDef, ArmorPieceId } from './armorPieces';
import type { BoneName } from './rig';

/**
 * Body-region waves for the Mark III suit-up (bottom → top).
 * Order: boots/legs → hips → torso → shoulders → arms → gauntlets → helmet → power.
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

/** One rigged suit-up component (see {@link ArmorPieceDef}). */
export interface ArmorPiece {
  id: ArmorPieceId;
  label: string;
  mesh: Object3D;
  wave: PieceWave;
  /** Bone the piece docks onto. */
  anchor: BoneName;
  /** Bind-pose center of the piece (model space, feet at y=0). */
  restPosition: Vector3;
  def: ArmorPieceDef;
}

/**
 * Mark III suit-up (Iron Man 2008): workshop fitting order, bottom → top.
 * Built inside → out: boots rise from the floor, leg clamshells, hips, back
 * plates, reactor housing then pecs (arc reactor ignites), pauldrons before
 * the bicep plates, forearm sleeves, gauntlets, then the helmet; the
 * faceplate slams shut and the eyes light.
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
