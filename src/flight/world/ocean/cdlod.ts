/**
 * CDLOD quadtree for the sea surface: every frame, square nodes are chosen
 * around the eye (finer near it, 2x coarser per level, continuous vertex
 * morphing between levels in the vertex shader), frustum culled, and — new
 * here — dropped where the land stands well above the sea.
 *
 * Node selection after web-ocean (https://github.com/Noniv/web-ocean,
 * js/main.js selectNode/selectAll), MIT License, Copyright (c) 2026
 * Maksymilian Dendura. See ./LICENSE.
 */
import * as THREE from 'three';

export interface CdlodOptions {
  /** Finest node edge (m). */
  leaf: number;
  /** Quads per node edge. */
  grid: number;
  /** LOD-0 range as a multiple of the leaf size. */
  rangeK: number;
  levels: number;
  maxDist: number;
  maxNodes: number;
  /** Vertical / horizontal bounds of the displaced surface (m). */
  heightBound: number;
  sideBound: number;
}

/** Answers "is this whole square dry land, well above the waves?". */
export type LandTest = (x0: number, z0: number, size: number) => boolean;

export class Cdlod {
  readonly data: Float32Array;
  count = 0;
  readonly r0: number;
  private readonly ranges: Float64Array;
  private readonly frustum = new THREE.Frustum();
  private readonly box = new THREE.Box3();
  private readonly m = new THREE.Matrix4();
  private readonly eye = new THREE.Vector3();
  private cx = 0;
  private cy = 0;
  private cz = 0;

  constructor(
    readonly o: CdlodOptions,
    private readonly land: LandTest | null,
  ) {
    this.data = new Float32Array(o.maxNodes * 4);
    this.r0 = o.leaf * o.rangeK;
    this.ranges = new Float64Array(o.levels);
    for (let l = 0; l < o.levels; l++) this.ranges[l] = this.r0 * 2 ** l;
  }

  private sphereHit(x0: number, z0: number, size: number, r: number): boolean {
    const hb = this.o.heightBound;
    const dx = Math.max(x0 - this.cx, 0, this.cx - (x0 + size));
    const dz = Math.max(z0 - this.cz, 0, this.cz - (z0 + size));
    const dy = Math.max(-hb - this.cy, 0, this.cy - hb);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  private visible(x0: number, z0: number, size: number): boolean {
    const xb = this.o.sideBound;
    const hb = this.o.heightBound;
    this.box.min.set(x0 - xb, -hb, z0 - xb);
    this.box.max.set(x0 + size + xb, hb, z0 + size + xb);
    // Side planes only (three orders them first): the sea runs on past the
    // far plane and is pulled in by the vertex shader
    const planes = this.frustum.planes;
    for (let i = 0; i < 4; i++) {
      const pl = planes[i];
      const n = pl.normal;
      const px = n.x > 0 ? this.box.max.x : this.box.min.x;
      const py = n.y > 0 ? this.box.max.y : this.box.min.y;
      const pz = n.z > 0 ? this.box.max.z : this.box.min.z;
      if (n.x * px + n.y * py + n.z * pz + pl.constant < 0) return false;
    }
    return !(this.land && this.land(x0, z0, size));
  }

  private add(x0: number, z0: number, size: number, lod: number): void {
    if (this.count >= this.o.maxNodes) return;
    const i = this.count * 4;
    this.data[i] = x0;
    this.data[i + 1] = z0;
    this.data[i + 2] = size;
    this.data[i + 3] = lod;
    this.count++;
  }

  private node(x0: number, z0: number, size: number, lod: number): boolean {
    if (!this.sphereHit(x0, z0, size, this.ranges[lod])) return false;
    if (!this.sphereHit(x0, z0, size, this.o.maxDist) || !this.visible(x0, z0, size)) return true;
    if (lod === 0 || !this.sphereHit(x0, z0, size, this.ranges[lod - 1])) {
      this.add(x0, z0, size, lod);
      return true;
    }
    const h = size * 0.5;
    for (let i = 0; i < 4; i++) {
      const nx = x0 + (i & 1) * h;
      const nz = z0 + (i >> 1) * h;
      if (!this.node(nx, nz, h, lod - 1)) {
        if (this.sphereHit(nx, nz, h, this.o.maxDist) && this.visible(nx, nz, h)) this.add(nx, nz, h, lod - 1);
      }
    }
    return true;
  }

  select(camera: THREE.Camera): number {
    camera.updateMatrixWorld();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    const p = camera.getWorldPosition(this.eye);
    this.cx = p.x;
    this.cy = p.y;
    this.cz = p.z;
    this.count = 0;
    const top = this.o.levels - 1;
    const ts = this.o.leaf * 2 ** top;
    const md = this.o.maxDist;
    const x0 = Math.floor((this.cx - md) / ts);
    const x1 = Math.floor((this.cx + md) / ts);
    const z0 = Math.floor((this.cz - md) / ts);
    const z1 = Math.floor((this.cz + md) / ts);
    for (let zi = z0; zi <= z1; zi++) for (let xi = x0; xi <= x1; xi++) this.node(xi * ts, zi * ts, ts, top);
    return this.count;
  }
}

/**
 * Min-height pyramid of the heightfield: a node is dry land when the lowest
 * ground under it (plus a margin for the cubic filter) stands above `clear`.
 * Outside the heightfield nothing is culled.
 */
export function landTest(texels: Float32Array, res: number, worldSize: number, clear: number): LandTest {
  const levels: Float32Array[] = [texels];
  let n = res;
  while (n > 1) {
    const src = levels[levels.length - 1];
    const m = n >> 1;
    const dst = new Float32Array(m * m);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const a = src[2 * j * n + 2 * i];
        const b = src[2 * j * n + 2 * i + 1];
        const c = src[(2 * j + 1) * n + 2 * i];
        const d = src[(2 * j + 1) * n + 2 * i + 1];
        dst[j * m + i] = Math.min(a, b, c, d);
      }
    }
    levels.push(dst);
    n = m;
  }
  const texel = worldSize / res;
  const half = worldSize / 2;
  return (x0, z0, size) => {
    const pad = texel * 2;
    const ax = x0 - pad + half;
    const az = z0 - pad + half;
    const bx = x0 + size + pad + half;
    const bz = z0 + size + pad + half;
    if (ax < 0 || az < 0 || bx > worldSize || bz > worldSize) return false;
    const span = size + 2 * pad;
    const lvl = Math.min(levels.length - 1, Math.max(0, Math.ceil(Math.log2(span / texel)) - 1));
    const lr = res >> lvl;
    const lt = texel * (1 << lvl);
    const i0 = Math.floor(ax / lt);
    const i1 = Math.min(lr - 1, Math.floor(bx / lt));
    const j0 = Math.floor(az / lt);
    const j1 = Math.min(lr - 1, Math.floor(bz / lt));
    const L = levels[lvl];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (L[j * lr + i] < clear) return false;
    return true;
  };
}
