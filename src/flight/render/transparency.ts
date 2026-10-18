import * as THREE from 'three';

/**
 * Draw order for the see-through things. Nothing transparent writes depth,
 * so where two of them overlap on screen the one drawn last wins whatever
 * their real distances. The clouds are one instanced draw of hundreds of
 * puffs sorted among themselves, which three can only place as a whole: so
 * they are split each frame at the suit's distance — puffs beyond it draw
 * first, then the suit's plumes, flares and dust, then the puffs between
 * the camera and the suit.
 */
export const RENDER_ORDER = {
  /** Ground wash under the boots. */
  wash: 3,
  /** Cloud puffs farther from the eye than the suit. */
  cloudsFar: 4,
  /** Particles (dust, spray, smoke) and their glow layer use 5 / 6. */
  plume: 6,
  /** Plume glow sprites. */
  plumeGlow: 6,
  /** Cloud puffs nearer the eye than the suit: over everything above. */
  cloudsNear: 9,
} as const;

/**
 * Where the eye's attention (the suit) is this frame: the jets write it
 * after posing, the clouds read it to split near from far.
 */
export const sortFocus = {
  point: new THREE.Vector3(),
  valid: false,
};
