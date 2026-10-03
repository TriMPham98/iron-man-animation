import * as THREE from 'three';

export type BurstKind = 'sparks' | 'steam';

/** Platform top in suit-model space (the soles) and its radius. */
const DECK_Y = 0;
const DECK_R = 1.05;
/** Workshop floor below the platform edge (model space). */
const FLOOR_Y = -0.05;

const GRAVITY = 9.81;
/** Motion-blur window for spark streaks (s). */
const STREAK_SEC = 0.022;

interface Emitter {
  kind: BurstKind;
  at: THREE.Vector3;
  dir: THREE.Vector3 | null;
  remaining: number;
  /** Particles per second. */
  rate: number;
  acc: number;
}

const SPARK_HEAD_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(1.5, aSize * uScale / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const SPARK_HEAD_FRAG = /* glsl */ `
  varying vec4 vColor;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    float core = smoothstep(0.5, 0.0, r);
    gl_FragColor = vec4(vColor.rgb * (0.5 + core * 1.5), core * core * vColor.a);
  }
`;

const STEAM_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;
  attribute float aRot;
  varying float vAlpha;
  varying float vSeed;
  varying float vRot;
  uniform float uScale;
  void main() {
    vAlpha = aAlpha;
    vSeed = aSeed;
    vRot = aRot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const STEAM_FRAG = /* glsl */ `
  varying float vAlpha;
  varying float vSeed;
  varying float vRot;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    p = mat2(c, -s, s, c) * p;
    float r = length(p);
    if (r > 0.5) discard;
    // Billowy edge: fbm eats into the disc
    vec2 q = p * 3.2 + vSeed * 17.0;
    float f = 0.55 * n(q) + 0.3 * n(q * 2.1) + 0.15 * n(q * 4.3);
    float body = smoothstep(0.5, 0.05, r + (f - 0.5) * 0.35);
    // Brighter top-lit core, cooler rim
    vec3 col = mix(vec3(0.62, 0.68, 0.76), vec3(0.92, 0.95, 1.0), smoothstep(0.35, -0.2, p.y + r * 0.4));
    gl_FragColor = vec4(col, body * vAlpha * 0.55);
  }
`;

/**
 * CPU particle FX for the suit-up: bolt-driver / clamp sparks and
 * pressure-vent steam, in suit-model space.
 *
 * Sparks spray over a few milliseconds, fly ballistically under real
 * gravity with air drag, render as motion-blurred streaks that cool from
 * white through orange to dull red, and skip off the platform deck. Steam
 * jets out of the vent, slows hard in the air, rises, curls and billows
 * out as it thins. Bursts are fired from timeline calls on the matching
 * SFX transients.
 */
export class SuitParticles {
  readonly group = new THREE.Group();
  private readonly emitters: Emitter[] = [];
  private time = 0;

  // Sparks
  private readonly sN = 700;
  private readonly sPos = new Float32Array(this.sN * 3);
  private readonly sVel = new Float32Array(this.sN * 3);
  private readonly sLife = new Float32Array(this.sN);
  private readonly sMax = new Float32Array(this.sN);
  private readonly sSize = new Float32Array(this.sN);
  private readonly sBounce = new Uint8Array(this.sN);
  private sNext = 0;
  private readonly heads: THREE.Points;
  private readonly streaks: THREE.LineSegments;
  private readonly headColor: Float32Array;
  private readonly linePos: Float32Array;
  private readonly lineColor: Float32Array;

  // Steam
  private readonly vN = 360;
  private readonly vPos = new Float32Array(this.vN * 3);
  private readonly vVel = new Float32Array(this.vN * 3);
  private readonly vLife = new Float32Array(this.vN);
  private readonly vMax = new Float32Array(this.vN);
  private readonly vSize0 = new Float32Array(this.vN);
  private readonly vSize = new Float32Array(this.vN);
  private readonly vAlpha = new Float32Array(this.vN);
  private readonly vSeed = new Float32Array(this.vN);
  private readonly vRot = new Float32Array(this.vN);
  private readonly vSpin = new Float32Array(this.vN);
  private vNext = 0;
  private readonly steam: THREE.Points;

  private readonly _v = new THREE.Vector3();

  constructor() {
    this.group.name = 'suit-particles';

    // Spark heads (hot dots) + streaks (velocity-aligned lines)
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3));
    hg.setAttribute('aSize', new THREE.BufferAttribute(this.sSize, 1));
    this.headColor = new Float32Array(this.sN * 4);
    hg.setAttribute('aColor', new THREE.BufferAttribute(this.headColor, 4));
    this.heads = new THREE.Points(
      hg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uScale: { value: 1400 } },
        vertexShader: SPARK_HEAD_VERT,
        fragmentShader: SPARK_HEAD_FRAG,
      }),
    );
    this.linePos = new Float32Array(this.sN * 6);
    this.lineColor = new Float32Array(this.sN * 8);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lineColor, 4));
    this.streaks = new THREE.LineSegments(
      lg,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );

    // Steam puffs
    const vg = new THREE.BufferGeometry();
    vg.setAttribute('position', new THREE.BufferAttribute(this.vPos, 3));
    vg.setAttribute('aSize', new THREE.BufferAttribute(this.vSize, 1));
    vg.setAttribute('aAlpha', new THREE.BufferAttribute(this.vAlpha, 1));
    vg.setAttribute('aSeed', new THREE.BufferAttribute(this.vSeed, 1));
    vg.setAttribute('aRot', new THREE.BufferAttribute(this.vRot, 1));
    this.steam = new THREE.Points(
      vg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uScale: { value: 1400 } },
        vertexShader: STEAM_VERT,
        fragmentShader: STEAM_FRAG,
      }),
    );

    for (const o of [this.heads, this.streaks, this.steam]) {
      o.frustumCulled = false;
      o.renderOrder = 5;
      o.visible = false;
      this.group.add(o);
    }
  }

  /**
   * Fire a burst at a group-local point. `dir` biases the spray (e.g. the
   * outward normal of the bolt being driven). Sparks spray over ~60 ms,
   * steam vents over ~0.25 s.
   */
  burst(kind: BurstKind, at: THREE.Vector3, count: number, dir?: THREE.Vector3): void {
    const n = kind === 'sparks' ? Math.round(count * 1.6) : Math.round(count * 1.3);
    const span = kind === 'sparks' ? 0.06 : 0.25;
    this.emitters.push({
      kind,
      at: at.clone(),
      dir: dir ? dir.clone().normalize() : null,
      remaining: n,
      rate: n / span,
      acc: kind === 'sparks' ? n * 0.4 : 1,
    });
    // Contact flash: one fat, short-lived white spark at the source
    if (kind === 'sparks') this.spawnSpark(at, null, true);
  }

  private spawnSpark(at: THREE.Vector3, dir: THREE.Vector3 | null, flash = false): void {
    const k = this.sNext;
    this.sNext = (this.sNext + 1) % this.sN;
    this.sPos.set([at.x, at.y, at.z], k * 3);
    if (flash) {
      this.sVel.fill(0, k * 3, k * 3 + 3);
      this.sMax[k] = this.sLife[k] = 0.07;
      this.sSize[k] = 0.07;
      this.sBounce[k] = 9;
      return;
    }
    // Cone around the spray direction; most fast, a few slow fat ones
    const v = this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    if (dir) v.multiplyScalar(0.75).add(dir).normalize();
    const fast = Math.random() < 0.8;
    const speed = fast ? 1.6 + Math.random() * 2.2 : 0.5 + Math.random() * 0.8;
    v.multiplyScalar(speed);
    v.y += 0.5;
    this.sVel.set([v.x, v.y, v.z], k * 3);
    this.sMax[k] = this.sLife[k] = fast ? 0.35 + Math.random() * 0.45 : 0.6 + Math.random() * 0.5;
    this.sSize[k] = fast ? 0.006 + Math.random() * 0.006 : 0.011 + Math.random() * 0.006;
    this.sBounce[k] = 0;
  }

  private spawnSteam(at: THREE.Vector3, dir: THREE.Vector3 | null): void {
    const k = this.vNext;
    this.vNext = (this.vNext + 1) % this.vN;
    const v = this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    if (dir) v.multiplyScalar(0.35).add(dir).normalize();
    // Jet leaves the vent fast, the air brakes it within a few tenths
    v.multiplyScalar(1.1 + Math.random() * 1.0);
    this.vPos.set([at.x, at.y, at.z], k * 3);
    this.vVel.set([v.x, v.y, v.z], k * 3);
    this.vMax[k] = this.vLife[k] = 1.1 + Math.random() * 1.1;
    this.vSize0[k] = 0.03 + Math.random() * 0.03;
    this.vSize[k] = this.vSize0[k];
    this.vSeed[k] = Math.random();
    this.vRot[k] = Math.random() * Math.PI * 2;
    this.vSpin[k] = (Math.random() - 0.5) * 1.2;
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    this.time += step;

    // Emitters
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.acc += e.rate * step;
      while (e.acc >= 1 && e.remaining > 0) {
        e.acc -= 1;
        e.remaining--;
        if (e.kind === 'sparks') this.spawnSpark(e.at, e.dir);
        else this.spawnSteam(e.at, e.dir);
      }
      if (e.remaining <= 0) this.emitters.splice(i, 1);
    }

    this.updateSparks(step);
    this.updateSteam(step);
  }

  private updateSparks(step: number): void {
    const drag = Math.exp(-1.6 * step);
    let any = false;
    const P = this.sPos;
    const V = this.sVel;
    for (let i = 0; i < this.sN; i++) {
      const c4 = i * 4;
      const l6 = i * 6;
      if (this.sLife[i] <= 0) {
        this.headColor[c4 + 3] = 0;
        this.lineColor[i * 8 + 3] = 0;
        this.lineColor[i * 8 + 7] = 0;
        continue;
      }
      any = true;
      this.sLife[i] -= step;
      const u = Math.max(0, this.sLife[i] / this.sMax[i]);
      const i3 = i * 3;
      if (this.sBounce[i] !== 9) {
        V[i3] *= drag;
        V[i3 + 1] = V[i3 + 1] * drag - GRAVITY * step;
        V[i3 + 2] *= drag;
        P[i3] += V[i3] * step;
        P[i3 + 1] += V[i3 + 1] * step;
        P[i3 + 2] += V[i3 + 2] * step;
        // Skip off the deck (or the shop floor past its edge)
        const floor = Math.hypot(P[i3], P[i3 + 2]) < DECK_R ? DECK_Y : FLOOR_Y;
        if (P[i3 + 1] < floor && V[i3 + 1] < 0) {
          P[i3 + 1] = floor;
          V[i3 + 1] *= -0.3;
          V[i3] *= 0.55;
          V[i3 + 2] *= 0.55;
          this.sBounce[i]++;
          // Each bounce sheds heat
          this.sLife[i] *= 0.7;
        }
      }
      // Temperature: white-hot → yellow → orange → dull red
      const t = this.sBounce[i] === 9 ? 1 : u;
      const r = 1;
      const g = t > 0.6 ? 0.85 + 0.15 * (t - 0.6) / 0.4 : 0.25 + 0.6 * (t / 0.6);
      const b = t > 0.75 ? 0.55 + 0.45 * (t - 0.75) / 0.25 : 0.08 + 0.4 * (t / 0.75);
      const a = this.sBounce[i] === 9 ? u : Math.sqrt(u);
      this.headColor.set([r, g, b, a], c4);
      // Streak from the head back along the velocity
      this.linePos[l6] = P[i3];
      this.linePos[l6 + 1] = P[i3 + 1];
      this.linePos[l6 + 2] = P[i3 + 2];
      this.linePos[l6 + 3] = P[i3] - V[i3] * STREAK_SEC;
      this.linePos[l6 + 4] = P[i3 + 1] - V[i3 + 1] * STREAK_SEC;
      this.linePos[l6 + 5] = P[i3 + 2] - V[i3 + 2] * STREAK_SEC;
      this.lineColor.set([r, g, b, a * 0.9, r, g * 0.6, b * 0.4, 0], i * 8);
    }
    this.heads.visible = this.streaks.visible = any;
    if (!any) return;
    for (const [geo, names] of [
      [this.heads.geometry, ['position', 'aSize', 'aColor']],
      [this.streaks.geometry, ['position', 'color']],
    ] as const) {
      for (const n of names) (geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  private updateSteam(step: number): void {
    const drag = Math.exp(-3.2 * step);
    let any = false;
    const P = this.vPos;
    const V = this.vVel;
    for (let i = 0; i < this.vN; i++) {
      if (this.vLife[i] <= 0) {
        this.vAlpha[i] = 0;
        continue;
      }
      any = true;
      this.vLife[i] -= step;
      const u = Math.max(0, this.vLife[i] / this.vMax[i]);
      const age = 1 - u;
      const i3 = i * 3;
      // Turbulent curl (cheap: phase-shifted sines per puff) + buoyancy
      const s = this.vSeed[i] * 40;
      const tt = this.time * 1.7;
      V[i3] = V[i3] * drag + Math.sin(tt + s) * 0.25 * step;
      V[i3 + 1] = V[i3 + 1] * drag + (0.45 + 0.2 * Math.sin(tt * 0.7 + s)) * step;
      V[i3 + 2] = V[i3 + 2] * drag + Math.cos(tt * 1.3 + s * 1.7) * 0.25 * step;
      P[i3] += V[i3] * step;
      P[i3 + 1] += V[i3 + 1] * step;
      P[i3 + 2] += V[i3 + 2] * step;
      // Billow out as it thins; quick bloom in, long fade
      this.vSize[i] = this.vSize0[i] * (1 + 5.5 * Math.sqrt(age));
      this.vAlpha[i] = Math.min(1, age * 9) * Math.pow(u, 1.3);
      this.vRot[i] += this.vSpin[i] * step;
    }
    this.steam.visible = any;
    if (!any) return;
    const geo = this.steam.geometry;
    for (const n of ['position', 'aSize', 'aAlpha', 'aRot', 'aSeed']) {
      (geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear(): void {
    this.emitters.length = 0;
    this.sLife.fill(0);
    this.vLife.fill(0);
    this.headColor.fill(0);
    this.lineColor.fill(0);
    this.vAlpha.fill(0);
    this.heads.visible = this.streaks.visible = this.steam.visible = false;
  }

  /**
   * World-size → pixel scale: drawing-buffer height / (2·tan(fov/2)).
   * Keeps spark size physical across resolutions and lens changes.
   */
  setProjectionScale(scale: number): void {
    for (const o of [this.heads, this.steam]) {
      (o.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
    }
  }

  dispose(): void {
    for (const o of [this.heads, this.streaks, this.steam]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
