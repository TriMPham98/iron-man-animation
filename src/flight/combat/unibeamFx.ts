import * as THREE from 'three';
import { withLogDepth } from '../render/depth';

/**
 * The unibeam as the film draws it: the arc reactor winds up to a hard
 * white glare in a cyan halo, then a thick beam — a white-hot core in a
 * cyan sheath that ripples outward along it, with a faint shimmering heat
 * haze round the lot — slams into whatever it meets in a white splash and
 * leaves the ground scorched. One ribbon draw for the beam (camera-facing,
 * the profile and the ripple are worked out per pixel), a handful of
 * sprites for the glare and the splash, and two instanced draws for the
 * scorch marks.
 */

const BEAM_VERT = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform vec2 uWidth; // half-width of the haze at A, at B (m)
attribute float aT;
attribute float aSide;
varying vec2 vUv;
varying float vLen;
varying float vView;
void main() {
  vec3 a = (viewMatrix * vec4(uA, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(uB, 1.0)).xyz;
  float len = length(uB - uA);
  // Keep both ends in front of the eye
  float ta = 0.0;
  if (a.z > -0.05) { float k = (-0.05 - b.z) / (a.z - b.z + 1e-5); ta = 1.0 - k; a = mix(b, a, k); }
  if (b.z > -0.05) b = mix(a, b, (-0.05 - a.z) / (b.z - a.z + 1e-5));
  vec3 dir = b - a;
  float l = length(dir);
  dir = l > 1e-5 ? dir / l : vec3(0.0, 1.0, 0.0);
  float t = aT;
  vec3 mid = mix(a, b, t);
  vec3 side = normalize(cross(dir, normalize(mid)));
  float w = mix(uWidth.x, uWidth.y, mix(ta, 1.0, t));
  // Round the far end off by pushing it out half a width
  vec3 p = mid + side * aSide * w + dir * step(0.999, t) * w * 0.6;
  vUv = vec2(aSide, t);
  vLen = mix(ta, 1.0, t) * len;
  vView = -mid.z;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const BEAM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
uniform float uCore;   // core half-width as a share of the haze half-width
uniform float uSheath; // sheath half-width as a share
varying vec2 vUv;
varying float vLen;
varying float vView;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  float x = abs(vUv.x);
  // Ripples run outward along the beam; they blur into a steady sheath far
  // off (where they would only alias)
  float near = exp(-vView / 90.0);
  float s = vLen * 1.6 - uTime * 70.0;
  float ripple = 0.5 + 0.5 * sin(s + 2.0 * noise(vec2(vLen * 0.35, uTime * 3.0)));
  float shimmer = noise(vec2(vLen * 2.2 - uTime * 40.0, vUv.x * 3.0 + uTime * 6.0));
  float core = exp(-pow(x / uCore, 2.0) * 1.6);
  float sw = uSheath * (0.88 + 0.12 * mix(1.0, ripple, near));
  float sheath = exp(-pow(x / sw, 2.0) * 2.2);
  float edge = smoothstep(sw * 1.1, sw * 0.5, x) * smoothstep(sw * 0.25, sw * 0.8, x);
  float haze = exp(-x * x * 3.0) * (0.35 + 0.65 * shimmer) * 0.22;
  vec3 col = vec3(1.0) * core * 4.0
           + vec3(0.3, 0.8, 1.0) * sheath * (1.0 + 0.7 * mix(0.5, ripple, near))
           + vec3(0.6, 0.95, 1.0) * edge * 0.9 * mix(0.4, ripple, near)
           + vec3(0.3, 0.6, 1.0) * haze;
  // Hottest at the reactor, settling down the beam
  col *= 1.0 + 0.5 * exp(-vLen / 4.0);
  gl_FragColor = vec4(col * uPower, 1.0);
}
`;

const SEGS = 48;

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.12, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.3, 'rgba(160,230,255,0.45)');
  grad.addColorStop(0.65, 'rgba(70,170,255,0.12)');
  grad.addColorStop(1, 'rgba(40,120,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** Scorch: a charred patch with a ragged fringe (R) and its hot core (G). */
let scorchTex: THREE.Texture | null = null;
function scorchTexture(): THREE.Texture {
  if (scorchTex) return scorchTex;
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n - 0.5;
      const y = (j + 0.5) / n - 0.5;
      const a = Math.atan2(y, x);
      const r = Math.hypot(x, y) * 2 / (0.8 + 0.12 * Math.sin(a * 5 + 1) + 0.08 * Math.sin(a * 11));
      const k = Math.min(1, Math.max(0, (r - 0.15) / 0.85));
      // R: char (opacity); G: the hot core that glows while it cools
      const v = 1 - k * k * (3 - 2 * k);
      const o = (j * n + i) * 4;
      data[o] = Math.round(v * 0.88 * 255);
      data[o + 1] = Math.round(Math.max(0, 1 - r / 0.55) ** 2 * 255);
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  scorchTex = new THREE.DataTexture(data, n, n);
  scorchTex.needsUpdate = true;
  return scorchTex;
}

const SCORCH_MAX = 48;
const SCORCH_LIFE = 30;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class UnibeamFx {
  readonly group = new THREE.Group();
  private readonly beam: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly glare: THREE.Sprite;
  private readonly halo: THREE.Sprite;
  private readonly streak: THREE.Sprite;
  private readonly splash: THREE.Sprite;
  private readonly splashHalo: THREE.Sprite;
  private readonly scorch: THREE.InstancedMesh;
  /** Per mark: char opacity, ember heat. */
  private readonly fade: THREE.InstancedBufferAttribute;
  private readonly scorchAge = new Float32Array(SCORCH_MAX).fill(SCORCH_LIFE);
  private readonly scorchSize = new Float32Array(SCORCH_MAX);
  private readonly scorchPos: THREE.Vector3[] = Array.from({ length: SCORCH_MAX }, () => new THREE.Vector3());
  private readonly scorchN: THREE.Vector3[] = Array.from({ length: SCORCH_MAX }, () => new THREE.Vector3(0, 1, 0));
  private scorchNext = 0;
  private readonly lastScorch = new THREE.Vector3(Infinity, 0, 0);
  private time = 0;

  constructor() {
    this.group.name = 'unibeam';
    const g = new THREE.BufferGeometry();
    const t: number[] = [];
    const side: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= SEGS; i++) {
      // Segments bunched toward the reactor, where the beam is seen closest
      const u = Math.pow(i / SEGS, 2);
      t.push(u, u);
      side.push(-1, 1);
      if (i < SEGS) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(t.length * 3), 3));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setIndex(idx);
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: {
          uA: { value: new THREE.Vector3() },
          uB: { value: new THREE.Vector3() },
          uWidth: { value: new THREE.Vector2(0.6, 2) },
          uTime: { value: 0 },
          uPower: { value: 0 },
          uCore: { value: 0.16 },
          uSheath: { value: 0.42 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.beam = new THREE.Mesh(g, mat);
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 8;
    this.beam.visible = false;

    const sprite = (color: number) => {
      const s = new THREE.Sprite(
        withLogDepth(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })),
      );
      s.visible = false;
      s.renderOrder = 9;
      this.group.add(s);
      return s;
    };
    this.glare = sprite(0xffffff);
    this.halo = sprite(0x7fd8ff);
    this.streak = sprite(0x9fe6ff);
    this.splash = sprite(0xffffff);
    this.splashHalo = sprite(0x6cc8ff);

    // Scorch marks: char laid over the ground (premultiplied over) with the
    // embers of its hot core added on top, in one instanced draw
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(SCORCH_MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    plane.setAttribute('aFade', this.fade);
    this.scorch = new THREE.InstancedMesh(
      plane,
      withLogDepth(
        new THREE.ShaderMaterial({
          uniforms: { uMap: { value: scorchTexture() } },
          vertexShader: /* glsl */ `
            attribute vec2 aFade;
            varying vec2 vUv;
            varying vec2 vFade;
            void main() {
              vUv = uv;
              vFade = aFade;
              gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: /* glsl */ `
            uniform sampler2D uMap;
            varying vec2 vUv;
            varying vec2 vFade;
            void main() {
              vec4 t = texture2D(uMap, vUv);
              float a = t.r * vFade.x;
              vec3 ember = vec3(3.2, 1.1, 0.25) * t.g * vFade.y;
              gl_FragColor = vec4(vec3(0.035, 0.03, 0.026) * a + ember, a);
            }`,
          transparent: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
          toneMapped: false,
        }),
      ),
      SCORCH_MAX,
    );
    this.scorch.count = 0;
    this.scorch.frustumCulled = false;
    this.scorch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scorch.renderOrder = 2;
    this.group.add(this.beam, this.scorch);
  }

  /**
   * One frame. `charge` 0–1 winds the reactor up; `power` 0–1 is the beam
   * itself (from → to); `hit` is where it lands (null: it runs out in the air).
   */
  update(dt: number, from: THREE.Vector3, to: THREE.Vector3, charge: number, power: number, hit: boolean, camPos: THREE.Vector3): void {
    this.time += dt;
    const T = this.time;
    const flick = 0.92 + 0.08 * Math.sin(T * 53) * Math.sin(T * 31 + 1);

    // Reactor glare: a pulse that tightens as it charges, a wide halo and
    // an anamorphic streak across it once it fires
    const glow = Math.max(charge * charge, power);
    const show = glow > 0.01;
    this.glare.visible = this.halo.visible = show;
    this.streak.visible = power > 0.01;
    if (show) {
      const pulse = power > 0 ? 1 : 0.8 + 0.2 * Math.sin(T * (10 + 30 * charge));
      const seen = Math.max(1, from.distanceTo(camPos) / 12);
      this.glare.position.copy(from);
      this.glare.scale.setScalar((0.12 + 0.3 * glow * pulse + 0.25 * power) * seen);
      this.glare.material.color.setRGB(4, 4, 4).multiplyScalar(glow * flick);
      this.halo.position.copy(from);
      this.halo.scale.setScalar((0.3 + 0.6 * glow + 0.6 * power) * pulse * seen);
      this.halo.material.color.setRGB(0.45, 1.1, 1.8).multiplyScalar(glow * (0.6 + 0.4 * flick));
      this.streak.position.copy(from);
      this.streak.scale.set(5 * power * seen, 0.16 * power * seen, 1);
      this.streak.material.color.setRGB(1, 2, 3).multiplyScalar(power * flick);
    }

    // The beam
    this.beam.visible = power > 0.01;
    const u = this.beam.material.uniforms;
    if (this.beam.visible) {
      (u.uA.value as THREE.Vector3).copy(from);
      (u.uB.value as THREE.Vector3).copy(to);
      const len = from.distanceTo(to);
      // A little wider down range so it still reads as a bar of light far off
      (u.uWidth.value as THREE.Vector2).set(0.4 * power, (0.4 + len * 0.0012) * power);
      u.uTime.value = T;
      u.uPower.value = power * flick;
    }

    // Splash where it lands
    this.splash.visible = this.splashHalo.visible = power > 0.01;
    if (this.splash.visible) {
      const seen = Math.max(1, to.distanceTo(camPos) / 40);
      const jit = 0.8 + 0.4 * Math.random();
      this.splash.position.copy(to);
      this.splash.scale.setScalar((hit ? 2.4 : 1.2) * jit * seen * power);
      this.splash.material.color.setRGB(5, 5, 5);
      this.splashHalo.position.copy(to);
      this.splashHalo.scale.setScalar((hit ? 9 : 4) * (0.85 + 0.3 * Math.random()) * seen * power);
      this.splashHalo.material.color.setRGB(0.8, 1.8, 3);
    }

    // Scorch marks: char fades back to the ground; the embers cool fast
    let n = 0;
    for (let i = 0; i < SCORCH_MAX; i++) {
      const age = (this.scorchAge[i] += dt);
      if (age >= SCORCH_LIFE) continue;
      n = Math.max(n, i + 1);
    }
    this.scorch.count = n;
    for (let i = 0; i < n; i++) {
      const age = this.scorchAge[i];
      const live = age < SCORCH_LIFE;
      const s = live ? this.scorchSize[i] * Math.min(1, 0.4 + age * 6) : 0;
      _q.setFromUnitVectors(UP, this.scorchN[i]);
      _m.compose(this.scorchPos[i], _q, _s.set(s, 1, s));
      this.scorch.setMatrixAt(i, _m);
      // The char weathers away over the back half of its life; the core cools in seconds
      const char = live ? 1 - Math.min(1, Math.max(0, (age - SCORCH_LIFE * 0.5) / (SCORCH_LIFE * 0.5))) : 0;
      this.fade.setXY(i, char, live ? Math.exp(-age * 1.2) : 0);
    }
    this.scorch.instanceMatrix.needsUpdate = true;
    this.fade.needsUpdate = true;
  }

  /** Burn a mark where the beam digs in (spaced out as it sweeps). */
  scorchAt(at: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    if (at.distanceTo(this.lastScorch) < size * 0.45) {
      // Same spot: keep it fresh
      const i = (this.scorchNext + SCORCH_MAX - 1) % SCORCH_MAX;
      this.scorchAge[i] = Math.min(this.scorchAge[i], 0.2);
      return;
    }
    const i = this.scorchNext;
    this.scorchNext = (i + 1) % SCORCH_MAX;
    this.scorchAge[i] = 0;
    this.scorchSize[i] = size * (0.85 + 0.3 * Math.random());
    this.scorchPos[i].copy(at).addScaledVector(normal, 0.05);
    this.scorchN[i].copy(normal);
    this.lastScorch.copy(at);
  }
}
