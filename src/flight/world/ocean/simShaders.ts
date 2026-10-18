/**
 * GLSL ES 3.0 ports of the web-ocean simulation passes
 * (https://github.com/Noniv/web-ocean, js/wgsl/sim.js and common.js),
 * MIT License, Copyright (c) 2026 Maksymilian Dendura. See ./LICENSE.
 *
 * WebGPU compute shaders become full-screen fragment passes: the spectrum
 * evolution, a Stockham radix-2 inverse FFT (one pass per stage, ping-pong,
 * all cascades stacked in one atlas), the final assembly into mip-mapped
 * texture arrays, the procedural foam texture and the world-space foam
 * clipmaps.
 */
import { N } from './spectrum';

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const FSQ_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** h(k,t) from h0 and the dispersion; outputs the eight spectra the FFT inverts. */
export const EVOLVE_FRAG = HEAD + /* glsl */ `
uniform sampler2D uH0;
uniform vec4 uL;
uniform float uTime;
uniform float uLoop;
uniform float uChoppy;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
const float PI = 3.14159265358979;
const int N = ${N};
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 mulI(vec2 a) { return vec2(-a.y, a.x); }
float omegaOf(float k) { return sqrt(9.81 * k + 7.4e-5 * k * k * k); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.y / N;
  int x = p.x;
  int y = p.y - c * N;
  float L = uL[c];
  vec2 k = vec2(float(x >= N / 2 ? x - N : x), float(y >= N / 2 ? y - N : y)) * (2.0 * PI / L);
  float kl = length(k);
  if (kl < 1e-5) { oA = vec4(0.0); oB = vec4(0.0); return; }
  float w0 = 2.0 * PI / uLoop;
  float w = floor(omegaOf(kl) / w0) * w0;
  // mod in double-ish steps: keep the phase argument small
  float ph = mod(w * uTime, 2.0 * PI);
  vec2 e = vec2(cos(ph), sin(ph));
  vec4 H0 = texelFetch(uH0, p, 0);
  vec2 h = cmul(H0.xy, vec2(e.x, -e.y)) + cmul(H0.zw, e);
  vec2 ih = mulI(h);
  float lam = uChoppy;
  float ik = 1.0 / kl;
  vec2 Dx = ih * (lam * k.x * ik);
  vec2 Dz = ih * (lam * k.y * ik);
  vec2 jxz = h * (-lam * k.x * k.y * ik);
  vec2 sx = ih * k.x;
  vec2 sz = ih * k.y;
  vec2 jxx = h * (-lam * k.x * k.x * ik);
  vec2 jzz = h * (-lam * k.y * k.y * ik);
  oA = vec4(Dx + mulI(Dz), h + mulI(jxz));
  oB = vec4(sx + mulI(sz), jxx + mulI(jzz));
}
`;

/** One Stockham stage of the inverse FFT along rows (uHoriz = 1) or columns. */
export const FFT_FRAG = HEAD + /* glsl */ `
uniform sampler2D uA;
uniform sampler2D uB;
uniform int uSize;
uniform int uHoriz;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
const float PI = 3.14159265358979;
const int N = ${N};
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = uHoriz == 1 ? p.x : p.y % N;
  int half_ = uSize / 2;
  int even = (n / uSize) * half_ + n % half_;
  int odd = even + N / 2;
  ivec2 pe = uHoriz == 1 ? ivec2(even, p.y) : ivec2(p.x, p.y - n + even);
  ivec2 po = uHoriz == 1 ? ivec2(odd, p.y) : ivec2(p.x, p.y - n + odd);
  float ang = 2.0 * PI * float(n % uSize) / float(uSize);
  vec2 w = vec2(cos(ang), sin(ang));
  vec4 a0 = texelFetch(uA, pe, 0);
  vec4 a1 = texelFetch(uA, po, 0);
  vec4 b0 = texelFetch(uB, pe, 0);
  vec4 b1 = texelFetch(uB, po, 0);
  oA = a0 + vec4(cmul(a1.xy, w), cmul(a1.zw, w));
  oB = b0 + vec4(cmul(b1.xy, w), cmul(b1.zw, w));
}
`;

/**
 * Final assembly of one cascade into one of the three texture arrays:
 * 0 = displacement (Dx, h, Dz, jxz), 1 = derivatives (sx, sz, jxx, jzz),
 * 2 = slope moments (sx^2, sz^2, sx*sz) for LEAN mapping.
 */
export const ASSEMBLE_FRAG = HEAD + /* glsl */ `
uniform sampler2D uA;
uniform sampler2D uB;
uniform int uCascade;
uniform int uMode;
out vec4 oColor;
const int N = ${N};
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, uCascade * N);
  vec4 a = texelFetch(uA, p, 0);
  vec4 b = texelFetch(uB, p, 0);
  if (uMode == 0) oColor = vec4(a.x, a.z, a.y, a.w);
  else if (uMode == 1) oColor = b;
  else oColor = vec4(b.x * b.x, b.y * b.y, b.x * b.y, 0.0);
}
`;

const NOISE = /* glsl */ `
uint pcgHash(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// floor-mod for (possibly negative) ints: GLSL's % is undefined for them
int imod(int a, int b) { return a - b * int(floor(float(a) / float(b))); }
ivec2 imod2(ivec2 a, int b) { return ivec2(imod(a.x, b), imod(a.y, b)); }
vec2 hashGrad(ivec2 i) {
  uint h = pcgHash(uint(i.x) * 1664525u + pcgHash(uint(i.y) + 1013904223u));
  float a = float(h) * (6.28318530718 / 4294967296.0);
  return vec2(cos(a), sin(a));
}
float pnoise(vec2 p, int period) {
  ivec2 i = ivec2(floor(p));
  vec2 f = p - floor(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec2 i00 = imod2(i, period);
  ivec2 i10 = imod2(i + ivec2(1, 0), period);
  ivec2 i01 = imod2(i + ivec2(0, 1), period);
  ivec2 i11 = imod2(i + ivec2(1, 1), period);
  float a = dot(hashGrad(i00), f);
  float b = dot(hashGrad(i10), f - vec2(1.0, 0.0));
  float c = dot(hashGrad(i01), f - vec2(0.0, 1.0));
  float d = dot(hashGrad(i11), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 p, int period, int oct) {
  float s = 0.0; float a = 0.5; vec2 q = p; int per = period;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    s += a * pnoise(q, per);
    q *= 2.0; per *= 2; a *= 0.5;
  }
  return s;
}
`;

/**
 * Tileable foam micro-structure: R = bubble lace (warped fbm sheets with
 * Worley bubbles), G = finer lace, B = soft fbm density, A = streak noise.
 */
export const FOAM_TEX_FRAG = HEAD + NOISE + /* glsl */ `
in vec2 vUv;
out vec4 oColor;
vec2 h2(ivec2 i, uint salt) {
  uint h = pcgHash((uint(i.x) * 73856093u) ^ pcgHash(uint(i.y) * 19349663u + salt));
  uint h2v = pcgHash(h + 0x9e3779b9u);
  return vec2(float(h >> 8u), float(h2v >> 8u)) / 16777216.0;
}
float bubbles(vec2 uv, int period, uint salt, float rmin, float rmax) {
  vec2 w = vec2(pfbm(uv * float(period) * 0.5, period / 2, 3), pfbm(uv * float(period) * 0.5 + 17.0, period / 2, 3));
  vec2 p = uv * float(period) + w * 0.9;
  ivec2 ip = ivec2(floor(p));
  vec2 fp = p - floor(p);
  float v = 9.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 o = ivec2(i, j);
      ivec2 cell = imod2(ip + o, period);
      vec2 hh = h2(cell, salt);
      vec2 r = vec2(o) + hh * 0.9 + 0.05 - fp;
      float rad = mix(rmin, rmax, h2(cell, salt + 7u).x);
      v = min(v, length(r) / rad);
    }
  }
  return smoothstep(0.8, 1.25, v);
}
void main() {
  vec2 uv = vUv;
  vec2 w1 = vec2(pfbm(uv * 5.0, 5, 3), pfbm(uv * 5.0 + vec2(3.7, 9.1), 5, 3));
  float m1 = smoothstep(-0.14, 0.06, pfbm(uv * 10.0 + w1 * 1.4, 10, 5));
  vec2 w2 = vec2(pfbm(uv * 12.0 + 1.3, 12, 2), pfbm(uv * 12.0 + 7.9, 12, 2));
  float m2 = smoothstep(-0.16, 0.04, pfbm(uv * 27.0 + w2 * 0.9, 27, 4));
  float b3 = bubbles(uv, 29, 37u, 0.06, 0.45);
  float b4 = bubbles(uv, 61, 53u, 0.05, 0.42);
  float dens = pfbm(uv * 4.0, 4, 5) * 0.5 + 0.5;
  float fineD = pfbm(uv * 16.0, 16, 3) * 0.5 + 0.5;
  float big = m1 * (0.55 + 0.45 * m2) * (0.75 + 0.25 * b3);
  float fine = 0.45 + 0.55 * b3 * (0.7 + 0.3 * b4);
  float streak = pfbm(uv * vec2(4.0, 16.0), 4, 5) * 0.5 + 0.5;
  oColor = vec4(clamp(big * 0.6 + dens * 0.4, 0.0, 1.0), clamp(fine * 0.8 + fineD * 0.2, 0.0, 1.0), dens, streak);
}
`;

/**
 * World-space foam clipmap, toroidally addressed around the eye. Foam is
 * injected where the total surface Jacobian folds (crests breaking), decays,
 * and drifts downwind. R = foam, G = freshness.
 */
export const FOAM_UPDATE_FRAG = HEAD + /* glsl */ `
precision highp sampler2DArray;
uniform sampler2D uPrev;
uniform sampler2DArray uDisp;
uniform sampler2DArray uDeriv;
uniform ivec4 uSnap;      // current eye texel (x, z), previous (x, z)
uniform int uRes;
uniform float uTexel;     // m per texel
uniform float uDt;
uniform float uDecay;
uniform vec3 uInject;     // J threshold, gain, growth
uniform vec2 uDrift;      // m/s
uniform vec4 uCascL;
uniform float uFirst;
out vec4 oColor;
// floor-mod (GLSL's % is undefined for negative operands)
int wrapIdx(int i, int lo) { int d = i - lo; return lo + d - uRes * int(floor(float(d) / float(uRes))); }
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  ivec2 lo = uSnap.xy - ivec2(uRes / 2);
  ivec2 g = ivec2(wrapIdx(id.x, lo.x), wrapIdx(id.y, lo.y));
  ivec2 plo = uSnap.zw - ivec2(uRes / 2);
  bool inPrev = uFirst < 0.5 && all(greaterThanEqual(g, plo)) && all(lessThan(g, plo + ivec2(uRes)));
  vec2 p = (vec2(g) + 0.5) * uTexel;
  float jxx = 0.0, jzz = 0.0, jxz = 0.0;
  for (int c = 0; c < 4; c++) {
    float texel = uCascL[c] / ${N}.0;
    float lod = log2(max(uTexel / texel, 1.0));
    if (lod < 7.5) {
      vec2 uv = p / uCascL[c];
      vec4 d = textureLod(uDeriv, vec3(uv, float(c)), lod);
      vec4 a = textureLod(uDisp, vec3(uv, float(c)), lod);
      jxx += d.z; jzz += d.w; jxz += a.w;
    }
  }
  float J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;
  vec4 prev = vec4(0.0);
  if (inPrev) {
    vec2 back = (vec2(id) + 0.5 - uDrift * uDt / uTexel) / float(uRes);
    prev = textureLod(uPrev, back, 0.0);
  }
  float inject = clamp((uInject.x - J) * uInject.y, 0.0, 1.0);
  float f = prev.r * exp(-uDt * uDecay);
  f = max(f, inject);
  f = min(f + inject * uDt * uInject.z, 1.6);
  float fresh = max(prev.g * exp(-uDt * 1.6), inject);
  oColor = vec4(f, fresh, J, 1.0);
}
`;
