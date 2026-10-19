import * as THREE from 'three';
import { withLogDepth } from '../render/depth';

/**
 * The sound barrier the way DCS draws it: no explosion at Mach 1, no
 * blast ring — just the transonic vapour cone (Prandtl–Glauert
 * condensation: air expanding round the body drops below its dew point
 * and fogs up to the shock, where it snaps clear). It flickers in and out
 * with every few knots through ~M 0.93–1.0, is thickest in the wet air
 * down low and all but absent up high, slides aft as the shock does, and
 * is gone once the suit is properly supersonic. The boom itself is only
 * ever heard from outside, when the Mach cone sweeps over the ear (see
 * Soundscape).
 *
 * Also owns *when* the barrier is crossed: Mach 1 with hysteresis, so a
 * suit hovering on it doesn't report a crossing every time the needle
 * wobbles.
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

const UP = new THREE.Vector3(0, 1, 0);

/** Least time between two booms (s). */
const REARM_TIME = 4;
/** Mach number the suit must drop back under before it can boom again. */
const REARM_MACH = 0.94;

export class SonicBoomFx {
  readonly group = new THREE.Group();
  private readonly cone: THREE.Mesh;
  private readonly coneMat: THREE.ShaderMaterial;
  private armed = true;
  private sinceBoom = 99;
  private time = 0;
  private readonly dir = new THREE.Vector3(0, 0, 1);
  private readonly _q = new THREE.Quaternion();

  constructor(atmo: Record<string, THREE.IUniform>) {
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

  /** Follow the suit (drawn position): the cone comes and goes with the Mach number. */
  update(dt: number, at: THREE.Vector3, vel: THREE.Vector3, mach: number): void {
    this.time += dt;
    const t = this.time;
    // On just short of the barrier, gone just past it
    const band = THREE.MathUtils.smoothstep(mach, 0.925, 0.97) * (1 - THREE.MathUtils.smoothstep(mach, 0.995, 1.035));
    // Wet sea air fogs readily; the dry air up high hardly at all
    const humid = Math.exp(-Math.max(0, at.y) / 3500);
    // It never sits still: the fog pops in and out as the flow round the
    // body hunts about the dew point
    const flutter = 0.6 + 0.25 * Math.sin(t * 23.0) * Math.sin(t * 7.3 + 1.1) + 0.15 * Math.sin(t * 41.0 + 2.3);
    const alpha = band * humid * flutter;
    const speed = vel.length();
    this.cone.visible = alpha > 0.01 && speed > 50;
    if (this.cone.visible) {
      // Lathe +Y runs back from the chest along the wake; the shock (and
      // the cloud's sharp back edge) creeps aft as the speed builds
      this.dir.copy(vel).multiplyScalar(-1 / speed);
      this._q.setFromUnitVectors(UP, this.dir);
      this.cone.quaternion.copy(this._q);
      const aft = THREE.MathUtils.clamp((mach - 0.93) / 0.07, 0, 1);
      this.cone.position.copy(at).addScaledVector(this.dir, -0.9 + 0.7 * aft);
      this.coneMat.uniforms.uAlpha.value = alpha * 1.1;
      this.coneMat.uniforms.uTime.value = t;
      // Past the barrier it loosens and thins before it lets go
      this.coneMat.uniforms.uSpread.value = 0.25 * THREE.MathUtils.smoothstep(mach, 0.99, 1.03);
    }
  }
}
