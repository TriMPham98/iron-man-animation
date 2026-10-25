import * as THREE from 'three';
import { BONE_NAMES, BONE_SPECS } from '../../suit/rig';

/**
 * The helmet view looks out from inside the suit: the helmet shell (and the
 * eyes' glow) would fill the lens, so three's own materials on the suit cut
 * away everything inside a sphere round the head. And only the suit's
 * outside is ever drawn: from the eye, a face turned away from it is the
 * back of a plate (a shell cut open, a two-sided flap, the cavity lining),
 * and the plates are modelled thick, so their inner skins face in toward
 * the bone they ride (a third of the suit's faces). Those go too. Only the
 * colour pass is cut — the shadow pass draws its own depth material, so the
 * suit's shadow keeps its head. Chains any onBeforeCompile already on the
 * material.
 */
const DONE = Symbol('eyeClip');
/** A face whose normal points this far in toward its bone is an inner skin (cos). */
const INNER = -0.2;

export interface EyeClip {
  /** World centre (xyz) and radius (w, m); radius 0 draws everything. */
  readonly uEyeClip: THREE.IUniform<THREE.Vector4>;
}

export function createEyeClip(): EyeClip {
  return { uEyeClip: { value: new THREE.Vector4(0, 0, 0, 0) } };
}

/**
 * Each bone's weighting segment in bind space (two ends per bone, by skin
 * index). Fixed by the rig, so compiled in: as a uniform array three
 * re-sends all of it on every draw of every suit material (it caches no
 * arrays), and ANGLE/Metal stalls on it — ~20 ms a frame.
 */
const EYE_BONES = (() => {
  const ends: string[] = BONE_NAMES.flatMap(() => ['vec3(0.0)', 'vec3(0.0)']);
  const v = (p: readonly number[]) => `vec3(${p.map((x) => x.toFixed(5)).join(', ')})`;
  for (const s of BONE_SPECS) {
    const [a, b] = s.capsule ?? [s.head, s.tail];
    const i = BONE_NAMES.indexOf(s.name) * 2;
    ends[i] = v(a);
    ends[i + 1] = v(b);
  }
  return `const vec3 uEyeBones[${ends.length}] = vec3[](\n  ${ends.join(',\n  ')}\n);`;
})();

const VERT_HEAD = /* glsl */ `
varying vec3 vEyeClipW;
varying float vEyeOut;
${EYE_BONES}`;

// How squarely the face looks away from the bone it rides (bind space: the
// skinned suit's own positions; the dominant bone is the first skin index)
const VERT_BODY = /* glsl */ `
vEyeClipW = (modelMatrix * vec4(transformed, 1.0)).xyz;
#ifdef USE_SKINNING
{
  int eb = int(skinIndex.x) * 2;
  vec3 ea = uEyeBones[eb];
  vec3 ed = uEyeBones[eb + 1] - ea;
  float et = clamp(dot(position - ea, ed) / max(dot(ed, ed), 1e-9), 0.0, 1.0);
  vec3 er = position - (ea + ed * et);
  vEyeOut = dot(normal, er) / max(length(er), 1e-5);
}
#else
vEyeOut = 1.0;
#endif`;

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
      .replace('#include <common>', `#include <common>${VERT_HEAD}`)
      .replace('#include <project_vertex>', `#include <project_vertex>${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEyeClipW;\nvarying float vEyeOut;\nuniform vec4 uEyeClip;')
      .replace(
        /void\s+main\s*\(\s*\)\s*\{/,
        (s) => `${s}\n  if (uEyeClip.w > 0.0 && (!gl_FrontFacing || vEyeOut < ${INNER.toFixed(2)} || distance(vEyeClipW, uEyeClip.xyz) < uEyeClip.w)) discard;`,
      );
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
