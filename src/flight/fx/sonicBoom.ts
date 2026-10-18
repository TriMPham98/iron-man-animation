import * as THREE from 'three';
import { withLogDepth } from '../render/depth';

/**
 * Breaking the sound barrier, as you'd see it: the Prandtl–Glauert vapour
 * cone (air expanding round the body drops below its dew point and fogs,
 * right up to the shock, where it snaps clear — a bell of cloud with a
 * soft, streaming front and a knife-sharp rim at the back), and the shock
 * front itself left hanging in the air where the suit went through,
 * opening out as a thin ring of disturbed air.
 *
 * Also owns *when* that happens: Mach 1 with hysteresis, so a suit
 * hovering on the barrier doesn't boom again every time the needle
 * wobbles across it.
 */

const CONE_VERT = /* glsl */ `
uniform float uTime;
uniform float uSpread;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vUv = uv;
  // The bell breathes: a little ragged swelling round the rim, streaming back
  float wob = vnoise(vec2(uv.x * 9.0, uv.y * 2.0 - uTime * 3.0)) - 0.5;
  vec3 p = position;
  vec2 radial = normalize(p.xz + 1e-5);
  p.xz += radial * (wob * 0.12 * uv.y + uSpread * uv.y);
  p.y *= 1.0 + uSpread * 0.4;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vPosW = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const CONE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s;
}
void main() {
  float along = vUv.y;
  // Streaks blown back along the body, wrapping seamlessly round it
  float ang = vUv.x * 48.0;
  float n = fbm(vec2(ang, along * 3.0 - uTime * 7.0));
  float fine = vnoise(vec2(vUv.x * 160.0, along * 14.0 - uTime * 20.0));
  // Soft, ragged front; thickening toward the back …
  float front = smoothstep(0.0, 0.7, along + (n - 0.5) * 0.35);
  // … to a hard rim at the shock, where the cloud ends at once
  float rim = 1.0 - smoothstep(0.9, 0.985, along + (fine - 0.5) * 0.03);
  float edge = exp(-pow((along - 0.93) / 0.05, 2.0)) * 0.6;
  float dens = front * rim * (0.55 + 0.6 * n) + edge * rim;
  // Seen edge-on the shell is a longer path through the fog
  vec3 v = normalize(cameraPosition - vPosW);
  vec3 nrm = normalize(vNormalW);
  float graze = 1.0 - abs(dot(nrm, v));
  dens *= 0.3 + 0.9 * graze * graze;
  // Sunlit cloud, a cool grey in its own shade, a bright forward-scatter glint
  float lit = 0.5 + 0.5 * dot(nrm, uSunDir);
  float fwd = pow(max(0.0, dot(-v, uSunDir)), 6.0);
  vec3 col = mix(vec3(0.66, 0.71, 0.78), vec3(1.0, 0.98, 0.94), lit) + fwd * 0.35;
  float a = clamp(dens * uAlpha, 0.0, 0.85);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
}
`;

const RING_VERT = /* glsl */ `
varying vec2 vP;
varying vec3 vPosW;
void main() {
  vP = position.xy;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPosW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const RING_FRAG = /* glsl */ `
uniform float uAge;
uniform float uAlpha;
uniform vec3 uSunDir;
varying vec2 vP;
varying vec3 vPosW;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  // Unit quad: r = 1 is the front's current radius
  float r = length(vP);
  float ang = atan(vP.y, vP.x);
  float jag = h(vec2(floor(ang * 40.0), 3.0)) * 0.02;
  float w = 0.035 + 0.05 * uAge;
  float ring = exp(-pow((r - 0.96 + jag) / w, 2.0));
  // A faint wake of fogged air inside it, thinning as it opens
  float wake = smoothstep(1.0, 0.2, r) * 0.18 * (1.0 - uAge);
  float a = (ring + wake) * uAlpha;
  if (a < 0.003) discard;
  float lit = 0.75 + 0.25 * uSunDir.y;
  gl_FragColor = vec4(vec3(0.92, 0.94, 0.97) * lit, clamp(a, 0.0, 0.7));
}
`;

const UP = new THREE.Vector3(0, 1, 0);

/** Least time between two booms (s). */
const REARM_TIME = 4;
/** Mach number the suit must drop back under before it can boom again. */
const REARM_MACH = 0.94;

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  age: number;
}

export class SonicBoomFx {
  readonly group = new THREE.Group();
  private readonly cone: THREE.Mesh;
  private readonly coneMat: THREE.ShaderMaterial;
  private readonly rings: Ring[] = [];
  private readonly ringGeo = new THREE.PlaneGeometry(2, 2);
  private armed = true;
  private sinceBoom = 99;
  /** The vapour burst at the crossing (1 → 0). */
  private burst = 0;
  private time = 0;
  private readonly dir = new THREE.Vector3(0, 0, 1);
  private readonly _q = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();

  constructor(private readonly atmo: Record<string, THREE.IUniform>) {
    // A bell: narrow at the chest, flaring back to the shock rim
    const pts: THREE.Vector2[] = [];
    const L = 3.6;
    for (let i = 0; i <= 18; i++) {
      const u = i / 18;
      pts.push(new THREE.Vector2(0.3 + 2.0 * Math.pow(u, 0.62), u * L));
    }
    const geo = new THREE.LatheGeometry(pts, 56);
    this.coneMat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: CONE_VERT,
        fragmentShader: CONE_FRAG,
        uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uSpread: { value: 0 }, uSunDir: atmo.uSunDir ?? { value: new THREE.Vector3(0, 1, 0) } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.cone = new THREE.Mesh(geo, this.coneMat);
    this.cone.frustumCulled = false;
    this.cone.visible = false;
    this.cone.renderOrder = 2;
    this.group.add(this.cone);
  }

  /** Did the suit just go through the barrier? (Call once per frame.) */
  crossed(mach: number, dt: number): boolean {
    this.sinceBoom += dt;
    if (mach < REARM_MACH && this.sinceBoom > REARM_TIME) this.armed = true;
    if (this.armed && mach >= 1.0) {
      this.armed = false;
      this.sinceBoom = 0;
      return true;
    }
    return false;
  }

  /** The shock goes off here, the suit flying along `vel`. */
  boom(at: THREE.Vector3, vel: THREE.Vector3): void {
    this.burst = 1;
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: { uAge: { value: 0 }, uAlpha: { value: 1 }, uSunDir: this.atmo.uSunDir ?? { value: new THREE.Vector3(0, 1, 0) } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.position.copy(at);
    // Facing along the flight path: the front opens across it
    const d = this._v.copy(vel).normalize();
    if (d.lengthSq() < 0.5) d.set(0, 0, 1);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
    this.group.add(mesh);
    this.rings.push({ mesh, mat, age: 0 });
  }

  /** Follow the suit (drawn position) and age everything. */
  update(dt: number, at: THREE.Vector3, vel: THREE.Vector3, mach: number): void {
    this.time += dt;
    // The cone hangs on while the suit sits in the transonic band, and
    // blooms for a moment as it goes through
    const band = Math.exp(-Math.pow((mach - 1.0) / 0.035, 2));
    this.burst = Math.max(0, this.burst - dt / 1.1);
    const flash = this.burst > 0.8 ? 1 : Math.pow(this.burst / 0.8, 1.6);
    const alpha = Math.max(band * 0.7, flash);
    const speed = vel.length();
    this.cone.visible = alpha > 0.01 && speed > 50;
    if (this.cone.visible) {
      // Lathe +Y runs back from the chest along the wake
      this.dir.copy(vel).multiplyScalar(-1 / speed);
      this._q.setFromUnitVectors(UP, this.dir);
      this.cone.quaternion.copy(this._q);
      this.cone.position.copy(at).addScaledVector(this.dir, -0.75);
      this.coneMat.uniforms.uAlpha.value = alpha * 1.15;
      this.coneMat.uniforms.uTime.value = this.time;
      // As it fades the cloud loosens and spreads
      this.coneMat.uniforms.uSpread.value = (1 - flash) * this.burst * 0.6;
    }
    for (const r of this.rings) {
      r.age += dt;
      const T = 0.9;
      const k = r.age / T;
      // Fast, then slowing as it weakens
      const R = 2 + 70 * (1 - Math.pow(1 - Math.min(1, k), 2.2));
      r.mesh.scale.setScalar(R);
      r.mat.uniforms.uAge.value = Math.min(1, k);
      r.mat.uniforms.uAlpha.value = Math.pow(Math.max(0, 1 - k), 1.5) * 0.8;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      if (r.age > 0.9) {
        this.group.remove(r.mesh);
        r.mat.dispose();
        this.rings.splice(i, 1);
      }
    }
  }
}
