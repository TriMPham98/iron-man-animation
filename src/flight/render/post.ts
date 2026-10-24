import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * The flight sim's frame: the scene into a 4× multisampled HDR target with a
 * float depth buffer (reversed-Z keeps 1 cm precision underfoot and the
 * mountains 30 km off from fighting), a quarter-resolution bloom, then one
 * full-screen pass for the camera: lens flare off the sun, a touch of
 * chromatic fringe at speed, vignette, damage and cloud white-out, ACES and
 * dithered output.
 */
export interface LensState {
  /** Sun position in UV (0–1) and how visible it is (0–1). */
  sunUv: THREE.Vector2;
  sunVis: number;
  /** Speed effect 0–1 (edge fringe, slight radial smear). */
  speed: number;
  /** Damage flash 0–1 (red edge pulse). */
  damage: number;
  /** In-cloud white-out 0–1. */
  cloud: number;
  /** Exposure multiplier (eye adaptation, flashbangs). */
  exposure: number;
  /** Helmet view: stronger vignette, visor tint. */
  helmet: number;
}

const FINAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uSunUv;
uniform float uSunVis;
uniform float uSpeed;
uniform float uDamage;
uniform float uCloud;
uniform float uExposure;
uniform float uHelmet;
uniform float uAspect;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c = IN * c;
  c = RRTAndODTFit(c);
  return clamp(OUT * c, 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// Soft disc ghost at a point along the flare axis
vec3 ghost(vec2 uv, vec2 at, float size, vec3 tint) {
  vec2 d = (uv - at) * vec2(uAspect, 1.0);
  float r = length(d) / size;
  return tint * smoothstep(1.0, 0.6, r) * (0.5 + 0.5 * smoothstep(0.4, 1.0, r));
}

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  // Chromatic fringe toward the edges at speed (and in the visor)
  float fr = (uSpeed * 0.0035 + uHelmet * 0.0012) * dot(c, c) * 4.0;
  vec3 hdr;
  hdr.r = texture2D(tScene, uv - c * fr).r;
  hdr.g = texture2D(tScene, uv).g;
  hdr.b = texture2D(tScene, uv + c * fr).b;
  hdr += texture2D(tBloom, uv).rgb;

  // Lens flare: ghosts strung through the centre opposite the sun
  if (uSunVis > 0.001) {
    vec2 axis = vec2(0.5) - uSunUv;
    vec3 f = vec3(0.0);
    f += ghost(uv, uSunUv + axis * 0.55, 0.035, vec3(0.9, 0.55, 0.25)) * 0.35;
    f += ghost(uv, uSunUv + axis * 0.85, 0.06, vec3(0.35, 0.6, 0.9)) * 0.18;
    f += ghost(uv, uSunUv + axis * 1.25, 0.022, vec3(0.6, 0.9, 0.5)) * 0.3;
    f += ghost(uv, uSunUv + axis * 1.6, 0.11, vec3(0.8, 0.45, 0.65)) * 0.09;
    f += ghost(uv, uSunUv + axis * 2.05, 0.045, vec3(0.9, 0.7, 0.4)) * 0.14;
    // Veiling glare round the sun itself and a faint anamorphic streak
    vec2 ds = (uv - uSunUv) * vec2(uAspect, 1.0);
    f += vec3(1.0, 0.75, 0.5) * 0.25 * exp(-length(ds) * 9.0);
    f += vec3(1.0, 0.7, 0.45) * 0.35 * exp(-abs(ds.y) * 140.0) * exp(-abs(ds.x) * 2.2);
    hdr += f * uSunVis;
  }

  // In a cloud: the world goes milky white
  hdr = mix(hdr, vec3(1.25, 1.2, 1.15), uCloud * 0.85);

  hdr *= uExposure;
  vec3 col = aces(hdr);

  // Vignette (heavier in the helmet), damage pulses red at the edges
  float r2 = dot(c * vec2(uAspect * 0.8, 1.0), c * vec2(uAspect * 0.8, 1.0));
  col *= mix(1.0, smoothstep(1.2, 0.15, r2), 0.45 + 0.35 * uHelmet);
  col = mix(col, vec3(0.75, 0.05, 0.03), uDamage * smoothstep(0.08, 0.6, r2) * 0.7);
  // Visor: a faint cool tint
  col = mix(col, col * vec3(0.92, 1.0, 1.06), uHelmet * 0.6);
  // Inside the helmet: the faceplate's rim, far too close to focus, closes
  // in on the corners of the view (the brow sags a touch at the middle);
  // the HUD projector lights its inner lip
  if (uHelmet > 0.001) {
    vec2 q = c * 2.0;
    q.y += 0.06 * (1.0 - q.x * q.x) * step(0.0, q.y);
    float d = pow(pow(abs(q.x) / 1.03, 3.2) + pow(abs(q.y) / 0.97, 3.2), 1.0 / 3.2);
    float rim = smoothstep(1.0, 1.3, d);
    vec3 shell = vec3(0.045, 0.028, 0.024) * (0.6 + 0.4 * smoothstep(1.5, 1.05, d));
    col = mix(col, shell, rim * uHelmet);
    col += vec3(0.25, 0.75, 0.9) * 0.018 * exp(-pow((d - 1.08) / 0.05, 2.0)) * uHelmet;
  }

  col = toSrgb(col);
  // Film grain / dither (kills banding in the sky gradients)
  col += (hash(uv * uRes + fract(uTime) * 61.0) - 0.5) / 255.0 * 2.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

const BRIGHT_PASS_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
vec3 tap(vec2 uv, inout float wsum) {
  vec3 c = texture2D(tDiffuse, uv).rgb;
  float w = 1.0 / (1.0 + luminance(c));
  wsum += w;
  return c * w;
}
void main() {
  // four bilinear taps one source pixel off-centre cover the 4×4 block
  vec2 px = 1.0 / vec2(textureSize(tDiffuse, 0));
  float wsum = 0.0;
  vec3 c = tap(vUv + vec2(-px.x, -px.y), wsum) + tap(vUv + vec2(px.x, -px.y), wsum)
         + tap(vUv + vec2(-px.x, px.y), wsum) + tap(vUv + vec2(px.x, px.y), wsum);
  c /= wsum;
  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, luminance(c));
  gl_FragColor = mix(vec4(defaultColor, defaultOpacity), vec4(c, 1.0), alpha);
}
`;

export class FlightPost {
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly bloom: UnrealBloomPass;
  private readonly final: FullScreenQuad;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private time = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    const depth = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: depth,
      depthBuffer: true,
    });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 1.3);
    // The glow is added in the final pass, so the pass's own last step (blend
    // it back over the scene) is skipped outright: drawn invisible, it still
    // rendered into the multisampled scene target and paid a full-resolution
    // resolve for nothing (~0.75 ms on an M1 Pro)
    const quad = (this.bloom as unknown as { fsQuad: FullScreenQuad }).fsQuad;
    const draw = quad.render.bind(quad);
    quad.render = (r) => {
      if (quad.material !== this.bloom.blendMaterial) draw(r);
    };
    // The bright pass reads the frame at quarter resolution, one tap per
    // texel: a lone glint off a wave crest or the armour (HDR in the
    // thousands) lands in a single texel and blurs out as a glowing square.
    // Gather the texel's whole 4×4 footprint instead, Karis-weighted, so
    // isolated sparkles average away while broad highlights (the sun, the
    // glitter path, the jets) bloom as before
    this.bloom.materialHighPassFilter.fragmentShader = BRIGHT_PASS_FRAG;
    this.bloom.materialHighPassFilter.needsUpdate = true;
    this.uniforms = {
      tScene: { value: this.rt.texture },
      tBloom: { value: this.bloom.renderTargetsHorizontal[0].texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uSunUv: { value: new THREE.Vector2() },
      uSunVis: { value: 0 },
      uSpeed: { value: 0 },
      uDamage: { value: 0 },
      uCloud: { value: 0 },
      uExposure: { value: 1 },
      uHelmet: { value: 0 },
      uAspect: { value: 1 },
    };
    this.final = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: FINAL_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.resize();
  }

  resize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.rt.setSize(size.x, size.y);
    // UnrealBloomPass halves again internally: quarter-resolution glow
    this.bloom.setSize(Math.round(size.x / 2), Math.round(size.y / 2));
    (this.uniforms.uRes.value as THREE.Vector2).copy(size);
    this.uniforms.uAspect.value = size.x / Math.max(1, size.y);
  }

  render(dt: number, lens: LensState): void {
    this.time += dt;
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(this.scene, this.camera);
    this.bloom.render(r, null as unknown as THREE.WebGLRenderTarget, this.rt, dt, false);
    const u = this.uniforms;
    u.uTime.value = this.time;
    (u.uSunUv.value as THREE.Vector2).copy(lens.sunUv);
    u.uSunVis.value = lens.sunVis;
    u.uSpeed.value = lens.speed;
    u.uDamage.value = lens.damage;
    u.uCloud.value = lens.cloud;
    u.uExposure.value = lens.exposure;
    u.uHelmet.value = lens.helmet;
    r.setRenderTarget(null);
    this.final.render(r);
  }
}
