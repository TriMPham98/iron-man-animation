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
import {
  attachSystemsShader,
  darkenAlbedoGlowRegions,
  packSystemsEmissiveMap,
  type GlowMaterial,
} from './systemsGlow';

const MODEL_URL = '/models/ironman.glb';

export type { GlowMaterial } from './systemsGlow';

/**
 * Map a shard to a body region for Mark III–style waves.
 *
 * Calibrated on this GLB’s envelope (after normalize):
 *   - outer thigh / hip armor: rNorm ≤ ~0.54
 *   - true outer limbs (forearm/hand): rNorm ≥ ~0.70
 *
 * Hands are classified as **arms** (not a separate early wave and never
 * thighs). The arm wave grows proximal→distal so fingers clamp only after
 * the arm stump exists. Outer-thigh armor stays in leg waves.
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

  // Beyond body armor envelope — forearm + hand (was wrongly thigh at 0.77)
  const OUTER_LIMB_RNORM = 0.7;
  // Moderate lateral above the hips — upper arm / elbow
  const ARM_RNORM = 0.38;

  // Head
  if (yNorm > 0.88) return 'helmet';

  // Feet
  if (yNorm < 0.1) return 'boots';

  // Lower legs
  if (yNorm < 0.28) return 'calves';

  // ── Outer limb chain first (hands must never join thigh wave) ────
  // Hands hang at hip/thigh height but far outside the body; body thigh
  // plates top out ~0.54 rNorm on this mesh.
  if (rNorm >= OUTER_LIMB_RNORM) {
    if (yNorm < 0.78) return 'arms'; // forearm + hand (distal end of arm wave)
    return 'shoulders';
  }

  // Thighs — body armor only (inner of OUTER_LIMB_RNORM)
  if (yNorm < 0.52) {
    if (yNorm >= 0.48 && rNorm <= 0.16) return 'hips';
    return 'thighs';
  }

  // Hip / lower abdomen: core hips vs outer thigh guards vs lower arm
  if (yNorm < 0.62) {
    if (rNorm >= 0.58) return 'arms';
    if (rNorm <= 0.16) return 'hips';
    return 'thighs';
  }

  // Soft core strip before arms dominate
  if (yNorm < 0.66 && rNorm < ARM_RNORM) return 'torso';

  // Upper arms
  if (yNorm >= 0.62 && yNorm < 0.82 && rNorm > ARM_RNORM) return 'arms';

  // Shoulders
  if (yNorm >= 0.72 && yNorm < 0.9 && rNorm > 0.28) return 'shoulders';

  // Chest / back / abs
  if (yNorm >= 0.55 && yNorm < 0.88) return 'torso';

  // Fallbacks
  if (yNorm < 0.62) return 'thighs';
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

      // Cold sockets until each system ignites
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

  // Split into spatial shards for fly-in — share prepared materials so
  // sequenced system glow (reactor / eyes) lights the correct UV islands
  // as soon as each body region locks (not only after showFinal).
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

    // Keep shared systems material (packed emissive + shader uniforms)
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
