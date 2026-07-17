import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import {
  shardGridForTier,
  type QualityTier,
} from '../scene/quality';
import { scatterRotation, scatterStart } from '../utils/easeHelpers';
import {
  sortShardsInsideOut,
  splitMeshIntoShards,
  type MeshShard,
} from './splitMesh';
import type { ArmorPiece } from './waves';
import { classifyWave } from './classifyWave';
import {
  attachSystemsShader,
  darkenAlbedoGlowRegions,
  packSystemsEmissiveMap,
  type GlowMaterial,
} from './systemsGlow';

const MODEL_URL = '/models/ironman.glb';
/** Local Draco wasm/js decoders vendored under public/draco/ (no CDN). */
const DRACO_DECODER_PATH = '/draco/';

export type { GlowMaterial } from './systemsGlow';

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
  // Must sit on the sternum band (not thighs, not pauldrons)
  if (yNorm < 0.55 || yNorm > 0.8) return false;
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
  const allShards: MeshShard[] = [];
  for (const mesh of sourceMeshes) {
    const shards = splitMeshIntoShards(mesh, shardGrid);
    allShards.push(...shards);
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

  // Classify by body region, then order inside-out within each band
  const tagged = allShards.map((shard) => ({
    shard,
    wave: classifyWave(shard.centroid, minY, yRange, maxRadial),
  }));

  // Force any shard that carries the arc-reactor UV island into the torso
  // wave. Coarse spatial buckets can park the sternum plate on a low
  // centroid (thighs/hips), so it flies in glowing long before the chest
  // is built — the bug in the user's 28% screenshot.
  for (const entry of tagged) {
    if (entry.wave === 'torso' || entry.wave === 'helmet') continue;
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

  onProgress?.(1);
  draco.dispose();

  return { group, finalModel, pieces, sourceMeshes, glowMaterials };
}
