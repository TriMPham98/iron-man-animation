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
        m.metalness = Math.max(m.metalness ?? 0, 0.72);
        m.roughness = Math.min(m.roughness ?? 0.5, 0.38);
        m.envMapIntensity = 1.5;
        m.needsUpdate = true;
      }
      // Boost emissive bits (eyes / reactor painted bright in texture)
      if ('emissive' in m && m.map) {
        // leave map-driven look; slight emissive for glow zones via bloom on bright albedo
      }
    }
  });
}

/**
 * Normalize model orientation/scale so it stands ~1.85m on y=0, facing camera.
 */
function normalizeModel(root: THREE.Object3D): void {
  // Merge transforms
  root.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());

  // If model is lying on its side (height not on Y), rotate into Y-up
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

  // Bake world transforms into a working group
  const wrapper = new THREE.Group();
  wrapper.add(model);
  wrapper.updateMatrixWorld(true);

  const sourceMeshes: THREE.Mesh[] = [];
  wrapper.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      sourceMeshes.push(obj as THREE.Mesh);
    }
  });

  // Split into spatial shards for assembly
  const allShards: MeshShard[] = [];
  for (const mesh of sourceMeshes) {
    // denser grid on larger meshes
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

  // Hide original continuous meshes (we animate shards instead)
  for (const mesh of sourceMeshes) {
    mesh.visible = false;
  }

  onProgress?.(1);
  draco.dispose();

  return { group, pieces, sourceMeshes };
}
