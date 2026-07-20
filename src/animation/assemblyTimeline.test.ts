import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ArmorPiece, PieceWave } from '../suit/waves';
import { isFaceplateRest } from '../utils/easeHelpers';
import {
  groupHasFaceplate,
  orderHelmetLaunchGroups,
} from './assemblyTimeline';

function piece(
  id: string,
  x: number,
  y: number,
  z: number,
  wave: PieceWave = 'helmet',
): ArmorPiece {
  return {
    id,
    mesh: new THREE.Object3D(),
    wave,
    restPosition: new THREE.Vector3(x, y, z),
    restRotation: new THREE.Euler(),
    restScale: new THREE.Vector3(1, 1, 1),
    startPosition: new THREE.Vector3(),
    startRotation: new THREE.Euler(),
    startScale: new THREE.Vector3(1, 1, 1),
  };
}

describe('groupHasFaceplate / orderHelmetLaunchGroups', () => {
  it('detects front faceplate rest (mask) vs cranial shell', () => {
    const mask = piece('mask', 0.02, 1.45, 0.12);
    const crown = piece('crown', 0.02, 1.72, -0.02);
    expect(isFaceplateRest(mask.restPosition)).toBe(true);
    expect(isFaceplateRest(crown.restPosition)).toBe(false);
    expect(groupHasFaceplate([mask])).toBe(true);
    expect(groupHasFaceplate([crown])).toBe(false);
  });

  it('schedules cranial shells before faceplate groups', () => {
    const crown = piece('crown', 0.0, 1.75, -0.02);
    const cheekL = piece('cheek-L', 0.18, 1.55, 0.02);
    const cheekR = piece('cheek-R', -0.18, 1.55, 0.02);
    const mask = piece('mask', 0.01, 1.42, 0.1);

    // Interleaved input order: faceplate first — should still end last
    const groups = [[mask], [cheekL, cheekR], [crown]];
    const { ordered, faceplateStart } = orderHelmetLaunchGroups(groups);

    expect(faceplateStart).toBe(2);
    expect(ordered).toHaveLength(3);
    expect(ordered[0].map((p) => p.id)).toEqual(['cheek-L', 'cheek-R']);
    expect(ordered[1].map((p) => p.id)).toEqual(['crown']);
    expect(ordered[2].map((p) => p.id)).toEqual(['mask']);
  });

  it('leaves order unchanged when there is no faceplate split', () => {
    const crown = piece('crown', 0.0, 1.75, -0.02);
    const cheek = piece('cheek', 0.2, 1.55, 0.0);
    const groups = [[crown], [cheek]];
    const { ordered, faceplateStart } = orderHelmetLaunchGroups(groups);
    expect(faceplateStart).toBe(2);
    expect(ordered).toEqual(groups);
  });

  it('leaves order unchanged when every group is faceplate', () => {
    const maskA = piece('mask-a', 0.0, 1.4, 0.1);
    const maskB = piece('mask-b', 0.05, 1.35, 0.11);
    const groups = [[maskA], [maskB]];
    const { ordered, faceplateStart } = orderHelmetLaunchGroups(groups);
    expect(faceplateStart).toBe(2);
    expect(ordered).toEqual(groups);
  });
});
