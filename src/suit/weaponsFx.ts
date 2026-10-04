import * as THREE from 'three';
import { FLARE_POPS, type FlightCheckFrame } from '../animation/flightCheck';
import { boneSpec, type BoneName } from './rig';
import type { SuitRig } from './rigPose';
import { FLARE_PUSH, flapMotion, forearmNormal, SILO_RISE, type Flap } from './flightFlaps';
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

/** Convex outline (x, z) of the vertices a flap geometry uses, grown by `pad`. */
function footprint(geo: THREE.BufferGeometry, pad: number): Array<[number, number]> {
  const pos = geo.getAttribute('position');
  const idx = geo.index!.array;
  const pts: Array<[number, number]> = [];
  const seen = new Set<number>();
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (seen.has(v)) continue;
    seen.add(v);
    pts.push([pos.getX(v), pos.getZ(v)]);
  }
  return inset(hull2(pts), -pad);
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

/** Keep the part of a convex outline with z ≤ c (Sutherland–Hodgman). */
function clipZ(poly: Array<[number, number]>, c: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ina = a[1] <= c;
    const inb = b[1] <= c;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (c - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, c]);
    }
  }
  return out.length >= 3 ? out : poly;
}

/** Shrink (d > 0) or grow (d < 0) a convex outline about its centroid. */
function inset(poly: Array<[number, number]>, d: number): Array<[number, number]> {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return poly.map(([x, z]) => {
    const r = Math.hypot(x - cx, z - cz) || 1;
    const k = Math.max(0, r - d) / r;
    return [cx + (x - cx) * k, cz + (z - cz) * k];
  });
}

/**
 * Grow a convex outline by `d` on every side: scaled about its centroid so
 * each edge stays parallel and moves out by at least `d`. (Pushing points
 * radially leaves edges that run toward the centroid where they were, in
 * the plane of the body's own face.)
 */
function grow(poly: Array<[number, number]>, d: number): Array<[number, number]> {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  let h = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    h = Math.min(h, Math.abs((bx - ax) * (az - cz) - (bz - az) * (ax - cx)) / len);
  }
  const k = 1 + d / Math.max(h, 1e-3);
  return poly.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k]);
}

/** Vertical prism over an (x, z) outline from y0 to y1. */
function prism(outline: Array<[number, number]>, y0: number, y1: number, m: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  // Shape (x, z) extruded along +Z → rotateX(+90°): (x, z, e) → (x, −e, z)
  g.rotateX(Math.PI / 2);
  g.translate(0, y1, 0);
  return new THREE.Mesh(g, m);
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

interface Launcher extends Mount {
  side: 'L' | 'R';
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
    Mount & { rockets: THREE.Object3D[]; cells: THREE.MeshBasicMaterial[]; front: number; side: number; center: THREE.Vector3 }
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

  /** Launcher frame: +X out of the forearm, +Y along it toward the hand. */
  private makeLauncher(side: 'L' | 'R', flap: Flap, m: ReturnType<typeof mats>): Launcher {
    const spec = boneSpec(`forearm.${side}`);
    const y = new THREE.Vector3(...spec.tail).sub(new THREE.Vector3(...spec.head)).normalize();
    const x = forearmNormal(side);
    const z = new THREE.Vector3().crossVectors(x, y);
    const at = flap.bounds.getCenter(new THREE.Vector3()).addScaledVector(x, -0.03);
    const bind = new THREE.Matrix4().makeBasis(x, y, z).setPosition(at);

    const rig = new THREE.Group();
    // Rail under the panel, launch tube, rocket nose in the muzzle
    rig.add(box(0.012, 0.126, 0.03, m.gun, 0.006, 0, 0));
    const pod = new THREE.Group();
    pod.position.set(0.012, 0, 0);
    // End caps are staggered by a millimetre or more: two caps in one plane flicker
    pod.add(tube(0.016, 0.016, -0.069, 0.064, m.gun, 20));
    pod.add(tube(0.0175, 0.0175, 0.048, 0.065, m.gold, 20));
    pod.add(tube(0.0175, 0.0175, -0.07, -0.056, m.gold, 20));
    pod.add(tube(0.0115, 0.0, 0.067, 0.093, m.red, 16));
    pod.add(tube(0.012, 0.012, 0.06, 0.0685, m.steel, 16));
    // Targeting lens (its own material: it flares on this launcher's lock)
    const lens = m.lens.clone();
    lens.emissiveIntensity = 0.6;
    pod.add(box(0.006, 0.01, 0.008, lens, 0.015, 0.03, 0));
    // Muzzle ring glows round the rocket nose once locked
    const ring = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xff6a2a).multiplyScalar(2),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.0118, 0.0168, 24).rotateX(-Math.PI / 2), ring);
    ringMesh.position.y = 0.0656;
    pod.add(ringMesh);
    rig.add(pod);
    // Laser: from the nose tip down the bore axis (toward the hand), 1.6 m
    const len = 1.6;
    const laserGeo = new THREE.CylinderGeometry(0.0012, 0.0012, len, 6, 1, true);
    laserGeo.translate(0, len / 2, 0);
    const laser = new THREE.Mesh(laserGeo, laserMaterial());
    laser.position.set(0.012, 0.094, 0);
    laser.visible = false;
    rig.add(laser);
    const muzzle = new THREE.Vector3(0.012, 0.094, 0);
    return { ...this.mount(`forearm.${side}`, flap, bind, rig), side, muzzle, lens, ring, laser, lastLock: 0, locked: false };
  }

  /**
   * Mini-rocket silo contoured to the trap panel: the panel's own footprint
   * extruded down as the silo body, so it rises as one with the armor. Its
   * front face carries a 3 × 2 rack of rockets pointing forward.
   */
  private makeSilo(s: number, flap: Flap, m: ReturnType<typeof mats>) {
    const b = flap.bounds;
    // A touch inside the panel outline so the lifted panel overhangs it like a lid
    // Flat front face for the rocket rack (outline clipped at z ≤ face)
    const raw = footprint(flap.mesh.geometry, -0.02);
    const face = Math.max(...raw.map((q) => q[1])) - 0.012;
    const foot = clipZ(raw, face);
    // Top tucks halfway into the panel; the exposed band is SILO_RISE tall
    const half = (b.max.y - b.min.y) / 2;
    const H = half + SILO_RISE + 0.01;
    // Silo top tucks halfway into the panel so no gap opens under its high side
    const bind = new THREE.Matrix4().makeTranslation(0, (b.min.y + b.max.y) / 2, 0);
    const rig = new THREE.Group();
    // Body (contoured prism) + gold rim just under the lid
    rig.add(prism(foot, -H, 0, m.red));
    rig.add(prism(grow(foot, 0.0015), -half - 0.006, -half - 0.002, m.gold));
    // Second gold band low on the exposed sleeve + a dark seam between
    rig.add(prism(grow(foot, 0.0012), -half - SILO_RISE * 0.86, -half - SILO_RISE * 0.8, m.gold));
    rig.add(prism(grow(foot, 0.001), -half - SILO_RISE * 0.5, -half - SILO_RISE * 0.47, m.gun));
    // Front face: bezel plate and the rocket rack, aimed forward (+Z)
    // Rack sits on the silo's own front face
    const front = Math.max(...foot.map((q) => q[1]));
    const cx = foot.filter((q) => q[1] > front - 0.003).reduce((a, q, _i, arr) => a + q[0] / arr.length, 0);
    // Rack spans the silo's own front face (never wider than the silo)
    const fx = foot.filter((q) => q[1] > front - 0.003).map((q) => q[0]);
    const w = Math.min(0.055, (Math.max(...fx) - Math.min(...fx)) * 0.82);
    const bezel = box(w, 0.042, 0.006, m.gun, cx, -0.0222, front + 0.001);
    rig.add(bezel);
    const rockets: THREE.Object3D[] = [];
    const cells: THREE.MeshBasicMaterial[] = [];
    // 2 × 3 rack; neighbouring collars must not touch (touching facets flicker)
    const collar = Math.min(0.0054, w * 0.25 - 0.0008);
    const band = Math.min(0.0064, collar - 0.0004);
    const body = Math.min(0.0055, collar - 0.0012);
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 3; j++) {
        const r = new THREE.Group();
        r.position.set(cx + (i - 0.5) * w * 0.5, -0.01 - j * 0.0122, front - 0.012);
        r.rotation.x = Math.PI / 2; // tube +Y → forward
        r.add(tube(collar, collar, -0.004, 0.0, m.gold, 12)); // cell collar
        r.add(tube(body, body, 0.0008, 0.016, m.steel, 10));
        r.add(tube(band, band, 0.011, 0.014, m.gold, 10)); // warhead band
        r.add(tube(body, 0.0, 0.016, 0.028, m.red, 10));
        rig.add(r);
        rockets.push(r);
        // Cell light on the bezel beside each rocket, outboard of its column
        const led = new THREE.MeshBasicMaterial({ color: CELL_OFF.clone(), toneMapped: false });
        const lx = r.position.x + (i === 0 ? -1 : 1) * (collar + 0.0032);
        rig.add(box(0.0024, 0.0024, 0.002, led, lx, r.position.y, front + 0.0045));
        cells.push(led);
      }
    }
    // Arming order: top row first, outboard column before inboard
    const order = [0, 3, 1, 4, 2, 5].map((k) => (s > 0 ? k : k < 3 ? k + 3 : k - 3));
    const byArm = order.map((k) => rockets[k]);
    const cellsByArm = order.map((k) => cells[k]);
    const center = new THREE.Vector3(cx, -0.022, front);
    // Hinge pins + sensor
    rig.add(box(0.008, 0.005, 0.003, m.lens, cx + s * w * 0.42, -0.006, front + 0.0045));
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
      const lock = mt.side === 'L' ? f.lockL : f.lockR;
      if (!mt.root.visible) {
        mt.lastLock = lock;
        mt.locked = false;
        continue;
      }
      // Rides the panel exactly (lift + its small tilt)
      this.place(mt, rig, modelInv, flapMotion(mt.flap, k, this._lift));
      // Lock: lens flares, the muzzle ring lights, a laser ranges the bore
      // line for a beat and a puff of gas vents from the tube
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
      // Rides the trap panel straight up (the same lift)
      this.place(mt, rig, modelInv, flapMotion(mt.flap, k, this._lift));
      // Cells arm one at a time after the lock: each rocket runs out of
      // its cell and its light goes amber → green; all slide home first
      // as the silo sinks
      const home = ease(0.85, 1, k);
      mt.rockets.forEach((r, i) => {
        const out = Math.min(ease(0, 1, f.siloArmed - i), home);
        r.position.z = mt.front - 0.012 + 0.012 * out;
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
    for (const fl of this.flares) this.removeFlare(fl);
    this.flares.length = 0;
    this.flareLight.intensity = 0;
    this.siloArmed = 0;
    this.lastT = Number.NaN;
  }
}
