/**
 * Sea surface shaders: CDLOD vertex displacement from the FFT cascades and
 * the web-ocean shading model — LEAN-mapped slope statistics (anisotropic
 * roughness at every distance, so the far sea settles into a sheen instead
 * of aliasing), an anisotropic Gaussian sun glitter with Smith masking,
 * grazing-angle sky reflection, a turbid water body with backlit-crest
 * subsurface glow, wind-gust patches, and Jacobian whitecaps with
 * persistent, streaking world-space foam.
 *
 * Ported from web-ocean (https://github.com/Noniv/web-ocean,
 * js/wgsl/ocean.js), MIT License, Copyright (c) 2026 Maksymilian Dendura.
 * See ./LICENSE. Adapted to this world: the sky is the baked sky cube, the
 * air is the shared height haze, the depth buffer is logarithmic (the
 * material is patched with withLogDepth), and the sea knows the coast —
 * waves calm and foam lines surge over the shelf, the seabed shows through
 * the shallows, and cliff shadows fall on the water.
 */
import { ATMOSPHERE_GLSL } from '../atmosphere';
import { TERRAIN_SAMPLE_GLSL } from '../heightfield';
import { CASCADES, N } from './spectrum';

const SHORE_GLSL = /* glsl */ `
// Wave amplitude over the shelf (depth below sea level, m): the swell lies
// down toward the beach instead of climbing the sand
float shoreAmp(float depth) { return mix(0.25, 1.0, smoothstep(0.0, 12.0, depth)); }
`;

export const SURFACE_VERT = /* glsl */ `
precision highp sampler2DArray;
attribute vec4 aNode; // x0, z0, size, lod
uniform sampler2DArray uDisp;
uniform vec4 uCascL;
uniform float uGrid;
uniform float uR0;
uniform float uFarClamp;
varying vec3 vWorld;
varying vec2 vXZ;
varying float vHeight;
varying float vAmp;
${TERRAIN_SAMPLE_GLSL}
${SHORE_GLSL}
void main() {
  vec2 g = position.xz;
  float spacing = aNode.z / uGrid;
  vec2 xz = aNode.xy + g * spacing;
  // CDLOD morph toward the next coarser level
  float R = uR0 * exp2(aNode.w);
  float d = distance(vec3(xz.x, 0.0, xz.y), cameraPosition);
  float mk = clamp((d - 0.8 * R) / (0.2 * R), 0.0, 1.0);
  xz -= fract(g * 0.5) * 2.0 * spacing * mk;
  float eff = spacing * (1.0 + mk);
  vec3 disp = vec3(0.0);
  for (int c = 0; c < ${CASCADES}; c++) {
    float texel = uCascL[c] / ${N}.0;
    float lod = log2(max(eff / texel, 1.0)) + 0.5;
    if (lod < 8.0) disp += textureLod(uDisp, vec3(xz / uCascL[c], float(c)), lod).xyz;
  }
  float amp = shoreAmp(-terrainBase(xz));
  vHeight = disp.y;
  vAmp = amp;
  disp *= amp;
  vec3 world = vec3(xz.x + disp.x, disp.y, xz.y + disp.z);
  vWorld = world;
  vXZ = xz;
  // The flat sea runs on to the horizon line; past the far plane it is
  // pulled in radially (fully hazed by then, shading uses the true point)
  vec3 rel = world - cameraPosition;
  float rl = length(rel);
  if (rl > uFarClamp) rel *= uFarClamp / rl;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + rel, 1.0);
}
`;

export const SURFACE_FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uDisp;
uniform sampler2DArray uDeriv;
uniform sampler2DArray uMom;
uniform sampler2D uFoamTex;
uniform sampler2D uFoamW0;
uniform sampler2D uFoamW1;
uniform vec4 uCascL;
uniform vec3 uWind;       // direction xz, speed
uniform float uTime;
uniform vec2 uFoamLevels; // clipmap spans (m)
uniform vec4 uWater;      // body scatter colour, unresolved slope variance
uniform vec4 uSss;        // subsurface colour, strength
uniform vec4 uFoamP;      // J threshold, J gain, intensity, -
uniform vec4 uTune;       // sky radiance clamp, glitter clamp, body gain, -
varying vec3 vWorld;
varying vec2 vXZ;
varying float vHeight;
varying float vAmp;
${TERRAIN_SAMPLE_GLSL}
${ATMOSPHERE_GLSL}
const float PI = 3.14159265358979;
const float ENV_MAXMIP = 8.0;
const float ENV_TEXELS_PER_RAD = 256.0 / 1.5708;

float fresnelWater(float c) {
  float x = 1.0 - clamp(c, 0.0, 1.0);
  float x2 = x * x;
  return 0.02 + 0.98 * x2 * x2 * x;
}
float lambdaSmith(vec3 w, vec3 cov) {
  float xz2 = max(dot(w.xz, w.xz), 1e-8);
  float il = inversesqrt(xz2);
  vec2 az = w.xz * il;
  float sig2 = az.x * az.x * cov.x + az.y * az.y * cov.y + 2.0 * az.x * az.y * cov.z;
  float cotT = w.y * il;
  float a = max(cotT, 1e-3) / sqrt(2.0 * max(sig2, 1e-7));
  if (a >= 1.6) return 0.0;
  return (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
}
float foamPattern(vec2 xz, float t) {
  float a = texture(uFoamTex, xz * 0.23 + vec2(0.013, 0.0) * t).r;
  float b = texture(uFoamTex, xz * 0.71 + vec2(0.37, 0.71)).g;
  return a * 0.78 + b * 0.22;
}

void main() {
  vec2 xz = vXZ;
  float amp = vAmp;
  // Wind gusts ("cat's paws"): patches where the short ripples are stronger or calmer
  float gustN = texture(uFoamTex, xz * 0.011 + uWind.xy * (uTime * 0.0004)).b;
  float gust = mix(0.35, 1.2, smoothstep(0.3, 0.72, gustN));
  // Kilometre-scale, non-repeating variation of the wind sea (breaks up any
  // tiling of the patches seen from altitude)
  vec2 mq = mat2(0.8, -0.6, 0.6, 0.8) * xz;
  float macroN = texture(uFoamTex, xz / 5300.0 + 0.37).b * 0.55 + texture(uFoamTex, mq / 13700.0).b * 0.45;
  float macro = mix(0.65, 1.3, smoothstep(0.32, 0.68, macroN));

  vec2 s = vec2(0.0);
  float jxx = 0.0, jzz = 0.0, jxz = 0.0;
  vec3 cov = vec3(0.0);
  for (int c = 0; c < ${CASCADES}; c++) {
    vec3 uv = vec3(xz / uCascL[c], float(c));
    float gk = c == 3 ? mix(1.0, gust, 0.5) : c == 2 ? mix(1.0, gust, 0.2) * macro : c == 1 ? mix(1.0, macro, 0.5) : 1.0;
    gk *= amp;
    vec4 dv = texture(uDeriv, uv) * gk;
    vec4 mv = texture(uMom, uv) * (gk * gk);
    vec4 av = texture(uDisp, uv) * gk;
    s += dv.xy;
    jxx += dv.z;
    jzz += dv.w;
    jxz += av.w;
    cov += vec3(max(mv.x - dv.x * dv.x, 0.0), max(mv.y - dv.y * dv.y, 0.0), mv.z - dv.x * dv.y);
  }
  vec3 toEye = cameraPosition - vWorld;
  float dist = length(toEye);
  vec3 V = toEye / dist;
  vec3 Ld = uSunDir;

  // Slope statistics (LEAN) plus unresolved capillary roughness, growing
  // with distance toward Cox-Munk totals in the far sheen
  float unres = (uWater.w + 0.0035 * smoothstep(30.0, 500.0, dist)) * mix(0.6, 1.2, gust * 0.6 + macro * 0.2);
  cov.x += unres;
  cov.y += unres;
  float jx = max(1.0 + jxx, 0.15);
  float jz = max(1.0 + jzz, 0.15);
  vec2 sl = vec2(s.x / jx, s.y / jz);
  vec3 nrm = normalize(vec3(-sl.x, 1.0, -sl.y));
  // Specular anti-aliasing: slope variation across the pixel widens the lobe
  vec2 dsx = dFdx(sl);
  vec2 dsy = dFdy(sl);
  vec3 aa = vec3(dsx.x * dsx.x + dsy.x * dsy.x, dsx.y * dsx.y + dsy.y * dsy.y, dsx.x * dsx.y + dsy.x * dsy.y) * 0.5;
  cov += aa * min(1.0, 0.03 / max(max(aa.x, aa.y), 1e-8));
  float J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;

  // Cliff and ridge shadows on the water
  float sunVis = texture2D(uBake, xz / uWorld + 0.5).r;
  vec3 sunE = uSunColor * sunVis;
  vec3 skyUp = textureLod(uSkyCube, vec3(0.0, 1.0, 0.0), ENV_MAXMIP).rgb;
  vec3 skyHemi = skyUp * 0.4 + 0.15 * (
      textureLod(uSkyCube, vec3(0.94, 0.34, 0.0), ENV_MAXMIP - 1.0).rgb +
      textureLod(uSkyCube, vec3(-0.94, 0.34, 0.0), ENV_MAXMIP - 1.0).rgb +
      textureLod(uSkyCube, vec3(0.0, 0.34, 0.94), ENV_MAXMIP - 1.0).rgb +
      textureLod(uSkyCube, vec3(0.0, 0.34, -0.94), ENV_MAXMIP - 1.0).rgb);
  vec3 skyN = textureLod(uSkyCube, nrm, ENV_MAXMIP - 1.0).rgb;

  // ---- sun glitter: anisotropic Gaussian slope distribution ----
  vec3 Hv = normalize(V + Ld);
  vec2 hs = -Hv.xz / max(Hv.y, 1e-3);
  vec2 dsl = hs - sl;
  float det = max(cov.x * cov.y - cov.z * cov.z, 1e-10);
  float e = (dsl.x * dsl.x * cov.y + dsl.y * dsl.y * cov.x - 2.0 * dsl.x * dsl.y * cov.z) / det;
  float pdf = exp(-0.5 * e) / (2.0 * PI * sqrt(det));
  float hy2 = Hv.y * Hv.y;
  float Dm = pdf / max(hy2 * hy2, 1e-6);
  float G = 1.0 / (1.0 + lambdaSmith(V, cov) + lambdaSmith(Ld, cov));
  float Fh = fresnelWater(dot(V, Hv));
  vec3 spec = sunE * min(Fh * Dm * G / (4.0 * max(V.y, 0.02)), uTune.y) * step(0.0, Ld.y);

  // ---- sky reflection ----
  // At grazing angles the visible facets lean toward the viewer, so the
  // effective reflector tilts up and sees higher, greyer sky
  float sig = sqrt(max(cov.x + cov.y, 1e-6) * 0.5);
  vec3 vh = normalize(vec3(V.x, 0.0, V.z) + vec3(1e-5, 0.0, 0.0));
  float sigV = sqrt(max(vh.x * vh.x * cov.x + vh.z * vh.z * cov.y + 2.0 * vh.x * vh.z * cov.z, 1e-6));
  float aV = max(V.y, 1e-3) / max(sqrt(1.0 - V.y * V.y), 1e-3) / (1.4142 * sigV);
  float tilt = 0.32 * sigV * (1.0 - smoothstep(0.0, 2.5, aV));
  vec3 nV = normalize(nrm + vh * tilt);
  vec3 R = reflect(-V, nV);
  R.y = abs(R.y) * 0.4 + max(R.y, 0.0) * 0.6;
  R = normalize(R);
  float envLod = clamp(log2(max(2.0 * sig * ENV_TEXELS_PER_RAD, 1.0)), 0.0, ENV_MAXMIP);
  // (the cube's own sun disc is left to the analytic glitter above)
  vec3 refl = min(textureLod(uSkyCube, R, envLod).rgb, vec3(uTune.x));
  vec3 nF = normalize(mix(nrm, vec3(0.0, 1.0, 0.0), 0.45));
  float Fr = fresnelWater(max(dot(nF, V), 0.0));

  // ---- water body: upwelling scatter + backlit subsurface glow ----
  vec3 ambient = skyUp * 1.3 + skyN * 0.5;
  vec3 body = uWater.rgb * (skyHemi * 1.6 + sunE * max(Ld.y, 0.0) * 0.8) * uTune.z;
  float crest = clamp((vHeight * amp - 0.05) / 0.9, 0.0, 1.0);
  float toSun = max(dot(Ld, -V), 0.0);
  float thin = pow(clamp(0.5 - 0.5 * dot(Ld, nrm), 0.0, 1.0), 3.0);
  float k1 = uSss.w * crest * crest * pow(toSun, 4.0) * thin * exp(-dist / 600.0);
  body += uSss.rgb * sunE * k1;

  // ---- the shelf: sand seen through the shallows ----
  float ground = terrainHeight(xz);
  float depth = max(vWorld.y - ground, 0.0);
  vec3 absorb = exp(-depth * vec3(0.45, 0.10, 0.07));
  vec3 seabed = vec3(0.42, 0.36, 0.26) * (sunE * max(Ld.y, 0.0) * 0.9 + skyHemi * 0.6);
  body = mix(body, seabed, absorb);

  // ---- foam ----
  // persistent foam from the world-space clipmaps (near: fine, far: coarse),
  // plus instantaneous crest foam from the per-pixel Jacobian beyond them
  vec2 dc = abs(xz - cameraPosition.xz);
  float cheb = max(dc.x, dc.y);
  float w0 = 1.0 - smoothstep(0.30 * uFoamLevels.x, 0.45 * uFoamLevels.x, cheb);
  float w1 = 1.0 - smoothstep(0.30 * uFoamLevels.y, 0.45 * uFoamLevels.y, cheb);
  vec4 fw0 = texture(uFoamW0, xz / uFoamLevels.x);
  vec4 fw1 = texture(uFoamW1, xz / uFoamLevels.y);
  vec4 fwl = mix(fw1, fw0, w0) * w1 * amp;
  float fresh = clamp((uFoamP.x - J) * uFoamP.y, 0.0, 1.0);
  float cover = clamp((max(fwl.r, fresh * (1.0 - w1 * 0.7)) + fwl.g * 0.6) * uFoamP.z, 0.0, 1.5);
  // aged foam breaks into wind-aligned streaks; fresh crest foam stays dense
  vec2 wd = uWind.xy;
  vec2 ws = vec2(dot(xz, wd), dot(xz, vec2(-wd.y, wd.x)));
  float streak = texture(uFoamTex, ws * vec2(0.035, 0.11)).a;
  float freshK = clamp(fwl.g * 2.0 + fresh, 0.0, 1.0);
  cover *= mix(smoothstep(0.25, 0.75, streak) * 1.5, 1.0, freshK);
  float pat = foamPattern(xz, uTime);

  // Surf: swell crests spill over the outer shelf, and lines of wash surge
  // up the last metre of the beach
  float seaD = max(-ground, 0.0);
  float breaker = smoothstep(1.2, 2.2, seaD) * (1.0 - smoothstep(4.0, 6.5, seaD)) * smoothstep(0.25, 0.8, vHeight);
  float surge = 0.5 + 0.5 * sin(uTime * 0.8 - seaD * 2.2 + pat * 1.5);
  float wash = (1.0 - smoothstep(0.2, 2.2, seaD)) * smoothstep(0.38, 0.85, surge * 0.65 + pat * 0.45);
  float surf = clamp(max(breaker * (0.5 + 0.7 * pat), wash) * step(0.02, seaD), 0.0, 1.0);
  cover = max(cover, surf);
  freshK = max(freshK, surf);

  float fw = fwidth(pat) + 0.03;
  // dense foam has crisp edges, thin decaying foam a soft translucent margin
  float soft = 0.04 + 0.14 * (1.0 - clamp(cover, 0.0, 1.0));
  float fm = smoothstep(1.0 - cover - fw - soft, 1.0 - cover + fw + soft, pat);
  float foamMask = clamp(fm * smoothstep(0.0, 0.5, cover), 0.0, 1.0) * (0.68 + 0.32 * smoothstep(0.3, 0.9, cover));
  // freshly broken crests: dense, almost opaque core
  foamMask = max(foamMask, smoothstep(0.35, 0.9, max(fwl.g, surf * 0.8)) * smoothstep(0.25, 0.6, pat + 0.25) * 0.95);
  // submerged bubbles brighten and tint the water just beneath foam
  body += uSss.rgb * (sunE * 0.05 + ambient * 0.35) * clamp(cover, 0.0, 1.0);
  body += vec3(0.10, 0.32, 0.30) * skyUp * fwl.g * 0.35;
  float bub = texture(uFoamTex, xz * 1.9 + vec2(0.21, 0.53)).g;
  vec3 foamAlb = vec3(0.82, 0.87, 0.92) * (0.78 + 0.3 * bub);
  // foam scatters light from the whole hemisphere; grazing sun is largely
  // self-shadowed by its lumpy micro-structure
  vec3 foamAmb = skyHemi + skyN * 0.3;
  vec3 foamAmbN = mix(foamAmb, vec3(dot(foamAmb, vec3(0.2126, 0.7152, 0.0722))), 0.85);
  vec3 foamLit = foamAlb * (sunE * max(dot(nrm, Ld), 0.0) * 0.318 * 0.5 + foamAmbN * 1.1);

  vec3 col = body * (1.0 - Fr) + refl * Fr + spec;
  col = mix(col, foamLit, foamMask * 0.95);
  col = applyHaze(col, cameraPosition, vWorld, sunVis);
  // Past the planet's horizon (the world is flat, the sky isn't) the sea
  // gives way to the sky's own colour below the horizon line
  float horizonD = sqrt(2.0 * 6.371e6 * max(cameraPosition.y, 2.0));
  col = mix(col, textureLod(uSkyCube, -V, 0.0).rgb, smoothstep(0.5, 1.0, dist / horizonD));
  gl_FragColor = vec4(col, 1.0);
}
`;
