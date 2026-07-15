import * as THREE from 'three';

export interface MeshShard {
  mesh: THREE.Mesh;
  restPosition: THREE.Vector3;
  restRotation: THREE.Euler;
  restScale: THREE.Vector3;
  centroid: THREE.Vector3;
}

/**
 * Split a list of non-indexed triangle indices into connectivity islands.
 * Non-indexed meshes don't share vertex indices, so we weld by quantized
 * world position. Used so arm + thigh geometry that land in the same grid
 * cell (e.g. former thighs#103 / #111) become separate fly-in plates.
 */
function splitTrisByConnectivity(
  tris: number[],
  pos: THREE.BufferAttribute,
  world: THREE.Matrix4,
  quantize: number,
): number[][] {
  const n = tris.length;
  if (n <= 1) return n === 1 ? [tris] : [];

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    // path compression
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c];
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const vertToTri = new Map<string, number>();
  const v = new THREE.Vector3();
  const q = Math.max(quantize, 1e-6);

  for (let ti = 0; ti < n; ti++) {
    const t = tris[ti];
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(world);
      const key = `${Math.round(v.x / q)},${Math.round(v.y / q)},${Math.round(v.z / q)}`;
      const prev = vertToTri.get(key);
      if (prev === undefined) {
        vertToTri.set(key, ti);
      } else {
        union(ti, prev);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let ti = 0; ti < n; ti++) {
    const root = find(ti);
    let g = groups.get(root);
    if (!g) {
      g = [];
      groups.set(root, g);
    }
    g.push(tris[ti]);
  }
  return [...groups.values()];
}

/**
 * Split a mesh into spatial shards for a "suit assembly" fly-in effect.
 * Buckets triangles by a 3D grid over the mesh bounds, then splits each
 * bucket into connectivity islands so disconnected armor parts never share
 * a piece (arm fragment glued to a thigh plate, e.g. former thighs#103/#111).
 */
export function splitMeshIntoShards(
  source: THREE.Mesh,
  grid: { x: number; y: number; z: number } = { x: 3, y: 6, z: 3 },
): MeshShard[] {
  const geometry = source.geometry.index
    ? source.geometry.toNonIndexed()
    : source.geometry.clone();

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | null;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | null;
  const color = geometry.getAttribute('color') as THREE.BufferAttribute | null;

  const triCount = pos.count / 3;
  if (triCount < 1) return [];

  // World-space triangle centroids for bucketing
  source.updateWorldMatrix(true, false);
  const world = source.matrixWorld;

  const centroids: THREE.Vector3[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const bounds = new THREE.Box3();

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    a.fromBufferAttribute(pos, i).applyMatrix4(world);
    b.fromBufferAttribute(pos, i + 1).applyMatrix4(world);
    c.fromBufferAttribute(pos, i + 2).applyMatrix4(world);
    const centroid = new THREE.Vector3()
      .addVectors(a, b)
      .add(c)
      .multiplyScalar(1 / 3);
    centroids.push(centroid);
    bounds.expandByPoint(centroid);
  }

  const size = new THREE.Vector3();
  bounds.getSize(size);
  // Avoid zero-size axes
  size.x = Math.max(size.x, 1e-4);
  size.y = Math.max(size.y, 1e-4);
  size.z = Math.max(size.z, 1e-4);

  // Weld epsilon for non-indexed edges (~1–2 mm). Too tight fragments a
  // single plate; too loose can glue unrelated islands across a gap.
  const weldEps = Math.max(size.length() * 5e-4, 1.5e-3);

  type Bucket = number[]; // triangle indices
  const buckets = new Map<string, Bucket>();

  for (let t = 0; t < triCount; t++) {
    const p = centroids[t];
    const ix = Math.min(
      grid.x - 1,
      Math.max(0, Math.floor(((p.x - bounds.min.x) / size.x) * grid.x)),
    );
    const iy = Math.min(
      grid.y - 1,
      Math.max(0, Math.floor(((p.y - bounds.min.y) / size.y) * grid.y)),
    );
    const iz = Math.min(
      grid.z - 1,
      Math.max(0, Math.floor(((p.z - bounds.min.z) / size.z) * grid.z)),
    );
    const key = `${ix},${iy},${iz}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(t);
  }

  const shards: MeshShard[] = [];
  const mat = Array.isArray(source.material)
    ? source.material[0]
    : source.material;

  const buildShard = (key: string, tris: number[], part: number) => {
    if (tris.length === 0) return;

    const vertCount = tris.length * 3;
    const positions = new Float32Array(vertCount * 3);
    const normals = normal ? new Float32Array(vertCount * 3) : null;
    const uvs = uv ? new Float32Array(vertCount * 2) : null;
    const colors = color
      ? new Float32Array(vertCount * (color.itemSize || 3))
      : null;

    const localCentroid = new THREE.Vector3();
    let vi = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const src = t * 3 + k;
        a.fromBufferAttribute(pos, src).applyMatrix4(world);
        localCentroid.add(a);
        positions[vi * 3] = a.x;
        positions[vi * 3 + 1] = a.y;
        positions[vi * 3 + 2] = a.z;

        if (normals && normal) {
          a.fromBufferAttribute(normal, src);
          a.transformDirection(world);
          normals[vi * 3] = a.x;
          normals[vi * 3 + 1] = a.y;
          normals[vi * 3 + 2] = a.z;
        }
        if (uvs && uv) {
          uvs[vi * 2] = uv.getX(src);
          uvs[vi * 2 + 1] = uv.getY(src);
        }
        if (colors && color) {
          for (let ci = 0; ci < color.itemSize; ci++) {
            colors[vi * color.itemSize + ci] = color.getComponent(src, ci);
          }
        }
        vi++;
      }
    }
    localCentroid.multiplyScalar(1 / vertCount);

    for (let i = 0; i < vertCount; i++) {
      positions[i * 3] -= localCentroid.x;
      positions[i * 3 + 1] -= localCentroid.y;
      positions[i * 3 + 2] -= localCentroid.z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (normals) {
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else {
      geo.computeVertexNormals();
    }
    if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (colors && color) {
      geo.setAttribute(
        'color',
        new THREE.BufferAttribute(colors, color.itemSize),
      );
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name =
      part > 0
        ? `${source.name || 'shard'}_${key}_p${part}`
        : `${source.name || 'shard'}_${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(localCentroid);

    shards.push({
      mesh,
      restPosition: localCentroid.clone(),
      restRotation: new THREE.Euler(0, 0, 0),
      restScale: new THREE.Vector3(1, 1, 1),
      centroid: localCentroid.clone(),
    });
  };

  /**
   * Coarse body band — used to decide whether two modes should stay apart.
   * Absolute meters match loadSuitModel classifyWave heuristics.
   */
  const bandOf = (c: THREE.Vector3): string => {
    const y = c.y;
    const r = Math.hypot(c.x, c.z);
    if (y < 0.15) return 'boots';
    if (y < 0.5) return 'calves';
    // Hanging hands / gauntlets — further out than body thigh armor
    if (y < 1.05 && r >= 0.26) return 'arms';
    // Elbow / lower upper-arm just above hip crease (thighs#103/#111 arm half)
    if (y >= 1.0 && y < 1.18 && r >= 0.15) return 'arms';
    if (y < 1.05) return 'thighs';
    if (y < 1.2 && r < 0.14) return 'torso';
    if (y < 1.4 && r >= 0.14) return 'arms';
    if (y < 1.52 && r >= 0.14) return 'shoulders';
    if (y >= 1.5) return 'helmet';
    return 'torso';
  };

  const islandCentroid = (comp: number[]) => {
    const c = new THREE.Vector3();
    for (const t of comp) c.add(centroids[t]);
    return c.multiplyScalar(1 / Math.max(comp.length, 1));
  };

  /** 1D 2-means on a scalar projected from each triangle centroid. */
  const tryBimodalSplit = (
    tris: number[],
    project: (c: THREE.Vector3) => number,
    minSpan: number,
    minSep: number,
  ): number[][] | null => {
    if (tris.length < 24) return null;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const t of tris) {
      const v = project(centroids[t]);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    if (maxV - minV < minSpan) return null;

    let cA = minV;
    let cB = maxV;
    for (let iter = 0; iter < 6; iter++) {
      let sA = 0;
      let nA = 0;
      let sB = 0;
      let nB = 0;
      for (const t of tris) {
        const v = project(centroids[t]);
        if (Math.abs(v - cA) <= Math.abs(v - cB)) {
          sA += v;
          nA++;
        } else {
          sB += v;
          nB++;
        }
      }
      if (nA < 8 || nB < 8) return null;
      cA = sA / nA;
      cB = sB / nB;
    }
    if (Math.abs(cA - cB) < minSep) return null;

    const groupA: number[] = [];
    const groupB: number[] = [];
    for (const t of tris) {
      const v = project(centroids[t]);
      if (Math.abs(v - cA) <= Math.abs(v - cB)) groupA.push(t);
      else groupB.push(t);
    }

    const ca = islandCentroid(groupA);
    const cb = islandCentroid(groupB);
    const dist = ca.distanceTo(cb);
    // Keep if bands differ, L/R mirrors, body vs hand, or far duals
    if (bandOf(ca) !== bandOf(cb)) return [groupA, groupB];
    if (
      Math.sign(ca.x) !== Math.sign(cb.x) &&
      Math.abs(ca.x) > 0.05 &&
      Math.abs(cb.x) > 0.05
    ) {
      return [groupA, groupB];
    }
    const ra = Math.hypot(ca.x, ca.z);
    const rb = Math.hypot(cb.x, cb.z);
    if ((ra < 0.24 && rb >= 0.26) || (rb < 0.24 && ra >= 0.26)) {
      return [groupA, groupB];
    }
    // Hip-height thigh vs arm vertical dual
    if (
      Math.abs(ca.y - cb.y) > 0.08 &&
      Math.min(ca.y, cb.y) < 1.05 &&
      Math.max(ca.y, cb.y) > 0.95 &&
      Math.min(ra, rb) < 0.24
    ) {
      return [groupA, groupB];
    }
    if (dist >= 0.16) return [groupA, groupB];
    return null;
  };

  /**
   * When connectivity welds arm+thigh (or body+hand) across a thin bridge,
   * split by height and/or radial modes that map to different body parts.
   */
  const trySpatialBandSplit = (tris: number[]): number[][] | null => {
    // Prefer radial first: hanging hands sit at same height as outer thighs
    // (body r≲0.24 vs hand r≳0.26 — modes can be only ~0.05–0.08 apart)
    const byR = tryBimodalSplit(
      tris,
      (c) => Math.hypot(c.x, c.z),
      0.05,
      0.04,
    );
    if (byR) return byR;
    // Lateral L/R dual plates sharing a mid-body grid cell
    const byX = tryBimodalSplit(tris, (c) => c.x, 0.1, 0.08);
    if (byX) return byX;
    return tryBimodalSplit(tris, (c) => c.y, 0.12, 0.08);
  };

  /**
   * Coarse key: body wave + inner/outer radial. Side (L/R) is applied only
   * when a coarse group actually contains substantial geometry on both sides
   * (fixes former thighs#103 / #111 dual plates without shredding panels).
   */
  const coarseKey = (c: THREE.Vector3): string => {
    const band = bandOf(c);
    const r = Math.hypot(c.x, c.z);
    const zone = r >= 0.26 ? 'out' : 'in';
    return `${band}|${zone}`;
  };
  const sideOf = (c: THREE.Vector3): 'L' | 'R' | 'M' =>
    c.x > 0.1 ? 'R' : c.x < -0.1 ? 'L' : 'M';

  for (const [key, tris] of buckets) {
    if (tris.length === 0) continue;

    const raw = splitTrisByConnectivity(tris, pos, world, weldEps);

    // Expand connectivity islands with spatial bi-modal split when a thin
    // bridge welded two body parts (arm/thigh or body/hand).
    const expanded: number[][] = [];
    for (const comp of raw) {
      if (comp.length === 0) continue;
      const spatial = trySpatialBandSplit(comp);
      if (spatial) expanded.push(...spatial);
      else expanded.push(comp);
    }

    let candidates =
      expanded.length > 0 ? expanded : trySpatialBandSplit(tris) ?? [tris];
    if (candidates.length === 1) {
      const spatial = trySpatialBandSplit(candidates[0]);
      if (spatial) candidates = spatial;
    }

    // 1) Group by band + radial zone
    type Group = { tris: number[]; c: THREE.Vector3 };
    const coarse = new Map<string, Group>();
    const scraps: number[][] = [];

    for (const part of candidates) {
      if (part.length === 0) continue;
      if (part.length < 12) {
        scraps.push(part);
        continue;
      }
      const c = islandCentroid(part);
      const ck = coarseKey(c);
      const g = coarse.get(ck);
      if (g) {
        g.tris.push(...part);
        g.c = islandCentroid(g.tris);
      } else {
        coarse.set(ck, { tris: [...part], c });
      }
    }

    for (const scrap of scraps) {
      const sc = islandCentroid(scrap);
      let bestKey: string | null = null;
      let bestD = Infinity;
      for (const [ck, g] of coarse) {
        const d = sc.distanceTo(g.c);
        if (d < bestD) {
          bestD = d;
          bestKey = ck;
        }
      }
      if (bestKey) {
        const g = coarse.get(bestKey)!;
        g.tris.push(...scrap);
        g.c = islandCentroid(g.tris);
      } else {
        coarse.set(`scrap-${coarse.size}`, { tris: scrap, c: sc });
      }
    }

    // 2) Within each coarse group, split L/R only if both sides are large
    //    (fixes midline dual plates without shredding every panel).
    const finalGroups: Group[] = [];
    for (const g of coarse.values()) {
      let nL = 0;
      let nR = 0;
      let nM = 0;
      for (const t of g.tris) {
        const s = sideOf(centroids[t]);
        if (s === 'L') nL++;
        else if (s === 'R') nR++;
        else nM++;
      }
      const bothSides = nL >= 20 && nR >= 20;
      if (!bothSides) {
        finalGroups.push(g);
        continue;
      }
      const left: number[] = [];
      const right: number[] = [];
      const mid: number[] = [];
      for (const t of g.tris) {
        const s = sideOf(centroids[t]);
        if (s === 'L') left.push(t);
        else if (s === 'R') right.push(t);
        else mid.push(t);
      }
      // Midline tris join the larger side
      if (left.length >= right.length) left.push(...mid);
      else right.push(...mid);
      if (left.length) {
        finalGroups.push({ tris: left, c: islandCentroid(left) });
      }
      if (right.length) {
        finalGroups.push({ tris: right, c: islandCentroid(right) });
      }
    }

    if (finalGroups.length <= 1) {
      buildShard(key, finalGroups[0]?.tris ?? tris, 0);
      continue;
    }

    let part = 0;
    for (const g of finalGroups) {
      buildShard(key, g.tris, part++);
    }
  }

  return shards;
}

/**
 * Global pre-sort (bottom→top, then spine). Final attach order is still
 * computed per-wave in assemblyOrder.sortPiecesInWave (neighbor growth).
 */
export function sortShardsInsideOut(shards: MeshShard[]): MeshShard[] {
  let minY = Infinity;
  let maxY = -Infinity;
  let maxR = 0;
  for (const s of shards) {
    minY = Math.min(minY, s.centroid.y);
    maxY = Math.max(maxY, s.centroid.y);
    maxR = Math.max(maxR, Math.hypot(s.centroid.x, s.centroid.z));
  }
  const yRange = Math.max(1e-4, maxY - minY);
  maxR = Math.max(maxR, 1e-4);

  // Prefer height so IDs loosely match structural build; radial is secondary
  const WR = 0.35;
  const WY = 0.65;

  return [...shards].sort((a, b) => {
    const score = (s: MeshShard) => {
      const rNorm = Math.hypot(s.centroid.x, s.centroid.z) / maxR;
      const yNorm = (s.centroid.y - minY) / yRange;
      return WY * yNorm + WR * rNorm;
    };
    return score(a) - score(b);
  });
}
