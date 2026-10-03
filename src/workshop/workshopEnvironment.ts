import * as THREE from 'three';
import { ROBOTS } from './fittingProgram';

/**
 * Tony's Malibu workshop, built procedurally: a raised suit-up platform with
 * boot hatches and robot elevator wells, mast hardpoints for the overhead
 * arms, an eight-sided bay with pilasters, conduits, cable trays and a lit
 * truss, animated JARVIS monitors, server racks, a holo table, crates and
 * floor paint, and soft beams of work light.
 */

export const PLATFORM_RADIUS = 1.05;
/** Platform top = suit sole height (SUIT_GROUND_CLEARANCE). */
export const PLATFORM_TOP = 0.05;
export const HATCH_RADIUS = 0.135;
export const ROOM_RADIUS = 7.4;
export const ROOM_HEIGHT = 4.6;

/** Monitors: left share of the screen given to the live suit scan. */
const SCAN_SPLIT = 0.62;

/** Radius of a floor arm's elevator well (pedestal is 0.19). */
export const WELL_RADIUS = 0.235;

export interface WorkshopEnvironment {
  group: THREE.Group;
  /** Boot lift plates (move with the boots). */
  liftPlates: THREE.Group[];
  /** Slide a floor well's lid shut as its arm finishes stowing (0–1). */
  setWell: (id: string, stow: number) => void;
  /** Screens, rack LEDs, holo table. */
  update: (dt: number) => void;
  dispose: () => void;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** One wall facet: brushed panels, a lit service strip, small status lights. */
function wallTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const W = 512;
  const H = 512;
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  g.fillStyle = '#15181d';
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  // Panels
  const cols = 3;
  const rows = 4;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = (i / cols) * W;
      const y = (j / rows) * H;
      const v = 22 + ((i * 7 + j * 13) % 9);
      g.fillStyle = `rgb(${v},${v + 3},${v + 8})`;
      g.fillRect(x + 3, y + 3, W / cols - 6, H / rows - 6);
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 3;
      g.strokeRect(x + 1.5, y + 1.5, W / cols - 3, H / rows - 3);
    }
  }
  // Grit
  for (let k = 0; k < 2500; k++) {
    const v = Math.random() * 30;
    g.fillStyle = `rgba(${v},${v},${v + 4},0.08)`;
    g.fillRect(Math.random() * W, Math.random() * H, 2, 1);
  }
  // Service strip (≈2.6 m) and floor kick light
  const strip = (y: number, hgt: number, col: string) => {
    g.fillStyle = '#0b0d10';
    g.fillRect(0, y - 4, W, hgt + 8);
    ge.fillStyle = col;
    ge.fillRect(0, y, W, hgt);
  };
  strip(H * 0.42, 6, '#6fd8ff');
  strip(H * 0.965, 4, '#2a6f88');
  // Vertical pilaster lights
  ge.fillStyle = '#9fe6ff';
  ge.fillRect(W - 10, H * 0.08, 4, H * 0.3);
  // Amber status pips
  for (let k = 0; k < 5; k++) {
    ge.fillStyle = k === 2 ? '#ffb347' : '#3a8aa8';
    ge.fillRect(30 + k * 16, H * 0.47, 8, 4);
  }
  return { map: tex(c), emissive: tex(e) };
}

/**
 * JARVIS monitor chrome: grid, frame, readouts and bars on the right; the
 * left 62% is left clear for the live suit scan feed.
 */
function screenTexture(seed: number): THREE.CanvasTexture {
  const W = 512;
  const H = 288;
  const [c, g] = canvas(W, H);
  const split = Math.round(W * SCAN_SPLIT);
  g.fillStyle = '#031018';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(90,216,255,0.85)';
  g.fillStyle = 'rgba(90,216,255,0.9)';
  g.lineWidth = 1.5;
  g.globalAlpha = 0.18;
  for (let x = split; x < W; x += 24) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
  }
  for (let y = 0; y < H; y += 24) {
    g.beginPath();
    g.moveTo(split, y);
    g.lineTo(W, y);
    g.stroke();
  }
  g.globalAlpha = 1;
  // Panel divider + corner ticks on the scan pane
  g.beginPath();
  g.moveTo(split + 0.5, 10);
  g.lineTo(split + 0.5, H - 10);
  g.stroke();
  for (const [x, y, dx, dy] of [
    [8, 8, 1, 1],
    [split - 8, 8, -1, 1],
    [8, H - 8, 1, -1],
    [split - 8, H - 8, -1, -1],
  ]) {
    g.beginPath();
    g.moveTo(x, y + dy * 14);
    g.lineTo(x, y);
    g.lineTo(x + dx * 14, y);
    g.stroke();
  }
  g.font = 'bold 13px monospace';
  g.fillText('DIAGNOSTIC // MARK III', 16, 26);
  // Readouts
  g.font = '13px monospace';
  const lines = [
    ['STRUCTURAL', 'NOMINAL'],
    ['POWER GRID', seed % 2 ? '98.6%' : '99.1%'],
    ['ARC OUTPUT', '3.2 GJ/s'],
    ['SERVO MAP', 'SYNC'],
    ['HUD LAYERS', 'OK'],
  ];
  lines.forEach(([k, v], i) => {
    g.fillText(k, split + 14, 36 + i * 22);
    g.fillText(v, W - 14 - g.measureText(v).width, 36 + i * 22);
  });
  for (let i = 0; i < 18; i++) {
    const h = 6 + ((i * 37 + seed * 11) % 46);
    g.fillRect(split + 14 + i * 9, 262 - h, 6, h);
  }
  return tex(c);
}

/** Platform top decal: radial seams, hazard ring, hatch rings (holes cut out). */
function platformDecal(hatches: Array<[number, number]>): THREE.CanvasTexture {
  const S = 1024;
  const [c, g] = canvas(S, S);
  const R = S / 2;
  g.translate(R, R);
  g.fillStyle = '#1b1f26';
  g.beginPath();
  g.arc(0, 0, R, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(8,10,14,0.9)';
  g.lineWidth = 3;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * R * 0.32, Math.sin(a) * R * 0.32);
    g.lineTo(Math.cos(a) * R * 0.97, Math.sin(a) * R * 0.97);
    g.stroke();
  }
  for (const r of [0.32, 0.62, 0.97]) {
    g.beginPath();
    g.arc(0, 0, R * r, 0, Math.PI * 2);
    g.stroke();
  }
  // Hazard band
  g.save();
  g.beginPath();
  g.arc(0, 0, R * 0.995, 0, Math.PI * 2);
  g.arc(0, 0, R * 0.93, 0, Math.PI * 2, true);
  g.clip();
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    g.fillStyle = i % 2 ? '#c8782a' : '#111317';
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, R, a, a + Math.PI / 72 + 0.02);
    g.fill();
  }
  g.restore();
  // Hatch rings and holes (x → canvas x, −z → canvas y)
  const px = (m: number) => (m / PLATFORM_RADIUS) * R;
  for (const [x, z] of hatches) {
    g.strokeStyle = 'rgba(200,120,42,0.9)';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(px(x), px(-z), px(HATCH_RADIUS + 0.02), 0, Math.PI * 2);
    g.stroke();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(px(x), px(-z), px(HATCH_RADIUS), 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  const t = tex(c);
  t.flipY = false;
  return t;
}

/** Floor arm well: pit under the pedestal + a lid that slides shut over it. */
export interface FloorWellSpec {
  id: string;
  x: number;
  z: number;
}

/** Animated screen: static canvas + scanline sweep, flicker and live bars. */
function screenMaterial(
  map: THREE.Texture,
  scan: THREE.Texture | null,
  tint = new THREE.Color(0x5ad8ff),
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uScan: { value: scan },
      uHasScan: { value: scan ? 1 : 0 },
      uSplit: { value: SCAN_SPLIT },
      uTime: { value: Math.random() * 10 },
      uTint: { value: tint },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform sampler2D uScan;
      uniform float uHasScan;
      uniform float uSplit;
      uniform float uTime;
      uniform vec3 uTint;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(uMap, vUv).rgb;
        // Live suit scan on the left pane (16:9 feed cropped to the pane)
        if (uHasScan > 0.5 && vUv.x < uSplit) {
          vec2 suv = vec2(0.5 + (vUv.x / uSplit - 0.5) * (uSplit * 512.0 / 288.0) * (9.0 / 16.0), vUv.y);
          c = max(c, texture2D(uScan, suv).rgb);
        }
        float sweep = smoothstep(0.03, 0.0, abs(fract(uTime * 0.25) - vUv.y)) * 0.6;
        float lines = 0.85 + 0.15 * sin(vUv.y * 400.0);
        float bars = step(vUv.y, 0.1 + 0.08 * sin(floor(vUv.x * 40.0) * 1.7 + uTime * 3.0))
          * step(uSplit + 0.03, vUv.x) * step(vUv.x, 0.97) * step(0.03, vUv.y);
        vec3 col = c * lines + uTint * (sweep + bars * 0.8);
        col *= 0.92 + 0.08 * sin(uTime * 37.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    toneMapped: false,
  });
}

/** Server rack face: a grid of status LEDs blinking on hashed schedules. */
function rackMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 grid = vec2(6.0, 42.0);
        vec2 cell = floor(vUv * grid);
        vec2 f = fract(vUv * grid);
        float unit = step(0.06, f.y) * step(f.y, 0.94);
        float bezel = mix(0.035, 0.06, step(0.5, fract(cell.y / 6.0)));
        float led = step(0.7, f.x) * step(f.x, 0.85) * step(0.35, f.y) * step(f.y, 0.65);
        float r = h(cell);
        float on = step(0.5, fract(uTime * (0.4 + r * 3.0) + r * 7.0));
        vec3 ledCol = mix(vec3(0.35, 0.9, 1.0), vec3(1.0, 0.65, 0.2), step(0.85, r));
        vec3 col = vec3(bezel) * unit + ledCol * led * on * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    toneMapped: false,
  });
}

/** Floor paint: hazard ring round the cell, walkway lines to the benches. */
function floorDecal(): THREE.CanvasTexture {
  const S = 2048;
  const [c, g] = canvas(S, S);
  const R = S / 2;
  const m = S / 14; // px per metre (14 m square)
  g.translate(R, R);
  g.clearRect(-R, -R, S, S);
  // Hazard tape ring at 2.45 m
  g.save();
  g.beginPath();
  g.arc(0, 0, 2.5 * m, 0, Math.PI * 2);
  g.arc(0, 0, 2.38 * m, 0, Math.PI * 2, true);
  g.clip();
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    g.fillStyle = i % 2 ? 'rgba(20,20,22,0.9)' : 'rgba(214,150,40,0.85)';
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 3 * m, a, a + Math.PI / 180 + 0.004);
    g.fill();
  }
  g.restore();
  // Walkway lines
  g.strokeStyle = 'rgba(214,170,60,0.55)';
  g.lineWidth = 6;
  for (const a of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
    for (const off of [-0.45, 0.45]) {
      const nx = Math.cos(a + Math.PI / 2) * off * m;
      const ny = Math.sin(a + Math.PI / 2) * off * m;
      g.beginPath();
      g.moveTo(Math.cos(a) * 2.6 * m + nx, Math.sin(a) * 2.6 * m + ny);
      g.lineTo(Math.cos(a) * 5.8 * m + nx, Math.sin(a) * 5.8 * m + ny);
      g.stroke();
    }
  }
  // Stencils
  g.fillStyle = 'rgba(214,170,60,0.6)';
  g.font = `bold ${0.22 * m}px monospace`;
  g.textAlign = 'center';
  for (const [a, txt] of [
    [Math.PI * 0.5, 'FITTING CELL 03 · KEEP CLEAR'],
    [Math.PI * 1.5, 'ROBOT ENVELOPE · NO ENTRY'],
  ] as const) {
    g.save();
    g.rotate(a - Math.PI / 2);
    g.fillText(txt, 0, 2.75 * m);
    g.restore();
  }
  const t = tex(c);
  return t;
}

/** Flight-case face: steel frame, corner caps, ribs and a stencil. */
function caseTexture(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, S, S);
  // Ribs
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 40; y < S - 30; y += 22) g.fillRect(14, y, S - 28, 4);
  // Frame + corners
  g.strokeStyle = '#3a3d42';
  g.lineWidth = 14;
  g.strokeRect(7, 7, S - 14, S - 14);
  g.fillStyle = '#2a2c30';
  for (const [x, y] of [
    [0, 0],
    [S - 34, 0],
    [0, S - 34],
    [S - 34, S - 34],
  ]) {
    g.fillRect(x, y, 34, 34);
  }
  // Stencil
  g.fillStyle = 'rgba(20,20,22,0.75)';
  g.font = 'bold 22px monospace';
  g.textAlign = 'center';
  g.fillText('STARK', S / 2, S / 2 - 6);
  g.font = '13px monospace';
  g.fillText('INDUSTRIES · MK III', S / 2, S / 2 + 16);
  g.fillText('HANDLE WITH CARE', S / 2, S / 2 + 36);
  // Wear
  for (let k = 0; k < 600; k++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 6, 1);
  }
  return tex(c);
}

/** Holographic arc reactor projection for the work table (animated). */
function holoReactor(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x5ad8ff,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    wireframe: true,
  });
  const ring = (r: number, tube: number, seg: number) => new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, seg), mat);
  g.add(ring(0.32, 0.02, 48), ring(0.22, 0.015, 40), ring(0.1, 0.03, 24));
  for (let i = 0; i < 10; i++) {
    const coil = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.03), mat);
    const a = (i / 10) * Math.PI * 2;
    coil.position.set(Math.cos(a) * 0.27, Math.sin(a) * 0.27, 0);
    coil.rotation.z = a;
    g.add(coil);
  }
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xbff3ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  g.add(core);
  return g;
}

/**
 * @param hatches world (x, z) of each boot hatch
 * @param wells floor arms that stow into wells
 */
export function createWorkshopEnvironment(
  hatches: Array<[number, number]>,
  wells: FloorWellSpec[] = [],
  scanFeed: THREE.Texture | null = null,
): WorkshopEnvironment {
  const group = new THREE.Group();
  group.name = 'workshop-environment';
  const disposables: Array<{ dispose: () => void }> = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const animated: THREE.ShaderMaterial[] = [];

  const steel = keep(new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.8, roughness: 0.42 }));
  const darkSteel = keep(new THREE.MeshStandardMaterial({ color: 0x14171c, metalness: 0.7, roughness: 0.55 }));
  const concrete = keep(new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.1, roughness: 0.85 }));
  const amber = keep(new THREE.MeshStandardMaterial({ color: 0xc8782a, metalness: 0.4, roughness: 0.45 }));
  const red = keep(new THREE.MeshStandardMaterial({ color: 0x7a1414, metalness: 0.45, roughness: 0.4 }));
  const pipeMat = keep(new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.9, roughness: 0.3 }));
  const lampMat = keep(new THREE.MeshBasicMaterial({ color: 0xfff2dd, toneMapped: false }));
  const glowCyan = keep(
    new THREE.MeshBasicMaterial({ color: 0x6fd8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const stripMat = keep(new THREE.MeshBasicMaterial({ color: 0x8fe0ff, toneMapped: false }));

  // ── Suit-up platform (top flush with the soles) with boot hatches ──
  const shape = new THREE.Shape();
  shape.absarc(0, 0, PLATFORM_RADIUS, 0, Math.PI * 2, false);
  for (const [x, z] of hatches) {
    const hole = new THREE.Path();
    // Shape lives in XY; rotated so shape +Y → world −Z
    hole.absarc(x, -z, HATCH_RADIUS, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const platformGeo = keep(
    new THREE.ExtrudeGeometry(shape, { depth: PLATFORM_TOP, bevelEnabled: false, curveSegments: 72 }),
  );
  const platform = new THREE.Mesh(platformGeo, steel);
  platform.rotation.x = -Math.PI / 2;
  platform.name = 'suit-platform';
  group.add(platform);

  const decalMat = keep(
    new THREE.MeshStandardMaterial({
      map: keep(platformDecal(hatches)),
      transparent: true,
      metalness: 0.75,
      roughness: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  const decal = new THREE.Mesh(keep(new THREE.CircleGeometry(PLATFORM_RADIUS, 96)), decalMat);
  decal.rotation.x = -Math.PI / 2;
  decal.position.y = PLATFORM_TOP + 0.0008;
  group.add(decal);

  const rim = new THREE.Mesh(keep(new THREE.TorusGeometry(PLATFORM_RADIUS, 0.008, 8, 128)), glowCyan);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = PLATFORM_TOP;
  group.add(rim);

  // Hatch pits + boot lift plates on pistons
  const liftPlates: THREE.Group[] = [];
  const pitGeo = keep(new THREE.CylinderGeometry(HATCH_RADIUS, HATCH_RADIUS, 0.85, 32, 1, true));
  const pitMat = keep(new THREE.MeshStandardMaterial({ color: 0x0b0d10, metalness: 0.5, roughness: 0.7, side: THREE.BackSide }));
  const plateGeo = keep(new THREE.CylinderGeometry(HATCH_RADIUS - 0.006, HATCH_RADIUS - 0.006, 0.03, 32));
  const ramGeo = keep(new THREE.CylinderGeometry(0.035, 0.035, 0.8, 16));
  const chrome = keep(new THREE.MeshStandardMaterial({ color: 0xd8dde4, metalness: 1, roughness: 0.18 }));
  for (const [x, z] of hatches) {
    const pit = new THREE.Mesh(pitGeo, pitMat);
    pit.position.set(x, PLATFORM_TOP - 0.425, z);
    group.add(pit);
    const lift = new THREE.Group();
    const plate = new THREE.Mesh(plateGeo, steel);
    plate.position.y = -0.015;
    lift.add(plate);
    const ram = new THREE.Mesh(ramGeo, chrome);
    ram.position.y = -0.43;
    lift.add(ram);
    lift.position.set(x, PLATFORM_TOP, z);
    group.add(lift);
    liftPlates.push(lift);
  }

  // ── Robot wells (elevator pits + sliding lids) ─────────────────────
  const wellPit = keep(new THREE.CylinderGeometry(WELL_RADIUS, WELL_RADIUS, 2.6, 36, 1, true));
  const wellRing = keep(new THREE.TorusGeometry(WELL_RADIUS + 0.012, 0.012, 6, 48));
  const lidGeo = keep(new THREE.CylinderGeometry(WELL_RADIUS + 0.01, WELL_RADIUS + 0.01, 0.025, 36));
  const lids = new Map<string, { lid: THREE.Mesh; open: THREE.Vector3; closed: THREE.Vector3 }>();
  for (const w of wells) {
    const pit = new THREE.Mesh(wellPit, pitMat);
    pit.position.set(w.x, -1.3, w.z);
    group.add(pit);
    const ring = new THREE.Mesh(wellRing, amber);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(w.x, 0.004, w.z);
    group.add(ring);
    const away = new THREE.Vector3(w.x, 0, w.z).normalize();
    const lid = new THREE.Mesh(lidGeo, steel);
    lid.userData.dynamic = true;
    const open = new THREE.Vector3(w.x, 0.0125, w.z).addScaledVector(away, 0.6);
    const closed = new THREE.Vector3(w.x, 0.0125, w.z);
    lid.position.copy(open);
    group.add(lid);
    lids.set(w.id, { lid, open, closed });
  }

  // ── Bay walls, pilasters, conduits, ceiling ────────────────────────
  const wallTex = wallTextures();
  keep(wallTex.map);
  keep(wallTex.emissive);
  for (const t of [wallTex.map, wallTex.emissive]) {
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(8, 1);
  }
  const wallMat = keep(
    new THREE.MeshStandardMaterial({
      map: wallTex.map,
      emissiveMap: wallTex.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.9,
      metalness: 0.55,
      roughness: 0.6,
      side: THREE.BackSide,
    }),
  );
  const walls = new THREE.Mesh(keep(new THREE.CylinderGeometry(ROOM_RADIUS, ROOM_RADIUS, ROOM_HEIGHT, 8, 1, true)), wallMat);
  walls.position.y = ROOM_HEIGHT / 2;
  walls.rotation.y = Math.PI / 8;
  group.add(walls);

  const corner = (i: number, r: number) => {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8 + Math.PI / 8;
    return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
  };
  const facetMid = (i: number, r: number) => {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    return { p: new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r), a };
  };
  const pilasterGeo = keep(new THREE.BoxGeometry(0.5, ROOM_HEIGHT, 0.35));
  const pilStripGeo = keep(new THREE.BoxGeometry(0.04, ROOM_HEIGHT * 0.7, 0.02));
  const facetLen = 2 * ROOM_RADIUS * Math.sin(Math.PI / 8) * 0.96;
  const conduitGeo = keep(new THREE.CylinderGeometry(0.05, 0.05, facetLen, 12));
  const trayGeo = keep(new THREE.BoxGeometry(facetLen, 0.08, 0.3));
  for (let i = 0; i < 8; i++) {
    const c = corner(i, ROOM_RADIUS * 0.985);
    const pil = new THREE.Mesh(pilasterGeo, concrete);
    pil.position.set(c.x, ROOM_HEIGHT / 2, c.z);
    pil.lookAt(0, ROOM_HEIGHT / 2, 0);
    group.add(pil);
    const strip = new THREE.Mesh(pilStripGeo, stripMat);
    strip.position.copy(pil.position).addScaledVector(c.clone().normalize(), -0.18);
    strip.position.y = ROOM_HEIGHT * 0.5;
    strip.lookAt(0, strip.position.y, 0);
    group.add(strip);
    const { p, a } = facetMid(i, ROOM_RADIUS * Math.cos(Math.PI / 8) - 0.12);
    for (const [y, r] of [
      [3.75, 0],
      [3.9, 0.12],
      [0.32, 0],
    ] as const) {
      const pipe = new THREE.Mesh(conduitGeo, pipeMat);
      pipe.position.set(p.x - Math.sin(a) * r, y, p.z - Math.cos(a) * r);
      pipe.rotation.set(0, a, Math.PI / 2);
      group.add(pipe);
    }
    const tray = new THREE.Mesh(trayGeo, steel);
    tray.position.set(p.x - Math.sin(a) * 0.25, 4.15, p.z - Math.cos(a) * 0.25);
    tray.rotation.y = a + Math.PI / 2;
    group.add(tray);
  }

  const ceiling = new THREE.Mesh(keep(new THREE.CircleGeometry(ROOM_RADIUS * 1.05, 8)), darkSteel);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  group.add(ceiling);

  // Ceiling light panels
  const panelGeo = keep(new THREE.PlaneGeometry(1.6, 0.18));
  const panelMat = keep(new THREE.MeshBasicMaterial({ color: 0xcfefff }));
  for (const [x, z, r] of [
    [-2.6, -1.6, 0.3],
    [2.6, -1.6, -0.3],
    [-2.6, 2.2, -0.3],
    [2.6, 2.2, 0.3],
    [0, -3.4, 0],
    [0, 3.6, 0],
  ] as const) {
    const p = new THREE.Mesh(panelGeo, panelMat);
    p.rotation.set(Math.PI / 2, 0, r);
    p.position.set(x, ROOM_HEIGHT - 0.02, z);
    group.add(p);
  }

  // Ceiling truss (clear of the arm masts) + pendant work lamps
  const trussY = ROOM_HEIGHT - 0.35;
  const beamX = keep(new THREE.BoxGeometry(0.16, 0.22, 8.4));
  const beamZ = keep(new THREE.BoxGeometry(8.4, 0.22, 0.16));
  for (const x of [-3.2, -1.35, 1.35, 3.2]) {
    const b = new THREE.Mesh(beamX, steel);
    b.position.set(x, trussY, 0);
    group.add(b);
  }
  for (const z of [-3.6, -1.9, 1.9, 3.6]) {
    const b = new THREE.Mesh(beamZ, steel);
    b.position.set(0, trussY - 0.22, z);
    group.add(b);
  }
  const shadeGeo = keep(new THREE.ConeGeometry(0.22, 0.2, 24, 1, true));
  const bulbGeo = keep(new THREE.CircleGeometry(0.17, 24));
  const cableGeo = keep(new THREE.CylinderGeometry(0.008, 0.008, 0.7, 6));
  for (const [x, z] of [
    [-1.35, -1.9],
    [1.35, -1.9],
    [-1.35, 1.9],
    [1.35, 1.9],
    [-3.2, 0],
    [3.2, 0],
  ] as const) {
    const shade = new THREE.Mesh(shadeGeo, darkSteel);
    shade.position.set(x, trussY - 0.95, z);
    group.add(shade);
    const bulb = new THREE.Mesh(bulbGeo, lampMat);
    bulb.rotation.x = Math.PI / 2;
    bulb.position.set(x, trussY - 1.05, z);
    group.add(bulb);
    const cable = new THREE.Mesh(cableGeo, darkSteel);
    cable.position.set(x, trussY - 0.5, z);
    group.add(cable);
  }

  // Overhead mast hardpoints for the ceiling arms
  const plateGeo2 = keep(new THREE.BoxGeometry(0.5, 0.06, 0.5));
  for (const r of ROBOTS.filter((s) => s.mount === 'ceiling')) {
    const p = new THREE.Mesh(plateGeo2, steel);
    p.position.set(r.base[0], ROOM_HEIGHT - 0.03, r.base[2]);
    group.add(p);
  }

  // ── Workbenches + animated JARVIS monitors ────────────────────────
  const benchGeo = keep(new THREE.BoxGeometry(2.2, 0.9, 0.8));
  const screenGeo = keep(new THREE.PlaneGeometry(1.1, 0.62));
  const benches: Array<[number, number]> = [
    [-Math.PI * 0.78, 6.1],
    [Math.PI * 0.78, 6.1],
    [-Math.PI * 0.42, 6.3],
    [Math.PI * 0.42, 6.3],
  ];
  benches.forEach(([a, r], i) => {
    const bench = new THREE.Group();
    const top = new THREE.Mesh(benchGeo, darkSteel);
    top.position.y = 0.45;
    bench.add(top);
    for (const dx of [-0.42, 0.42]) {
      const screenMat = keep(screenMaterial(keep(screenTexture(i * 2 + (dx > 0 ? 1 : 0))), scanFeed));
      animated.push(screenMat);
      const screen = new THREE.Mesh(screenGeo, screenMat);
      screen.scale.setScalar(0.72);
      screen.position.set(dx, 1.35, -0.2);
      screen.rotation.set(-0.12, -dx * 0.5, 0);
      bench.add(screen);
    }
    const stand = new THREE.Mesh(keep(new THREE.BoxGeometry(0.9, 0.04, 0.06)), steel);
    stand.position.set(0, 1.06, -0.26);
    bench.add(stand);
    // Tools on the bench
    for (let k = 0; k < 4; k++) {
      const tool = new THREE.Mesh(keep(new THREE.BoxGeometry(0.18, 0.05, 0.08)), k % 2 ? amber : steel);
      tool.position.set(-0.8 + k * 0.4, 0.925, 0.15 - (k % 2) * 0.12);
      tool.rotation.y = k * 0.7;
      bench.add(tool);
    }
    bench.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
    bench.lookAt(0, 0, 0);
    group.add(bench);
  });

  // Big wall display behind the cell
  const wallScreen = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(2.8, 1.4)),
    (() => {
      const m = keep(screenMaterial(keep(screenTexture(7)), scanFeed, new THREE.Color(0x7ad8ff)));
      animated.push(m);
      return m;
    })(),
  );
  wallScreen.position.set(0, 2.55, -ROOM_RADIUS * Math.cos(Math.PI / 8) + 0.2);
  group.add(wallScreen);
  const frame = new THREE.Mesh(keep(new THREE.BoxGeometry(2.95, 1.55, 0.08)), darkSteel);
  frame.position.copy(wallScreen.position).add(new THREE.Vector3(0, 0, -0.05));
  group.add(frame);

  // ── Server racks with blinking status LEDs ────────────────────────
  const rackGeo = keep(new THREE.BoxGeometry(0.62, 2.05, 0.95));
  const rackFaceGeo = keep(new THREE.PlaneGeometry(0.54, 1.95));
  const rackMat = keep(rackMaterial());
  animated.push(rackMat);
  const rackAngle = -Math.PI * 0.62;
  for (let k = 0; k < 4; k++) {
    const r = ROOM_RADIUS * Math.cos(Math.PI / 8) - 0.6;
    const a = rackAngle + (k - 1.5) * 0.095;
    const rack = new THREE.Group();
    const body = new THREE.Mesh(rackGeo, darkSteel);
    body.position.y = 1.025;
    rack.add(body);
    const face = new THREE.Mesh(rackFaceGeo, rackMat);
    face.position.set(0, 1.025, 0.476);
    rack.add(face);
    rack.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
    rack.lookAt(0, 0, 0);
    group.add(rack);
  }

  // ── Holo work table with a rotating arc reactor projection ────────
  const holoTable = new THREE.Group();
  const tableBase = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.35, 0.45, 0.85, 32)), darkSteel);
  tableBase.position.y = 0.425;
  holoTable.add(tableBase);
  const tableTop = new THREE.Mesh(
    keep(new THREE.CylinderGeometry(0.75, 0.75, 0.04, 48)),
    keep(new THREE.MeshPhysicalMaterial({ color: 0x0c1a22, metalness: 0.2, roughness: 0.05, transmission: 0.2, transparent: true, opacity: 0.85 })),
  );
  tableTop.position.y = 0.87;
  holoTable.add(tableTop);
  const emitter = new THREE.Mesh(keep(new THREE.RingGeometry(0.5, 0.7, 48)), glowCyan);
  emitter.rotation.x = -Math.PI / 2;
  emitter.position.y = 0.895;
  holoTable.add(emitter);
  const holo = holoReactor();
  holo.position.y = 1.45;
  holoTable.add(holo);
  const holoLight = new THREE.PointLight(0x5ad8ff, 2.2, 3.5, 2);
  holoLight.position.y = 1.4;
  holoTable.add(holoLight);
  holoTable.position.set(3.7, 0, -3.3);
  group.add(holoTable);
  holo.userData.dynamic = true;
  holo.traverse((o) => (o.userData.dynamic = true));

  // ── Flight cases, tool chests, a gas bottle rack ──────────────────
  const crateGeo = keep(new THREE.BoxGeometry(1, 1, 1));
  const caseMap = keep(caseTexture());
  const caseMat = (m: THREE.MeshStandardMaterial) =>
    keep(new THREE.MeshStandardMaterial({ color: m.color, map: caseMap, metalness: 0.35, roughness: 0.55 }));
  const amberCase = caseMat(amber);
  const redCase = caseMat(red);
  const darkCase = caseMat(darkSteel);
  const props: Array<[number, number, number, number, number, number, THREE.Material]> = [
    // x, z, w, h, d, yaw, material
    [-5.2, -2.6, 1.1, 0.7, 0.8, 0.4, amber],
    [-5.0, -1.6, 0.8, 0.5, 0.6, 0.9, darkSteel],
    [-4.6, -3.4, 0.6, 1.1, 0.5, 0.3, red],
    [5.3, 1.9, 1.2, 0.85, 0.6, -0.6, red],
    [5.0, 2.9, 0.7, 0.6, 0.7, -0.2, darkSteel],
    [-5.4, 2.4, 1.0, 1.25, 0.55, 0.9, red],
    [2.0, -5.6, 1.4, 0.6, 0.8, 0.1, darkSteel],
    [-2.2, -5.5, 0.9, 0.9, 0.9, -0.15, amber],
  ];
  for (const [x, z, w, h, d, yaw, mat] of props) {
    const crate = new THREE.Mesh(
      crateGeo,
      mat === amber ? amberCase : mat === red ? redCase : darkCase,
    );
    crate.scale.set(w, h, d);
    crate.position.set(x, h / 2, z);
    crate.rotation.y = yaw;
    group.add(crate);
  }
  const bottleGeo = keep(new THREE.CylinderGeometry(0.11, 0.11, 1.4, 16));
  for (let k = 0; k < 4; k++) {
    const b = new THREE.Mesh(bottleGeo, k % 2 ? pipeMat : red);
    b.position.set(-3.0 + k * 0.26, 0.7, -5.9);
    group.add(b);
  }

  // ── Floor paint ───────────────────────────────────────────────────
  const floorPaint = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(14, 14)),
    keep(
      new THREE.MeshStandardMaterial({
        map: keep(floorDecal()),
        transparent: true,
        depthWrite: false,
        roughness: 0.7,
        metalness: 0.1,
      }),
    ),
  );
  floorPaint.rotation.x = -Math.PI / 2;
  floorPaint.position.y = 0.002;
  floorPaint.renderOrder = 1;
  group.add(floorPaint);

  // ── Work-light beam over the platform (fake volumetric cone) ──────
  const coneMat = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(0xbfe6ff) } },
      vertexShader: /* glsl */ `
        varying float vH;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vH = uv.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vH;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
          float fade = smoothstep(0.0, 0.85, vH) * (1.0 - smoothstep(0.92, 1.0, vH));
          gl_FragColor = vec4(uColor, 0.045 * edge * fade);
        }
      `,
    }),
  );
  const beam = new THREE.Mesh(keep(new THREE.ConeGeometry(1.25, 4.2, 48, 1, true)), coneMat);
  beam.position.set(0, ROOM_HEIGHT - 2.1, 0.15);
  beam.renderOrder = 4;
  group.add(beam);

  let clock = 0;
  return {
    group,
    liftPlates,
    setWell: (id, stow) => {
      const w = lids.get(id);
      if (!w) return;
      const close = THREE.MathUtils.smoothstep(stow, 0.9, 1);
      w.lid.position.lerpVectors(w.open, w.closed, close);
    },
    update: (dt) => {
      clock += dt;
      for (const m of animated) m.uniforms.uTime.value += dt;
      holo.rotation.y = clock * 0.6;
      holo.rotation.x = Math.sin(clock * 0.4) * 0.25;
      holoLight.intensity = 2.0 + Math.sin(clock * 5.3) * 0.25;
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

/** Floor stand, or a hoist rod from the ceiling, holding a parts cradle. */
export function createCradleStand(
  at: THREE.Vector3,
  restBottom: number,
  restTop: number,
  hanging: boolean,
  mats: { steel: THREE.Material; accent: THREE.Material },
): THREE.Group {
  const g = new THREE.Group();
  if (!hanging) {
    const h = Math.max(0.05, restBottom - 0.01);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, h, 12), mats.steel);
    post.position.set(at.x, h / 2, at.z);
    g.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 24), mats.steel);
    foot.position.set(at.x, 0.015, at.z);
    g.add(foot);
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.12), mats.accent);
    saddle.position.set(at.x, h, at.z);
    g.add(saddle);
  } else {
    const top = ROOM_HEIGHT - 0.02;
    const h = Math.max(0.05, top - restTop - 0.01);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, h, 10), mats.steel);
    rod.position.set(at.x, top - h / 2, at.z);
    g.add(rod);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.1), mats.accent);
    hook.position.set(at.x, restTop + 0.012, at.z);
    g.add(hook);
  }
  return g;
}
