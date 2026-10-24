import * as THREE from 'three';
import { HOME_HEIGHT, type Heightfield } from './heightfield';
import { toLocal, toWorld } from './houseCliff';
import type { P2 } from './houseKit';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NOISE_GLSL } from './noiseGlsl';

/**
 * The drive from the entry court up into the hills.
 *
 * The road is cut into the hillside rather than draped over it: a graded
 * profile (the ground along the line, smoothed to an even climb) is pressed
 * into the heightfield as a level bed eight metres either side of the
 * centreline, blending back into the slope by twenty, so the terrain, the
 * flight model and the road all agree on where the ground is. On the bed:
 * crowned asphalt with worn wheel paths, oil down the lanes, patches and
 * sealed cracks; a gutter of granite setts each side; a rounded precast
 * curb. The surface detail is procedural in one small shader, the whole
 * road one draw.
 */

/** The drive's line (house frame), from the court up into the hills. */
export const DRIVE: P2[] = [[64, -38], [69, -60], [84, -92], [102, -130], [108, -175], [98, -225], [92, -280], [100, -330]];
/** The entry court (house frame) and its paving's radius (m). */
export const COURT = new THREE.Vector2(64, -26);
export const COURT_R = 14;
/** The forecourt is levelled out to here across the walk (m), and from the court up under the deck. */
const FORE_HALF = 9;
const FORE_Z1 = 0;
/** Half-widths (m): asphalt, the sett gutter, the curb's back. */
const ASPHALT = 3.6;
const GUTTER = 4.2;
export const CURB = 4.6;
/** The bed is level out to FLAT either side and back on the hillside by FALLOFF (m). */
const FLAT = 8;
const FALLOFF = 20;
/** Bed texel (m), and centreline sample spacing (m). */
const TEXEL = 0.5;
const STEP = 1;
/** The road surface sits this far above its bed (m). */
const LIFT = 0.05;

/** The graded centreline: frame xz every STEP m, unit tangents, bed height (frame y). */
export interface DrivePath {
  pts: THREE.Vector2[];
  tan: THREE.Vector2[];
  y: number[];
}

/** Grades the drive's bed into the ground (call before anything samples it). */
export function gradeDrive(field: Heightfield): DrivePath {
  const curve = new THREE.CatmullRomCurve3(DRIVE.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const n = Math.ceil(curve.getLength() / STEP);
  const pts = curve.getSpacedPoints(n).map((p) => new THREE.Vector2(p.x, p.z));
  const tan = pts.map((_, i) => pts[Math.min(n, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());

  // The ground along the line (averaged across the width), smoothed to an even grade
  const w = new THREE.Vector2();
  let y = pts.map((p, i) => {
    let h = 0;
    for (const a of [-3, 0, 3]) {
      toWorld(p.x - tan[i].y * a, p.y + tan[i].x * a, w);
      h += field.heightAt(w.x, w.y) - HOME_HEIGHT;
    }
    return h / 3;
  });
  for (let pass = 0; pass < 4; pass++) {
    const r = 9;
    y = y.map((_, i) => {
      let s = 0;
      for (let k = -r; k <= r; k++) s += y[Math.min(n, Math.max(0, i + k))];
      return s / (2 * r + 1);
    });
  }
  // Level with the court where it leaves it
  y = y.map((h, i) => h * THREE.MathUtils.smoothstep(i * STEP, 0, 30));

  // The bed: weight, weight × height, distance across — rasterised segment by segment
  const world = pts.map((p) => toWorld(p.x, p.y));
  const reach = FALLOFF + 3;
  // The forecourt's corners, so the box takes in its falloff too
  const fore = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => toWorld(COURT.x + a * (COURT_R + 4), b > 0 ? FORE_Z1 + 4 : COURT.y - COURT_R - 4));
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of [...world, ...fore]) {
    x0 = Math.min(x0, p.x - reach);
    z0 = Math.min(z0, p.y - reach);
    x1 = Math.max(x1, p.x + reach);
    z1 = Math.max(z1, p.y + reach);
  }
  const nx = Math.ceil((x1 - x0) / TEXEL);
  const nz = Math.ceil((z1 - z0) / TEXEL);
  const dist = new Float32Array(nx * nz).fill(99);
  const bed = new Float32Array(nx * nz);
  for (let i = 0; i < n; i++) {
    const a = world[i];
    const b = world[i + 1];
    const ex = b.x - a.x;
    const ez = b.y - a.y;
    const len2 = ex * ex + ez * ez;
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - x0) / TEXEL));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + reach - x0) / TEXEL));
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach - z0) / TEXEL));
    const j1 = Math.min(nz - 1, Math.ceil((Math.max(a.y, b.y) + reach - z0) / TEXEL));
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * TEXEL;
      for (let k = i0; k <= i1; k++) {
        const px = x0 + (k + 0.5) * TEXEL;
        const t = Math.min(1, Math.max(0, ((px - a.x) * ex + (pz - a.y) * ez) / len2));
        const d = Math.hypot(px - a.x - t * ex, pz - a.y - t * ez);
        const at = j * nx + k;
        if (d < dist[at]) {
          dist[at] = d;
          bed[at] = HOME_HEIGHT + y[i] + (y[i + 1] - y[i]) * t;
        }
      }
    }
  }
  const smoother = (s: number) => 1 - s * s * s * (s * (s * 6 - 15) + 10);
  const data = new Float32Array(nx * nz * 4);
  const l = new THREE.Vector2();
  for (let i = 0; i < nx * nz; i++) {
    let k = smoother(THREE.MathUtils.clamp((dist[i] - FLAT) / (FALLOFF - FLAT), 0, 1));
    let h = bed[i];
    // The forecourt: the court and the strip from it to the front door, set
    // just under the paving so no hump of hillside shows through it
    toLocal(x0 + ((i % nx) + 0.5) * TEXEL, z0 + (Math.floor(i / nx) + 0.5) * TEXEL, l);
    const out = Math.min(
      l.distanceTo(COURT) - COURT_R - 1,
      Math.max(Math.abs(l.x - COURT.x) - FORE_HALF, COURT.y - l.y, l.y - FORE_Z1),
    );
    const kc = smoother(THREE.MathUtils.clamp(out / 10, 0, 1));
    if (kc > k) {
      h = HOME_HEIGHT - 0.08;
      k = kc;
    }
    data[i * 4] = k;
    data[i * 4 + 1] = k * h;
    data[i * 4 + 2] = dist[i];
  }
  const texture = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = texture.minFilter = field.heightTex.magFilter === THREE.LinearFilter ? THREE.LinearFilter : THREE.NearestFilter;
  texture.needsUpdate = true;
  field.grade({ x0, z0, nx, nz, texel: TEXEL, data, texture });
  return { pts, tan, y };
}

/**
 * The cross-section, right half from the crown out: across (m), height over
 * the bed (m), band (0 asphalt, 1 setts, 2 curb). A repeated point starts a
 * new band: the zero-width quad between keeps the edge hard.
 */
const SECTION: [number, number, number][] = (() => {
  const s: [number, number, number][] = [];
  for (const a of [0, 0.9, 1.8, 2.6, 3.2, ASPHALT]) s.push([a, 0.05 * (1 - (a / ASPHALT) ** 2), 0]);
  for (let i = 0; i <= 4; i++) s.push([ASPHALT + ((GUTTER - ASPHALT) * i) / 4, -0.03 * Math.sin((Math.PI * i) / 4), 1]);
  s.push([GUTTER, 0, 2], [GUTTER, 0.12, 2], [GUTTER + 0.025, 0.148, 2], [GUTTER + 0.07, 0.16, 2], [CURB - 0.08, 0.16, 2], [CURB - 0.03, 0.15, 2], [CURB - 0.01, 0.12, 2], [CURB + 0.02, -0.25, 2]);
  return s;
})();

/**
 * The entry court's paving, a disc from r0 to r1 round `centre` at height y
 * (house frame): concentric courses of limestone with three granite bands
 * and a granite kerb, falling gently to the rim to drain.
 */
export function courtGeometry(centre: THREE.Vector2, r0: number, r1: number, y: number): THREE.BufferGeometry {
  const rings: number[] = [];
  for (let r = r0; r < r1; r += 0.45) rings.push(r);
  rings.push(r1);
  const seg = 128;
  const pos: number[] = [];
  const road: number[] = [];
  for (const r of rings) {
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const h = 0.025 * (1 - (r - r0) / (r1 - r0));
      pos.push(centre.x + Math.cos(a) * r, y + h, centre.y + Math.sin(a) * r);
      road.push(r, a, 3, h);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a = i * (seg + 1) + k;
      const d = a + seg + 1;
      idx.push(a, d, a + 1, a + 1, d, d + 1);
    }
  }
  return pavingGeometry(pos, road, idx);
}

/** A walk of large limestone slabs over a plan quad: corners in order, `across` (m) and `along` (m) spans. */
export function walkGeometry(corners: THREE.Vector2[], across: [number, number], along: [number, number], y: number): THREE.BufferGeometry {
  const [a, b, c, d] = corners;
  const pos: number[] = [];
  const road: number[] = [];
  const n = 12;
  for (let j = 0; j <= n; j++) {
    const t = j / n;
    for (const [u, p, q] of [[0, a, d], [1, b, c]] as const) {
      const v = p.clone().lerp(q, t);
      pos.push(v.x, y, v.y);
      road.push(across[0] + (across[1] - across[0]) * u, along[0] + (along[1] - along[0]) * t, 4, 0);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) idx.push(j * 2, j * 2 + 2, j * 2 + 1, j * 2 + 1, j * 2 + 2, j * 2 + 3);
  return pavingGeometry(pos, road, idx);
}

/** A garden path of the same slabs along a plan curve, laid on the ground. */
export function pathGeometry(pts: P2[], width: number, ground: (x: number, z: number) => number, lift: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const len = curve.getLength();
  const n = Math.ceil(len);
  const pos: number[] = [];
  const road: number[] = [];
  const idx: number[] = [];
  const across = [-width / 2, 0, width / 2];
  for (let j = 0; j <= n; j++) {
    const p = curve.getPointAt(j / n);
    const t = curve.getTangentAt(j / n);
    for (const a of across) {
      const x = p.x - t.z * a;
      const z = p.z + t.x * a;
      pos.push(x, ground(x, z) + lift, z);
      road.push(a, (j / n) * len, 4, 0);
    }
    if (j < n) for (let c = 0; c < 2; c++) idx.push(j * 3 + c, j * 3 + c + 3, j * 3 + c + 1, j * 3 + c + 1, j * 3 + c + 3, j * 3 + c + 4);
  }
  return pavingGeometry(pos, road, idx);
}

function pavingGeometry(pos: number[], road: number[], idx: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 4));
  geo.setIndex(idx);
  faceUp(geo);
  return geo;
}

/** Winds every triangle of a near-flat sheet to face up, with smooth normals. */
function faceUp(geo: THREE.BufferGeometry): void {
  const idx = geo.getIndex()!.array as Uint16Array | Uint32Array;
  const pos = geo.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let k = 0; k < idx.length; k += 3) {
    a.fromBufferAttribute(pos, idx[k]);
    b.fromBufferAttribute(pos, idx[k + 1]).sub(a);
    c.fromBufferAttribute(pos, idx[k + 2]).sub(a);
    // Zero-width quads (the hard band edges) have no say
    const ny = b.z * c.x - b.x * c.z;
    if (ny < 0) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
  }
  geo.computeVertexNormals();
}

/**
 * The road on its bed, in the house frame (y up from the terrace), with
 * the court's and the walk's paving (`paving`) in the same draw. Rows that
 * start inside the entry court are trimmed to its rim.
 */
export function buildDrive(path: DrivePath, uniforms: Record<string, THREE.IUniform>, court: THREE.Vector2, courtR: number, paving: THREE.BufferGeometry[] = []): THREE.Mesh {
  const cols = [...SECTION.slice(1).reverse().map(([a, h, b]) => [-a, h, b] as [number, number, number]), ...SECTION];
  const C = cols.length;
  const first = path.pts.findIndex((p) => p.distanceTo(court) > courtR - 1.2);
  const rows = path.pts.length - first;
  const pos = new Float32Array(rows * C * 3);
  const road = new Float32Array(rows * C * 4);
  const v = new THREE.Vector2();
  for (let r = 0; r < rows; r++) {
    const i = first + r;
    const p = path.pts[i];
    const t = path.tan[i];
    for (let c = 0; c < C; c++) {
      const [a, h, band] = cols[c];
      v.set(p.x - t.y * a, p.y + t.x * a);
      // Inside the court: slide on along the road to its rim
      const off = v.clone().sub(court);
      if (off.length() < courtR) {
        const b = off.dot(t);
        v.addScaledVector(t, -b + Math.sqrt(b * b - off.lengthSq() + courtR * courtR));
      }
      pos.set([v.x, path.y[i] + LIFT + h, v.y], (r * C + c) * 3);
      road.set([a, i * STEP, band, h], (r * C + c) * 4);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < C - 1; c++) {
      const a = r * C + c;
      const b = a + 1;
      const d = a + C;
      const e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  // Wind every quad to face up (the line's handedness decides it)
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRoad', new THREE.BufferAttribute(road, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if ((geo.getAttribute('normal') as THREE.BufferAttribute).getY(C >> 1) < 0) {
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  if (paving.length) geo = mergeGeometries([geo, ...paving])!;
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBake = uniforms.uBake;
    shader.uniforms.uWorld = uniforms.uWorld;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRoad;\nvarying vec4 vRoad;\nvarying vec3 vRoadWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_PARS}`)
      .replace('#include <map_fragment>', ROAD_SURFACE)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(rRough, 0.3, 1.0);')
      .replace('#include <normal_fragment_maps>', ROAD_BUMP)
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        // The terrain's baked low-sun shadow and sky occlusion, so the road
        // darkens with the hillside it runs through
        reflectedLight.directDiffuse *= rSun;
        reflectedLight.directSpecular *= rSun;
        reflectedLight.indirectDiffuse *= rAo;
        reflectedLight.indirectSpecular *= rAo;`,
      );
  };
  mat.customProgramCacheKey = () => 'drive';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'drive';
  mesh.receiveShadow = true;
  return mesh;
}

const ROAD_PARS = /* glsl */ `
varying vec4 vRoad; // across, along (m), band, height over the bed (court: radius, angle)
varying vec3 vRoadWorld;
uniform sampler2D uBake;
uniform float uWorld;
${NOISE_GLSL}
float rRough = 0.85;
float rBump = 0.0;
float rSun = 1.0;
float rAo = 1.0;
float rHash(vec2 p) { return hash12(p) * 0.5 + 0.5; }
float rNoise(vec2 p) { return vnoise(p) * 0.5 + 0.5; }
// Antialiased line coverage, d m from a line w m wide: fades to its
// footprint once thinner than a pixel, instead of a constant-width stroke
float rLine(float d, float w) {
  float px = fwidth(d) + 1e-5;
  return (1.0 - smoothstep(w * 0.5, w * 0.5 + px, d)) * min(1.0, w / px);
}
// Antialiased 0–1 box over [lo, hi]
float rBox(vec2 f, vec2 lo, vec2 hi) {
  vec2 w = fwidth(f) + 1e-4;
  vec2 k = smoothstep(lo - w, lo + w, f) * smoothstep(hi + w, hi - w, f);
  return k.x * k.y;
}
`;

const ROAD_SURFACE = /* glsl */ `
{
  float a = vRoad.x;
  float s = vRoad.y;
  float band = vRoad.z;
  float aa = abs(a);
  vec2 p = vec2(a, s);
  // Close-up detail fades out with distance (and with it, the shimmer)
  float near = 1.0 - smoothstep(35.0, 220.0, length(vRoadWorld - cameraPosition));
  float m1 = rNoise(p * vec2(0.35, 0.12) + 4.1);
  float m2 = rNoise(p * 1.7 + 9.3);
  float m3 = mix(0.5, rNoise(p * 9.0 + 1.7), near);
  vec3 col;
  if (band < 0.5) {
    // Asphalt: warm dark grey, mottled, the aggregate showing close up
    col = vec3(0.165, 0.158, 0.148) * (0.84 + 0.28 * m1 + 0.12 * (m2 - 0.5) + 0.2 * (m3 - 0.5));
    // Two lanes; each wheel path polished paler, oil dripped down the middle
    float lane = aa - 1.8;
    float wheel = smoothstep(0.5, 0.2, abs(abs(lane) - 0.85)) * (0.7 + 0.3 * m2);
    col *= 1.0 + 0.18 * wheel;
    rRough = 0.9 - 0.14 * wheel;
    float oil = smoothstep(0.4, 0.05, abs(lane)) * smoothstep(0.45, 0.75, rNoise(p * vec2(1.6, 0.25) + 2.2));
    col *= 1.0 - 0.3 * oil;
    rRough -= 0.2 * oil;
    // Patches: here and there a lane cut out and relaid, darker and newer
    vec2 cell = vec2(floor(a / ASPHALT_W), floor(s / 11.0));
    if (rHash(cell + 3.1) > 0.8) {
      vec2 f = vec2(a / ASPHALT_W, s / 11.0) - cell;
      vec2 lo = vec2(0.12 + 0.2 * rHash(cell + 1.3), 0.08 + 0.3 * rHash(cell + 2.7));
      float relaid = rBox(f, lo, lo + vec2(0.5 + 0.2 * rHash(cell + 5.1), 0.3 + 0.3 * rHash(cell + 7.9)));
      col = mix(col, vec3(0.128, 0.124, 0.118) * (0.92 + 0.16 * m3), relaid * 0.85);
      rRough = mix(rRough, 0.8, relaid);
    }
    // Sealed cracks: the construction joint up the crown, and transverse
    // cracks across a lane here and there, each a thin wandering line of tar
    float jc = abs(a + 0.05 * vnoise(vec2(s * 0.6, 1.3)));
    float tc = floor(s / 7.0);
    float tr = abs(fract(s / 7.0 + 0.04 * vnoise(vec2(a * 0.9, tc))) - 0.5) * 7.0;
    float trOn = step(0.55, rHash(vec2(tc, floor(a / ASPHALT_W) + 9.0))) * smoothstep(0.35, 0.5, rNoise(vec2(a * 0.7, tc * 3.1)));
    float crack = max(rLine(jc, 0.012), rLine(tr, 0.01) * trOn) * near;
    col = mix(col, vec3(0.04, 0.039, 0.037), crack);
    rRough = mix(rRough, 0.5, crack);
    // Dust blown onto the edges
    col = mix(col, vec3(0.36, 0.31, 0.24), smoothstep(2.8, ASPHALT_W, aa) * (0.25 + 0.25 * m2));
    rBump = (m3 - 0.5) * 0.004 + 0.002 * crack;
  } else if (band < 1.5) {
    // Granite setts in the gutter: two staggered courses
    float u = (aa - ASPHALT_W) / 0.3;
    float row = floor(u);
    float v = s / 0.22 + row * 0.5;
    vec2 id = vec2(row, floor(v));
    vec2 f = vec2(fract(u), fract(v));
    vec2 e = min(f, 1.0 - f) * vec2(0.3, 0.22);
    float edge = min(e.x, e.y);
    float joint = rLine(edge, 0.02);
    float hs = rHash(id);
    float hw = rHash(id + 7.7);
    col = mix(vec3(0.3, 0.29, 0.28), vec3(0.52, 0.48, 0.43), hs) * mix(vec3(1.0), vec3(1.06, 0.98, 0.9), hw) * (0.86 + 0.28 * m3);
    // Grit and dead leaves silted in along the joints
    col = mix(col, vec3(0.12, 0.1, 0.08), joint * mix(1.0, 0.6, near));
    rRough = 0.78 - 0.12 * hs;
    rBump = smoothstep(0.0, 0.03, edge) * (0.006 + 0.004 * hw) * near;
  } else if (band > 2.5) {
    // Court and walk: honed limestone, granite bands and kerb (court: across
    // = radius, along = angle)
    float graniteK = 0.0;
    vec2 id;
    vec2 f;
    vec2 size;
    if (band < 3.5) {
      float r = a;
      // Granite: three bands of small setts, and the kerb at the rim
      float gb = min(min(abs(r - 6.0), abs(r - 9.5)), abs(r - 12.5));
      float rim = 13.6;
      if (r > rim) {
        graniteK = 1.0;
        float n = floor(6.2832 * r / 0.9);
        float u = s / 6.2832 * n;
        id = vec2(floor(u), 50.0);
        f = vec2(fract(u), (r - rim) / (14.0 - rim));
        size = vec2(6.2832 * r / n, 14.0 - rim);
      } else if (gb < 0.2) {
        // Two courses of setts, staggered
        graniteK = 1.0;
        float c = abs(r - 6.0) < 0.2 ? 6.0 : abs(r - 9.5) < 0.2 ? 9.5 : 12.5;
        float rr = r - c + 0.2;
        float course = floor(rr / 0.2);
        float n = floor(6.2832 * r / 0.14);
        float u = s / 6.2832 * n + course * 0.5;
        id = vec2(floor(u), course + c * 10.0);
        f = vec2(fract(u), fract(rr / 0.2));
        size = vec2(6.2832 * r / n, 0.2);
      } else {
        // Limestone courses 0.9 m deep, each cut into ~1.4 m lengths, staggered
        float course = floor((r - 4.15) / 0.9);
        float rm = 4.15 + (course + 0.5) * 0.9;
        float n = floor(6.2832 * rm / 1.4);
        float u = s / 6.2832 * n + rHash(vec2(course, 1.0));
        id = vec2(floor(u), course);
        f = vec2(fract(u), fract((r - 4.15) / 0.9));
        size = vec2(6.2832 * rm / n, 0.9);
      }
    } else {
      // Walk: 0.8 × 1.6 m slabs, stack bonded across the walk
      vec2 q = vec2(a / 1.6, s / 0.8);
      id = floor(q);
      f = fract(q);
      size = vec2(1.6, 0.8);
    }
    vec2 e = min(f, 1.0 - f) * size;
    float edge = min(e.x, e.y);
    float joint = rLine(edge, graniteK > 0.5 ? 0.014 : 0.008);
    float hs = rHash(id + band);
    vec3 lime = mix(vec3(0.72, 0.69, 0.63), vec3(0.8, 0.77, 0.7), hs) * (0.9 + 0.14 * m1 + 0.1 * (m3 - 0.5));
    // Fossil fleck and a faint vein in the stone, close up
    lime *= 1.0 - 0.06 * near * smoothstep(0.62, 0.7, rNoise(p * 3.1 + id * 7.0));
    vec3 granite = mix(vec3(0.2, 0.2, 0.21), vec3(0.3, 0.29, 0.28), hs) * (0.85 + 0.3 * m3);
    col = mix(lime, granite, graniteK);
    col = mix(col, vec3(0.22, 0.2, 0.18), joint * 0.8);
    // Tyres have scuffed a darker ring round the drum
    col *= band < 3.5 ? 1.0 - 0.1 * smoothstep(1.4, 0.0, abs(a - 8.0)) * m2 : 1.0;
    rRough = mix(0.55, 0.7, graniteK) + 0.1 * m2;
    rBump = smoothstep(0.0, 0.02, edge) * 0.004 * near;
  } else {
    // Curb: pale precast concrete in 1.8 m units, grimed along its foot
    col = vec3(0.62, 0.6, 0.56) * (0.86 + 0.22 * m1 + 0.12 * (m3 - 0.5));
    float j = abs(fract(s / 1.8 + 0.5) - 0.5) * 1.8;
    float joint = rLine(j, 0.012);
    col = mix(col, vec3(0.16, 0.15, 0.14), joint * 0.85);
    col *= mix(0.55, 1.0, smoothstep(0.0, 0.11, vRoad.w));
    rRough = 0.72;
    rBump = -joint * 0.004 * near;
  }
  diffuseColor.rgb *= col;
  vec4 bk = texture2D(uBake, vRoadWorld.xz / uWorld + 0.5);
  rSun = bk.r;
  rAo = mix(0.55, 1.0, bk.g);
}
`.replace(/ASPHALT_W/g, ASPHALT.toFixed(2));

const ROAD_BUMP = /* glsl */ `
#include <normal_fragment_maps>
{
  // Bump from the procedural height (surface gradient, after Mikkelsen)
  vec3 sp = -vViewPosition;
  vec3 dx = dFdx(sp);
  vec3 dy = dFdy(sp);
  vec3 r1 = cross(dy, normal);
  vec3 r2 = cross(normal, dx);
  float det = dot(dx, r1);
  // Faded out once a pixel spans more than a couple of centimetres: the
  // joints are thinner than that, and their bump would only sparkle
  vec2 dh = vec2(dFdx(rBump), dFdy(rBump)) * smoothstep(0.035, 0.012, length(fwidth(vRoadWorld)));
  normal = normalize(abs(det) * normal - sign(det) * (dh.x * r1 + dh.y * r2));
}
`;
