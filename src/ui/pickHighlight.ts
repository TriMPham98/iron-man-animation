import * as THREE from 'three';

/**
 * Cyan outline + soft gold shell overlays for director plate pick.
 * Optionally draws the carry path the piece travels (world-space samples).
 */
export function createPickHighlight(scene: THREE.Scene): {
  clear: () => void;
  apply: (root: THREE.Object3D, path?: THREE.Vector3[] | null) => void;
} {
  const pickHighlights: THREE.Object3D[] = [];
  /** World-space flight path line (parented to scene, not the plate). */
  let flightLine: THREE.Line | null = null;
  let flightStartMark: THREE.Mesh | null = null;

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

  const clearFlightPath = () => {
    if (flightLine) {
      flightLine.parent?.remove(flightLine);
      flightLine.geometry.dispose();
      (flightLine.material as THREE.Material).dispose();
      flightLine = null;
    }
    if (flightStartMark) {
      flightStartMark.parent?.remove(flightStartMark);
      flightStartMark.geometry.dispose();
      (flightStartMark.material as THREE.Material).dispose();
      flightStartMark = null;
    }
  };

  const clear = () => {
    for (const h of pickHighlights) {
      h.parent?.remove(h);
      disposePickHighlight(h);
    }
    pickHighlights.length = 0;
    clearFlightPath();
  };

  const applyFlightPath = (points: THREE.Vector3[]) => {
    clearFlightPath();
    if (points.length < 2) return;

    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = points[i].y;
      positions[i * 3 + 2] = points[i].z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.userData.pickOwnedGeometry = true;

    const mat = new THREE.LineBasicMaterial({
      color: 0x7ee8ff,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      depthWrite: false,
    });
    mat.userData.pickOwnedMaterial = true;

    const line = new THREE.Line(geo, mat);
    line.name = '__flightPathLine';
    line.userData.isPickHighlight = true;
    line.renderOrder = 1000;
    line.raycast = () => {};
    scene.add(line);
    flightLine = line;

    // Small marker at scatter start so the origin of the path is obvious
    const markGeo = new THREE.SphereGeometry(0.028, 12, 12);
    markGeo.userData.pickOwnedGeometry = true;
    const markMat = new THREE.MeshBasicMaterial({
      color: 0xe8c547,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
    });
    markMat.userData.pickOwnedMaterial = true;
    const mark = new THREE.Mesh(markGeo, markMat);
    mark.name = '__flightPathStart';
    mark.userData.isPickHighlight = true;
    mark.position.copy(points[0]);
    mark.renderOrder = 1001;
    mark.raycast = () => {};
    scene.add(mark);
    flightStartMark = mark;
  };

  /**
   * Skinned pieces need skinned overlays (same skeleton + bind) or the
   * highlight would sit at the bind pose while the arm is raised.
   */
  const overlayMesh = (
    mesh: THREE.Mesh,
    material: THREE.Material,
  ): THREE.Mesh => {
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      const src = mesh as THREE.SkinnedMesh;
      const skinned = new THREE.SkinnedMesh(src.geometry, material);
      skinned.bindMode = src.bindMode;
      skinned.bind(src.skeleton, src.bindMatrix);
      // Child of the piece: compose the parent's matrix only once
      skinned.matrixAutoUpdate = false;
      skinned.matrix.identity();
      skinned.frustumCulled = false;
      return skinned;
    }
    return new THREE.Mesh(mesh.geometry, material);
  };

  const apply = (root: THREE.Object3D, path?: THREE.Vector3[] | null) => {
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
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        // Skinned: cyan wire + gold fill, both riding the skeleton
        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x7ee8ff,
          wireframe: true,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        });
        wireMat.userData.pickOwnedMaterial = true;
        const fillMat = new THREE.MeshBasicMaterial({
          color: 0xe8c547,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        fillMat.userData.pickOwnedMaterial = true;
        for (const [m, name, order] of [
          [wireMat, '__pickHighlight', 999],
          [fillMat, '__pickHighlightShell', 998],
        ] as const) {
          const o = overlayMesh(mesh, m);
          o.name = name;
          o.userData.isPickHighlight = true;
          o.renderOrder = order;
          o.raycast = () => {};
          mesh.add(o);
          pickHighlights.push(o);
        }
        continue;
      }

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

    if (path) {
      applyFlightPath(path);
    }
  };

  return { clear, apply };
}
