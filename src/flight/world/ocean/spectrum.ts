/**
 * Ocean wave spectrum (Tessendorf FFT ocean), generated on the CPU once.
 *
 * Ported from web-ocean (https://github.com/Noniv/web-ocean, js/wgsl/sim.js
 * SIM_INIT / SIM_EVOLVE), MIT License, Copyright (c) 2026 Maksymilian Dendura.
 * See ./LICENSE. The GPU there builds h0 in a compute shader; here it is
 * built in TypeScript (bit-identical hashing) so the CPU can also answer
 * "how high is the sea here" for splashes from the same spectrum the GPU
 * animates.
 *
 * A fetch-limited JONSWAP wind sea with Donelan-Banner spreading plus a
 * narrow long-crested swell, split over cascades of nested patch sizes.
 */

export const N = 256;
export const LOG_N = 8;
/** Patch sizes (m), coarse to fine. */
export const CASCADE_L = [1103.0, 211.3, 39.7, 7.43] as const;
export const CASCADES = CASCADE_L.length;
/** Spectrum time loop (s): frequencies are quantised so the sea repeats seamlessly. */
export const LOOP = 600;

const GRAV = 9.81;
const SURF = 7.4e-5;
const PI = Math.PI;
const D2R = PI / 180;

/** Sea state. Directions are the way the waves travel, in the xz plane (deg, atan2(z, x)). */
export const SEA = {
  windSpeed: 7.0,
  /** Onshore breeze off the sunset: the waves run north-east into the coast. */
  windDir: -78,
  fetchKm: 90,
  gamma: 3.3,
  swellHs: 1.6,
  swellDir: -62,
  swellLength: 120,
  swellSpread: 48,
  choppy: 1.15,
  shortCut: 0.0012,
  seed: 1,
};

export const omegaOf = (k: number): number => Math.sqrt(GRAV * k + SURF * k * k * k);
const dOmegaOf = (k: number): number => (GRAV + 3 * SURF * k * k) / (2 * omegaOf(k));
/** Dispersion quantised to the loop period (as the GPU evolves it). */
export function omegaLooped(k: number): number {
  const w0 = (2 * PI) / LOOP;
  return Math.floor(omegaOf(k) / w0) * w0;
}

function pcgHash(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const rand01 = (s: number): number => ((pcgHash(s >>> 0) >>> 8) + 0.5) / 16777216;
function gauss2(seed: number, out: [number, number]): void {
  const u1 = rand01(Math.imul(seed, 2) + 17);
  const u2 = rand01(((Math.imul(seed, 2) + 18) >>> 0) + pcgHash(seed));
  const r = Math.sqrt(-2 * Math.log(u1));
  const a = 2 * PI * u2;
  out[0] = r * Math.cos(a);
  out[1] = r * Math.sin(a);
}
const wrapAngle = (a: number): number => a - 2 * PI * Math.floor((a + PI) / (2 * PI));

function jonswap(w: number, wp: number, alpha: number, gamma: number): number {
  const sigma = w <= wp ? 0.07 : 0.09;
  const d = (w - wp) / (sigma * wp);
  const r = Math.exp(-0.5 * d * d);
  const q2 = (wp / w) ** 2;
  return ((alpha * GRAV * GRAV) / w ** 5) * Math.exp(-1.25 * q2 * q2) * gamma ** r;
}
function donelanBanner(theta: number, w: number, wp: number): number {
  const ratio = w / wp;
  let beta: number;
  if (ratio < 0.95) beta = 2.61 * ratio ** 1.3;
  else if (ratio < 1.6) beta = 2.28 * ratio ** -1.3;
  else beta = 10 ** (-0.4 + 0.8393 * Math.exp(-0.567 * Math.log(ratio * ratio)));
  const sh = 1 / Math.cosh(Math.max(-20, Math.min(20, beta * theta)));
  return (beta / (2 * Math.tanh(beta * PI))) * sh * sh;
}
function cosSpread(theta: number, s: number): number {
  const q = Math.sqrt(s + 0.25) / (2 * Math.sqrt(PI));
  return q * Math.abs(Math.cos(theta * 0.5)) ** (2 * s);
}

function spectrum(kx: number, kz: number): number {
  const kl = Math.hypot(kx, kz);
  const w = omegaOf(kl);
  const theta = Math.atan2(kz, kx);
  const U = SEA.windSpeed;
  const F = SEA.fetchKm * 1000;
  let S = 0;
  if (U > 0.1) {
    const alpha = 0.076 * ((U * U) / (F * GRAV)) ** 0.22;
    const wp = 22 * ((GRAV * GRAV) / (U * F)) ** (1 / 3);
    S = jonswap(w, wp, alpha, SEA.gamma) * donelanBanner(wrapAngle(theta - SEA.windDir * D2R), w, wp);
  }
  if (SEA.swellHs > 0.001) {
    const ws = Math.sqrt(GRAV * ((2 * PI) / SEA.swellLength));
    const gs = 6;
    const hs4 = SEA.swellHs * 0.25;
    const alphaS = ((hs4 * hs4 * 5 * ws ** 4) / (GRAV * GRAV)) * (1 - 0.287 * Math.log(gs));
    S += jonswap(w, ws, alphaS, gs) * cosSpread(wrapAngle(theta - SEA.swellDir * D2R), SEA.swellSpread);
  }
  S *= Math.exp(-kl * kl * SEA.shortCut * SEA.shortCut);
  return (S * dOmegaOf(kl)) / kl;
}

/** Wavenumber band each cascade owns (no double counting between patches). */
export function cascadeBands(): { kMin: number[]; kMax: number[] } {
  const kMin: number[] = [];
  const kMax: number[] = [];
  for (let c = 0; c < CASCADES; c++) {
    const L = CASCADE_L[c];
    kMax[c] = c < CASCADES - 1 ? (2 * PI * 6) / CASCADE_L[c + 1] : ((PI * N) / L) * 0.98;
    kMin[c] = c === 0 ? PI / L : kMax[c - 1];
  }
  for (let c = 1; c < CASCADES; c++) kMin[c] = kMax[c - 1];
  return { kMin, kMax };
}

const waveIndex = (i: number): number => (i >= N / 2 ? i - N : i);

/**
 * h0 for every cascade: RGBA float texels, cascades stacked in rows
 * (row = c * N + y). (h0(k).re, h0(k).im, conj(h0(-k)).re, conj(h0(-k)).im).
 */
export function buildH0(): Float32Array {
  const out = new Float32Array(N * N * CASCADES * 4);
  const { kMin, kMax } = cascadeBands();
  const a: [number, number] = [0, 0];
  const b: [number, number] = [0, 0];
  for (let c = 0; c < CASCADES; c++) {
    const L = CASCADE_L[c];
    const dk = (2 * PI) / L;
    // the finest cascade is toned down (it otherwise reads as crumpled foil)
    const g = c === CASCADES - 1 ? 0.85 : 1;
    const amp = (kx: number, kz: number): number => {
      const kl = Math.hypot(kx, kz);
      if (kl < 1e-5 || kl < kMin[c] || kl >= kMax[c]) return 0;
      return Math.sqrt(Math.max(spectrum(kx, kz), 0)) * dk * 0.5 * g;
    };
    const seed = (Math.imul(SEA.seed, 7919) + Math.imul(c, 1000003)) >>> 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const kx = waveIndex(x) * dk;
        const kz = waveIndex(y) * dk;
        const mx = (N - x) % N;
        const my = (N - y) % N;
        gauss2((seed + y * N + x) >>> 0, a);
        gauss2((seed + my * N + mx) >>> 0, b);
        const ap = amp(kx, kz);
        const bp = amp(-kx, -kz);
        const o = ((c * N + y) * N + x) * 4;
        out[o] = a[0] * ap;
        out[o + 1] = a[1] * ap;
        out[o + 2] = b[0] * bp;
        out[o + 3] = -b[1] * bp;
      }
    }
  }
  return out;
}

/** The strongest wave components, for a cheap CPU height query. */
interface Mode {
  kx: number;
  kz: number;
  w: number;
  ar: number;
  ai: number;
  br: number;
  bi: number;
}
let modes: Mode[] | null = null;

/** Keep the M most energetic components of the two coarse cascades (the swell and the wind sea peak). */
export function dominantModes(h0: Float32Array, count = 96): Mode[] {
  const all: { e: number; m: Mode }[] = [];
  for (let c = 0; c < Math.min(2, CASCADES); c++) {
    const dk = (2 * PI) / CASCADE_L[c];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const iy = waveIndex(y);
        const ix = waveIndex(x);
        // half plane: the partner -k carries the conjugate
        if (iy < 0 || (iy === 0 && ix <= 0)) continue;
        const o = ((c * N + y) * N + x) * 4;
        const ar = h0[o], ai = h0[o + 1], br = h0[o + 2], bi = h0[o + 3];
        const e = ar * ar + ai * ai + br * br + bi * bi;
        if (e <= 0) continue;
        const kx = ix * dk;
        const kz = iy * dk;
        all.push({ e, m: { kx, kz, w: omegaLooped(Math.hypot(kx, kz)), ar, ai, br, bi } });
      }
    }
  }
  all.sort((p, q) => q.e - p.e);
  return all.slice(0, count).map((p) => p.m);
}

export function setModes(m: Mode[]): void {
  modes = m;
}

/**
 * Sea surface height (m) at a point (the open-sea swell, from the dominant
 * spectrum components; horizontal choppiness and the shallows are ignored).
 */
export function seaHeightAt(x: number, z: number, time: number): number {
  if (!modes) modes = dominantModes(buildH0());
  const t = ((time % LOOP) + LOOP) % LOOP;
  let y = 0;
  for (const m of modes) {
    const ph = m.w * t;
    const c = Math.cos(ph);
    const s = Math.sin(ph);
    // h(k,t) = a e^{-iwt} + b e^{iwt}
    const hr = m.ar * c + m.ai * s + m.br * c - m.bi * s;
    const hi = m.ai * c - m.ar * s + m.bi * c + m.br * s;
    const kp = m.kx * x + m.kz * z;
    // Re(h e^{ik.x}), doubled for the -k partner
    y += 2 * (hr * Math.cos(kp) - hi * Math.sin(kp));
  }
  return y;
}

/**
 * One radix-2 Stockham pass of the inverse DFT (sum X[k] e^{+2 pi i kn/N}),
 * exactly as the GPU pass indexes it: output n of a pass with sub-transform
 * size `size` reads input `even` and `even + N/2`.
 */
export function stockhamIndex(n: number, size: number, len: number): { even: number; odd: number; angle: number } {
  const half = size / 2;
  const even = Math.floor(n / size) * half + (n % half);
  return { even, odd: even + len / 2, angle: (2 * PI * (n % size)) / size };
}
