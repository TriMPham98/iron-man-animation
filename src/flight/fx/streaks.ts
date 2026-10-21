import * as THREE from 'three';
import { withLogDepth } from '../render/depth';

/**
 * Camera-facing glowing ribbons between two points, all in one instanced
 * draw: repulsor bolts, tracer rounds, the unibeam and targeting lasers.
 * Each frame the owners write their segments; nothing persists.
 */
const VERT = /* glsl */ `
attribute vec3 iA;
attribute vec3 iB;
attribute vec4 iColor;
attribute vec2 iWidth; // width at A, width at B
varying vec2 vUv;
varying float vCap;
varying vec4 vColor;
void main() {
  vec3 a = (viewMatrix * vec4(iA, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(iB, 1.0)).xyz;
  // Keep both ends in front of the eye
  if (a.z > -0.05) a = mix(b, a, (-0.05 - b.z) / (a.z - b.z + 1e-5));
  if (b.z > -0.05) b = mix(a, b, (-0.05 - a.z) / (b.z - a.z + 1e-5));
  vec3 dir = b - a;
  float len = length(dir);
  dir = len > 1e-5 ? dir / len : vec3(0.0, 1.0, 0.0);
  vec3 mid = mix(a, b, position.y);
  // Side vector perpendicular to the segment and the view ray
  vec3 side = normalize(cross(dir, normalize(mid)));
  float w = mix(iWidth.x, iWidth.y, position.y);
  // Caps: push the ends out along the segment by half a width
  vec3 p = mid + side * position.x * w + dir * (position.y - 0.5) * 2.0 * w * position.z;
  vUv = vec2(position.x, position.y);
  // −1 / +1 at the far edge of the A / B cap, 0 where the cap meets the body
  vCap = position.z * (position.y * 2.0 - 1.0);
  vColor = iColor;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vCap;
varying vec4 vColor;
void main() {
  // Round ends: across the body and out along the caps share one falloff,
  // so a streak shorter than it is wide is a dot, not a square
  float r2 = vUv.x * vUv.x + vCap * vCap;
  float core = exp(-r2 * 18.0);
  float halo = exp(-r2 * 3.5) * 0.45;
  gl_FragColor = vec4(vColor.rgb * (core * 1.6 + halo), 1.0) * vColor.a;
}
`;

const MAX = 2048;

export class Streaks {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly a: THREE.InstancedBufferAttribute;
  private readonly b: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly width: THREE.InstancedBufferAttribute;
  private n = 0;

  constructor() {
    const geo = new THREE.InstancedBufferGeometry();
    // A strip across (x −1…1) and along (y 0…1); z marks cap vertices
    const pos = new Float32Array([
      -1, 0, 1, 1, 0, 1, -1, 0.0, 0, 1, 0.0, 0, -1, 1.0, 0, 1, 1.0, 0, -1, 1, 1, 1, 1, 1,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6, 5, 7, 6]);
    const f = (k: number) => new THREE.InstancedBufferAttribute(new Float32Array(MAX * k), k).setUsage(THREE.DynamicDrawUsage);
    this.a = f(3);
    this.b = f(3);
    this.color = f(4);
    this.width = f(2);
    geo.setAttribute('iA', this.a);
    geo.setAttribute('iB', this.b);
    geo.setAttribute('iColor', this.color);
    geo.setAttribute('iWidth', this.width);
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }

  begin(): void {
    this.n = 0;
  }

  /** HDR colour (values > 1 bloom). */
  add(a: THREE.Vector3, b: THREE.Vector3, r: number, g: number, bl: number, alpha: number, wa: number, wb = wa): void {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.a.setXYZ(i, a.x, a.y, a.z);
    this.b.setXYZ(i, b.x, b.y, b.z);
    this.color.setXYZW(i, r, g, bl, alpha);
    this.width.setXY(i, wa, wb);
  }

  end(): void {
    this.geo.instanceCount = this.n;
    for (const at of [this.a, this.b, this.color, this.width]) at.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }
}
