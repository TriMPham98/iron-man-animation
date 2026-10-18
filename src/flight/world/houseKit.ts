import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The house's building kit: smooth closed plan outlines (slab edges, glass
 * lines) that can be offset, extruded and tested against, and a batcher that
 * gathers every piece of one material into a single merged mesh with
 * vertex colours, a per-vertex glow (interior light, lamps) and world-scale
 * box-projected UVs. All coordinates are in the house frame: x = along the
 * cliff, y = up from the terrace, z = out toward the sea.
 */

export type P2 = readonly [number, number];

const UP = new THREE.Vector3(0, 1, 0);

/** A closed plan outline, counter-clockwise in (x, z), with outward normals. */
export class Outline {
  constructor(
    readonly pts: THREE.Vector2[],
    readonly nrm: THREE.Vector2[],
  ) {}

  /** Smooth closed curve through control points, resampled every `spacing` metres. */
  static smooth(ctrl: P2[], spacing = 1.2): Outline {
    const curve = new THREE.CatmullRomCurve3(
      ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
    );
    const n = Math.max(12, Math.ceil(curve.getLength() / spacing));
    const pts = curve.getSpacedPoints(n).slice(0, n).map((p) => new THREE.Vector2(p.x, p.z));
    return Outline.fromPoints(pts);
  }

  static circle(cx: number, cz: number, r: number, n = 64): Outline {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cz + Math.sin(a) * r));
    }
    return Outline.fromPoints(pts);
  }

  static fromPoints(pts: THREE.Vector2[]): Outline {
    if (THREE.ShapeUtils.area(pts) < 0) pts.reverse();
    const n = pts.length;
    const nrm: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n];
      const b = pts[(i + 1) % n];
      // CCW: outward is the tangent turned clockwise
      nrm.push(new THREE.Vector2(b.y - a.y, -(b.x - a.x)).normalize());
    }
    return new Outline(pts, nrm);
  }

  /** Grown (d > 0) or shrunk (d < 0) along the normals. */
  offset(d: number): Outline {
    return Outline.fromPoints(this.pts.map((p, i) => p.clone().addScaledVector(this.nrm[i], d)));
  }

  shape(): THREE.Shape {
    return new THREE.Shape(this.pts);
  }

  contains(x: number, z: number): boolean {
    const p = this.pts;
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if (p[i].y > z !== p[j].y > z && x < ((p[j].x - p[i].x) * (z - p[i].y)) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
    }
    return inside;
  }

  get length(): number {
    let s = 0;
    for (let i = 0; i < this.pts.length; i++) s += this.pts[i].distanceTo(this.pts[(i + 1) % this.pts.length]);
    return s;
  }
}

/** Plan-space hit test with a cached bounding box. */
export class Footprint {
  private readonly min = new THREE.Vector2(Infinity, Infinity);
  private readonly max = new THREE.Vector2(-Infinity, -Infinity);
  constructor(
    private readonly outline: Outline,
    readonly top: number,
  ) {
    for (const p of outline.pts) {
      this.min.min(p);
      this.max.max(p);
    }
  }
  test(x: number, z: number): boolean {
    return x >= this.min.x && x <= this.max.x && z >= this.min.y && z <= this.max.y && this.outline.contains(x, z);
  }
}

/** Collects geometry for one material and merges it into one mesh. */
export class Batch {
  private readonly parts: THREE.BufferGeometry[] = [];
  constructor(
    readonly name: string,
    private readonly uvScale = 0.25,
    /** 'box': projected on the dominant axis; 'wall': along the plan and up (cliffs). */
    private readonly projection: 'box' | 'wall' = 'box',
  ) {}

  /** Adds a geometry (consumed), painted one colour and glow. */
  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation = 0xffffff, glow = 0): void {
    const geo = g.index ? g.toNonIndexed() : g;
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color' && k !== 'glow') geo.deleteAttribute(k);
    const n = geo.getAttribute('position').count;
    if (!geo.getAttribute('color')) {
      const c = new THREE.Color(color);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (!geo.getAttribute('glow')) geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    geo.morphAttributes = {};
    geo.groups = [];
    this.parts.push(geo);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  /** One mesh, with box-projected world-scale UVs. */
  build(material: THREE.Material): THREE.Mesh {
    const geo = mergeGeometries(this.parts) ?? new THREE.BufferGeometry();
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const uv = new Float32Array(pos.count * 2);
    const s = this.uvScale;
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nrm.getX(i));
      const ay = Math.abs(nrm.getY(i));
      const az = Math.abs(nrm.getZ(i));
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (this.projection === 'wall') uv.set([(x + z * 0.7) * s, y * s], i * 2);
      else if (ay >= ax && ay >= az) uv.set([x * s, z * s], i * 2);
      else if (ax >= az) uv.set([z * s, y * s], i * 2);
      else uv.set([x * s, y * s], i * 2);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = this.name;
    return mesh;
  }
}

// ── Geometry pieces ───────────────────────────────────────────────────────

/** Triangles from a flat list of corner points, each facing along `facing` (flipped if needed). */
export function polyGeo(tris: THREE.Vector3[], facing?: THREE.Vector3): THREE.BufferGeometry {
  const pos = new Float32Array(tris.length * 3);
  const nrm = new Float32Array(tris.length * 3);
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < tris.length; i += 3) {
    let a = tris[i];
    let b = tris[i + 1];
    const c = tris[i + 2];
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).normalize();
    if (facing && n.dot(facing) < 0) {
      [a, b] = [b, a];
      n.negate();
    }
    pos.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], i * 3);
    nrm.set([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/** A vertical quad from plan point a to b, y0 to y1, facing `n` (plan). */
export function wallQuad(a: THREE.Vector2, b: THREE.Vector2, y0: number, y1: number, n: THREE.Vector2): THREE.BufferGeometry {
  const A = new THREE.Vector3(a.x, y0, a.y);
  const B = new THREE.Vector3(b.x, y0, b.y);
  const C = new THREE.Vector3(b.x, y1, b.y);
  const D = new THREE.Vector3(a.x, y1, a.y);
  return polyGeo([A, B, C, A, C, D], new THREE.Vector3(n.x, 0, n.y));
}

/** A flat plate filling an outline (minus holes) at height y, facing up or down. */
export function flat(o: Outline, y: number, up: boolean, holes: Outline[] = []): THREE.BufferGeometry {
  const contour = o.pts;
  const hs = holes.map((h) => h.pts.slice().reverse());
  const faces = THREE.ShapeUtils.triangulateShape(contour, hs);
  const all = [...contour, ...hs.flat()];
  const tris: THREE.Vector3[] = [];
  for (const f of faces) for (const k of f) tris.push(new THREE.Vector3(all[k].x, y, all[k].y));
  return polyGeo(tris, up ? UP : UP.clone().negate());
}

/** Slab: the outline extruded down from `top` by `thick`, edges softly rounded. */
export function slab(o: Outline, top: number, thick: number, bevel = 0.06, holes: Outline[] = []): THREE.BufferGeometry {
  const shape = o.shape();
  for (const h of holes) shape.holes.push(new THREE.Path(h.pts));
  const b = Math.min(bevel, thick * 0.3);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, thick - 2 * b),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 2,
    curveSegments: 1,
    steps: 1,
  });
  g.rotateX(Math.PI / 2);
  g.translate(0, top - b, 0);
  return g;
}

/** Edge beam: a ring between the outline and its inset, hanging below `top`. */
export function fascia(o: Outline, top: number, depth: number, width: number): THREE.BufferGeometry {
  return slab(o, top, depth, 0.05, [o.offset(-width)]);
}

/** An oriented box: centre, size, yaw about y. */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (yaw) g.rotateY(yaw);
  return g.translate(x, y, z);
}

/** A box laid along a plan segment a→b (length along it), centred at height y. */
export function beam(a: THREE.Vector2, b: THREE.Vector2, y: number, h: number, d: number, extra = 0): THREE.BufferGeometry {
  const len = a.distanceTo(b) + extra;
  const g = new THREE.BoxGeometry(len, h, d);
  g.rotateY(-Math.atan2(b.y - a.y, b.x - a.x));
  return g.translate((a.x + b.x) / 2, y, (a.y + b.y) / 2);
}

/** A tapered strut between two points: rectangular, `wa`×`da` at a, `wb`×`db` at b. */
export function strut(a: THREE.Vector3, b: THREE.Vector3, wa: number, da: number, wb: number, db: number): THREE.BufferGeometry {
  const axis = new THREE.Vector3().subVectors(b, a).normalize();
  // Width runs horizontally across the strut, depth in the remaining direction
  const side = new THREE.Vector3().crossVectors(axis, UP);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const fwd = new THREE.Vector3().crossVectors(side, axis).normalize();
  const corner = (c: THREE.Vector3, w: number, d: number, sx: number, sz: number) =>
    c.clone().addScaledVector(side, (sx * w) / 2).addScaledVector(fwd, (sz * d) / 2);
  const A = [corner(a, wa, da, -1, -1), corner(a, wa, da, 1, -1), corner(a, wa, da, 1, 1), corner(a, wa, da, -1, 1)];
  const B = [corner(b, wb, db, -1, -1), corner(b, wb, db, 1, -1), corner(b, wb, db, 1, 1), corner(b, wb, db, -1, 1)];
  const centre = a.clone().add(b).multiplyScalar(0.5);
  const tris: THREE.Vector3[] = [];
  const faces: THREE.Vector3[][] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    faces.push([A[i], A[j], B[j], B[i]]);
  }
  faces.push([A[0], A[1], A[2], A[3]], [B[0], B[1], B[2], B[3]]);
  const parts: THREE.BufferGeometry[] = [];
  for (const f of faces) {
    const mid = f[0].clone().add(f[1]).add(f[2]).add(f[3]).multiplyScalar(0.25);
    const out = mid.sub(centre);
    tris.length = 0;
    tris.push(f[0], f[1], f[2], f[0], f[2], f[3]);
    parts.push(polyGeo(tris.slice(), out));
  }
  return mergeGeometries(parts)!;
}

/** Paints every vertex of a geometry (for parts merged before batching). */
export function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, glow = 0): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute('position').count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color' && k !== 'glow') geo.deleteAttribute(k);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  return geo;
}

/** Arc-length positions along an outline's segments: calls fn every `step` metres. */
export function alongOutline(o: Outline, step: number, fn: (p: THREE.Vector2, n: THREE.Vector2, i: number) => void, phase = 0): void {
  let acc = phase;
  const P = o.pts;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const len = a.distanceTo(b);
    const n = o.nrm[i].clone().add(o.nrm[(i + 1) % P.length]).normalize();
    while (acc <= len) {
      fn(a.clone().lerp(b, acc / len), n, i);
      acc += step;
    }
    acc -= len;
  }
}

// ── Surfaces ──────────────────────────────────────────────────────────────

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

function canvasTexture(size: number, draw: (c: CanvasRenderingContext2D, rnd: () => number) => void, seed: number, srgb = true): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d')!;
  draw(c, seeded(seed));
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Off-white cast concrete: faint blotching and board-form lines. 1 tile = 4 m. */
function concreteMap(): THREE.Texture {
  return canvasTexture(
    512,
    (c, rnd) => {
      c.fillStyle = '#f2f0eb';
      c.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 260; i++) {
        const x = rnd() * 512;
        const y = rnd() * 512;
        const r = 10 + rnd() * 60;
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        const v = rnd() < 0.5 ? '120,115,105' : '255,255,250';
        g.addColorStop(0, `rgba(${v},${0.025 + rnd() * 0.035})`);
        g.addColorStop(1, `rgba(${v},0)`);
        c.fillStyle = g;
        c.fillRect(x - r, y - r, r * 2, r * 2);
      }
      // Board-form joints every 0.5 m, a panel joint every 2 m
      for (let y = 0; y < 512; y += 64) {
        c.fillStyle = `rgba(90,85,78,${y % 256 === 0 ? 0.16 : 0.05})`;
        c.fillRect(0, y, 512, y % 256 === 0 ? 2 : 1);
      }
      for (let i = 0; i < 3000; i++) {
        c.fillStyle = `rgba(80,76,70,${rnd() * 0.08})`;
        c.fillRect(rnd() * 512, rnd() * 512, 1 + rnd() * 2, 1 + rnd() * 2);
      }
    },
    11,
  );
}

/** Dry-laid sandstone: coursed blocks of warm buff and grey. 1 tile = 4 m. */
function stoneMap(): THREE.Texture {
  return canvasTexture(
    512,
    (c, rnd) => {
      c.fillStyle = '#4a4238';
      c.fillRect(0, 0, 512, 512);
      let y = 0;
      while (y < 512) {
        const h = 22 + Math.floor(rnd() * 26);
        let x = -Math.floor(rnd() * 60);
        while (x < 512) {
          const w = 40 + Math.floor(rnd() * 70);
          const t = rnd();
          const r = 150 + t * 70 + rnd() * 15;
          const g = 135 + t * 60 + rnd() * 10;
          const b = 110 + t * 45;
          c.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
          c.fillRect(x + 2, y + 2, w - 3, Math.min(h, 512 - y) - 3);
          // Weathering speckle
          for (let k = 0; k < 18; k++) {
            c.fillStyle = `rgba(${rnd() < 0.5 ? '60,50,40' : '255,245,225'},${rnd() * 0.18})`;
            c.fillRect(x + rnd() * w, y + rnd() * h, 2 + rnd() * 8, 1 + rnd() * 4);
          }
          if (x + w > 512) {
            // Wrap the last block so the tile repeats seamlessly
            c.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
            c.fillRect(x + 2 - 512, y + 2, w - 3, Math.min(h, 512 - y) - 3);
          }
          x += w;
        }
        y += h;
      }
    },
    23,
  );
}

/** Rock strata for the bluff: banded sandstone and mudstone, cracked. 1 tile = 16 m. */
function rockMap(): THREE.Texture {
  return canvasTexture(
    512,
    (c, rnd) => {
      const T = (Math.PI * 2) / 512;
      for (let y = 0; y < 512; y++) {
        // Periodic strata: a few thin beds, a couple of thick ones
        const band = 0.5 * Math.sin(y * T * 23 + 0.4) + 0.35 * Math.sin(y * T * 7 + 1.3) + 0.25 * Math.sin(y * T * 61);
        const v = 205 + band * 14;
        c.fillStyle = `rgb(${v | 0},${(v * 0.93) | 0},${(v * 0.84) | 0})`;
        c.fillRect(0, y, 512, 1);
      }
      // Weathering: big soft stains, then grit
      for (let i = 0; i < 220; i++) {
        const x = rnd() * 512;
        const y = rnd() * 512;
        const r = 12 + rnd() * 70;
        const dark = rnd() < 0.6;
        for (const ox of [-512, 0, 512])
          for (const oy of [-512, 0, 512]) {
            const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
            g.addColorStop(0, dark ? `rgba(60,48,36,${0.06 + rnd() * 0.08})` : `rgba(255,248,232,${0.05 + rnd() * 0.06})`);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            c.fillStyle = g;
            c.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
          }
      }
      for (let i = 0; i < 2600; i++) {
        c.fillStyle = `rgba(${rnd() < 0.6 ? '70,55,40' : '255,240,215'},${rnd() * 0.14})`;
        c.fillRect(rnd() * 512, rnd() * 512, 2 + rnd() * 18, 1 + rnd() * 2);
      }
    },
    37,
  );
}

/** Rippled water: a tileable normal map from summed waves. */
function waterNormals(): THREE.Texture {
  const size = 256;
  const h = new Float32Array(size * size);
  const rnd = seeded(5);
  const waves = Array.from({ length: 14 }, () => ({
    kx: Math.round((rnd() - 0.5) * 14),
    ky: Math.round((rnd() - 0.5) * 14),
    p: rnd() * Math.PI * 2,
    a: 0.3 + rnd(),
  }));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += (w.a * Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.p)) / Math.hypot(w.kx, w.ky, 1);
      h[y * size + x] = v;
    }
  return canvasTexture(
    size,
    (c) => {
      const img = c.createImageData(size, size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x + size - 1) % size)];
          const dy = h[((y + 1) % size) * size + x] - h[((y + size - 1) % size) * size + x];
          const n = new THREE.Vector3(-dx * 2.5, -dy * 2.5, 1).normalize();
          const i = (y * size + x) * 4;
          img.data[i] = (n.x * 0.5 + 0.5) * 255;
          img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
          img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
          img.data[i + 3] = 255;
        }
      c.putImageData(img, 0, 0);
    },
    0,
    false,
  );
}

/** Vertex glow → emissive (interior light, lamps, soffit downlights). */
function withGlow<T extends THREE.MeshStandardMaterial>(m: T, indoors = false): T {
  m.onBeforeCompile = (shader) => {
    if (indoors) {
      // Indoors: no sun through the roof, little sky — lit by its own lamps
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.directDiffuse *= 0.0;
        reflectedLight.directSpecular *= 0.0;
        reflectedLight.indirectDiffuse *= 0.3;
        reflectedLight.indirectSpecular *= 0.3;`,
      );
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow;');
  };
  m.customProgramCacheKey = () => (indoors ? 'house-glow-indoors' : 'house-glow');
  return m;
}

export interface HouseMaterials {
  concrete: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  rock: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  lit: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  water: THREE.MeshPhysicalMaterial;
}

export function houseMaterials(): HouseMaterials {
  const concrete = new THREE.MeshStandardMaterial({ map: concreteMap(), vertexColors: true, roughness: 0.62, metalness: 0 });
  const stone = new THREE.MeshStandardMaterial({ map: stoneMap(), vertexColors: true, roughness: 0.92, metalness: 0 });
  const rock = new THREE.MeshStandardMaterial({ map: rockMap(), vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
  const metal = withGlow(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.7 }));
  const lit = withGlow(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide }), true);
  const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  foliage.envMapIntensity = 0.6;

  // Glass: reflection added on top, the lit room behind seen through it.
  // Blended (1, 1 − α) so the sky's reflection isn't dimmed by the opacity.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x061014,
    roughness: 0.03,
    metalness: 0,
    envMapIntensity: 0.75,
    specularIntensity: 1,
    ior: 1.52,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const nm = waterNormals();
  nm.repeat.set(0.18, 0.18);
  const water = new THREE.MeshPhysicalMaterial({
    color: 0x1a8ea0,
    roughness: 0.04,
    metalness: 0,
    normalMap: nm,
    normalScale: new THREE.Vector2(0.35, 0.35),
    emissive: new THREE.Color(0.02, 0.24, 0.3),
    emissiveIntensity: 1,
    envMapIntensity: 1.3,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  return { concrete, stone, rock, metal, glass, lit, foliage, water };
}
