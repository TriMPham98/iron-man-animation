import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { scatterRotation, scatterStart } from '../utils/easeHelpers';
import {
  sortShardsInsideOut,
  splitMeshIntoShards,
  type MeshShard,
} from './splitMesh';
import type { ArmorPiece, PieceWave } from './createPieces';

const MODEL_URL = '/models/ironman.glb';

/**
 * Map a shard to a body region for Mark III–style waves.
 * Uses height (y) + radial distance from spine so hands classify as gauntlets
 * (after arms) and feet as boots (early, with the legs).
 */
function classifyWave(
  c: THREE.Vector3,
  minY: number,
  yRange: number,
  maxRadial: number,
): PieceWave {
  const yNorm = (c.y - minY) / yRange;
  const radial = Math.hypot(c.x, c.z);
  const rNorm = radial / Math.max(maxRadial, 1e-4);

  // Head
  if (yNorm > 0.88) return 'helmet';

  // Feet — lowest band
  if (yNorm < 0.1) return 'boots';

  // Hands / gauntlets — mid-low, far from spine (after arms)
  if (yNorm >= 0.22 && yNorm < 0.52 && rNorm > 0.55) return 'gauntlets';

  // Arms — mid height, lateral (shoulders already placed)
  if (yNorm >= 0.45 && yNorm < 0.82 && rNorm > 0.42) return 'arms';

  // Shoulders — high, moderately lateral
  if (yNorm >= 0.72 && yNorm < 0.9 && rNorm > 0.28) return 'shoulders';

  // Lower legs
  if (yNorm >= 0.1 && yNorm < 0.28) return 'calves';

  // Upper legs
  if (yNorm >= 0.28 && yNorm < 0.48) return 'thighs';

  // Hips / waist
  if (yNorm >= 0.45 && yNorm < 0.58 && rNorm < 0.45) return 'hips';

  // Chest / back / abs core
  if (yNorm >= 0.5 && yNorm < 0.88) return 'torso';

  // Fallbacks by height
  if (yNorm < 0.35) return 'thighs';
  if (rNorm > 0.5) return 'arms';
  return 'torso';
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

export interface GlowMaterial {
  material: THREE.MeshStandardMaterial;
  /** Full-power emissive intensity once systems come online. */
  baseIntensity: number;
}

/**
 * The albedo paints reactor / eyes / repulsors as bright cyan even when
 * emissive is off — so they look "powered" during fly-in. Darken those texels
 * (using the emissive map as a mask) so systems read as cold metal until
 * power-up lights them via emissive only.
 */
function darkenAlbedoGlowRegions(material: THREE.MeshStandardMaterial): void {
  const map = material.map;
  const emap = material.emissiveMap;
  if (!map?.image || !emap?.image) return;

  const baseImg = map.image as CanvasImageSource & { width?: number; height?: number };
  const emImg = emap.image as CanvasImageSource & { width?: number; height?: number };
  const w = Number(baseImg.width) || 0;
  const h = Number(baseImg.height) || 0;
  if (w < 2 || h < 2) return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(baseImg, 0, 0, w, h);
    const baseData = ctx.getImageData(0, 0, w, h);

    const eCanvas = document.createElement('canvas');
    eCanvas.width = w;
    eCanvas.height = h;
    const ectx = eCanvas.getContext('2d', { willReadFrequently: true });
    if (!ectx) return;
    ectx.drawImage(emImg, 0, 0, w, h);
    const emData = ectx.getImageData(0, 0, w, h);

    // Cold unpowered glass / socket (near-black, slight cool metal)
    const darkR = 10;
    const darkG = 12;
    const darkB = 16;

    for (let i = 0; i < baseData.data.length; i += 4) {
      const elum =
        Math.max(emData.data[i], emData.data[i + 1], emData.data[i + 2]) / 255;
      if (elum < 0.06) continue;
      // Full darken on bright emissive texels so reactor never reads "on"
      const t = Math.min(1, elum * 1.55);
      baseData.data[i] = Math.round(baseData.data[i] * (1 - t) + darkR * t);
      baseData.data[i + 1] = Math.round(
        baseData.data[i + 1] * (1 - t) + darkG * t,
      );
      baseData.data[i + 2] = Math.round(
        baseData.data[i + 2] * (1 - t) + darkB * t,
      );
    }

    ctx.putImageData(baseData, 0, 0);
    map.image = canvas;
    map.needsUpdate = true;
  } catch {
    // CORS / tainted canvas — leave albedo as-is
  }
}

/**
 * Capture glow materials, darken painted-on systems in the albedo, and start
 * emissive at 0 so nothing ignites until armor lock + power-up.
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

      // Moderate full-power glow (bloom stays subtle)
      const authored = hasStrength ? m.emissiveIntensity : 0;
      const base = THREE.MathUtils.clamp(
        Math.max(authored, hasMap ? 2.0 : 1.4),
        1.2,
        2.4,
      );

      // Kill baked "already on" look in the color map
      darkenAlbedoGlowRegions(m);

      // Emissive map still drives shape; intensity stays 0 until setPowered
      if (hasMap && m.emissive.getHex() === 0) {
        m.emissive.setRGB(1, 1, 1);
      }
      m.emissiveIntensity = 0;
      m.needsUpdate = true;

      glow.push({ material: m, baseIntensity: base });
    }
  });

  return glow;
}

/** Assembly shards must never carry glow — strip emissive completely. */
function stripShardEmissive(mat: THREE.MeshStandardMaterial): void {
  mat.emissiveMap = null;
  mat.emissive.setRGB(0, 0, 0);
  mat.emissiveIntensity = 0;
  mat.needsUpdate = true;
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
): Promise<LoadedSuitModel> {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  loader.setDRACOLoader(draco);

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

  // Split into spatial shards for fly-in only (clones of materials, no emissive)
  const allShards: MeshShard[] = [];
  for (const mesh of sourceMeshes) {
    const shards = splitMeshIntoShards(mesh, { x: 3, y: 7, z: 3 });
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
  const sorted = sortShardsInsideOut(tagged.map((t) => t.shard));
  const waveByShard = new Map(
    tagged.map((t) => [t.shard, t.wave] as const),
  );

  const pieces: ArmorPiece[] = sorted.map((shard, i) => {
    const wave = waveByShard.get(shard) ?? 'torso';
    const id = `shard-${i}-${wave}`;

    // Clone material so shards never share glow state with the final mesh
    const srcMat = Array.isArray(shard.mesh.material)
      ? shard.mesh.material[0]
      : shard.mesh.material;
    if (srcMat) {
      const cloned = (srcMat as THREE.Material).clone() as THREE.MeshStandardMaterial;
      if ('emissive' in cloned) {
        stripShardEmissive(cloned);
      }
      shard.mesh.material = cloned;
    }

    const restPosition = shard.restPosition.clone();
    const restRotation = shard.restRotation.clone();
    const restScale = shard.restScale.clone();
    const startPosition = scatterStart(restPosition, id, 3.5, 8.5);
    const startRotation = scatterRotation(id);
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
