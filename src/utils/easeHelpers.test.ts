import { describe, expect, it } from 'vitest';
import { hashSeed } from './easeHelpers';

describe('hashSeed', () => {
  it('is deterministic and in [0, 1)', () => {
    for (const id of ['helmet', 'boot.L', 'forearm.R', '']) {
      const a = hashSeed(id);
      expect(a).toBe(hashSeed(id));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('separates mirrored piece ids', () => {
    expect(hashSeed('gauntlet.L')).not.toBe(hashSeed('gauntlet.R'));
  });
});
