import * as THREE from 'three';
import { FLARE_POPS, type FlightCheckFrame } from '../animation/flightCheck';
import { boneSpec, type BoneName } from './rig';
import type { SuitRig } from './rigPose';
import {
  FLARE_PUSH,
  flapMotion,
  forearmAxis,
  forearmNormal,
  MISSILE_RISE,
  MISSILE_RISE_SPAN,
  SILO_POD_H,
  SILO_RISE,
  type Flap,
} from './flightFlaps';
import type { SuitParticles } from './particles';

/**
 * Mark III weapons for the flight check's arming step (Iron Man, 2008):
 * the forearm anti-tank launcher (the tank shot at Gulmira), the
 * trapezius mini-rocket silos and the hip flare dispensers.
 *
 * Built procedurally in bind space under the armor panels that carry them
 * and moved with those panels' motion each frame; hidden while stowed
 * inside the shell.
 */

const mats = () => ({
  gun: new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.85, roughness: 0.35 }),
  // Hot-rod red and gold of the suit itself (clearcoated metallic)
  red: new THREE.MeshPhysicalMaterial({ color: 0x6d0a10, metalness: 0.85, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12 }),
  gold: new THREE.MeshPhysicalMaterial({ color: 0xb8913c, metalness: 1, roughness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.15 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 1, roughness: 0.22 }),
  lens: new THREE.MeshStandardMaterial({ color: 0x0a2430, emissive: new THREE.Color(0x6fe0ff), emissiveIntensity: 2 }),
});

/** Silo outline as a share of the trap lid's footprint (the lid overhangs it). */
const SILO_SCALE = 0.7;
/** Anti-tank missile: body radius, warhead and nozzle lengths, fin span (m). */
const MISSILE_R = 0.0068;
const NOSE = 0.02;
const NOZZLE = 0.004;
const FIN = 0.0055;
/** Half-width the missile and its fins take across the bay (m). */
const MISSILE_SPAN = MISSILE_R + FIN * 0.75;

const UP = new THREE.Vector3(0, 1, 0);

const ease = (a: number, b: number, u: number) => {
  const k = Math.min(1, Math.max(0, (u - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** Cylinder along local +Y spanning y0 → y1. */
function tube(r0: number, r1: number, y0: number, y1: number, m: THREE.Material, seg = 16, open = false): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1, open);
  g.translate(0, (y0 + y1) / 2, 0);
  return new THREE.Mesh(g, m);
}

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  return b;
}

function hull2(points: Array<[number, number]>): Array<[number, number]> {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Array<[number, number]> = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
    up.push(p[i]);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Solid with a (z, y) side profile, extruded across x0 → x1. */
function sideProfile(profile: Array<[number, number]>, x0: number, x1: number, m: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false });
  // Shape (s, y) extruded along e: (s, y, e) → (x1 − e, y, s), a proper rotation (keeps the winding)
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, x1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  g.computeVertexNormals();
  return new THREE.Mesh(g, m);
}

/** Scale a convex outline about its centroid (never degenerates, unlike a radial inset). */
function scaleAbout(poly: Array<[number, number]>, k: number): Array<[number, number]> {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return poly.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k]);
}

function flareTexture(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,230,170,0.9)');
  grad.addColorStop(0.6, 'rgba(255,140,40,0.3)');
  grad.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Mount {
  bone: BoneName;
  flap: Flap;
  /** Bind-space placement under the flap's panel. */
  bind: THREE.Matrix4;
  rig: THREE.Group;
  root: THREE.Group;
}

interface Ram {
  base: THREE.Vector3;
  end: THREE.Vector3;
  sleeve: THREE.Mesh;
  rod: THREE.Mesh;
  eye: THREE.Mesh;
}

interface Launcher extends Mount {
  side: 'L' | 'R';
  /** Outward forearm normal (bind): the missile rises along it. */
  normal: THREE.Vector3;
  /** Rams carrying the lid: base fixed in the bay, end on the lid (bind). */
  rams: Ram[];
  /** Holds the rams in the forearm's frame. */
  fixed: THREE.Group;
  /** Muzzle point and bore axis in the launcher frame. */
  muzzle: THREE.Vector3;
  lens: THREE.MeshStandardMaterial;
  ring: THREE.MeshBasicMaterial;
  laser: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  lastLock: number;
  /** Latched from the lock until the launcher starts to stow. */
  locked: boolean;
}

/** A weapon JARVIS is tracking, for the HUD reticles (model space). */
export interface WeaponTarget {
  id: string;
  label: string;
  at: THREE.Vector3;
  /** 0 tracking → 1 locked / armed. */
  lock: number;
}

/** Cell light colours (HDR so they bloom): off, arming, armed. */
const CELL_OFF = new THREE.Color(0x140c06);
const CELL_ARMING = new THREE.Color(0xffa018).multiplyScalar(2.2);
const CELL_ARMED = new THREE.Color(0x4dff9a).multiplyScalar(2.4);

/** Targeting laser: a hairline beam fading out along its length. */
function laserMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vH;
      void main() {
        vH = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vH;
      void main() {
        // uv.y runs 0 at the far end → 1 at the muzzle
        float a = vH * vH * uOpacity;
        gl_FragColor = vec4(vec3(1.0, 0.16, 0.08) * 2.4, a);
      }`,
  });
}

/**
 * Weapons ride the suit's own armor: the forearm launcher sits under an
 * outer forearm panel that rises out on it; each trapezius silo sits under
 * a trap panel that lifts on top of it and flips open to bare the rockets.
 */
export class WeaponsFx {
  readonly group = new THREE.Group();
  private readonly launchers: Launcher[] = [];
  private readonly silos: Array<
    Mount & {
      rockets: THREE.Object3D[];
      cells: THREE.MeshBasicMaterial[];
      front: number;
      side: number;
      center: THREE.Vector3;
    }
  > = [];
  private readonly dispensers: Array<Mount & { cells: THREE.Vector3[]; side: number }> = [];
  /** Live flares (model space), each with a hot spot on the deck under it. */
  private readonly flares: Array<{
    p: THREE.Vector3;
    v: THREE.Vector3;
    life: number;
    sprite: THREE.Sprite;
    spot: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    puff?: number;
  }> = [];
  private readonly spotGeo = new THREE.CircleGeometry(0.5, 24).rotateX(-Math.PI / 2);
  /**
   * One light carried by the youngest flare so the hip, the suit and the
   * deck catch its glare. Always in the scene (intensity 0 when idle): a
   * light that comes and goes changes every lit shader and recompiles.
   */
  private readonly flareLight = new THREE.PointLight(0xffa860, 0, 2.2, 2);
  private siloArmed = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _lid = new THREE.Matrix4();
  private readonly _dir = new THREE.Vector3();
  private readonly _dir2 = new THREE.Vector3();
  private readonly flareTex = flareTexture();
  private lastT = Number.NaN;
  private readonly _m = new THREE.Matrix4();
  private readonly _t = new THREE.Matrix4();

  constructor(flaps: readonly Flap[]) {
    this.group.name = 'weapons';
    this.group.add(this.flareLight);
    const m = mats();
    for (const side of ['L', 'R'] as const) {
      const s = side === 'L' ? 1 : -1;
      const launcher = flaps.find((f) => f.id === `launcher.${side}`);
      if (launcher) this.launchers.push(this.makeLauncher(side, launcher, m));
      const trap = flaps.find((f) => f.id === `trap.${side}`);
      if (trap) this.silos.push(this.makeSilo(s, trap, m));
      const hip = flaps.find((f) => f.id === `flare.${side}`);
      if (hip) this.dispensers.push(this.makeDispenser(s, hip, m));
    }
  }

  /**
   * Anti-tank missile in a bay under the outer forearm lid. Frame: +X out
   * of the forearm, +Y along it toward the hand. Slim and finned, as long
   * as the bay (less a margin) and seated a few mm under the lid's inner
   * face, so it rises out through the opening the lid leaves and never
   * through the shell beside it.
   */
  private makeLauncher(side: 'L' | 'R', flap: Flap, m: ReturnType<typeof mats>): Launcher {
    const y = forearmAxis(side);
    const x = forearmNormal(side);
    const z = new THREE.Vector3().crossVectors(x, y);
    const c = flap.bounds.getCenter(new THREE.Vector3());
    // The lid in this frame, origin at its centre
    const pos = flap.mesh.geometry.getAttribute('position');
    const local: Array<[number, number, number]> = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).sub(c);
      local.push([v.dot(x), v.dot(y), v.dot(z)]);
    }
    const zMin = Math.min(...local.map((p) => p[2]));
    const zMax = Math.max(...local.map((p) => p[2]));
    const zm = (zMin + zMax) / 2;
    // The bay's length where the missile lies (the lid's outline is not square)
    const lane = local.filter((p) => Math.abs(p[2] - zm) < MISSILE_SPAN);
    const yMin = Math.min(...lane.map((p) => p[1]));
    const yMax = Math.max(...lane.map((p) => p[1]));
    const len = Math.min(0.11, yMax - yMin - 0.016 - NOZZLE);
    const ym = (yMin + yMax) / 2;
    // Lowest point of the lid's underside over the missile
    let under = Infinity;
    for (const [a, b, w] of local) {
      if (Math.abs(w - zm) < MISSILE_SPAN && Math.abs(b - ym) < len / 2) under = Math.min(under, a);
    }
    if (!Number.isFinite(under)) under = 0;
    const at = c
      .clone()
      .addScaledVector(x, under - 0.003 - MISSILE_SPAN)
      .addScaledVector(y, ym + NOZZLE / 2)
      .addScaledVector(z, zm);
    const bind = new THREE.Matrix4().makeBasis(x, y, z).setPosition(at);

    const R = MISSILE_R;
    const tail = -len / 2;
    const noseAt = len / 2 - NOSE;
    const rig = new THREE.Group();
    // Launch rail and saddle clamps under it
    rig.add(box(0.004, len * 0.82, 0.007, m.gun, -R - 0.002, 0, 0));
    for (const yy of [-len * 0.28, len * 0.2]) rig.add(box(0.005, 0.004, 0.011, m.gun, -R + 0.0005, yy, 0));
    const missile = new THREE.Group();
    // Nozzle, steel motor section, red body, gold band behind the warhead
    missile.add(tube(0.0052, 0.0042, tail - NOZZLE, tail, m.gun, 16));
    missile.add(tube(R, R, tail, tail + 0.016, m.steel, 20));
    missile.add(tube(R, R, tail + 0.016, noseAt, m.red, 20));
    missile.add(tube(R + 0.0006, R + 0.0006, noseAt - 0.007, noseAt - 0.0035, m.gold, 20));
    // Ogive warhead
    const ogive: THREE.Vector2[] = [];
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      ogive.push(new THREE.Vector2(Math.max(0.0004, R * Math.sqrt(Math.max(0, 1 - u * u)) * (1 - 0.15 * u)), noseAt + u * NOSE));
    }
    missile.add(new THREE.Mesh(new THREE.LatheGeometry(ogive, 20), m.steel));
    // Seeker head (its own material: it flares on this launcher's lock)
    const lens = m.lens.clone();
    lens.emissiveIntensity = 0.6;
    const seeker = new THREE.Mesh(new THREE.SphereGeometry(0.0019, 10, 8), lens);
    seeker.position.y = len / 2 - 0.0006;
    missile.add(seeker);
    // Cruciform tail fins, set at 45° so none points into the rail
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Group();
      fin.rotation.y = Math.PI / 4 + (i * Math.PI) / 2;
      fin.add(box(FIN, 0.013, 0.0006, m.gun, R + FIN / 2 - 0.0005, tail + 0.0085, 0));
      missile.add(fin);
    }
    rig.add(missile);
    // Seeker ring glows behind the warhead once locked
    const ring = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xff6a2a).multiplyScalar(2),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(new THREE.RingGeometry(R + 0.0008, R + 0.0026, 24).rotateX(-Math.PI / 2), ring);
    ringMesh.position.y = noseAt - 0.0052;
    rig.add(ringMesh);
    // Laser: from the nose tip down the bore axis (toward the hand), 1.6 m
    const beam = 1.6;
    const laserGeo = new THREE.CylinderGeometry(0.0012, 0.0012, beam, 6, 1, true);
    laserGeo.translate(0, beam / 2, 0);
    const laser = new THREE.Mesh(laserGeo, laserMaterial());
    const muzzle = new THREE.Vector3(0, len / 2, 0);
    laser.position.copy(muzzle);
    laser.visible = false;
    rig.add(laser);
    // Lid rams: two telescoping arms either side of the missile at the
    // elbow end of the bay, from the bay floor up to the lid's underside, so
    // the lid is carried out and back on them (bind coords; the lid end
    // rides the lid's motion each frame)
    const ramY = yMin + 0.016;
    const rams = [zm - MISSILE_SPAN - 0.005, zm + MISSILE_SPAN + 0.005].map((w) => {
      const at2 = (a: number) => c.clone().addScaledVector(x, a).addScaledVector(y, ramY).addScaledVector(z, w);
      return {
        base: at2(under - 0.022),
        end: at2(under + 0.0015),
        sleeve: new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 1, 12).translate(0, 0.5, 0), m.gun),
        rod: new THREE.Mesh(new THREE.CylinderGeometry(0.0017, 0.0017, 1, 10).translate(0, 0.5, 0), m.steel),
        eye: new THREE.Mesh(new THREE.SphereGeometry(0.0029, 10, 8), m.gold),
      };
    });
    const fixed = new THREE.Group();
    fixed.matrixAutoUpdate = false;
    fixed.visible = false;
    for (const r of rams) fixed.add(r.sleeve, r.rod, r.eye);
    this.group.add(fixed);
    return {
      ...this.mount(`forearm.${side}`, flap, bind, rig),
      side,
      muzzle,
      lens,
      ring,
      laser,
      lastLock: 0,
      locked: false,
      normal: x,
      rams,
      fixed,
    };
  }

  /**
   * Mini-missile pod in a well under the trap plate, as in the film: the
   * plate hinges back out of the way (it is the only moving armor), and the
   * pod — a gunmetal launcher block with a 3 × 2 bank of tubes — elevates
   * about its own back edge so its muzzles aim forward and up. The pivot
   * sits inside the well, so the pod never floats free of the shoulder.
   * Frame: bind axes, origin at the lid's mid height.
   */
  private makeSilo(s: number, flap: Flap, m: ReturnType<typeof mats>) {
    const b = flap.bounds;
    const cy = (b.min.y + b.max.y) / 2;
    const geo = flap.mesh.geometry;
    const pos = geo.getAttribute('position');
    const pts: THREE.Vector3[] = [...new Set(geo.index!.array)].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    const lid = hull2(pts.map((p) => [p.x, p.z] as [number, number]));
    const inner = scaleAbout(lid, SILO_SCALE);
    const fx0 = Math.min(...inner.map((q) => q[0]));
    const fx1 = Math.max(...inner.map((q) => q[0]));
    const fz0 = Math.min(...inner.map((q) => q[1]));
    const fz1 = Math.max(...inner.map((q) => q[1]));
    // Lid underside (relative to the frame) over the pod
    let under = Infinity;
    for (const p of pts) {
      if (p.x > fx0 && p.x < fx1 && p.z > fz0 && p.z < fz1) under = Math.min(under, p.y);
    }
    const top = (Number.isFinite(under) ? under : b.min.y) - cy - 0.003;
    const bind = new THREE.Matrix4().makeTranslation(0, cy, 0);
    const rig = new THREE.Group();

    // Pod block: a hair inside the well, top just under the lid
    const W = fx1 - fx0;
    const D = fz1 - fz0;
    const H = SILO_POD_H;
    const cx = (fx0 + fx1) / 2;
    const pod = new THREE.Group();
    rig.add(pod);
    const zc = (fz0 + fz1) / 2;
    // Sleeve below the body that stays down in the well at full rise, so the
    // pod is always seated in the shoulder
    pod.add(box(W * 0.9, SILO_RISE + 0.008, D * 0.86, m.gun, cx, top - H - (SILO_RISE + 0.008) / 2 + 0.001, zc - D * 0.04));
    // Gunmetal body, chamfered along its length, under a red armored cowl
    // that sweeps down to the back; gold pinstripes along the cheeks
    pod.add(sideProfile(
      [
        [fz0, top - H],
        [fz1 - 0.003, top - H],
        [fz1, top - H + 0.003],
        [fz1, top - 0.004],
        [fz1 - 0.004, top],
        [fz0 + 0.008, top],
        [fz0, top - 0.008],
      ],
      fx0,
      fx1,
      m.gun,
    ));
    pod.add(sideProfile(
      [
        [fz0 + 0.004, top - 0.004],
        [fz1 - 0.004, top - 0.0012],
        [fz1 - 0.008, top + 0.0028],
        [fz0 + 0.01, top + 0.0012],
      ],
      fx0 + 0.0015,
      fx1 - 0.0015,
      m.red,
    ));
    for (const sx of [fx0, fx1]) pod.add(box(0.0008, 0.0016, D * 0.72, m.gold, sx + Math.sign(sx - cx) * 0.0004, top - H * 0.55, zc + D * 0.06));
    // Front bezel and the tube bank: gold rims, dark bores, warheads seated in them
    const front = fz1;
    pod.add(box(W * 0.94, H * 0.9, 0.003, m.gun, cx, top - H / 2, front + 0.0015));
    const cols = 3;
    const rows = 2;
    const pitchX = (W * 0.9) / cols;
    const pitchY = (H * 0.8) / rows;
    const rimR = Math.min(pitchX, pitchY) * 0.42;
    const rockets: THREE.Object3D[] = [];
    const cells: THREE.MeshBasicMaterial[] = [];
    const bore = new THREE.MeshStandardMaterial({ color: 0x07080a, metalness: 0.6, roughness: 0.7 });
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = cx + (i - (cols - 1) / 2) * pitchX;
        const y = top - H / 2 + ((rows - 1) / 2 - j) * pitchY;
        // Tube muzzle (along +Z)
        const rim = tube(rimR, rimR, 0, 0.004, m.gold, 16, true);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(x, y, front + 0.0004);
        pod.add(rim);
        const hole = new THREE.Mesh(new THREE.CircleGeometry(rimR * 0.92, 16), bore);
        hole.position.set(x, y, front + 0.0034);
        pod.add(hole);
        // Missile in its tube: slides out of the muzzle as it arms
        const r = new THREE.Group();
        r.position.set(x, y, front);
        r.rotation.x = Math.PI / 2; // +Y → forward
        r.add(tube(rimR * 0.62, rimR * 0.62, -0.006, 0.0008, m.steel, 10));
        r.add(tube(rimR * 0.7, 0, 0.0008, 0.0008 + rimR * 2.4, m.red, 12));
        pod.add(r);
        rockets.push(r);
      }
    }
    // Cell lights in a strip along the bezel's foot, one under each tube
    for (let k = 0; k < cols * rows; k++) {
      const led = new THREE.MeshBasicMaterial({ color: CELL_OFF.clone(), toneMapped: false });
      const x = cx - W * 0.4 + (k / (cols * rows - 1)) * W * 0.8;
      pod.add(box(0.0022, 0.0016, 0.0012, led, x, top - H + 0.0016, front + 0.0035));
      cells.push(led);
    }
    // Sensor on the outboard cheek
    pod.add(box(0.0012, 0.004, 0.006, m.lens, s > 0 ? fx1 + 0.0006 : fx0 - 0.0006, top - H * 0.35, front - 0.006));
    // Arming order: top row first, outboard column before inboard
    const outboard = (i: number) => (s > 0 ? cols - 1 - i : i);
    const order = [0, 1, 2].flatMap((n) => [outboard(n), cols + outboard(n)]).sort((p, q) => Math.floor(p / cols) - Math.floor(q / cols));
    const byArm = order.map((k) => rockets[k]);
    const cellsByArm = order.map((k) => cells[k]);
    const center = new THREE.Vector3(cx, top - H / 2, front);
    return { ...this.mount('chest', flap, bind, rig), rockets: byArm, cells: cellsByArm, front, side: s, center };
  }

  /**
   * Flare drum under the suit's own round hip plate: the plate pushes out
   * along its normal and the drum it caps comes out with it — a short
   * cylinder the plate's own size (so it stays hidden in the plate's seat
   * when stowed), suit red with a gold band, six ports round its side. Drum and
   * plate index a sixth of a turn together; flares leave from the ports.
   */
  private makeDispenser(s: number, flap: Flap, m: ReturnType<typeof mats>) {
    const b = flap.bounds;
    const n = flap.axis.clone().normalize();
    // Plate radius in its own plane (it faces out along ±X); the drum is a
    // hair inside it so the face disk reads as a lid
    const size = b.getSize(new THREE.Vector3());
    const r = (Math.min(size.y, size.z) / 2) * 0.93;
    // Drum frame: +Y along the plate normal, origin at the plate's centre
    const y = n;
    const x = new THREE.Vector3(0, 1, 0).cross(y).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    const bind = new THREE.Matrix4().makeBasis(x, y, z).setPosition(flap.pivot);
    // The face disk is the plate's outer few mm (a hub runs in behind it):
    // the drum starts right under the disk and runs back past the push, so
    // the hub and the plate's seat are sleeved at every point of travel
    const face = size.x / 2;
    const y1 = face - 0.007;
    const y0 = y1 - FLARE_PUSH - 0.02;
    const rig = new THREE.Group();
    rig.add(tube(r, r, y0, y1, m.red, 32, true));
    // Bands stand a millimetre proud of the drum (closer, they flicker)
    rig.add(tube(r + 0.0012, r + 0.0012, y1 - 0.007, y1 - 0.003, m.gold, 32, true));
    rig.add(tube(r + 0.0012, r + 0.0012, y0 + 0.004, y0 + 0.007, m.gold, 32, true));
    const cells: THREE.Vector3[] = [];
    const portY = y1 - FLARE_PUSH * 0.55;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      // Dark port recess with a gold collar on the drum's side
      const port = new THREE.Group();
      port.position.copy(dir).multiplyScalar(r).setY(portY);
      port.rotation.y = -a;
      port.add(box(0.003, 0.012, 0.009, m.gold, 0, 0, 0));
      port.add(box(0.004, 0.009, 0.0065, m.gun, 0.0012, 0, 0));
      rig.add(port);
      cells.push(dir.clone().multiplyScalar(r + 0.004).setY(portY));
    }
    return { ...this.mount('hips', flap, bind, rig), cells, side: s };
  }

  private mount(bone: BoneName, flap: Flap, bind: THREE.Matrix4, rig: THREE.Group): Mount {
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.visible = false;
    root.add(rig);
    this.group.add(root);
    return { bone, flap, bind, rig, root };
  }

  /** root.matrix = dock(bone) · motion · bind */
  private place(mt: Mount, rig: SuitRig, modelInv: THREE.Matrix4, motion: THREE.Matrix4): void {
    const h = boneSpec(mt.bone).head;
    this._m.multiplyMatrices(modelInv, rig.bones[mt.bone].matrixWorld);
    this._m.multiply(this._t.makeTranslation(-h[0], -h[1], -h[2]));
    mt.root.matrix.multiplyMatrices(this._m, motion).multiply(mt.bind);
    mt.root.matrixWorldNeedsUpdate = true;
  }

  update(f: FlightCheckFrame, t: number, rig: SuitRig, modelInv: THREE.Matrix4, particles: SuitParticles): void {
    for (const mt of this.launchers) {
      const k = f.flaps[mt.flap.id] ?? 0;
      mt.root.visible = k > 0.01;
      mt.fixed.visible = mt.root.visible;
      const lock = mt.side === 'L' ? f.lockL : f.lockR;
      if (!mt.root.visible) {
        mt.lastLock = lock;
        mt.locked = false;
        continue;
      }
      // The lid swings clear, then the missile rises out of its bay
      const rise = MISSILE_RISE * ease(MISSILE_RISE_SPAN[0], MISSILE_RISE_SPAN[1], k);
      this.place(mt, rig, modelInv, this._lift.makeTranslation(mt.normal.x * rise, mt.normal.y * rise, mt.normal.z * rise));
      // Rams: forearm frame, from the bay floor to the lid as it lifts and slides back
      mt.fixed.matrix.copy(this._m);
      mt.fixed.matrixWorldNeedsUpdate = true;
      const lid = flapMotion(mt.flap, k, this._lid);
      for (const r of mt.rams) {
        const end = this._v.copy(r.end).applyMatrix4(lid);
        const dir = this._dir.subVectors(end, r.base);
        const d = dir.length();
        dir.divideScalar(Math.max(1e-6, d));
        r.sleeve.position.copy(r.base);
        r.sleeve.quaternion.setFromUnitVectors(UP, dir);
        r.sleeve.scale.set(1, Math.max(0.012, d * 0.6), 1);
        r.rod.position.copy(end);
        r.rod.quaternion.setFromUnitVectors(UP, this._dir2.copy(dir).negate());
        r.rod.scale.set(1, Math.max(0.012, d * 0.6), 1);
        r.eye.position.copy(end);
      }
      // Lock: the seeker flares, its ring lights, a laser ranges the bore
      // line for a beat and a puff of gas vents off the nose
      const up = ease(0.85, 1, k);
      mt.lens.emissiveIntensity = 0.6 + 4 * lock * up;
      mt.ring.opacity = up * (0.15 + 0.85 * lock);
      const beam = Math.min(1, Math.max(0, (lock - 0.3) / 0.7)) * up;
      mt.laser.visible = beam > 0.01;
      mt.laser.material.uniforms.uOpacity.value = beam;
      if (lock > mt.lastLock + 0.5) {
        mt.locked = true;
        const at = this._v.copy(mt.muzzle).applyMatrix4(mt.root.matrix);
        const dir = new THREE.Vector3(0, 1, 0).transformDirection(mt.root.matrix);
        particles.burst('steam', at, 2, dir);
      }
      if (k < 0.9) mt.locked = false;
      mt.lastLock = lock;
    }
    for (const mt of this.silos) {
      const k = f.flaps[mt.flap.id] ?? 0;
      mt.root.visible = k > 0.01;
      if (!mt.root.visible) continue;
      // The pod elevates under the trap plate, which rides on top of it,
      // parallel: both turn about the plate's back edge
      this.place(mt, rig, modelInv, flapMotion(mt.flap, k, this._lift));
      // Cells arm one at a time after the lock: each rocket runs out of
      // its cell and its light goes amber → green; all slide home first
      // as the silo sinks
      const home = ease(0.85, 1, k);
      mt.rockets.forEach((r, i) => {
        const out = Math.min(ease(0, 1, f.siloArmed - i), home);
        r.position.z = mt.front + 0.006 * out;
        const led = mt.cells[i].color;
        if (home < 0.98) led.copy(CELL_OFF);
        else led.copy(f.siloArmed - i >= 1 ? CELL_ARMED : CELL_ARMING);
      });
    }
    for (const mt of this.dispensers) {
      const k = f.flaps[mt.flap.id] ?? 0;
      mt.root.visible = k > 0.01;
      if (!mt.root.visible) continue;
      this.place(mt, rig, modelInv, flapMotion(mt.flap, k, this._lift));
    }
    this.siloArmed = f.siloArmed;
    this.updateFlares(t, particles);
  }

  /**
   * Deployed weapons for the HUD reticles (model space): launcher muzzles,
   * silo racks and flare drums, with how far each is locked / armed.
   */
  targets(f: FlightCheckFrame): WeaponTarget[] {
    const out: WeaponTarget[] = [];
    for (const mt of this.launchers) {
      if (!mt.root.visible) continue;
      const k = f.flaps[mt.flap.id] ?? 0;
      out.push({
        id: `at.${mt.side}`,
        label: `AT-${mt.side} ${mt.locked ? 'LOCK' : 'TRK'}`,
        at: mt.muzzle.clone().applyMatrix4(mt.root.matrix),
        lock: mt.locked ? 1 : 0.3 * k,
      });
    }
    // Both silos arm together: one box between the racks
    const silos = this.silos.filter((mt) => mt.root.visible);
    if (silos.length) {
      const at = new THREE.Vector3();
      for (const mt of silos) at.add(this._v.copy(mt.center).applyMatrix4(mt.root.matrix));
      const n = Math.floor(Math.min(6, this.siloArmed));
      out.push({ id: 'silos', label: `SILOS ${n}/6`, at: at.divideScalar(silos.length), lock: n / 6 });
    }
    for (const mt of this.dispensers) {
      if (!mt.root.visible) continue;
      const side = mt.side > 0 ? 'L' : 'R';
      const k = f.flaps[mt.flap.id] ?? 0;
      out.push({ id: `flr.${side}`, label: `FLR-${side}`, at: new THREE.Vector3().applyMatrix4(mt.root.matrix), lock: k > 0.9 ? 1 : 0.3 * k });
    }
    return out;
  }

  /** Pop flares on schedule and fly the live ones. */
  private updateFlares(t: number, particles: SuitParticles): void {
    const prev = this.lastT;
    this.lastT = t;
    const dt = Number.isFinite(prev) ? t - prev : 0;
    if (dt > 0 && dt < 0.5) {
      for (const pop of FLARE_POPS) {
        if (pop.t <= prev || pop.t > t) continue;
        const mt = this.dispensers.find((d) => (d.side > 0 ? 'L' : 'R') === pop.side && d.root.visible);
        if (!mt) continue;
        const cell = mt.cells[Math.floor(Math.random() * mt.cells.length)].clone().applyMatrix4(mt.root.matrix);
        // Out from the hip, kicked aft and a little up, then they fall
        const v = new THREE.Vector3(mt.side * (1.4 + Math.random() * 0.5), 0.9 + Math.random() * 0.4, -1.1 - Math.random() * 0.4);
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: this.flareTex, color: 0xfff1d0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
        );
        this.group.add(sprite);
        const spot = new THREE.Mesh(
          this.spotGeo,
          new THREE.MeshBasicMaterial({ map: this.flareTex, color: 0xffb070, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
        );
        spot.renderOrder = 3;
        this.group.add(spot);
        this.flares.push({ p: cell, v, life: 1.6, sprite, spot });
        particles.burst('sparks', cell, 16, v.clone().normalize());
        particles.burst('steam', cell, 3, v.clone().normalize());
      }
    }
    const step = Math.max(0, Math.min(0.05, dt));
    let lit: (typeof this.flares)[number] | null = null;
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const fl = this.flares[i];
      fl.life -= step;
      if (fl.life <= 0 || dt < 0) {
        this.removeFlare(fl);
        this.flares.splice(i, 1);
        continue;
      }
      if (!lit || fl.life > lit.life) lit = fl;
      // Light flares: heavy drag, gentle fall, skid on the deck
      fl.v.multiplyScalar(Math.exp(-1.8 * step));
      fl.v.y -= 4.5 * step;
      fl.p.addScaledVector(fl.v, step);
      if (fl.p.y < 0.01) {
        fl.p.y = 0.01;
        fl.v.y = Math.abs(fl.v.y) * 0.2;
      }
      const flick = 0.75 + 0.25 * Math.sin(t * 70 + i * 3);
      const fade = Math.min(1, fl.life * 2);
      fl.sprite.position.copy(fl.p);
      fl.sprite.scale.setScalar((0.07 + 0.05 * flick) * fade);
      // Hot spot on the deck under it: tight and bright as it comes down
      const near = Math.max(0, 1 - fl.p.y / 0.7);
      fl.spot.position.set(fl.p.x, 0.004, fl.p.z);
      fl.spot.scale.setScalar(0.12 + 0.22 * (1 - near));
      fl.spot.material.opacity = 0.65 * near * near * fade * flick;
      // Smoke trail — one puff per ~0.12 s of flight (time-based, so it
      // costs the same at any frame rate) and thin enough that the big soft
      // sprites never pile up into fill-rate-heavy overdraw
      fl.puff = (fl.puff ?? 0) + step;
      if (fl.puff > 0.12) {
        fl.puff = 0;
        particles.burst('steam', fl.p, 1, this._v.copy(fl.v).multiplyScalar(-0.2));
      }
    }
    if (lit) {
      this.flareLight.position.copy(lit.p);
      this.flareLight.intensity = 1.6 * Math.min(1, lit.life * 2) * (0.85 + 0.15 * Math.sin(t * 53));
    } else {
      this.flareLight.intensity = 0;
    }
  }

  private removeFlare(fl: (typeof this.flares)[number]): void {
    this.group.remove(fl.sprite, fl.spot);
    fl.sprite.material.dispose();
    fl.spot.material.dispose();
  }

  private readonly _lift = new THREE.Matrix4();

  hide(): void {
    for (const mt of [...this.launchers, ...this.silos, ...this.dispensers]) mt.root.visible = false;
    for (const mt of this.launchers) mt.fixed.visible = false;
    for (const fl of this.flares) this.removeFlare(fl);
    this.flares.length = 0;
    this.flareLight.intensity = 0;
    this.siloArmed = 0;
    this.lastT = Number.NaN;
  }
}
