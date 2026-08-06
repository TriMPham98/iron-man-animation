import * as THREE from 'three';
import { COLORS } from '../utils/colors';

export interface EnvironmentHandles {
  group: THREE.Group;
  ground: THREE.Mesh;
}

/**
 * Hangar pad only: detailed metal disc + rings in a cool void.
 * Full-fidelity textures and geometry (no quality tiers).
 */
export function createEnvironment(scene: THREE.Scene): EnvironmentHandles {
  const voidColor = COLORS.bg;
  scene.background = new THREE.Color(voidColor);
  scene.fog = new THREE.FogExp2(voidColor, 0.014);

  const group = new THREE.Group();
  group.name = 'environment';

  const padDetail = 1024;
  const { colorMap, roughnessMap, alphaMap, emissiveMap } =
    buildPadTextures(padDetail);

  const groundGeo = new THREE.CircleGeometry(5.6, 96);
  const groundMat = new THREE.MeshStandardMaterial({
    map: colorMap,
    roughnessMap,
    alphaMap,
    emissiveMap,
    emissive: new THREE.Color(0x3a90b8),
    emissiveIntensity: 0.22,
    color: 0xffffff,
    metalness: 0.72,
    roughness: 0.62,
    transparent: true,
    opacity: 1,
    depthWrite: true,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.name = 'ground';
  group.add(ground);

  addPadRings(group);

  scene.add(group);

  return { group, ground };
}

function addPadRings(group: THREE.Group): void {
  const segs = 80;

  const inner = ringMesh(1.12, 1.22, segs, 0x5ec8ff, 0.32, 0.01);
  inner.name = 'pad-ring-inner';
  group.add(inner);

  const mid = ringMesh(1.85, 1.9, segs, 0x3a6a88, 0.12, 0.011);
  mid.name = 'pad-ring-mid';
  group.add(mid);

  const outer = ringMesh(2.55, 2.62, segs, COLORS.red, 0.14, 0.012);
  outer.name = 'pad-ring-outer';
  group.add(outer);

  const safety = ringMesh(3.35, 3.4, segs, 0xc9a227, 0.06, 0.013);
  safety.name = 'pad-ring-safety';
  group.add(safety);
}

function ringMesh(
  inner: number,
  outer: number,
  segs: number,
  color: number,
  opacity: number,
  y: number,
): THREE.Mesh {
  const geo = new THREE.RingGeometry(inner, outer, segs);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * Procedural hangar-pad maps: panel lines, concentric grooves, grit,
 * soft circular alpha falloff, and a faint reactor-aligned emissive grid.
 */
function buildPadTextures(size: number): {
  colorMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  alphaMap: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
} {
  const color = document.createElement('canvas');
  color.width = size;
  color.height = size;
  const cctx = color.getContext('2d')!;

  const rough = document.createElement('canvas');
  rough.width = size;
  rough.height = size;
  const rctx = rough.getContext('2d')!;

  const alpha = document.createElement('canvas');
  alpha.width = size;
  alpha.height = size;
  const actx = alpha.getContext('2d')!;

  const emis = document.createElement('canvas');
  emis.width = size;
  emis.height = size;
  const ectx = emis.getContext('2d')!;

  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.5;

  // Base metal
  const base = cctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  base.addColorStop(0, '#141820');
  base.addColorStop(0.45, '#0e121a');
  base.addColorStop(0.78, '#0a0d14');
  base.addColorStop(1, '#06080e');
  cctx.fillStyle = base;
  cctx.fillRect(0, 0, size, size);

  // Roughness base (brighter = rougher)
  rctx.fillStyle = '#9a9aa5';
  rctx.fillRect(0, 0, size, size);

  // Grit noise
  const grit = size >= 768 ? 9000 : 4500;
  for (let i = 0; i < grit; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = 8 + Math.random() * 18;
    cctx.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.04 + Math.random() * 0.05})`;
    cctx.fillRect(x, y, 1, 1);
    const rv = 120 + Math.random() * 80;
    rctx.fillStyle = `rgba(${rv},${rv},${rv},0.35)`;
    rctx.fillRect(x, y, 1 + Math.random(), 1 + Math.random());
  }

  // Concentric grooves
  cctx.lineWidth = Math.max(1, size / 512);
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    const r = R * (0.12 + t * 0.82);
    cctx.beginPath();
    cctx.arc(cx, cy, r, 0, Math.PI * 2);
    cctx.strokeStyle = `rgba(30, 40, 58, ${0.18 + (i % 3 === 0 ? 0.2 : 0)})`;
    cctx.stroke();

    rctx.beginPath();
    rctx.arc(cx, cy, r, 0, Math.PI * 2);
    rctx.strokeStyle =
      i % 3 === 0 ? 'rgba(200,200,210,0.55)' : 'rgba(160,160,170,0.25)';
    rctx.lineWidth = 1.5;
    rctx.stroke();
  }

  // Radial panel seams
  const panels = 24;
  for (let i = 0; i < panels; i++) {
    const a = (i / panels) * Math.PI * 2;
    const major = i % 4 === 0;
    cctx.beginPath();
    cctx.moveTo(cx + Math.cos(a) * R * 0.14, cy + Math.sin(a) * R * 0.14);
    cctx.lineTo(cx + Math.cos(a) * R * 0.98, cy + Math.sin(a) * R * 0.98);
    cctx.strokeStyle = major
      ? 'rgba(55, 70, 95, 0.45)'
      : 'rgba(35, 45, 62, 0.28)';
    cctx.lineWidth = major ? 1.6 : 0.9;
    cctx.stroke();

    rctx.beginPath();
    rctx.moveTo(cx + Math.cos(a) * R * 0.14, cy + Math.sin(a) * R * 0.14);
    rctx.lineTo(cx + Math.cos(a) * R * 0.98, cy + Math.sin(a) * R * 0.98);
    rctx.strokeStyle = major
      ? 'rgba(220,220,230,0.5)'
      : 'rgba(180,180,190,0.25)';
    rctx.lineWidth = major ? 2 : 1;
    rctx.stroke();
  }

  // Bolt ring dots
  const boltR = R * 0.72;
  const bolts = 36;
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * Math.PI * 2;
    const x = cx + Math.cos(a) * boltR;
    const y = cy + Math.sin(a) * boltR;
    cctx.beginPath();
    cctx.arc(x, y, size * 0.0045, 0, Math.PI * 2);
    cctx.fillStyle = 'rgba(70, 85, 110, 0.55)';
    cctx.fill();
    cctx.strokeStyle = 'rgba(20, 25, 35, 0.6)';
    cctx.lineWidth = 0.8;
    cctx.stroke();
  }

  // Center plate
  const center = cctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.18);
  center.addColorStop(0, '#1a222e');
  center.addColorStop(0.7, '#121820');
  center.addColorStop(1, '#0c1018');
  cctx.beginPath();
  cctx.arc(cx, cy, R * 0.18, 0, Math.PI * 2);
  cctx.fillStyle = center;
  cctx.fill();
  cctx.strokeStyle = 'rgba(80, 120, 150, 0.35)';
  cctx.lineWidth = 1.5;
  cctx.stroke();

  // Soft circular alpha falloff (edge dissolves into fog)
  const ag = actx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
  ag.addColorStop(0, '#ffffff');
  ag.addColorStop(0.72, '#e8e8e8');
  ag.addColorStop(0.9, '#606060');
  ag.addColorStop(1, '#000000');
  actx.fillStyle = ag;
  actx.fillRect(0, 0, size, size);

  // Emissive: faint concentric reactor cue + sparse radial ticks
  ectx.fillStyle = '#000000';
  ectx.fillRect(0, 0, size, size);
  ectx.strokeStyle = 'rgba(80, 200, 255, 0.55)';
  ectx.lineWidth = Math.max(1.2, size / 400);
  for (const t of [0.22, 0.35, 0.48]) {
    ectx.beginPath();
    ectx.arc(cx, cy, R * t, 0, Math.PI * 2);
    ectx.stroke();
  }
  ectx.strokeStyle = 'rgba(60, 160, 210, 0.25)';
  ectx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ectx.beginPath();
    ectx.moveTo(cx + Math.cos(a) * R * 0.2, cy + Math.sin(a) * R * 0.2);
    ectx.lineTo(cx + Math.cos(a) * R * 0.5, cy + Math.sin(a) * R * 0.5);
    ectx.stroke();
  }
  const eg = ectx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.2);
  eg.addColorStop(0, 'rgba(100, 210, 255, 0.45)');
  eg.addColorStop(1, 'rgba(0,0,0,0)');
  ectx.fillStyle = eg;
  ectx.beginPath();
  ectx.arc(cx, cy, R * 0.2, 0, Math.PI * 2);
  ectx.fill();

  return {
    colorMap: canvasTex(color, true),
    roughnessMap: canvasTex(rough, false),
    alphaMap: canvasTex(alpha, false),
    emissiveMap: canvasTex(emis, true),
  };
}

function canvasTex(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
