import * as THREE from 'three';

/**
 * Industrial finishes for the robot cell.
 *
 * Physical materials with a small procedural layer injected into the
 * standard shader: object-space value-noise grime that darkens crevices and
 * roughens the clearcoat, fine directional scratches on bare metal, and
 * chipped safety paint that shows steel underneath. Noise is evaluated in
 * object space so it sticks to the moving links instead of swimming.
 */

export interface RobotMaterials {
  /** Graphite clearcoated paint (links, turret). */
  paint: THREE.MeshPhysicalMaterial;
  /** Safety-orange paint with chipped edges (bands, jaws). */
  accent: THREE.MeshPhysicalMaterial;
  /** Cast iron / black anodized (pedestals, motor housings). */
  dark: THREE.MeshPhysicalMaterial;
  /** Machined steel (flanges, tool bodies). */
  metal: THREE.MeshPhysicalMaterial;
  /** Hard chrome (piston rods, spindles). */
  chrome: THREE.MeshPhysicalMaterial;
  /** Cable sheathing / bellows. */
  rubber: THREE.MeshPhysicalMaterial;
  /** Status LEDs. */
  led: THREE.MeshStandardMaterial;
  /** Stencilled labels (transparent). */
  decal: THREE.MeshStandardMaterial;
}

export interface Weathering {
  /** Grime darkening / roughness variation 0–1. */
  grime: number;
  /** Fine directional scratches 0–1 (bare metal). */
  scratch: number;
  /** Paint chipping to bare steel 0–1. */
  chip: number;
  /** Noise frequency (cycles / m). */
  scale: number;
}

const NOISE_GLSL = /* glsl */ `
  varying vec3 vObjPos;
  uniform float uGrime;
  uniform float uScratch;
  uniform float uChip;
  uniform float uScale;
  float rHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float rNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(rHash(i), rHash(i + vec3(1, 0, 0)), f.x),
          mix(rHash(i + vec3(0, 1, 0)), rHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(rHash(i + vec3(0, 0, 1)), rHash(i + vec3(1, 0, 1)), f.x),
          mix(rHash(i + vec3(0, 1, 1)), rHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float rFbm(vec3 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      s += a * rNoise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return s;
  }
`;

export function weather<M extends THREE.MeshStandardMaterial>(mat: M, w: Weathering, key: string): M {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrime = { value: w.grime };
    shader.uniforms.uScratch = { value: w.scratch };
    shader.uniforms.uChip = { value: w.chip };
    shader.uniforms.uScale = { value: w.scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        vec3 rp = vObjPos * uScale;
        float rGrime = rFbm(rp);
        float rChipN = rFbm(rp * 6.3 + 7.0);
        float rChip = smoothstep(0.72, 0.75, rChipN) * uChip;
        diffuseColor.rgb *= mix(1.0, 0.7 + 0.3 * rGrime, uGrime);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.28, 0.29, 0.31), rChip);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        float rScr = rNoise(vObjPos * vec3(260.0, 9.0, 260.0));
        rScr = smoothstep(0.72, 0.98, rScr) * uScratch;
        // Grime only ever dulls the finish; scratches catch thin highlights
        roughnessFactor = clamp(roughnessFactor + rGrime * 0.3 * uGrime - rScr * 0.12, 0.08, 1.0);
        `,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `
        #include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 1.0, rChip);
        `,
      );
  };
  mat.customProgramCacheKey = () => `robot-${key}`;
  return mat;
}

/** Stencil sheet: maker plate, payload rating, hazard chevrons, axis numbers. */
function decalTexture(): THREE.Texture {
  // Headless (tests): a blank texture keeps the material graph intact
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  // Row 1: maker plate
  g.fillStyle = 'rgba(230,232,236,0.92)';
  g.font = 'bold 34px monospace';
  g.fillText('STARK INDUSTRIES', 18, 46);
  g.font = '20px monospace';
  g.fillStyle = 'rgba(200,120,42,0.95)';
  g.fillText('SI-6R  ROBOTIC FITTING CELL', 18, 76);
  // Row 2: hazard chevrons
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? 'rgba(20,20,22,0.95)' : 'rgba(214,150,40,0.95)';
    g.beginPath();
    g.moveTo(i * 32, 140);
    g.lineTo(i * 32 + 32, 140);
    g.lineTo(i * 32 + 16, 108);
    g.lineTo(i * 32 - 16, 108);
    g.closePath();
    g.fill();
  }
  // Row 3: payload + axis labels
  g.fillStyle = 'rgba(230,232,236,0.85)';
  g.font = '22px monospace';
  g.fillText('MAX PAYLOAD 120 kg', 18, 186);
  g.font = 'bold 40px monospace';
  g.fillText('A1  A2  A3', 18, 238);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** UV sub-rectangles of the decal sheet (u0, v0, u1, v1). */
export const DECAL_RECTS = {
  maker: [0, 0.68, 1, 1],
  hazard: [0, 0.45, 1, 0.58],
  payload: [0, 0.22, 0.75, 0.33],
  axes: [0, 0.0, 0.6, 0.17],
} as const;

export function createRobotMaterials(): RobotMaterials {
  return {
    paint: weather(
      new THREE.MeshPhysicalMaterial({
        color: 0x2b3038,
        metalness: 0.35,
        roughness: 0.42,
        clearcoat: 0.55,
        clearcoatRoughness: 0.28,
      }),
      { grime: 0.6, scratch: 0.15, chip: 0.25, scale: 9 },
      'paint',
    ),
    accent: weather(
      new THREE.MeshPhysicalMaterial({
        color: 0xb4682a,
        metalness: 0.2,
        roughness: 0.48,
        clearcoat: 0.35,
        clearcoatRoughness: 0.35,
      }),
      { grime: 0.5, scratch: 0.1, chip: 0.6, scale: 14 },
      'accent',
    ),
    dark: weather(
      new THREE.MeshPhysicalMaterial({ color: 0x15171b, metalness: 0.55, roughness: 0.6 }),
      { grime: 0.7, scratch: 0.2, chip: 0, scale: 6 },
      'dark',
    ),
    metal: weather(
      new THREE.MeshPhysicalMaterial({ color: 0x9aa1a8, metalness: 1, roughness: 0.32 }),
      { grime: 0.35, scratch: 0.9, chip: 0, scale: 18 },
      'metal',
    ),
    chrome: weather(
      new THREE.MeshPhysicalMaterial({ color: 0xe2e6ea, metalness: 1, roughness: 0.1 }),
      { grime: 0.15, scratch: 0.5, chip: 0, scale: 30 },
      'chrome',
    ),
    rubber: weather(
      new THREE.MeshPhysicalMaterial({ color: 0x0d0e10, metalness: 0, roughness: 0.82, sheen: 0.3 }),
      { grime: 0.4, scratch: 0, chip: 0, scale: 25 },
      'rubber',
    ),
    led: new THREE.MeshStandardMaterial({
      color: 0x0c2a33,
      emissive: new THREE.Color(0x5ad8ff),
      emissiveIntensity: 1.6,
    }),
    decal: new THREE.MeshStandardMaterial({
      map: decalTexture(),
      transparent: true,
      alphaTest: 0.05,
      metalness: 0.2,
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      depthWrite: false,
    }),
  };
}

/** Plane showing one region of the decal sheet. */
export function decalPlane(
  mats: RobotMaterials,
  rect: readonly [number, number, number, number],
  width: number,
): THREE.Mesh {
  const [u0, v0, u1, v1] = rect;
  const aspect = ((u1 - u0) * 512) / ((v1 - v0) * 256);
  const geo = new THREE.PlaneGeometry(width, width / aspect);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  return new THREE.Mesh(geo, mats.decal);
}
