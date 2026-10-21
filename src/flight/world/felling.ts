import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import { GRAVITY } from './config';
import type { Heightfield } from './heightfield';

/**
 * What the unibeam does to the trees: a stem it crosses is cut through at
 * the height it crossed, the cut glowing, and the top tips away from the
 * suit, slowly at first, then crashes down, bounces and lies there, the
 * stump smoking. Brush in its path just burns off.
 *
 * Each felled tree is drawn twice from its close build: the stump (kept
 * below the cut) where it stood, and the top (kept above it) pivoting on
 * the cut's far edge. The cut face is the inside of the trunk's tube,
 * charred and glowing while it's hot.
 */

/** How a kind stands up to the beam, in model units. */
export interface FellProfile {
  /** Top of the model (m). */
  height: number;
  /** Where the stem can be cut through (m): lowest, highest. None: it burns off instead. */
  cut?: readonly [number, number];
  /** How close the beam has to pass to the stem's axis at a height (m). */
  girth: (y: number) => number;
  /** How far the fallen crown holds the stem off the ground (m). */
  rest?: number;
}

export const FELL: Record<string, FellProfile> = {
  oak: { height: 7.4, cut: [0.3, 1.5], girth: (y) => (y < 1.7 ? 0.45 : 3), rest: 1.6 },
  pine: { height: 10.8, cut: [0.3, 8], girth: (y) => (y < 2 ? 0.3 : 0.3 + 2.2 * Math.max(0, 1 - (y - 2) / 9)), rest: 1.2 },
  // (the trunk bends out ~1 m by the crown)
  palm: { height: 15, cut: [0.4, 11.5], girth: (y) => (y < 12 ? 0.45 + 0.9 * (y / 13) ** 2 : 2.4), rest: 0.6 },
  olive: { height: 5, cut: [0.3, 1], girth: (y) => (y < 1.2 ? 0.6 : 2.2), rest: 1.1 },
  cypress: { height: 11, cut: [0.3, 8], girth: (y) => (y < 1 ? 0.25 : 0.85), rest: 0.7 },
  bush: { height: 1.6, girth: () => 1.2 },
  hedge: { height: 1.3, girth: () => 1.1 },
  agave: { height: 1.1, girth: () => 0.9 },
};

/** Felled trees kept per kind (the oldest go first). */
const CAP = 24;
/** Seconds a cut takes to cool. */
const COOL = 10;

interface Tree {
  kind: string;
  /** Where it stood. */
  m0: THREE.Matrix4;
  tint: THREE.Color;
  cut: number;
  /** Height-wise scale. */
  s: number;
  /** The cut's far edge as it was, and where it is now. */
  pivot0: THREE.Vector3;
  pivot: THREE.Vector3;
  /** Horizontal, away from the beam. */
  fall: THREE.Vector3;
  axis: THREE.Vector3;
  /** Length of the top (m). */
  length: number;
  theta: number;
  omega: number;
  /** Once tipped far enough the top slides off the stump and drops. */
  released: boolean;
  vy: number;
  /** Lowest the top can lie (the deck a garden stands on). */
  floor: number;
  landed: boolean;
  settled: boolean;
  heat: number;
  stumpTop: THREE.Vector3;
}

export interface FellFx {
  particles: Particles;
  events: EventBus;
}

const UP = new THREE.Vector3(0, 1, 0);
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _v = new THREE.Vector3();

export class Felling {
  readonly group = new THREE.Group();
  /** Set by the sim: the felling's sparks, smoke and sounds go through it. */
  fx: FellFx | null = null;
  private readonly slots = new Map<string, { mesh: THREE.InstancedMesh; cut: THREE.InstancedBufferAttribute }>();
  private readonly trees: Tree[] = [];

  constructor(
    private readonly field: Heightfield,
    private readonly material: THREE.Material,
  ) {
    this.group.name = 'felled';
  }

  /** A kind that can be felled, drawn with this (close) build. */
  register(kind: string, geo: THREE.BufferGeometry): void {
    if (this.slots.has(kind) || !FELL[kind]?.cut) return;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
    const cut = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aCut', cut);
    const mesh = new THREE.InstancedMesh(g, this.material, CAP * 2);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.slots.set(kind, { mesh, cut });
  }

  /**
   * Where a beam (from `from` along unit `dir` for `reach` m, `radius` m
   * thick) crosses a plant standing at `m`: the height up its stem (model
   * units), or −1 if it misses.
   */
  strike(kind: string, m: THREE.Matrix4, from: THREE.Vector3, dir: THREE.Vector3, reach: number, radius: number): number {
    const prof = FELL[kind];
    if (!prof) return -1;
    _inv.copy(m).invert();
    const a = _a.copy(from).applyMatrix4(_inv);
    const b = _b.copy(from).addScaledVector(dir, reach).applyMatrix4(_inv).sub(a);
    // Closest approach to the stem's axis (the model's own y)
    const bb = b.x * b.x + b.z * b.z;
    const t = bb > 1e-9 ? THREE.MathUtils.clamp(-(a.x * b.x + a.z * b.z) / bb, 0, 1) : 1;
    const p = a.addScaledVector(b, t);
    if (p.y < -0.6 || p.y > prof.height) return -1;
    const y = Math.max(0, p.y);
    const wide = _v.setFromMatrixColumn(m, 0).length();
    return Math.hypot(p.x, p.z) < prof.girth(y) + radius / wide ? y : -1;
  }

  /** Cuts a tree standing at `m` through at `y` (model units); it falls away from `from`. */
  fell(kind: string, m: THREE.Matrix4, tint: THREE.Color, y: number, from: THREE.Vector3, floor = -Infinity): void {
    const prof = FELL[kind];
    if (!prof?.cut || !this.slots.has(kind)) return this.burn(m);
    const cut = THREE.MathUtils.clamp(y, prof.cut[0], prof.cut[1]);
    const s = _v.setFromMatrixColumn(m, 1).length();
    const wide = _v.setFromMatrixColumn(m, 0).length();
    const base = new THREE.Vector3().setFromMatrixPosition(m);
    const fall = new THREE.Vector3(base.x - from.x, 0, base.z - from.z);
    if (fall.lengthSq() < 1e-4) fall.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    fall.normalize().applyAxisAngle(UP, (Math.random() - 0.5) * 0.8);
    const stumpTop = new THREE.Vector3(0, cut, 0).applyMatrix4(m);
    const pivot0 = stumpTop.clone().addScaledVector(fall, 0.3 * wide);
    const kept = this.trees.filter((t) => t.kind === kind);
    if (kept.length >= CAP) this.trees.splice(this.trees.indexOf(kept[0]), 1);
    this.trees.push({
      kind,
      m0: m.clone(),
      tint: tint.clone(),
      cut,
      s,
      pivot0,
      pivot: pivot0.clone(),
      fall,
      axis: new THREE.Vector3().crossVectors(UP, fall).normalize(),
      length: (prof.height - cut) * s,
      theta: 0.02,
      omega: 0.25 + Math.random() * 0.2,
      released: false,
      vy: 0,
      floor,
      landed: false,
      settled: false,
      heat: 1,
      stumpTop,
    });
    if (!this.fx) return;
    const P = this.fx.particles;
    _v.copy(fall).negate();
    P.burst('spark', stumpTop, 14, 14, _v, 1.2);
    P.burst('ember', stumpTop, 6, 4, UP, 1);
    P.emit('fire', stumpTop, _c.set(0, 2, 0), { scale: 0.5 * wide });
    P.emit('smoke', stumpTop, _c.set(0, 2, 0), { scale: 0.6 });
    this.fx.events.emit('treeCut', { at: stumpTop, value: s });
  }

  /** Brush in the beam's path: gone in a flare of fire and smoke. */
  burn(m: THREE.Matrix4): void {
    if (!this.fx) return;
    const s = _v.setFromMatrixColumn(m, 1).length();
    const at = _c.set(0, 0.5, 0).applyMatrix4(m);
    const P = this.fx.particles;
    P.emit('fire', at, _a.set(0, 2.5, 0), { scale: 0.7 * s });
    P.burst('ember', at, 5, 5, UP, 1);
    if (Math.random() < 0.6) P.emit('darkSmoke', at, _a.set(0, 2, 0), { scale: 0.35 * s });
  }

  update(dt: number): void {
    if (!this.trees.length) return;
    const counts = new Map<string, number>();
    for (const tree of this.trees) {
      tree.heat = Math.max(0, tree.heat - dt / COOL);
      if (!tree.settled) {
        // Substeps: a fast fall mustn't tunnel through the ground
        const n = Math.ceil(dt / (1 / 120));
        for (let i = 0; i < n; i++) this.step(tree, dt / n);
      }
      this.smoulder(tree, dt);
      const slot = this.slots.get(tree.kind)!;
      const i = counts.get(tree.kind) ?? 0;
      counts.set(tree.kind, i + 2);
      // The stump where it stood; the top swung about the cut's far edge
      slot.mesh.setMatrixAt(i, tree.m0);
      _q.setFromAxisAngle(tree.axis, tree.theta);
      _m.makeTranslation(tree.pivot.x, tree.pivot.y, tree.pivot.z)
        .multiply(_t.makeRotationFromQuaternion(_q))
        .multiply(_t.makeTranslation(-tree.pivot0.x, -tree.pivot0.y, -tree.pivot0.z))
        .multiply(tree.m0);
      slot.mesh.setMatrixAt(i + 1, _m);
      slot.mesh.setColorAt(i, tree.tint);
      slot.mesh.setColorAt(i + 1, tree.tint);
      slot.cut.setXYZ(i, tree.cut, -1, tree.heat);
      slot.cut.setXYZ(i + 1, tree.cut, 1, tree.heat);
    }
    for (const [kind, slot] of this.slots) {
      slot.mesh.count = counts.get(kind) ?? 0;
      slot.mesh.instanceMatrix.needsUpdate = true;
      slot.mesh.instanceColor!.needsUpdate = true;
      slot.cut.needsUpdate = true;
    }
  }

  private ground(x: number, z: number, floor: number): number {
    return Math.max(this.field.surfaceAt(x, z), floor);
  }

  /** The top: a crown-heavy pole tipping over its pivot, then dropping off the stump. */
  private step(tree: Tree, dt: number): void {
    const L = tree.length;
    const lever = 0.55 * L;
    tree.omega += (GRAVITY * lever * Math.sin(tree.theta)) / (lever * lever + (0.3 * L) ** 2) * dt;
    tree.theta = Math.min(1.9, tree.theta + tree.omega * dt);
    if (!tree.released && tree.theta > 0.45) tree.released = true;
    const floor = this.ground(tree.pivot.x, tree.pivot.z, tree.floor) + 0.25 * tree.s;
    if (tree.released && tree.pivot.y > floor) {
      tree.vy -= GRAVITY * dt;
      tree.pivot.y = Math.max(floor, tree.pivot.y + tree.vy * dt);
      if (tree.pivot.y === floor) tree.vy = 0;
    }
    // The crown (and the tip) meeting the ground stops it
    const prof = FELL[tree.kind];
    const along = _a.copy(UP).multiplyScalar(Math.cos(tree.theta)).addScaledVector(tree.fall, Math.sin(tree.theta));
    let contact: THREE.Vector3 | null = null;
    for (const [f, rest] of [
      [0.7, 1],
      [1, 0.35],
    ] as const) {
      const c = _c.copy(tree.pivot).addScaledVector(along, f * L);
      if (c.y - (prof.rest ?? 1) * rest * tree.s < this.ground(c.x, c.z, tree.floor)) {
        contact = c;
        break;
      }
    }
    if (contact && tree.omega > 0) {
      if (!tree.landed) {
        tree.landed = true;
        if (this.fx) {
          const P = this.fx.particles;
          P.burst('dust', contact, 10, 7, UP, 1.2, { scale: 0.8 + L * 0.06 });
          P.burst('dust', tree.pivot, 4, 4, UP, 1, { scale: 0.7 });
          this.fx.events.emit('treeFall', { at: contact, value: L });
        }
      }
      tree.omega = tree.omega > 0.8 ? -tree.omega * 0.15 : 0;
    }
    if (tree.landed && Math.abs(tree.omega) < 0.03 && (!tree.released || tree.pivot.y <= floor)) tree.settled = true;
  }

  /** A hot cut smokes and drops embers while it cools. */
  private smoulder(tree: Tree, dt: number): void {
    if (!this.fx || tree.heat < 0.1) return;
    const P = this.fx.particles;
    const h = tree.heat;
    if (Math.random() < dt * 3 * h) P.emit('smoke', tree.stumpTop, _a.set(0, 1.5, 0), { scale: 0.3 + 0.3 * h });
    if (Math.random() < dt * 8 * h) P.emit('ember', tree.stumpTop, _a.set(Math.random() - 0.5, 1.5, Math.random() - 0.5));
  }
}
