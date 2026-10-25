import * as THREE from 'three';

/**
 * The world: a 32 km stretch of coastal range on the Pacific, flown at
 * golden hour. Metres throughout; +Y up, the ocean lies to the south (+Z)
 * and the sun hangs low in the west-south-west over the water.
 */
export const WORLD_SIZE = 32768;
/** Heightfield texels per side (16 m each). */
export const HEIGHT_RES = 2048;
export const TEXEL = WORLD_SIZE / HEIGHT_RES;
/** Tileable detail-noise texture: texels per side and world span (m). */
export const DETAIL_RES = 256;
export const DETAIL_SPAN = 192;
/** Vertex spacing (m) of the finest terrain mesh, the one drawn underfoot. */
export const TERRAIN_PITCH = 4;
export const SEA_LEVEL = 0;

/** Direction toward the sun (unit). Elevation ~7°. */
export const SUN_DIR = new THREE.Vector3(-0.74, 0.122, 0.66).normalize();
/** Direct sun colour × intensity (warm, low sun through a long air path). */
export const SUN_COLOR = new THREE.Color(1.0, 0.78, 0.56);
export const SUN_INTENSITY = 4.4;

/** Speed of sound at sea level (m/s): Mach readout, sonic boom, sound delay. */
export const SPEED_OF_SOUND = 343;
export const GRAVITY = 9.81;
