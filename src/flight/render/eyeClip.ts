import * as THREE from 'three';

/**
 * The helmet view looks out from inside the suit: the helmet shell (and the
 * eyes' glow) would fill the lens, so three's own materials on the suit cut
 * away everything inside a sphere round the head. Only the colour pass is
 * cut — the shadow pass draws its own depth material, so the suit's shadow
 * keeps its head. Chains any onBeforeCompile already on the material.
 */
const DONE = Symbol('eyeClip');

export interface EyeClip {
  /** World centre (xyz) and radius (w, m); radius 0 draws everything. */
  readonly uEyeClip: THREE.IUniform<THREE.Vector4>;
}

export function createEyeClip(): EyeClip {
  return { uEyeClip: { value: new THREE.Vector4(0, 0, 0, 0) } };
}

function withEyeClip(mat: THREE.Material, clip: EyeClip): void {
  const m = mat as THREE.Material & { [DONE]?: boolean };
  // Hand-written shaders (hologram, jets, sparks) have no chunks to hook
  if (m[DONE] || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
  m[DONE] = true;
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    if (!shader.vertexShader.includes('#include <project_vertex>')) return;
    shader.uniforms.uEyeClip = clip.uEyeClip;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEyeClipW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvEyeClipW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEyeClipW;\nuniform vec4 uEyeClip;')
      .replace(/void\s+main\s*\(\s*\)\s*\{/, (s) => `${s}\n  if (distance(vEyeClipW, uEyeClip.xyz) < uEyeClip.w) discard;`);
  };
  mat.customProgramCacheKey = () => `${prevKey()}|eyeClip`;
  mat.needsUpdate = true;
}

export function eyeClipAll(root: THREE.Object3D, clip: EyeClip): void {
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) withEyeClip(m, clip);
  });
}
