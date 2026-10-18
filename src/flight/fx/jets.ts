import * as THREE from 'three';
import { withLogDepth } from '../render/depth';
import { RENDER_ORDER, sortFocus } from '../render/transparency';
import type { Suit } from '../../suit/Suit';
import type { BoneName } from '../../suit/rig';
import type { Particles } from './particles';

/**
 * Boot and palm thrusters in world space: a white-hot core in a blue sheath
 * with shock diamonds that multiply and tighten with throttle, a nozzle glow,
 * one light that washes the suit and the ground at take-off, and — where a
 * jet reaches the ground or the sea — a hot spot with dust or spray blown
 * out from it.
 */

const SOLES: Array<{ bone: BoneName; shin: BoneName; at: [number, number, number] }> = [
  { bone: 'foot.L', shin: 'shin.L', at: [0.16, 0.0, 0.01] },
  { bone: 'foot.R', shin: 'shin.R', at: [-0.16, 0.0, 0.01] },
];
/** How much of the boot jet follows the sole (the rest runs down the leg). */
const SOLE_SHARE = 0.2;
/** Outward tilt of each boot jet off the body's centre plane (≈ rad). */
const BOOT_SPLAY = 0.025;

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(210,240,255,0.85)');
  grad.addColorStop(0.5, 'rgba(90,180,255,0.25)');
  grad.addColorStop(1, 'rgba(40,120,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function plumeMaterial(color: number, falloff: number): THREE.ShaderMaterial {
  return withLogDepth(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uSeed: { value: Math.random() * 100 },
        uPower: { value: 0 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSeed;
        varying float vH;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vH = -position.y;
          vec3 p = position;
          float h = clamp(vH, 0.0, 1.0);
          float a = uTime * 7.0 + uSeed;
          p.x += h * h * 0.008 * (sin(a + vH * 9.0) + 0.5 * sin(a * 1.9 - vH * 17.0));
          p.z += h * h * 0.008 * (cos(a * 1.3 + vH * 7.0) + 0.5 * sin(a * 2.3 + vH * 13.0));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uTime;
        uniform float uSeed;
        uniform float uPower;
        varying float vH;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float along = pow(1.0 - clamp(vH, 0.0, 1.0), ${falloff.toFixed(1)} * (1.5 - uPower));
          float freq = 16.0 + 26.0 * uPower;
          float diamonds = 0.8 + (0.15 + 0.5 * uPower) * pow(0.5 + 0.5 * cos(vH * freq), 6.0) * (1.0 - vH);
          float race = 0.97 + 0.03 * sin(vH * 34.0 - uTime * 14.0 + uSeed);
          float edge = pow(abs(dot(vN, vV)), 0.8);
          vec3 col = mix(uColor * vec3(0.45, 0.65, 1.0), mix(uColor, vec3(1.0), 0.6), uPower) * 3.0;
          gl_FragColor = vec4(col * diamonds * race, along * edge * uOpacity);
        }
      `,
    }),
  );
}

interface Jet {
  sheath: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  core: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  glow: THREE.Sprite;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
}

export interface JetState {
  bootL: number;
  bootR: number;
  palmL: number;
  palmR: number;
}

export interface GroundQuery {
  surface(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
}

export class Jets {
  readonly group = new THREE.Group();
  private readonly boots: Jet[] = [];
  private readonly palms: Jet[] = [];
  private readonly light = new THREE.PointLight(0x9fd4ff, 0, 40, 1.6);
  private readonly washes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  private time = 0;
  private puff = 0;
  private readonly _q = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly DOWN = new THREE.Vector3(0, -1, 0);

  constructor() {
    const tex = glowTexture();
    const sheathGeo = new THREE.CylinderGeometry(0.06, 0.022, 1, 24, 8, true).translate(0, -0.5, 0);
    const coreGeo = new THREE.CylinderGeometry(0.026, 0.006, 1, 16, 6, true).translate(0, -0.5, 0);
    const make = (sheathColor: number, coreColor: number): Jet => {
      const sheath = new THREE.Mesh(sheathGeo, plumeMaterial(sheathColor, 1.6));
      const core = new THREE.Mesh(coreGeo, plumeMaterial(coreColor, 2.4));
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, color: 0xcfefff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      // After the clouds beyond the suit, before any between it and the eye
      sheath.renderOrder = core.renderOrder = RENDER_ORDER.plume;
      glow.renderOrder = RENDER_ORDER.plumeGlow;
      for (const m of [sheath, core, glow]) {
        m.visible = false;
        m.frustumCulled = false;
        this.group.add(m);
      }
      return { sheath, core, glow, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, -1, 0) };
    };
    for (let i = 0; i < 2; i++) this.boots.push(make(0x7fc4ff, 0xeaf8ff));
    for (let i = 0; i < 2; i++) this.palms.push(make(0x8fd0ff, 0xf0fbff));
    const washGeo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const w = new THREE.Mesh(
        washGeo,
        new THREE.MeshBasicMaterial({ map: tex, color: 0x8fcfff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }),
      );
      w.visible = false;
      w.renderOrder = RENDER_ORDER.wash;
      this.washes.push(w);
      this.group.add(w);
    }
    this.light.castShadow = false;
    this.group.add(this.light);
    this.group.name = 'jets';
  }

  /** Nozzle positions and thrust directions (world), after the suit is posed. */
  update(dt: number, suit: Suit, state: JetState, ground: GroundQuery, particles: Particles, suitVel: THREE.Vector3): void {
    this.time += dt;
    const t = this.time;
    // Boots: out of the soles, down the line of the leg — the thrust axis
    // the flight model pushes along. Pointed toes in flight would otherwise
    // tip the sole normal (and the jet) up behind the suit
    SOLES.forEach((s, i) => {
      const j = this.boots[i];
      suit.boneWorldPoint(s.bone, s.at, j.pos);
      suit.boneWorldDir(s.bone, [0, -1, 0], j.dir).multiplyScalar(SOLE_SHARE);
      j.dir.add(suit.boneWorldDir(s.shin, [0, -1, 0], this._d).multiplyScalar(1 - SOLE_SHARE)).normalize();
    });
    // Side by side and straight: legs drawn in together (flight, a hover)
    // toe the two shins in, and the jets crossed into one beam a metre or
    // so down. Keep what they share sideways (both legs swinging out in a
    // turn) but not the toe-in: each jet runs parallel to the other with a
    // hair of outward splay, so they never touch
    const side = suit.boneWorldDir('root', [1, 0, 0], this._d);
    const [jl, jr] = this.boots;
    const mean = (jl.dir.dot(side) + jr.dir.dot(side)) / 2;
    jl.dir.addScaledVector(side, mean + BOOT_SPLAY - jl.dir.dot(side)).normalize();
    jr.dir.addScaledVector(side, mean - BOOT_SPLAY - jr.dir.dot(side)).normalize();
    // Start just off the plating so the sole never cuts into the flame
    for (const j of this.boots) j.pos.addScaledVector(j.dir, 0.02);
    // The clouds split their draw at this distance (see render/transparency)
    sortFocus.point.copy(this.boots[0].pos).add(this.boots[1].pos).multiplyScalar(0.5);
    sortFocus.valid = true;
    suit.palms.forEach((p, i) => {
      const j = this.palms[i];
      suit.boneWorldPoint(p.bone, p.at, j.pos);
      suit.boneWorldDir(p.bone, p.normal, j.dir);
      j.pos.addScaledVector(j.dir, 0.012);
    });
    const powers = [state.bootL, state.bootR];
    const palmPowers = [state.palmL, state.palmR];
    // One light, on the boot jets only and clear of the soles: averaged in
    // with the palms it hopped about the suit with every repulsor shot and
    // sat right on the back plate, blowing it out in flashes
    let lightSum = 0;
    const lightPos = this._v.set(0, 0, 0);
    this.boots.forEach((j, i) => {
      const k = powers[i];
      this.drawJet(j, k, 0.6 + 1.6 * Math.pow(k, 1.3), 0.85 + 0.6 * k, t, i);
      lightSum += k;
      lightPos.addScaledVector(j.pos, k).addScaledVector(j.dir, 0.8 * k);
    });
    this.palms.forEach((j, i) => {
      const k = palmPowers[i];
      this.drawJet(j, k, 0.18 + 0.6 * Math.pow(k, 1.3), 0.7 + 0.4 * k, t, i + 7);
    });
    // It's there to wash the ground at take-off: up high it only scorched
    // the boot plates white
    if (lightSum > 0.01) lightPos.divideScalar(lightSum);
    const low = lightSum > 0.01 ? 1 - THREE.MathUtils.smoothstep(lightPos.y - Math.max(0, ground.surface(lightPos.x, lightPos.z)), 4, 25) : 0;
    this.light.intensity = lightSum * 60 * low;
    if (low > 0) this.light.position.copy(lightPos);

    // Where the boot jets reach the ground or the sea: wash and blow-out
    this.puff += dt;
    const doPuff = this.puff > 1 / 30;
    if (doPuff) this.puff = 0;
    this.boots.forEach((j, i) => {
      const k = powers[i];
      const w = this.washes[i];
      w.visible = false;
      if (k < 0.05) return;
      const dy = -j.dir.y;
      if (dy < 0.2) return;
      // March down the jet line to the surface (it's short: ≤ 25 m)
      const surf = ground.surface(j.pos.x, j.pos.z);
      const h = j.pos.y - surf;
      const reach = h / dy;
      if (reach > 26 || reach < 0) return;
      const near = 1 - reach / 26;
      const hit = this._d.copy(j.pos).addScaledVector(j.dir, reach);
      hit.y = ground.surface(hit.x, hit.z) + 0.05;
      const water = ground.isWater(hit.x, hit.z);
      w.visible = true;
      w.position.copy(hit);
      w.scale.setScalar(0.6 + 2.2 * (1 - near) + 0.6 * k);
      w.material.opacity = 0.9 * k * near * near;
      if (!doPuff) return;
      const n = Math.round(1 + 3 * near * k);
      for (let p = 0; p < n; p++) {
        const a = Math.random() * Math.PI * 2;
        const spd = 6 + 14 * near * k;
        const v = this._v.set(Math.cos(a) * spd, 0.6 + Math.random() * 1.5, Math.sin(a) * spd).addScaledVector(suitVel, 0.3);
        particles.emit(water ? 'spray' : 'dust', hit, v, { scale: 0.7 + near });
      }
      if (water && Math.random() < 0.5 * near) particles.emit('mist', hit, this._v.set(0, 1.5, 0), { scale: 1 + near });
    });
  }

  private drawJet(j: Jet, k: number, len: number, width: number, t: number, seed: number): void {
    const on = k > 0.01;
    j.sheath.visible = j.core.visible = j.glow.visible = on;
    if (!on) return;
    this._q.setFromUnitVectors(this.DOWN, j.dir);
    const fl = 0.985 + 0.015 * Math.sin(t * 5.3 + seed) * Math.sin(t * 3.1 + seed * 1.7);
    for (const [m, w, l, op] of [
      [j.sheath, width, len, 0.85],
      [j.core, width * 0.9, len * 0.7, 1.15],
    ] as const) {
      m.position.copy(j.pos);
      m.quaternion.copy(this._q);
      m.scale.set(w, l * fl, w);
      const u = m.material.uniforms;
      u.uPower.value = k;
      u.uOpacity.value = (0.35 + 0.65 * k) * k * fl * op;
      u.uTime.value = t;
    }
    // The glow sits clear of the armour: half-buried, camera shake made it blink
    j.glow.position.copy(j.pos).addScaledVector(j.dir, 0.05);
    j.glow.scale.setScalar(0.14 + 0.3 * k);
    j.glow.material.opacity = Math.min(1, k * 1.4);
  }
}
