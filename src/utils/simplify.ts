import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Resolves once the (tiny, inlined) meshoptimizer wasm is up. */
export const simplifierReady: Promise<void> = MeshoptSimplifier.ready;
let ready = false;
void simplifierReady.then(() => (ready = true));

/**
 * Quadric-error simplification (meshoptimizer) to roughly `ratio` of the
 * triangles, keeping the silhouette and the hard panel edges (creased
 * normals). For distant set dressing. Returns null until the simplifier is
 * ready so callers can fall back.
 */
export function simplifyGeometry(src: THREE.BufferGeometry, ratio: number, creaseDeg = 40): THREE.BufferGeometry | null {
  if (!ready) return null;
  const pos = src.getAttribute('position');
  const index = src.index ? src.index.array : Array.from({ length: pos.count }, (_, i) => i);
  // Weld split-normal / UV-seam duplicates so the simplifier sees one surface
  const remap = new Uint32Array(pos.count);
  const keys = new Map<string, number>();
  const welded: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = keys.get(key);
    if (id === undefined) {
      id = welded.length / 3;
      keys.set(key, id);
      welded.push(x, y, z);
    }
    remap[i] = id;
  }
  const idx = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) idx[i] = remap[index[i]];
  const positions = new Float32Array(welded);
  const target = Math.floor((idx.length * ratio) / 3) * 3;
  const [out] = MeshoptSimplifier.simplify(idx, positions, 3, target, 0.02);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(out, 1));
  return toCreasedNormals(g, THREE.MathUtils.degToRad(creaseDeg));
}
