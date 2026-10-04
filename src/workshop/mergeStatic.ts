import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NOISE_FUNCS, noiseTexture, type Weathering } from './robotMaterials';

/**
 * Static mesh merging for the robot cell.
 *
 * Plain PBR finishes (no textures, opaque, front-sided) are baked into
 * vertex attributes — colour, metalness / roughness / clearcoat / glow and
 * the weathering layer — so every such child of a node collapses into ONE
 * draw with a shared "uber" material. Anything else (textured decals,
 * screens, transparent or two-sided surfaces) still merges per material.
 * Children flagged `userData.dynamic` (moving jaws, spindles, rams) are
 * left alone.
 */

let uber: THREE.MeshPhysicalMaterial | null = null;

/** Shared material that reads its finish from vertex attributes. */
export function uberMaterial(): THREE.MeshPhysicalMaterial {
  if (uber) return uber;
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    metalness: 1,
    roughness: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.3,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise3D = { value: noiseTexture() };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 aPBR;\nattribute vec4 aWear;\nvarying vec4 vPBR;\nvarying vec4 vWear;\nvarying vec3 vObjPos;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPBR = aPBR;\nvWear = aWear;\nvObjPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vPBR;\nvarying vec4 vWear;\nvarying vec3 vObjPos;\n${NOISE_FUNCS}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        // vWear: grime, scratch, chip, noise scale (0 scale = no wear)
        float rGrime = 0.0;
        float rChip = 0.0;
        if (vWear.w > 0.0) {
          vec3 rp = vObjPos * vWear.w;
          rGrime = rFbm(rp);
          if (vWear.z > 0.0) {
            vec3 cp = rp * 6.3 + 7.0;
            rChip = smoothstep(0.76, 0.79, 0.64 * rNoise(cp) + 0.36 * rNoise(cp * 2.1)) * vWear.z;
          }
          diffuseColor.rgb *= mix(1.0, 0.7 + 0.3 * rGrime, vWear.x);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.28, 0.29, 0.31), rChip);
        }
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        float rScr = 0.0;
        if (vWear.y > 0.0) rScr = smoothstep(0.72, 0.98, rNoise(vObjPos * vec3(260.0, 9.0, 260.0))) * vWear.y;
        roughnessFactor = clamp(vPBR.y + rGrime * 0.3 * vWear.x - rScr * 0.12, 0.06, 1.0);
        `,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = mix(vPBR.x, 1.0, rChip);',
      )
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = vPBR.z;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vPBR.w;',
      );
  };
  m.customProgramCacheKey = () => 'robot-uber';
  uber = m;
  return m;
}

/** Can this material's look be baked into vertex attributes? */
function bakeable(mat: THREE.Material): mat is THREE.MeshStandardMaterial {
  const m = mat as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || m.transparent || m.side !== THREE.FrontSide || m.vertexColors) return false;
  if (m.map || m.emissiveMap || m.normalMap || m.roughnessMap || m.metalnessMap || m.alphaMap) return false;
  // Only our own weathering hook is allowed (its params live in userData)
  if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile && !m.userData.wear) return false;
  return true;
}

/** Geometry with the finish of `mat` baked in as attributes. */
function bake(geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const pbr = new Float32Array(n * 4);
  const wear = new Float32Array(n * 4);
  const glow = mat.emissive.r + mat.emissive.g + mat.emissive.b > 0 ? mat.emissiveIntensity : 0;
  // Emissive finishes carry their glow colour in the vertex colour
  const c = glow > 0 ? mat.emissive : mat.color;
  const cc = (mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial ? (mat as THREE.MeshPhysicalMaterial).clearcoat : 0;
  const w = (mat.userData.wear as Weathering | undefined) ?? { grime: 0, scratch: 0, chip: 0, scale: 0 };
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3);
    pbr.set([mat.metalness, mat.roughness, cc, glow], i * 4);
    wear.set([w.grime, w.scratch, w.chip, w.scale], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aPBR', new THREE.BufferAttribute(pbr, 4));
  geo.setAttribute('aWear', new THREE.BufferAttribute(wear, 4));
  return geo;
}

function prepared(m: THREE.Mesh, keep: string[]): THREE.BufferGeometry {
  m.updateMatrix();
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
  for (const name of Object.keys(g.attributes)) {
    if (!keep.includes(name)) g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g.applyMatrix4(m.matrix);
}

export function mergeStaticChildren(parent: THREE.Object3D): void {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  const baked: THREE.Mesh[] = [];
  for (const child of parent.children) {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.dynamic || Array.isArray(mesh.material)) continue;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) continue;
    if (mesh.children.length > 0) continue;
    if (mesh.renderOrder !== 0) continue;
    if (bakeable(mesh.material)) {
      baked.push(mesh);
      continue;
    }
    const list = byMat.get(mesh.material) ?? [];
    list.push(mesh);
    byMat.set(mesh.material, list);
  }

  // One draw for every plain-finish child
  if (baked.length >= 2) {
    const geos = baked.map((m) => bake(prepared(m, ['position', 'normal']), m.material as THREE.MeshStandardMaterial));
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (merged) {
      for (const m of baked) {
        parent.remove(m);
        m.geometry.dispose();
      }
      const out = new THREE.Mesh(merged, uberMaterial());
      out.name = `${parent.name || 'node'}-uber`;
      parent.add(out);
    }
  }

  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => prepared(m, ['position', 'normal', 'uv']));
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    for (const m of meshes) {
      parent.remove(m);
      m.geometry.dispose();
    }
    const out = new THREE.Mesh(merged, mat);
    out.name = `${parent.name || 'node'}-merged`;
    parent.add(out);
  }
}

/** {@link mergeStaticChildren} applied to every node of a subtree. */
export function mergeStaticTree(root: THREE.Object3D): void {
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) nodes.push(o);
  });
  for (const n of nodes) mergeStaticChildren(n);
}
