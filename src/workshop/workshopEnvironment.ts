import * as THREE from 'three';
import { weather } from './robotMaterials';
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
/**
 * One round boot hatch at the platform centre, concentric with the
 * platform seams: two half-disc lift plates (one per boot) close into a
 * single flush disc.
 */
export const FOOT_HATCH_RADIUS = 0.336;
export const ROOM_RADIUS = 7.4;
export const ROOM_HEIGHT = 4.6;

/** Monitors: left share of the screen given to the live suit scan. */
const SCAN_SPLIT = 0.62;

/** Radius of a floor arm's elevator well (pedestal flange is 0.205). */
export const WELL_RADIUS = 0.215;
/** Half-width of the concentric trench the floor arms rise from. */
export const RING_HALF_WIDTH = 0.25;

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

/** Platform top decal: radial seams, hazard ring, centre hatch cut out. */
function platformDecal(): THREE.CanvasTexture {
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
  // Centre boot hatch: hole on the inner seam ring
  const px = (m: number) => (m / PLATFORM_RADIUS) * R;
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(0, 0, px(FOOT_HATCH_RADIUS), 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = 'source-over';
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

/**
 * Bench workstation displays (everything except the main wall TV, which
 * carries the live suit scan): code scroll, reactor schematic,
 * oscilloscope, radar sweep and a power-grid node map — all procedural.
 */
function workstationMaterial(mode: number, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: seed * 3.7 }, uMode: { value: mode }, uSeed: { value: seed } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uMode;
      uniform float uSeed;
      varying vec2 vUv;
      const float PI = 3.14159265;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 13.1) * 43758.5453); }
      float line(float d, float w) { return smoothstep(w, 0.0, abs(d)); }
      void main() {
        vec2 uv = vUv;
        vec3 cyan = vec3(0.35, 0.85, 1.0);
        vec3 amber = vec3(1.0, 0.68, 0.25);
        vec3 col = vec3(0.01, 0.03, 0.05);
        // Header strip
        float head = step(0.9, uv.y);
        col += head * cyan * 0.12;
        col += head * step(0.03, uv.x) * step(uv.x, 0.3) * step(0.93, uv.y) * step(uv.y, 0.96) * cyan * 0.6;
        vec2 p = vec2(uv.x, uv.y / 0.9);
        float body = 1.0 - head;
        if (uMode < 0.5) {
          // Code scroll: rows of tokens drifting up, a blinking cursor
          float rows = 26.0;
          float y = p.y * rows + uTime * 1.6;
          float r = floor(y);
          float fy = fract(y);
          float indent = floor(h(vec2(r, 1.0)) * 4.0) * 0.04;
          float len = 0.15 + h(vec2(r, 2.0)) * 0.6;
          float tok = step(0.5, fract(p.x * 30.0 + h(vec2(r, 3.0)) * 7.0)) * 0.6 + 0.4;
          float on = step(0.05 + indent, p.x) * step(p.x, 0.05 + indent + len) * step(0.25, fy) * step(fy, 0.7);
          vec3 tint = mix(cyan, amber, step(0.82, h(vec2(r, 4.0))));
          col += body * on * tok * tint * 0.75;
        } else if (uMode < 1.5) {
          // Reactor schematic: rotating segmented rings + spokes, side bars
          vec2 c = (p - vec2(0.36, 0.5)) * vec2(1.6, 1.0);
          float rr = length(c);
          float a = atan(c.y, c.x);
          for (int i = 0; i < 4; i++) {
            float R = 0.12 + float(i) * 0.09;
            float seg = step(0.35, fract((a + uTime * (0.3 - float(i) * 0.17)) / (2.0 * PI) * (6.0 + float(i) * 4.0)));
            col += body * line(rr - R, 0.006) * seg * cyan * 0.9;
          }
          col += body * line(fract(a / (2.0 * PI) * 10.0) - 0.5, 0.02) * step(rr, 0.4) * step(0.1, rr) * cyan * 0.15;
          col += body * smoothstep(0.09, 0.0, rr) * vec3(0.7, 0.95, 1.0) * (0.8 + 0.2 * sin(uTime * 4.0));
          for (int i = 0; i < 6; i++) {
            float y0 = 0.15 + float(i) * 0.12;
            float v = 0.4 + 0.5 * h(vec2(float(i), floor(uTime * 2.0)));
            col += body * step(0.7, p.x) * step(p.x, 0.7 + 0.25 * v) * step(y0, p.y) * step(p.y, y0 + 0.05) * mix(cyan, amber, step(0.85, v)) * 0.7;
          }
        } else if (uMode < 2.5) {
          // Oscilloscope: three traces over a grid
          vec2 g = abs(fract(p * vec2(10.0, 8.0)) - 0.5);
          col += body * step(0.48, max(g.x, g.y)) * cyan * 0.12;
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float yc = 0.25 + fi * 0.25;
            float w = sin(p.x * (14.0 + fi * 9.0) - uTime * (3.0 + fi)) * 0.06 + sin(p.x * 41.0 + uTime * 7.0) * 0.015 * fi;
            col += body * line(p.y - yc - w, 0.008) * mix(cyan, amber, step(1.5, fi)) * 1.1;
          }
        } else if (uMode < 3.5) {
          // Radar: rings, rotating sweep, fading blips
          vec2 c = (p - 0.5) * vec2(1.7, 1.0);
          float rr = length(c);
          float a = atan(c.y, c.x);
          float sweepA = mod(uTime * 1.2, 2.0 * PI);
          float d = mod(sweepA - a + 2.0 * PI, 2.0 * PI);
          col += body * step(rr, 0.45) * exp(-d * 3.0) * cyan * 0.45;
          for (int i = 1; i < 4; i++) col += body * line(rr - float(i) * 0.15, 0.004) * cyan * 0.35;
          col += body * (line(c.x, 0.003) + line(c.y, 0.003)) * step(rr, 0.45) * cyan * 0.25;
          for (int i = 0; i < 7; i++) {
            vec2 b = vec2(h(vec2(float(i), 5.0)) - 0.5, h(vec2(float(i), 6.0)) - 0.5) * 0.8;
            float ba = atan(b.y, b.x);
            float age = mod(sweepA - ba + 2.0 * PI, 2.0 * PI);
            col += body * smoothstep(0.02, 0.0, length(c - b)) * exp(-age * 0.6) * amber * 1.4;
          }
        } else {
          // Power grid: lattice of nodes, energized links, meters
          vec2 q = p * vec2(9.0, 6.0);
          vec2 cell = floor(q);
          vec2 f = fract(q) - 0.5;
          float node = smoothstep(0.12, 0.05, length(f));
          float pulse = 0.5 + 0.5 * sin(uTime * 3.0 + h(cell) * 20.0);
          float lx = step(0.5, h(cell + 0.3)) * line(f.y, 0.03) * step(0.0, f.x);
          float ly = step(0.5, h(cell + 0.7)) * line(f.x, 0.03) * step(0.0, f.y);
          float flow = 0.5 + 0.5 * sin((q.x + q.y) * 3.0 - uTime * 5.0);
          col += body * (node * mix(cyan, amber, step(0.8, h(cell))) * (0.5 + 0.8 * pulse) + (lx + ly) * cyan * 0.35 * flow);
        }
        // Scanlines + slight flicker + edge vignette
        col *= 0.9 + 0.1 * sin(vUv.y * 500.0);
        col *= 0.95 + 0.05 * sin(uTime * 43.0);
        col *= smoothstep(0.0, 0.04, uv.x) * smoothstep(1.0, 0.96, uv.x) * smoothstep(0.0, 0.05, uv.y);
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

  // Every hard surface gets the same object-space wear as the robots:
  // grime in the crevices, scratched bare metal, chipped paint
  const W = (m: THREE.MeshStandardMaterial, grime: number, scratch: number, chip: number, scale: number, key: string) =>
    keep(weather(m, { grime, scratch, chip, scale }, `env-${key}`));
  const steel = W(new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.8, roughness: 0.42 }), 0.55, 0.6, 0.15, 7, 'steel');
  const darkSteel = W(new THREE.MeshStandardMaterial({ color: 0x14171c, metalness: 0.7, roughness: 0.55 }), 0.6, 0.35, 0, 5, 'dark');
  const concrete = W(new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.1, roughness: 0.85 }), 0.8, 0, 0, 3, 'concrete');
  const amber = W(new THREE.MeshStandardMaterial({ color: 0xc8782a, metalness: 0.4, roughness: 0.45 }), 0.5, 0.15, 0.55, 10, 'amber');
  const red = W(new THREE.MeshStandardMaterial({ color: 0x7a1414, metalness: 0.45, roughness: 0.4 }), 0.5, 0.15, 0.5, 10, 'red');
  const pipeMat = W(new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.9, roughness: 0.3 }), 0.45, 0.7, 0, 14, 'pipe');
  const lampMat = keep(new THREE.MeshBasicMaterial({ color: 0xfff2dd, toneMapped: false }));
  const glowCyan = keep(
    new THREE.MeshBasicMaterial({ color: 0x6fd8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const stripMat = keep(new THREE.MeshBasicMaterial({ color: 0x8fe0ff, toneMapped: false }));

  // ── Suit-up platform (top flush with the soles) with boot hatches ──
  const shape = new THREE.Shape();
  shape.absarc(0, 0, PLATFORM_RADIUS, 0, Math.PI * 2, false);
  {
    const hole = new THREE.Path();
    hole.absarc(0, 0, FOOT_HATCH_RADIUS, 0, Math.PI * 2, true);
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
      map: keep(platformDecal()),
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

  // Centre hatch pit + one half-disc lift plate per boot on its own ram
  const liftPlates: THREE.Group[] = [];
  const pitMat = keep(new THREE.MeshStandardMaterial({ color: 0x0b0d10, metalness: 0.5, roughness: 0.7, side: THREE.BackSide }));
  const pit = new THREE.Mesh(keep(new THREE.CylinderGeometry(FOOT_HATCH_RADIUS, FOOT_HATCH_RADIUS, 0.85, 64, 1, true)), pitMat);
  pit.position.set(0, PLATFORM_TOP - 0.425, 0);
  group.add(pit);
  const ramGeo = keep(new THREE.CylinderGeometry(0.035, 0.035, 0.8, 16));
  const chrome = keep(new THREE.MeshStandardMaterial({ color: 0xd8dde4, metalness: 1, roughness: 0.18 }));
  const seamGap = 0.003;
  for (const [x] of hatches) {
    const side = x >= 0 ? 1 : -1;
    // Half disc on this boot's side (θ from +Z: 0..π is +X)
    const half = keep(
      new THREE.CylinderGeometry(FOOT_HATCH_RADIUS - 0.005, FOOT_HATCH_RADIUS - 0.005, 0.03, 48, 1, false, side > 0 ? 0 : Math.PI, Math.PI),
    );
    const lift = new THREE.Group();
    const plate = new THREE.Mesh(half, steel);
    plate.position.set(side * seamGap, -0.015, 0);
    lift.add(plate);
    const ram = new THREE.Mesh(ramGeo, chrome);
    ram.position.set(x, -0.43, 0);
    lift.add(ram);
    lift.position.set(0, PLATFORM_TOP, 0);
    group.add(lift);
    liftPlates.push(lift);
  }

  // ── Robot ring: one concentric trench the floor arms rise out of ────
  // A shallow channel around the platform; each arm's elevator well opens
  // in its floor, and a lid slides in under the platform once it stows.
  const ringR = wells.length ? Math.hypot(wells[0].x, wells[0].z) : 1.45;
  const r0 = ringR - RING_HALF_WIDTH;
  const r1 = ringR + RING_HALF_WIDTH;
  const CH = -0.012;
  const chShape = new THREE.Shape();
  chShape.absarc(0, 0, r1, 0, Math.PI * 2, false);
  const inner = new THREE.Path();
  inner.absarc(0, 0, r0, 0, Math.PI * 2, true);
  chShape.holes.push(inner);
  for (const w of wells) {
    const h = new THREE.Path();
    h.absarc(w.x, -w.z, WELL_RADIUS, 0, Math.PI * 2, true);
    chShape.holes.push(h);
  }
  const channel = new THREE.Mesh(keep(new THREE.ShapeGeometry(chShape, 96)), darkSteel);
  channel.rotation.x = -Math.PI / 2;
  channel.position.y = CH;
  group.add(channel);
  const outerWall = new THREE.Mesh(keep(new THREE.CylinderGeometry(r1, r1, -CH, 128, 1, true)), darkSteel);
  outerWall.material = keep(new THREE.MeshStandardMaterial({ color: 0x14171c, metalness: 0.7, roughness: 0.55, side: THREE.BackSide }));
  outerWall.position.y = CH / 2;
  group.add(outerWall);
  const innerWall = new THREE.Mesh(keep(new THREE.CylinderGeometry(r0, r0, -CH, 128, 1, true)), darkSteel);
  innerWall.position.y = CH / 2;
  group.add(innerWall);
  for (const [a0, a1] of [
    [r0 + 0.012, r0 + 0.02],
    [r1 - 0.02, r1 - 0.012],
  ]) {
    const strip = new THREE.Mesh(keep(new THREE.RingGeometry(a0, a1, 160)), glowCyan);
    strip.rotation.x = -Math.PI / 2;
    strip.position.y = CH + 0.0008;
    group.add(strip);
  }

  const wellPit = keep(new THREE.CylinderGeometry(WELL_RADIUS, WELL_RADIUS, 2.6, 36, 1, true));
  const lidGeo = keep(new THREE.CylinderGeometry(WELL_RADIUS + 0.01, WELL_RADIUS + 0.01, 0.025, 36));
  const lids = new Map<string, { lid: THREE.Mesh; open: THREE.Vector3; closed: THREE.Vector3 }>();
  for (const w of wells) {
    const pit = new THREE.Mesh(wellPit, pitMat);
    pit.position.set(w.x, CH - 1.3, w.z);
    group.add(pit);
    const toward = new THREE.Vector3(-w.x, 0, -w.z).normalize();
    const lid = new THREE.Mesh(lidGeo, darkSteel);
    lid.userData.dynamic = true;
    // Flush with the channel floor; parks in under the platform
    const y = CH - 0.002 - 0.0125;
    const open = new THREE.Vector3(w.x, y, w.z).addScaledVector(toward, 0.5);
    const closed = new THREE.Vector3(w.x, y, w.z);
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
  const bezelGeo = keep(new THREE.BoxGeometry(0.84, 0.5, 0.03));
  const monArmGeo = keep(new THREE.BoxGeometry(0.05, 0.3, 0.05));
  const worktopGeo = keep(new THREE.BoxGeometry(2.32, 0.04, 0.86));
  const drawerGeo = keep(new THREE.BoxGeometry(0.48, 0.21, 0.012));
  const handleGeo = keep(new THREE.BoxGeometry(0.2, 0.018, 0.02));
  const kickGeo = keep(new THREE.BoxGeometry(2.18, 0.05, 0.01));
  const keyboardGeo = keep(new THREE.BoxGeometry(0.46, 0.02, 0.16));
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
      // Only the main wall TV shows the suit; benches run other workloads
      const k = i * 2 + (dx > 0 ? 1 : 0);
      const screenMat = keep(workstationMaterial(k % 5, k + 1));
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
    // Monitor bezels + arms, worktop, drawer bank, kick plate, keyboard
    for (const dx of [-0.42, 0.42]) {
      const bezel = new THREE.Mesh(bezelGeo, darkSteel);
      // Sits behind the screen plane (rotated with it) — never coplanar
      bezel.position.set(dx, 1.35, -0.2).add(new THREE.Vector3(0, 0, -0.022).applyEuler(new THREE.Euler(-0.12, -dx * 0.5, 0)));
      bezel.rotation.set(-0.12, -dx * 0.5, 0);
      bench.add(bezel);
      const arm = new THREE.Mesh(monArmGeo, steel);
      arm.position.set(dx * 0.85, 1.18, -0.27);
      bench.add(arm);
    }
    const worktop = new THREE.Mesh(worktopGeo, steel);
    worktop.position.y = 0.915;
    bench.add(worktop);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 3; row++) {
        const x = -0.78 + col * 0.52;
        const y = 0.2 + row * 0.24;
        const drawer = new THREE.Mesh(drawerGeo, row === 2 && col % 2 ? red : darkSteel);
        drawer.position.set(x, y, 0.405);
        bench.add(drawer);
        const handle = new THREE.Mesh(handleGeo, pipeMat);
        handle.position.set(x, y + 0.06, 0.422);
        bench.add(handle);
      }
    }
    const kick = new THREE.Mesh(kickGeo, amber);
    kick.position.set(0, 0.03, 0.402);
    bench.add(kick);
    const kb = new THREE.Mesh(keyboardGeo, darkSteel);
    kb.position.set(0, 0.945, 0.12);
    bench.add(kb);
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
    // Dark smoked glass. No `transmission`: on any material it makes three
    // re-render the whole opaque scene into a refraction target every frame
    // (≈ a second full scene pass) for a barely visible 20 % see-through
    keep(new THREE.MeshPhysicalMaterial({ color: 0x0c1a22, metalness: 0.2, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, opacity: 0.8 })),
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
  const cornerGeo = keep(new THREE.BoxGeometry(0.075, 0.075, 0.075));
  const crateHandleGeo = keep(new THREE.BoxGeometry(0.03, 0.04, 0.2));
  const caseMat = (m: THREE.MeshStandardMaterial, key: string) =>
    W(new THREE.MeshStandardMaterial({ color: m.color, map: caseMap, metalness: 0.35, roughness: 0.55 }), 0.65, 0.25, 0.45, 8, `case-${key}`);
  const amberCase = caseMat(amber, 'amber');
  const redCase = caseMat(red, 'red');
  const darkCase = caseMat(darkSteel, 'dark');
  const props: Array<[number, number, number, number, number, number, THREE.Material]> = [
    // x, z, w, h, d, yaw, material
    [-5.2, -2.6, 1.1, 0.7, 0.8, 0.4, amber],
    [-5.0, -1.6, 0.8, 0.5, 0.6, 0.9, darkSteel],
    [-4.6, -3.4, 0.6, 1.1, 0.5, 0.3, red],
    [5.3, 1.9, 1.2, 0.85, 0.6, -0.6, red],
    [5.0, 2.9, 0.7, 0.6, 0.7, -0.2, darkSteel],
    [-5.4, 2.4, 1.0, 1.25, 0.55, 0.9, red],
    [-4.3, 4.6, 1.4, 0.6, 0.8, 0.5, darkSteel],
    [4.4, 4.4, 0.9, 0.9, 0.9, -0.5, amber],
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
    // Steel corner caps and side handles
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (const sx of [-1, 1]) {
      for (const sy of [0, 1]) {
        for (const sz of [-1, 1]) {
          const cap = new THREE.Mesh(cornerGeo, darkSteel);
          cap.position.set((sx * w) / 2, sy * h + (sy ? -0.03 : 0.03), (sz * d) / 2).applyQuaternion(rot).add(new THREE.Vector3(x, 0, z));
          cap.quaternion.copy(rot);
          group.add(cap);
        }
      }
      const handle = new THREE.Mesh(crateHandleGeo, pipeMat);
      handle.position.set((sx * (w + 0.03)) / 2, h * 0.7, 0).applyQuaternion(rot).add(new THREE.Vector3(x, 0, z));
      handle.quaternion.copy(rot);
      group.add(handle);
    }
  }
  const bottleGeo = keep(new THREE.CylinderGeometry(0.11, 0.11, 1.4, 16));
  for (let k = 0; k < 4; k++) {
    const b = new THREE.Mesh(bottleGeo, k % 2 ? pipeMat : red);
    b.position.set(-0.95 + k * 0.26, 0.7, -6.25);
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
