import * as THREE from 'three';
import { COLORS } from '../utils/colors';
import { SUIT_GROUND_CLEARANCE } from './loadSuitModel';

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
 * Map overall progress to the scan front Y (**head → feet**).
 * End-of-assembly close-out: starts at the crown and settles to the pad.
 * Full height by t=0.9; holds at feet through opacity fade-out.
 */
export function scanFrontY(
  progress01: number,
  _minY: number,
  maxY: number,
): number {
  const t = THREE.MathUtils.clamp(progress01, 0, 1);
  // Full descent by t=0.9; hold at feet through opacity fade-out
  const u = THREE.MathUtils.clamp(t / 0.9, 0, 1);
  // Slight ease-in-out so the band doesn't race mid-torso
  const e = u * u * (3 - 2 * u);
  // Suit group is lifted in world space; scan lives in suit-local coords.
  // End under the boots (local floor can be slightly below plant y=0).
  // Ring floor = pad clearance − group lift (not mesh minY).
  const floorY = scanRingLocalFloorY();
  return THREE.MathUtils.lerp(maxY + 0.06, floorY, e);
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

// ── Scan ring stack (INITIATE-orb language, slower than exit spin-up) ─────

/** Outer radius of the holographic scan disc (finalModel local units). */
const RING_RADIUS = 0.78;

/**
 * Hangar pad sits at world y=0 with decorative rings at ~0.01–0.013.
 * World-space floor for the scan disc (must stay above the pad).
 */
export const SCAN_RING_PAD_CLEARANCE = 0.028;

/**
 * Suit-local Y for the ring floor when the rig is lifted by
 * {@link SUIT_GROUND_CLEARANCE} (world ring = local + group.y).
 */
export function scanRingLocalFloorY(): number {
  return SCAN_RING_PAD_CLEARANCE - SUIT_GROUND_CLEARANCE;
}

/**
 * Angular speeds (rad/s) — exit CTA spins ~14–18 rad/s; we crawl like the
 * idle orb tracks (several seconds per rev) so the scan feels deliberate.
 */
const SPIN_OUTER = (Math.PI * 2) / 9.5;
const SPIN_MID = -(Math.PI * 2) / 14;
const SPIN_TICKS = (Math.PI * 2) / 12;
const SPIN_TICKS_FINE = -(Math.PI * 2) / 18;
const SPIN_ACCENT_GOLD = -(Math.PI * 2) / 11;
const SPIN_ACCENT_CYAN = (Math.PI * 2) / 13;
const SPIN_SWEEP = (Math.PI * 2) / 7.5;

type RingLayer = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  /** Base opacity at full band strength. */
  baseOpacity: number;
  /** Optional continuous spin rate (rad/s). */
  spin?: number;
};

function makeCanvasTexture(
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  size = 512,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 4;
  return tex;
}

/** Annulus mask helper: paint only between r0–r1 (0–1 of half-size). */
function withAnnulus(
  ctx: CanvasRenderingContext2D,
  size: number,
  rInner: number,
  rOuter: number,
  paint: () => void,
): void {
  const c = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, rOuter * c, 0, Math.PI * 2);
  ctx.arc(c, c, rInner * c, 0, Math.PI * 2, true);
  ctx.clip();
  paint();
  ctx.restore();
}

function drawSegmentedOuter(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2;
  // Segment pattern inspired by .jarvis-orb-ring-outer conic-gradient
  const segs: Array<{ a0: number; a1: number; a: number }> = [
    { a0: -28, a1: 14, a: 0.98 },
    { a0: 26, a1: 70, a: 0.82 },
    { a0: 84, a1: 140, a: 0.95 },
    { a0: 152, a1: 200, a: 0.82 },
    { a0: 216, a1: 272, a: 0.98 },
    { a0: 288, a1: 332, a: 0.88 },
  ];
  withAnnulus(ctx, size, 0.86, 1, () => {
    for (const s of segs) {
      const a0 = ((s.a0 - 90) * Math.PI) / 180;
      const a1 = ((s.a1 - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(c, c, c * 0.97, a0, a1);
      ctx.arc(c, c, c * 0.88, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = `rgba(130, 236, 255, ${s.a})`;
      ctx.fill();
    }
  });
}

function drawDashedMid(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2;
  withAnnulus(ctx, size, 0.72, 0.82, () => {
    // Hairline track
    ctx.strokeStyle = 'rgba(100, 210, 255, 0.35)';
    ctx.lineWidth = size * 0.008;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.77, 0, Math.PI * 2);
    ctx.stroke();
    // Dash beads around the track
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 - Math.PI / 2;
      const span = 0.09;
      ctx.beginPath();
      ctx.arc(c, c, c * 0.77, a, a + span);
      ctx.strokeStyle =
        i % 3 === 0
          ? 'rgba(140, 235, 255, 0.85)'
          : 'rgba(100, 215, 255, 0.5)';
      ctx.lineWidth = size * 0.012;
      ctx.stroke();
    }
  });
}

function drawInnerRing(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2;
  withAnnulus(ctx, size, 0.58, 0.66, () => {
    ctx.strokeStyle = 'rgba(130, 230, 255, 0.9)';
    ctx.lineWidth = size * 0.014;
    ctx.shadowColor = 'rgba(80, 200, 255, 0.7)';
    ctx.shadowBlur = size * 0.04;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Soft fill band
    ctx.fillStyle = 'rgba(40, 130, 190, 0.18)';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.655, 0, Math.PI * 2);
    ctx.arc(c, c, c * 0.585, 0, Math.PI * 2, true);
    ctx.fill();
  });
}

function drawTicks(
  ctx: CanvasRenderingContext2D,
  size: number,
  opts: { count: number; r0: number; r1: number; alpha: number; width: number },
): void {
  const c = size / 2;
  const { count, r0, r1, alpha, width } = opts;
  ctx.strokeStyle = `rgba(160, 240, 255, ${alpha})`;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(c + cos * c * r0, c + sin * c * r0);
    ctx.lineTo(c + cos * c * r1, c + sin * c * r1);
    ctx.stroke();
  }
}

function drawAccentArc(
  ctx: CanvasRenderingContext2D,
  size: number,
  opts: {
    fromDeg: number;
    spanDeg: number;
    r0: number;
    r1: number;
    color: string;
    glow: string;
  },
): void {
  const c = size / 2;
  const a0 = ((opts.fromDeg - 90) * Math.PI) / 180;
  const a1 = ((opts.fromDeg + opts.spanDeg - 90) * Math.PI) / 180;
  ctx.save();
  ctx.shadowColor = opts.glow;
  ctx.shadowBlur = size * 0.035;
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = (opts.r1 - opts.r0) * c;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(c, c, ((opts.r0 + opts.r1) / 2) * c, a0, a1);
  ctx.stroke();
  ctx.restore();
}

function drawSweep(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2;
  withAnnulus(ctx, size, 0.42, 0.98, () => {
    const grad = ctx.createConicGradient(-Math.PI / 2, c, c);
    grad.addColorStop(0, 'rgba(220, 250, 255, 0)');
    grad.addColorStop(0.78, 'rgba(140, 235, 255, 0)');
    grad.addColorStop(0.88, 'rgba(140, 235, 255, 0.06)');
    grad.addColorStop(0.96, 'rgba(180, 245, 255, 0.28)');
    grad.addColorStop(1, 'rgba(220, 250, 255, 0.5)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  });
}

function drawSoftGlow(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(90, 210, 255, 0.32)');
  g.addColorStop(0.28, 'rgba(40, 150, 210, 0.16)');
  g.addColorStop(0.52, 'rgba(20, 80, 140, 0.06)');
  g.addColorStop(0.72, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

function discMesh(
  tex: THREE.Texture,
  radius: number,
  opacity: number,
  renderOrder: number,
): { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; geo: THREE.CircleGeometry } {
  const geo = new THREE.CircleGeometry(radius, 96);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    // depthTest true so the disc occludes behind the suit, but pad clearance
    // keeps it from sinking into the hangar floor.
    depthTest: true,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
    // Prefer drawing above coplanar pad fragments when y is tight
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData.diagnosticOverlay = true;
  mesh.renderOrder = renderOrder;
  return { mesh, mat, geo };
}

/**
 * Multi-layer holographic scan disc — same ring vocabulary as the INITIATE
 * orb exit (segmented outer, mid track, ticks, gold/cyan accents, radar sweep)
 * but with idle-like spin rates instead of the ~0.4s exit spin-up.
 */
function createScanRingStack(parent: THREE.Group): {
  layers: RingLayer[];
  textures: THREE.Texture[];
  geometries: THREE.BufferGeometry[];
  setY: (y: number) => void;
  setOpacity: (bandOp: number) => void;
  spin: (elapsedSec: number) => void;
  disposeLayers: () => void;
} {
  const textures: THREE.Texture[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const layers: RingLayer[] = [];

  const add = (
    draw: (ctx: CanvasRenderingContext2D, size: number) => void,
    opts: { opacity: number; spin?: number; order: number; size?: number },
  ) => {
    const tex = makeCanvasTexture(draw, opts.size ?? 512);
    textures.push(tex);
    const { mesh, mat, geo } = discMesh(tex, RING_RADIUS, 0, opts.order);
    geometries.push(geo);
    parent.add(mesh);
    layers.push({
      mesh,
      mat,
      baseOpacity: opts.opacity,
      spin: opts.spin,
    });
  };

  add(drawSoftGlow, { opacity: 0.55, order: 1 });
  add(drawSegmentedOuter, { opacity: 0.95, spin: SPIN_OUTER, order: 4 });
  add(drawDashedMid, { opacity: 0.8, spin: SPIN_MID, order: 5 });
  add(drawInnerRing, { opacity: 0.85, order: 6 });
  add(
    (ctx, size) =>
      drawTicks(ctx, size, {
        count: 60,
        r0: 0.8,
        r1: 0.92,
        alpha: 0.85,
        width: size * 0.004,
      }),
    { opacity: 0.75, spin: SPIN_TICKS, order: 7 },
  );
  add(
    (ctx, size) =>
      drawTicks(ctx, size, {
        count: 120,
        r0: 0.74,
        r1: 0.8,
        alpha: 0.45,
        width: size * 0.0025,
      }),
    { opacity: 0.55, spin: SPIN_TICKS_FINE, order: 7 },
  );
  add(
    (ctx, size) =>
      drawAccentArc(ctx, size, {
        fromDeg: 198,
        spanDeg: 26,
        r0: 0.9,
        r1: 0.97,
        color: 'rgba(255, 210, 80, 0.95)',
        glow: 'rgba(232, 180, 40, 0.75)',
      }),
    { opacity: 0.9, spin: SPIN_ACCENT_GOLD, order: 8 },
  );
  add(
    (ctx, size) =>
      drawAccentArc(ctx, size, {
        fromDeg: 18,
        spanDeg: 22,
        r0: 0.91,
        r1: 0.98,
        color: 'rgba(180, 245, 255, 0.95)',
        glow: 'rgba(120, 230, 255, 0.8)',
      }),
    { opacity: 0.9, spin: SPIN_ACCENT_CYAN, order: 8 },
  );
  add(drawSweep, { opacity: 0.7, spin: SPIN_SWEEP, order: 9 });

  // Thin bright lead edge (hairline ring at outer rim)
  {
    const geo = new THREE.RingGeometry(
      RING_RADIUS * 0.985,
      RING_RADIUS,
      128,
    );
    geometries.push(geo);
    const mat = new THREE.MeshBasicMaterial({
      color: COLORS.reactorCore,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.diagnosticOverlay = true;
    mesh.renderOrder = 10;
    parent.add(mesh);
    layers.push({ mesh, mat, baseOpacity: 0.65 });
  }

  const setY = (y: number) => {
    // Suit-local floor: under boots, world position still above pad
    const yy = Math.max(y, scanRingLocalFloorY());
    for (const layer of layers) {
      layer.mesh.position.y = yy;
    }
  };

  const setOpacity = (bandOp: number) => {
    // Soft breathe on the whole stack (slower than exit flare)
    const breathe = 0.92 + 0.08 * Math.sin(performance.now() * 0.0016);
    for (const layer of layers) {
      layer.mat.opacity = layer.baseOpacity * bandOp * breathe;
    }
  };

  const spin = (elapsedSec: number) => {
    for (const layer of layers) {
      if (layer.spin == null) continue;
      // Y-up disc: rotate around local Y after the X=-90° tilt ⇒ mesh.rotation.z
      layer.mesh.rotation.z = layer.spin * elapsedSec;
    }
  };

  const disposeLayers = () => {
    for (const layer of layers) {
      parent.remove(layer.mesh);
      layer.mat.map = null;
      layer.mat.dispose();
    }
    for (const g of geometries) g.dispose();
    for (const t of textures) t.dispose();
    layers.length = 0;
  };

  return { layers, textures, geometries, setY, setOpacity, spin, disposeLayers };
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

  // Clip: keep geometry with y >= scanY (reveal head → feet as front falls).
  // distance = y - scanY < 0  ⇒  y < scanY  clipped.
  const revealPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
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

  // Horizontal holographic ring stack (INITIATE-orb language, slower spin)
  const ringStack = createScanRingStack(group);
  // Spin phase: wall-clock from first visible frame so resume mid-scan stays smooth
  let spinOriginMs: number | null = null;

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

    // Local: keep y ≥ scanY  (head→feet reveal as front descends)
    // normal (0,1,0), constant = -y  ⇒  distance = py - y
    _localReveal.set(_nUp, -y);
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

    ringStack.setY(y);
    ringStack.setOpacity(bandOp);

    if (spinOriginMs == null) spinOriginMs = performance.now();
    const elapsed = (performance.now() - spinOriginMs) / 1000;
    ringStack.spin(elapsed);

    // Very slow scale breathe (not the old fast pulse)
    const breathe = 1 + 0.015 * Math.sin(elapsed * 1.1);
    for (const layer of ringStack.layers) {
      layer.mesh.scale.setScalar(breathe);
    }
  };

  const setVisible = (v: boolean) => {
    group.visible = v;
    for (const line of lineMeshes) {
      line.visible = v;
    }
    if (!v) {
      revealMat.opacity = 0;
      bandMat.opacity = 0;
      ringStack.setOpacity(0);
      spinOriginMs = null;
    }
  };

  const dispose = () => {
    for (const line of lineMeshes) {
      line.parent?.remove(line);
    }
    lineMeshes.length = 0;
    ringStack.disposeLayers();
    for (const g of edgeGeos) g.dispose();
    for (const g of geometries) g.dispose();
    revealMat.dispose();
    bandMat.dispose();
    finalModel.remove(group);
  };

  return { group, setProgress, setVisible, dispose };
}
