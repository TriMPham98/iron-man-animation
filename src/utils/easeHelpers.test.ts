import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hashSeed, scatterStart } from './easeHelpers';

describe('scatterStart determinism', () => {
  it('same seed → same start position', () => {
    const rest = new THREE.Vector3(0.2, 1.2, 0.05);
    const a = scatterStart(rest, 'shard-0-arms', 3.5, 8.5, 'arms');
    const b = scatterStart(rest, 'shard-0-arms', 3.5, 8.5, 'arms');
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });

  it('different seeds → different positions', () => {
    const rest = new THREE.Vector3(0, 1, 0);
    const a = scatterStart(rest, 'seed-a', 4, 9, 'torso');
    const b = scatterStart(rest, 'seed-b', 4, 9, 'torso');
    expect(a.equals(b)).toBe(false);
  });

  it('hashSeed is deterministic', () => {
    expect(hashSeed('hello')).toBe(hashSeed('hello'));
    expect(hashSeed('hello')).not.toBe(hashSeed('world'));
  });
});
