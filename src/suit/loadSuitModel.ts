import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  shardGridForTier,
  type QualityTier,
} from '../scene/quality';
import { scatterRotation, scatterStart } from '../utils/easeHelpers';
import { classifyWave } from './classifyWave';
import {
  isHandRegionCentroid,
  refineHandShards,
  sortShardsInsideOut,
  splitMeshIntoShards,
  type MeshShard,
} from './splitMesh';
import {
  attachSystemsShader,
  darkenAlbedoGlowRegions,
  packSystemsEmissiveMap,
  type GlowMaterial,
} from './systemsGlow';
import type { ArmorPiece } from './waves';

const MODEL_URL = '/models/ironman.glb';
/** Local Draco wasm/js decoders vendored under public/draco/ (no CDN). */
const DRACO_DECODER_PATH = '/draco/';

export type { GlowMaterial } from './systemsGlow';

/**
 * Upper front faceplate dual shell (high-tier helmet#363 + #400).
 *
 * Two stacked front-center plates at y≈1.72–1.77, z≈0.09. Co-locate
 * pairing often claims the lower one with mid-face helmet#333 first,
 * leaving #400 as a thin floating fragment on its own beat. Merging
 * them into one plate reads as a single clean mask surface.
 *
 * Match by rest pose (not shard index) so quality tiers stay stable.
 */
export function isUpperFaceplateShellRest(rest: THREE.Vector3): boolean {
  return (
    Math.abs(rest.x) < 0.04 &&
    rest.z > 0.07 &&
    rest.y > 1.7 &&
    rest.y < 1.8
  );
}

/**
 * Merge secondary armor pieces into `keep` (geometry + rest centroid).
 * Removes absorbed meshes from `group` and returns the kept piece.
 */
function absorbPiecesInto(
  keep: ArmorPiece,
  absorb: ArmorPiece[],
  group: THREE.Group,
): void {
  if (absorb.length === 0) return;

  const keepMesh = keep.mesh as THREE.Mesh;
  const geos: THREE.BufferGeometry[] = [];

  // Primary verts already live in keep-rest local space
  geos.push(keepMesh.geometry.clone());

  for (const other of absorb) {
    const otherMesh = other.mesh as THREE.Mesh;
    const geo = otherMesh.geometry.clone();
    // Shift other-rest local → keep-rest local
    const ox = other.restPosition.x - keep.restPosition.x;
    const oy = other.restPosition.y - keep.restPosition.y;
    const oz = other.restPosition.z - keep.restPosition.z;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) + ox,
        pos.getY(i) + oy,
        pos.getZ(i) + oz,
      );
    }
    pos.needsUpdate = true;
    geos.push(geo);
  }

  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return;

  // Re-center so mesh.position can stay at the combined socket
  merged.computeBoundingBox();
  const box = merged.boundingBox;
  if (box) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    if (center.lengthSq() > 1e-12) {
      const pos = merged.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(
          i,
          pos.getX(i) - center.x,
          pos.getY(i) - center.y,
          pos.getZ(i) - center.z,
        );
      }
      pos.needsUpdate = true;
      keep.restPosition.add(center);
    }
  }
  merged.computeBoundingSphere();

  keepMesh.geometry.dispose();
  keepMesh.geometry = merged;

  for (const other of absorb) {
    group.remove(other.mesh);
    const om = other.mesh as THREE.Mesh;
    om.geometry?.dispose();
  }

  // Fresh scatter from the combined rest so the mask flies as one plate
  keep.startPosition.copy(
    scatterStart(keep.restPosition, keep.id, 3.5, 8.5, keep.wave),
  );
  keep.startRotation.copy(
    scatterRotation(keep.id, { rest: keep.restPosition, wave: keep.wave }),
  );
  keepMesh.position.copy(keep.startPosition);
  keepMesh.rotation.copy(keep.startRotation);
  keepMesh.scale.copy(keep.startScale);
}

/**
 * Fuse stacked upper faceplate shells (helmet#363 + #400 on high tier)
 * into a single assembly piece.
 */
export function mergeUpperFaceplateShells(
  pieces: ArmorPiece[],
  group: THREE.Group,
): ArmorPiece[] {
  const shells = pieces.filter(
    (p) => p.wave === 'helmet' && isUpperFaceplateShellRest(p.restPosition),
  );
  if (shells.length < 2) return pieces;

  // Keep the shell with the most verts (usually the main mask surface)
  let keep = shells[0];
  let keepVerts = 0;
  for (const p of shells) {
    const mesh = p.mesh as THREE.Mesh;
    const n = mesh.geometry?.getAttribute('position')?.count ?? 0;
    if (n >= keepVerts) {
      keepVerts = n;
      keep = p;
    }
  }
  const absorb = shells.filter((p) => p !== keep);
  absorbPiecesInto(keep, absorb, group);

  const drop = new Set(absorb.map((p) => p.id));
  return pieces.filter((p) => !drop.has(p.id));
}

/**
 * Max |world X| of shard vertices. Geometry positions are local to the
 * centroid; world X = local X + centroid.x.
 */
function shardMaxAbsX(shard: MeshShard): number {
  const pos = shard.mesh.geometry.getAttribute(
    'position',
  ) as THREE.BufferAttribute | null;
  if (!pos || pos.count < 1) return Math.abs(shard.centroid.x);
  let max = 0;
  const cx = shard.centroid.x;
  for (let i = 0; i < pos.count; i++) {
    max = Math.max(max, Math.abs(pos.getX(i) + cx));
  }
  return max;
}

/**
 * True if this shard owns the arc-reactor disk: tight front-sternum centroid
 * plus UV hits on the packed reactor (R) channel. Kept strict so thighs /
 * abs plates are not swallowed into the torso wave.
 */
function shardCarriesReactor(
  shard: MeshShard,
  minY: number,
  yRange: number,
): boolean {
  const mesh = shard.mesh;
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | null;
  if (!pos || pos.count < 3) return false;

  const c = shard.centroid;
  const yNorm = (c.y - minY) / yRange;
  const radial = Math.hypot(c.x, c.z);
  // Must sit on the sternum band (not thighs, not pauldrons).
  // Upper bound 0.85 covers tall reactor housing (former helmet#270 at yNorm≈0.82).
  if (yNorm < 0.55 || yNorm > 0.85) return false;
  if (radial > 0.28) return false;
  if (c.z < 0.0) return false;

  // UV path: packed emissive R = reactor (dilated to cover gold bezel)
  const mat = (
    Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  ) as THREE.MeshStandardMaterial | undefined;
  const emap = mat?.emissiveMap;
  if (!uv || !emap?.image) {
    // No atlas to sample — still treat a very central front shard as reactor
    return radial < 0.16 && c.z > 0.08;
  }

  let w = 0;
  let h = 0;
  let pixels: Uint8ClampedArray | Uint8Array | null = null;
  try {
    if (emap.image instanceof HTMLCanvasElement) {
      const ctx = emap.image.getContext('2d');
      if (ctx) {
        w = emap.image.width;
        h = emap.image.height;
        pixels = ctx.getImageData(0, 0, w, h).data;
      }
    }
  } catch {
    pixels = null;
  }
  if (!pixels || w < 2 || h < 2) {
    return radial < 0.16 && c.z > 0.08;
  }

  let hot = 0;
  let checked = 0;
  const step = Math.max(1, Math.floor(uv.count / 64));
  for (let i = 0; i < uv.count; i += step) {
    const u = THREE.MathUtils.clamp(uv.getX(i), 0, 1);
    const v = THREE.MathUtils.clamp(uv.getY(i), 0, 1);
    const px = Math.round(u * (w - 1));
    const py = Math.round(v * (h - 1));
    const si = (py * w + px) * 4;
    // Packed map R = reactor
    if ((pixels[si] ?? 0) > 50) hot++;
    checked++;
  }
  return checked > 0 && hot / checked > 0.12;
}

/**
 * Keep the GLB's original colors / maps / metalness / roughness.
 * Only nudge env reflection strength so the current lighting can show shine.
 */
function enhanceMaterials(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const m = mat as THREE.MeshStandardMaterial;
      if (!('metalness' in m)) continue;

      // Preserve authored color & texture; do not recolor or rebuild materials
      // Slight env boost so studio lights / env map read as gloss on metal
      if (typeof m.envMapIntensity === 'number') {
        m.envMapIntensity = Math.max(m.envMapIntensity, 1.35);
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * Capture glow materials, darken baked-on systems in the albedo, pack the
 * emissive atlas into R/G/B (reactor / eyes / repulsors), and attach the
 * sequenced systems shader. All systems start at power 0.
 */
function prepareGlowMaterials(root: THREE.Object3D): GlowMaterial[] {
  const seen = new Set<THREE.Material>();
  const glow: GlowMaterial[] = [];

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      const m = mat as THREE.MeshStandardMaterial;
      if (!('emissive' in m)) continue;

      const hasMap = !!m.emissiveMap;
      const hasStrength =
        typeof m.emissiveIntensity === 'number' && m.emissiveIntensity > 0;
      if (!hasMap && !hasStrength) continue;

      const authored = hasStrength ? m.emissiveIntensity : 0;
      const base = THREE.MathUtils.clamp(
        Math.max(authored, hasMap ? 2.0 : 1.4),
        1.2,
        2.4,
      );

      // Cold sockets until each system ignites (emissive islands only —
      // do not crush general albedo / ambient response)
      darkenAlbedoGlowRegions(m);
      packSystemsEmissiveMap(root, m);
      attachSystemsShader(m);

      glow.push({ material: m, baseIntensity: base });
    }
  });

  return glow;
}

/**
 * Normalize model orientation/scale so it stands ~1.85m on y=0, facing camera.
 */
function normalizeModel(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());

  if (size.z > size.y * 1.25 && size.z > size.x) {
    root.rotation.x = -Math.PI / 2;
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  } else if (size.x > size.y * 1.25 && size.x > size.z) {
    root.rotation.z = Math.PI / 2;
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }

  const targetHeight = 1.85;
  const s = targetHeight / Math.max(size.y, 1e-4);
  root.scale.multiplyScalar(s);
  root.updateMatrixWorld(true);

  box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
}

export interface LoadedSuitModel {
  group: THREE.Group;
  /** Seamless full suit — shown after assembly completes */
  finalModel: THREE.Group;
  pieces: ArmorPiece[];
  sourceMeshes: THREE.Mesh[];
  /** Final-mesh materials with authored emissive (reactor / eyes / repulsors) */
  glowMaterials: GlowMaterial[];
}

export async function loadSuitModel(
  onProgress?: (ratio: number) => void,
  quality: QualityTier = 'high',
): Promise<LoadedSuitModel> {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);
  loader.setDRACOLoader(draco);

  const shardGrid = shardGridForTier(quality);

  const gltf = await new Promise<Awaited<ReturnType<typeof loader.loadAsync>>>(
    (resolve, reject) => {
      loader.load(
        MODEL_URL,
        resolve,
        (e) => {
          if (e.total) onProgress?.(e.loaded / e.total);
        },
        reject,
      );
    },
  );

  const group = new THREE.Group();
  group.name = 'suitModel';

  const model = gltf.scene;
  enhanceMaterials(model);
  normalizeModel(model);

  // Seamless finished suit (hidden until assembly ends)
  const finalModel = new THREE.Group();
  finalModel.name = 'finalSuit';
  finalModel.add(model);
  finalModel.visible = false;
  group.add(finalModel);

  finalModel.updateMatrixWorld(true);

  // Zero emissive until power-up (map already paints reactor / eyes / repulsors)
  const glowMaterials = prepareGlowMaterials(model);

  const sourceMeshes: THREE.Mesh[] = [];
  model.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      sourceMeshes.push(obj as THREE.Mesh);
    }
  });

  // Split into spatial shards for fly-in — share prepared materials so
  // sequenced system glow (reactor / eyes) lights the correct UV islands
  // as soon as each body region locks (not only after showFinal).
  let allShards: MeshShard[] = [];
  for (const mesh of sourceMeshes) {
    const shards = splitMeshIntoShards(mesh, shardGrid);
    allShards.push(...shards);
  }
  // Hands start as one blob — light subdivide (≈ half prior density)
  // low tier: skip refine; medium/high: coarse 2×2×2 only
  if (quality !== 'low') {
    allShards = refineHandShards(allShards, { x: 2, y: 2, z: 2 });
  }

  let minY = Infinity;
  let maxY = -Infinity;
  let maxRadial = 0;
  for (const s of allShards) {
    minY = Math.min(minY, s.centroid.y);
    maxY = Math.max(maxY, s.centroid.y);
    maxRadial = Math.max(maxRadial, Math.hypot(s.centroid.x, s.centroid.z));
  }
  const yRange = Math.max(1e-4, maxY - minY);

  // Classify by body region, then order inside-out within each band.
  // Pass max |world X| so thin hip side-flares (centroid only slightly
  // lateral) are not mistaken for free arms that extend outward.
  const tagged = allShards.map((shard) => {
    const maxAbsX = shardMaxAbsX(shard);
    return {
      shard,
      wave: classifyWave(
        {
          x: shard.centroid.x,
          y: shard.centroid.y,
          z: shard.centroid.z,
          maxAbsX,
        },
        minY,
        yRange,
        maxRadial,
      ),
    };
  });

  // Force hand-region / refined-hand shards into gauntlets (centroid can sit
  // inside the thigh radial band after a hand blob is subdivided).
  for (const entry of tagged) {
    if (entry.shard.mesh.userData.handRegion) {
      entry.wave = 'gauntlets';
      continue;
    }
    if (isHandRegionCentroid(entry.shard.centroid)) {
      entry.wave = 'gauntlets';
    }
  }

  // Force any shard that carries the arc-reactor UV island into the torso
  // wave. Coarse spatial buckets can park the sternum plate on a low
  // centroid (thighs/hips) or a high one (helmet — former helmet#270), so
  // it flies in glowing long before the chest is built.
  for (const entry of tagged) {
    if (entry.wave === 'torso') continue;
    if (shardCarriesReactor(entry.shard, minY, yRange)) {
      entry.wave = 'torso';
    }
  }

  const sorted = sortShardsInsideOut(tagged.map((t) => t.shard));
  const waveByShard = new Map(
    tagged.map((t) => [t.shard, t.wave] as const),
  );

  const pieces: ArmorPiece[] = sorted.map((shard, i) => {
    const wave = waveByShard.get(shard) ?? 'torso';
    const id = `shard-${i}-${wave}`;

    // Keep shared systems material (packed emissive + shader uniforms)
    const restPosition = shard.restPosition.clone();
    const restRotation = shard.restRotation.clone();
    const restScale = shard.restScale.clone();
    const startPosition = scatterStart(restPosition, id, 3.5, 8.5, wave);
    const startRotation = scatterRotation(id, { rest: restPosition, wave });
    const startScale = new THREE.Vector3(0.08, 0.08, 0.08);

    shard.mesh.position.copy(startPosition);
    shard.mesh.rotation.copy(startRotation);
    shard.mesh.scale.copy(startScale);
    shard.mesh.visible = false;
    group.add(shard.mesh);

    return {
      id,
      mesh: shard.mesh,
      wave,
      restPosition,
      restRotation,
      restScale,
      startPosition,
      startRotation,
      startScale,
    };
  });

  // Upper faceplate dual shell (high-tier helmet#363 + #400) → one plate
  const mergedPieces = mergeUpperFaceplateShells(pieces, group);

  onProgress?.(1);
  draco.dispose();

  return {
    group,
    finalModel,
    pieces: mergedPieces,
    sourceMeshes,
    glowMaterials,
  };
}
