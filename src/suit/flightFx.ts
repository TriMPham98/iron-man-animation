import * as THREE from 'three';
import type { FlightCheckFrame } from '../animation/flightCheck';
import { boneSpec, type BoneName, type Vec3 } from './rig';
import type { SuitRig } from './rigPose';
import type { SuitParticles } from './suitEffects';

/** Palm repulsor emitters (bind space, on the palm face). */
export interface PalmEmitter {
  bone: BoneName;
  at: Vec3;
  normal: Vec3;
}
const DEFAULT_PALMS: PalmEmitter[] = [
  { bone: 'hand.L', at: [0.358, 0.955, 0.03], normal: [-1, 0, 0.12] },
  { bone: 'hand.R', at: [-0.358, 0.955, 0.03], normal: [1, 0, 0.12] },
];
/** Boot thruster nozzles (bind space, sole centre). */
const SOLES: Array<{ bone: BoneName; at: Vec3 }> = [
  { bone: 'foot.L', at: [0.16, 0.0, 0.01] },
  { bone: 'foot.R', at: [-0.16, 0.0, 0.01] },
];

function glowTexture(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(200,240,255,0.85)');
  grad.addColorStop(0.55, 'rgba(90,190,255,0.25)');
  grad.addColorStop(1, 'rgba(40,120,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Steady burn with a faint, slow shimmer (±3 %). Repulsors are a stable
 * energy jet, not a guttering flame — any visible strobing reads as a fault.
 */
function flick(t: number, seed: number): number {
  return 0.97 + 0.02 * Math.sin(t * 5.3 + seed) * Math.sin(t * 3.1 + seed * 1.7) + 0.01 * Math.sin(t * 11 + seed * 2.3);
}

/**
 * Flight-check effects in model space: palm repulsor flares, boot thruster
 * jets with a glow pool on the platform, and vapour blowing out under the
 * soles while they burn.
 */
export class FlightFx {
  readonly group = new THREE.Group();
  /** One-sided glow discs facing out of the palm (dark from the back of the hand). */
  private readonly palms: THREE.Mesh[] = [];
  private readonly _n = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly jets: THREE.Mesh[] = [];
  private readonly cores: THREE.Mesh[] = [];
  private readonly pools: THREE.Mesh[] = [];
  private lastPuff = -1;
  private readonly _m = new THREE.Matrix4();
  private readonly _v = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();

  private readonly palmSpecs: PalmEmitter[];
  private readonly palmJets: THREE.Mesh[] = [];
  private readonly palmCores: THREE.Mesh[] = [];
  /** Wash under each palm on the deck while it pushes down near it. */
  private readonly palmPools: THREE.Mesh[] = [];
  private lastPalmPuff = -1;

  /** `palms`: repulsor centres + normals measured off the gauntlet palms. */
  constructor(palms: PalmEmitter[] = DEFAULT_PALMS) {
    this.palmSpecs = palms;
    this.group.name = 'flight-fx';
    const tex = glowTexture();
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false } as const;
    const disc = new THREE.CircleGeometry(0.5, 32);
    for (let i = 0; i < palms.length; i++) {
      const s = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ map: tex, color: 0xcff2ff, side: THREE.FrontSide, ...add }));
      s.visible = false;
      this.palms.push(s);
      this.group.add(s);
    }
    // Jet plume: open cone from the nozzle (y 0) to its tip (y −1), fading
    // along its length; a narrow white-hot core inside a wider blue sheath
    const jetGeo = new THREE.CylinderGeometry(0.055, 0.02, 1, 24, 6, true);
    jetGeo.translate(0, -0.5, 0);
    const coreGeo = new THREE.CylinderGeometry(0.024, 0.006, 1, 16, 4, true);
    coreGeo.translate(0, -0.5, 0);
    const plume = (color: number, power: number) =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uOpacity: { value: 0 },
          uTime: { value: 0 },
          uSeed: { value: Math.random() * 100 },
        },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uSeed;
          varying float vH;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            vH = -position.y;
            // Turbulent plume: the column wanders and breathes more toward
            // its tip, never a rigid cone
            vec3 p = position;
            float h = clamp(vH, 0.0, 1.0);
            float a = uTime * 6.0 + uSeed;
            p.x += h * h * 0.025 * (sin(a + vH * 9.0) + 0.5 * sin(a * 1.9 - vH * 17.0));
            p.z += h * h * 0.025 * (cos(a * 1.3 + vH * 7.0) + 0.5 * sin(a * 2.3 + vH * 13.0));
            p.xz *= 1.0 + 0.04 * sin(a * 2.1 - vH * 9.0) * h;
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
          varying float vH;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            // Bright at the nozzle, thinning out; standing shock diamonds
            // near the nozzle plus turbulent bands racing down it
            float along = pow(1.0 - clamp(vH, 0.0, 1.0), ${power.toFixed(1)});
            float diamonds = 0.85 + 0.3 * pow(0.5 + 0.5 * cos(vH * 34.0), 6.0) * (1.0 - vH);
            float race = 0.95 + 0.05 * sin(vH * 30.0 - uTime * 18.0 + uSeed);
            float bands = diamonds * race;
            float edge = pow(abs(dot(vN, vV)), 0.8);
            gl_FragColor = vec4(uColor * bands, along * edge * uOpacity);
          }
        `,
      });
    const poolGeo = new THREE.CircleGeometry(0.26, 40);
    poolGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < SOLES.length; i++) {
      const jet = new THREE.Mesh(jetGeo, plume(0x7fc4ff, 1.6));
      // Palm thrust: same plume, smaller, along the palm normal
      const pj = new THREE.Mesh(jetGeo, plume(0x8fd0ff, 1.4));
      const pc = new THREE.Mesh(coreGeo, plume(0xf0fbff, 2.2));
      pj.visible = pc.visible = false;
      this.palmJets.push(pj);
      this.palmCores.push(pc);
      this.group.add(pj, pc);
      jet.visible = false;
      this.jets.push(jet);
      this.group.add(jet);
      const core = new THREE.Mesh(coreGeo, plume(0xeaf8ff, 2.4));
      core.visible = false;
      this.cores.push(core);
      this.group.add(core);
      const pool = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({ map: tex, color: 0x7fc8ff, ...add }));
      pool.visible = false;
      pool.renderOrder = 3;
      this.pools.push(pool);
      this.group.add(pool);
      const pp = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({ map: tex, color: 0x9fd8ff, ...add }));
      pp.visible = false;
      pp.renderOrder = 3;
      this.palmPools.push(pp);
      this.group.add(pp);
    }
  }

  /** Bind-space point carried by a bone → model space. */
  private carried(rig: SuitRig, modelInv: THREE.Matrix4, bone: BoneName, at: Vec3, out: THREE.Vector3): THREE.Vector3 {
    const h = boneSpec(bone).head;
    this._m.multiplyMatrices(modelInv, rig.bones[bone].matrixWorld);
    return out.set(at[0] - h[0], at[1] - h[1], at[2] - h[2]).applyMatrix4(this._m);
  }

  update(f: FlightCheckFrame, t: number, rig: SuitRig, modelInv: THREE.Matrix4, particles: SuitParticles): void {
    const flashes = [f.repulsorL, f.repulsorR];
    this.palmSpecs.forEach((p, i) => {
      const s = this.palms[i];
      const k = flashes[i];
      s.visible = this.palmJets[i].visible = this.palmCores[i].visible = k > 0.01;
      if (!s.visible) return;
      this.carried(rig, modelInv, p.bone, p.at, s.position);
      // Face out of the palm: disc normal = palm normal carried by the hand
      this._m.multiplyMatrices(modelInv, rig.bones[p.bone].matrixWorld);
      this._n.set(p.normal[0], p.normal[1], p.normal[2]).transformDirection(this._m);
      s.quaternion.copy(this._q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._n));
      s.position.addScaledVector(this._n, 0.012);
      s.scale.setScalar(0.07 + 0.22 * k);
      (s.material as THREE.MeshBasicMaterial).opacity = Math.min(1, k * 1.4);
      // Thrust plume straight out of the palm (jet geometry runs along −Y)
      this._q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this._n);
      const fl = flick(t, i * 3.1);
      for (const [m, w, len, op] of [
        [this.palmJets[i], 0.75, 0.36, 0.8],
        [this.palmCores[i], 0.8, 0.24, 1.1],
      ] as const) {
        m.position.copy(s.position);
        m.quaternion.copy(this._q);
        m.scale.set(w * (0.9 + 0.15 * k), len * (0.35 + 0.65 * k) * (0.9 + 0.12 * fl), w * (0.9 + 0.15 * k));
        const u = (m.material as THREE.ShaderMaterial).uniforms;
        u.uOpacity.value = k * fl * op;
        u.uTime.value = t;
      }
      // Pointed at the deck and close to it: the blast lights and blows
      // across the floor under the palm
      const pool = this.palmPools[i];
      const down = Math.max(0, -this._n.y);
      const h = Math.max(0, s.position.y);
      const near = down * THREE.MathUtils.clamp(1 - h / 1.4, 0, 1) * k;
      pool.visible = near > 0.02;
      if (pool.visible) {
        pool.position.set(s.position.x + this._n.x * h, 0.005, s.position.z + this._n.z * h);
        pool.scale.setScalar(0.35 + 0.35 * near * fl);
        (pool.material as THREE.MeshBasicMaterial).opacity = 0.55 * near * fl;
        const puff = Math.floor(t * 9);
        if (near > 0.25 && puff !== this.lastPalmPuff && i === 1) {
          for (let j = 0; j < this.palmPools.length; j++) {
            const pj = this.palmPools[j];
            if (!pj.visible) continue;
            const a = puff * 2.39996 + j;
            this._d.set(Math.cos(a), 0.05, Math.sin(a));
            particles.burst('steam', this._p.set(pj.position.x, 0.012, pj.position.z), 1 + Math.round(2 * near), this._d);
          }
          this.lastPalmPuff = puff;
        }
      }
    });
    for (let i = 0; i < this.palmPools.length; i++) if (!(flashes[i] > 0.01)) this.palmPools[i].visible = false;

    const burn = f.thrusters;
    const burns = [f.thrusterL, f.thrusterR];
    const puff = Math.floor(t * 12);
    SOLES.forEach((p, i) => {
      const jet = this.jets[i];
      const core = this.cores[i];
      const pool = this.pools[i];
      const b = burns[i];
      const on = b > 0.01;
      jet.visible = core.visible = pool.visible = on;
      if (!on) return;
      const nozzle = this.carried(rig, modelInv, p.bone, p.at, this._v);
      // Jet leaves along the sole normal, so it vectors with the ankle and
      // the suit's tilt instead of always pointing straight down
      this._m.multiplyMatrices(modelInv, rig.bones[p.bone].matrixWorld);
      this._n.set(0, -1, 0).transformDirection(this._m);
      this._q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this._n);
      const fl = flick(t, 11 + i * 4.7);
      // Plume reaches the deck (model y 0) and splashes; capped when high
      const h = Math.max(0, nozzle.y);
      const reach = h / Math.max(0.35, -this._n.y);
      const len = Math.min(0.7, reach + 0.05) * (0.6 + 0.4 * b) * (0.92 + 0.1 * fl);
      for (const [m, w] of [
        [jet, (1 + 0.4 * b) * (0.95 + 0.08 * fl)],
        [core, 1],
      ] as const) {
        m.position.copy(nozzle);
        m.quaternion.copy(this._q);
        m.scale.set(w, len, w);
        const u = (m.material as THREE.ShaderMaterial).uniforms;
        u.uOpacity.value = b * fl * (m === core ? 1.2 : 0.8);
        u.uTime.value = t;
      }
      // Wash on the deck where the jet lands: brightest while close
      const near = THREE.MathUtils.clamp(1 - h / 0.8, 0.15, 1);
      pool.position.set(nozzle.x + this._n.x * reach, 0.004, nozzle.z + this._n.z * reach);
      pool.scale.setScalar((0.5 + 0.9 * b * (1.2 - near * 0.4)) * (0.95 + 0.1 * fl));
      (pool.material as THREE.MeshBasicMaterial).opacity = 0.8 * b * fl * near;
      // Exhaust vapour blown out across the deck
      if (burn > 0.45 && puff !== this.lastPuff) {
        const a = puff * 2.39996 + i * 1.7;
        this._d.set(Math.cos(a), 0.08, Math.sin(a));
        particles.burst('steam', this._p.copy(pool.position).setY(0.015), Math.round(2 + 3 * near), this._d);
        // The odd spark kicked off the deck plating
        if (near > 0.5 && (puff + i) % 3 === 0) particles.burst('sparks', this._p, 2, this._d);
      }
    });
    if (burn > 0.45) this.lastPuff = puff;
  }

  hide(): void {
    for (const o of [...this.palms, ...this.palmJets, ...this.palmCores, ...this.palmPools, ...this.jets, ...this.cores, ...this.pools]) o.visible = false;
  }
}
