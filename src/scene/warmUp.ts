import * as THREE from 'three';

const TEXTURE_SLOTS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap'] as const;

/**
 * Finish all GPU work before the first visible frame: every material's
 * program is compiled (including ones only used later — fitting hologram,
 * flight-check flaps, weapons, diagnostic wireframe) and every texture is
 * uploaded, so nothing hitches mid-sequence. Hidden objects are shown just
 * for the compile, then restored.
 */
export async function warmUp(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  /**
   * Draw one real frame through the actual pipeline (shadows, post) while
   * everything is shown. `compile` alone builds programs against a generic
   * state; the real passes can still key a different variant and compile it
   * on first use — a mid-sequence hitch. One frame here catches all of them.
   */
  renderFrame?: () => void,
): Promise<void> {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  const seen = new Set<THREE.Texture>();
  scene.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const rec = m as unknown as Record<string, unknown>;
      for (const slot of TEXTURE_SLOTS) {
        const t = rec[slot] as THREE.Texture | null | undefined;
        if (t && t.isTexture && !seen.has(t)) {
          seen.add(t);
          renderer.initTexture(t);
        }
      }
      const uniforms = (m as THREE.ShaderMaterial).uniforms;
      if (uniforms) {
        for (const u of Object.values(uniforms)) {
          const t = u?.value as THREE.Texture | undefined;
          if (t && t.isTexture && !seen.has(t)) {
            seen.add(t);
            renderer.initTexture(t);
          }
        }
      }
    }
  });
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    renderer.compile(scene, camera);
  }
  renderFrame?.();
  for (const o of hidden) o.visible = false;
}
