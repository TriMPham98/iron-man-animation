import * as THREE from 'three';
import { withLogDepth } from '../render/depth';
import { RENDER_ORDER, sortFocus } from '../render/transparency';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { WORLD_SIZE } from './config';

/**
 * Fair-weather cumulus drifting over the coast at 1.4–2.6 km: each cloud a
 * cluster of soft puffs with a flat base, lit as rounded volumes — sunlit
 * tops, blue-grey undersides, a silver lining when the sun is behind them —
 * and fading into the haze. Sorted back to front and drawn in two instanced
 * calls split at the suit's distance — the puffs beyond it before the jet
 * plumes, the puffs between it and the eye after them — so a cloud behind
 * the suit never paints over its thrust (render/transparency). The camera
 * can fly straight through: puffs thin out as you reach them and the frame
 * goes milky white inside.
 */

interface Puff {
  p: THREE.Vector3;
  r: number;
  seed: number;
}

const VERT = /* glsl */ `
attribute vec4 iPuff; // xyz, radius
attribute float iSeed;
varying vec2 vUv;
varying float vFade;
varying float vHaze;
varying vec3 vHazeCol;
varying vec3 vCenterDir;
varying float vSeed;
varying float vBaseK;
uniform float uBase;
${ATMOSPHERE_GLSL}
void main() {
  vUv = uv;
  vSeed = iSeed;
  vec3 c = iPuff.xyz;
  float r = iPuff.w;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float dist = length(mv.xyz);
  // Thin out as the eye reaches the puff (no hard cut flying through)
  vFade = smoothstep(r * 0.45, r * 1.4, dist);
  mv.xy += position.xy * r * 2.0;
  vHaze = hazeAmount(cameraPosition, c);
  vHazeCol = hazeColor(normalize(c - cameraPosition));
  vCenterDir = normalize(c - cameraPosition);
  // How far down the cloud this puff sits (bases are darker)
  vBaseK = clamp((c.y - uBase) / 700.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSunView;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
varying vec2 vUv;
varying float vFade;
varying float vHaze;
varying vec3 vHazeCol;
varying vec3 vCenterDir;
varying float vSeed;
varying float vBaseK;
void main() {
  // Rotate the texture per puff
  float a = vSeed * 6.2831;
  vec2 uv = mat2(cos(a), -sin(a), sin(a), cos(a)) * (vUv - 0.5) + 0.5;
  vec4 tex = texture2D(uMap, uv);
  float density = tex.a;
  if (density * vFade < 0.01) discard;
  vec2 p = vUv * 2.0 - 1.0;
  float z = sqrt(max(0.0, 1.0 - dot(p, p)));
  vec3 n = normalize(vec3(p, z * 0.9 + 0.1));
  // Lambert-ish wrap toward the sun, darker underneath
  // Mostly the cloud's own height in the cluster, a little the puff's roundness
  float lit = mix(0.62, clamp(dot(n, uSunView) * 0.6 + 0.5, 0.0, 1.0), 0.45);
  lit *= mix(0.55, 1.0, vBaseK) * (0.75 + 0.25 * tex.r);
  // Forward scattering: bright rims looking toward the sun
  float mu = dot(vCenterDir, uSunDir);
  float silver = pow(max(mu, 0.0), 6.0) * (1.0 - density * 0.7) * 2.2 + pow(max(mu, 0.0), 2.0) * 0.35;
  vec3 amb = mix(uAmbBottom, uAmbTop, clamp(n.y * 0.5 + 0.5, 0.0, 1.0) * 0.6 + vBaseK * 0.4);
  vec3 col = amb + uSunCol * (lit * 0.85 + silver);
  col = mix(col, vHazeCol, vHaze);
  gl_FragColor = vec4(col, density * vFade * 0.8);
}
`;

function puffTexture(): THREE.Texture {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Tileable value-noise octaves → billowy fbm
  const lattices = [4, 8, 16, 32, 64].map((k) => ({ k, v: Float32Array.from({ length: k * k }, rnd) }));
  const noise = (u: number, v: number) => {
    let sum = 0;
    let amp = 0.5;
    for (const { k, v: lat } of lattices) {
      const x = u * k;
      const y = v * k;
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const at = (i: number, j: number) => lat[(((j % k) + k) % k) * k + (((i % k) + k) % k)];
      const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
      const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
      sum += amp * (a + (b - a) * sy);
      amp *= 0.5;
    }
    return sum / 0.97;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      // Billows: |noise| folded, eroding the edge of a soft disc
      const f = noise(u, v);
      const billow = 1 - Math.abs(f * 2 - 1);
      const body = Math.max(0, 1 - r * r) * (0.55 + 0.45 * billow);
      const a = Math.max(0, Math.min(1, (body - 0.18 * (1 - billow)) * 1.6));
      const i = (y * n + x) * 4;
      img.data[i] = Math.round(255 * Math.min(1, 0.55 + 0.45 * billow));
      img.data[i + 1] = img.data[i + 2] = img.data[i];
      img.data[i + 3] = Math.round(a * a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class Clouds {
  /** Puffs beyond the suit (the near ones are its child, {@link nearMesh}). */
  readonly mesh: THREE.Mesh;
  readonly nearMesh: THREE.Mesh;
  private readonly puffs: Puff[] = [];
  private readonly farGeo: THREE.InstancedBufferGeometry;
  private readonly nearGeo: THREE.InstancedBufferGeometry;
  private readonly iPuff: THREE.InstancedBufferAttribute;
  private readonly iSeed: THREE.InstancedBufferAttribute;
  private readonly nearPuff: THREE.InstancedBufferAttribute;
  private readonly nearSeed: THREE.InstancedBufferAttribute;
  /** Drifted puff centres + radii, unsorted. */
  private readonly raw: Float32Array;
  private readonly order: number[];
  private readonly keys: Float32Array;
  private readonly uniforms: Record<string, THREE.IUniform>;
  /** Wind drift (m/s). */
  private readonly drift = new THREE.Vector3(3.5, 0, -1.5);
  private readonly offset = new THREE.Vector3();

  constructor(atmosphere: Record<string, THREE.IUniform>) {
    let s = 4242;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const BASE = 1400;
    for (let c = 0; c < 70; c++) {
      const cx = (rnd() - 0.5) * WORLD_SIZE * 1.1;
      const cz = (rnd() - 0.5) * WORLD_SIZE * 1.1;
      const base = BASE + rnd() * 600;
      const size = 350 + rnd() * 700;
      const n = 14 + Math.floor(rnd() * 18);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * size;
        const up = rnd() * rnd() * size * 0.7;
        const rad = (0.25 + rnd() * 0.35) * size * (1 - (r / size) * 0.4);
        this.puffs.push({ p: new THREE.Vector3(cx + Math.cos(a) * r, base + up + rad * 0.35, cz + Math.sin(a) * r * 0.7), r: rad, seed: rnd() });
      }
    }
    const N = this.puffs.length;
    const quad = new THREE.PlaneGeometry(1, 1);
    const makeGeo = () => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = quad.index;
      geo.setAttribute('position', quad.getAttribute('position'));
      geo.setAttribute('uv', quad.getAttribute('uv'));
      const puff = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const seed = new THREE.InstancedBufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iPuff', puff);
      geo.setAttribute('iSeed', seed);
      geo.instanceCount = 0;
      return { geo, puff, seed };
    };
    const far = makeGeo();
    const near = makeGeo();
    this.farGeo = far.geo;
    this.nearGeo = near.geo;
    this.iPuff = far.puff;
    this.iSeed = far.seed;
    this.nearPuff = near.puff;
    this.nearSeed = near.seed;
    this.raw = new Float32Array(N * 4);
    this.order = this.puffs.map((_, i) => i);
    this.keys = new Float32Array(N);
    this.uniforms = {
      ...atmosphere,
      uMap: { value: puffTexture() },
      uSunView: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Color(1.55, 1.2, 0.86) },
      uAmbTop: { value: new THREE.Color(0.42, 0.5, 0.64) },
      uAmbBottom: { value: new THREE.Color(0.2, 0.22, 0.3) },
      uBase: { value: BASE },
    };
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.mesh = new THREE.Mesh(this.farGeo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.cloudsFar;
    this.mesh.name = 'clouds';
    // Same material, drawn after the plumes (a child: world adds only `mesh`)
    this.nearMesh = new THREE.Mesh(this.nearGeo, mat);
    this.nearMesh.frustumCulled = false;
    this.nearMesh.renderOrder = RENDER_ORDER.cloudsNear;
    this.nearMesh.name = 'clouds-near';
    this.mesh.add(this.nearMesh);
  }

  /** 0–1: how deep inside a cloud the eye is (post white-out). */
  update(dt: number, camera: THREE.Camera): number {
    this.offset.addScaledVector(this.drift, dt);
    const eye = camera.position;
    const sv = this.uniforms.uSunView.value as THREE.Vector3;
    sv.copy(this.uniforms.uSunDir.value as THREE.Vector3).transformDirection(camera.matrixWorldInverse);
    let inside = 0;
    const N = this.puffs.length;
    const half = WORLD_SIZE * 0.6;
    for (let i = 0; i < N; i++) {
      const p = this.puffs[i];
      // Drift with the wind, wrapping round the map
      let x = p.p.x + this.offset.x;
      let z = p.p.z + this.offset.z;
      x = ((((x + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
      z = ((((z + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
      this.raw[i * 4] = x;
      this.raw[i * 4 + 1] = p.p.y;
      this.raw[i * 4 + 2] = z;
      this.raw[i * 4 + 3] = p.r;
      const dx = x - eye.x;
      const dy = p.p.y - eye.y;
      const dz = z - eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      this.keys[i] = d2;
      const d = Math.sqrt(d2);
      if (d < p.r * 0.8) inside = Math.max(inside, 1 - d / (p.r * 0.8));
    }
    // Back to front, split at the suit: [far … | … near]
    this.order.sort((a, b) => this.keys[b] - this.keys[a]);
    const f = sortFocus.valid ? sortFocus.point.distanceToSquared(eye) : 0;
    let split = N;
    if (sortFocus.valid) {
      split = 0;
      while (split < N && this.keys[this.order[split]] >= f) split++;
    }
    const fp = this.iPuff.array as Float32Array;
    const fs = this.iSeed.array as Float32Array;
    const np = this.nearPuff.array as Float32Array;
    const ns = this.nearSeed.array as Float32Array;
    for (let o = 0; o < N; o++) {
      const i = this.order[o];
      const near = o >= split;
      const k = near ? o - split : o;
      (near ? np : fp).set(this.raw.subarray(i * 4, i * 4 + 4), k * 4);
      (near ? ns : fs)[k] = this.puffs[i].seed;
    }
    this.farGeo.instanceCount = split;
    this.nearGeo.instanceCount = N - split;
    this.mesh.visible = true;
    this.nearMesh.visible = split < N;
    this.iPuff.needsUpdate = this.iSeed.needsUpdate = true;
    if (split < N) this.nearPuff.needsUpdate = this.nearSeed.needsUpdate = true;
    return Math.min(1, inside * 1.6);
  }

}
