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
    const ax = Math.abs(c.x);
    if (y < 0.15) return 'boots';
    if (y < 0.5) return 'calves';
    // Hanging hands / gauntlets — further out than body thigh armor
    if (y < 1.05 && r >= 0.235) return 'gauntlets';
    // Elbow / lower upper-arm just above hip crease (thighs#103/#111 arm half)
    if (y >= 1.0 && y < 1.18 && r >= 0.15 && ax >= 0.18) return 'arms';
    if (y < 1.05) return 'thighs';
    // Hip / oblique side flare — on the body wall, not free arm
    // (medial half of former arms#186/#189 welded plates: ax≈0.15, r≈0.15)
    if (y >= 1.0 && y < 1.35 && ax < 0.19 && r < 0.2) return 'hips';
    if (y < 1.2 && r < 0.14) return 'torso';
    if (y < 1.4 && r >= 0.14) return 'arms';
    if (y < 1.52 && r >= 0.14) return 'shoulders';
    // Upper collar / shoulder-pad lobes (not faceplate) — keep separate after
    // faceplate+pad spatial split so coarse re-merge cannot glue them back
    // onto the helmet face (former helmet#333 pads at y≈1.60, |x|≈0.09).
    if (
      y >= 1.55 &&
      y < 1.635 &&
      ax > 0.07 &&
      ax < 0.16 &&
      c.z > 0.04 &&
      c.z < 0.12
    ) {
      return 'torso';
    }
    // Neck / upper-chest collar welded into the same grid cell as the cranial
    // shell (helmet#220 islands at y≈1.58–1.63, low |z|). Must not re-merge
    // with crown (y≳1.66) under a shared helmet|in coarse key.
    if (
      y >= 1.55 &&
      y < 1.64 &&
      ax > 0.04 &&
      ax < 0.16 &&
      Math.abs(c.z) < 0.09
    ) {
      return 'torso';
    }
    // Centerline lower collar / trapezius bridge under the skull
    if (
      y >= 1.55 &&
      y < 1.62 &&
      ax <= 0.1 &&
      c.z > -0.09 &&
      c.z < 0.05
    ) {
      return 'torso';
    }
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
    // Oblique (medial body wall) vs upper-arm lateral dual — former arms#186/#189
    // (both halves same height/sign; modes |x|≈0.15 vs ≈0.24, dist≈0.10)
    {
      const axA = Math.abs(ca.x);
      const axB = Math.abs(cb.x);
      const yLo = Math.min(ca.y, cb.y);
      const yHi = Math.max(ca.y, cb.y);
      if (
        yLo > 0.95 &&
        yHi < 1.45 &&
        Math.abs(axA - axB) >= 0.05 &&
        Math.min(axA, axB) < 0.18 &&
        Math.max(axA, axB) > 0.2
      ) {
        return [groupA, groupB];
      }
    }
    if (dist >= 0.16) return [groupA, groupB];
    return null;
  };

  /**
   * Hard |x| cut for welded oblique wall + free arm on the same side.
   * 2-means fails when the arm mass dominates (modes both land lateral and
   * leave a medial tongue attached — residual of former arms#186/#189).
   * Span is measured on vertices (centroids alone can sit mid-tri and miss
   * a thin medial tongue).
   */
  const tryObliqueArmCut = (tris: number[]): number[][] | null => {
    if (tris.length < 24) return null;
    let minAx = Infinity;
    let maxAx = -Infinity;
    let minYy = Infinity;
    let maxYy = -Infinity;
    const v = new THREE.Vector3();
    for (const t of tris) {
      const tc = centroids[t];
      minYy = Math.min(minYy, tc.y);
      maxYy = Math.max(maxYy, tc.y);
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(world);
        const ax = Math.abs(v.x);
        minAx = Math.min(minAx, ax);
        maxAx = Math.max(maxAx, ax);
      }
    }
    // Waist → upper-arm band with clear medial body + lateral arm span
    if (minYy < 0.95 || maxYy > 1.45) return null;
    if (maxAx - minAx < 0.1) return null;
    if (minAx > 0.17 || maxAx < 0.22) return null;

    // Assign by each triangle’s most-medial vertex so a thin body-wall tongue
    // isn’t swallowed when the centroid sits out on the free arm.
    const cut = 0.19;
    const medial: number[] = [];
    const lateral: number[] = [];
    for (const t of tris) {
      let triMinAx = Infinity;
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(world);
        triMinAx = Math.min(triMinAx, Math.abs(v.x));
      }
      if (triMinAx < cut) medial.push(t);
      else lateral.push(t);
    }
    if (medial.length < 8 || lateral.length < 8) return null;
    return [medial, lateral];
  };

  /**
   * Cranial helmet welded to upper-chest / collar geometry (helmet#220).
   * Head shell rises to y≈1.83 while collar hangs to y≈1.56 — one fly-in
   * reads as a giant plate clipping the chest. Split on Y so the collar
   * seats with torso/shoulders and the skull with the helmet wave.
   */
  const tryHelmetChestCollarSplit = (
    tris: number[],
  ): number[][] | null => {
    if (tris.length < 80) return null;

    let minYy = Infinity;
    let maxYy = -Infinity;
    let frontish = 0;
    for (const t of tris) {
      const tc = centroids[t];
      minYy = Math.min(minYy, tc.y);
      maxYy = Math.max(maxYy, tc.y);
      if (tc.z > -0.05) frontish++;
    }
    // Must span collar band + true cranial height
    if (minYy > 1.58 || maxYy < 1.75) return null;
    if (maxYy - minYy < 0.2) return null;
    if (frontish < tris.length * 0.35) return null;

    const cutY = 1.62;
    const chest: number[] = [];
    const helmet: number[] = [];
    for (const t of tris) {
      if (centroids[t].y < cutY) chest.push(t);
      else helmet.push(t);
    }
    if (chest.length < 40 || helmet.length < 80) return null;

    // Chest mass should sit clearly lower than helmet mass
    const cChest = islandCentroid(chest);
    const cHelm = islandCentroid(helmet);
    if (cHelm.y - cChest.y < 0.04) return null;

    return [helmet, chest];
  };

  /**
   * Shoulder collar welded with floating face/helmet scraps (shoulders#254).
   * Main pad mass sits at y≈1.56–1.62; two high floaters at y≳1.65 are
   * face geometry and must assemble with the helmet, not the pauldrons.
   */
  const tryShoulderHelmetFloatSplit = (
    tris: number[],
  ): number[][] | null => {
    if (tris.length < 20) return null;

    let minYy = Infinity;
    let maxYy = -Infinity;
    let frontish = 0;
    for (const t of tris) {
      const tc = centroids[t];
      minYy = Math.min(minYy, tc.y);
      maxYy = Math.max(maxYy, tc.y);
      if (tc.z > 0.04) frontish++;
    }
    // Collar height + face-height span
    if (minYy > 1.56 || maxYy < 1.66) return null;
    if (frontish < tris.length * 0.4) return null;

    const shoulder: number[] = [];
    const helmet: number[] = [];
    for (const t of tris) {
      if (centroids[t].y >= 1.64) helmet.push(t);
      else shoulder.push(t);
    }
    // Helmet floaters can be tiny (1–2 tris each) — still split them off
    if (helmet.length < 1 || shoulder.length < 16) return null;
    // Both L and R floaters (or at least dual high scraps)
    let hasL = false;
    let hasR = false;
    for (const t of helmet) {
      if (centroids[t].x < -0.03) hasL = true;
      if (centroids[t].x > 0.03) hasR = true;
    }
    if (!hasL || !hasR) return null;
    return [shoulder, helmet];
  };

  /**
   * Faceplate welded to left+right upper-collar shoulder pads
   * (former helmet#333): tall front face (y→1.8) with lower lateral lobes
   * at y≈1.60, |x|≈0.09. Pads must fly with the chest, not the helmet.
   */
  const tryFaceplateCollarPadSplit = (tris: number[]): number[][] | null => {
    if (tris.length < 40) return null;

    let minYy = Infinity;
    let maxYy = -Infinity;
    let maxAx = 0;
    let frontish = 0;
    for (const t of tris) {
      const tc = centroids[t];
      minYy = Math.min(minYy, tc.y);
      maxYy = Math.max(maxYy, tc.y);
      maxAx = Math.max(maxAx, Math.abs(tc.x));
      if (tc.z > 0.04) frontish++;
    }
    // Tall front face + lower lateral span
    if (minYy > 1.52 || maxYy < 1.72) return null;
    if (maxAx < 0.09) return null;
    if (frontish < tris.length * 0.5) return null;

    const face: number[] = [];
    const pads: number[] = [];
    const v = new THREE.Vector3();
    for (const t of tris) {
      const tc = centroids[t];
      let triMaxAx = 0;
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(world);
        triMaxAx = Math.max(triMaxAx, Math.abs(v.x));
      }
      // Lateral lower lobes → upper chest / collar pads
      // y cut 1.63 (not 1.62) so left pad mass at y≈1.622 is not left on the face
      if (triMaxAx > 0.075 && tc.y < 1.63) pads.push(t);
      else face.push(t);
    }
    if (pads.length < 12 || face.length < 24) return null;

    // Require both L and R pad mass so we don't peel a single cheek
    let hasL = false;
    let hasR = false;
    for (const t of pads) {
      if (centroids[t].x < -0.05) hasL = true;
      if (centroids[t].x > 0.05) hasR = true;
    }
    if (!hasL || !hasR) return null;
    return [face, pads];
  };

  /**
   * When connectivity welds arm+thigh (or body+hand) across a thin bridge,
   * split by height and/or radial modes that map to different body parts.
   */
  const trySpatialBandSplit = (tris: number[]): number[][] | null => {
    // Hard cut first for welded oblique + arm (arms#186/#189). Must run
    // before radial 2-means, which can “succeed” with useless partitions
    // and leave a medial tongue attached to the free arm.
    const byCut = tryObliqueArmCut(tris);
    if (byCut) return byCut;
    // Cranial shell + upper-chest collar (helmet#220) — big Y span first
    const byHelmChest = tryHelmetChestCollarSplit(tris);
    if (byHelmChest) return byHelmChest;
    // Faceplate + dual collar pads (helmet#333) before generic |x| 2-means
    const byCollar = tryFaceplateCollarPadSplit(tris);
    if (byCollar) return byCollar;
    // Shoulder pads + floating face scraps (shoulders#254)
    const byFloat = tryShoulderHelmetFloatSplit(tris);
    if (byFloat) return byFloat;
    // Prefer radial: hanging hands sit at same height as outer thighs
    // (body r≲0.24 vs hand r≳0.26 — modes can be only ~0.05–0.08 apart)
    const byR = tryBimodalSplit(
      tris,
      (c) => Math.hypot(c.x, c.z),
      0.05,
      0.04,
    );
    if (byR) return byR;
    // Absolute laterality: welded oblique (medial) + upper-arm (lateral)
    // plates on the same side. Signed-X modes can sit only ~0.08 apart.
    const byAbsX = tryBimodalSplit(
      tris,
      (c) => Math.abs(c.x),
      0.08,
      0.06,
    );
    if (byAbsX) return byAbsX;
    // Lateral L/R dual plates sharing a mid-body grid cell
    const byX = tryBimodalSplit(tris, (c) => c.x, 0.1, 0.07);
    if (byX) return byX;
    return tryBimodalSplit(tris, (c) => c.y, 0.12, 0.08);
  };

  /** Recursively spatial-split until modes no longer bipartition. */
  const expandSpatial = (comp: number[]): number[][] => {
    const spatial = trySpatialBandSplit(comp);
    if (!spatial) return [comp];
    const out: number[][] = [];
    for (const part of spatial) {
      if (part.length === 0) continue;
      // Guard: only recurse when both children are meaningfully smaller
      if (part.length >= comp.length) {
        out.push(part);
        continue;
      }
      out.push(...expandSpatial(part));
    }
    return out.length > 0 ? out : [comp];
  };

  /**
   * Coarse key: body wave + inner/outer radial. Side (L/R) is applied only
   * when a coarse group actually contains substantial geometry on both sides
   * (fixes former thighs#103 / #111 dual plates without shredding panels).
   */
  const coarseKey = (c: THREE.Vector3): string => {
    const band = bandOf(c);
    const r = Math.hypot(c.x, c.z);
    // Three radial zones so medial oblique (r≈0.15) and near-body upper arm
    // (r≈0.23) do not re-merge after a spatial split (threshold was 0.26).
    const zone = r >= 0.26 ? 'out' : r >= 0.19 ? 'mid' : 'in';
    return `${band}|${zone}`;
  };
  const sideOf = (c: THREE.Vector3): 'L' | 'R' | 'M' =>
    c.x > 0.1 ? 'R' : c.x < -0.1 ? 'L' : 'M';

  for (const [key, tris] of buckets) {
    if (tris.length === 0) continue;

    const raw = splitTrisByConnectivity(tris, pos, world, weldEps);

    // Expand connectivity islands with spatial bi-modal split when a thin
    // bridge welded two body parts (arm/thigh, body/hand, oblique/arm).
    const expanded: number[][] = [];
    for (const comp of raw) {
      if (comp.length === 0) continue;
      expanded.push(...expandSpatial(comp));
    }

    let candidates =
      expanded.length > 0 ? expanded : expandSpatial(tris);
    if (candidates.length === 1) {
      candidates = expandSpatial(candidates[0]);
    }

    // 1) Group by band + radial zone
    type Group = { tris: number[]; c: THREE.Vector3 };
    const coarse = new Map<string, Group>();
    const scraps: number[][] = [];

    for (const part of candidates) {
      if (part.length === 0) continue;
      const c = islandCentroid(part);
      // Keep tiny high face floaters as real pieces (shoulders#254 scraps
      // are often 1–2 tris at y≳1.65 — scrap threshold would re-glue them).
      const isHelmetFloater =
        part.length >= 1 &&
        part.length <= 8 &&
        c.y >= 1.64 &&
        Math.abs(c.x) < 0.12 &&
        c.z > 0.04;
      if (part.length < 12 && !isHelmetFloater) {
        scraps.push(part);
        continue;
      }
      // Unique key so floaters never re-merge into a large co-bucketed helmet
      const ck = isHelmetFloater
        ? `helm-float-${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}`
        : coarseKey(c);
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
      const scrapBand = bandOf(sc);
      let bestKey: string | null = null;
      let bestD = Infinity;
      for (const [ck, g] of coarse) {
        // Don't glue an oblique/body tongue back onto a free-arm host (or
        // vice versa) just because scrap size is under the island threshold.
        // Never glue high face floaters onto shoulder/collar hosts.
        if (sc.y >= 1.64 && g.c.y < 1.64) continue;
        if (
          scrapBand !== bandOf(g.c) &&
          Math.abs(Math.abs(sc.x) - Math.abs(g.c.x)) > 0.04
        ) {
          continue;
        }
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
 * Hang-pose hands / gauntlets (absolute meters after model normalize).
 * Includes slightly inner palm/finger fragments that can sit r≈0.20–0.25
 * after a hand blob is subdivided (those were mis-tagged as thighs).
 */
export function isHandRegionCentroid(c: THREE.Vector3): boolean {
  const r = Math.hypot(c.x, c.z);
  const ax = Math.abs(c.x);
  // Classic hang: outer, hip-height
  if (c.y > 0.55 && c.y < 1.08 && r >= 0.235) return true;
  // Sub-shard / palm fragment: strongly lateral at hang height
  if (c.y > 0.72 && c.y < 1.05 && ax >= 0.22 && r >= 0.19) return true;
  return false;
}

/**
 * Further subdivide large hand-region shards so gauntlets assemble as
 * a few plates instead of one plop. Keep density modest (≈ half prior).
 */
export function refineHandShards(
  shards: MeshShard[],
  denserGrid: { x: number; y: number; z: number } = { x: 2, y: 2, z: 2 },
): MeshShard[] {
  const out: MeshShard[] = [];
  for (const s of shards) {
    if (!isHandRegionCentroid(s.centroid)) {
      out.push(s);
      continue;
    }
    const pos = s.mesh.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute | null;
    const triCount = pos ? pos.count / 3 : 0;
    // Only re-split truly chunky hand blobs (higher bar = fewer parts)
    if (triCount < 72) {
      s.mesh.userData.handRegion = true;
      out.push(s);
      continue;
    }

    s.mesh.updateWorldMatrix(true, false);
    const sub = splitMeshIntoShards(s.mesh, denserGrid);
    if (sub.length <= 1) {
      s.mesh.userData.handRegion = true;
      out.push(s);
      continue;
    }

    s.mesh.geometry.dispose();
    for (const piece of sub) {
      // Mark so classifyWave cannot re-tag palm fragments as thighs
      piece.mesh.userData.handRegion = true;
      out.push(piece);
    }
  }
  return out;
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
