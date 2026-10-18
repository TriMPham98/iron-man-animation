import * as THREE from 'three';

/**
 * Depth precision across 0.1 m – 150 km comes from a logarithmic depth
 * buffer. three's own materials handle it; hand-written shaders opt in
 * through {@link withLogDepth}, which patches one in place (the chunks are
 * #ifdef'd, so it's harmless without log depth).
 */

const VERT_PARS = '#ifdef USE_LOGDEPTHBUF\nvarying float vFragDepth;\nvarying float vIsPerspective;\n#endif\n';
const VERT_MAIN = '\n#ifdef USE_LOGDEPTHBUF\nvFragDepth = 1.0 + gl_Position.w;\nvIsPerspective = 1.0;\n#endif\n';
const FRAG_PARS = '#include <logdepthbuf_pars_fragment>\n';
const FRAG_MAIN = '\n#include <logdepthbuf_fragment>\n';
const PATCHED = Symbol('logDepth');

/** Insert before the closing brace of main() (the last brace in the source). */
function beforeMainEnd(src: string, code: string): string {
  const i = src.lastIndexOf('}');
  return i < 0 ? src : src.slice(0, i) + code + src.slice(i);
}

function afterMainStart(src: string, code: string): string {
  return src.replace(/void\s+main\s*\(\s*(void)?\s*\)\s*\{/, (m) => m + code);
}

export function withLogDepth<T extends THREE.Material>(mat: T): T {
  const m = mat as unknown as THREE.ShaderMaterial & { [PATCHED]?: boolean };
  if (!m.isShaderMaterial || m[PATCHED]) return mat;
  if (m.vertexShader.includes('logdepthbuf')) return mat;
  m.vertexShader = beforeMainEnd(VERT_PARS + m.vertexShader, VERT_MAIN);
  m.fragmentShader = afterMainStart(FRAG_PARS + m.fragmentShader, FRAG_MAIN);
  m[PATCHED] = true;
  m.needsUpdate = true;
  return mat;
}

/** Patch every hand-written shader under a root. */
export function patchLogDepth(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) withLogDepth(m);
  });
}
