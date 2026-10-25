import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { Felling } from './felling';
import { HOME, coastZ, type Heightfield } from './heightfield';
import { rockOver } from './houseCliff';

/**
 * The Malibu cover: chaparral and grey coastal sage on the dry slopes,
 * spreading coast live oaks down the sheltered folds, fan palms along the
 * bluffs and beaches, a few pines high on the range, and close to the eye
 * a carpet of dry grass and brush clumps. Grown from the same cover map
 * the terrain shader paints, so the ground and what stands on it agree;
 * they're what gives low flying its sense of speed.
 *
 * Level of detail, per 128 m cell:
 *  - Close (< ~150 m): the full models (twigs, rounder clumps, more palm
 *    fans), one draw per species.
 *  - Near (to ~420 m): the same layouts built lighter. Both with crown
 *    light baked into the vertex colours, rounded canopy normals and wind
 *    sway in the vertex shader.
 *  - Far (to 2 km): one instanced draw of camera-facing impostors cut from
 *    an atlas the 3D models are rendered into at boot (colour + normals),
 *    so they light and shade like the models they stand in for. They
 *    dither in (per pixel) over the models through a band before the
 *    models step out, so nothing pops.
 *  - Dense brush (< ~230 m): small clumps that grow in from the edge.
 *  - Leaf cards (alpha-tested sprays of leaves) over every close crown and
 *    the brush by the eye; each leaf shrinks away before its hand-over.
 * The house's garden goes through the same tiers: its plants are dropped
 * into the cells they stand in, so every species, wild or planted, is
 * drawn, culled, cut down and handed over by the one path (see
 * {@link Species}).
 * Cells are culled against a widened view frustum and the instance lists
 * rebuilt only when the eye has moved or turned enough to need it (or the
 * unibeam has cut something down: see {@link Felling}).
 */

const CELL = 128;
/** Impostors reach this far (m). */
const RADIUS = 2000;
/** 3D models hand over to impostors across this band (m). */
const LOD_NEAR = 330;
const LOD_FAR = 420;
/**
 * The full models within this (m); the lighter builds beyond. A shrub's
 * leaf cards stop telling long before a tree's do, and with the crowns the
 * same blobs either side the hand-over costs nothing.
 */
export const TREE_HI = 150;
export const SHRUB_HI = 80;
/** Dense brush out to here (m). */
const TUFT_R = 230;
/** Brush within this (m) is the close build, in leaf cards. */
const TUFT_HI = SHRUB_HI;
/** Rebuild the lists after this much travel (m) or turn (cos of ~7°). */
const REBUILD_MOVE = 24;
const REBUILD_TURN = Math.cos(THREE.MathUtils.degToRad(7));
/** Extra cone round the view frustum for the cull (≈ 12°). */
const CULL_MARGIN = 0.21;
/** Main-thread time a rebuild may spend planting new far cells (ms). */
const PLANT_BUDGET_MS = 2.5;

const KINDS = ['bush', 'oak', 'pine', 'palm'] as const;
type Kind = (typeof KINDS)[number];
const CAP: Record<Kind | 'tuft' | 'tuftHi' | 'grass', number> = { bush: 16000, oak: 5000, pine: 2500, palm: 2000, tuft: 10000, tuftHi: 3000, grass: 16000 };
const CAP_HI: Record<Kind, number> = { bush: 4000, oak: 1500, pine: 800, palm: 800 };
const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k);
const IMP_CAP = 60000;
/** Floats per near instance: matrix (16) + tint (3). */
const NEAR_STRIDE = 19;
/** Floats per impostor: x y z sy | sx kind | r g b. */
const IMP_STRIDE = 9;

export function seeded(cx: number, cz: number, salt = 0): () => number {
  let s = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

// ── Models ───────────────────────────────────────────────────────────────

/**
 * Every model comes in two builds off one layout: `hi` for the trees right
 * by the eye (rounder clumps, twigs, more fronds), `lo` out to the
 * impostors. Same silhouette, so the swap between them barely shows.
 */
export type Detail = 'hi' | 'lo';

/** A stable 0–1 hash of a point (shared corners of a non-indexed mesh agree). */
function hash3(x: number, y: number, z: number, seed: number): number {
  const h = Math.sin(Math.round(x * 997) * 12.9898 + Math.round(y * 997) * 78.233 + Math.round(z * 997) * 37.719 + seed * 4.1) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Lumpy blob with normals pointing out from its own centre. `leafy` kicks
 * each corner in or out at random, so the outline reads as ragged leaves
 * rather than a polygon; the normals stay smooth, so the light doesn't.
 */
export function blob(r: number, sy: number, at: THREE.Vector3, seed: number, detail = 0, leafy = 0): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.getAttribute('position');
  const nrm = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.copy(v).normalize();
    const k =
      1 +
      0.2 * Math.sin(v.x * 5.1 / r + seed) * Math.sin(v.z * 4.3 / r + seed * 2) +
      0.12 * Math.sin(v.y * 7 / r + seed) +
      (detail > 0 ? 0.08 * Math.sin(v.x * 13 / r + v.z * 11 / r + seed * 3) : 0) +
      leafy * (hash3(v.x / r, v.y / r, v.z / r, seed) - 0.5);
    v.multiplyScalar(k);
    v.y *= sy;
    // Flat-ish underside: crowns sit on their branches, not on a point
    if (v.y < -r * sy * 0.45) v.y = -r * sy * 0.45 + (v.y + r * sy * 0.45) * 0.3;
    pos.setXYZ(i, v.x + at.x, v.y + at.y, v.z + at.z);
    // Rounded: the blob's own normal leaning up (sky-lit tops)
    n.y = n.y * 0.8 + 0.35;
    n.normalize();
    nrm.set([n.x, n.y, n.z], i * 3);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/**
 * A leaf clump. Far off it's just the lumpy blob; close up (`hi`) a
 * smaller core shingled with small leaf triangles standing off its
 * surface at all angles, so the outline breaks up into foliage and light
 * gets in among the leaves. Leaves carry the blob's outward normal, so the
 * clump still shades as one soft mass.
 */
export function clump(r: number, sy: number, at: THREE.Vector3, seed: number, hi: boolean, leafy: number, leaf = 0.42): THREE.BufferGeometry {
  if (!hi) return blob(r, sy, at, seed, 0, leafy);
  if (cardSink) {
    // The lighter build's own blob (so the hand-over shows nothing), laced with cards
    const shell = blob(r, sy, at, seed, 0, leafy);
    shell.userData.cards = leafCards(shell, r, at, seed, leaf);
    return shell;
  }
  const core = blob(r * 0.86, sy, at, seed, 0, leafy * 0.6);
  const cp = core.getAttribute('position');
  const rnd = seeded(seed, 977);
  const n = Math.round(68 * r * r);
  const pos = new Float32Array(n * 9);
  const nrm = new Float32Array(n * 9);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const p = new THREE.Vector3();
  const out = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const tris = cp.count / 3;
  for (let k = 0; k < n; k++) {
    const f = Math.floor(rnd() * tris) * 3;
    a.fromBufferAttribute(cp, f);
    b.fromBufferAttribute(cp, f + 1);
    c.fromBufferAttribute(cp, f + 2);
    let u = rnd();
    let v = rnd();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    p.copy(a).addScaledVector(b.sub(a), u).addScaledVector(c.sub(a), v);
    out.copy(p).sub(at).normalize();
    p.addScaledVector(out, r * (0.02 + rnd() * 0.16));
    // A leaf tilted anywhere up to ~70° off the surface, facing out
    t1.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(out).normalize();
    t2.crossVectors(out, t1);
    const tilt = (rnd() - 0.5) * 2.4;
    const s = leaf * (0.7 + rnd() * 0.6);
    const ln = t2.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(out, Math.sin(tilt));
    const corners = [p.clone().addScaledVector(ln, s), p.clone().addScaledVector(t1, s * 0.6).addScaledVector(ln, -s * 0.4), p.clone().addScaledVector(t1, -s * 0.6).addScaledVector(ln, -s * 0.4)];
    // Wind it to face out of the clump
    const fn = corners[1].clone().sub(corners[0]).cross(corners[2].clone().sub(corners[0]));
    if (fn.dot(out) < 0) corners.reverse();
    const nn = out.clone();
    nn.y = nn.y * 0.8 + 0.35;
    nn.normalize();
    corners.forEach((q, j) => {
      pos.set([q.x, q.y, q.z], k * 9 + j * 3);
      nrm.set([nn.x, nn.y, nn.z], k * 9 + j * 3);
    });
  }
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  leaves.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return mergeGeometries([bare(core), leaves]);
}

/**
 * While a model's built through {@link withCards}: its clumps keep their
 * leaves out of the mesh and the crowns leave their (lit) cards here.
 */
let cardSink: THREE.BufferGeometry[] | null = null;

/** Vertices per leaf card (two triangles, in a fixed corner order). */
const CARD_CORNERS = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];

/**
 * Leaf cards over a clump's surface: on it to a little proud of it (they
 * lace its outline into leaves and cover its face), facing out at up to
 * ~30° and turned at random. Normals are the clump's, so the cards
 * light as one soft mass with it, never as flat sheets.
 */
function leafCards(shell: THREE.BufferGeometry, r: number, at: THREE.Vector3, seed: number, leaf: number): THREE.BufferGeometry {
  const sp = shell.getAttribute('position');
  const tris = sp.count / 3;
  const rnd = seeded(seed, 433);
  // (never so small the cards outnumber what they cover: small-leaved
  // plants just show the atlas's leaves smaller)
  const half = Math.max(0.3, leaf * 1.1);
  const n = Math.round((10 * r * r) / (half * half));
  const pos = new Float32Array(n * 18);
  const nrm = new Float32Array(n * 18);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const p = new THREE.Vector3();
  const out = new THREE.Vector3();
  const face = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const nn = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const f = Math.floor(rnd() * tris) * 3;
    a.fromBufferAttribute(sp, f);
    b.fromBufferAttribute(sp, f + 1);
    c.fromBufferAttribute(sp, f + 2);
    let u = rnd();
    let v = rnd();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    p.copy(a).addScaledVector(b.sub(a), u).addScaledVector(c.sub(a), v);
    out.copy(p).sub(at).normalize();
    p.addScaledVector(out, r * rnd() * 0.16);
    face.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).add(out).normalize();
    t1.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(face).normalize();
    t2.crossVectors(face, t1);
    const s = half * (0.75 + rnd() * 0.5);
    nn.copy(out);
    nn.y = nn.y * 0.8 + 0.35;
    nn.normalize();
    for (let j = 0; j < 6; j++) {
      const cu = CARD_CORNERS[j * 2] * 2 - 1;
      const cv = CARD_CORNERS[j * 2 + 1] * 2 - 1;
      pos.set([p.x + (t1.x * cu + t2.x * cv) * s, p.y + (t1.y * cu + t2.y * cv) * s, p.z + (t1.z * cu + t2.z * cv) * s], k * 18 + j * 3);
      nrm.set([nn.x, nn.y, nn.z], k * 18 + j * 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/**
 * A model's close build with leaf cards instead of leaf triangles: the
 * mesh, its crowns the lighter build's blobs, and the cards to draw over
 * it, each uv'd into one of the four sprays of the leaf atlas. No cards
 * (null) for a model with no clumps.
 */
export function withCards(build: () => THREE.BufferGeometry): { model: THREE.BufferGeometry; cards: THREE.BufferGeometry | null } {
  const sink: THREE.BufferGeometry[] = [];
  cardSink = sink;
  let model: THREE.BufferGeometry;
  try {
    model = build();
  } finally {
    cardSink = null;
  }
  if (!sink.length) return { model, cards: null };
  const cards = mergeGeometries(sink);
  const count = cards.getAttribute('position').count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const q = Math.floor(hash3(Math.floor(i / 6), 0.5, 0, 3) * 4);
    const j = i % 6;
    uv[i * 2] = (CARD_CORNERS[j * 2] + (q & 1)) / 2;
    uv[i * 2 + 1] = (CARD_CORNERS[j * 2 + 1] + (q >> 1)) / 2;
  }
  cards.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return { model, cards };
}

/** Non-indexed, position + normal only: anything can then merge with anything. */
export function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal') out.deleteAttribute(k);
  return out;
}

export function paint(g: THREE.BufferGeometry, top: THREE.Color, bottom: THREE.Color, y0: number, y1: number): THREE.BufferGeometry {
  g = bare(g);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const k = THREE.MathUtils.clamp((pos.getY(i) - y0) / (y1 - y0), 0, 1);
    c.copy(bottom).lerp(top, k);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const _fl = new THREE.Vector3();
const _fn = new THREE.Vector3();
const _fe = new THREE.Vector3();
const _fc = new THREE.Color();
const _fw = new THREE.Color();
const WARM = new THREE.Color(1.3, 1.15, 0.62);

/**
 * Merges a crown's clumps and bakes its light into the vertex colours:
 * darker deep inside and underneath (the self-shadowing the models can't
 * cast), a clump-to-clump breakup in tone and a warmer, yellower cast on
 * the outer twigs; normals pulled toward the crown's envelope so it
 * shades as one mass, not a pile of balls. Free at draw time, and the
 * impostors inherit it from the bake. The clumps' leaf cards (if they
 * have them) are lit the same way and handed to {@link withCards}.
 */
export function foliage(parts: THREE.BufferGeometry[], c: THREE.Vector3, rad: THREE.Vector3, top: THREE.Color, bottom: THREE.Color, seed: number): THREE.BufferGeometry {
  const cards = parts.flatMap((p) => (p.userData.cards as THREE.BufferGeometry | undefined) ?? []);
  if (cards.length && cardSink) cardSink.push(crownLight(paint(mergeGeometries(cards), top, bottom, c.y - rad.y, c.y + rad.y), c, rad, seed));
  return crownLight(paint(mergeGeometries(parts.map(bare)), top, bottom, c.y - rad.y, c.y + rad.y), c, rad, seed);
}

function crownLight(g: THREE.BufferGeometry, c: THREE.Vector3, rad: THREE.Vector3, seed: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col = g.getAttribute('color');
  const S = THREE.MathUtils.smoothstep;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    _fl.set(x, y, z).sub(c).divide(rad);
    const d = _fl.length();
    // The envelope's own normal, with the same lean to the sky
    _fe.copy(_fl).divide(rad).normalize();
    _fe.y = _fe.y * 0.8 + 0.35;
    _fn.fromBufferAttribute(nrm, i).lerp(_fe.normalize(), 0.45).normalize();
    nrm.setXYZ(i, _fn.x, _fn.y, _fn.z);
    const ao = (0.38 + 0.62 * S(d, 0.3, 1.0)) * (0.7 + 0.3 * THREE.MathUtils.clamp(_fl.y * 0.6 + 0.55, 0, 1));
    const blot = Math.sin(x * 1.3 + seed) * Math.sin(z * 1.1 - seed * 0.7) * Math.sin(y * 1.7 + seed * 1.3);
    _fc.fromBufferAttribute(col, i).multiplyScalar(ao * (1 + 0.3 * blot) * (0.86 + 0.28 * hash3(x, y, z, seed)));
    _fw.copy(_fc).multiply(WARM);
    _fc.lerp(_fw, S(blot, 0.1, 0.8) * S(d, 0.75, 1.05) * 0.7);
    col.setXYZ(i, _fc.r, _fc.g, _fc.b);
  }
  return g;
}

/** A tapered limb from a to b (open tube). */
export function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, sides = 5): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true).translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q).translate(a.x, a.y, a.z);
  return g;
}

export const BARK = [new THREE.Color(0.075, 0.062, 0.05), new THREE.Color(0.045, 0.037, 0.03)] as const;
export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Chaparral clump: dense lobes (also sage, and the brush near the eye, by tint). */
function bushGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  // (the lighter build stays smooth: it's also the brush right by the eye)
  const lf = hi ? 0.2 : 0;
  return foliage(
    [
      clump(0.9, 0.66, V(0, 0.5, 0), 1, hi, lf, 0.24),
      clump(0.66, 0.72, V(0.62, 0.38, 0.2), 2, hi, lf, 0.24),
      clump(0.58, 0.7, V(-0.5, 0.32, -0.45), 3, hi, lf, 0.24),
      clump(0.5, 0.8, V(-0.2, 0.75, 0.45), 4, hi, lf, 0.24),
      clump(0.45, 0.7, V(0.3, 0.3, -0.7), 5, hi, lf, 0.24),
    ],
    V(0, 0.45, 0),
    V(1.3, 0.75, 1.3),
    new THREE.Color(0.085, 0.105, 0.045),
    new THREE.Color(0.03, 0.04, 0.017),
    2,
  );
}

/** Dry grass clump: a fan of thin bent blades (two-sided). */
export function grassGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const rnd = seeded(3, 9);
  const base = new THREE.Color(0.3, 0.22, 0.1);
  const tip = new THREE.Color(0.62, 0.5, 0.28);
  for (let b = 0; b < 9; b++) {
    const a = rnd() * Math.PI * 2;
    const lean = 0.15 + rnd() * 0.35;
    const h = 0.45 + rnd() * 0.45;
    const r = rnd() * 0.12;
    const ox = Math.cos(a) * r;
    const oz = Math.sin(a) * r;
    const sx = -Math.sin(a) * 0.035;
    const sz = Math.cos(a) * 0.035;
    const mid = [ox + Math.cos(a) * lean * h * 0.4, h * 0.55, oz + Math.sin(a) * lean * h * 0.4];
    const top = [ox + Math.cos(a) * lean * h, h, oz + Math.sin(a) * lean * h];
    const quad = [
      [ox - sx, 0, oz - sz],
      [ox + sx, 0, oz + sz],
      [mid[0] + sx * 0.7, mid[1], mid[2] + sz * 0.7],
      [mid[0] - sx * 0.7, mid[1], mid[2] - sz * 0.7],
    ];
    const tris = [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3], quad[3], quad[2], top];
    for (const flip of [false, true]) {
      for (let t = 0; t < tris.length; t += 3) {
        const tri = flip ? [tris[t], tris[t + 2], tris[t + 1]] : tris.slice(t, t + 3);
        for (const v of tri) {
          pos.push(v[0], v[1], v[2]);
          // Blades light like the ground they stand on (sky-lit, soft)
          nrm.push(Math.cos(a) * 0.3, 0.95, Math.sin(a) * 0.3);
          const c = base.clone().lerp(tip, v[1] / h);
          col.push(c.r, c.g, c.b);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * Coast live oak: a short trunk forking low into five spreading limbs,
 * each spraying twigs out to a leaf clump, under a broad, flat-topped dome
 * filled in over the fork.
 */
function oakGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  const rnd = seeded(11, 5);
  const fork = V(0.1, 1.7, 0);
  const wood = [limb(V(0, 0, 0), fork, 0.38, 0.3, hi ? 8 : 5)];
  const clumps: THREE.BufferGeometry[] = [];
  const lf = 0.3;
  const N = 6;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2 + rnd() * 0.5;
    const reach = 1.4 + rnd() * 0.9;
    const end = V(Math.cos(ang) * reach, 3.0 + rnd() * 0.8, Math.sin(ang) * reach);
    wood.push(limb(fork, end, 0.2, 0.11, hi ? 6 : 4));
    const nt = 2 + (rnd() < 0.5 ? 1 : 0);
    for (let t = 0; t < nt; t++) {
      const a2 = ang + (t - (nt - 1) / 2) * 0.6 + (rnd() - 0.5) * 0.3;
      const out = 0.5 + rnd() * 0.9;
      // The farthest-flung twigs sag lowest: the dome's skirt
      const tip = V(Math.cos(a2) * (reach + out), end.y + 1.1 - out * 0.6 + rnd() * 0.5, Math.sin(a2) * (reach + out));
      // Twigs only show close up, under the crown's edge
      if (hi) wood.push(limb(end, tip, 0.1, 0.035, 4));
      clumps.push(clump(1.0 + rnd() * 0.45, 0.8, tip, i * 3 + t, hi, lf));
    }
  }
  // The dome over the fork
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + 0.3;
    clumps.push(clump(1.3 + rnd() * 0.3, 0.82, V(Math.cos(ang) * 1.8, 5.1 + rnd() * 0.6, Math.sin(ang) * 1.8), 20 + i, hi, lf));
  }
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2 + 1.1;
    clumps.push(clump(1.35, 0.85, V(Math.cos(ang) * 0.7, 6.1 + rnd() * 0.4, Math.sin(ang) * 0.7), 30 + i, hi, lf));
  }
  const crown = foliage(clumps, V(0, 4.6, 0), V(4.3, 2.4, 4.3), new THREE.Color(0.105, 0.135, 0.052), new THREE.Color(0.03, 0.042, 0.018), 3);
  return mergeGeometries([...wood.map((g) => paint(g, BARK[0], BARK[1], 0, 3)), crown]);
}

/** Turns a surface inside out (the underside of a pine's tier). */
function flipped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g = bare(g);
  for (const name of ['position', 'normal']) {
    const a = g.getAttribute(name);
    for (let t = 0; t < a.count; t += 3) {
      const x = a.getX(t + 1);
      const y = a.getY(t + 1);
      const z = a.getZ(t + 1);
      a.setXYZ(t + 1, a.getX(t + 2), a.getY(t + 2), a.getZ(t + 2));
      a.setXYZ(t + 2, x, y, z);
    }
  }
  const n = g.getAttribute('normal');
  for (let k = 0; k < n.count; k++) n.setXYZ(k, -n.getX(k) * 0.6, -n.getY(k) * 0.4 + 0.25, -n.getZ(k) * 0.6);
  return g;
}

/**
 * A whorl of needled branches: a star-rimmed cone whose points droop (so
 * the tiers read ragged, not like party hats), twisted against the one
 * below, and closed underneath so it doesn't go hollow seen from below.
 */
function tier(r: number, h: number, y: number, seed: number, hi: boolean): THREE.BufferGeometry {
  const segs = hi ? 14 : 10;
  const c = new THREE.ConeGeometry(r, h, segs, hi ? 2 : 1, true).translate(0, y, 0);
  const pos = c.getAttribute('position');
  const v = new THREE.Vector3();
  const rim = y - h / 2;
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k);
    const t = (y + h / 2 - v.y) / h; // 0 apex .. 1 rim
    if (t < 0.05) continue;
    const a = Math.atan2(v.z, v.x);
    const star = Math.round(((a + Math.PI) / (2 * Math.PI)) * segs) % 2;
    const s = 1 - t * t * (0.28 * (1 - star) - 0.08 * Math.sin(a * 3 + seed));
    // Branch tips sag under their own weight
    const sag = t * t * (0.25 + 0.2 * star) * h * 0.5;
    pos.setXYZ(k, v.x * s, v.y - sag, v.z * s);
  }
  c.computeVertexNormals();
  const n = c.getAttribute('normal');
  for (let k = 0; k < n.count; k++) {
    v.set(n.getX(k), n.getY(k) + 0.5, n.getZ(k)).normalize();
    n.setXYZ(k, v.x, v.y, v.z);
  }
  const under = flipped(new THREE.ConeGeometry(r * 0.85, h * 0.3, hi ? 10 : 7, 1, true).translate(0, rim - h * 0.05 + h * 0.15, 0));
  return mergeGeometries([bare(c), under]).rotateY(seed * 1.7);
}

/** A pine high on the range: eight ragged whorls up a tapering trunk. */
function pineGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  const rnd = seeded(7, 3);
  const trunk = paint(limb(V(0, 0, 0), V(0, 9.5, 0), 0.26, 0.05, hi ? 7 : 5), BARK[0], BARK[1], 0, 2);
  const tiers: THREE.BufferGeometry[] = [];
  const T = 8;
  for (let i = 0; i < T; i++) {
    const t = i / (T - 1);
    tiers.push(tier(2.6 * (1 - 0.78 * t) * (0.9 + rnd() * 0.2), 2.3 - 0.9 * t, 2.6 + i * 0.95, i + 1, hi));
  }
  tiers.push(bare(new THREE.ConeGeometry(0.3, 1.5, 6, 1, true).translate(0, 10.1, 0)));
  const crown = foliage(tiers, V(0, 6.0, 0), V(2.7, 4.6, 2.7), new THREE.Color(0.07, 0.11, 0.065), new THREE.Color(0.022, 0.038, 0.022), 5);
  return mergeGeometries([trunk, crown]);
}

/**
 * Mexican fan palm: a tall, slender, slightly bent trunk flaring at the
 * foot, a brown skirt of dead fronds, and a crown of palmate fans on long
 * stalks, each fan's leaflets splaying and drooping at the tips. The fans
 * are single sheets (the palms' material is two-sided).
 */
function palmGeometry(d: Detail): THREE.BufferGeometry {
  const hi = d === 'hi';
  const H = 13;
  const SEG = hi ? 10 : 6;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    pts.push(V(0.9 * t * t, H * t, 0.25 * t * t));
  }
  const rad = (t: number) => 0.2 - 0.05 * t + 0.16 * (1 - t) ** 8;
  const trunk = mergeGeometries(pts.slice(1).map((p, i) => bare(limb(pts[i], p, rad(i / SEG), rad((i + 1) / SEG), hi ? 7 : 5))));
  const trunkP = paint(trunk, new THREE.Color(0.13, 0.11, 0.09), new THREE.Color(0.075, 0.065, 0.055), 0, H);
  const top = pts[pts.length - 1];
  // Old fronds: a dead brown skirt under the crown. Close up, a thatch of
  // hanging dead leaves round a darker core; further off just the lump
  const skirtTop = new THREE.Color(0.12, 0.09, 0.055);
  const skirtFoot = new THREE.Color(0.045, 0.035, 0.025);
  let skirt = paint(blob(hi ? 0.5 : 0.72, hi ? 1.9 : 1.5, top.clone().add(V(0, -1.0, 0)), 9, hi ? 1 : 0, 0.5), skirtTop, skirtFoot, H - 2.2, H);
  if (hi) {
    const rs = seeded(9, 21);
    const thatch: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * Math.PI * 2 + rs() * 0.25;
      const out = V(Math.cos(a), 0, Math.sin(a));
      const side = V(-out.z, 0, out.x);
      const y0 = top.y - 0.1 - rs() * 0.4;
      const len = 1.6 + rs() * 0.9;
      // Hangs from the crown, bellying out, then in toward the trunk at the hem
      const p0 = top.clone().setY(y0).addScaledVector(out, 0.35);
      const p1 = top.clone().setY(y0 - len * 0.5).addScaledVector(out, 0.78 + rs() * 0.15);
      const p2 = top.clone().setY(y0 - len).addScaledVector(out, 0.5 + rs() * 0.2);
      const w = 0.24 + rs() * 0.12;
      const tris: number[] = [];
      for (const [a0, a1, w0, w1] of [
        [p0, p1, w, w * 1.1],
        [p1, p2, w * 1.1, w * 0.5],
      ] as const) {
        const q = [a0.clone().addScaledVector(side, -w0), a0.clone().addScaledVector(side, w0), a1.clone().addScaledVector(side, w1), a1.clone().addScaledVector(side, -w1)];
        for (const i of [0, 2, 1, 0, 3, 2]) tris.push(q[i].x, q[i].y, q[i].z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
      const n = new Float32Array(tris.length);
      for (let i = 0; i < n.length; i += 3) n.set([out.x, 0.35, out.z], i);
      g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      thatch.push(g);
    }
    skirt = mergeGeometries([skirt, paint(mergeGeometries(thatch), skirtTop.clone().multiplyScalar(1.15), skirtFoot, H - 2.8, H)]);
  }

  const rnd = seeded(5, 13);
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const green = new THREE.Color(0.1, 0.14, 0.05);
  const deep = new THREE.Color(0.04, 0.055, 0.022);
  const dead = new THREE.Color(0.13, 0.11, 0.05);
  const c = new THREE.Color();
  const tri = (a: THREE.Vector3, b: THREE.Vector3, e: THREE.Vector3, n: THREE.Vector3, ca: THREE.Color, cb: THREE.Color, ce: THREE.Color) => {
    for (const [p, k] of [
      [a, ca],
      [b, cb],
      [e, ce],
    ] as const) {
      pos.push(p.x, p.y, p.z);
      nrm.push(n.x, n.y, n.z);
      col.push(k.r, k.g, k.b);
    }
  };
  const UPV = V(0, 1, 0);
  const N = hi ? 16 : 10;
  const L = hi ? 9 : 5;
  const LS = hi ? 3 : 2;
  for (let f = 0; f < N; f++) {
    const a = (f / N) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
    // Young fans stand up; the oldest hang, browning, toward the skirt
    const lift = f % 3 === 0 ? 0.9 : f % 3 === 1 ? 0.35 : -0.25 - rnd() * 0.3;
    const age = THREE.MathUtils.clamp(-lift * 1.6, 0, 1);
    const dir = V(Math.cos(a), 0, Math.sin(a));
    const side = V(-dir.z, 0, dir.x);
    const fwd = dir.clone().multiplyScalar(Math.cos(lift)).addScaledVector(UPV, Math.sin(lift));
    const base = top.clone().add(V(0, 0.2, 0));
    const hub = base.clone().addScaledVector(fwd, 1.4);
    // Stalk: a thin ribbon out to the fan
    const sw = side.clone().multiplyScalar(0.05);
    const cs = c.copy(deep).lerp(dead, age).clone();
    const nUp = side.clone().cross(fwd).normalize();
    if (nUp.y < 0) nUp.negate();
    tri(base.clone().sub(sw), hub.clone().sub(sw), hub.clone().add(sw), nUp, cs, cs, cs);
    tri(base.clone().sub(sw), hub.clone().add(sw), base.clone().add(sw), nUp, cs, cs, cs);
    const tipC = c.copy(green).lerp(dead, age).multiplyScalar(0.9 + rnd() * 0.25).clone();
    const rootC = c.copy(deep).lerp(dead, age * 0.7).clone();
    for (let l = 0; l < L; l++) {
      const th = (l / (L - 1) - 0.5) * 2.5;
      const ld = fwd.clone().multiplyScalar(Math.cos(th)).addScaledVector(side, Math.sin(th));
      const pw = fwd.clone().multiplyScalar(-Math.sin(th)).addScaledVector(side, Math.cos(th));
      const len = 1.9 * (1 - 0.22 * Math.abs(th)) * (0.9 + rnd() * 0.2);
      const droop = len * (0.45 + 0.35 * Math.abs(th) + 0.3 * age);
      const at = (t: number, w: number) => hub.clone().addScaledVector(ld, len * t).addScaledVector(UPV, -droop * t * t).addScaledVector(pw, w);
      const width = (t: number) => (0.2 * (1 - t) + 0.02) * (hi ? 1 : 1.3);
      const n = nUp.clone().addScaledVector(ld, 0.3).normalize();
      for (let s = 0; s < LS; s++) {
        const t0 = s / LS;
        const t1 = (s + 1) / LS;
        const c0 = c.copy(rootC).lerp(tipC, Math.sqrt(t0)).clone();
        const c1 = c.copy(rootC).lerp(tipC, Math.sqrt(t1)).clone();
        const a0 = at(t0, -width(t0));
        const b0 = at(t0, width(t0));
        const a1 = at(t1, -width(t1));
        const b1 = at(t1, width(t1));
        tri(a0, a1, b0, n, c0, c1, c0);
        tri(b0, a1, b1, n, c0, c1, c1);
      }
    }
  }
  const crown = new THREE.BufferGeometry();
  crown.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  crown.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  crown.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return mergeGeometries([trunkP, skirt, crown]);
}

/**
 * A species, however it's planted (the coast's cover or the house's
 * garden): its two builds and where the close one takes over. Every
 * species is drawn through the same tiers — the close build with leaf
 * cards, the lighter build, then an impostor out to {@link RADIUS} — so
 * whatever changes how trees are drawn reaches all of them.
 */
export interface Species {
  build: (d: Detail) => THREE.BufferGeometry;
  /** Single-sheet leaves (drawn both sides). */
  twoSided?: boolean;
  /** The close build within this (m): {@link TREE_HI} or {@link SHRUB_HI}. */
  hiRange: number;
}

/** The coast's own species (the garden plants these too). */
export const SPECIES: Record<Kind, Species> = {
  bush: { build: bushGeometry, hiRange: SHRUB_HI },
  oak: { build: oakGeometry, hiRange: TREE_HI },
  pine: { build: pineGeometry, hiRange: TREE_HI },
  // Palm fans are single sheets
  palm: { build: palmGeometry, twoSided: true, hiRange: TREE_HI },
};

// ── Shaders ──────────────────────────────────────────────────────────────

const DITHER_GLSL = /* glsl */ `
// Interleaved gradient noise: a per-pixel threshold for the impostors'
// fade-in, stable on screen (no shimmer as the eye moves)
float lodDither() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
`;

const NEAR_VERT_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uEye;
uniform vec4 uFade; // (unused, unused), shrink band (inner, outer)
varying vec3 vInstWorld;
`;
const NEAR_VERT_BEGIN = /* glsl */ `
  vec3 transformed = vec3(position);
  vec3 origin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vInstWorld = origin;
  // Wind: gusts roll across the hills; crowns sway, bases stay planted
  float gust = 0.6 + 0.4 * sin(uTime * 0.37 + origin.x * 0.004 - origin.z * 0.003);
  float ph = uTime * 1.3 + origin.x * 0.05 + origin.z * 0.07;
  float bend = max(position.y - 0.5, 0.0);
  float sway = (sin(ph) * 0.04 + sin(ph * 2.7 + position.x) * 0.012) * bend * gust;
  transformed.x += sway;
  transformed.z += sway * 0.6;
  transformed *= smoothstep(uFade.w, uFade.z, distance(origin, uEye));
`;
const NEAR_FRAG_PARS = /* glsl */ `
uniform sampler2D uBake;
uniform float uWorld;
varying vec3 vInstWorld;
${ATMOSPHERE_GLSL}
`;
const SHADE_GLSL = /* glsl */ `
  vec4 vegBake = texture2D(uBake, vInstWorld.xz / uWorld + 0.5);
  reflectedLight.directDiffuse *= vegBake.r;
  reflectedLight.directSpecular *= vegBake.r;
  reflectedLight.indirectDiffuse *= mix(0.6, 1.0, vegBake.g);
  // Backlit leaves: the low sun glowing through crowns seen against it
  vec3 vegV = normalize(vInstWorld + vec3(0.0, 4.0, 0.0) - cameraPosition);
  float vegBack = pow(max(dot(vegV, uSunDir), 0.0), 4.0);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * uSunColor * (vegBack * 0.35 * RECIPROCAL_PI * vegBake.r);
`;

// Leaf cards: cut out of the atlas, fading by shrinking every leaf
/** Leaf atlas size (px). */
const LEAF_ATLAS = 512;
/** Alpha cut-off at full size: each leaf's cone of alpha crosses it at the leaf's edge. */
const LEAF_CUT = 0.35;

const CARD_VERT_PARS = /* glsl */ `
${NEAR_VERT_PARS}
varying vec2 vLeafUv;
`;
const CARD_FRAG_PARS = /* glsl */ `
${NEAR_FRAG_PARS}
uniform sampler2D uLeaf;
uniform vec2 uCardFade; // leaves shrink away between (start, end) m
varying vec2 vLeafUv;
`;
const CARD_MAP_GLSL = /* glsl */ `
  vec4 leaf = texture2D(uLeaf, vLeafUv);
  // Mips average the leaves' alpha down: hold their size as the cards recede
  vec2 leafPx = vLeafUv * ${LEAF_ATLAS}.0;
  float leafLod = max(0.0, 0.5 * log2(max(dot(dFdx(leafPx), dFdx(leafPx)), dot(dFdy(leafPx), dFdy(leafPx)))));
  float leafCut = mix(${LEAF_CUT}, 1.01, smoothstep(uCardFade.x, uCardFade.y, distance(vInstWorld, cameraPosition)));
  if (leaf.a * (1.0 + 0.3 * leafLod) < leafCut) discard;
  diffuseColor.rgb *= leaf.rgb * 1.25;
`;

// Felled trees: the close build, kept on one side of the cut (no sway)
const FELL_VERT_PARS = /* glsl */ `
attribute vec3 aCut; // cut height (model units), side kept (+1 above, −1 below), heat 0–1
varying vec3 vInstWorld;
varying vec3 vCut;
`;
const FELL_VERT_BEGIN = /* glsl */ `
  vec3 transformed = vec3(position);
  vInstWorld = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vCut = vec3((position.y - aCut.x) * aCut.y, aCut.y, aCut.z);
`;
const FELL_FRAG_PARS = /* glsl */ `
${NEAR_FRAG_PARS}
varying vec3 vCut;
`;
const FELL_COLOR_GLSL = /* glsl */ `
  #include <color_fragment>
  // The cut: the inside of the trunk's tube charred, its rim glowing while hot
  float fellRim = 1.0 - smoothstep(0.0, 0.45, vCut.x);
  if (!gl_FrontFacing && vCut.x < 1.2) diffuseColor.rgb = vec3(0.02, 0.016, 0.012);
`;

const impVertPars = (kinds: number) => /* glsl */ `
attribute vec4 iA; // x y z, height scale
attribute vec2 iB; // width scale, kind
attribute vec3 iT; // tint
uniform float uTime;
uniform vec3 uEye;
uniform vec4 uFade; // dither band (start, end), outer shrink (start, end)
uniform vec4 uKinds[${kinds}]; // half-width, height, base offset, atlas column
varying vec3 vInstWorld;
varying float vLod;
varying vec2 vAtlas;
varying vec3 vTint;
varying vec3 vRight;
varying vec3 vUpW;
varying vec3 vFwd;
`;
const impVertBegin = (kinds: number) => /* glsl */ `
  vec4 K = uKinds[int(iB.y + 0.5)];
  vec3 origin = iA.xyz;
  vInstWorld = origin;
  vTint = iT;
  vec3 toCam = cameraPosition - origin;
  float d = length(toCam);
  vec3 dir = toCam / max(d, 1e-3);
  vec3 flat3 = normalize(vec3(toCam.x, 0.0, toCam.z) + vec3(1e-4, 0.0, 0.0));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), flat3));
  // Upright, leaning back toward the eye when seen from above (no paper-thin crowns)
  vec3 up = normalize(vec3(0.0, 1.0, 0.0) - dir * dir.y * 0.6);
  vec3 fwd = normalize(cross(right, up));
  vRight = right;
  vUpW = up;
  vFwd = fwd;
  float grow = smoothstep(uFade.w, uFade.z, d);
  float w = K.x * iB.x * grow;
  float h = K.y * iA.w * grow;
  float gust = 0.6 + 0.4 * sin(uTime * 0.37 + origin.x * 0.004 - origin.z * 0.003);
  float sway = sin(uTime * 1.3 + origin.x * 0.05 + origin.z * 0.07) * 0.04 * gust * (position.y + 0.5) * h;
  vec3 transformed = origin + right * (position.x * 2.0 * w + sway) + up * (K.z * iA.w + (position.y + 0.5) * h);
  vLod = smoothstep(uFade.x, uFade.y, d);
  vAtlas = vec2((uv.x + K.w) / ${kinds}.0, uv.y);
`;
const IMP_FRAG_PARS = /* glsl */ `
uniform sampler2D uBake;
uniform float uWorld;
uniform sampler2D uAtlasC;
uniform sampler2D uAtlasN;
varying vec3 vInstWorld;
varying float vLod;
varying vec2 vAtlas;
varying vec3 vTint;
varying vec3 vRight;
varying vec3 vUpW;
varying vec3 vFwd;
${DITHER_GLSL}
${ATMOSPHERE_GLSL}
`;

// ── Leaf atlas ───────────────────────────────────────────────────────────

/**
 * Four sprays of small leaves on twigs, one per quadrant: rgb a multiplier
 * on the crown's baked colour (each leaf its own value and a little warmer
 * or cooler, darker toward its stalk), alpha a cone peaking down each
 * leaf's midrib, so filtering keeps the edges crisp close up and raising
 * the cut-off shrinks every leaf evenly (how the cards fade out).
 */
function leafAtlas(): THREE.DataTexture {
  const N = LEAF_ATLAS;
  const Q = N / 2;
  const px = new Uint8Array(N * N * 4);
  const rnd = seeded(41, 17);
  const put = (x: number, y: number, a: number, r: number, g: number, b: number) => {
    const i = (y * N + x) * 4;
    if (a * 255 <= px[i + 3]) return;
    px[i] = Math.min(255, r * 255);
    px[i + 1] = Math.min(255, g * 255);
    px[i + 2] = Math.min(255, b * 255);
    px[i + 3] = a * 255;
  };
  /** A pointed oval, `len` × `wid` px, centred at (cx, cy) in quadrant (qx, qy). */
  const shape = (qx: number, qy: number, cx: number, cy: number, ang: number, len: number, wid: number, tone: readonly number[], taper: number) => {
    const ex = len / 2 / (1 - LEAF_CUT);
    const ey = wid / 2 / (1 - LEAF_CUT);
    const R = Math.ceil(ex);
    const co = Math.cos(ang);
    const si = Math.sin(ang);
    // A few texels' margin round each quadrant, so the mips don't bleed sprays together
    for (let y = Math.max(4, Math.floor(cy - R)); y <= Math.min(Q - 5, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(4, Math.floor(cx - R)); x <= Math.min(Q - 5, Math.ceil(cx + R)); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = (dx * co + dy * si) / ex;
        const v = (-dx * si + dy * co) / ey;
        const e = Math.hypot(u, v / Math.max(0.2, 1 - taper * u));
        if (e >= 1) continue;
        const k = 0.8 + 0.2 * (u * 0.5 + 0.5);
        put(qx + x, qy + y, 1 - e, tone[0] * k, tone[1] * k, tone[2] * k);
      }
    }
  };
  const TWIG = [0.42, 0.34, 0.24];
  const twig = (qx: number, qy: number, x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    shape(qx, qy, (x0 + x1) / 2, (y0 + y1) / 2, Math.atan2(y1 - y0, x1 - x0), len, 2.6, TWIG, 0.3);
  };
  const leafTone = (): number[] => {
    const v = 0.62 + rnd() * 0.38;
    const h = rnd();
    // Mostly plain, some yellowed in the sun, some bluer in the shade
    const t = h < 0.25 ? [1.08, 1.04, 0.72] : h < 0.45 ? [0.84, 0.95, 1.05] : [1, 1, 1];
    return t.map((c) => c * v);
  };
  for (let q = 0; q < 4; q++) {
    const qx = (q & 1) * Q;
    const qy = (q >> 1) * Q;
    const leafLen = () => Q * (0.095 + rnd() * 0.045);
    const leaf = (x: number, y: number, ang: number) => {
      const l = leafLen();
      shape(qx, qy, x + Math.cos(ang) * l * 0.45, y + Math.sin(ang) * l * 0.45, ang, l, l * (0.42 + rnd() * 0.14), leafTone(), 0.35);
    };
    // The main stem up the card, twigs off it alternately, leaves along both
    const sx = Q * (0.5 + (rnd() - 0.5) * 0.1);
    const ex = Q * (0.5 + (rnd() - 0.5) * 0.25);
    const stem = (t: number): [number, number] => [sx + (ex - sx) * t * t, Q * (0.08 + 0.8 * t)];
    for (let i = 0; i < 8; i++) {
      const [x0, y0] = stem(i / 8);
      const [x1, y1] = stem((i + 1) / 8);
      twig(qx, qy, x0, y0, x1, y1);
    }
    const sprigs: number[][] = [];
    for (let i = 0; i < 9; i++) {
      const t = 0.12 + i * 0.09 + rnd() * 0.04;
      const [x0, y0] = stem(t);
      const side = i % 2 ? 1 : -1;
      const ang = Math.PI / 2 + side * (0.7 + rnd() * 0.5);
      const len = Q * (0.32 - 0.18 * t) * (0.85 + rnd() * 0.3);
      const x1 = x0 + Math.cos(ang) * len;
      const y1 = y0 + Math.sin(ang) * len;
      twig(qx, qy, x0, y0, x1, y1);
      sprigs.push([x0, y0, x1, y1, ang]);
    }
    for (const [x0, y0, x1, y1, ang] of sprigs) {
      const nl = 6 + Math.floor(rnd() * 3);
      for (let l = 0; l < nl; l++) {
        const t = 0.25 + (l / nl) * 0.8;
        leaf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, ang + (l % 2 ? 1 : -1) * (0.5 + rnd() * 0.5));
      }
      leaf(x1, y1, ang + (rnd() - 0.5) * 0.4);
    }
    for (let l = 0; l < 10; l++) {
      const [x, y] = stem(0.15 + l * 0.08);
      leaf(x, y, Math.PI / 2 + (l % 2 ? 1 : -1) * (0.6 + rnd() * 0.5));
    }
    // Loose leaves filling in round the spray, so a card reads as foliage, not a twig
    for (let l = 0; l < 18; l++) {
      const a = rnd() * Math.PI * 2;
      const d = Q * (0.12 + rnd() * 0.26);
      leaf(Q * 0.5 + Math.cos(a) * d, Q * 0.5 + Math.sin(a) * d, rnd() * Math.PI * 2);
    }
    const [tx, ty] = stem(1);
    leaf(tx, ty - 2, Math.PI / 2 + (rnd() - 0.5) * 0.3);
  }
  const tex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ── Impostor atlas ───────────────────────────────────────────────────────

const ATLAS_CELL = 256;

/** Renders each model side-on into an atlas column: colour (√-encoded) and normals. */
function bakeAtlas(renderer: THREE.WebGLRenderer, geos: THREE.BufferGeometry[]): { color: THREE.Texture; normal: THREE.Texture; kinds: THREE.Vector4[] } {
  const W = ATLAS_CELL * geos.length;
  const make = () =>
    new THREE.WebGLRenderTarget(W, ATLAS_CELL, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
    });
  const color = make();
  const normal = make();
  const vert = /* glsl */ `
    attribute vec3 color;
    varying vec3 vC;
    varying vec3 vN;
    void main() {
      vC = color;
      vN = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const matC = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: 'varying vec3 vC; varying vec3 vN; void main() { gl_FragColor = vec4(sqrt(vC), 1.0); }', side: THREE.DoubleSide });
  const matN = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: 'varying vec3 vC; varying vec3 vN; void main() { vec3 n = normalize(vN); n = gl_FrontFacing ? n : -n; gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }',
    side: THREE.DoubleSide,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geos[0], matC);
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, 0, 0.1, 100);
  const kinds: THREE.Vector4[] = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  for (const rt of [color, normal]) {
    renderer.setRenderTarget(rt);
    renderer.clear();
  }
  geos.forEach((g, i) => {
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const hw = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z) * 1.02;
    const y0 = Math.min(0, b.min.y);
    const h = (b.max.y - y0) * 1.02;
    cam.left = -hw;
    cam.right = hw;
    cam.bottom = y0;
    cam.top = y0 + h;
    cam.position.set(0, 0, 50);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    mesh.geometry = g;
    for (const [rt, m] of [
      [color, matC],
      [normal, matN],
    ] as const) {
      mesh.material = m;
      rt.viewport.set(i * ATLAS_CELL, 0, ATLAS_CELL, ATLAS_CELL);
      rt.scissor.set(i * ATLAS_CELL, 0, ATLAS_CELL, ATLAS_CELL);
      rt.scissorTest = true;
      renderer.setRenderTarget(rt);
      renderer.clearDepth();
      renderer.render(scene, cam);
    }
    kinds.push(new THREE.Vector4(hw, h, y0, i));
  });
  for (const rt of [color, normal]) {
    rt.viewport.set(0, 0, W, ATLAS_CELL);
    rt.scissor.set(0, 0, W, ATLAS_CELL);
    rt.scissorTest = false;
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAutoClear;
  matC.dispose();
  matN.dispose();
  return { color: color.texture, normal: normal.texture, kinds };
}

// ── Placement ────────────────────────────────────────────────────────────

interface CellData {
  x: number;
  z: number;
  minY: number;
  maxY: number;
  /** Per species (the garden's included), its plants' matrices and tints. */
  near: Record<string, Float32Array>;
  imp: Float32Array;
  /** Brush clumps: worked out only once the eye comes near (undefined until then). */
  tuft: { brush: Float32Array; grass: Float32Array } | null | undefined;
  cx: number;
  cz: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** A garden plant (world space); `squash` widens or narrows it. */
export interface GardenPlant {
  kind: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  squash?: number;
  yaw?: number;
  tint?: readonly number[];
}

/** Tints (multiplying the models' own colours). */
export const TINT = {
  chaparral: [1, 1, 1],
  sage: [1.75, 1.75, 1.95],
  dryBrush: [2.4, 1.75, 1.35],
  greenGrass: [0.7, 0.85, 0.6],
} as const;

/** Squared distance from a point to a segment, on the ground plane. */
function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const ll = dx * dx + dz * dz;
  const t = ll > 1e-9 ? THREE.MathUtils.clamp(((px - ax) * dx + (pz - az) * dz) / ll, 0, 1) : 0;
  return (px - ax - dx * t) ** 2 + (pz - az - dz * t) ** 2;
}

/** Takes plants (by "x,z") out of a cell: its models and its impostors. */
function strip(c: CellData, gone: Set<string>): void {
  for (const k of Object.keys(c.near)) {
    const src = c.near[k];
    const keep: number[] = [];
    for (let o = 0; o < src.length; o += NEAR_STRIDE) if (!gone.has(`${src[o + 12]},${src[o + 14]}`)) for (let e = 0; e < NEAR_STRIDE; e++) keep.push(src[o + e]);
    if (keep.length !== src.length) c.near[k] = new Float32Array(keep);
  }
  const imp: number[] = [];
  for (let o = 0; o < c.imp.length; o += IMP_STRIDE) if (!gone.has(`${c.imp[o]},${c.imp[o + 2]}`)) for (let e = 0; e < IMP_STRIDE; e++) imp.push(c.imp[o + e]);
  if (imp.length !== c.imp.length) c.imp = new Float32Array(imp);
}

export class Vegetation {
  readonly group = new THREE.Group();
  /** Every species drawn, wild and planted (the impostor atlas's column order). */
  private readonly kinds: string[];
  private readonly species: Record<string, Species>;
  private readonly near: Record<string, THREE.InstancedMesh> = {};
  private readonly close: Record<string, THREE.InstancedMesh> = {};
  private readonly cap: Record<string, number> = {};
  private readonly capHi: Record<string, number> = {};
  private readonly tuft: THREE.InstancedMesh;
  private readonly tuftHi: THREE.InstancedMesh;
  private readonly grass: THREE.InstancedMesh;
  private readonly imp: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  private readonly impA: THREE.InstancedBufferAttribute;
  private readonly impB: THREE.InstancedBufferAttribute;
  private readonly impT: THREE.InstancedBufferAttribute;
  private readonly cache = new Map<string, CellData>();
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly lastEye = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastDir = new THREE.Vector3();
  private lastFov = 0;
  /** Cells left unplanted at the last rebuild (over the time budget). */
  private pending = false;
  private readonly frustum = new THREE.Frustum();
  private readonly _vp = new THREE.Matrix4();
  private readonly _dir = new THREE.Vector3();
  /** The garden's plants by the cell they stand in, merged into it when it's planted. */
  private readonly gardenCells = new Map<string, { near: Record<string, number[]>; imp: number[]; grass: number[]; minY: number; maxY: number }>();
  /** Garden plants ("x,z") stand on the house's decks: felled, they fall no lower than this. */
  private readonly gardenFloor = new Map<string, number>();
  /** What the unibeam has taken, per cell ("x,z" of each plant), so a cell planted again stays cut. */
  private readonly cuts = new Map<string, Set<string>>();
  /** Something was cut: rebuild the lists next frame. */
  private dirty = false;
  private lastTime = 0;
  readonly felling: Felling;
  /** Leaf cards over a close build: (mesh, its cards), drawn from the mesh's own instances. */
  private readonly cards: [THREE.InstancedMesh, THREE.InstancedMesh][] = [];
  private cardMesh!: (owner: THREE.InstancedMesh, cards: THREE.BufferGeometry | null, fadeEnd: number) => void;
  /** Cells and instances put in the lists at the last rebuild (stats). */
  stats = { cells: 0, near: 0, imp: 0, tuft: 0, rebuilds: 0, buildMs: 0 };

  constructor(
    private readonly field: Heightfield,
    atmosphere: Record<string, THREE.IUniform>,
    renderer?: THREE.WebGLRenderer,
    garden?: { species: Record<string, Species>; plants: GardenPlant[] },
  ) {
    this.uniforms = {
      ...atmosphere,
      uBake: field.uniforms.uBake,
      uWorld: field.uniforms.uWorld,
      uTime: { value: 0 },
      uEye: { value: new THREE.Vector3() },
    };
    this.species = { ...SPECIES, ...garden?.species };
    this.kinds = Object.keys(this.species);
    // The garden's own kinds hold just what it plants; the coast's get its count on top
    const planted = (k: string) => garden?.plants.filter((p) => p.kind === k).length ?? 0;
    for (const k of this.kinds) {
      this.cap[k] = (isKind(k) ? CAP[k] : 0) + planted(k);
      this.capHi[k] = (isKind(k) ? CAP_HI[k] : 0) + planted(k);
    }
    const lo = Object.fromEntries(this.kinds.map((k) => [k, this.species[k].build('lo')]));

    const nearMat = (fade: THREE.Vector4, key: string, side: THREE.Side = THREE.FrontSide) => {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side });
      mat.envMapIntensity = 0.7;
      const u = { ...this.uniforms, uFade: { value: fade } };
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${NEAR_VERT_PARS}`).replace('#include <begin_vertex>', NEAR_VERT_BEGIN);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${NEAR_FRAG_PARS}`)
          .replace('#include <aomap_fragment>', SHADE_GLSL)
          .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vInstWorld, vegBake.r);');
      };
      mat.customProgramCacheKey = () => `vegetation-${key}`;
      return mat;
    };
    // The impostors dither in across the LOD band over the models, which then
    // shrink away in its last few metres: no discard in the models' shader
    // (alpha-tested draws lose hidden-surface removal on tiled GPUs)
    const treeMat = nearMat(new THREE.Vector4(1e6, 1e6 + 1, LOD_FAR - 14, LOD_FAR), 'near');
    const sheetMat = nearMat(new THREE.Vector4(1e6, 1e6 + 1, LOD_FAR - 14, LOD_FAR), 'near-sheet', THREE.DoubleSide);
    const tuftMat = nearMat(new THREE.Vector4(1e6, 1e6 + 1, TUFT_R * 0.75, TUFT_R), 'tuft');
    const make = (geo: THREE.BufferGeometry, cap: number, mat: THREE.Material) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      return m;
    };
    const hiBuild = Object.fromEntries(this.kinds.map((k) => [k, withCards(() => this.species[k].build('hi'))]));
    for (const k of this.kinds) {
      const mat = this.species[k].twoSided ? sheetMat : treeMat;
      this.near[k] = make(lo[k], this.cap[k], mat);
      this.close[k] = make(hiBuild[k].model, this.capHi[k], mat);
    }

    // Leaf cards: two-sided, lit from the crown's normals whichever side
    // shows, and alpha-tested; only ever over the close builds (< ~150 m),
    // so the discard costs little. They've shrunk away before the hand-over
    // even when the eye has come a rebuild's travel nearer since the lists
    // were drawn up, so a crown never gains its leaves with a pop.
    const leafTex = leafAtlas();
    const cardMats = new Map<number, THREE.Material>();
    const cardMat = (fadeEnd: number) => {
      let mat = cardMats.get(fadeEnd);
      if (mat) return mat;
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
      m.envMapIntensity = 0.7;
      const u = { ...this.uniforms, uFade: { value: new THREE.Vector4(1e6, 1e6 + 1, 1e6, 1e6 + 1) }, uLeaf: { value: leafTex }, uCardFade: { value: new THREE.Vector2(fadeEnd - REBUILD_MOVE - 36, fadeEnd - REBUILD_MOVE - 2) } };
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${CARD_VERT_PARS}`).replace('#include <begin_vertex>', `${NEAR_VERT_BEGIN}\n  vLeafUv = uv;`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${CARD_FRAG_PARS}`)
          .replace('#include <map_fragment>', CARD_MAP_GLSL)
          .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
          .replace('#include <aomap_fragment>', SHADE_GLSL)
          .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vInstWorld, vegBake.r);');
      };
      m.customProgramCacheKey = () => `vegetation-cards-${fadeEnd}`;
      cardMats.set(fadeEnd, m);
      return m;
    };
    this.cardMesh = (owner, geo, fadeEnd) => {
      if (!geo) return;
      const m = new THREE.InstancedMesh(geo, cardMat(fadeEnd), 1);
      m.instanceMatrix = owner.instanceMatrix;
      m.instanceColor = owner.instanceColor;
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      // After the shells, so depth rejects the halves of the cards inside them
      m.renderOrder = 1;
      this.group.add(m);
      this.cards.push([owner, m]);
    };
    for (const k of this.kinds) this.cardMesh(this.close[k], hiBuild[k].cards, this.species[k].hiRange);
    this.tuft = make(lo.bush, CAP.tuft, tuftMat);
    this.tuftHi = make(hiBuild.bush.model, CAP.tuftHi, tuftMat);
    this.cardMesh(this.tuftHi, hiBuild.bush.cards, TUFT_HI);
    this.grass = make(grassGeometry(), CAP.grass, tuftMat);

    // Felled trees: both sides drawn (the cut's inside shows), clipped at the cut
    const fellMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    fellMat.envMapIntensity = 0.7;
    fellMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${FELL_VERT_PARS}`).replace('#include <begin_vertex>', FELL_VERT_BEGIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FELL_FRAG_PARS}`)
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vCut.x < 0.0) discard;')
        .replace('#include <color_fragment>', FELL_COLOR_GLSL)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(5.0, 1.6, 0.35) * vCut.z * fellRim * fellRim;')
        .replace('#include <aomap_fragment>', SHADE_GLSL)
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vInstWorld, vegBake.r);');
    };
    fellMat.customProgramCacheKey = () => 'vegetation-felled';
    this.felling = new Felling(field, fellMat);
    // (felled trees keep the leaf-triangle build: no cards to fall with them)
    for (const k of this.kinds) this.felling.register(k, this.species[k].build('hi'));
    this.group.add(this.felling.group);

    // Impostors
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.setAttribute('normal', quad.getAttribute('normal'));
    this.impA = new THREE.InstancedBufferAttribute(new Float32Array(IMP_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.impB = new THREE.InstancedBufferAttribute(new Float32Array(IMP_CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.impT = new THREE.InstancedBufferAttribute(new Float32Array(IMP_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iA', this.impA);
    geo.setAttribute('iB', this.impB);
    geo.setAttribute('iT', this.impT);
    geo.instanceCount = 0;
    const atlas = renderer ? bakeAtlas(renderer, this.kinds.map((k) => lo[k])) : null;
    const impU = {
      ...this.uniforms,
      uFade: { value: new THREE.Vector4(LOD_NEAR, LOD_FAR, RADIUS * 0.85, RADIUS) },
      uKinds: { value: atlas?.kinds ?? this.kinds.map((_, i) => new THREE.Vector4(2, 6, 0, i)) },
      uAtlasC: { value: atlas?.color ?? null },
      uAtlasN: { value: atlas?.normal ?? null },
    };
    const impMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    impMat.envMapIntensity = 0.7;
    impMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, impU);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${impVertPars(this.kinds.length)}`)
        .replace('#include <begin_vertex>', impVertBegin(this.kinds.length))
        // World-space positions already: no instance / model transform
        .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${IMP_FRAG_PARS}`)
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          vec4 atl = texture2D(uAtlasC, vAtlas);
          if (atl.a < 0.5 || lodDither() >= vLod) discard;
          vec3 alb = atl.rgb / atl.a;
          diffuseColor.rgb = alb * alb * vTint;`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `
          vec4 an = texture2D(uAtlasN, vAtlas);
          vec3 nl = an.xyz / max(an.a, 1e-3) * 2.0 - 1.0;
          vec3 nw = normalize(vRight * nl.x + vUpW * nl.y + vFwd * nl.z);
          vec3 normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
          float faceDirection = 1.0;`,
        )
        .replace('#include <normal_fragment_maps>', '')
        .replace('#include <aomap_fragment>', SHADE_GLSL)
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vInstWorld, vegBake.r);');
    };
    impMat.customProgramCacheKey = () => `vegetation-impostor-${this.kinds.length}`;
    this.imp = new THREE.Mesh(geo, impMat);
    this.imp.frustumCulled = false;
    // Always ≥ 330 m out: the suit's shadow box never reaches them
    this.imp.receiveShadow = false;
    this.imp.matrixAutoUpdate = false;
    this.imp.visible = !!atlas;
    this.group.add(this.imp);
    this.group.name = 'vegetation';
    if (garden) this.sow(garden.plants);
  }

  /**
   * Drops the house's garden into the cells it stands in, so it's culled,
   * handed over (close build, lighter build, impostor) and cut down exactly
   * like the cover around it; its dry grass joins the cells' own.
   */
  private sow(plants: GardenPlant[]): void {
    for (const p of plants) {
      const ki = this.kinds.indexOf(p.kind);
      if (ki < 0 && p.kind !== 'grass') continue;
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      let g = this.gardenCells.get(key);
      if (!g) this.gardenCells.set(key, (g = { near: {}, imp: [], grass: [], minY: Infinity, maxY: -Infinity }));
      _q.setFromAxisAngle(UP, p.yaw ?? hash3(p.x, 0, p.z, 7) * Math.PI * 2);
      const k = p.scale;
      const w = k * (p.squash ?? 1);
      _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(w, k, w));
      const t = p.tint ?? TINT.chaparral;
      const v = 0.88 + hash3(p.x, 1, p.z, 3) * 0.24;
      const out = ki < 0 ? g.grass : (g.near[p.kind] ??= []);
      for (let e = 0; e < 16; e++) out.push(_m.elements[e]);
      out.push(t[0] * v, t[1] * v, t[2] * v);
      g.minY = Math.min(g.minY, p.y);
      if (ki < 0) continue;
      g.imp.push(p.x, p.y, p.z, k, w, ki, t[0] * v, t[1] * v, t[2] * v);
      g.maxY = Math.max(g.maxY, p.y + 14 * k);
      this.gardenFloor.set(`${p.x},${p.z}`, p.y - 0.3);
    }
  }

  /** Everything planted in one cell, computed once and cached. */
  private cell(cx: number, cz: number): CellData {
    const key = `${cx},${cz}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const lists: Record<Kind, number[]> = { bush: [], oak: [], pine: [], palm: [] };
    const imp: number[] = [];
    let minY = Infinity;
    let maxY = -Infinity;
    const rnd = seeded(cx, cz);
    const F = this.field;
    const S = THREE.MathUtils.smoothstep;
    const KI: Record<Kind, number> = { bush: 0, oak: 1, pine: 2, palm: 3 };
    const plant = (kind: Kind, x: number, z: number, h: number, k: number, tint: readonly number[], tilt: boolean) => {
      _s.set(k * (0.85 + rnd() * 0.3), k * (0.8 + rnd() * 0.4), k * (0.85 + rnd() * 0.3));
      _q.setFromAxisAngle(UP, rnd() * Math.PI * 2);
      // Shrubs lean with the slope; trees grow straight up
      if (tilt) _q.premultiply(_tilt.setFromUnitVectors(UP, _n));
      const y = h - 0.25 * k;
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      const v = 0.82 + rnd() * 0.36;
      const r = tint[0] * v;
      const g = tint[1] * v * (0.95 + rnd() * 0.1);
      const b = tint[2] * v;
      const out = lists[kind];
      for (let i = 0; i < 16; i++) out.push(_m.elements[i]);
      out.push(r, g, b);
      imp.push(x, y, z, _s.y, (_s.x + _s.z) / 2, KI[kind], r, g, b);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 14 * k);
    };
    const homeD = (x: number, z: number) => Math.hypot(x - HOME.x, z - HOME.y);
    for (let i = 0; i < 120; i++) {
      const x = (cx + rnd()) * CELL;
      const z = (cz + rnd()) * CELL;
      const r = rnd();
      const h = F.heightAt(x, z);
      if (h < 2.5 || h > 1500) continue;
      if (homeD(x, z) < 90) continue;
      // The drive and its verges are kept clear
      if (F.roadDistance(x, z) < 11) continue;
      // Nothing under (or growing out of) the house's rock
      if (homeD(x, z) < 320 && rockOver(F, x, z, h, 8)) continue;
      F.normalAt(x, z, _n);
      const slope = 1 - _n.y;
      if (slope > 0.42) continue;
      // The terrain shader's cover map, on the CPU
      const m2 = F.toneAt(x + 517, z + 517, 1130);
      const m3 = F.toneAt(x - 211, z - 211, 430);
      const mid = F.toneAt(x, z, 160);
      const scrub = S(m2 * 0.5 + m3 * 0.35 + mid * 0.15 + slope * 0.35, 0.5, 0.66);
      const ao = F.aoAt(x, z);
      const oakK = (1 - S(ao, 0.52, 0.82)) * (1 - S(slope, 0.16, 0.38)) * (0.45 + 0.55 * m3);
      const high = S(h, 600, 1000);
      // Sun-facing (south, toward the sea) slopes are the dry ones: sage, not chaparral
      const dry = S(_n.z * 3 + (mid - 0.5), 0.05, 0.6) * (1 - oakK);
      // Palms: low, gentle ground along the bluffs and beaches
      // in groves (planted round the beach houses and along the coast road)
      const coastal =
        (1 - S(h, 30, 95)) * (1 - S(slope, 0.14, 0.3)) * (1 - S(Math.abs(coastZ(x) - z), 900, 1600)) * S(F.toneAt(x - 91, z + 37, 260), 0.48, 0.62);
      if (h < 4.5) {
        if (coastal > 0.3 && r < 0.03 * coastal) plant('palm', x, z, h, 0.85 + rnd() * 0.4, TINT.chaparral, false);
        continue;
      }
      if (r < coastal * 0.1) {
        plant('palm', x, z, h, 0.85 + rnd() * 0.4, TINT.chaparral, false);
      } else if (r < oakK * 0.55) {
        plant(high > 0.5 ? 'pine' : 'oak', x, z, h, 0.7 + rnd() * 0.75, TINT.chaparral, false);
      } else if (r < oakK * 0.55 + scrub * 0.6 + 0.06) {
        const sage = rnd() < dry * 0.8;
        plant('bush', x, z, h, sage ? 0.6 + rnd() * 1.0 : 0.8 + rnd() * 1.8, sage ? TINT.sage : TINT.chaparral, true);
      } else if (r > 0.985 && high < 0.5) plant('oak', x, z, h, 0.7 + rnd() * 0.75, TINT.chaparral, false);
      else if (r > 0.97 && high > 0.5) plant('pine', x, z, h, 0.7 + rnd() * 0.75, TINT.chaparral, false);
    }
    const near: Record<string, Float32Array> = {};
    const planted = this.gardenCells.get(key);
    for (const k of this.kinds) near[k] = new Float32Array([...(isKind(k) ? lists[k] : []), ...(planted?.near[k] ?? [])]);
    if (planted) {
      imp.push(...planted.imp);
      minY = Math.min(minY, planted.minY);
      maxY = Math.max(maxY, planted.maxY);
    }
    const data: CellData = {
      x: (cx + 0.5) * CELL,
      z: (cz + 0.5) * CELL,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
      near,
      imp: new Float32Array(imp),
      tuft: undefined,
      cx,
      cz,
    };
    const gone = this.cuts.get(key);
    if (gone) strip(data, gone);
    this.cache.set(key, data);
    if (this.cache.size > 3000) {
      // Forget the oldest cells
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return data;
  }

  /** The dense brush of one cell (drawn only near the eye, so grown only then). */
  private tufts(c: CellData): { brush: Float32Array; grass: Float32Array } | null {
    if (c.tuft !== undefined) return c.tuft;
    const F = this.field;
    const brush: number[] = [];
    const grass: number[] = [];
    const rt = seeded(c.cx, c.cz, 7);
    for (let i = 0; i < 220; i++) {
      const x = (c.cx + rt()) * CELL;
      const z = (c.cz + rt()) * CELL;
      const h = F.heightAt(x, z);
      if (h < 4.5 || h > 1300 || Math.hypot(x - HOME.x, z - HOME.y) < 90) continue;
      if (Math.hypot(x - HOME.x, z - HOME.y) < 320 && rockOver(F, x, z, h, 1)) continue;
      if (F.roadDistance(x, z) < 7) continue;
      F.normalAt(x, z, _n);
      const slope = 1 - _n.y;
      if (slope > 0.5 || rt() > 1 - slope * 1.2) continue;
      const isGrass = rt() < 0.65;
      const k = isGrass ? 0.7 + rt() * 0.7 : 0.4 + rt() * 0.5;
      const tint = isGrass ? (rt() < 0.7 ? TINT.chaparral : TINT.greenGrass) : rt() < 0.5 ? TINT.dryBrush : TINT.sage;
      _s.set(k * (0.85 + rt() * 0.3), k * (0.8 + rt() * 0.4), k * (0.85 + rt() * 0.3));
      _q.setFromAxisAngle(UP, rt() * Math.PI * 2).premultiply(_tilt.setFromUnitVectors(UP, _n));
      _m.compose(_p.set(x, h - (isGrass ? 0.05 : 0.25) * k, z), _q, _s);
      const v = 0.8 + rt() * 0.4;
      const out = isGrass ? grass : brush;
      for (let e = 0; e < 16; e++) out.push(_m.elements[e]);
      out.push(tint[0] * v, tint[1] * v, tint[2] * v);
    }
    grass.push(...(this.gardenCells.get(`${c.cx},${c.cz}`)?.grass ?? []));
    c.tuft = brush.length + grass.length ? { brush: new Float32Array(brush), grass: new Float32Array(grass) } : null;
    return c.tuft;
  }

  /**
   * The unibeam's line (from `from` along unit `dir`, `reach` m, `radius`
   * m thick) through the cover and the garden: trees it crosses are cut
   * through where it meets the stem and fall away from the suit, brush
   * burns off. Only cells already planted can hold anything it hits.
   */
  cut(from: THREE.Vector3, dir: THREE.Vector3, reach: number, radius: number): void {
    const ex = from.x + dir.x * reach;
    const ez = from.z + dir.z * reach;
    // Far enough off the line that nothing standing there can reach it
    const pad = radius + 8;
    const near = (x: number, z: number, r: number) => segDist2(x, z, from.x, from.z, ex, ez) < r * r;
    const tint = new THREE.Color();
    const take = (kind: string, src: Float32Array, o: number): boolean => {
      if (!near(src[o + 12], src[o + 14], pad * Math.max(1, Math.hypot(src[o + 4], src[o + 5], src[o + 6])))) return false;
      _m.fromArray(src, o);
      const y = this.felling.strike(kind, _m, from, dir, reach, radius);
      if (y < 0) return false;
      // (the garden, laid on the house's decks, falls no lower than it stood)
      this.felling.fell(kind, _m, tint.fromArray(src, o + 16), y, from, this.gardenFloor.get(`${src[o + 12]},${src[o + 14]}`));
      return true;
    };
    const x0 = Math.floor((Math.min(from.x, ex) - pad) / CELL);
    const x1 = Math.floor((Math.max(from.x, ex) + pad) / CELL);
    const z0 = Math.floor((Math.min(from.z, ez) - pad) / CELL);
    const z1 = Math.floor((Math.max(from.z, ez) + pad) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = `${cx},${cz}`;
        const c = this.cache.get(key);
        if (!c || !near(c.x, c.z, CELL * Math.SQRT1_2 + pad)) continue;
        let gone: Set<string> | null = null;
        for (const k of this.kinds) {
          const src = c.near[k];
          for (let o = 0; o < src.length; o += NEAR_STRIDE) {
            if (!take(k, src, o)) continue;
            gone ??= new Set();
            gone.add(`${src[o + 12]},${src[o + 14]}`);
          }
        }
        if (!gone) continue;
        const all = this.cuts.get(key) ?? new Set<string>();
        for (const g of gone) all.add(g);
        this.cuts.set(key, all);
        strip(c, gone);
        this.dirty = true;
      }
    }
  }

  update(camera: THREE.PerspectiveCamera | THREE.Camera, time: number): void {
    const eye = camera.position;
    this.felling.update(THREE.MathUtils.clamp(time - this.lastTime, 0, 0.1));
    this.lastTime = time;
    this.uniforms.uTime.value = time;
    (this.uniforms.uEye.value as THREE.Vector3).copy(eye);
    const ground = Math.max(0, this.field.heightAt(eye.x, eye.z));
    const alt = eye.y - ground;
    this.group.visible = alt < RADIUS * 0.9;
    if (!this.group.visible) return;
    camera.getWorldDirection(this._dir);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 0;
    if (!this.pending && !this.dirty && eye.distanceToSquared(this.lastEye) < REBUILD_MOVE * REBUILD_MOVE && this._dir.dot(this.lastDir) > REBUILD_TURN && fov === this.lastFov) return;
    // A jump (boot, respawn, a teleport) plants the whole ring at once:
    // no point growing it in over seconds behind a cut
    const jumped = eye.distanceToSquared(this.lastEye) > 500 * 500;
    this.lastEye.copy(eye);
    this.lastDir.copy(this._dir);
    this.lastFov = fov;
    this.rebuild(camera, jumped ? Infinity : PLANT_BUDGET_MS);
  }

  /** Visible cells into the instance lists. */
  private rebuild(camera: THREE.Camera, budgetMs: number): void {
    const t0 = performance.now();
    let pending = false;
    this.dirty = false;
    const eye = camera.position;
    camera.updateMatrixWorld();
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._vp);
    const planes = this.frustum.planes;
    const cx = Math.floor(eye.x / CELL);
    const cz = Math.floor(eye.z / CELL);
    const reach = Math.ceil(RADIUS / CELL);
    const nearCount: Record<string, number> = Object.fromEntries(this.kinds.map((k) => [k, 0]));
    const hiCount: Record<string, number> = { ...nearCount };
    let impN = 0;
    let tuftN = 0;
    let tuftHiN = 0;
    let grassN = 0;
    let cells = 0;
    const impA = this.impA.array as Float32Array;
    const impB = this.impB.array as Float32Array;
    const impT = this.impT.array as Float32Array;
    const half = CELL * 0.5;
    const centre = _p;
    const copyNear = (mesh: THREE.InstancedMesh, src: Float32Array, at: number, cap: number): number => {
      const n = Math.min(cap - at, src.length / NEAR_STRIDE);
      const m = mesh.instanceMatrix.array as Float32Array;
      const c = mesh.instanceColor!.array as Float32Array;
      for (let i = 0; i < n; i++) {
        const o = i * NEAR_STRIDE;
        m.set(src.subarray(o, o + 16), (at + i) * 16);
        c[(at + i) * 3] = src[o + 16];
        c[(at + i) * 3 + 1] = src[o + 17];
        c[(at + i) * 3 + 2] = src[o + 18];
      }
      return Math.max(0, n);
    };
    const put = (mesh: THREE.InstancedMesh, src: Float32Array, o: number, at: number) => {
      (mesh.instanceMatrix.array as Float32Array).set(src.subarray(o, o + 16), at * 16);
      (mesh.instanceColor!.array as Float32Array).set(src.subarray(o + 16, o + 19), at * 3);
    };
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const x0 = (cx + i) * CELL;
        const z0 = (cz + j) * CELL;
        const dx = Math.max(x0 - eye.x, 0, eye.x - (x0 + CELL));
        const dz = Math.max(z0 - eye.z, 0, eye.z - (z0 + CELL));
        const flat2 = dx * dx + dz * dz;
        if (flat2 > RADIUS * RADIUS) continue;
        // Planting a cell costs ~1 ms: past the frame's budget, cells out
        // beyond the models' range wait for the next frame (they only grow
        // in at the far edge anyway), so a fast pass never hitches
        const ready = this.cache.get(`${cx + i},${cz + j}`);
        if (!ready && flat2 > LOD_FAR * LOD_FAR && performance.now() - t0 > budgetMs) {
          pending = true;
          continue;
        }
        const c = ready ?? this.cell(cx + i, cz + j);
        if (c.imp.length === 0 && c.tuft === null) continue;
        // Sphere round the cell, widened by a cone so small turns don't need a rebuild
        const midY = (c.minY + c.maxY) * 0.5;
        centre.set(c.x, midY, c.z);
        const dist = centre.distanceTo(eye);
        const rad = Math.hypot(half * Math.SQRT2, (c.maxY - c.minY) * 0.5) + REBUILD_MOVE + dist * CULL_MARGIN;
        let inside = true;
        for (let p = 0; p < 6; p++) {
          if (planes[p].distanceToPoint(centre) < -rad) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;
        cells++;
        const dy = Math.max(c.minY - eye.y, 0, eye.y - c.maxY);
        const dMin = Math.sqrt(flat2 + dy * dy);
        const dMax = Math.hypot(Math.max(Math.abs(c.x - eye.x) + half, 0), Math.max(Math.abs(c.z - eye.z) + half, 0), Math.max(Math.abs(c.minY - eye.y), Math.abs(c.maxY - eye.y)));
        for (const k of this.kinds) {
          if (!c.near[k].length) continue;
          const hr = this.species[k].hiRange;
          if (dMax < hr) hiCount[k] += copyNear(this.close[k], c.near[k], hiCount[k], this.capHi[k]);
          else if (dMin > hr) {
            if (dMin < LOD_FAR + REBUILD_MOVE) nearCount[k] += copyNear(this.near[k], c.near[k], nearCount[k], this.cap[k]);
          } else {
            // Straddling the hand-over: tree by tree
            const src = c.near[k];
            for (let o = 0; o < src.length; o += NEAR_STRIDE) {
              const ex = src[o + 12] - eye.x;
              const ey = src[o + 13] - eye.y;
              const ez = src[o + 14] - eye.z;
              if (ex * ex + ey * ey + ez * ez < hr * hr) {
                if (hiCount[k] < this.capHi[k]) put(this.close[k], src, o, hiCount[k]++);
              } else if (nearCount[k] < this.cap[k]) put(this.near[k], src, o, nearCount[k]++);
            }
          }
        }
        if (dMax > LOD_NEAR - REBUILD_MOVE && c.imp.length) {
          const n = Math.min(IMP_CAP - impN, c.imp.length / IMP_STRIDE);
          for (let q = 0; q < n; q++) {
            const o = q * IMP_STRIDE;
            const w = impN + q;
            impA[w * 4] = c.imp[o];
            impA[w * 4 + 1] = c.imp[o + 1];
            impA[w * 4 + 2] = c.imp[o + 2];
            impA[w * 4 + 3] = c.imp[o + 3];
            impB[w * 2] = c.imp[o + 4];
            impB[w * 2 + 1] = c.imp[o + 5];
            impT[w * 3] = c.imp[o + 6];
            impT[w * 3 + 1] = c.imp[o + 7];
            impT[w * 3 + 2] = c.imp[o + 8];
          }
          impN += Math.max(0, n);
        }
        if (dMin < TUFT_R + REBUILD_MOVE) {
          const t = this.tufts(c);
          if (t && dMin < TUFT_HI + REBUILD_MOVE) {
            // By the eye: clump by clump
            const src = t.brush;
            for (let o = 0; o < src.length; o += NEAR_STRIDE) {
              const near = (src[o + 12] - eye.x) ** 2 + (src[o + 13] - eye.y) ** 2 + (src[o + 14] - eye.z) ** 2 < TUFT_HI * TUFT_HI;
              if (near && tuftHiN < CAP.tuftHi) put(this.tuftHi, src, o, tuftHiN++);
              else if (!near && tuftN < CAP.tuft) put(this.tuft, src, o, tuftN++);
            }
            grassN += copyNear(this.grass, t.grass, grassN, CAP.grass);
          } else if (t) {
            tuftN += copyNear(this.tuft, t.brush, tuftN, CAP.tuft);
            grassN += copyNear(this.grass, t.grass, grassN, CAP.grass);
          }
        }
      }
    }
    const upload = (attr: THREE.BufferAttribute, n: number) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    };
    for (const k of this.kinds) {
      for (const [m, n] of [
        [this.near[k], nearCount[k]],
        [this.close[k], hiCount[k]],
      ] as const) {
        m.count = n;
        upload(m.instanceMatrix, n);
        upload(m.instanceColor!, n);
      }
    }
    this.tuft.count = tuftN;
    upload(this.tuft.instanceMatrix, tuftN);
    upload(this.tuft.instanceColor!, tuftN);
    this.tuftHi.count = tuftHiN;
    upload(this.tuftHi.instanceMatrix, tuftHiN);
    upload(this.tuftHi.instanceColor!, tuftHiN);
    this.grass.count = grassN;
    upload(this.grass.instanceMatrix, grassN);
    upload(this.grass.instanceColor!, grassN);
    for (const [owner, cards] of this.cards) cards.count = owner.count;
    this.imp.geometry.instanceCount = impN;
    upload(this.impA, impN);
    upload(this.impB, impN);
    upload(this.impT, impN);
    this.pending = pending;
    const nearN = this.kinds.reduce((s, k) => s + nearCount[k] + hiCount[k], 0);
    this.stats = { cells, near: nearN, imp: impN, tuft: tuftN + tuftHiN + grassN, rebuilds: this.stats.rebuilds + 1, buildMs: +(performance.now() - t0).toFixed(2) };
  }

  get instanceCount(): number {
    return this.stats.near + this.stats.imp + this.stats.tuft;
  }
}
