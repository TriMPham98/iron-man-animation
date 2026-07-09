import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { scatterRotation, scatterStart } from '../utils/easeHelpers';
import {
  sortShardsBottomUp,
  splitMeshIntoShards,
  type MeshShard,
} from './splitMesh';
import type { ArmorPiece, PieceWave } from './createPieces';

const MODEL_URL = '/models/ironman.glb';

const WAVE_BY_HEIGHT: PieceWave[] = [
  'boots',
  'calves',
  'thighs',
  'hips',
  'torso',
  'shoulders',
  'arms',
  'gauntlets',
  'helmet',
  'power',
];

function assignWave(yNorm: number): PieceWave {
  const idx = Math.min(
    WAVE_BY_HEIGHT.length - 1,
    Math.floor(yNorm * WAVE_BY_HEIGHT.length),
  );
  return WAVE_BY_HEIGHT[idx];
}

function enhanceMaterials(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const m = mat as THREE.MeshStandardMaterial;
      if ('metalness' in m) {
        // Dark armor textures + high metalness crush to black. Prefer readable
        // painted metal: some metal, more diffuse, brighter albedo multiply.
        m.metalness = 0.42;
        m.roughness = 0.45;
        m.envMapIntensity = 2.4;
        // HDR-style color boost (values > 1 are valid and brighten the map)
        if (m.color) {
          m.color.setRGB(1.55, 1.55, 1.55);
        }
        if ('emissiveIntensity' in m) {
          m.emissiveIntensity = 0;
          m.emissive = new THREE.Color(0x000000);
        }
        m.needsUpdate = true;
      }
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

  const sorted = sortShardsBottomUp(allShards);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of sorted) {
    minY = Math.min(minY, s.centroid.y);
    maxY = Math.max(maxY, s.centroid.y);
  }
  const yRange = Math.max(1e-4, maxY - minY);

  const pieces: ArmorPiece[] = sorted.map((shard, i) => {
    const yNorm = (shard.centroid.y - minY) / yRange;
    const wave = assignWave(yNorm);
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
