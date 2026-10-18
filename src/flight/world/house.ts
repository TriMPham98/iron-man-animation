import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HOME, HOME_HEIGHT, type Heightfield } from './heightfield';
import { FRAME_YAW, buildCliffGeometry, cliffHeight, crest, toLocal, toWorld } from './houseCliff';
import { Batch, Footprint, Outline, alongOutline, beam, box, fascia, flat, houseMaterials, slab, strut, wallQuad, type P2 } from './houseKit';
import { cypressGeometry, palmGeometry, shrubGeometry } from './housePlants';

/**
 * The house on the bluff, after the Stark house in Iron Man (2008) and Iron
 * Man 3 — the Lautner-style concrete-and-glass house on the cliffs at Point
 * Dume. Thin white floor plates sweep along the cliff edge in organic
 * curves, each with a deep overhang and a thick rounded edge; behind them
 * run continuous ribbons of glass on slim mullions, warm rooms lit inside.
 * The great room bulges out over the drop, held up on a fan of tapered
 * concrete struts raking back into the rock, the workshop's lit band below
 * it. Two white drums stand on the upper roof. At the west end an infinity
 * pool sits on a dry-stone bastion with a helical stair up to the terrace,
 * and a switchback stair runs down the face to a landing at the water.
 * Behind: the round entry court with its sculpture, and the drive winding
 * up into the hills. The landing pad sits on the lawn beside the house,
 * ringed in the reactor's blue.
 *
 * Everything static is merged per material (a dozen draw calls); palms,
 * cypress and shrubs are instanced; furniture, mullions, rails and the
 * small lights drop out beyond ~900 m.
 */

/** Where the suit stands (world xz) and the pad's height. */
export const PAD = new THREE.Vector2(HOME.x, HOME.y + 14);
export const PAD_Y = HOME_HEIGHT + 0.35;

// ── Plan (house frame: x along the cliff, z out to sea, y up from the terrace) ──

/** Main floor glass line. */
const E0 = Outline.smooth([
  [24, 4], [42, -2], [64, -4], [88, -1], [104, 6], [110, 18], [104, 30], [90, 38],
  [78, 45], [72, 56], [60, 60.5], [48, 56], [42, 45], [32, 40], [22, 34], [19, 20],
]);
/** Upper floor glass line. */
const E1 = Outline.smooth([
  [30, 6], [50, 0], [74, -1], [96, 5], [102, 15], [95, 25], [80, 30], [62, 34], [44, 31], [33, 22],
]);
const S1 = E0.offset(3.6); // main roof / upper terrace
const P0 = E0.offset(2.2); // main floor deck
const S2 = E1.offset(4.2); // upper roof
const Y0 = 0.3; // main floor
const Y1 = 4.6; // upper floor (top of S1)
const Y2 = 9.3; // top of the upper roof
/** The great room's lower level: the workshop, under the bulge. */
const DRUM = new THREE.Vector2(60, 50.5);
const LL = Outline.circle(DRUM.x, DRUM.y, 10.5, 72);
const LL_FLOOR = -4.4;
/** Rooftop drums. */
const TOWERS = [
  { x: 50, z: 12, r: 3.2, h: 3.3, slant: 0 },
  { x: 67, z: 8, r: 2.5, h: 4.3, slant: 0.22 },
];
/** Pool wing: deck on a stone bastion. */
const PD = Outline.smooth([[10, 26], [28, 23], [38, 29], [40, 42], [35, 53], [20, 55], [9, 51], [6, 38]]);
const PD_Y = 0.7;
const POOL = roundedRect(13, 41.5, 33, 52.1, 1.2);
/** Helical stair from the lawn up to the upper terrace. */
const SPIRAL = new THREE.Vector2(13, 23);
/** Entry court. */
const COURT = new THREE.Vector2(64, -26);
const PAD_L = toLocal(PAD.x, PAD.y);

function roundedRect(x0: number, z0: number, x1: number, z1: number, r: number): Outline {
  const pts: THREE.Vector2[] = [];
  const corners: [number, number, number][] = [
    [x1 - r, z0 + r, -Math.PI / 2],
    [x1 - r, z1 - r, 0],
    [x0 + r, z1 - r, Math.PI / 2],
    [x0 + r, z0 + r, Math.PI],
  ];
  for (const [cx, cz, a0] of corners) for (let i = 0; i <= 4; i++) pts.push(new THREE.Vector2(cx + Math.cos(a0 + (i / 4) * (Math.PI / 2)) * r, cz + Math.sin(a0 + (i / 4) * (Math.PI / 2)) * r));
  return Outline.fromPoints(pts);
}

// ── Collision ──

const FOOTPRINTS = [
  ...TOWERS.map((t) => new Footprint(Outline.circle(t.x, t.z, t.r, 24), Y2 + t.h)),
  new Footprint(S2, Y2),
  new Footprint(S1, Y1),
  new Footprint(PD, PD_Y),
  new Footprint(P0, Y0),
];
const _l = new THREE.Vector2();

/**
 * Tops of the built surfaces (pad deck, roofs, terraces, the rock of the
 * bluff) at a point, or −∞: the flight model lands on them like ground.
 */
export function structureTop(x: number, z: number): number {
  if (Math.hypot(x - PAD.x, z - PAD.y) < 7) return PAD_Y + 0.35;
  const l = toLocal(x, z, _l);
  if (l.x < -100 || l.x > 180 || l.y < -40 || l.y > 140) return -Infinity;
  let top = -Infinity;
  for (const f of FOOTPRINTS) {
    if (f.top > top && f.test(l.x, l.y)) top = f.top;
  }
  const rock = cliffHeight(l.x, l.y);
  return HOME_HEIGHT + Math.max(top, rock);
}

// ── Build ──

interface Batches {
  concrete: Batch;
  stone: Batch;
  rock: Batch;
  metal: Batch;
  metalFine: Batch;
  glass: Batch;
  lit: Batch;
  litFine: Batch;
  water: Batch;
  lawn: Batch;
}

const WHITE = new THREE.Color(0.74, 0.73, 0.71);
const WARM_CEIL = new THREE.Color(1.0, 0.82, 0.62);
const WARM_WALL = new THREE.Color(0.95, 0.8, 0.62);
const FLOOR = new THREE.Color(0.62, 0.55, 0.46);
const LAMP = new THREE.Color(1.0, 0.78, 0.5);
const COOL = new THREE.Color(0.72, 0.86, 1.0);
const FRAME = new THREE.Color(0.16, 0.17, 0.18);

/** Glass on the faces that look out (sea, sides); solid wall on the street side. */
const seaward = (_p: THREE.Vector2, n: THREE.Vector2) => n.y > -0.42;

function facade(B: Batches, o: Outline, y0: number, y1: number, glassIf: (p: THREE.Vector2, n: THREE.Vector2) => boolean, transom?: number): void {
  const P = o.pts;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const n = o.nrm[i].clone().add(o.nrm[(i + 1) % P.length]).normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    if (glassIf(mid, n)) {
      B.glass.add(wallQuad(a, b, y0, y1, n));
      B.metalFine.add(beam(a, b, y0 + 0.06, 0.12, 0.14, 0.04), FRAME);
      B.metalFine.add(beam(a, b, y1 - 0.06, 0.12, 0.14, 0.04), FRAME);
      if (transom) B.metalFine.add(beam(a, b, y0 + transom, 0.06, 0.1, 0.04), FRAME);
      if (i % 2 === 0) B.metalFine.add(box(0.16, y1 - y0, 0.07, a.x, (y0 + y1) / 2, a.y, -Math.atan2(n.y, n.x)), FRAME);
    } else {
      B.concrete.add(wallQuad(a, b, y0, y1, n), WHITE);
      // Lit slot windows down the street side, a wall-washer at the foot
      if (y1 - y0 > 3 && i % 3 === 0) {
        const c = a.clone().lerp(b, 0.5).addScaledVector(n, 0.03);
        B.litFine.add(box(0.02, y1 - y0 - 1.4, 0.32, c.x, (y0 + y1) / 2 + 0.1, c.y, -Math.atan2(n.y, n.x)), LAMP, 2.2);
        B.litFine.add(box(0.12, 0.08, 0.2, c.x + n.x * 0.3, y0 + 0.04, c.y + n.y * 0.3, -Math.atan2(n.y, n.x)), LAMP, 10);
      }
    }
  }
}

/** Lit rooms behind a glass line: floor, glowing ceiling, a lit core wall, downlights. */
function interior(B: Batches, o: Outline, y0: number, y1: number, depth: number, light: THREE.Color, glow: number): Outline {
  const inner = o.offset(-0.12);
  B.lit.add(flat(inner, y0 + 0.04, true), FLOOR, glow * 0.35);
  B.lit.add(flat(inner, y1 - 0.04, false), light, glow);
  const core = o.offset(-depth);
  for (let i = 0; i < core.pts.length; i++) {
    const a = core.pts[i];
    const b = core.pts[(i + 1) % core.pts.length];
    const n = core.nrm[i];
    // Lit wall, darker wainscot below
    B.lit.add(wallQuad(a, b, y0, y0 + 0.9, n), light.clone().multiplyScalar(0.55), glow * 0.7);
    B.lit.add(wallQuad(a, b, y0 + 0.9, y1, n), light, glow * 1.3);
  }
  // Recessed downlights on a grid, between the glass and the core
  const lights = o.offset(-1.2);
  for (let x = -40; x < 140; x += 3.2)
    for (let z = -20; z < 80; z += 3.2) {
      if (!lights.contains(x, z) || core.contains(x, z)) continue;
      B.litFine.add(new THREE.PlaneGeometry(0.28, 0.28).rotateX(Math.PI / 2).translate(x, y1 - 0.06, z), LAMP, 14);
    }
  return core;
}

type Vignette = (B: Batch, x: number, z: number, yaw: number, y: number) => void;

const put = (B: Batch, w: number, h: number, d: number, lx: number, ly: number, lz: number, x: number, y: number, z: number, yaw: number, color: THREE.ColorRepresentation, glow = 0) => {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Local (lx along the view, lz across) → frame
  B.add(box(w, h, d, x + c * lx + s * lz, y + ly, z - s * lx + c * lz, yaw), color, glow);
};

const SOFA = 0xcfc6b8;
const WOOD = 0x3a2a1c;
const DARK = 0x111214;
const sofaSet: Vignette = (B, x, z, yaw, y) => {
  put(B, 0.95, 0.42, 3.2, 0, 0.21, 0, x, y, z, yaw, SOFA, 0.06);
  put(B, 0.25, 0.8, 3.2, -0.48, 0.4, 0, x, y, z, yaw, SOFA, 0.06);
  put(B, 0.7, 0.36, 1.4, 1.3, 0.18, 0, x, y, z, yaw, WOOD);
  put(B, 0.8, 0.7, 0.8, 2.0, 0.35, 1.6, x, y, z, yaw, 0x8a7a66, 0.04);
  put(B, 0.8, 0.7, 0.8, 2.0, 0.35, -1.6, x, y, z, yaw, 0x8a7a66, 0.04);
  put(B, 0.05, 1.6, 0.05, -0.3, 0.8, 2.0, x, y, z, yaw, DARK);
  put(B, 0.45, 0.35, 0.45, -0.3, 1.7, 2.0, x, y, z, yaw, LAMP, 3);
};
const dining: Vignette = (B, x, z, yaw, y) => {
  put(B, 1.2, 0.08, 3.2, 0.5, 0.74, 0, x, y, z, yaw, 0x2c2018);
  put(B, 0.9, 0.7, 0.12, 0.5, 0.35, -1.3, x, y, z, yaw, DARK);
  put(B, 0.9, 0.7, 0.12, 0.5, 0.35, 1.3, x, y, z, yaw, DARK);
  for (const s of [-1.1, 0, 1.1])
    for (const side of [-0.5, 1.5]) put(B, 0.5, 0.9, 0.5, side, 0.45, s, x, y, z, yaw, 0x6b5b4a, 0.03);
  put(B, 0.5, 0.25, 0.5, 0.5, 2.6, 0, x, y, z, yaw, LAMP, 5);
};
const pianoSet: Vignette = (B, x, z, yaw, y) => {
  put(B, 1.6, 0.35, 1.5, 0.3, 0.85, 0, x, y, z, yaw, 0x050505);
  put(B, 1.2, 0.7, 1.2, 0.2, 0.35, 0, x, y, z, yaw, 0x050505);
  put(B, 0.4, 0.5, 1.0, -0.8, 0.25, 0, x, y, z, yaw, DARK);
  put(B, 0.6, 1.4, 0.6, 1.2, 0.7, -2.2, x, y, z, yaw, 0x2f4a22);
};
const loungers: Vignette = (B, x, z, yaw, y) => {
  for (const s of [-1.2, 1.2]) {
    put(B, 2.0, 0.3, 0.75, 0, 0.25, s, x, y, z, yaw, 0xe8e4dc, 0.02);
    put(B, 0.6, 0.5, 0.75, -0.8, 0.5, s, x, y, z, yaw, 0xe8e4dc, 0.02);
  }
  put(B, 0.5, 0.45, 0.5, 0, 0.22, 0, x, y, z, yaw, WOOD);
};
const bedroom: Vignette = (B, x, z, yaw, y) => {
  put(B, 2.2, 0.55, 2.0, 0.2, 0.28, 0, x, y, z, yaw, 0xf0ece4, 0.07);
  put(B, 0.15, 1.2, 2.4, -1.0, 0.6, 0, x, y, z, yaw, 0x4a3a2c);
  put(B, 0.5, 0.5, 0.5, -0.8, 0.25, 1.6, x, y, z, yaw, WOOD);
  put(B, 0.3, 0.3, 0.3, -0.8, 0.7, 1.6, x, y, z, yaw, LAMP, 4);
  put(B, 0.8, 0.8, 0.8, 1.9, 0.4, -1.6, x, y, z, yaw, 0x7a6a56, 0.04);
};

function furnish(B: Batch, o: Outline, y: number, step: number, inset: number, sets: Vignette[], where: (p: THREE.Vector2, n: THREE.Vector2) => boolean, phase = 2): void {
  let k = 0;
  alongOutline(
    o,
    step,
    (p, n) => {
      if (!where(p, n)) return;
      const at = p.clone().addScaledVector(n, -inset);
      // Facing the glass: local +x along the outward normal
      sets[k++ % sets.length](B, at.x, at.y, -Math.atan2(n.y, n.x), y);
    },
    phase,
  );
}

/** Glass balustrade with a slim top rail along part of an outline. */
function balustrade(B: Batches, o: Outline, y: number, where: (p: THREE.Vector2, n: THREE.Vector2) => boolean): void {
  const P = o.pts;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const n = o.nrm[i];
    if (!where(a.clone().add(b).multiplyScalar(0.5), n)) continue;
    B.glass.add(wallQuad(a, b, y, y + 1.05, n));
    B.metalFine.add(beam(a, b, y + 1.08, 0.06, 0.09, 0.03), 0x9a9c9e);
    if (i % 3 === 0) B.metalFine.add(box(0.05, 0.12, 0.05, a.x, y + 0.06, a.y), 0x9a9c9e);
  }
}

/** A ribbon laid on the ground along a plan curve (drive, paths). */
function ribbon(B: Batch, ground: (x: number, z: number) => number, pts: P2[], width: number, color: THREE.ColorRepresentation, lift = 0.1, curb?: THREE.ColorRepresentation): void {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const n = Math.ceil(curve.getLength() / 2.5);
  const P = curve.getSpacedPoints(n);
  const tris: THREE.Vector3[] = [];
  const curbs: THREE.Vector3[] = [];
  const edge = (i: number, s: number, w: number) => {
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(P.length - 1, i + 1)];
    const t = new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
    const x = P[i].x - t.y * w * s;
    const z = P[i].z + t.x * w * s;
    return new THREE.Vector3(x, ground(x, z) + lift, z);
  };
  for (let i = 0; i < P.length - 1; i++) {
    const l0 = edge(i, -1, width / 2);
    const r0 = edge(i, 1, width / 2);
    const l1 = edge(i + 1, -1, width / 2);
    const r1 = edge(i + 1, 1, width / 2);
    tris.push(l0, r0, r1, l0, r1, l1);
    if (curb) {
      for (const s of [-1, 1]) {
        const a0 = edge(i, s, width / 2);
        const a1 = edge(i + 1, s, width / 2);
        const b0 = edge(i, s, width / 2 + 0.35);
        const b1 = edge(i + 1, s, width / 2 + 0.35);
        for (const v of [a0, a1, b0, b1]) v.y += 0.08;
        curbs.push(a0, b0, b1, a0, b1, a1);
      }
    }
  }
  const up = new THREE.Vector3(0, 1, 0);
  const g = new THREE.BufferGeometry().setFromPoints(tris);
  B.add(flip(g, up), color);
  if (curb) B.add(flip(new THREE.BufferGeometry().setFromPoints(curbs), up), curb);
}

/** Makes every triangle of a flat-ish soup face `dir`, with flat normals. */
function flip(g: THREE.BufferGeometry, dir: THREE.Vector3): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (n.dot(dir) < 0) {
      pos.setXYZ(i, b.x, b.y, b.z);
      pos.setXYZ(i + 1, a.x, a.y, a.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

export function buildHouse(field?: Heightfield): THREE.Group {
  const g = new THREE.Group();
  g.name = 'house';
  const M = houseMaterials();
  const B: Batches = {
    concrete: new Batch('house-concrete', 0.25),
    stone: new Batch('house-stone', 0.25),
    rock: new Batch('house-rock', 1 / 16, 'wall'),
    metal: new Batch('house-metal'),
    metalFine: new Batch('house-metal-fine'),
    glass: new Batch('house-glass'),
    lit: new Batch('house-lit'),
    litFine: new Batch('house-lit-fine'),
    water: new Batch('house-pool', 0.25),
    lawn: new Batch('house-lawn'),
  };
  /** Ground height in the frame (terrace = 0), the rock top included. */
  const ground = (x: number, z: number) => {
    const w = toWorld(x, z);
    const t = field ? field.heightAt(w.x, w.y) - HOME_HEIGHT : 0;
    return Math.max(t, cliffHeight(x, z));
  };

  // The bluff
  if (field) B.rock.add(buildCliffGeometry(field), 0xffffff);

  // Floor plates: deck, main roof (= upper terrace) and upper roof, each with
  // a thick rounded edge beam
  B.concrete.add(slab(P0, Y0, 1.2, 0.08), WHITE);
  B.concrete.add(slab(S1, Y1, 0.45, 0.1), WHITE);
  B.concrete.add(fascia(S1, Y1 - 0.4, 0.75, 0.55), WHITE);
  B.concrete.add(slab(S2, Y2, 0.45, 0.1), WHITE);
  B.concrete.add(fascia(S2, Y2 - 0.4, 0.8, 0.55), WHITE);
  // A shallow parapet upstand round the upper terrace's outer edge
  B.concrete.add(fascia(S1, Y1 + 0.18, 0.2, 0.3), WHITE);

  // Glass lines with mullions; solid wall to the street
  facade(B, E0, Y0, Y1 - 0.45, seaward, 2.9);
  facade(B, E1, Y1, Y2 - 0.45, seaward);
  const core0 = interior(B, E0, Y0, Y1 - 0.45, 8, WARM_CEIL, 0.3);
  const core1 = interior(B, E1, Y1, Y2 - 0.45, 6.5, WARM_WALL, 0.26);
  // Bedrooms upstairs: partitions from the glass back to the core
  alongOutline(E1, 9, (p, n) => {
    if (!seaward(p, n)) return;
    const q = p.clone().addScaledVector(n, -6.4);
    B.lit.add(beam(p.clone().addScaledVector(n, -0.2), q, (Y1 + Y2 - 0.45) / 2, Y2 - 0.45 - Y1, 0.15), WARM_WALL, 0.3);
  }, 4.5);
  furnish(B.litFine, E0, Y0, 7, 3.4, [sofaSet, dining, sofaSet, pianoSet, loungers], (p, n) => seaward(p, n) && !core0.contains(p.x - n.x * 3.4, p.y - n.y * 3.4));
  furnish(B.litFine, E1, Y1, 9, 3.2, [bedroom], (p, n) => seaward(p, n) && !core1.contains(p.x - n.x * 3.2, p.y - n.y * 3.2), 9);
  // The great room: a round sunken lounge under the drum, a fire column
  for (let i = 0; i < 18; i++) {
    const a = Math.PI * 0.15 + (i / 17) * Math.PI * 0.7;
    const r = 4.2;
    B.litFine.add(box(1.2, 0.45, 0.9, DRUM.x + Math.cos(a) * r, Y0 + 0.22, DRUM.y + Math.sin(a) * r, -a), SOFA, 0.06);
  }
  B.litFine.add(new THREE.CylinderGeometry(0.9, 1.1, Y1 - 0.45 - Y0, 16).translate(DRUM.x, (Y0 + Y1 - 0.45) / 2, DRUM.y - 1), 0x2a2420, 0.05);
  B.litFine.add(new THREE.CylinderGeometry(0.7, 0.7, 0.9, 16).translate(DRUM.x, Y0 + 1.2, DRUM.y - 1), new THREE.Color(1, 0.55, 0.2), 6);

  // The workshop under the great room: a white band, a cool-lit window
  // ribbon, its floor, and the struts down into the rock
  const LLf = LL.offset(0.8);
  B.concrete.add(slab(LLf, LL_FLOOR, 0.6, 0.08), WHITE);
  facade(B, LL, -3.3, -1.5, (p) => p.y > crest(p.x) - 2);
  for (let i = 0; i < LL.pts.length; i++) {
    const a = LL.pts[i];
    const b = LL.pts[(i + 1) % LL.pts.length];
    if (a.y < crest(a.x) - 3) continue;
    // White bands above and below the window ribbon
    B.concrete.add(wallQuad(a, b, LL_FLOOR, -3.3, LL.nrm[i]), WHITE);
    B.concrete.add(wallQuad(a, b, -1.5, Y0 - 0.9, LL.nrm[i]), WHITE);
  }
  interior(B, LL, LL_FLOOR, Y0 - 1.2, 6, COOL, 0.45);
  // Cars and armour gantries in the workshop
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.2 + (i / 5) * Math.PI * 0.6;
    const x = DRUM.x + Math.cos(a) * 7.5;
    const z = DRUM.y + Math.sin(a) * 7.5;
    if (i % 2 === 0) {
      B.litFine.add(box(4.4, 0.7, 1.9, x, LL_FLOOR + 0.45, z, -a + Math.PI / 2), [0xb01818, 0x202224, 0xc8c8cc][i % 3], 0.02);
      B.litFine.add(box(2.2, 0.5, 1.7, x, LL_FLOOR + 1.0, z, -a + Math.PI / 2), 0x101214, 0.02);
    } else {
      B.litFine.add(box(1.6, 2.6, 1.0, x, LL_FLOOR + 1.3, z, -a), 0x3a3e44, 0.05);
      B.litFine.add(box(0.5, 1.9, 0.3, x, LL_FLOOR + 1.2, z, -a), new THREE.Color(0.9, 0.2, 0.1), 0.2);
    }
  }
  for (let i = 0; i < 9; i++) {
    const a = THREE.MathUtils.degToRad(22 + i * 17);
    const top = new THREE.Vector3(DRUM.x + Math.cos(a) * 10.2, LL_FLOOR - 0.5, DRUM.y + Math.sin(a) * 10.2);
    const ub = DRUM.x + Math.cos(a) * 10.2 * 0.75;
    const yb = -17;
    const vb = crest(ub) + -yb / 4.6 - 1.2;
    B.concrete.add(strut(top, new THREE.Vector3(ub, yb, Math.min(vb, top.z)), 1.3, 0.9, 0.45, 0.5), 0xf0eee8);
  }

  // Rooftop drums
  for (const t of TOWERS) {
    const cyl = new THREE.CylinderGeometry(t.r, t.r, t.h, 40, 1, false);
    const p = cyl.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setY(i, p.getY(i) + p.getX(i) * t.slant);
    cyl.computeVertexNormals();
    B.concrete.add(cyl.translate(t.x, Y2 + t.h / 2, t.z), WHITE);
    // A slot of glass round each
    B.glass.add(new THREE.CylinderGeometry(t.r + 0.02, t.r + 0.02, 0.5, 40, 1, true).translate(t.x, Y2 + t.h - 0.9, t.z));
  }
  // Skylights on the upper roof
  for (const [x, z] of [[58, 18], [80, 14], [40, 16]] as const) {
    B.metal.add(box(2.2, 0.25, 1.2, x, Y2 + 0.12, z), FRAME);
    B.glass.add(box(2.0, 0.05, 1.0, x, Y2 + 0.27, z));
  }

  // Soffit downlights under the overhangs
  alongOutline(E0.offset(1.8), 2.6, (p, n) => {
    if (n.y > -0.6) B.litFine.add(new THREE.PlaneGeometry(0.22, 0.22).rotateX(Math.PI / 2).translate(p.x, Y1 - 0.47, p.y), LAMP, 16);
  });
  alongOutline(E1.offset(2.0), 2.6, (p, n) => {
    if (n.y > -0.6) B.litFine.add(new THREE.PlaneGeometry(0.22, 0.22).rotateX(Math.PI / 2).translate(p.x, Y2 - 0.47, p.y), LAMP, 16);
  });

  // Balustrades: the upper terrace's edge, and the deck where it hangs over the drop
  balustrade(B, S1.offset(-0.45), Y1 + 0.38, (_p, n) => n.y > -0.5);
  balustrade(B, P0.offset(-0.3), Y0, (p) => p.y > crest(p.x) - 3);

  // Pool wing: deck on a dry-stone bastion, the infinity pool, a white parapet
  B.stone.add(slab(PD.offset(-0.1), PD_Y - 0.35, 9, 0.05), 0xa8a096);
  B.concrete.add(slab(PD, PD_Y, 0.35, 0.05, [POOL]), WHITE);
  B.water.add(flat(POOL, PD_Y - 0.12, true), 0xffffff);
  for (let i = 0; i < POOL.pts.length; i++) {
    const a = POOL.pts[i];
    const b = POOL.pts[(i + 1) % POOL.pts.length];
    B.stone.add(wallQuad(a, b, PD_Y - 0.4, PD_Y, POOL.nrm[i].clone().negate()), 0xd8d0c0);
  }
  const infinity = (p: THREE.Vector2) => p.y > 51 && p.x > 11 && p.x < 35;
  for (let i = 0; i < PD.pts.length; i++) {
    const a = PD.pts[i];
    const b = PD.pts[(i + 1) % PD.pts.length];
    const mid = a.clone().add(b).multiplyScalar(0.5);
    if (infinity(mid)) continue;
    const inA = a.clone().addScaledVector(PD.nrm[i], -0.15);
    const inB = b.clone().addScaledVector(PD.nrm[(i + 1) % PD.pts.length], -0.15);
    B.concrete.add(beam(inA, inB, PD_Y + 0.45, 0.9, 0.3, 0.12), WHITE);
  }
  // The spillway: a dark wet lip below the infinity edge
  B.stone.add(box(21, 0.5, 1.2, 23, PD_Y - 0.55, 54.1), 0x3a4648);
  furnish(B.concrete, PD.offset(-4.5), PD_Y, 6, 0, [loungers], (p) => p.y < 39 && p.y > 28 && p.x > 12 && p.x < 36);
  // Pool lights
  for (let x = 15; x < 33; x += 4) B.litFine.add(new THREE.PlaneGeometry(0.35, 0.2).translate(x, PD_Y - 0.3, 41.55), new THREE.Color(0.6, 0.95, 1), 10);

  // Helical stair from the lawn up to the terrace
  {
    const steps = 22;
    const rise = (Y1 - 0) / steps;
    for (let i = 0; i < steps; i++) {
      const a = Math.PI * 0.2 + i * 0.27;
      const r = 1.6;
      B.concrete.add(box(2.2, 0.12, 0.85, SPIRAL.x + Math.cos(a) * r, (i + 1) * rise - 0.06, SPIRAL.y + Math.sin(a) * r, -a), WHITE);
    }
    B.concrete.add(new THREE.CylinderGeometry(0.4, 0.4, Y1 + 1.1, 16).translate(SPIRAL.x, (Y1 + 1.1) / 2, SPIRAL.y), WHITE);
    // The curved outer stringer wall, rising with the steps
    const tris: THREE.Vector3[] = [];
    const R = 2.75;
    const segs = 40;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const a0 = Math.PI * 0.2 + t0 * steps * 0.27;
      const a1 = Math.PI * 0.2 + t1 * steps * 0.27;
      const p0 = new THREE.Vector3(SPIRAL.x + Math.cos(a0) * R, t0 * Y1 - 0.6, SPIRAL.y + Math.sin(a0) * R);
      const p1 = new THREE.Vector3(SPIRAL.x + Math.cos(a1) * R, t1 * Y1 - 0.6, SPIRAL.y + Math.sin(a1) * R);
      const q0 = p0.clone().setY(p0.y + 1.6);
      const q1 = p1.clone().setY(p1.y + 1.6);
      tris.push(p0, p1, q1, p0, q1, q0);
    }
    const band = new THREE.BufferGeometry().setFromPoints(tris);
    band.computeVertexNormals();
    // Both faces of the band
    const back = band.clone();
    const bp = back.getAttribute('position');
    for (let i = 0; i < bp.count; i += 3) {
      const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
      bp.setXYZ(i, bp.getX(i + 1), bp.getY(i + 1), bp.getZ(i + 1));
      bp.setXYZ(i + 1, x, y, z);
    }
    back.computeVertexNormals();
    B.concrete.add(band, WHITE);
    B.concrete.add(back, WHITE);
  }

  // Switchback stair down the cliff face to a landing at the water
  {
    const x0 = 5;
    const x1 = -13;
    const flights = 8;
    const drop = 6.4;
    let y = PD_Y - 0.3;
    for (let f = 0; f < flights; f++) {
      const xa = f % 2 === 0 ? x0 : x1;
      const xb = f % 2 === 0 ? x1 : x0;
      const ya = y;
      const yb = y - drop;
      // Stand off the face: furthest-out rock along this flight, plus a margin
      let z = 0;
      for (let k = 0; k <= 8; k++) {
        const u = THREE.MathUtils.lerp(xa, xb, k / 8);
        const yy = THREE.MathUtils.lerp(ya, yb, k / 8);
        z = Math.max(z, crest(u) + Math.max(0, -yy) / 4.6 + 2.6);
      }
      z += f * 0.25;
      const n = 30;
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        B.concrete.add(box(0.62, 0.1, 1.5, THREE.MathUtils.lerp(xa, xb, t), THREE.MathUtils.lerp(ya, yb, t), z), 0xe8e4dc);
      }
      B.concrete.add(strut(new THREE.Vector3(xa, ya - 0.3, z), new THREE.Vector3(xb, yb - 0.3, z), 1.5, 0.35, 1.5, 0.35), 0xe0dcd4);
      // Landing at the turn, tied back to the rock
      B.concrete.add(box(2.4, 0.3, 3.2, xb, yb - 0.15, z + 0.6), 0xe0dcd4);
      B.concrete.add(box(1.0, 0.8, Math.max(0.5, z - crest(xb) + 1), xb, yb - 0.5, (z + crest(xb) + Math.max(0, -yb) / 4.6) / 2 - 0.5), 0xd8d4cc);
      // Rail on the outer side
      const len = Math.abs(xb - xa);
      const dirAng = Math.atan2(yb - ya, xb - xa);
      B.metalFine.add(new THREE.BoxGeometry(Math.hypot(len, drop), 0.05, 0.05).rotateZ(dirAng).translate((xa + xb) / 2, (ya + yb) / 2 + 1.0, z + 0.72), 0x9a9c9e);
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        B.metalFine.add(box(0.04, 1.0, 0.04, THREE.MathUtils.lerp(xa, xb, t), THREE.MathUtils.lerp(ya, yb, t) + 0.5, z + 0.72), 0x9a9c9e);
      }
      y = yb;
    }
    // The landing at the bottom, on the rocks just above the swell
    const zEnd = crest(x0) + 56 / 4.6 + 4;
    B.concrete.add(box(9, 1.2, 6, x0 - 2, -52.6, zEnd), 0xd0ccc4);
    B.concrete.add(box(2.4, Math.max(1, -52 - y), 2.4, x0, (y - 52) / 2, zEnd - 3), 0xd0ccc4);
  }

  // Entry court: pale paving with dark ring joints, a planted drum with the sculpture
  {
    const court = Outline.circle(COURT.x, COURT.y, 14, 64);
    B.stone.add(flat(court, 0.06, true), 0xe8e2d6);
    for (const r of [6, 9.5, 12.5]) B.metal.add(slab(Outline.circle(COURT.x, COURT.y, r + 0.08, 64), 0.075, 0.02, 0, [Outline.circle(COURT.x, COURT.y, r - 0.08, 64)]), 0x1a1a1a);
    B.concrete.add(slab(Outline.circle(COURT.x, COURT.y, 4.2, 48), 0.75, 0.75, 0.06, [Outline.circle(COURT.x, COURT.y, 3.8, 48)]), WHITE);
    B.stone.add(flat(Outline.circle(COURT.x, COURT.y, 3.85, 48), 0.6, true), 0x3a2e22);
    // The bronze: three swelling lobes
    const bronze = mergeGeometries(
      [
        new THREE.SphereGeometry(1.3, 16, 12).scale(0.8, 1.6, 0.6).translate(-0.6, 2.3, 0),
        new THREE.SphereGeometry(1.1, 16, 12).scale(1, 1.3, 0.7).translate(0.7, 1.8, 0.3),
        new THREE.SphereGeometry(0.9, 16, 12).scale(1.3, 0.8, 0.8).translate(0.1, 1.1, -0.4),
      ].map((x) => x.toNonIndexed()),
    )!;
    B.metal.add(bronze.translate(COURT.x, 0, COURT.y), 0x2a3a34);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      B.litFine.add(box(0.4, 0.18, 0.05, COURT.x + Math.cos(a) * 4.22, 0.4, COURT.y + Math.sin(a) * 4.22, -a + Math.PI / 2), LAMP, 8);
    }
  }
  // Lawn round the house, fading out raggedly into the dry grass
  {
    const lawn: THREE.Vector3[] = [];
    const cols: number[] = [];
    const green = new THREE.Color(0.13, 0.17, 0.055);
    const dry = new THREE.Color(0.3, 0.25, 0.12);
    const c = new THREE.Color();
    const step = 2;
    const inside = (x: number, z: number) => {
      // Rounded box round the house, ragged at the edge
      const dx = Math.max(0, Math.abs(x - 52) - 62);
      const dz = Math.max(0, z < 20 ? 20 - z - 50 : 0);
      const n = Math.sin(x * 0.31) * Math.sin(z * 0.27) * 3 + Math.sin(x * 0.11 + z * 0.17) * 4;
      return 1 - THREE.MathUtils.smoothstep(Math.hypot(dx, dz) + n, -2, 8);
    };
    for (let x = -26; x < 130; x += step)
      for (let z = -44; z < 60; z += step) {
        const corners = [
          [x, z], [x + step, z], [x + step, z + step], [x, z + step],
        ].map(([cx, cz]) => {
          const a = crest(cx);
          const k = cz > a - 1.5 ? 0 : inside(cx, cz);
          // The edge sinks under the ground, so it meets it along a smooth contour
          return { p: new THREE.Vector3(cx, ground(cx, cz) + 0.12 - 0.6 * (1 - Math.min(1, k * 3)), cz), k };
        });
        if (corners.every((q) => q.k <= 0.02)) continue;
        if (corners.some((q) => P0.contains(q.p.x, q.p.z) || PD.contains(q.p.x, q.p.z) || q.p.distanceTo(new THREE.Vector3(COURT.x, q.p.y, COURT.y)) < 14.2 || Math.hypot(q.p.x - PAD_L.x, q.p.z - PAD_L.y) < 7.6)) continue;
        for (const i of [0, 2, 1, 0, 3, 2]) {
          const q = corners[i];
          lawn.push(q.p);
          const mott = 0.5 + 0.5 * Math.sin(q.p.x * 0.7) * Math.sin(q.p.z * 0.9 + q.p.x * 0.2);
          c.copy(dry).lerp(green, q.k).multiplyScalar(0.9 + 0.2 * mott);
          cols.push(c.r, c.g, c.b);
        }
      }
    const lg = flip(new THREE.BufferGeometry().setFromPoints(lawn), new THREE.Vector3(0, 1, 0));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    B.lawn.add(lg);
  }

  // Drive up into the hills, and paths
  ribbon(B.stone, ground, [[64, -38], [69, -60], [84, -92], [102, -130], [108, -175], [98, -225], [92, -280], [100, -330]], 7, 0x34322e, 0.1, 0xd8d2c6);
  ribbon(B.stone, ground, [[12, 10], [26, -6], [44, -16], [52, -22]], 2.4, 0xd8d0c0, 0.08);
  ribbon(B.stone, ground, [[PAD_L.x + 7, PAD_L.y + 2], [14.5, 17]], 2.4, 0xd8d0c0, 0.08);
  // Bollard lights along the drive
  {
    const curve = new THREE.CatmullRomCurve3([[64, -38], [69, -60], [84, -92], [102, -130], [108, -175]].map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const n = Math.floor(curve.getLength() / 14);
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n);
      const t = curve.getTangentAt(i / n);
      const x = p.x - t.z * 4.4;
      const z = p.z + t.x * 4.4;
      const y = ground(x, z);
      B.metal.add(box(0.18, 0.8, 0.18, x, y + 0.4, z), FRAME);
      B.litFine.add(box(0.2, 0.12, 0.2, x, y + 0.72, z), LAMP, 8);
    }
  }

  // ── Meshes ──
  const houseGroup = new THREE.Group();
  houseGroup.position.set(HOME.x, HOME_HEIGHT, HOME.y);
  houseGroup.rotation.y = FRAME_YAW;
  const keep = (m: THREE.Mesh, parent: THREE.Object3D = houseGroup) => {
    m.receiveShadow = true;
    m.castShadow = false;
    parent.add(m);
    return m;
  };
  keep(B.rock.build(M.rock));
  keep(B.concrete.build(M.concrete));
  keep(B.stone.build(M.stone));
  keep(B.metal.build(M.metal));
  keep(B.lit.build(M.lit));
  const pool = keep(B.water.build(M.water));
  keep(B.lawn.build(M.foliage));
  const glass = keep(B.glass.build(M.glass));
  glass.renderOrder = 1;
  // Fine detail: gone at range
  const centre = new THREE.Vector3(60, 0, 20);
  const fine = new THREE.Group();
  fine.position.copy(centre).negate();
  keep(B.metalFine.build(M.metal), fine);
  keep(B.litFine.build(M.lit), fine);
  const lod = new THREE.LOD();
  lod.position.copy(centre);
  lod.addLevel(fine, 0);
  lod.addLevel(new THREE.Object3D(), 900);
  houseGroup.add(lod);

  // Pool ripples drift
  const water = M.water.normalMap!;
  const t0 = performance.now();
  pool.onBeforeRender = () => {
    const t = (performance.now() - t0) / 1000;
    water.offset.set(t * 0.012, t * 0.007);
  };

  // Planting
  const at = (x: number, z: number, onDeck = false) => new THREE.Vector3(x, onDeck ? PD_Y : ground(x, z), z);
  const plant = (geo: THREE.BufferGeometry, spots: [THREE.Vector3, number][]) => {
    const mesh = new THREE.InstancedMesh(geo, M.foliage, spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    spots.forEach(([p, s], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (p.x * 12.9898 + p.z * 78.233) % (Math.PI * 2));
      mesh.setMatrixAt(i, m.compose(p, q, new THREE.Vector3(s, s, s)));
    });
    mesh.computeBoundingSphere();
    keep(mesh as unknown as THREE.Mesh);
  };
  plant(palmGeometry(), [
    [at(37, 45, true), 1.05], [at(35.5, 49, true), 0.85], [at(-6, 6), 0.9], [at(116, 24), 1.1],
    [at(113, 38), 0.95], [at(52, -16), 0.9], [at(77, -15), 1.0], [at(40, -11), 0.8], [at(98, -14), 0.95],
    [at(-14, -12), 1.1], [at(128, 8), 0.85], [at(84, 44), 0.9],
  ]);
  plant(cypressGeometry(), [
    [at(-2, -4), 1], [at(1.5, -9), 0.9], [at(-5, -16), 1.1], [at(120, -8), 1], [at(124, -2), 0.85], [at(29, -14), 0.95],
    [at(25, -20), 1.05], [at(118, 32), 0.9],
  ]);
  const shrubs: [THREE.Vector3, number][] = [];
  alongOutline(E0.offset(5), 4.2, (p) => {
    if (p.y > crest(p.x) - 2.5 || PD.contains(p.x, p.y) || p.distanceTo(SPIRAL) < 4 || p.distanceTo(PAD_L) < 9) return;
    shrubs.push([at(p.x, p.y), 0.8 + ((p.x * 7.1) % 0.6)]);
  });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    shrubs.push([at(COURT.x + Math.cos(a) * 2.6, COURT.y + Math.sin(a) * 2.6).setY(0.6), 0.7]);
  }
  for (let i = 0; i < 24; i++) {
    // Along the drive's first stretch
    const z = -40 - i * 4.5;
    const x = 64 + (i % 2 ? 6 : -6) + i * 0.6;
    shrubs.push([at(x, z), 0.9 + (i % 3) * 0.2]);
  }
  plant(shrubGeometry(), shrubs);

  g.add(houseGroup);

  // Landing pad
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.3 });
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.6, 2.2) });
  const padGroup = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, 0.7, 64), dark);
  const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 5.85, 96).rotateX(-Math.PI / 2), ringMat);
  ring.position.y = 0.36;
  const inner = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.62, 64).rotateX(-Math.PI / 2), ringMat);
  inner.position.y = 0.36;
  const ticks: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    ticks.push(new THREE.PlaneGeometry(0.12, i % 6 === 0 ? 0.9 : 0.4).rotateX(-Math.PI / 2).rotateY(-a).translate(Math.sin(a) * 6.4, 0.361, Math.cos(a) * 6.4));
  }
  const tickMesh = new THREE.Mesh(mergeGeometries(ticks), ringMat);
  padGroup.add(disc, ring, inner, tickMesh);
  padGroup.position.set(PAD.x, PAD_Y - 0.35, PAD.y);
  for (const m of [disc]) m.receiveShadow = true;
  g.add(padGroup);
  return g;
}
