/**
 * GLSL value noise with analytic derivatives (after Inigo Quilez), and the
 * fractal sums the terrain is grown from. Shared by the heightfield
 * generator and anything else that needs the same lattice.
 */
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z) * 2.0 - 1.0;
}
// value, d/dx, d/dy
vec3 noised(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float vnoise(vec2 x) { return noised(x).x; }
const mat2 ROT2 = mat2(0.8, -0.6, 0.6, 0.8);
float fbm(vec2 p, int octaves) {
  float a = 0.0;
  float b = 0.5;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    a += b * vnoise(p);
    b *= 0.5;
    p = ROT2 * p * 2.03;
  }
  return a;
}
// Derivative-damped fbm: steep slopes suppress the finer octaves, which
// reads as erosion — sharp ridges, smooth valley floors.
float erodedFbm(vec2 p, int octaves) {
  float a = 0.0;
  float b = 1.0;
  vec2 d = vec2(0.0);
  for (int i = 0; i < 14; i++) {
    if (i >= octaves) break;
    vec3 n = noised(p);
    d += n.yz;
    a += b * n.x / (1.0 + dot(d, d));
    b *= 0.5;
    p = ROT2 * p * 2.0;
  }
  return a;
}
float ridged(vec2 p, int octaves) {
  float a = 0.0;
  float b = 0.5;
  float w = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(vnoise(p));
    n *= n;
    a += n * b * w;
    w = clamp(n * 1.8, 0.0, 1.0);
    b *= 0.5;
    p = ROT2 * p * 2.03;
  }
  return a;
}
`;
