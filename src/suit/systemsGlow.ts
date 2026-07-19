import * as THREE from 'three';

/** Independent suit systems that can ignite on different beats. */
export type SuitSystem = 'reactor' | 'eyes' | 'repulsors';

export interface SystemPowers {
  reactor: number;
  eyes: number;
  repulsors: number;
}

export interface GlowMaterial {
  material: THREE.MeshStandardMaterial;
  /** Peak emissive scale once a system is fully online. */
  baseIntensity: number;
}

const POWER_EMISSIVE_BOOST = 1.05;

/**
 * Classify a world-space surface point into a suit system so the single
 * emissive atlas can be packed as R=reactor, G=eyes, B=repulsors.
 *
 * Hang-pose palms sit at r ≈ 0.28–0.40 (not >0.42). An older radial-only
 * palm gate let those verts fall into the chest-reactor fallback, so
 * gauntlet#246 (and its L/R twin) glowed when the arc reactor ignited —
 * long before the hands clamped on.
 */
export function classifySystemPoint(
  p: THREE.Vector3,
  minY: number,
  yRange: number,
): SuitSystem {
  const yNorm = (p.y - minY) / yRange;
  const radial = Math.hypot(p.x, p.z);
  const ax = Math.abs(p.x);

  // Helmet / faceplate
  if (yNorm > 0.84) return 'eyes';

  // Boot thrusters
  if (yNorm < 0.12) return 'repulsors';

  // Hands / gauntlets / lower arms — lateral hang pose (both palms).
  // Prefer |x| so front-chest protrusion cannot steal these verts.
  if (yNorm >= 0.35 && yNorm < 0.72 && ax >= 0.2) return 'repulsors';
  // Outer palm / finger tips (high absolute radial at hang height)
  if (yNorm >= 0.22 && yNorm < 0.62 && radial >= 0.26) return 'repulsors';

  // Arc reactor — medial chest core only
  if (yNorm >= 0.52 && yNorm < 0.84 && ax < 0.16 && radial < 0.32) {
    return 'reactor';
  }

  // Upper torso fallback → reactor only when clearly on the core
  if (yNorm >= 0.5 && ax < 0.14 && radial < 0.28) return 'reactor';
  return 'repulsors';
}

function channelIndex(sys: SuitSystem): number {
  if (sys === 'reactor') return 0;
  if (sys === 'eyes') return 1;
  return 2;
}

function readTextureImageData(
  tex: THREE.Texture,
): { data: ImageData; w: number; h: number } | null {
  const img = tex.image as { width?: number; height?: number } | null;
  if (!img) return null;
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (w < 2 || h < 2) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h), w, h };
  } catch {
    return null;
  }
}

/**
 * Darken albedo where the emissive map is bright so sockets read cold/off
 * until systems power up via emissive only.
 */
export function darkenAlbedoGlowRegions(
  material: THREE.MeshStandardMaterial,
): void {
  const map = material.map;
  const emap = material.emissiveMap;
  if (!map?.image || !emap?.image) return;

  const base = readTextureImageData(map);
  const em = readTextureImageData(emap);
  if (!base || !em) return;

  const { data: baseData, w, h } = base;
  const emData = em.data;
  const darkR = 10;
  const darkG = 12;
  const darkB = 16;

  for (let i = 0; i < baseData.data.length; i += 4) {
    const elum =
      Math.max(emData.data[i], emData.data[i + 1], emData.data[i + 2]) / 255;
    if (elum < 0.06) continue;
    const t = Math.min(1, elum * 1.55);
    baseData.data[i] = Math.round(baseData.data[i] * (1 - t) + darkR * t);
    baseData.data[i + 1] = Math.round(
      baseData.data[i + 1] * (1 - t) + darkG * t,
    );
    baseData.data[i + 2] = Math.round(
      baseData.data[i + 2] * (1 - t) + darkB * t,
    );
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(baseData, 0, 0);
    map.image = canvas;
    map.needsUpdate = true;
  } catch {
    // leave albedo
  }
}

/**
 * Pack authored emissive into R/G/B by body region so each system can
 * ignite independently (reactor ≠ eyes ≠ repulsors).
 */
export function packSystemsEmissiveMap(
  root: THREE.Object3D,
  material: THREE.MeshStandardMaterial,
): void {
  const emap = material.emissiveMap;
  if (!emap?.image) return;

  const src = readTextureImageData(emap);
  if (!src) return;
  const { data: srcData, w, h } = src;

  const packed = new ImageData(w, h);
  // glTF UVs + three flipY=false: origin top-left, same as canvas ImageData
  const uvToPixel = (u: number, v: number) => ({
    px: Math.round(THREE.MathUtils.clamp(u, 0, 1) * (w - 1)),
    py: Math.round(THREE.MathUtils.clamp(v, 0, 1) * (h - 1)),
  });

  const stamp = (
    u: number,
    v: number,
    lum: number,
    sys: SuitSystem,
    radius = 1,
  ) => {
    if (lum < 0.04) return;
    const { px, py } = uvToPixel(u, v);
    const ch = channelIndex(sys);
    const strength = Math.min(255, Math.round(lum * 255));
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        packed.data[i + ch] = Math.max(packed.data[i + ch], strength);
        packed.data[i + 3] = 255;
      }
    }
  };

  root.updateMatrixWorld(true);
  let minY = Infinity;
  let maxY = -Infinity;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
  });
  const yRange = Math.max(1e-4, maxY - minY);
  const tmp = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | null;
    if (!pos || !uv) return;

    const index = mesh.geometry.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const getIdx = (t: number, k: number) =>
      index ? index.getX(t * 3 + k) : t * 3 + k;

    for (let t = 0; t < triCount; t++) {
      const i0 = getIdx(t, 0);
      const i1 = getIdx(t, 1);
      const i2 = getIdx(t, 2);
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      tmp.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      const sys = classifySystemPoint(tmp, minY, yRange);

      for (const vi of [i0, i1, i2]) {
        const u = uv.getX(vi);
        const v = uv.getY(vi);
        const { px, py } = uvToPixel(u, v);
        const si = (py * w + px) * 4;
        const lum =
          Math.max(srcData.data[si], srcData.data[si + 1], srcData.data[si + 2]) /
          255;
        stamp(u, v, lum, sys, 2);
      }

      // Midpoints for denser coverage on small glow islands
      const uvs = [
        [(uv.getX(i0) + uv.getX(i1)) * 0.5, (uv.getY(i0) + uv.getY(i1)) * 0.5],
        [(uv.getX(i1) + uv.getX(i2)) * 0.5, (uv.getY(i1) + uv.getY(i2)) * 0.5],
        [(uv.getX(i2) + uv.getX(i0)) * 0.5, (uv.getY(i2) + uv.getY(i0)) * 0.5],
        [
          (uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3,
          (uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3,
        ],
      ] as const;
      for (const [u, v] of uvs) {
        const { px, py } = uvToPixel(u, v);
        const si = (py * w + px) * 4;
        const lum =
          Math.max(srcData.data[si], srcData.data[si + 1], srcData.data[si + 2]) /
          255;
        stamp(u, v, lum, sys, 1);
      }
    }
  });

  // Fill any leftover bright source texels using nearest packed neighbor
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const srcLum = Math.max(
        srcData.data[i],
        srcData.data[i + 1],
        srcData.data[i + 2],
      );
      if (srcLum < 20) continue;
      if (packed.data[i] + packed.data[i + 1] + packed.data[i + 2] > 0) continue;

      let best = -1;
      let bestD = Infinity;
      for (let r = 1; r <= 6 && best < 0; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = (ny * w + nx) * 4;
            for (let ch = 0; ch < 3; ch++) {
              if (packed.data[ni + ch] > 0) {
                const d = dx * dx + dy * dy;
                if (d < bestD) {
                  bestD = d;
                  best = ch;
                }
              }
            }
          }
        }
      }
      if (best >= 0) {
        packed.data[i + best] = srcLum;
        packed.data[i + 3] = 255;
      } else {
        // Unclassified bright texel → reactor (chest core is the usual leftover)
        packed.data[i] = srcLum;
        packed.data[i + 3] = 255;
      }
    }
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(packed, 0, 0);
    const packedTex = new THREE.CanvasTexture(canvas);
    packedTex.colorSpace = THREE.NoColorSpace;
    packedTex.flipY = emap.flipY;
    packedTex.wrapS = emap.wrapS;
    packedTex.wrapT = emap.wrapT;
    packedTex.needsUpdate = true;
    material.emissiveMap = packedTex;
    material.needsUpdate = true;
  } catch {
    // keep original map
  }
}

/**
 * Inject per-system uniforms so reactor / eyes / repulsors can ramp independently.
 * Powers live on material.userData so values set before first compile still apply.
 */
export function attachSystemsShader(
  material: THREE.MeshStandardMaterial,
): void {
  material.emissive.setRGB(1, 1, 1);
  material.emissiveIntensity = 1;
  material.userData.systemPowers = {
    reactor: 0,
    eyes: 0,
    repulsors: 0,
  } satisfies SystemPowers;

  material.onBeforeCompile = (shader) => {
    const p = material.userData.systemPowers as SystemPowers;
    shader.uniforms.uReactor = { value: p.reactor };
    shader.uniforms.uEyes = { value: p.eyes };
    shader.uniforms.uRepulsors = { value: p.repulsors };
    material.userData.shader = shader;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uReactor;
        uniform float uEyes;
        uniform float uRepulsors;
        `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #ifdef USE_EMISSIVEMAP
          vec4 emPacked = texture2D( emissiveMap, vEmissiveMapUv );
          float reactorM = emPacked.r * uReactor;
          float eyesM = emPacked.g * uEyes;
          float repulsorsM = emPacked.b * uRepulsors;
          // Cyan systems + warm eye slits (Mark III HUD)
          vec3 sysTint =
            vec3(0.45, 0.90, 1.0) * (reactorM + repulsorsM) +
            vec3(1.0, 0.94, 0.72) * eyesM;
          totalEmissiveRadiance = sysTint * emissive;
        #endif
        `,
      );
  };

  material.customProgramCacheKey = () => 'ironman-systems-glow-v1';
}

export function applySystemUniforms(
  glowMaterials: GlowMaterial[],
  powers: SystemPowers,
  pulse = 1,
): void {
  for (const { material, baseIntensity } of glowMaterials) {
    const scale = baseIntensity * POWER_EMISSIVE_BOOST * pulse;
    const scaled: SystemPowers = {
      reactor: powers.reactor * scale,
      eyes: powers.eyes * scale,
      repulsors: powers.repulsors * scale,
    };
    material.userData.systemPowers = scaled;

    const shader = material.userData.shader as
      | { uniforms: Record<string, { value: number }> }
      | undefined;
    if (!shader?.uniforms) continue;
    shader.uniforms.uReactor.value = scaled.reactor;
    shader.uniforms.uEyes.value = scaled.eyes;
    shader.uniforms.uRepulsors.value = scaled.repulsors;
  }
}
