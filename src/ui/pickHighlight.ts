import * as THREE from 'three';
import {
  sampleFlightPathLine,
  type FlightPathKeys,
} from '../utils/easeHelpers';
import type { ArmorPiece } from '../suit/waves';

/**
 * Cyan edge outline + soft gold shell overlays for director plate pick.
 * Optionally draws the magnetic flight path the plate traveled.
 */
export function createPickHighlight(scene: THREE.Scene): {
  clear: () => void;
  apply: (root: THREE.Object3D, piece?: ArmorPiece | null) => void;
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

  const applyFlightPath = (piece: ArmorPiece) => {
    clearFlightPath();

    const keys = piece.mesh.userData.flightPathKeys as
      | FlightPathKeys
      | undefined;
    if (!keys?.start || !keys?.rest) return;

    const points = sampleFlightPathLine(keys, 72);
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
    mark.position.copy(keys.start);
    mark.renderOrder = 1001;
    mark.raycast = () => {};
    scene.add(mark);
    flightStartMark = mark;
  };

  const apply = (root: THREE.Object3D, piece?: ArmorPiece | null) => {
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

    if (piece) {
      applyFlightPath(piece);
    }
  };

  return { clear, apply };
}
