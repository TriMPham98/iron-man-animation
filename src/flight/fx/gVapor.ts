import * as THREE from 'three';
import { withLogDepth } from '../render/depth';
import type { Suit } from '../../suit/Suit';
import type { BoneName } from '../../suit/rig';

/**
 * Pulling g in wet air, the way a fighter's wings fog up in a hard bank:
 * the lifting side of the body (the back, in flight) drops below its dew
 * point and a sheet of vapour forms off the shoulders and streams aft
 * past the hips, flickering as the load comes and goes; and from the
 * "wingtips" — the trailing hands and the toes — thin vortex threads are
 * left hanging in the air for a moment behind the suit.
 *
 * Cheap: one small curved sheet (one draw) and four camera-facing ribbons
 * (one draw each, a few dozen vertices rewritten per frame).
 */

const SHEET_VERT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPosW = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SHEET_FRAG = /* glsl */ `
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
void main() {
  // u across the back (0–1), v aft from the shoulders (0) past the hips (1)
  float across = abs(vUv.x - 0.5) * 2.0;
  float aft = vUv.y;
  // Streaks blown aft at speed, a finer grain racing through them
  float n = vnoise(vec2(vUv.x * 14.0, aft * 3.0 - uTime * 16.0)) * 0.7 + vnoise(vec2(vUv.x * 40.0, aft * 9.0 - uTime * 30.0)) * 0.3;
  // Forms just behind the leading edge (the shoulders), thins out ragged aft
  float onset = smoothstep(0.0, 0.14, aft);
  float tail = 1.0 - smoothstep(0.35, 1.0, aft + (n - 0.5) * 0.5);
  float sides = 1.0 - smoothstep(0.55, 1.0, across + (n - 0.5) * 0.3);
  float dens = onset * tail * sides * smoothstep(0.2, 0.85, n) * 1.3;
  vec3 v = normalize(cameraPosition - vPosW);
  vec3 nrm = normalize(vNormalW);
  float lit = 0.55 + 0.45 * abs(dot(nrm, uSunDir));
  float fwd = pow(max(0.0, dot(-v, uSunDir)), 6.0);
  vec3 col = mix(vec3(0.68, 0.73, 0.8), vec3(1.0, 0.99, 0.96), lit) + fwd * 0.3;
  float a = clamp(dens * uAlpha, 0.0, 0.8);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}
`;

const RIBBON_VERT = /* glsl */ `
attribute float aAge;
attribute float aK;
attribute float aSide;
varying float vAge;
varying float vK;
varying float vSide;
void main() {
  vAge = aAge;
  vK = aK;
  vSide = aSide;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const RIBBON_FRAG = /* glsl */ `
uniform float uSeed;
varying float vAge;
varying float vK;
varying float vSide;
float h(float x) { return fract(sin(x * 91.7 + uSeed) * 43758.5453); }
void main() {
  float core = exp(-vSide * vSide * 3.5);
  // Starts at the tip, then thins and breaks up as the vortex decays. A
  // thread swept back through the eye (a hard pull, the tips trailing past
  // the chase camera) interpolates its age a hair past 1 by the near plane:
  // clamp it, or pow() goes NaN and the bloom smears it over the frame
  float age = clamp(vAge, 0.0, 1.0);
  float start = smoothstep(0.0, 0.06, age);
  float life = pow(1.0 - age, 1.6);
  float breakup = mix(1.0, 0.4 + 0.6 * h(floor(age * 24.0)), age);
  float a = core * start * life * breakup * vK * 0.32;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), a);
}
`;

/** Ribbon length in time (s): how long a vortex thread stays visible. */
const THREAD_LIFE = 0.14;
const THREAD_POINTS = 64;

interface Thread {
  bone: BoneName;
  at: [number, number, number];
  t: Float32Array;
  k: Float32Array;
  p: Float32Array;
  n: number;
  head: number;
  geo: THREE.BufferGeometry;
  mesh: THREE.Mesh;
}

export class GVaporFx {
  readonly group = new THREE.Group();
  private readonly sheet: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly threads: Thread[] = [];
  private time = 0;
  private level = 0;
  private readonly _o = new THREE.Vector3();
  private readonly _x = new THREE.Vector3();
  private readonly _y = new THREE.Vector3();
  private readonly _z = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();

  constructor(
    suit: Suit,
    atmo: Record<string, THREE.IUniform>,
  ) {
    // The sheet, in the chest's bind frame (Y up the body, −Z out of the
    // back): from the tops of the shoulders aft past the hips, standing a
    // little proud of the plating and wrapping round the sides
    const geo = new THREE.PlaneGeometry(1, 1, 12, 10);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const u = uv.getX(i);
      const v = 1 - uv.getY(i);
      uv.setY(i, v);
      const x = (u - 0.5) * 0.66;
      const y = 1.58 - v * 0.8;
      const c = x / 0.33;
      // Off the back, curling round the flanks, lifting clear toward the tail
      const z = -0.2 - 0.03 * v - 0.05 * v * v + 0.13 * c * c;
      pos.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: SHEET_VERT,
        fragmentShader: SHEET_FRAG,
        uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uSunDir: atmo.uSunDir ?? { value: new THREE.Vector3(0, 1, 0) } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.sheet = new THREE.Mesh(geo, mat);
    this.sheet.matrixAutoUpdate = false;
    this.sheet.frustumCulled = false;
    this.sheet.visible = false;
    this.sheet.renderOrder = 6;
    this.group.add(this.sheet);

    // Vortex threads off the trailing tips: both hands, both toes
    const tips: Array<{ bone: BoneName; at: [number, number, number] }> = [
      ...suit.palms.slice(0, 2).map((p) => ({ bone: p.bone, at: [p.at[0], p.at[1], p.at[2]] as [number, number, number] })),
      { bone: 'foot.L', at: [0.165, 0.01, 0.17] },
      { bone: 'foot.R', at: [-0.165, 0.01, 0.17] },
    ];
    tips.forEach((tip, i) => {
      const g = new THREE.BufferGeometry();
      const V = THREAD_POINTS * 2;
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aAge', new THREE.BufferAttribute(new Float32Array(V), 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aK', new THREE.BufferAttribute(new Float32Array(V), 1).setUsage(THREE.DynamicDrawUsage));
      const side = new Float32Array(V);
      for (let j = 0; j < THREAD_POINTS; j++) {
        side[j * 2] = -1;
        side[j * 2 + 1] = 1;
      }
      g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
      const idx: number[] = [];
      for (let j = 0; j < THREAD_POINTS - 1; j++) {
        const a = j * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      g.setIndex(idx);
      g.setDrawRange(0, 0);
      const m = withLogDepth(
        new THREE.ShaderMaterial({
          vertexShader: RIBBON_VERT,
          fragmentShader: RIBBON_FRAG,
          uniforms: { uSeed: { value: i * 17.3 } },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 6;
      this.group.add(mesh);
      this.threads.push({
        ...tip,
        t: new Float32Array(THREAD_POINTS),
        k: new Float32Array(THREAD_POINTS),
        p: new Float32Array(THREAD_POINTS * 3),
        n: 0,
        head: 0,
        geo: g,
        mesh,
      });
    });
  }

  /**
   * After the suit is posed. `g` = felt load (g), `flight` = 0 hover … 1
   * flying, `alt` = height (m) for the humidity.
   */
  update(dt: number, suit: Suit, cam: THREE.Camera, g: number, speed: number, flight: number, alt: number): void {
    this.time += dt;
    const t = this.time;
    // Wet low air fogs readily; high up it takes far more load
    const humid = Math.exp(-Math.max(0, alt) / 4000);
    const goal = THREE.MathUtils.smoothstep(g, 3.5, 8) * THREE.MathUtils.smoothstep(speed, 90, 170) * flight * (0.25 + 0.75 * humid);
    // Comes on as the load does, but lets go quick when it's off
    this.level += (goal - this.level) * (1 - Math.exp(-dt / (goal > this.level ? 0.12 : 0.08)));
    const k = this.level;

    // Sheet: on the chest bone
    const flick = 0.75 + 0.15 * Math.sin(t * 19.0) * Math.sin(t * 6.1 + 0.7) + 0.1 * Math.sin(t * 37.0 + 1.9);
    this.sheet.visible = k > 0.02;
    if (this.sheet.visible) {
      // The chest bone's bind → world map (points, so any suit scale carries)
      suit.boneWorldPoint('chest', [0, 0, 0], this._o);
      suit.boneWorldPoint('chest', [1, 0, 0], this._x).sub(this._o);
      suit.boneWorldPoint('chest', [0, 1, 0], this._y).sub(this._o);
      suit.boneWorldPoint('chest', [0, 0, 1], this._z).sub(this._o);
      this.sheet.matrix.makeBasis(this._x, this._y, this._z).setPosition(this._o);
      this.sheet.matrixWorld.copy(this.sheet.matrix);
      const u = this.sheet.material.uniforms;
      u.uAlpha.value = k * flick * 0.85;
      u.uTime.value = t;
    }

    // Threads: push the tips, age the rest, rebuild the strips
    const camPos = cam.getWorldPosition(this._s);
    for (const th of this.threads) {
      th.head = (th.head + 1) % THREAD_POINTS;
      th.n = Math.min(THREAD_POINTS, th.n + 1);
      const p = suit.boneWorldPoint(th.bone, th.at, this._a);
      th.t[th.head] = t;
      th.k[th.head] = k * (0.8 + 0.2 * flick);
      th.p[th.head * 3] = p.x;
      th.p[th.head * 3 + 1] = p.y;
      th.p[th.head * 3 + 2] = p.z;
      let any = false;
      let m = 0;
      const pos = th.geo.attributes.position as THREE.BufferAttribute;
      const age = th.geo.attributes.aAge as THREE.BufferAttribute;
      const kk = th.geo.attributes.aK as THREE.BufferAttribute;
      for (let j = 0; j < th.n; j++) {
        const i = (th.head - j + THREAD_POINTS) % THREAD_POINTS;
        const a = (t - th.t[i]) / THREAD_LIFE;
        if (a > 1) break;
        if (th.k[i] > 0.01) any = true;
        const i2 = j === 0 ? (th.head - 1 + THREAD_POINTS) % THREAD_POINTS : (i + 1) % THREAD_POINTS;
        // Along the thread (toward the newer neighbour) and across it, facing the eye
        const P = this._a.set(th.p[i * 3], th.p[i * 3 + 1], th.p[i * 3 + 2]);
        const along = this._b.set(th.p[i2 * 3], th.p[i2 * 3 + 1], th.p[i2 * 3 + 2]).sub(P);
        if (j === 0) along.negate();
        const across = this._x.crossVectors(along, this._y.copy(camPos).sub(P));
        const L = across.length();
        if (L < 1e-6) across.set(0, 1, 0);
        else across.divideScalar(L);
        const w = 0.025 + 0.16 * a;
        pos.setXYZ(m * 2, P.x - across.x * w, P.y - across.y * w, P.z - across.z * w);
        pos.setXYZ(m * 2 + 1, P.x + across.x * w, P.y + across.y * w, P.z + across.z * w);
        age.setX(m * 2, a);
        age.setX(m * 2 + 1, a);
        kk.setX(m * 2, th.k[i]);
        kk.setX(m * 2 + 1, th.k[i]);
        m++;
      }
      th.mesh.visible = any && m > 1;
      if (!th.mesh.visible) continue;
      th.geo.setDrawRange(0, (m - 1) * 6);
      pos.needsUpdate = age.needsUpdate = kk.needsUpdate = true;
    }
  }
}
