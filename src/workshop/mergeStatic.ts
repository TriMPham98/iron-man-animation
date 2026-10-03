import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collapse a node's direct static mesh children into one mesh per material
 * (geometry baked with each child's local transform). Children flagged
 * `userData.dynamic` — moving jaws, spindles, rams — are left alone.
 * Cuts the robot cell from hundreds of draw calls to a few dozen.
 */
export function mergeStaticChildren(parent: THREE.Object3D): void {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of parent.children) {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.dynamic || Array.isArray(mesh.material)) continue;
    if (mesh.children.length > 0) continue;
    const list = byMat.get(mesh.material) ?? [];
    list.push(mesh);
    byMat.set(mesh.material, list);
  }
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      }
      return g.applyMatrix4(m.matrix);
    });
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    for (const m of meshes) {
      parent.remove(m);
      m.geometry.dispose();
    }
    const out = new THREE.Mesh(merged, mat);
    out.name = `${parent.name || 'node'}-merged`;
    parent.add(out);
  }
}

/** {@link mergeStaticChildren} applied to every node of a subtree. */
export function mergeStaticTree(root: THREE.Object3D): void {
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) nodes.push(o);
  });
  for (const n of nodes) mergeStaticChildren(n);
}
