import * as THREE from 'three';
import { ATMOSPHERE_GLSL } from '../world/atmosphere';

/**
 * Give three's own lit materials (the suit, the house, drones, launchers)
 * the same aerial perspective the terrain and the sea use, so a drone 3 km
 * out sits in the same blue haze as the ridge behind it. Chains any
 * onBeforeCompile already on the material.
 */
const DONE = Symbol('haze');

export function withHaze(mat: THREE.Material, uniforms: Record<string, THREE.IUniform>): void {
  const m = mat as THREE.Material & { [DONE]?: boolean };
  if (m[DONE]) return;
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return;
  m[DONE] = true;
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ATMOSPHERE_GLSL}`)
      .replace(
        '#include <fog_fragment>',
        /* glsl */ `{
          vec3 hazeWorld = cameraPosition + transpose(mat3(viewMatrix)) * (-vViewPosition);
          gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, hazeWorld);
        }`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey()}|haze`;
  mat.needsUpdate = true;
}

export function hazeAll(root: THREE.Object3D, uniforms: Record<string, THREE.IUniform>): void {
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) withHaze(m, uniforms);
  });
}
