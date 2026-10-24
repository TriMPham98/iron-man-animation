import * as THREE from 'three';
import { HOME, HOME_HEIGHT, coastZ, type Heightfield } from './heightfield';

/**
 * The house's frame and the bluff it stands on.
 *
 * The frame is squared to the coast: x runs along the cliff (east-ish), z
 * straight out to sea, y up from the terrace (HOME_HEIGHT). The heightfield
 * is 16 m a texel and smoothed, so on its own the bluff is a 55° slope; the
 * real thing at Point Dume is a sheer sandstone face. A rock mesh, built
 * against the heightfield, gives the house its cliff: a flat crest the house
 * sits on, then a banded face dropping until it meets the slope below.
 */

const SLOPE = 0.5 * (coastZ(HOME.x + 1) - coastZ(HOME.x - 1));
/** Seaward unit vector (world xz). */
export const FRAME_Z = new THREE.Vector2(-SLOPE, 1).normalize();
/** Along-the-cliff unit vector (world xz). */
export const FRAME_X = new THREE.Vector2(FRAME_Z.y, -FRAME_Z.x);
/** Group yaw that maps the frame's x/z onto FRAME_X/FRAME_Z. */
export const FRAME_YAW = -Math.atan2(FRAME_X.y, FRAME_X.x);

export function toLocal(x: number, z: number, out = new THREE.Vector2()): THREE.Vector2 {
  const dx = x - HOME.x;
  const dz = z - HOME.y;
  return out.set(dx * FRAME_X.x + dz * FRAME_X.y, dx * FRAME_Z.x + dz * FRAME_Z.y);
}

export function toWorld(u: number, v: number, out = new THREE.Vector2()): THREE.Vector2 {
  return out.set(HOME.x + u * FRAME_X.x + v * FRAME_Z.x, HOME.y + u * FRAME_X.y + v * FRAME_Z.y);
}

/** Extent of the rock face along the cliff, and where it blends into the slope. */
const U0 = -120;
const U1 = 200;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** 1 on the face, 0 where it has melted into the slope; the ends lean in toward the foot. */
const blend = (u: number, y = 0) => smooth(U0, U0 + 55, u + y * 0.9) * (1 - smooth(U1 - 55, U1, u - y * 0.9));

/** Smooth value noise, about −1…1. */
function vnoise(x: number, y: number): number {
  const hash = (i: number, j: number) => {
    let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(i, j);
  const b = hash(i + 1, j);
  const c = hash(i, j + 1);
  const d = hash(i + 1, j + 1);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}
function fbm(x: number, y: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 - 9.7;
    a *= 0.5;
  }
  return s;
}

/** Distance out to the cliff edge at x (frame); it dips in under the living room. */
export function crest(u: number): number {
  return 53 + 1.6 * Math.sin(u * 0.11 + 0.4) + 1.1 * Math.sin(u * 0.27 + 2) - 3.5 * Math.exp(-(((u - 60) / 16) ** 2));
}

/** Face steepness (m drop per m out). */
const steep = (u: number) => 4.6 + 1.4 * Math.sin(u * 0.05 + 0.7);

/** Ledges, buttresses and gullies: the face's outward offset at (x, height). */
function relief(u: number, y: number): number {
  // Bedding: lips where a harder bed stands proud, a few metres apart
  const bed = y / 4.7 + 0.6 * fbm(u * 0.03, 3.1, 2);
  const lip = 0.9 * smooth(0.55, 0.85, bed - Math.floor(bed)) + 0.5 * fbm(u * 0.05, y * 0.4, 2);
  // Buttresses and gullies: blocky, irregular, running down the face
  const mass = 3.2 * fbm(u * 0.045, y * 0.025 + 5.0, 4) + 1.4 * fbm(u * 0.16, y * 0.07, 3);
  return lip + mass * smooth(-1, -8, y);
}

/** How far out (frame z) the rock face stands at a height below the lip, ledges and buttresses included. */
export function faceOut(u: number, y: number): number {
  return crest(u) - Math.min(y, -0.6) / steep(u) + relief(u, y) * smooth(0, -3, y);
}

/**
 * Height (frame y) of the rock top / face at a frame point as the mesh lies,
 * or −∞ where it doesn't stand above the heightfield: toward the ends it
 * sinks into the slope.
 */
export function cliffHeight(field: Heightfield, u: number, v: number): number {
  if (u < U0 || u > U1 || v < 8) return -Infinity;
  const a = crest(u);
  const y = v <= a ? -0.35 * smooth(a - 4, a, v) : -(v - a) * steep(u);
  const w = toWorld(u, v, _w);
  const g = field.heightAt(w.x, w.y) - HOME_HEIGHT;
  const top = THREE.MathUtils.lerp(g - 0.6, y, blend(u, y));
  return top > g ? top : -Infinity;
}

const _l = new THREE.Vector2();
const _w = new THREE.Vector2();
/**
 * Whether the rock stands above `ground` (world m) at a world point or
 * within `reach` m of it: the heightfield under the bluff lies well below
 * the rock, so anything grown there would be buried, or poke out of the face.
 */
export function rockOver(field: Heightfield, x: number, z: number, ground: number, reach: number): boolean {
  const l = toLocal(x, z, _l);
  const u = l.x;
  const v = l.y;
  for (const du of [-reach, 0, reach])
    for (const dv of [-reach, 0, reach]) if (HOME_HEIGHT + cliffHeight(field, u + du, v + dv) > ground + 0.5) return true;
  return false;
}

const ROCK_TOP = 12;
const ROCK_FACE = 34;
const FACE_BOTTOM = -62;

/**
 * The rock: a top strip from the terrace out to the edge, then the face.
 * Columns every 1.5 m along the cliff; triangles that would only lie on the
 * heightfield are dropped.
 */
export function buildCliffGeometry(field: Heightfield): THREE.BufferGeometry {
  const ground = (u: number, v: number) => {
    const w = toWorld(u, v);
    return field.heightAt(w.x, w.y) - HOME_HEIGHT;
  };
  const cols: number[] = [];
  for (let u = U0; u <= U1 + 1e-6; u += 1.5) cols.push(u);
  const rows = ROCK_TOP + ROCK_FACE;
  const pos: number[] = [];
  const col: number[] = [];
  const need: boolean[] = [];
  const grass = new THREE.Color(0.5, 0.38, 0.19);
  const scrub = new THREE.Color(0.12, 0.125, 0.065);
  const lawn = new THREE.Color(0.14, 0.19, 0.06);
  const sand = new THREE.Color(0.54, 0.46, 0.36);
  const ochre = new THREE.Color(0.47, 0.35, 0.23);
  const grey = new THREE.Color(0.42, 0.4, 0.37);
  const dark = new THREE.Color(0.24, 0.2, 0.16);
  const slope = new THREE.Color(0.48, 0.4, 0.3);
  const c = new THREE.Color();
  for (const u of cols) {
    const a = crest(u);
    const k = steep(u);
    for (let r = 0; r < rows; r++) {
      let v: number;
      let y: number;
      if (r < ROCK_TOP) {
        // Top: from the terrace to the lip, rounding over the edge
        const t = r / (ROCK_TOP - 1);
        v = THREE.MathUtils.lerp(8, a - 0.6, Math.sqrt(t));
        y = -0.35 * smooth(a - 4, a, v);
      } else {
        const t = (r - ROCK_TOP + 1) / ROCK_FACE;
        y = THREE.MathUtils.lerp(-0.6, FACE_BOTTOM, t * t * 0.6 + t * 0.4);
        v = a + -y / k + relief(u, y) * smooth(0, -3, y);
      }
      const w = blend(u, y);
      const g = ground(u, v);
      // Ends blend into (just under) the slope
      y = THREE.MathUtils.lerp(g - 0.6, y, w);
      need.push(y > g + 0.08);
      pos.push(u, y, v);
      // Paint: dry grass and scrub on top (a lawn before the house), banded sandstone below
      if (r < ROCK_TOP) {
        const n = 0.5 + 0.5 * Math.sin(u * 0.37 + v * 0.21) * Math.sin(u * 0.13 - v * 0.4);
        c.copy(grass).lerp(scrub, n * 0.6);
        const lawnK = smooth(-12, 2, u) * (1 - smooth(118, 132, u)) * smooth(a - 3, a - 7, v);
        c.lerp(lawn, lawnK * 0.85);
      } else {
        const band = 0.5 + 0.5 * fbm(u * 0.01, y * 0.12, 3);
        c.copy(sand).lerp(ochre, band * 0.7);
        c.lerp(grey, (0.5 + 0.5 * fbm(u * 0.03 + 4, y * 0.03, 3)) * 0.5);
        // Dark runoff streaks down from the lip
        const streak = smooth(0.25, 0.6, fbm(u * 0.22, y * 0.015, 2));
        c.lerp(dark, streak * 0.4);
        // A fringe of scrub hanging over the lip
        c.lerp(scrub, smooth(-2.5, -0.6, y) * 0.8);
        // Darker, wetter rock near the waterline
        c.lerp(dark, smooth(-40, -54, y) * 0.6);
      }
      // Toward the ends, and where it meets the slope, take the slope's colour
      c.lerp(slope, 1 - w);
      col.push(c.r, c.g, c.b);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < cols.length - 1; i++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r;
      const b = (i + 1) * rows + r;
      const quad = [a, b, a + 1, b + 1];
      if (!quad.some((q) => need[q])) continue;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
