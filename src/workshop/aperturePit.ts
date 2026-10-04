import * as THREE from 'three';
import { APERTURE_INNER, APERTURE_OUTER } from './ringAperture';

/** Depth of the pit under the ring aperture (m). */
export const PIT_DEPTH = 3;
/** Stepped throat under each deck edge: the blades' track, then the lens-barrel rings. */
const THROAT = 0.2;
/** How far the throat rings and wall ribs stand into the opening (m). */
const STEP_IN = 0.022;
/** Outer bezel: width on the deck, height, lip overhang and slot roof (m). */
export const BEZEL_W = 0.15;
export const BEZEL_H = 0.018;
const BEZEL_LIP = 0.014;
const BEZEL_SLOT = 0.003;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/**
 * One bay of pit wall, top (deck) to bottom: lined panels, a hazard band
 * under the throat and status lights, fading to black with depth so the
 * pit reads deep without any lights of its own.
 */
function wallTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const W = 128;
  const H = 1024;
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  const px = H / (PIT_DEPTH - THROAT);
  g.fillStyle = '#1b1f25';
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  // Panels, a seam every 0.45 m, bolt heads at the corners
  for (let y = 0; y < H; y += 0.45 * px) {
    const v = 26 + ((y / 7) % 9);
    g.fillStyle = `rgb(${v},${v + 4},${v + 9})`;
    g.fillRect(6, y + 4, W - 12, 0.45 * px - 8);
    g.fillStyle = '#07090b';
    g.fillRect(0, y, W, 3);
    g.fillStyle = '#3a414b';
    for (const bx of [12, W - 14]) for (const by of [y + 10, y + 0.45 * px - 12]) g.fillRect(bx, by, 3, 3);
  }
  // Recessed vertical channel down the middle of the bay
  g.fillStyle = '#0c0e11';
  g.fillRect(W / 2 - 7, 0, 14, H);
  g.fillStyle = '#2c323a';
  g.fillRect(W / 2 - 9, 0, 2, H);
  // Hazard band just under the throat
  const hz = 0.06 * px;
  for (let x = -hz; x < W + hz; x += 16) {
    g.fillStyle = '#c98a26';
    g.beginPath();
    g.moveTo(x, 6);
    g.lineTo(x + 8, 6);
    g.lineTo(x + 8 + hz, 6 + hz);
    g.lineTo(x + hz, 6 + hz);
    g.fill();
  }
  // Lights: a cyan service line, amber pips down the channel, a deep glow ring
  const line = (y: number, h: number, col: string) => {
    ge.fillStyle = col;
    ge.fillRect(0, y, W, h);
    g.fillStyle = '#05070a';
    g.fillRect(0, y - 2, W, h + 4);
  };
  line(0.32 * px, 3, '#5fd4ff');
  line(1.45 * px, 2, '#1f6f8c');
  line(H - 0.12 * px, 3, '#b56a1c');
  for (const d of [0.7, 1.15, 1.9, 2.35]) {
    ge.fillStyle = d < 1.5 ? '#ffb347' : '#8a5a22';
    ge.fillRect(W / 2 - 3, d * px, 6, 10);
  }
  // Depth falloff: the pit swallows the light below the first couple of metres
  const fade = g.createLinearGradient(0, 0, 0, H);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.35, 'rgba(0,0,0,0.45)');
  fade.addColorStop(1, 'rgba(0,0,0,0.92)');
  g.fillStyle = fade;
  g.fillRect(0, 0, W, H);
  const make = (cv: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  return { map: make(c), emissive: make(e) };
}

/** Grated pit floor with a dim amber ring of drain lights. */
function floorTexture(): THREE.CanvasTexture {
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#07080a';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#15191e';
  g.lineWidth = 2;
  for (let k = 0; k <= S; k += 10) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k, S);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

/**
 * The pit under the ring aperture: a stepped throat under each deck edge
 * (the blade track, then lens-barrel rings, as in a camera barrel), panelled
 * walls with ribs and lights that fall away into the dark, and a grated
 * floor. All static: Workshop merges it into a handful of draws.
 */
export function aperturePit(trim: THREE.Material, keep: <T extends { dispose: () => void }>(x: T) => T): THREE.Group {
  const group = new THREE.Group();
  group.name = 'aperture-pit';

  // Throat profiles (r, y). Lathe normals face out when the profile runs
  // upwards, so the outer throat (seen from inside) runs downwards.
  const s = STEP_IN;
  const outer = [
    [APERTURE_OUTER + 0.08, -0.024],
    [APERTURE_OUTER - s, -0.024],
    [APERTURE_OUTER - s, -0.05],
    [APERTURE_OUTER - s * 0.4, -0.065],
    [APERTURE_OUTER - s * 0.4, -0.13],
    [APERTURE_OUTER - s, -0.145],
    [APERTURE_OUTER - s, -0.175],
    [APERTURE_OUTER, -THROAT],
  ];
  const inner = [
    [APERTURE_INNER, -THROAT],
    [APERTURE_INNER + s, -0.175],
    [APERTURE_INNER + s, -0.145],
    [APERTURE_INNER + s * 0.4, -0.13],
    [APERTURE_INNER + s * 0.4, -0.065],
    [APERTURE_INNER + s, -0.05],
    [APERTURE_INNER + s, -0.024],
    [APERTURE_INNER - 0.08, -0.024],
  ];
  // Bezel over the outer edge: a chamfered collar on the deck whose lip
  // overhangs the opening, leaving a narrow slot the blades draw back into
  // (so they slide under real metal instead of vanishing at a flat edge).
  // Wound so every face points out of the solid (lathe normals sit to the
  // right of the direction of travel in (r, y)).
  const O = APERTURE_OUTER;
  const bezel = [
    [O + BEZEL_W, 0.0005],
    [O + BEZEL_W - 0.03, BEZEL_H],
    [O + 0.008, BEZEL_H],
    [O - BEZEL_LIP + 0.004, BEZEL_H - 0.004],
    [O - BEZEL_LIP, BEZEL_H - 0.008],
    [O - BEZEL_LIP, BEZEL_SLOT],
    [O + 0.09, BEZEL_SLOT],
  ];
  for (const [pts, n] of [
    [outer, 160],
    [inner, 96],
    [bezel, 160],
  ] as const) {
    const geo = keep(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), n));
    group.add(new THREE.Mesh(geo, trim));
  }

  // Walls: the bay texture repeats once per blade (outer) / per 16th (inner)
  const tex = wallTextures();
  keep(tex.map);
  keep(tex.emissive);
  const wall = (r: number, bays: number, side: THREE.Side) => {
    const map = keep(tex.map.clone());
    const emissiveMap = keep(tex.emissive.clone());
    for (const t of [map, emissiveMap]) t.repeat.set(bays, 1);
    const mat = keep(
      new THREE.MeshStandardMaterial({
        map,
        emissiveMap,
        emissive: 0xffffff,
        emissiveIntensity: 1.4,
        metalness: 0.6,
        roughness: 0.6,
        side,
      }),
    );
    const h = PIT_DEPTH - THROAT;
    const m = new THREE.Mesh(keep(new THREE.CylinderGeometry(r, r, h, bays * 4, 1, true)), mat);
    m.position.y = -THROAT - h / 2;
    group.add(m);
  };
  wall(APERTURE_OUTER, 24, THREE.BackSide);
  wall(APERTURE_INNER, 12, THREE.FrontSide);

  // Ribs between the bays, standing just into the opening
  const ribH = PIT_DEPTH - THROAT - 0.1;
  const ribGeo = keep(new THREE.BoxGeometry(0.05, ribH, s));
  for (const [r, n, sgn] of [
    [APERTURE_OUTER, 24, -1],
    [APERTURE_INNER, 12, 1],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rib = new THREE.Mesh(ribGeo, trim);
      const rr = r + (sgn * s) / 2;
      rib.position.set(Math.cos(a) * rr, -THROAT - ribH / 2, Math.sin(a) * rr);
      rib.rotation.y = -a + Math.PI / 2;
      group.add(rib);
    }
  }

  const floorMap = keep(floorTexture());
  const floor = new THREE.Mesh(
    keep(new THREE.RingGeometry(APERTURE_INNER, APERTURE_OUTER, 160)),
    keep(new THREE.MeshStandardMaterial({ map: floorMap, color: 0x5a5f66, metalness: 0.3, roughness: 0.9, envMapIntensity: 0.25 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -PIT_DEPTH;
  group.add(floor);
  return group;
}
