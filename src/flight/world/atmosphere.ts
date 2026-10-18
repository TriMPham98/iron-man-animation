import * as THREE from 'three';
import { SUN_COLOR, SUN_DIR, SUN_INTENSITY } from './config';

/**
 * Sky, sun and air. A physically based sky is rendered once
 * into a cube map: it is the scene background, the image-based light every
 * PBR surface picks up (pre-filtered), and — sampled along the view ray —
 * the colour distant land and sea fade into, so the haze always matches
 * the sky behind it.
 */
export interface Atmosphere {
  sun: THREE.DirectionalLight;
  skyCube: THREE.CubeTexture;
  envMap: THREE.Texture;
  /** Uniforms shared by every custom shader that applies the haze. */
  uniforms: Record<string, THREE.IUniform>;
}

/** Height fog: sea-level density (1/m) and scale height falloff (1/m). */
const FOG_DENSITY = 1 / 30000;
const FOG_FALLOFF = 1 / 1400;

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform samplerCube uSkyCube;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uFogDensity;
uniform float uFogFalloff;
// Haze colour seen along a view ray: the sky at (or just above) the horizon
// behind it, warmed toward the sun
vec3 hazeColor(vec3 rd) {
  vec3 d = normalize(vec3(rd.x, max(rd.y, 0.015), rd.z));
  vec3 sky = textureLod(uSkyCube, d, 4.0).rgb;
  float s = max(dot(rd, uSunDir), 0.0);
  return sky + uSunColor * (pow(s, 12.0) * 0.08 + pow(s, 3.0) * 0.015);
}
// Amount of air between the eye and a point (exponential height fog,
// integrated analytically along the ray)
float hazeAmount(vec3 ro, vec3 p) {
  vec3 rd = p - ro;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  float b = uFogFalloff;
  float y = max(ro.y, -50.0);
  float k = rd.y * b;
  float fog = uFogDensity * exp(-y * b) * (abs(k) > 1e-5 ? (1.0 - exp(-dist * k)) / k : dist);
  return 1.0 - exp(-max(fog, 0.0));
}
vec3 applyHaze(vec3 col, vec3 ro, vec3 p) {
  float a = hazeAmount(ro, p);
  return mix(col, hazeColor(normalize(p - ro)), a);
}
`;

/**
 * Single-scattering sky (Rayleigh + Mie, after Nishita / O'Neil), integrated
 * per cube-map texel at bake time: deep blue overhead, the low sun burning
 * orange through a long air path, the pink belt opposite. Runs once.
 */
const SKY_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSun;
varying vec3 vDir;
const float PI = 3.14159265;
const float R_PLANET = 6371e3;
const float R_ATMOS = 6471e3;
const vec3 K_RLH = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float K_MIE = 21e-6;
const float SH_RLH = 8e3;
const float SH_MIE = 1.2e3;
const float G = 0.84;
const float I_SUN = 22.0;
vec2 rsi(vec3 r0, vec3 rd, float sr) {
  float b = 2.0 * dot(rd, r0);
  float c = dot(r0, r0) - sr * sr;
  float d = b * b - 4.0 * c;
  if (d < 0.0) return vec2(1e5, -1e5);
  return vec2((-b - sqrt(d)) / 2.0, (-b + sqrt(d)) / 2.0);
}
void main() {
  vec3 r = normalize(vDir);
  // Below the horizon: the horizon colour, darkening further down (the sea
  // and land cover these directions; this is only what the light sees)
  float below = clamp(-r.y / 0.25, 0.0, 1.0);
  r.y = max(r.y, 0.002);
  r = normalize(r);
  vec3 r0 = vec3(0.0, R_PLANET + 250.0, 0.0);
  vec3 sun = normalize(uSun);
  vec2 p = rsi(r0, r, R_ATMOS);
  float hitGround = rsi(r0, r, R_PLANET).x;
  bool ground = hitGround > 0.0 && hitGround < p.y;
  p.y = ground ? hitGround : p.y;
  p.x = max(p.x, 0.0);
  const int IS = 16;
  const int JS = 6;
  float step = (p.y - p.x) / float(IS);
  float t = 0.0;
  vec3 rl = vec3(0.0);
  vec3 mi = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float mu = dot(r, sun);
  float gg = G * G;
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mu * mu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * G, 1.5) * (2.0 + gg));
  for (int i = 0; i < IS; i++) {
    vec3 ip = r0 + r * (t + step * 0.5);
    float h = length(ip) - R_PLANET;
    float dR = exp(-h / SH_RLH) * step;
    float dM = exp(-h / SH_MIE) * step;
    odR += dR;
    odM += dM;
    float js = rsi(ip, sun, R_ATMOS).y / float(JS);
    float jt = 0.0;
    float jR = 0.0;
    float jM = 0.0;
    for (int j = 0; j < JS; j++) {
      vec3 jp = ip + sun * (jt + js * 0.5);
      float jh = length(jp) - R_PLANET;
      jR += exp(-jh / SH_RLH) * js;
      jM += exp(-jh / SH_MIE) * js;
      jt += js;
    }
    vec3 attn = exp(-(K_MIE * 1.1 * (odM + jM) + K_RLH * (odR + jR)));
    rl += dR * attn;
    mi += dM * attn;
    t += step;
  }
  vec3 col = I_SUN * (pR * K_RLH * rl + pM * K_MIE * mi);
  // Sun disc, reddened by the air it shines through, limb-darkened
  vec3 trans = exp(-(K_MIE * 1.1 * odM + K_RLH * odR));
  float cosA = dot(r, sun);
  float disc = smoothstep(0.99996, 0.999985, cosA);
  if (!ground && below <= 0.0) col += trans * disc * 900.0 * (0.6 + 0.4 * smoothstep(0.99996, 1.0, cosA));
  col *= mix(1.0, 0.3, below);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createAtmosphere(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Atmosphere {
  const sky = new THREE.Mesh(
    new THREE.BoxGeometry(100, 100, 100),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uSun: { value: SUN_DIR } },
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: SKY_FRAG,
    }),
  );

  const skyScene = new THREE.Scene();
  skyScene.add(sky);
  const cubeRt = new THREE.WebGLCubeRenderTarget(256, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const cubeCam = new THREE.CubeCamera(1, 2000, cubeRt);
  cubeCam.update(renderer, skyScene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(cubeRt.texture).texture;
  pmrem.dispose();
  sky.geometry.dispose();
  sky.material.dispose();

  scene.background = cubeRt.texture;
  scene.environment = env;
  scene.environmentIntensity = 0.8;

  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  sun.castShadow = true;
  // A tight shadow box that rides with the suit: self-shadowing and the
  // suit's own shadow on the ground or the sea when it flies low
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -6;
  sc.right = 6;
  sc.top = 6;
  sc.bottom = -6;
  sc.near = 1;
  sc.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  return {
    sun,
    skyCube: cubeRt.texture,
    envMap: env,
    uniforms: {
      uSkyCube: { value: cubeRt.texture },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: SUN_COLOR.clone().multiplyScalar(SUN_INTENSITY) },
      uFogDensity: { value: FOG_DENSITY },
      uFogFalloff: { value: FOG_FALLOFF },
    },
  };
}
