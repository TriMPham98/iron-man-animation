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
      if ('emissiveIntensity' in cloned) {
        cloned.emissiveIntensity = 0;
        cloned.emissive = new THREE.Color(0x000000);
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

  return { group, finalModel, pieces, sourceMeshes };
}
