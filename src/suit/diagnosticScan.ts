import * as THREE from 'three';
import { COLORS } from '../utils/colors';

/** Wall-clock length of the post-assembly diagnostic pass. */
export const DIAGNOSTIC_SCAN_SEC = 4.35;

/** Edge angle threshold for armor plate outlines (degrees). */
const EDGE_THRESHOLD_DEG = 22;

/** World-Y band height around the scan front (bright wire + plane). */
const SCAN_BAND = 0.11;

export interface DiagnosticScan {
  /** Root under the finished suit (scan ring lives here; edges parent to meshes). */
  readonly group: THREE.Group;
  /**
   * Drive the scan 0 → 1.
   * 0–0.1 fade in · 0.1–0.88 feet→head reveal · 0.88–1 fade out.
   */
  setProgress: (t: number) => void;
  setVisible: (v: boolean) => void;
  dispose: () => void;
}

/**
 * Map overall progress to the scan front Y (feet → head).
 * Starts immediately (no lead-in hold) so orbit ease-out has no dead beat;
 * soft-lands at the head for the last ~10%.
 */
export function scanFrontY(
  progress01: number,
  minY: number,
  maxY: number,
): number {
  const t = THREE.MathUtils.clamp(progress01, 0, 1);
  // Full height by t=0.9; hold at head through opacity fade-out
  const u = THREE.MathUtils.clamp(t / 0.9, 0, 1);
  // Slight ease-in-out so the band doesn't race mid-torso
  const e = u * u * (3 - 2 * u);
  return THREE.MathUtils.lerp(minY - 0.04, maxY + 0.06, e);
}

/**
 * Wireframe opacity envelope — full strength immediately so the orbit
 * ease-out scan has no “hesitation” fade-in, soft out only at the end.
 */
export function scanWireOpacity(progress01: number): number {
  const t = THREE.MathUtils.clamp(progress01, 0, 1);
  if (t > 0.9) return Math.max(0, 1 - (t - 0.9) / 0.1);
  return 1;
}

/** Bright band / plane opacity — on immediately, soft out with the wire. */
export function scanBandOpacity(progress01: number): number {
  const t = THREE.MathUtils.clamp(progress01, 0, 1);
  if (t > 0.9) return Math.max(0, 1 - (t - 0.9) / 0.1);
  return 1;
}

/** JARVIS status line for a given scan progress. */
export function diagnosticStatusForProgress(progress01: number): string {
  const t = THREE.MathUtils.clamp(progress01, 0, 1);
  if (t < 0.08) return 'DIAGNOSTIC SCAN // INIT';
  if (t < 0.34) return 'DIAGNOSTIC SCAN // STRUCTURAL';
  if (t < 0.62) return 'DIAGNOSTIC SCAN // POWER GRID';
  if (t < 0.88) return 'DIAGNOSTIC SCAN // SYSTEMS';
  return 'DIAGNOSTIC COMPLETE // NOMINAL';
}

/**
 * Build a holographic wireframe overlay + scan plane over the finished suit.
 *
 * Edge overlays are parented **to each source mesh** so they inherit the full
 * glTF hierarchy (including Y-up correction). Baking mesh.matrixWorld into a
 * sibling under finalModel and then calling updateMatrix() used to wipe that
 * rotation and left a Z-up body lying on the hangar floor.
 *
 * Requires `renderer.localClippingEnabled = true` for the reveal clip.
 */
export function createDiagnosticScan(
  finalModel: THREE.Object3D,
): DiagnosticScan {
  const group = new THREE.Group();
  group.name = 'diagnosticScan';
  group.visible = false;
  finalModel.add(group);

  // Clip: keep geometry with y <= scanY (reveal upward). World-space planes.
  // distance = -y + scanY < 0  ⇒  y > scanY  clipped.
  const revealPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const bandTop = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const bandBottom = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  const revealMat = new THREE.LineBasicMaterial({
    color: COLORS.reactor,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    clippingPlanes: [revealPlane],
    clipShadows: false,
  });

  const bandMat = new THREE.LineBasicMaterial({
    color: COLORS.reactorCore,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    clippingPlanes: [bandTop, bandBottom],
    clipShadows: false,
  });

  const lineMeshes: THREE.LineSegments[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  /** Unique edge geos (shared by reveal + band pair) for a single dispose. */
  const edgeGeos: THREE.BufferGeometry[] = [];

  finalModel.updateWorldMatrix(true, true);

  finalModel.traverse((obj) => {
    if (obj === group) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (mesh.userData?.diagnosticOverlay) return;

    let edges: THREE.EdgesGeometry;
    try {
      edges = new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD_DEG);
    } catch {
      return;
    }
    if (!edges.getAttribute('position')?.count) {
      edges.dispose();
      return;
    }
    edgeGeos.push(edges);

    // Parent to the source mesh — inherits glTF rotation/scale (Y-up fix, etc.)
    const reveal = new THREE.LineSegments(edges, revealMat);
    reveal.name = 'diagnosticReveal';
    reveal.userData.diagnosticOverlay = true;
    reveal.renderOrder = 2;
    reveal.visible = false;
    // Hairline inflate in mesh-local space (avoids z-fight with armor)
    reveal.scale.setScalar(1.004);
    mesh.add(reveal);
    lineMeshes.push(reveal);

    const band = new THREE.LineSegments(edges, bandMat);
    band.name = 'diagnosticBand';
    band.userData.diagnosticOverlay = true;
    band.renderOrder = 3;
    band.visible = false;
    band.scale.setScalar(1.006);
    mesh.add(band);
    lineMeshes.push(band);
  });

  // Bounds: world AABB → finalModel local Y for the scan plane
  const box = new THREE.Box3().setFromObject(finalModel);
  const invFinal = new THREE.Matrix4().copy(finalModel.matrixWorld).invert();
  const corners = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    c.applyMatrix4(invFinal);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) {
    minY = 0;
    maxY = 2;
  }

  // Horizontal scan disc in finalModel local XZ (ring + soft glow)
  const planeGeo = new THREE.RingGeometry(0.08, 0.72, 64);
  geometries.push(planeGeo);
  const planeMat = new THREE.MeshBasicMaterial({
    color: COLORS.reactor,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.name = 'diagnosticPlane';
  plane.rotation.x = -Math.PI / 2;
  plane.userData.diagnosticOverlay = true;
  plane.renderOrder = 4;
  group.add(plane);

  const glowGeo = new THREE.CircleGeometry(0.55, 48);
  geometries.push(glowGeo);
  const glowMat = new THREE.MeshBasicMaterial({
    color: COLORS.reactor,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.name = 'diagnosticGlow';
  glow.rotation.x = -Math.PI / 2;
  glow.userData.diagnosticOverlay = true;
  glow.renderOrder = 1;
  group.add(glow);

  // Scratch planes in finalModel-local space → world (Three clips in world).
  const _localReveal = new THREE.Plane();
  const _localBandTop = new THREE.Plane();
  const _localBandBot = new THREE.Plane();
  const _nDown = new THREE.Vector3(0, -1, 0);
  const _nUp = new THREE.Vector3(0, 1, 0);

  const setProgress = (progress01: number) => {
    const t = THREE.MathUtils.clamp(progress01, 0, 1);
    const y = scanFrontY(t, minY, maxY);
    const wireOp = scanWireOpacity(t);
    const bandOp = scanBandOpacity(t);

    finalModel.updateWorldMatrix(true, false);
    const mw = finalModel.matrixWorld;

    // Local: keep y ≤ scanY  (normal 0,-1,0 · p + y = -py + y)
    _localReveal.set(_nDown, y);
    _localReveal.applyMatrix4(mw);
    revealPlane.copy(_localReveal);

    // Band: y ∈ [y - SCAN_BAND, y + SCAN_BAND * 0.35]
    _localBandTop.set(_nDown, y + SCAN_BAND * 0.35);
    _localBandTop.applyMatrix4(mw);
    bandTop.copy(_localBandTop);

    _localBandBot.set(_nUp, -(y - SCAN_BAND));
    _localBandBot.applyMatrix4(mw);
    bandBottom.copy(_localBandBot);

    revealMat.opacity = 0.55 * wireOp;
    bandMat.opacity = 0.95 * bandOp;
    planeMat.opacity = 0.55 * bandOp;
    glowMat.opacity = 0.18 * bandOp;

    plane.position.y = y;
    glow.position.y = y - 0.002;

    const pulse = 1 + 0.04 * Math.sin(t * Math.PI * 6);
    plane.scale.setScalar(pulse);
    glow.scale.setScalar(0.92 * pulse);
  };

  const setVisible = (v: boolean) => {
    group.visible = v;
    for (const line of lineMeshes) {
      line.visible = v;
    }
    if (!v) {
      revealMat.opacity = 0;
      bandMat.opacity = 0;
      planeMat.opacity = 0;
      glowMat.opacity = 0;
    }
  };

  const dispose = () => {
    for (const line of lineMeshes) {
      line.parent?.remove(line);
    }
    lineMeshes.length = 0;
    group.remove(plane);
    group.remove(glow);
    for (const g of edgeGeos) g.dispose();
    for (const g of geometries) g.dispose();
    revealMat.dispose();
    bandMat.dispose();
    planeMat.dispose();
    glowMat.dispose();
    finalModel.remove(group);
  };

  return { group, setProgress, setVisible, dispose };
}
