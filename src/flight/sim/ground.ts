import type * as THREE from 'three';
import { structureTop } from '../world/house';
import type { Heightfield } from '../world/heightfield';
import { seaHeightAt } from '../world/ocean/spectrum';
import type { GroundProbe } from './flightModel';

/** The swell's height over the shelf (as the sea shader's shoreAmp): it lies down toward the beach. */
function shoreAmp(depth: number): number {
  const t = Math.min(1, Math.max(0, depth / 12));
  return 0.25 + 0.75 * t * t * (3 - 2 * t);
}

/**
 * The heightfield (and the house and pad on it) as the flight model, camera
 * and FX see it. The land is the drawn mesh (not the finer heightAt), so the
 * boots stand on the triangles on screen rather than sinking into a crag
 * between their corners or hanging over a hollow. The sea is the moving
 * swell the ocean draws, read at the world's clock, so the suit meets the
 * water where it is on screen.
 */
export function groundProbe(
  field: Heightfield,
  clock: () => number = () => 0,
  foam?: GroundProbe['foam'],
): GroundProbe & { isDeck(x: number, z: number): boolean } {
  const isWater = (x: number, z: number) => field.meshHeightAt(x, z) < 0 && structureTop(field, x, z) === -Infinity;
  return {
    surface: (x, z) => {
      const top = structureTop(field, x, z);
      const h = field.meshHeightAt(x, z);
      if (h >= 0 || top !== -Infinity) return Math.max(h, 0, top);
      return Math.max(h, seaHeightAt(x, z, clock()) * shoreAmp(-field.baseAt(x, z)));
    },
    isWater,
    seabed: (x, z) => field.meshHeightAt(x, z),
    foam,
    // The pad, the house's roofs and terraces, the bare rock of the bluff
    isDeck: (x, z) => structureTop(field, x, z) > field.surfaceAt(x, z),
    normal: (x, z, out: THREE.Vector3) => (structureTop(field, x, z) > field.surfaceAt(x, z) ? out.set(0, 1, 0) : field.normalAt(x, z, out)),
  };
}
