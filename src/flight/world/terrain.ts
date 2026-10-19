import * as THREE from 'three';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { HEIGHT_RES, TEXEL, WORLD_SIZE } from './config';
import { TERRAIN_SAMPLE_GLSL, type Heightfield } from './heightfield';

/**
 * Continuous-distance LOD terrain (CDLOD, Strugar 2010). A quadtree over the
 * world picks patches each frame by distance to the eye: 4 m between
 * vertices underfoot, coarsening by octaves out to the horizon. Every patch
 * is the same small grid drawn instanced in one call; near the outer edge of
 * its range each patch morphs its odd vertices onto the next coarser grid,
 * so LOD bands meet without cracks or popping.
 */

/** Cells per full patch side. */
const CELLS = 32;
/** Leaf (finest) node size in metres. */
const LEAF = 128;
const LEVELS = Math.round(Math.log2(WORLD_SIZE / LEAF)) + 1;
/** LOD 0 reaches this far (m); each coarser level doubles it. */
const RANGE0 = 320;
const MAX_PATCHES = 3072;

interface Node {
  x: number;
  z: number;
  size: number;
  level: number;
  minY: number;
  maxY: number;
  children: Node[] | null;
}

function patchGeometry(cells: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const n = cells + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Grid indices (the shader scales them by the patch spacing)
      pos.set([i, 0, j], (j * n + i) * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Alternate the diagonal so slopes don't comb in one direction
      if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // Lighting reads the per-pixel terrain normal; this only keeps three happy
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PATCHES * 4), 4);
  inst.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPatch', inst);
  geo.instanceCount = 0;
  return geo;
}

const VERT_PARS = /* glsl */ `
attribute vec4 aPatch; // x0, z0, spacing (m per cell), lod
uniform vec3 uEye;
uniform float uRange0;
varying vec3 vTerrainPos;
varying float vMorph;
varying vec3 vMacro;
${TERRAIN_SAMPLE_GLSL}
// The broad cover tones (scales of 430 m and up) per vertex rather than per
// pixel, prefiltered to the patch's vertex pitch: three texture reads off
// every terrain pixel
float macroTone(vec2 xz, float scale, float spacing) {
  float lod = max(0.0, log2(spacing * 256.0 / scale));
  return textureLod(uDetail, xz / scale, lod).r * 0.5 + 0.5;
}
`;

const VERT_BODY = /* glsl */ `
  vec2 grid = position.xz;
  float spacing = aPatch.z;
  vec2 world = aPatch.xy + grid * spacing;
  float h0 = terrainHeight(world);
  float range = uRange0 * exp2(aPatch.w);
  float dist = distance(vec3(world.x, h0, world.y), uEye);
  float morph = clamp((dist - range * 0.72) / (range * 0.26), 0.0, 1.0);
  // Odd vertices slide onto their even neighbour: the coarser grid
  vec2 odd = fract(grid * 0.5) * 2.0;
  world -= odd * morph * spacing;
  vMorph = morph;
  // Most vertices don't morph: skip the second height lookup for them
  float h = morph > 0.0 ? terrainHeight(world) : h0;
  vTerrainPos = vec3(world.x, h, world.y);
  vMacro = vec3(macroTone(world, 2900.0, spacing), macroTone(world + 517.0, 1130.0, spacing), macroTone(world - 211.0, 430.0, spacing));
  vec3 transformed = vTerrainPos;
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vTerrainPos;
varying float vMorph;
varying vec3 vMacro;
uniform float uTexel;
uniform float uTime;
${TERRAIN_SAMPLE_GLSL}
${ATMOSPHERE_GLSL}
float tSunVis;
float tAo;
float tWet;
// Detail texture as a 0–1 tone at a scale (m)
float tone(vec2 xz, float scale) { return texture2D(uDetail, xz / scale).r * 0.5 + 0.5; }
`;

const ALBEDO = /* glsl */ `
  vec2 xz = vTerrainPos.xz;
  float hgt = vTerrainPos.y;
  float slopeDetail;
  vec3 wN = terrainNormal(xz, hgt, slopeDetail);
  float viewD = length(vTerrainPos - cameraPosition);
  // Close-up detail (grain, micro relief, triplanar cliffs) fades out with
  // distance and is skipped outright beyond it: far pixels stay cheap
  float near = 1.0 - smoothstep(150.0, 900.0, viewD);
  float micro = 1.0 - smoothstep(30.0, 260.0, viewD);
  vec4 bake = texture2D(uBake, xz / uWorld + 0.5);
  tSunVis = bake.r;
  tAo = mix(0.55, 1.0, bake.g);

  float slope = 1.0 - wN.y;
  float m1 = vMacro.x;
  float m2 = vMacro.y;
  float m3 = vMacro.z;
  float mid = tone(xz, 160.0);
  float fine = 0.6;
  float grain = 0.6;
  if (near > 0.0) {
    fine = mix(0.6, tone(xz, 23.0), near);
    grain = mix(0.6, tone(xz, 6.1), near);
  }
  // Rock faces: the detail projected side-on as well (triplanar), so cliffs
  // carry grain and strata instead of streaks smeared down the slope
  float steep = smoothstep(0.3, 0.6, slope);
  vec3 tw = vec3(0.0, 1.0, 0.0);
  if (near > 0.0 && steep > 0.0) {
    tw = pow(abs(wN), vec3(4.0));
    tw /= tw.x + tw.y + tw.z;
    float gx = tone(vTerrainPos.zy, 6.1);
    float gz = tone(vTerrainPos.xy, 6.1);
    grain = mix(grain, mix(0.6, tw.x * gx + tw.z * gz + tw.y * grain, near), steep);
  }

  // Cover: golden grass on the open slopes, olive chaparral in broad
  // patches, grey-green sage on the dry sun-facing (seaward) slopes, dark
  // oak woodland down the folds where the hills shelter it
  float scrubK = smoothstep(0.5, 0.66, m2 * 0.5 + m3 * 0.35 + mid * 0.15 + slope * 0.35);
  float oakK = smoothstep(0.82, 0.52, bake.g) * smoothstep(0.38, 0.16, slope) * (0.45 + 0.55 * m3);
  float dry = smoothstep(0.05, 0.6, wN.z * 3.0 + (mid - 0.5)) * (1.0 - oakK);
  vec3 grass = mix(vec3(0.4, 0.29, 0.13), vec3(0.56, 0.43, 0.21), m1 * 0.45 + m3 * 0.55) * (0.92 + 0.16 * fine);
  // Burnt-out patches and paler dry grass break the gold up
  grass = mix(grass, vec3(0.6, 0.5, 0.33), smoothstep(0.55, 0.75, mid + (fine - 0.5) * 0.4) * 0.5);
  grass = mix(grass, grass * vec3(0.78, 0.74, 0.66), smoothstep(0.62, 0.8, m2 + (grain - 0.5) * 0.3) * 0.6);
  vec3 scrub = mix(vec3(0.085, 0.095, 0.05), vec3(0.17, 0.155, 0.085), m1) * (0.82 + 0.36 * fine);
  vec3 sage = mix(vec3(0.17, 0.18, 0.13), vec3(0.24, 0.24, 0.18), m3) * (0.85 + 0.3 * fine);
  scrub = mix(scrub, sage, dry * 0.7);
  vec3 oak = vec3(0.05, 0.07, 0.035) * (0.8 + 0.4 * fine);
  vec3 veg = mix(grass, scrub, scrubK);
  veg = mix(veg, oak, oakK * 0.85);
  // Brush stipple close up: the cover is clumps, not paint
  veg *= mix(1.0, 0.75 + 0.5 * grain, near * (0.4 + 0.6 * scrubK));

  // Rock: grey-brown with strata in the cliffs, lighter sandstone on the coast
  float strata = 0.5 + 0.5 * sin(hgt * 0.42 + mid * 9.0 + m1 * 14.0);
  vec3 rock = mix(vec3(0.17, 0.15, 0.13), vec3(0.33, 0.28, 0.23), strata * 0.65 + grain * 0.35);
  rock = mix(rock, vec3(0.44, 0.36, 0.27), smoothstep(110.0, 20.0, hgt) * 0.75);
  // Dark streaks of seepage and lichen down the faces
  if (steep > 0.0) rock *= 1.0 - 0.25 * smoothstep(0.55, 0.8, tone(vec2(xz.x * 3.0 + xz.y, hgt * 0.15), 90.0)) * steep;
  // Higher up the range the cover thins to rock and dust
  veg = mix(veg, mix(rock, grass, 0.45), smoothstep(700.0, 1250.0, hgt + mid * 160.0));

  float rockK = smoothstep(0.32, 0.56, slope + (grain - 0.5) * 0.16 + slopeDetail * 0.12);
  vec3 col = mix(veg, rock, rockK);

  // Beach: pale sand, darker and glossy where the swash wets it
  vec3 sand = mix(vec3(0.52, 0.43, 0.31), vec3(0.62, 0.53, 0.39), grain);
  float beach = smoothstep(4.5 + mid * 3.0, 1.5, hgt) * (1.0 - smoothstep(0.25, 0.45, slope));
  col = mix(col, sand, beach);
  float swash = 0.35 + 0.25 * sin(uTime * 0.7 + xz.x * 0.03 + xz.y * 0.05);
  tWet = smoothstep(swash + 0.9, swash, hgt);
  col = mix(col, sand * 0.48, tWet);
  // Sea floor: sand and weed, dimmed (the water shades it from above)
  col = mix(col, mix(vec3(0.32, 0.28, 0.2), vec3(0.08, 0.1, 0.06), mid), smoothstep(0.0, -3.0, hgt));

  // Micro relief (normal detail, not geometry) near the eye: rough rock,
  // lumpy brush, smoother sand. Triplanar on the faces
  if (micro > 0.0) {
    float amp = mix(mix(0.5, 0.22, beach), 1.1, rockK) * micro;
    vec2 gA = texture2D(uDetailGrad, xz / (uDetailSpan * 0.032)).rg / 0.032;
    vec2 gB = texture2D(uDetailGrad, xz / (uDetailSpan * 0.011) + 0.37).rg / 0.011;
    vec2 gT = (gA * 0.05 + gB * 0.012) * amp;
    vec3 p = vec3(gT.x, 0.0, gT.y) * tw.y;
    if (steep > 0.0) {
      vec2 sx = texture2D(uDetailGrad, vTerrainPos.zy / (uDetailSpan * 0.032)).rg / 0.032 * 0.05 * amp;
      vec2 sz = texture2D(uDetailGrad, vTerrainPos.xy / (uDetailSpan * 0.032)).rg / 0.032 * 0.05 * amp;
      p += vec3(0.0, sx.y, sx.x) * tw.x + vec3(sz.x, sz.y, 0.0) * tw.z;
    }
    wN = normalize(wN - p);
  }

  diffuseColor.rgb = col;
`;

export class Terrain {
  readonly mesh: THREE.Mesh;
  private readonly full: THREE.InstancedBufferGeometry;
  private readonly half: THREE.InstancedBufferGeometry;
  private readonly root: Node;
  private readonly ranges: number[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly _m = new THREE.Matrix4();
  private readonly _box = new THREE.Box3();
  private readonly halfMesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly group = new THREE.Group();
  private fullCount = 0;
  private halfCount = 0;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(
    private readonly field: Heightfield,
    atmosphere: Record<string, THREE.IUniform>,
    /** The raw heightfield texels (node bounds). */
    private readonly texels: Float32Array,
  ) {
    for (let l = 0; l < LEVELS; l++) this.ranges.push(RANGE0 * 2 ** l);
    this.root = this.buildTree();
    this.full = patchGeometry(CELLS);
    this.half = patchGeometry(CELLS / 2);
    this.uniforms = {
      ...field.uniforms,
      ...atmosphere,
      uEye: { value: new THREE.Vector3() },
      uRange0: { value: RANGE0 },
      uTexel: { value: TEXEL },
      uTime: { value: 0 },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    mat.envMapIntensity = 0.85;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', ALBEDO)
        .replace(
          '#include <roughnessmap_fragment>',
          'float roughnessFactor = mix(roughness, 0.32, tWet);',
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `
          vec3 normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
          float faceDirection = 1.0;`,
        )
        .replace(
          '#include <aomap_fragment>',
          /* glsl */ `
          // Baked low-sun shadow on the direct light, horizon AO on the sky light
          reflectedLight.directDiffuse *= tSunVis;
          reflectedLight.directSpecular *= tSunVis;
          reflectedLight.indirectDiffuse *= tAo;
          reflectedLight.indirectSpecular *= tAo;`,
        )
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vTerrainPos);');
    };
    // Program cache key: one terrain program
    mat.customProgramCacheKey = () => 'cdlod-terrain';
    this.material = mat;
    this.mesh = new THREE.Mesh(this.full, mat);
    this.halfMesh = new THREE.Mesh(this.half, mat);
    for (const m of [this.mesh, this.halfMesh]) {
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }
    this.group.name = 'terrain';
  }

  /** Quadtree with per-node height bounds from the heightfield. */
  private buildTree(): Node {
    const make = (x: number, z: number, size: number, level: number): Node => {
      const node: Node = { x, z, size, level, minY: 0, maxY: 0, children: null };
      if (level > 0) {
        const h = size / 2;
        node.children = [
          make(x, z, h, level - 1),
          make(x + h, z, h, level - 1),
          make(x, z + h, h, level - 1),
          make(x + h, z + h, h, level - 1),
        ];
        node.minY = Math.min(...node.children.map((c) => c.minY));
        node.maxY = Math.max(...node.children.map((c) => c.maxY));
      } else {
        // Bounds of the texels under the leaf (plus a texel either side for the spline)
        let lo = Infinity;
        let hi = -Infinity;
        const n = HEIGHT_RES;
        const i0 = Math.max(0, Math.floor((x / WORLD_SIZE + 0.5) * n) - 1);
        const j0 = Math.max(0, Math.floor((z / WORLD_SIZE + 0.5) * n) - 1);
        const span = Math.ceil(size / TEXEL) + 2;
        for (let j = j0; j < Math.min(n, j0 + span); j++) {
          for (let i = i0; i < Math.min(n, i0 + span); i++) {
            const y = this.texels[j * n + i];
            if (y < lo) lo = y;
            if (y > hi) hi = y;
          }
        }
        // Margin for the close-up crags the base relief doesn't carry
        node.minY = lo - 8;
        node.maxY = hi + 8;
      }
      return node;
    };
    return make(-WORLD_SIZE / 2, -WORLD_SIZE / 2, WORLD_SIZE, LEVELS - 1);
  }

  private boxDist2(n: Node, eye: THREE.Vector3): number {
    const dx = Math.max(n.x - eye.x, 0, eye.x - (n.x + n.size));
    const dz = Math.max(n.z - eye.z, 0, eye.z - (n.z + n.size));
    const dy = Math.max(n.minY - eye.y, 0, eye.y - n.maxY);
    return dx * dx + dy * dy + dz * dz;
  }

  private inFrustum(n: Node): boolean {
    this._box.min.set(n.x, n.minY, n.z);
    this._box.max.set(n.x + n.size, n.maxY, n.z + n.size);
    return this.frustum.intersectsBox(this._box);
  }

  private add(n: Node, lod: number, halfRes: boolean, ox = n.x, oz = n.z): void {
    const geo = halfRes ? this.half : this.full;
    const count = halfRes ? this.halfCount : this.fullCount;
    if (count >= MAX_PATCHES) return;
    const attr = geo.getAttribute('aPatch') as THREE.InstancedBufferAttribute;
    // Spacing: the level's own vertex pitch
    const spacing = (LEAF * 2 ** lod) / CELLS;
    attr.setXYZW(count, ox, oz, spacing, lod);
    if (halfRes) this.halfCount++;
    else this.fullCount++;
  }

  private select(n: Node, eye: THREE.Vector3): boolean {
    const lod = n.level;
    if (this.boxDist2(n, eye) > this.ranges[lod] ** 2) return false;
    if (!this.inFrustum(n)) return true;
    if (lod === 0 || this.boxDist2(n, eye) > this.ranges[lod - 1] ** 2) {
      this.add(n, lod, false);
      return true;
    }
    for (const c of n.children!) {
      // A child out of the finer range is drawn at this node's LOD: a
      // half-resolution patch over the child's quarter
      if (!this.select(c, eye)) {
        if (this.inFrustum(c)) this.add(c, lod, true);
      }
    }
    return true;
  }

  update(camera: THREE.Camera, time: number): void {
    const eye = camera.position;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    this.fullCount = 0;
    this.halfCount = 0;
    this.select(this.root, eye);
    this.full.instanceCount = this.fullCount;
    this.half.instanceCount = this.halfCount;
    for (const g of [this.full, this.half]) (g.getAttribute('aPatch') as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.mesh.visible = this.fullCount > 0;
    this.halfMesh.visible = this.halfCount > 0;
    (this.uniforms.uEye.value as THREE.Vector3).copy(eye);
    this.uniforms.uTime.value = time;
    void this.field;
  }

  get patchCount(): number {
    return this.fullCount + this.halfCount;
  }
}
