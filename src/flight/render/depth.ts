import * as THREE from 'three';

/**
 * Depth precision across 0.1 m – 150 km. Reversed-Z on a float depth buffer
 * is exact and free where the browser exposes EXT_clip_control; elsewhere
 * the renderer falls back to a logarithmic depth buffer, which three's own
 * materials handle but hand-written shaders must opt into — {@link withLogDepth}
 * patches one in place (a no-op under reversed-Z: the chunks are #ifdef'd).
 */
export function supportsReversedZ(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ok = !!gl?.getExtension('EXT_clip_control');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

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
