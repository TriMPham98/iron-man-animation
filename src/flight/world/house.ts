import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HOME, HOME_HEIGHT, type Heightfield } from './heightfield';
import { FRAME_YAW, buildCliffGeometry, cliffHeight, crest, faceOut, toLocal, toWorld } from './houseCliff';
import { Batch, Footprint, Outline, alongOutline, beam, box, fascia, flat, houseMaterials, slab, strut, wallQuad, type P2 } from './houseKit';
import { seeded, type GardenPlant } from './vegetation';

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
 * and a switchback stair runs down the face to the beach.
 * Behind: the round entry court with its sculpture, and the drive winding
 * up into the hills. The landing pad on the lawn beside the house is its
 * own piece (src/flight/world/landingPad.ts).
 *
 * Everything static is merged per material (a dozen draw calls);
 * furniture, mullions, rails and the small lights drop out beyond ~900 m.
 * The garden (palms, cypress, olives, oaks, hedges, agaves, dry grass) is
 * laid out here and handed to the vegetation, which draws it with the
 * coast's own models and shading (src/flight/world/housePlants.ts).
 */

/** Where the suit stands (world xz) and the pad's height. */
export const PAD = new THREE.Vector2(HOME.x, HOME.y + 14);
export const PAD_Y = HOME_HEIGHT + 0.35;
/** The pad deck's radius (m): the suit stands on it out to here. */
export const PAD_R = 7;

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
/** Cliff stair: its head off the pool deck's corner (x), the turns (x) and its width. */
const STAIR_HEAD = 9.8;
const STAIR_X0 = 5;
const STAIR_X1 = -13;
const STAIR_W = 1.5;
/** Entry court. */
const COURT = new THREE.Vector2(64, -26);
/** Hot tub on the pool deck, by the infinity edge. */
const SPA = new THREE.Vector2(36.4, 46.4);
/** Fire pit and lounge on the great room's roof. */
const FIRE = new THREE.Vector2(60, 50);
/** The drive's line (frame), from the court up into the hills. */
const DRIVE: P2[] = [[64, -38], [69, -60], [84, -92], [102, -130], [108, -175], [98, -225], [92, -280], [100, -330]];
/** Garden paths: round the west end, and from the pad to the helical stair. */
const PATHS: P2[][] = [
  [[12, 10], [26, -6], [44, -16], [52, -22]],
  [[0, 0], [14.5, 17]],
];
const PAD_L = toLocal(PAD.x, PAD.y);
PATHS[1][0] = [PAD_L.x + 7, PAD_L.y + 2];

/** 0–1: how far a point is into the irrigated lawn round the house (ragged at the edge). */
function lawnAt(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x - 52) - 62);
  const dz = Math.max(0, z < 20 ? 20 - z - 50 : 0);
  const n = Math.sin(x * 0.31) * Math.sin(z * 0.27) * 3 + Math.sin(x * 0.11 + z * 0.17) * 4;
  return 1 - THREE.MathUtils.smoothstep(Math.hypot(dx, dz) + n, -2, 8);
}

/** Plan distance from a point to a polyline. */
function toLine(x: number, z: number, line: P2[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, az] = line[i];
    const [bx, bz] = line[i + 1];
    const t = THREE.MathUtils.clamp(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2), 0, 1);
    best = Math.min(best, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)));
  }
  return best;
}

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
export function structureTop(field: Heightfield, x: number, z: number): number {
  if (Math.hypot(x - PAD.x, z - PAD.y) < PAD_R) return PAD_Y;
  const l = toLocal(x, z, _l);
  if (l.x < -100 || l.x > 180 || l.y < -40 || l.y > 140) return -Infinity;
  let top = -Infinity;
  for (const f of FOOTPRINTS) {
    if (f.top > top && f.test(l.x, l.y)) top = f.top;
  }
  const rock = cliffHeight(field, l.x, l.y);
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
  outFine: Batch;
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
const umbrella = (B: Batch, x: number, z: number, y: number) => {
  B.add(new THREE.CylinderGeometry(0.04, 0.05, 2.5, 6).translate(x, y + 1.25, z), 0x8a8c8e);
  B.add(new THREE.ConeGeometry(1.5, 0.45, 12, 1, true).translate(x, y + 2.5, z), 0xece6da);
  B.add(new THREE.CylinderGeometry(0.35, 0.35, 0.06, 12).translate(x, y + 0.03, z), 0x2a2a2c);
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

/** The house's meshes, and its garden for the vegetation to draw (world space). */
export function buildHouse(field?: Heightfield): { group: THREE.Group; garden: GardenPlant[] } {
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
    outFine: new Batch('house-out-fine'),
  };
  const garden: GardenPlant[] = [];
  /** A plant at a frame point (y up from the terrace). */
  const sow = (kind: string, x: number, y: number, z: number, scale: number, squash?: number) => {
    const w = toWorld(x, z);
    garden.push({ kind, x: w.x, y: y + HOME_HEIGHT, z: w.y, scale, squash });
  };
  /** Ground height in the frame (terrace = 0), the rock top included. */
  const ground = (x: number, z: number) => {
    const w = toWorld(x, z);
    const t = field ? field.heightAt(w.x, w.y) - HOME_HEIGHT : 0;
    return field ? Math.max(t, cliffHeight(field, x, z)) : t;
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
  // Shadow-gap reveals: a dark line between each plate and its edge beam,
  // and a steel drip edge under the deck's nose
  B.metal.add(fascia(S1.offset(0.03), Y1 - 0.4, 0.06, 0.1), 0x232426);
  B.metal.add(fascia(S2.offset(0.03), Y2 - 0.4, 0.06, 0.1), 0x232426);
  B.metal.add(fascia(P0.offset(0.02), Y0 - 0.9, 0.05, 0.08), 0x8a8c8e);

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
  // Sheers half drawn across some of the bedroom glass, and at the ends of the main floor
  for (const [o, y0, y1, k] of [
    [E1, Y1, Y2 - 0.45, 1.05],
    [E0, Y0, Y1 - 0.45, 1.5],
  ] as const) {
    const inner = o.offset(-0.22);
    for (let i = 0; i < inner.pts.length; i++) {
      const a = inner.pts[i];
      const b = inner.pts[(i + 1) % inner.pts.length];
      const n = inner.nrm[i];
      if (!seaward(a, n) || Math.sin(i * 0.61) + 0.6 * Math.sin(i * 1.93) < k) continue;
      B.lit.add(wallQuad(a, b, y0 + 0.05, y1 - 0.05, n), 0xf2e6d2, 0.42);
    }
  }
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

  // Planters along the upper terrace's seaward edge, hedged and grassed
  {
    const P = S1.offset(-1.5);
    for (let i = 0; i < P.pts.length; i++) {
      const a = P.pts[i];
      const b = P.pts[(i + 1) % P.pts.length];
      const n = P.nrm[i];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      if (n.y < 0.15 || i % 9 > 5 || S2.contains(mid.x, mid.y) || E1.offset(1).contains(mid.x, mid.y) || mid.distanceTo(FIRE) < 7) continue;
      B.concrete.add(beam(a, b, Y1 + 0.3, 0.6, 0.9, 0.02), WHITE);
      B.stone.add(beam(a, b, Y1 + 0.58, 0.06, 0.74, 0.03), 0x2e2418);
      sow(i % 2 ? 'hedge' : 'grass', mid.x, Y1 + 0.5, mid.y, i % 2 ? 0.65 : 1.1, 1.2);
    }
  }
  // The fire pit lounge on the great room's roof: a curved bench round a bowl of flame
  {
    for (let i = 0; i < 22; i++) {
      const a = -Math.PI * 0.18 + (i / 21) * Math.PI * 1.36;
      B.outFine.add(box(0.85, 0.42, 0.7, FIRE.x + Math.cos(a) * 3.6, Y1 + 0.21, FIRE.y + Math.sin(a) * 3.6, -a), 0xd8d0c2);
      B.outFine.add(box(0.85, 0.5, 0.18, FIRE.x + Math.cos(a) * 4.0, Y1 + 0.5, FIRE.y + Math.sin(a) * 4.0, -a), 0xd8d0c2);
    }
    B.concrete.add(new THREE.CylinderGeometry(1.0, 1.1, 0.45, 32).translate(FIRE.x, Y1 + 0.22, FIRE.y), 0x9a948a);
    B.litFine.add(new THREE.CylinderGeometry(0.75, 0.75, 0.05, 32).translate(FIRE.x, Y1 + 0.47, FIRE.y), new THREE.Color(1, 0.5, 0.15), 9);
    B.litFine.add(new THREE.ConeGeometry(0.55, 0.6, 9, 1, true).translate(FIRE.x, Y1 + 0.78, FIRE.y), new THREE.Color(1, 0.62, 0.22), 12);
    umbrella(B.outFine, FIRE.x - 8, FIRE.y + 4, Y1);
    umbrella(B.outFine, FIRE.x + 8.5, FIRE.y + 3, Y1);
    loungers(B.outFine, FIRE.x - 8, FIRE.y + 4, Math.PI / 2 + 0.3, Y1);
    loungers(B.outFine, FIRE.x + 8.5, FIRE.y + 3, Math.PI / 2 - 0.3, Y1);
  }

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
    // The gap for the cliff stair's head
    if (Math.abs(mid.x - STAIR_HEAD) < 1.1 && mid.y > 46) continue;
    const inA = a.clone().addScaledVector(PD.nrm[i], -0.15);
    const inB = b.clone().addScaledVector(PD.nrm[(i + 1) % PD.pts.length], -0.15);
    B.concrete.add(beam(inA, inB, PD_Y + 0.45, 0.9, 0.3, 0.12), WHITE);
  }
  // Pale stone coping round the pool
  B.stone.add(slab(POOL.offset(0.45), PD_Y + 0.04, 0.08, 0.02, [POOL]), 0xe6dfd0);
  // The hot tub: a raised white drum, its water lit from below
  {
    const rim = Outline.circle(SPA.x, SPA.y, 1.85, 40);
    const tub = Outline.circle(SPA.x, SPA.y, 1.5, 40);
    B.concrete.add(slab(rim, PD_Y + 0.45, 0.5, 0.05, [tub]), WHITE);
    B.stone.add(slab(Outline.circle(SPA.x, SPA.y, 1.95, 40), PD_Y + 0.5, 0.06, 0.02, [Outline.circle(SPA.x, SPA.y, 1.45, 40)]), 0xe6dfd0);
    B.water.add(flat(tub, PD_Y + 0.33, true), 0xffffff);
    B.litFine.add(new THREE.CircleGeometry(0.3, 12).rotateX(-Math.PI / 2).translate(SPA.x, PD_Y + 0.335, SPA.y), new THREE.Color(0.6, 0.95, 1), 6);
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

  // Switchback stair down the cliff face to the beach. Each flight stands
  // off the rock (ledges and the slope below it included) and leans out
  // with it; the next runs back alongside, a landing spanning the pair at
  // each turn, tied back into the rock or propped on the slope below.
  if (field) {
    const W = STAIR_W;
    const RAIL = 0x9a9c9e;
    const yBeach = -50.5;
    const flights = 8;
    const drop = (PD_Y - yBeach) / flights;
    const slope = (u: number, v: number) => {
      const w = toWorld(u, v);
      return field.heightAt(w.x, w.y) - HOME_HEIGHT;
    };
    /** Outermost rock or ground (frame z) at a height, a stride either side along the cliff included. */
    const wall = (u: number, y: number) => {
      let v = 0;
      for (const du of [-1.5, 0, 1.5]) {
        let w = y < -0.6 ? faceOut(u + du, y) : crest(u + du);
        while (w < 140 && slope(u + du, w) > y) w += 0.25;
        v = Math.max(v, w);
      }
      return v;
    };
    /** Least centre-line z at (x, y) that keeps a flight, its stringer and rails off the rock. */
    const clear = (x: number, y: number) => Math.max(wall(x, y - 1.4), wall(x, y), wall(x, y + 1.6)) + W / 2 + 0.8;
    const rail = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, posts: number) => {
      B.metalFine.add(strut(new THREE.Vector3(ax, ay + 1, az), new THREE.Vector3(bx, by + 1, bz), 0.05, 0.05, 0.05, 0.05), RAIL);
      for (let k = 0; k <= posts; k++) {
        const t = k / posts;
        B.metalFine.add(box(0.04, 1.0, 0.04, THREE.MathUtils.lerp(ax, bx, t), THREE.MathUtils.lerp(ay, by, t) + 0.5, THREE.MathUtils.lerp(az, bz, t)), RAIL);
      }
    };
    /** A column up from the slope below the face, where it comes near enough to stand on. */
    const prop = (x: number, y: number, z: number) => {
      const g = slope(x, z);
      if (cliffHeight(field, x, z) > g - 1 || faceOut(x, g) > z - 1.5) return;
      if (y - g > 0.4 && y - g < 10) B.concrete.add(box(0.4, y - g + 0.6, 0.4, x, (y + g - 0.6) / 2, z), 0xd8d4cc);
    };

    // Lay the flights out: each starts outboard of the last, then leans out as far as the rock below needs
    const runs: { xa: number; xb: number; ya: number; yb: number; za: number; zb: number }[] = [];
    let z = 0;
    for (let f = 0; f < flights; f++) {
      const xa = f === 0 ? STAIR_HEAD - 1.1 : f % 2 === 0 ? STAIR_X0 : STAIR_X1;
      const xb = f % 2 === 0 ? STAIR_X1 : STAIR_X0;
      const ya = PD_Y - f * drop;
      const yb = ya - drop;
      const at = (t: number) => clear(THREE.MathUtils.lerp(xa, xb, t), THREE.MathUtils.lerp(ya, yb, t));
      let za = f === 0 ? 0 : z + W + 0.3;
      for (let k = 0; k <= 2; k++) za = Math.max(za, at(k / 10));
      let zb = za;
      for (let k = 3; k <= 12; k++) zb = Math.max(zb, za + (at(k / 12) - za) / (k / 12));
      runs.push({ xa, xb, ya, yb, za, zb });
      z = zb;
    }

    // The head: a pier off the pool deck's corner, through a gap in the parapet
    {
      const { xa, za } = runs[0];
      let zIn = za;
      while (zIn > za - 12 && !PD.contains(STAIR_HEAD, zIn)) zIn -= 0.25;
      const z0 = zIn - 0.6;
      const z1 = za + W / 2;
      B.concrete.add(box(2.2, 0.35, z1 - z0, STAIR_HEAD, PD_Y - 0.175, (z0 + z1) / 2), 0xe8e4dc);
      rail(xa + 0.05, PD_Y, zIn, xa + 0.05, PD_Y, za - W / 2, 3);
      rail(xa + 2.15, PD_Y, zIn, xa + 2.15, PD_Y, za + W / 2 - 0.05, 4);
      rail(xa, PD_Y, za + W / 2 - 0.05, xa + 2.15, PD_Y, za + W / 2 - 0.05, 2);
    }

    runs.forEach(({ xa, xb, ya, yb, za, zb }, f) => {
      const dx = xb - xa;
      const dz = zb - za;
      const run = Math.hypot(dx, dz);
      const yaw = -Math.atan2(dz, dx);
      const n = Math.round(run / 0.62);
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        B.concrete.add(box(run / n + 0.02, 0.1, W, xa + dx * t, THREE.MathUtils.lerp(ya, yb, t), za + dz * t, yaw), 0xe8e4dc);
      }
      B.concrete.add(strut(new THREE.Vector3(xa, ya - 0.3, za), new THREE.Vector3(xb, yb - 0.3, zb), W, 0.35, W, 0.35), 0xe0dcd4);
      // Rails both sides
      for (const side of [-1, 1]) {
        const ox = (-dz / run) * (W / 2 - 0.05) * side;
        const oz = (dx / run) * (W / 2 - 0.05) * side;
        rail(xa + ox, ya, za + oz, xb + ox, yb, zb + oz, 6);
      }
      // Props where the slope comes up under the flight
      for (const t of [0.35, 0.7]) prop(xa + dx * t, THREE.MathUtils.lerp(ya, yb, t) - 0.45, za + dz * t);

      const sgn = Math.sign(dx);
      const next = runs[f + 1];
      if (next) {
        // Landing at the turn, spanning this flight and the next one out
        const z0 = zb - W / 2;
        const z1 = next.za + W / 2;
        const xe = xb + sgn * 1.8;
        B.concrete.add(box(2.1, 0.3, z1 - z0, xb + sgn * 0.75, yb - 0.15, (z0 + z1) / 2), 0xe0dcd4);
        rail(xe - sgn * 0.05, yb, z0, xe - sgn * 0.05, yb, z1, 3);
        rail(xb, yb, z0 + 0.05, xe, yb, z0 + 0.05, 2);
        rail(xb, yb, z1 - 0.05, xe, yb, z1 - 0.05, 2);
        // Tied back into the rock, or propped from the slope
        const rock = wall(xb + sgn * 0.75, yb - 0.7) - 0.6;
        if (z0 - rock > 0.2 && z0 - rock < 6) B.concrete.add(box(1.0, 0.8, z0 - rock, xb + sgn * 0.75, yb - 0.7, (z0 + rock) / 2), 0xd8d4cc);
        else prop(xb + sgn * 0.75, yb - 0.3, (z0 + z1) / 2);
      } else {
        // The foot: a plinth on the sand
        const cx = xb + sgn * 1.2;
        let g = yBeach;
        for (const [ox, oz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) g = Math.min(g, ground(cx + ox, zb + oz));
        B.concrete.add(box(3.2, yBeach - g + 0.8, 3.2, cx, (yBeach + g - 0.8) / 2, zb), 0xd0ccc4);
      }
    });
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
  // The front door: a lit glass portal in the street wall between two tall
  // fins, a walk across from the court between lit reflecting channels
  {
    let best = 0;
    E0.pts.forEach((p, i) => {
      if (p.distanceTo(COURT) < E0.pts[best].distanceTo(COURT)) best = i;
    });
    const p = E0.pts[best];
    const n = E0.nrm[best];
    const yaw = -Math.atan2(n.y, n.x);
    const t = new THREE.Vector2(-n.y, n.x);
    const at = (along: number, out: number) => p.clone().addScaledVector(t, along).addScaledVector(n, out);
    const door = at(0, 0.05);
    B.litFine.add(box(0.02, 3.1, 4.6, door.x, Y0 + 1.55, door.y, yaw), WARM_WALL, 1.1);
    const glass = at(0, 0.09);
    B.glass.add(box(0.02, 3.1, 4.6, glass.x, Y0 + 1.55, glass.y, yaw));
    for (const s of [-2.3, -0.75, 0.75, 2.3]) {
      const m = at(s, 0.1);
      B.metalFine.add(box(0.08, 3.1, 0.08, m.x, Y0 + 1.55, m.y, yaw), FRAME);
    }
    const head = at(0, 0.1);
    B.metalFine.add(box(0.1, 0.1, 4.7, head.x, Y0 + 3.12, head.y, yaw), FRAME);
    for (const s of [-3.2, 3.2]) {
      const f = at(s, 0.9);
      B.concrete.add(box(1.8, Y1 - 0.45 - Y0, 0.45, f.x, (Y0 + Y1 - 0.45) / 2, f.y, yaw), WHITE);
      const l = at(s * 0.86, 0.08);
      B.litFine.add(box(0.12, 0.08, 0.3, l.x, Y0 + 0.04, l.y, yaw), LAMP, 10);
    }
    // Walk and channels, from the deck's edge out to the court's paving
    const walkEnd = p.distanceTo(COURT) - 13.8;
    const runs: [number, number, number, number][] = [
      [-1.6, 1.6, 0x2e2c28, 0.09],
      [-3.4, -2.0, 0, 0],
      [2.0, 3.4, 0, 0],
    ];
    for (const [s0, s1, col, lift] of runs) {
      const q = (a: number, o: number) => {
        const v = at(a, o);
        return new THREE.Vector2(v.x, v.y);
      };
      const corners = [q(s0, 2.1), q(s1, 2.1), q(s1, walkEnd), q(s0, walkEnd)];
      const o = Outline.fromPoints(corners);
      if (col) {
        B.stone.add(flat(o, lift, true), 0xe8e2d6);
        for (let k = 0; k < 6; k++) {
          // Joints across the walk
          const j0 = q(s0, 2.1 + ((walkEnd - 2.1) * (k + 0.5)) / 6);
          const j1 = q(s1, 2.1 + ((walkEnd - 2.1) * (k + 0.5)) / 6);
          B.metal.add(beam(j0, j1, lift + 0.005, 0.01, 0.05), col);
        }
      } else {
        B.stone.add(slab(o.offset(0.22), 0.28, 0.3, 0.03, [o]), 0xe0d8c8);
        B.water.add(flat(o, 0.2, true), 0xffffff);
        for (let k = 0; k < 4; k++) {
          const l = q((s0 + s1) / 2, 2.6 + ((walkEnd - 3.1) * k) / 3);
          B.litFine.add(new THREE.PlaneGeometry(0.3, 0.3).rotateX(-Math.PI / 2).translate(l.x, 0.205, l.y), new THREE.Color(0.6, 0.95, 1), 5);
        }
      }
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
    const inside = lawnAt;
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
    // Shade as one smooth sward, not facets
    const ln = lg.getAttribute('normal');
    for (let i = 0; i < ln.count; i++) ln.setXYZ(i, ln.getX(i) * 0.3, 1, ln.getZ(i) * 0.3);
    ln.needsUpdate = true;
    B.lawn.add(lg);
  }

  // Drive up into the hills, and paths
  ribbon(B.stone, ground, DRIVE, 7, 0x34322e, 0.1, 0xd8d2c6);
  for (const path of PATHS) {
    ribbon(B.stone, ground, path, 2.4, 0xd8d0c0, 0.08);
    // Low path lights, every 8 m on alternate sides
    const curve = new THREE.CatmullRomCurve3(path.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
    const n = Math.max(1, Math.floor(curve.getLength() / 8));
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n);
      const t = curve.getTangentAt(i / n);
      const s = i % 2 ? 1.8 : -1.8;
      const x = p.x - t.z * s;
      const z = p.z + t.x * s;
      const y = ground(x, z);
      B.metal.add(box(0.12, 0.5, 0.12, x, y + 0.25, z), FRAME);
      B.litFine.add(box(0.14, 0.06, 0.14, x, y + 0.45, z), LAMP, 8);
    }
  }
  // Bollard lights along the drive
  {
    const curve = new THREE.CatmullRomCurve3(DRIVE.slice(0, 5).map(([x, z]) => new THREE.Vector3(x, 0, z)));
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
  keep(B.outFine.build(M.concrete), fine);
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

  // Planting (drawn by the vegetation: see housePlants.ts)
  {
    const onDeck = (x: number, z: number) => PD.contains(x, z);
    const lift = (x: number, z: number) => (onDeck(x, z) ? PD_Y : ground(x, z));
    const uplight = (x: number, z: number, y: number) => {
      B.litFine.add(box(0.3, 0.12, 0.3, x + 1.1, y + 0.06, z), LAMP, 9);
    };
    // Fan palms: round the lawn, the pool deck and the court, each washed by an uplight
    const palms: [number, number, number][] = [
      [9.6, 46.5, 1.3], [34.6, 51.2, 1.05], [-6, 6, 1.1], [116, 24, 1.35], [113, 38, 1.15], [119, 31, 0.95],
      [52, -16, 1.1], [77, -15, 1.2], [40, -11, 1.0], [98, -14, 1.15], [-14, -12, 1.3], [128, 8, 1.05],
      [84, 44, 1.1], [-10, 14, 0.95], [124, 18, 1.2], [46, -40, 1.1], [82, -40, 1.15],
    ];
    for (const [x, z, k] of palms) {
      // Never up through a roof
      if (S1.offset(1.5).contains(x, z)) continue;
      const y = lift(x, z) - 0.15;
      sow('palm', x, y, z, k);
      uplight(x, z, y + 0.15);
    }
    // Italian cypress: an allée up the first stretch of the drive, and screens at the ends of the house
    {
      const curve = new THREE.CatmullRomCurve3(DRIVE.slice(0, 4).map(([x, z]) => new THREE.Vector3(x, 0, z)));
      const n = 14;
      for (let i = 0; i < n; i++) {
        const u = 0.02 + (i / (n - 1)) * 0.5;
        const p = curve.getPointAt(u);
        const t = curve.getTangentAt(u);
        for (const s of [-1, 1]) {
          const x = p.x - t.z * s * 6.6;
          const z = p.z + t.x * s * 6.6;
          if (Math.hypot(x - COURT.x, z - COURT.y) < 15) continue;
          sow('cypress', x, ground(x, z) - 0.2, z, 0.85 + ((i * 7 + (s + 1) * 3) % 5) * 0.06, 0.95);
          // Agaves at their feet, between the trees
          const ax = p.x - t.z * s * 5.0 + t.x * 3;
          const az = p.z + t.x * s * 5.0 + t.z * 3;
          if (i % 2 === 0 && Math.hypot(ax - COURT.x, az - COURT.y) > 15) sow('agave', ax, ground(ax, az), az, 0.9 + (i % 3) * 0.2);
        }
      }
    }
    for (const [x, z, k] of [[-2, -4, 1], [1.5, -9, 0.9], [-5, -16, 1.1], [120, -8, 1], [124, -2, 0.85], [29, -14, 0.95], [25, -20, 1.05], [118, 32, 0.9], [-8, -22, 1.0], [127, -14, 1.05]] as const) {
      sow('cypress', x, ground(x, z) - 0.2, z, k);
    }
    // Olives in the court's paving, off the axes of the walk and the drive
    for (const a of [0.25, 0.75, 1.25, 1.75]) {
      const x = COURT.x + Math.cos(a * Math.PI) * 10.5;
      const z = COURT.y + Math.sin(a * Math.PI) * 10.5;
      sow('olive', x, 0.06, z, 1.0 + (a % 0.5) * 0.3);
      B.metal.add(slab(Outline.circle(x, z, 1.3, 24), 0.08, 0.03, 0, [Outline.circle(x, z, 1.15, 24)]), 0x1a1a1a);
      B.litFine.add(box(0.3, 0.1, 0.3, x + 1.0, 0.1, z), LAMP, 9);
    }
    // Coast live oaks shading the street side
    for (const [x, z, k] of [[20, -42, 1.2], [110, -35, 1.3], [138, -22, 1.1], [-22, -34, 1.25], [36, -62, 1.15], [96, -62, 1.2], [-30, -6, 1.05], [140, 2, 1.0]] as const) {
      sow('oak', x, ground(x, z) - 0.3, z, k);
    }
    // Foundation beds: clipped hedges along the house with agaves between, and the court's planter
    let bed = 0;
    alongOutline(E0.offset(5), 3.2, (p) => {
      if (p.y > crest(p.x) - 2.5 || PD.contains(p.x, p.y) || p.distanceTo(SPIRAL) < 4 || p.distanceTo(PAD_L) < 9 || p.distanceTo(COURT) < 17) return;
      const kind = bed++ % 4 === 3 ? 'agave' : 'hedge';
      sow(kind, p.x, ground(p.x, p.y) - 0.1, p.y, kind === 'hedge' ? 0.8 + ((p.x * 7.1) % 0.4) : 1.1);
    });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      sow(i % 3 ? 'hedge' : 'agave', COURT.x + Math.cos(a) * 2.7, 0.6, COURT.y + Math.sin(a) * 2.7, i % 3 ? 0.6 : 0.8);
    }
    // Dry grass and brush where the lawn gives out, kept off the paving and the edge
    const rnd = seeded(41, 17);
    const clear = (x: number, z: number) =>
      P0.offset(1.5).contains(x, z) ||
      PD.offset(1).contains(x, z) ||
      Math.hypot(x - COURT.x, z - COURT.y) < 15 ||
      Math.hypot(x - PAD_L.x, z - PAD_L.y) < 9 ||
      toLine(x, z, DRIVE) < 5.5 ||
      PATHS.some((l) => toLine(x, z, l) < 2) ||
      z > crest(x) - 1.5;
    for (let i = 0; i < 2600; i++) {
      const x = -60 + rnd() * 220;
      const z = -110 + rnd() * 170;
      const k = lawnAt(x, z);
      if (k > 0.35 || rnd() < k * 2.5 || clear(x, z)) continue;
      const y = ground(x, z);
      if (rnd() < 0.8) sow('grass', x, y - 0.05, z, 0.7 + rnd() * 0.7);
      else sow('bush', x, y - 0.2, z, 0.5 + rnd() * 0.9);
    }
  }

  g.add(houseGroup);

  return { group: g, garden };
}
