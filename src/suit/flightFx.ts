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
        uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 }, uTime: { value: 0 } },
        vertexShader: /* glsl */ `
          varying float vH;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            vH = -position.y;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vN = normalize(normalMatrix * normal);
            vV = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uOpacity;
          uniform float uTime;
          varying float vH;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            // Bright at the nozzle, thinning out; shock bands pulse down it
            float along = pow(1.0 - clamp(vH, 0.0, 1.0), ${power.toFixed(1)});
            float bands = 0.8 + 0.2 * sin(vH * 38.0 - uTime * 40.0);
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
      const flick = 0.88 + 0.12 * Math.sin(t * 57 + i) * Math.sin(t * 33);
      for (const [m, w, len, op] of [
        [this.palmJets[i], 0.75, 0.32, 0.8],
        [this.palmCores[i], 0.8, 0.22, 1.1],
      ] as const) {
        m.position.copy(s.position);
        m.quaternion.copy(this._q);
        m.scale.set(w, len * (0.35 + 0.65 * k), w);
        const u = (m.material as THREE.ShaderMaterial).uniforms;
        u.uOpacity.value = k * flick * op;
        u.uTime.value = t;
      }
    });

    const burn = f.thrusters;
    const flicker = 0.88 + 0.12 * Math.sin(t * 61) * Math.sin(t * 37);
    const puff = Math.floor(t * 12);
    SOLES.forEach((p, i) => {
      const jet = this.jets[i];
      const core = this.cores[i];
      const pool = this.pools[i];
      const on = burn > 0.01;
      jet.visible = core.visible = pool.visible = on;
      if (!on) return;
      const nozzle = this.carried(rig, modelInv, p.bone, p.at, this._v);
      // Plume reaches the deck (model y 0) and splashes; capped when high
      const h = Math.max(0, nozzle.y);
      const len = Math.min(0.7, h + 0.05) * (0.6 + 0.4 * burn);
      for (const [m, w] of [
        [jet, 1 + 0.4 * burn],
        [core, 1],
      ] as const) {
        m.position.copy(nozzle);
        m.scale.set(w, len, w);
        const u = (m.material as THREE.ShaderMaterial).uniforms;
        u.uOpacity.value = burn * flicker * (m === core ? 1.2 : 0.8);
        u.uTime.value = t;
      }
      // Wash on the deck: brightest while the boots are close to it
      const near = THREE.MathUtils.clamp(1 - h / 0.8, 0.15, 1);
      pool.position.set(nozzle.x, 0.004, nozzle.z);
      pool.scale.setScalar(0.5 + 0.9 * burn * (1.2 - near * 0.4));
      (pool.material as THREE.MeshBasicMaterial).opacity = 0.8 * burn * flicker * near;
      // Exhaust vapour blown out across the deck
      if (burn > 0.45 && puff !== this.lastPuff) {
        const a = puff * 2.39996 + i * 1.7;
        this._d.set(Math.cos(a), 0.08, Math.sin(a));
        particles.burst('steam', this._p.set(nozzle.x, 0.015, nozzle.z), Math.round(2 + 3 * near), this._d);
      }
    });
    if (burn > 0.45) this.lastPuff = puff;
  }

  hide(): void {
    for (const o of [...this.palms, ...this.palmJets, ...this.palmCores, ...this.jets, ...this.cores, ...this.pools]) o.visible = false;
  }
}
