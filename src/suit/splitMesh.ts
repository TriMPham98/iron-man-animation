import * as THREE from 'three';

export interface MeshShard {
  mesh: THREE.Mesh;
  restPosition: THREE.Vector3;
  restRotation: THREE.Euler;
  restScale: THREE.Vector3;
  centroid: THREE.Vector3;
}

/**
 * Split a mesh into spatial shards for a "suit assembly" fly-in effect.
 * Buckets triangles by a 3D grid over the mesh bounds.
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

  // Inverse world so shard geometry sits in local space at origin-ish rest pose
  const invWorld = new THREE.Matrix4().copy(world).invert();
  const shards: MeshShard[] = [];

  for (const [key, tris] of buckets) {
    if (tris.length === 0) continue;

    const vertCount = tris.length * 3;
    const positions = new Float32Array(vertCount * 3);
    const normals = normal ? new Float32Array(vertCount * 3) : null;
    const uvs = uv ? new Float32Array(vertCount * 2) : null;
    const colors = color ? new Float32Array(vertCount * (color.itemSize || 3)) : null;

    const localCentroid = new THREE.Vector3();
    let vi = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const src = t * 3 + k;
        a.fromBufferAttribute(pos, src).applyMatrix4(world);
        localCentroid.add(a);
        // store world temporarily
        positions[vi * 3] = a.x;
        positions[vi * 3 + 1] = a.y;
        positions[vi * 3 + 2] = a.z;

        if (normals && normal) {
          a.fromBufferAttribute(normal, src);
          // transform normal by world (approx, ignore non-uniform scale)
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
          for (let c = 0; c < color.itemSize; c++) {
            colors[vi * color.itemSize + c] = color.getComponent(src, c);
          }
        }
        vi++;
      }
    }
    localCentroid.multiplyScalar(1 / vertCount);

    // Center geometry on centroid so mesh.position = centroid is rest pose
    for (let i = 0; i < vertCount; i++) {
      positions[i * 3] -= localCentroid.x;
      positions[i * 3 + 1] -= localCentroid.y;
      positions[i * 3 + 2] -= localCentroid.z;
    }

    // Also convert to a local frame consistent with suit root (already world-ish)
    // Geometry is in world space relative to centroid; parent under suit root at origin.
    void invWorld;

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

    const mat = Array.isArray(source.material)
      ? source.material[0]
      : source.material;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `${source.name || 'shard'}_${key}`;
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
