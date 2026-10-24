import * as THREE from 'three';

/**
 * Depth precision across 0.1 m – 150 km comes from reversed-Z into the float
 * depth buffer of the scene target ({@link useReversedDepth}). Where the GPU
 * lacks EXT_clip_control a logarithmic depth buffer stands in: three's own
 * materials handle it; hand-written shaders opt in through
 * {@link withLogDepth}, which patches one in place (the chunks are #ifdef'd,
 * so it's harmless without log depth). Log depth writes gl_FragDepth, which
 * turns off early depth rejection (hidden-surface removal on tiled GPUs):
 * on an M1 Pro it cost about half the frame.
 */

/** Context attributes the flight renderer is created with. */
export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
};

/** True when the context can draw reversed-Z (clip-space depth 0–1). */
export function canReverseDepth(gl: WebGL2RenderingContext | null): boolean {
  return !!gl?.getExtension('EXT_clip_control');
}

/**
 * Puts a renderer made with `reverseDepthBuffer: true` into a working
 * reversed-Z state, working round three r172:
 *  - its setReversed() reads the flag before updating it, so it leaves clip
 *    depth at −1–1 and the depth clear at 1: nothing passes the depth test
 *    (the frame rendered black). Each switch is followed by the right clip
 *    mode and clear here.
 *  - the shadow lookups assume conventional depth, so the shadow pass is
 *    drawn with reversal off.
 *  - polygon offsets aren't flipped: a negative offset (pull toward the eye)
 *    has to be positive under reversed-Z, so the context's polygonOffset
 *    negates while reversed.
 */
export function useReversedDepth(renderer: THREE.WebGLRenderer): void {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_clip_control');
  if (!ext || !renderer.capabilities.reverseDepthBuffer) return;
  const depth = renderer.state.buffers.depth;
  const set = (reversed: boolean) => {
    depth.setReversed(reversed);
    ext.clipControlEXT(ext.LOWER_LEFT_EXT, reversed ? ext.ZERO_TO_ONE_EXT : ext.NEGATIVE_ONE_TO_ONE_EXT);
    // setClear caches the value it last sent, flipped or not: step off it
    // first so the (flipped when reversed) 1 really goes out
    depth.setClear(0.5);
    depth.setClear(1);
  };
  set(true);
  const shadows = renderer.shadowMap.render.bind(renderer.shadowMap);
  renderer.shadowMap.render = (...args) => {
    set(false);
    try {
      shadows(...args);
    } finally {
      set(true);
    }
  };
  const polygonOffset = gl.polygonOffset.bind(gl);
  gl.polygonOffset = (factor, units) => (depth.getReversed() ? polygonOffset(-factor, -units) : polygonOffset(factor, units));
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
