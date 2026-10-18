import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { DETAIL_RES, DETAIL_SPAN, HEIGHT_RES, SUN_DIR, TEXEL, WORLD_SIZE } from './config';
import { NOISE_GLSL } from './noiseGlsl';

/**
 * The terrain as data. The large-scale relief is grown on the GPU (one
 * fragment per 16 m texel, fourteen octaves of eroded noise), read back once
 * so the flight model, the drones and every projectile collide with exactly
 * what is drawn, and then baked a second time for the low sun: soft cast
 * shadows (they run for kilometres at golden hour) and ambient occlusion.
 *
 * Close up, a small tileable detail texture adds a few metres of crag on
 * rock, sampled the same way on the CPU and the GPU.
 */

/** Coastline (world z of the shore at x), before the noise warp. */
export function coastZ(x: number): number {
  return 600 + 900 * Math.sin(x * 0.00023 + 0.3) + 380 * Math.sin(x * 0.00071 + 1.7) + 140 * Math.sin(x * 0.0019 + 0.2);
}

/** Where the house stands: on the bluff, 75 m back from the cliff edge. */
export const HOME = new THREE.Vector2(0, coastZ(0) - 75);
/** Height of the house terrace (m). */
export const HOME_HEIGHT = 54;

const COAST_GLSL = /* glsl */ `
float coastZ(float x) {
  return 600.0 + 900.0 * sin(x * 0.00023 + 0.3) + 380.0 * sin(x * 0.00071 + 1.7) + 140.0 * sin(x * 0.0019 + 0.2);
}
`;

const GEN_FRAG = /* glsl */ `
precision highp float;
uniform float uWorld;
uniform vec2 uHome;
uniform float uHomeH;
varying vec2 vUv;
${NOISE_GLSL}
${COAST_GLSL}

float island(vec2 p, vec2 c, float r, float peak, float seed) {
  vec2 q = (p - c) / r;
  float n = fbm(p / 650.0 + seed, 5);
  float k = 1.0 - smoothstep(0.0, 1.0, length(q) + 0.35 * n);
  float rid = erodedFbm(p / 900.0 + seed * 3.0, 10) * 0.5 + 0.6;
  return k * k * peak * rid - 30.0 * (1.0 - k);
}

void main() {
  vec2 p = (vUv - 0.5) * uWorld;
  float homeD = length(p - uHome);
  // The shore wanders (noise warp), except right round the house
  float warpK = smoothstep(400.0, 1800.0, homeD);
  vec2 w = vec2(fbm(p / 3800.0 + 3.1, 5), fbm(p / 3800.0 - 7.7, 5));
  vec2 q = p + w * 1100.0 * warpK;
  float d = coastZ(q.x) - q.y; // + inland (north is -z)

  // Shore character: sheer bluffs in places, long beaches between
  float cliffy = smoothstep(-0.12, 0.22, fbm(vec2(q.x / 4200.0, 1.7), 4));
  cliffy = mix(1.0, cliffy, smoothstep(300.0, 1200.0, homeD));
  float cliffH = mix(5.0, 62.0 + 46.0 * fbm(q / 900.0, 4), cliffy);
  // The house's bluff: a clean 50 m drop with nothing between it and the sea
  cliffH = mix(50.0, cliffH, smoothstep(250.0, 1100.0, homeD));
  float shoreW = mix(220.0, 38.0, cliffy);
  float land = smoothstep(-shoreW * 0.25, shoreW, d);

  // Foothills climb straight off the bluffs into the range behind: the
  // Santa Monica Mountains meet the sea within a few kilometres
  float hills = (fbm(q / 1300.0, 7) * 0.5 + 0.5) * 170.0 * smoothstep(40.0, 1400.0, d);
  float range = smoothstep(150.0, 5200.0, d) * (0.75 + 0.4 * fbm(vec2(q.x / 7000.0, 5.3), 3));
  float m = erodedFbm(q / 2600.0 + vec2(11.3, -4.1), 11);
  float sharp = ridged(q / 3400.0 + 2.9, 6);
  float mountains = max(0.0, m * 0.75 + 0.3 + sharp * 0.35) * 1250.0 * range;
  // Drainage: winding canyons cut down toward the sea
  float valley = pow(1.0 - abs(vnoise(q / 2600.0 + 4.7)), 7.0) * smoothstep(200.0, 2000.0, d);
  float relief = (hills + mountains) * (1.0 - 0.6 * valley);
  float hLand = cliffH + relief;

  // Shelf, then the deep: the sea floor drops away offshore
  float depth = 2.0 + 18.0 * smoothstep(0.0, 500.0, -d) + 110.0 * smoothstep(300.0, 5000.0, -d) + 8.0 * fbm(q / 700.0, 4);
  float h = mix(-depth, hLand, land);

  // A few sea stacks off the bluffs: weathered, flat-topped
  float sn = vnoise(p / 140.0 + 2.3);
  float stack = smoothstep(0.66, 0.78, sn) * (34.0 + 30.0 * vnoise(p / 37.0)) * cliffy;
  stack *= smoothstep(-420.0, -90.0, d) * (1.0 - smoothstep(-90.0, -25.0, d));
  if (stack > 0.5) h = max(h, stack - 5.0);

  // Islands offshore
  h = max(h, island(p, vec2(-6200.0, 9800.0), 2600.0, 560.0, 1.3));
  h = max(h, island(p, vec2(7800.0, 7200.0), 1100.0, 210.0, 7.1));
  h = max(h, island(p, vec2(2200.0, 4300.0), 420.0, 75.0, 3.7));

  // The house terrace: levelled, blending back into the bluff — only a short
  // way on the sea side, so the bluff drops away right below the house
  vec2 hr = p - uHome;
  vec2 cn = normalize(vec2(-0.5 * (coastZ(uHome.x + 1.0) - coastZ(uHome.x - 1.0)), 1.0));
  float across = dot(hr, cn);
  float pad = 1.0 - smoothstep(55.0, 180.0, length(vec2(dot(hr, vec2(cn.y, -cn.x)), across * (across > 0.0 ? 3.2 : 1.0))));
  h = mix(h, uHomeH, pad * pad * (3.0 - 2.0 * pad));

  // Past the edge of the map everything slips under the sea
  vec2 e = abs(vUv - 0.5) * 2.0;
  float edge = smoothstep(1.0, 0.84, max(e.x, e.y));
  h = mix(-140.0, h, edge);

  gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
}
`;

const BAKE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uHeight;
uniform float uWorld;
uniform vec3 uSun;
varying vec2 vUv;
float H(vec2 uv) { return texture2D(uHeight, uv).r; }
void main() {
  float h0 = max(H(vUv), 0.0);
  vec2 sd = normalize(uSun.xz);
  float tanE = uSun.y / length(uSun.xz);
  // Soft cast shadow: march toward the sun, geometric steps 16 m → 12 km
  float vis = 1.0;
  float t = 14.0;
  for (int i = 0; i < 46; i++) {
    vec2 uv = vUv + sd * t / uWorld;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float ray = h0 + t * tanE + 1.5;
    float hs = H(uv);
    vis = min(vis, clamp(6.0 * (ray - hs) / t + 0.5, 0.0, 1.0));
    if (vis <= 0.0) break;
    t *= 1.155;
  }
  // Ambient occlusion: how much sky the horizon hides, 8 azimuths × 4 radii
  float occ = 0.0;
  for (int a = 0; a < 6; a++) {
    float ang = float(a) * 1.0472 + 0.3;
    vec2 dir = vec2(cos(ang), sin(ang));
    float hor = 0.0;
    for (int r = 0; r < 3; r++) {
      float rad = 26.0 * pow(3.4, float(r));
      float dh = max(H(vUv + dir * rad / uWorld), 0.0) - h0;
      hor = max(hor, dh / sqrt(dh * dh + rad * rad));
    }
    occ += hor;
  }
  float ao = clamp(1.0 - occ / 6.0 * 1.25, 0.0, 1.0);
  gl_FragColor = vec4(vis, ao, 0.0, 1.0);
}
`;

/** Base-relief normals, one per texel (filtered bilinear in the terrain shader). */
const NORMAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uHeight;
uniform float uTexel;
uniform float uRes;
varying vec2 vUv;
void main() {
  float e = 1.0 / uRes;
  float hl = texture2D(uHeight, vUv - vec2(e, 0.0)).r;
  float hr = texture2D(uHeight, vUv + vec2(e, 0.0)).r;
  float hd = texture2D(uHeight, vUv - vec2(0.0, e)).r;
  float hu = texture2D(uHeight, vUv + vec2(0.0, e)).r;
  vec3 n = normalize(vec3(hl - hr, 2.0 * uTexel, hd - hu));
  gl_FragColor = vec4(n, 1.0);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Detail crag amplitude (m) for a base height: none on beaches and below. */
export function detailAmp(base: number): number {
  const k = Math.min(1, Math.max(0, (base - 4) / (45 - 4)));
  return 2.6 * k * k * (3 - 2 * k);
}

/** GLSL twin of {@link detailAmp} plus the full height function. */
export const TERRAIN_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uDetail;
uniform sampler2D uBake;
uniform sampler2D uNormal;
uniform sampler2D uDetailGrad;
uniform float uWorld;
uniform float uDetailSpan;
uniform float uHeightRes;
// Cubic B-spline through the 16 m heightfield (four bilinear taps): smooth
// slopes and cliff lines with no texel-grid facets or zig-zags
float terrainBase(vec2 xz) {
  vec2 tex = (xz / uWorld + 0.5) * uHeightRes - 0.5;
  vec2 i = floor(tex);
  vec2 f = tex - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / uHeightRes;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) / uHeightRes;
  float a = texture2D(uHeight, vec2(h0.x, h0.y)).r;
  float b = texture2D(uHeight, vec2(h1.x, h0.y)).r;
  float c = texture2D(uHeight, vec2(h0.x, h1.y)).r;
  float d = texture2D(uHeight, vec2(h1.x, h1.y)).r;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}
uniform vec2 uHome;
float detailAmp(float base) { return 2.6 * smoothstep(4.0, 45.0, base); }
float terrainDetail(vec2 xz) {
  return texture2D(uDetail, xz / uDetailSpan).r + 0.45 * texture2D(uDetail, xz / (uDetailSpan * 0.37) + 0.31).r;
}
float terrainGraded(vec2 xz) { return smoothstep(45.0, 140.0, length(xz - uHome)); }
float terrainHeight(vec2 xz) {
  float b = terrainBase(xz);
  // The house terrace is graded smooth
  return b + terrainDetail(xz) * detailAmp(b) * terrainGraded(xz);
}
// Surface normal from the baked base normals and the detail gradients:
// three texture reads instead of two dozen
vec3 terrainNormal(vec2 xz, float h, out float slopeDetail) {
  vec3 nb = texture2D(uNormal, xz / uWorld + 0.5).xyz;
  vec2 g = -nb.xz / max(nb.y, 0.05);
  vec2 gd = texture2D(uDetailGrad, xz / uDetailSpan).rg + (0.45 / 0.37) * texture2D(uDetailGrad, xz / (uDetailSpan * 0.37) + 0.31).rg;
  slopeDetail = length(gd);
  g += gd * detailAmp(h) * terrainGraded(xz);
  return normalize(vec3(-g.x, 1.0, -g.y));
}
`;

/** Periodic fractal value noise, values roughly −1…1. */
function buildDetail(n: number): Float32Array {
  const out = new Float32Array(n * n);
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  let amp = 1;
  let total = 0;
  // Octaves: lattice sizes 4, 8, 16, 32, 64 cells across the tile
  for (const cells of [4, 8, 16, 32, 64]) {
    const g = new Float32Array(cells * cells).map(() => rand());
    const step = n / cells;
    for (let y = 0; y < n; y++) {
      const fy = y / step;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      for (let x = 0; x < n; x++) {
        const fx = x / step;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const a = g[(y0 % cells) * cells + (x0 % cells)];
        const b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
        const c = g[((y0 + 1) % cells) * cells + (x0 % cells)];
        const d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
        out[y * n + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
      }
    }
    total += amp;
    amp *= 0.55;
  }
  // Ridge it a little: crags read sharper than soft lumps
  for (let i = 0; i < out.length; i++) {
    const v = out[i] / total;
    out[i] = (1 - Math.abs(v)) * 1.6 - 0.9 + v * 0.4;
  }
  return out;
}

/** Cubic B-spline weights for a fractional position. */
function bspline(f: number): [number, number, number, number] {
  const f2 = f * f;
  const f3 = f2 * f;
  return [(1 - 3 * f + 3 * f2 - f3) / 6, (4 - 6 * f2 + 3 * f3) / 6, (1 + 3 * f + 3 * f2 - 3 * f3) / 6, f3 / 6];
}

/** Bilinear lookup that matches a LinearFilter texture (texel centres at i + ½). */
function bilinear(data: Float32Array, n: number, u: number, v: number, wrap: boolean): number {
  let x = u * n - 0.5;
  let y = v * n - 0.5;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  if (wrap) {
    x0 = ((x0 % n) + n) % n;
    x1 = ((x1 % n) + n) % n;
    y0 = ((y0 % n) + n) % n;
    y1 = ((y1 % n) + n) % n;
  } else {
    x0 = Math.min(n - 1, Math.max(0, x0));
    x1 = Math.min(n - 1, Math.max(0, x1));
    y0 = Math.min(n - 1, Math.max(0, y0));
    y1 = Math.min(n - 1, Math.max(0, y1));
    x = 0;
    y = 0;
  }
  const a = data[y0 * n + x0];
  const b = data[y0 * n + x1];
  const c = data[y1 * n + x0];
  const d = data[y1 * n + x1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

export class Heightfield {
  readonly heightTex: THREE.Texture;
  readonly bakeTex: THREE.Texture;
  readonly detailTex: THREE.DataTexture;
  readonly normalTex: THREE.Texture;
  readonly detailGradTex: THREE.DataTexture;
  /** Uniforms every terrain-sampling shader shares (same objects). */
  readonly uniforms: Record<string, THREE.IUniform>;

  /** Raw texels (row-major, z rows), for bounds. */
  get texels(): Float32Array {
    return this.data;
  }

  private constructor(
    private readonly data: Float32Array,
    private readonly detail: Float32Array,
    private readonly bake: Uint8Array,
    heightTex: THREE.Texture,
    bakeTex: THREE.Texture,
    detailTex: THREE.DataTexture,
    normalTex: THREE.Texture,
    detailGradTex: THREE.DataTexture,
  ) {
    this.normalTex = normalTex;
    this.detailGradTex = detailGradTex;
    this.heightTex = heightTex;
    this.bakeTex = bakeTex;
    this.detailTex = detailTex;
    this.uniforms = {
      uHeight: { value: heightTex },
      uDetail: { value: detailTex },
      uBake: { value: bakeTex },
      uNormal: { value: normalTex },
      uDetailGrad: { value: detailGradTex },
      uWorld: { value: WORLD_SIZE },
      uDetailSpan: { value: DETAIL_SPAN },
      uHome: { value: HOME },
      uHeightRes: { value: HEIGHT_RES },
    };
  }

  static generate(renderer: THREE.WebGLRenderer): Heightfield {
    const n = HEIGHT_RES;
    const linearFloat = renderer.extensions.has('OES_texture_float_linear');
    const filter = linearFloat ? THREE.LinearFilter : THREE.NearestFilter;
    const rt = new THREE.WebGLRenderTarget(n, n, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      depthBuffer: false,
      generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    const gen = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: GEN_FRAG,
        uniforms: {
          uWorld: { value: WORLD_SIZE },
          uHome: { value: HOME },
          uHomeH: { value: HOME_HEIGHT },
        },
      }),
    );
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    gen.render(renderer);

    const rgba = new Float32Array(n * n * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, n, n, rgba);
    const data = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) data[i] = rgba[i * 4];

    const bakeRt = new THREE.WebGLRenderTarget(n, n, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const bakeQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: BAKE_FRAG,
        uniforms: {
          uHeight: { value: rt.texture },
          uWorld: { value: WORLD_SIZE },
          uSun: { value: SUN_DIR },
        },
      }),
    );
    renderer.setRenderTarget(bakeRt);
    bakeQuad.render(renderer);
    const bake = new Uint8Array(n * n * 4);
    renderer.readRenderTargetPixels(bakeRt, 0, 0, n, n, bake);
    const normalRt = new THREE.WebGLRenderTarget(n, n, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: true,
    });
    const normalQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: NORMAL_FRAG,
        uniforms: { uHeight: { value: rt.texture }, uTexel: { value: TEXEL }, uRes: { value: n } },
      }),
    );
    renderer.setRenderTarget(normalRt);
    normalQuad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    gen.dispose();
    bakeQuad.dispose();
    normalQuad.dispose();

    const detail = buildDetail(DETAIL_RES);
    const detailTex = new THREE.DataTexture(detail, DETAIL_RES, DETAIL_RES, THREE.RedFormat, THREE.FloatType);
    detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
    // Mipmapped: ripples and grain far away average out instead of sparkling
    // (vertex reads stay on the base level, matching the CPU)
    detailTex.magFilter = filter;
    detailTex.minFilter = linearFloat ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
    detailTex.generateMipmaps = linearFloat;
    detailTex.needsUpdate = true;

    // Detail gradient (per metre at the base span), for the normals
    const D = DETAIL_RES;
    const grad = new Float32Array(D * D * 2);
    const k = D / DETAIL_SPAN / 2;
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < D; x++) {
        const at = (i: number, j: number) => detail[((j + D) % D) * D + ((i + D) % D)];
        grad[(y * D + x) * 2] = (at(x + 1, y) - at(x - 1, y)) * k;
        grad[(y * D + x) * 2 + 1] = (at(x, y + 1) - at(x, y - 1)) * k;
      }
    }
    const gradTex = new THREE.DataTexture(grad, D, D, THREE.RGFormat, THREE.FloatType);
    gradTex.wrapS = gradTex.wrapT = THREE.RepeatWrapping;
    gradTex.magFilter = filter;
    gradTex.minFilter = linearFloat ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
    gradTex.generateMipmaps = linearFloat;
    gradTex.needsUpdate = true;

    return new Heightfield(data, detail, bake, rt.texture, bakeRt.texture, detailTex, normalRt.texture, gradTex);
  }

  /** Large-scale relief (m): the same cubic B-spline the GPU evaluates. */
  baseAt(x: number, z: number): number {
    const n = HEIGHT_RES;
    const tx = (x / WORLD_SIZE + 0.5) * n - 0.5;
    const ty = (z / WORLD_SIZE + 0.5) * n - 0.5;
    const ix = Math.floor(tx);
    const iy = Math.floor(ty);
    const wx = bspline(tx - ix);
    const wy = bspline(ty - iy);
    let h = 0;
    for (let j = 0; j < 4; j++) {
      const row = Math.min(n - 1, Math.max(0, iy + j - 1)) * n;
      let r = 0;
      for (let i = 0; i < 4; i++) r += wx[i] * this.data[row + Math.min(n - 1, Math.max(0, ix + i - 1))];
      h += wy[j] * r;
    }
    return h;
  }

  /** Ground height (m) at a world point, including the close-up crags. */
  heightAt(x: number, z: number): number {
    const b = this.baseAt(x, z);
    const hd = Math.hypot(x - HOME.x, z - HOME.y);
    const graded = hd >= 140 ? 1 : hd <= 45 ? 0 : ((t) => t * t * (3 - 2 * t))((hd - 45) / 95);
    const amp = detailAmp(b) * graded;
    if (amp <= 0) return b;
    const d =
      bilinear(this.detail, DETAIL_RES, x / DETAIL_SPAN, z / DETAIL_SPAN, true) +
      0.45 * bilinear(this.detail, DETAIL_RES, x / (DETAIL_SPAN * 0.37) + 0.31, z / (DETAIL_SPAN * 0.37) + 0.31, true);
    return b + d * amp;
  }

  /** Surface the suit or a shell meets: ground, or the sea where it is deeper. */
  surfaceAt(x: number, z: number): number {
    return Math.max(0, this.heightAt(x, z));
  }

  /** Unit ground normal by central differences. */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 2;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** The detail texture as a 0–1 tone at a world scale (m), as the terrain shader's tone(). */
  toneAt(x: number, z: number, scale: number): number {
    return bilinear(this.detail, DETAIL_RES, x / scale, z / scale, true) * 0.5 + 0.5;
  }

  /** Baked ambient occlusion 0–1. */
  aoAt(x: number, z: number): number {
    const n = HEIGHT_RES;
    const i = Math.min(n - 1, Math.max(0, Math.floor((x / WORLD_SIZE + 0.5) * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor((z / WORLD_SIZE + 0.5) * n)));
    return this.bake[(j * n + i) * 4 + 1] / 255;
  }

  /** Baked sun visibility 0–1 at a world point (shadowed valleys). */
  sunAt(x: number, z: number): number {
    const n = HEIGHT_RES;
    const i = Math.min(n - 1, Math.max(0, Math.floor((x / WORLD_SIZE + 0.5) * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor((z / WORLD_SIZE + 0.5) * n)));
    return this.bake[(j * n + i) * 4] / 255;
  }

  /**
   * First hit of a segment with the ground or sea (distance along `dir`), or
   * −1. Marches in steps of a few metres, then bisects.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    let prev = 0;
    let t = 0;
    const above = (s: number) => origin.y + dir.y * s - this.surfaceAt(origin.x + dir.x * s, origin.z + dir.z * s);
    if (above(0) < 0) return 0;
    while (t < maxDist) {
      const gap = above(t);
      if (gap < 0) {
        let a = prev;
        let b = t;
        for (let i = 0; i < 12; i++) {
          const m = (a + b) / 2;
          if (above(m) < 0) b = m;
          else a = m;
        }
        return (a + b) / 2;
      }
      prev = t;
      // Step by the clearance (the ground can't climb faster than ~1:1)
      t += Math.max(TEXEL * 0.25, gap * 0.7);
    }
    return -1;
  }
}
