import * as THREE from 'three';

/**
 * Cyan edge outline + soft gold shell overlays for director plate pick.
 * Uses dedicated materials/geometries so source meshes are never recolored.
 */
export function createPickHighlight(): {
  clear: () => void;
  apply: (root: THREE.Object3D) => void;
} {
  const pickHighlights: THREE.Object3D[] = [];

  const disposePickHighlight = (obj: THREE.Object3D) => {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry && mesh.userData.pickOwnedGeometry) {
        mesh.geometry.dispose();
      }
      const mats = mesh.material
        ? Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]
        : [];
      for (const m of mats) {
        if (m && (m as THREE.Material).userData?.pickOwnedMaterial) {
          m.dispose();
        }
      }
    });
  };

  const clear = () => {
    for (const h of pickHighlights) {
      h.parent?.remove(h);
      disposePickHighlight(h);
    }
    pickHighlights.length = 0;
  };

  const apply = (root: THREE.Object3D) => {
    clear();

    // Snapshot meshes first — adding children during traverse would re-enter
    // on the new shell/edge meshes and blow the call stack.
    const targets: THREE.Mesh[] = [];
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (mesh.userData.isPickHighlight) return;
      targets.push(mesh);
    });

    for (const mesh of targets) {
      // Cyan edge outline
      const edges = new THREE.EdgesGeometry(mesh.geometry, 28);
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x7ee8ff,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
      });
      edgeMat.userData.pickOwnedMaterial = true;
      const lines = new THREE.LineSegments(edges, edgeMat);
      lines.name = '__pickHighlight';
      lines.userData.isPickHighlight = true;
      lines.userData.pickOwnedGeometry = true;
      lines.renderOrder = 999;
      lines.raycast = () => {};
      mesh.add(lines);
      pickHighlights.push(lines);

      // Soft gold fill so the plate reads as selected
      const shellMat = new THREE.MeshBasicMaterial({
        color: 0xe8c547,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      shellMat.userData.pickOwnedMaterial = true;
      const shell = new THREE.Mesh(mesh.geometry, shellMat);
      shell.name = '__pickHighlightShell';
      shell.userData.isPickHighlight = true;
      shell.renderOrder = 998;
      shell.scale.setScalar(1.012);
      shell.raycast = () => {};
      mesh.add(shell);
      pickHighlights.push(shell);
    }
  };

  return { clear, apply };
}
