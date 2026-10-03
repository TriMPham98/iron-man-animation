import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { armorPieceDef, cutArmor, type PieceBuffers } from './armorPieces';
import { boneIndex, computeSkinWeights, skinWeightsAt } from './rig';
import { createRig, type SuitRig } from './rigPose';
import { createHologramMaterial } from './suitEffects';
import {
  attachSystemsShader,
  cloneGlowMaterial,
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
 * World-space lift applied to {@link Suit.group} after load — keeps feet
 * above the scan ring / pad without shifting plate rest poses (absolute Y
 * thresholds in classify/merge stay stable).
 */
export const SUIT_GROUND_CLEARANCE = 0.05;

/**
 * Normalize model orientation/scale so it stands ~1.85m on y=0, facing camera.
 * Do **not** bake pad clearance here — that rewrites rest Y and changes
 * assembly classification / faceplate merges.
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
  /** Model-space root (feet at local y=0); parent of everything below. */
  group: THREE.Group;
  /** Seamless finished suit — shown after assembly completes. */
  finalModel: THREE.Group;
  /** Single skinned mesh inside {@link finalModel}. */
  finalMesh: THREE.SkinnedMesh;
  /** JARVIS fitting ghost sharing the body geometry + skeleton. */
  hologram: THREE.SkinnedMesh;
  rig: SuitRig;
  /** Movie suit-up components (skinned, detached bind). */
  pieces: ArmorPiece[];
  /** Final-mesh materials with authored emissive (reactor / eyes / repulsors) */
  glowMaterials: GlowMaterial[];
}

/**
 * Bake every source mesh into one model-space geometry (position, normal,
 * uv, index). All primitives on this GLB share one material.
 */
function mergeBody(root: THREE.Object3D): {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
} {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  if (meshes.length === 0) throw new Error('Suit GLB has no meshes');

  let vertCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    const n = m.geometry.getAttribute('position').count;
    vertCount += n;
    indexCount += m.geometry.index ? m.geometry.index.count : n;
  }

  const pos = new Float32Array(vertCount * 3);
  const nrm = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  const index = new Uint32Array(indexCount);
  const v = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    const g = m.geometry;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const nAttr = g.getAttribute('normal') as THREE.BufferAttribute;
    const uAttr = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    normalMatrix.getNormalMatrix(m.matrixWorld);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      pos.set([v.x, v.y, v.z], (vo + i) * 3);
      v.fromBufferAttribute(nAttr, i).applyMatrix3(normalMatrix).normalize();
      nrm.set([v.x, v.y, v.z], (vo + i) * 3);
      if (uAttr) uv.set([uAttr.getX(i), uAttr.getY(i)], (vo + i) * 2);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[io++] = g.index.getX(i) + vo;
    } else {
      for (let i = 0; i < p.count; i++) index[io++] = i + vo;
    }
    vo += p.count;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  const mat = meshes[0].material;
  return { geometry, material: Array.isArray(mat) ? mat[0] : mat };
}

/** Bind every vertex of a part to one bone. */
function rigidTo(buf: PieceBuffers, bone: number): void {
  for (let i = 0; i < buf.skinWeight.length; i += 4) {
    buf.skinIndex[i] = bone;
    buf.skinIndex[i + 1] = buf.skinIndex[i + 2] = buf.skinIndex[i + 3] = 0;
    buf.skinWeight[i] = 1;
    buf.skinWeight[i + 1] = buf.skinWeight[i + 2] = buf.skinWeight[i + 3] = 0;
  }
}

function pieceGeometry(buf: PieceBuffers): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(buf.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(buf.uvs, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(buf.skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(buf.skinWeight, 4));
  geo.setIndex(new THREE.BufferAttribute(buf.indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function skinnedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  // Detached bind: the mesh's own matrix composes on top of skinning, which
  // is how pieces travel in before docking (see Suit.syncPieces).
  mesh.bindMode = THREE.DetachedBindMode;
  mesh.frustumCulled = false;
  return mesh;
}

export async function loadSuitModel(
  onProgress?: (ratio: number) => void,
): Promise<LoadedSuitModel> {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);
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

  // Pack reactor / eyes / repulsors on the source hierarchy (world-space
  // classification), then bake everything into one model-space body.
  const glowMaterials = prepareGlowMaterials(model);
  const { geometry: body, material } = mergeBody(model);

  // ── Rig: auto-skin to the procedural skeleton ───────────────────────
  const positions = body.getAttribute('position').array as Float32Array;
  const indices = body.index!.array as Uint32Array;
  const skin = computeSkinWeights(positions, indices);

  // ── Cut the movie suit-up components (clean planar seams) ───────────
  const cut = cutArmor({
    positions,
    normals: body.getAttribute('normal').array as Float32Array,
    uvs: body.getAttribute('uv').array as Float32Array,
    indices,
    island: skin.island,
    islandLimb: skin.islandLimb,
    skinIndex: skin.skinIndex,
    skinWeight: skin.skinWeight,
    headBone: boneIndex('head'),
    weightsAt: (x, y, z, island, outIndex, outWeight) => {
      const rigid = skin.islandBone[island];
      if (rigid >= 0) {
        outIndex[0] = rigid;
        outWeight[0] = 1;
        return;
      }
      skinWeightsAt(x, y, z, skin.islandLimb[island], outIndex, outWeight);
    },
  });
  body.dispose();

  const rig = createRig();
  group.add(rig.root);

  // Every part gets its own material (shared maps + program) so the reset
  // dissolve can run per part; all of them take the systems glow.
  const baseGlow = glowMaterials.find((g) => g.material === material);
  const ownMaterial = (): THREE.Material => {
    if (!baseGlow) return material;
    const m = cloneGlowMaterial(baseGlow.material);
    glowMaterials.push({ material: m, baseIntensity: baseGlow.baseIntensity });
    return m;
  };

  const pieces: ArmorPiece[] = [];
  const pieceGeos: THREE.BufferGeometry[] = [];
  for (const buf of cut) {
    const def = armorPieceDef(buf.id);
    // Helmet + faceplate are rigid shells on the head: skin them 100% to it
    // so a head turn never shears the chin away from the mask
    if (def.id === 'helmet' || def.id === 'faceplate') rigidTo(buf, boneIndex('head'));
    const geo = pieceGeometry(buf);
    pieceGeos.push(geo);
    const mesh = skinnedMesh(geo, ownMaterial(), `piece-${def.id}`);
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    group.add(mesh);
    const restPosition = new THREE.Vector3();
    geo.boundingBox!.getCenter(restPosition);
    pieces.push({
      id: def.id,
      label: def.label,
      mesh,
      wave: def.wave,
      anchor: def.anchor,
      restPosition,
      def,
    });
  }

  // Seamless suit = the same cut pieces merged, so swapping is invisible
  const finalGeo = mergeGeometries(pieceGeos, false);
  if (!finalGeo) throw new Error('Failed to merge suit pieces');
  finalGeo.computeBoundingBox();
  finalGeo.computeBoundingSphere();

  const finalModel = new THREE.Group();
  finalModel.name = 'finalSuit';
  const finalMesh = skinnedMesh(finalGeo, ownMaterial(), 'suit-final');
  finalModel.add(finalMesh);
  finalModel.visible = false;
  group.add(finalModel);

  const hologram = skinnedMesh(finalGeo, createHologramMaterial(), 'suit-hologram');
  hologram.renderOrder = 3;
  hologram.visible = false;
  group.add(hologram);

  onProgress?.(1);
  draco.dispose();

  return {
    group,
    finalModel,
    finalMesh,
    hologram,
    rig,
    pieces,
    glowMaterials,
  };
}
