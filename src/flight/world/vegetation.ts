import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { HOME, type Heightfield } from './heightfield';

/**
 * Chaparral, coast live oaks and, high on the range, pines — instanced
 * around the eye out to ~1.7 km and grown from the same cover map the
 * terrain shader paints (scrub where it's olive, oaks down the sheltered
 * folds), so the ground and what stands on it agree. They're what gives
 * low flying its sense of speed. Canopies use rounded normals (soft, lit
 * like foliage, not facets), sway a touch in the wind, sit in the baked
 * hill shadows and fade into the haze.
 */

const CELL = 128;
const RADIUS = 1700;
const CAP = { shrub: 26000, oak: 9000, pine: 6000 } as const;
type Kind = keyof typeof CAP;

function seeded(cx: number, cz: number): () => number {
  let s = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

/** Lumpy blob with normals pointing out from its own centre. */
function blob(r: number, sy: number, at: THREE.Vector3, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 0);
  const pos = g.getAttribute('position');
  const nrm = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const k = 1 + 0.18 * Math.sin(v.x * 5.1 + seed) * Math.sin(v.z * 4.3 + seed * 2) + 0.1 * Math.sin(v.y * 7 + seed);
    v.multiplyScalar(k);
    v.y *= sy;
    pos.setXYZ(i, v.x + at.x, v.y + at.y, v.z + at.z);
    // Rounded: half the blob's own normal, half up (sky-lit tops)
    n.y = n.y * 0.8 + 0.35;
    n.normalize();
    nrm.set([n.x, n.y, n.z], i * 3);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

function paint(g: THREE.BufferGeometry, top: THREE.Color, bottom: THREE.Color, y0: number, y1: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const k = THREE.MathUtils.clamp((pos.getY(i) - y0) / (y1 - y0), 0, 1);
    c.copy(bottom).lerp(top, k);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g;
}

function shrubGeometry(): THREE.BufferGeometry {
  const g = mergeGeometries([
    blob(1, 0.62, new THREE.Vector3(0, 0.45, 0), 1),
    blob(0.7, 0.7, new THREE.Vector3(0.6, 0.35, 0.2), 2),
  ]);
  return paint(g, new THREE.Color(0.075, 0.095, 0.04), new THREE.Color(0.02, 0.028, 0.012), 0, 1.1);
}

function oakGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.18, 0.3, 3.2, 6, 1, true).translate(0, 1.6, 0).toNonIndexed();
  paint(trunk, new THREE.Color(0.08, 0.065, 0.05), new THREE.Color(0.05, 0.04, 0.03), 0, 3);
  const canopy = mergeGeometries([
    blob(2.6, 0.62, new THREE.Vector3(0, 4.2, 0), 3),
    blob(2.0, 0.6, new THREE.Vector3(1.9, 3.6, 0.6), 4),
    blob(1.9, 0.6, new THREE.Vector3(-1.6, 3.7, -0.9), 5),
    blob(1.5, 0.6, new THREE.Vector3(0.3, 5.0, -1.4), 6),
  ]);
  paint(canopy, new THREE.Color(0.1, 0.13, 0.05), new THREE.Color(0.025, 0.035, 0.015), 2.6, 5.8);
  return mergeGeometries([trunk, canopy]);
}

function pineGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.14, 0.22, 2.5, 5, 1, true).translate(0, 1.25, 0).toNonIndexed();
  paint(trunk, new THREE.Color(0.08, 0.06, 0.045), new THREE.Color(0.05, 0.04, 0.03), 0, 2);
  const tiers = [0, 1, 2].map((i) => {
    const c = new THREE.ConeGeometry(2.4 - i * 0.6, 3.6 - i * 0.5, 7, 1, true).translate(0, 3.2 + i * 2.1, 0).toNonIndexed();
    // Soften the cone normals toward up
    const n = c.getAttribute('normal');
    for (let k = 0; k < n.count; k++) {
      const v = new THREE.Vector3(n.getX(k), n.getY(k) + 0.5, n.getZ(k)).normalize();
      n.setXYZ(k, v.x, v.y, v.z);
    }
    return c;
  });
  const crown = mergeGeometries(tiers);
  paint(crown, new THREE.Color(0.06, 0.1, 0.06), new THREE.Color(0.02, 0.035, 0.02), 1.8, 9);
  return mergeGeometries([trunk, crown]);
}

const VERT_PARS = /* glsl */ `
uniform float uTime;
uniform float uRadius;
uniform vec3 uEye;
varying vec3 vInstWorld;
`;
const VERT_BEGIN = /* glsl */ `
  vec3 transformed = vec3(position);
  vec3 origin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vInstWorld = origin;
  // Wind: the crown sways, the base stays planted
  float sway = sin(uTime * 1.3 + origin.x * 0.05 + origin.z * 0.07) * 0.04 * max(position.y - 0.5, 0.0);
  transformed.x += sway;
  transformed.z += sway * 0.6;
  // Grow in / out at the edge of the planted ring
  float d = distance(origin, uEye);
  transformed *= smoothstep(uRadius, uRadius * 0.82, d);
`;
const FRAG_PARS = /* glsl */ `
uniform sampler2D uBake;
uniform float uWorld;
varying vec3 vInstWorld;
${ATMOSPHERE_GLSL}
`;

export class Vegetation {
  readonly group = new THREE.Group();
  private readonly meshes: Record<Kind, THREE.InstancedMesh>;
  private readonly cache = new Map<string, Record<Kind, number[]>>();
  private lastCell = '';
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(
    private readonly field: Heightfield,
    atmosphere: Record<string, THREE.IUniform>,
  ) {
    this.uniforms = {
      ...atmosphere,
      uBake: field.uniforms.uBake,
      uWorld: field.uniforms.uWorld,
      uTime: { value: 0 },
      uRadius: { value: RADIUS },
      uEye: { value: new THREE.Vector3() },
    };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    mat.envMapIntensity = 0.7;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', VERT_BEGIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace(
          '#include <aomap_fragment>',
          /* glsl */ `
          vec4 vegBake = texture2D(uBake, vInstWorld.xz / uWorld + 0.5);
          reflectedLight.directDiffuse *= vegBake.r;
          reflectedLight.directSpecular *= vegBake.r;
          reflectedLight.indirectDiffuse *= mix(0.6, 1.0, vegBake.g);`,
        )
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vInstWorld);');
    };
    mat.customProgramCacheKey = () => 'vegetation';
    const make = (geo: THREE.BufferGeometry, kind: Kind) => {
      const m = new THREE.InstancedMesh(geo, mat, CAP[kind]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    this.meshes = { shrub: make(shrubGeometry(), 'shrub'), oak: make(oakGeometry(), 'oak'), pine: make(pineGeometry(), 'pine') };
    this.group.name = 'vegetation';
  }

  /** Instances for one cell (matrices, 16 floats each), computed once. */
  private cell(cx: number, cz: number): Record<Kind, number[]> {
    const key = `${cx},${cz}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out: Record<Kind, number[]> = { shrub: [], oak: [], pine: [] };
    const rnd = seeded(cx, cz);
    const F = this.field;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const tilt = new THREE.Quaternion();
    for (let i = 0; i < 110; i++) {
      const x = (cx + rnd()) * CELL;
      const z = (cz + rnd()) * CELL;
      const r = rnd();
      const h = F.heightAt(x, z);
      if (h < 3.5 || h > 1500) continue;
      if (Math.hypot(x - HOME.x, z - HOME.y) < 90) continue;
      F.normalAt(x, z, n);
      const slope = 1 - n.y;
      if (slope > 0.42) continue;
      // The terrain shader's cover map, on the CPU
      const m2 = F.toneAt(x + 517, z + 517, 1130);
      const m3 = F.toneAt(x - 211, z - 211, 430);
      const mid = F.toneAt(x, z, 160);
      const scrub = THREE.MathUtils.smoothstep(m2 * 0.5 + m3 * 0.35 + mid * 0.15 + slope * 0.35, 0.5, 0.66);
      const ao = F.aoAt(x, z);
      const oakK = (1 - THREE.MathUtils.smoothstep(ao, 0.52, 0.82)) * (1 - THREE.MathUtils.smoothstep(slope, 0.16, 0.38)) * (0.45 + 0.55 * m3);
      const high = THREE.MathUtils.smoothstep(h, 600, 1000);
      let kind: Kind | null = null;
      if (r < oakK * 0.55) kind = high > 0.5 ? 'pine' : 'oak';
      else if (r < oakK * 0.55 + scrub * 0.6 + 0.06) kind = 'shrub';
      else if (r > 0.985 && high < 0.5) kind = 'oak';
      else if (r > 0.97 && high > 0.5) kind = 'pine';
      if (!kind) continue;
      const k = kind === 'shrub' ? 0.8 + rnd() * 1.8 : 0.7 + rnd() * 0.75;
      s.set(k * (0.85 + rnd() * 0.3), k * (0.8 + rnd() * 0.4), k * (0.85 + rnd() * 0.3));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      // Shrubs lean with the slope; trees grow straight up
      if (kind === 'shrub') q.premultiply(tilt.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n));
      p.set(x, h - 0.25 * k, z);
      m.compose(p, q, s);
      out[kind].push(...m.elements);
    }
    this.cache.set(key, out);
    if (this.cache.size > 3000) {
      // Forget the oldest cells
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return out;
  }

  update(camera: THREE.Camera, time: number): void {
    const eye = camera.position;
    this.uniforms.uTime.value = time;
    (this.uniforms.uEye.value as THREE.Vector3).copy(eye);
    const ground = Math.max(0, this.field.heightAt(eye.x, eye.z));
    const alt = eye.y - ground;
    this.group.visible = alt < RADIUS;
    if (!this.group.visible) return;
    const cx = Math.floor(eye.x / CELL);
    const cz = Math.floor(eye.z / CELL);
    const key = `${cx},${cz}`;
    if (key === this.lastCell) return;
    this.lastCell = key;
    const reach = Math.ceil(RADIUS / CELL);
    const counts: Record<Kind, number> = { shrub: 0, oak: 0, pine: 0 };
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const dx = Math.max(0, Math.abs(i) - 0.5) * CELL;
        const dz = Math.max(0, Math.abs(j) - 0.5) * CELL;
        if (dx * dx + dz * dz > RADIUS * RADIUS) continue;
        const c = this.cell(cx + i, cz + j);
        for (const kind of ['shrub', 'oak', 'pine'] as const) {
          const src = c[kind];
          const mesh = this.meshes[kind];
          const room = CAP[kind] - counts[kind];
          const n = Math.min(room, src.length / 16);
          if (n <= 0) continue;
          (mesh.instanceMatrix.array as Float32Array).set(n * 16 === src.length ? src : src.slice(0, n * 16), counts[kind] * 16);
          counts[kind] += n;
        }
      }
    }
    for (const kind of ['shrub', 'oak', 'pine'] as const) {
      const mesh = this.meshes[kind];
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  get instanceCount(): number {
    return this.meshes.shrub.count + this.meshes.oak.count + this.meshes.pine.count;
  }
}
