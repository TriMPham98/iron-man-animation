import type * as THREE from 'three';
import { structureTop } from '../world/house';
import type { Heightfield } from '../world/heightfield';
import type { GroundProbe } from './flightModel';

/** The heightfield (and the house and pad on it) as the flight model, camera and FX see it. */
export function groundProbe(field: Heightfield): GroundProbe & { isDeck(x: number, z: number): boolean } {
  return {
    surface: (x, z) => Math.max(field.surfaceAt(x, z), structureTop(field, x, z)),
    isWater: (x, z) => field.heightAt(x, z) < 0 && structureTop(field, x, z) === -Infinity,
    // The pad, the house's roofs and terraces, the bare rock of the bluff
    isDeck: (x, z) => structureTop(field, x, z) > field.surfaceAt(x, z),
    normal: (x, z, out: THREE.Vector3) => (structureTop(field, x, z) > field.surfaceAt(x, z) ? out.set(0, 1, 0) : field.normalAt(x, z, out)),
  };
}
