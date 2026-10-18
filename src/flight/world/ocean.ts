import * as THREE from 'three';
import { withLogDepth } from '../render/depth';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { TERRAIN_SAMPLE_GLSL, type Heightfield } from './heightfield';

/**
 * The Pacific: a polar grid that rides under the eye (dense underfoot,
 * kilometres apart at the horizon), displaced by a sum of Gerstner swells
 * rolling in from the south-west. Shaded with Fresnel reflection of the real
 * sky cube, a sun glitter path that widens toward the horizon, light
 * absorbed with depth (turquoise over the sand shelf, ink offshore — the
 * depth comes from the same heightfield as the land) and surf where it
 * shoals against the beaches.
 */

/** [direction (deg, travel toward), wavelength (m), steepness]. */
const WAVES: ReadonlyArray<readonly [number, number, number]> = [
  [-62, 96, 0.13],
  [-80, 61, 0.15],
  [-48, 37, 0.14],
  [-95, 23, 0.12],
  [-70, 14, 0.1],
  [-35, 8.5, 0.08],
];

const WAVES_GLSL = (() => {
  const lines = WAVES.map(([deg, len, steep]) => {
    const a = (deg * Math.PI) / 180;
    const k = (2 * Math.PI) / len;
    const c = Math.sqrt(9.81 / k);
    const amp = steep / k / WAVES.length;
    return `  gerstner(p, vec2(${Math.cos(a).toFixed(4)}, ${Math.sin(a).toFixed(4)}), ${k.toFixed(5)}, ${(c * k).toFixed(5)}, ${amp.toFixed(5)}, ${(steep / WAVES.length).toFixed(5)}, fade, disp, tx, tz);`;
  });
  return /* glsl */ `
void gerstner(vec2 p, vec2 dir, float k, float w, float amp, float q, float fade, inout vec3 disp, inout vec3 tx, inout vec3 tz) {
  float ph = k * dot(dir, p) - w * uTime;
  float s = sin(ph);
  float c = cos(ph);
  float a = amp * fade;
  disp += vec3(dir.x * a * c, a * s, dir.y * a * c);
  float qa = q * fade;
  // Tangent frame (for the normal): derivatives of the displaced surface
  tx += vec3(-dir.x * dir.x * qa * s, dir.x * qa * c, -dir.x * dir.y * qa * s);
  tz += vec3(-dir.x * dir.y * qa * s, dir.y * qa * c, -dir.y * dir.y * qa * s);
}
vec3 waves(vec2 p, float fade, out vec3 n, out float crest) {
  vec3 disp = vec3(0.0);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
${lines.join('\n')}
  n = normalize(cross(tz, tx));
  // Folding (Jacobian) — where crests sharpen toward breaking
  crest = clamp(1.0 - tx.x * tz.z, 0.0, 1.0);
  return disp;
}
`;
})();

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uEye;
varying vec3 vWorld;
varying vec2 vFlat;
varying float vFade;
${WAVES_GLSL}
void main() {
  vec2 p = position.xz + uEye.xz;
  float d = length(position.xz);
  // Swell only where it can be seen; the far sea is a flat mirror
  float fade = 1.0 - smoothstep(600.0, 3500.0, d);
  vec3 n;
  float crest;
  vec3 disp = waves(p, fade, n, crest);
  vec3 world = vec3(p.x, 0.0, p.y) + disp;
  vWorld = world;
  vFlat = p;
  vFade = fade;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec2 vFlat;
varying float vFade;
${TERRAIN_SAMPLE_GLSL}
${ATMOSPHERE_GLSL}
${WAVES_GLSL}
vec2 rippleGrad(vec2 p, float scale, vec2 drift, float rot) {
  // Rotated so the noise lattice never lines up into a grid
  vec2 q = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * p;
  vec2 uv = q / scale + drift * uTime;
  float e = 1.0 / 256.0;
  float h = texture2D(uDetail, uv).r;
  vec2 gq = vec2(texture2D(uDetail, uv + vec2(e, 0.0)).r - h, texture2D(uDetail, uv + vec2(0.0, e)).r - h) / (e * scale);
  return mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * gq;
}
void main() {
  vec3 V = cameraPosition - vWorld;
  float dist = length(V);
  V /= dist;
  vec3 n;
  float crest;
  waves(vFlat, vFade, n, crest);
  // Wind ripples on the swell, fading out with distance
  float rk = 1.0 - smoothstep(25.0, 420.0, dist);
  vec2 g = rippleGrad(vFlat, 9.0, vec2(0.021, -0.034), 0.61) * 0.5 + rippleGrad(vFlat, 3.1, vec2(-0.05, -0.03), 2.2) * 0.28 + rippleGrad(vFlat, 1.3, vec2(0.04, 0.07), 4.0) * 0.12;
  n = normalize(n + vec3(-g.x, 0.0, -g.y) * rk);

  float ground = terrainHeight(vFlat);
  float depth = max(vWorld.y - ground, 0.0);
  vec4 bake = texture2D(uBake, vFlat / uWorld + 0.5);
  float sunVis = bake.r;

  // Reflection: the sky (Fresnel), with the glitter path
  float ndv = max(dot(n, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 refl = textureLod(uSkyCube, R, 0.6).rgb;
  vec3 L = uSunDir;
  vec3 Hh = normalize(L + V);
  // Rougher (wider glitter) the further away the facets are averaged
  float power = mix(520.0, 70.0, smoothstep(20.0, 5000.0, dist));
  float spec = pow(max(dot(n, Hh), 0.0), power) * (power + 8.0) / 25.0;
  vec3 sunSpec = uSunColor * min(spec * 0.4, 30.0) * sunVis;

  // Under the surface: seabed seen through absorbing water, and the blue
  // light the water scatters back up
  float ndl = max(dot(n, L), 0.0);
  vec3 skyAmb = textureLod(uSkyCube, vec3(0.0, 1.0, 0.0), 6.0).rgb;
  vec3 absorb = exp(-depth * vec3(0.5, 0.11, 0.075));
  vec3 seabed = vec3(0.42, 0.36, 0.26) * (uSunColor * 0.16 * sunVis + skyAmb * 0.55);
  vec3 scatter = vec3(0.004, 0.028, 0.045) * (skyAmb * 1.6 + uSunColor * 0.05 * sunVis);
  // Backlit crests glow green-blue
  float sss = pow(max(dot(-V, L) * 0.5 + 0.5, 0.0), 4.0) * crest * 0.6 + crest * 0.08;
  vec3 body = seabed * absorb + scatter * (1.0 - absorb.g) + vec3(0.02, 0.09, 0.08) * sss * (uSunColor.r * 0.3);
  vec3 col = mix(body, refl, F) + sunSpec;

  // Surf: foam where the swell shoals, streaked and drifting
  float foamTex = texture2D(uDetail, vFlat / 23.0 + vec2(uTime * 0.012, uTime * -0.02)).r * 0.5 + 0.5;
  float foamTex2 = texture2D(uDetail, vFlat / 7.0 - vec2(uTime * 0.03, 0.0)).r * 0.5 + 0.5;
  float surge = 0.5 + 0.5 * sin(uTime * 0.9 - depth * 1.3 + foamTex * 3.0);
  float shore = smoothstep(2.2, 0.0, depth) * smoothstep(0.35, 0.75, foamTex * 0.6 + foamTex2 * 0.4 + surge * 0.3);
  float caps = smoothstep(0.55, 0.9, crest + foamTex2 * 0.25) * 0.5 * vFade;
  float foam = clamp(shore + caps, 0.0, 1.0);
  vec3 foamCol = vec3(0.85) * (uSunColor * 0.22 * sunVis * (0.4 + 0.6 * ndl) + skyAmb * 0.9);
  col = mix(col, foamCol, foam);

  col = applyHaze(col, cameraPosition, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
`;

function polarGrid(segments: number): THREE.BufferGeometry {
  const radii: number[] = [0];
  let r = 1.5;
  while (r < 120000) {
    radii.push(r);
    r *= 1.055;
  }
  const pos: number[] = [];
  for (const rad of radii) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < radii.length - 1; k++) {
    for (let s = 0; s < segments; s++) {
      const a = k * segments + s;
      const b = k * segments + ((s + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(field: Heightfield, atmosphere: Record<string, THREE.IUniform>) {
    this.uniforms = {
      ...field.uniforms,
      ...atmosphere,
      uTime: { value: 0 },
      uEye: { value: new THREE.Vector3() },
    };
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: this.uniforms,
      }),
    );
    this.mesh = new THREE.Mesh(polarGrid(288), mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ocean';
    // Drawn after the land so most of it fails the depth test early
    this.mesh.renderOrder = 1;
  }

  update(eye: THREE.Vector3, time: number): void {
    (this.uniforms.uEye.value as THREE.Vector3).set(eye.x, 0, eye.z);
    this.uniforms.uTime.value = time;
  }

  /** Sea surface height at a point (the swell), for spray and splashes. */
  static heightAt(x: number, z: number, time: number): number {
    let y = 0;
    for (const [deg, len, steep] of WAVES) {
      const a = (deg * Math.PI) / 180;
      const k = (2 * Math.PI) / len;
      const w = Math.sqrt(9.81 / k) * k;
      y += (steep / k / WAVES.length) * Math.sin(k * (Math.cos(a) * x + Math.sin(a) * z) - w * time);
    }
    return y;
  }
}
