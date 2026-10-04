import * as THREE from 'three';
import { REACTOR_COLLAPSE, REACTOR_SPIN, reactorCore, reactorOverlayShare } from '../animation/doffSequence';
import { boneSpec } from './rig';
import type { SuitRig } from './rigPose';

/** Arc reactor face (bind): centre a hair proud of the glass, and its normal. */
const CENTRE = new THREE.Vector3(0, 1.436, 0.1745);
const NORMAL = new THREE.Vector3(0, 0.2, 1).normalize();
/** Coil segments round the core, and their ring (m). */
const SEGMENTS = 10;
const SEG_R = [0.025, 0.033] as const;
/** Spin of the coil ring at full power (rad/s) as it starts to run down. */
const SPIN_RATE = 7;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, t: number) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * (3 - 2 * u);
};

/** Soft radial glow for the halo. */
function haloTexture(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glow = (color: THREE.ColorRepresentation, map?: THREE.Texture) =>
  new THREE.MeshBasicMaterial({
    color,
    map: map ?? null,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

/**
 * The arc reactor's power-down at the start of the doff, laid over the
 * chest glass: the core surges, browns out in a couple of flickers, then
 * the ring of coils winds down — spinning slower as they go dark one after
 * another round the ring — until the core collapses to a dim standby glow.
 * Driven by the doff clock; rides the chest bone.
 */
export class ReactorPowerDown {
  readonly group = new THREE.Group();
  private readonly face = new THREE.Group();
  private readonly coils = new THREE.Group();
  private readonly core: THREE.MeshBasicMaterial;
  private readonly ring: THREE.MeshBasicMaterial;
  private readonly halo: THREE.MeshBasicMaterial;
  private readonly segs: THREE.MeshBasicMaterial[] = [];
  private readonly coreMesh: THREE.Mesh;
  private readonly tex = haloTexture();
  private readonly _m = new THREE.Matrix4();
  private readonly _t = new THREE.Matrix4();

  constructor() {
    this.group.name = 'reactor-power-down';
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.add(this.face);
    // Face frame: +Z out of the glass
    this.face.position.copy(CENTRE);
    this.face.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), NORMAL);
    const cyan = new THREE.Color(0x9ff0ff).multiplyScalar(2.2);
    this.halo = glow(new THREE.Color(0x6fd8ff).multiplyScalar(1.4), this.tex);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.15), this.halo);
    halo.position.z = 0.0005;
    this.ring = glow(cyan);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.019, 0.0225, 48), this.ring);
    ring.position.z = 0.0012;
    this.core = glow(new THREE.Color(0xd8fbff).multiplyScalar(2.6), this.tex);
    this.coreMesh = new THREE.Mesh(new THREE.CircleGeometry(0.03, 32), this.core);
    this.coreMesh.position.z = 0.0016;
    // Coils: short arcs with a gap between each, so the ring reads as it turns
    const arc = (Math.PI * 2) / SEGMENTS;
    const segGeo = new THREE.RingGeometry(SEG_R[0], SEG_R[1], 6, 1, arc * 0.12, arc * 0.76);
    for (let i = 0; i < SEGMENTS; i++) {
      const mat = glow(cyan);
      const seg = new THREE.Mesh(segGeo, mat);
      seg.rotation.z = i * arc;
      this.coils.add(seg);
      this.segs.push(mat);
    }
    this.coils.position.z = 0.001;
    this.face.add(halo, ring, this.coils, this.coreMesh);
    for (const o of [halo, ring, this.coreMesh, ...this.coils.children]) (o as THREE.Mesh).renderOrder = 3;
  }

  /** Doff time `t` (s), or null to hide. Places itself on the chest bone. */
  update(t: number | null, rig: SuitRig, modelInv: THREE.Matrix4): void {
    if (t === null || t > REACTOR_COLLAPSE[1] + 1.2) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const h = boneSpec('chest').head;
    this._m.multiplyMatrices(modelInv, rig.bones.chest.matrixWorld).multiply(this._t.makeTranslation(-h[0], -h[1], -h[2]));
    this.group.matrix.copy(this._m);
    this.group.matrixWorldNeedsUpdate = true;

    const core = reactorCore(t);
    // The overlay takes the reactor's light over from the glass (dimmed under
    // it) for the power-down, and hands it back at standby
    const share = reactorOverlayShare(t);
    // Surge: a bright pop of the halo before it starts failing
    const surge = smooth(0.12, 0.2, t) * (1 - smooth(0.24, 0.42, t));
    // Collapse flash as the last coil drops out
    const pop = smooth(REACTOR_COLLAPSE[0] - 0.02, REACTOR_COLLAPSE[0] + 0.03, t) * (1 - smooth(REACTOR_COLLAPSE[0] + 0.03, REACTOR_COLLAPSE[0] + 0.2, t));
    this.halo.opacity = (0.25 * core + 0.9 * surge + 0.7 * pop) * share;
    this.core.opacity = share * Math.min(1, core * 1.1 + 0.5 * pop);
    this.ring.opacity = share * Math.min(1, core * 1.2);
    // The core shrinks as it collapses (to the standby pinpoint)
    const shrink = 1 - 0.55 * smooth(REACTOR_COLLAPSE[0], REACTOR_COLLAPSE[1], t);
    this.coreMesh.scale.setScalar(shrink);

    // Coils: spin at full rate, run down to a stop over the spin-down, and go
    // dark one after another round the ring as they slow
    const [s0, s1] = REACTOR_SPIN;
    const span = s1 - s0;
    const u = clamp01((t - s0) / span);
    // ω = SPIN_RATE·(1 − u)² → angle = SPIN_RATE·span·(1 − (1 − u)³)/3, plus the spin before it
    const angle = SPIN_RATE * Math.min(t, s0) + (SPIN_RATE * span * (1 - (1 - u) ** 3)) / 3;
    this.coils.rotation.z = -angle;
    for (let i = 0; i < SEGMENTS; i++) {
      const off = s0 + 0.08 + (i / SEGMENTS) * (span - 0.12);
      const on = 1 - smooth(off, off + 0.06, t);
      // A dying coil stutters once before it goes
      const stutter = t > off - 0.05 && t < off - 0.02 ? 0.35 : 1;
      this.segs[i].opacity = share * on * stutter * Math.min(1, core * 1.4 + 0.25);
    }
  }

  dispose(): void {
    this.tex.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
  }
}
