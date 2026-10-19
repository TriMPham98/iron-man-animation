import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { HOME, coastZ, type Heightfield } from './heightfield';

/**
 * The Malibu cover: chaparral and grey coastal sage on the dry slopes,
 * spreading coast live oaks down the sheltered folds, fan palms along the
 * bluffs and beaches, a few pines high on the range, and close to the eye
 * a carpet of dry grass and brush clumps. Grown from the same cover map
 * the terrain shader paints, so the ground and what stands on it agree;
 * they're what gives low flying its sense of speed.
 *
 * Level of detail, per 128 m cell:
 *  - Near (< ~420 m): real instanced geometry, one draw per species, with
 *    rounded canopy normals and wind sway in the vertex shader.
 *  - Far (to 2 km): one instanced draw of camera-facing impostors cut from
 *    an atlas the 3D models are rendered into at boot (colour + normals),
 *    so they light and shade like the models they stand in for. They
 *    dither in (per pixel) over the models through a band before the
 *    models step out, so nothing pops.
 *  - Dense brush (< ~230 m): small clumps that grow in from the edge.
 * Cells are culled against a widened view frustum and the instance lists
 * rebuilt only when the eye has moved or turned enough to need it.
 */

const CELL = 128;
/** Impostors reach this far (m). */
const RADIUS = 2000;
/** 3D models hand over to impostors across this band (m). */
const LOD_NEAR = 330;
const LOD_FAR = 420;
/** Dense brush out to here (m). */
const TUFT_R = 230;
/** Rebuild the lists after this much travel (m) or turn (cos of ~7°). */
const REBUILD_MOVE = 24;
const REBUILD_TURN = Math.cos(THREE.MathUtils.degToRad(7));
/** Extra cone round the view frustum for the cull (≈ 12°). */
const CULL_MARGIN = 0.21;
/** Main-thread time a rebuild may spend planting new far cells (ms). */
const PLANT_BUDGET_MS = 2.5;

const KINDS = ['bush', 'oak', 'pine', 'palm'] as const;
type Kind = (typeof KINDS)[number];
const CAP: Record<Kind | 'tuft' | 'grass', number> = { bush: 16000, oak: 5000, pine: 2500, palm: 2000, tuft: 10000, grass: 16000 };
const IMP_CAP = 60000;
/** Floats per near instance: matrix (16) + tint (3). */
const NEAR_STRIDE = 19;
/** Floats per impostor: x y z sy | sx kind | r g b. */
const IMP_STRIDE = 9;

function seeded(cx: number, cz: number, salt = 0): () => number {
  let s = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

// ── Models ───────────────────────────────────────────────────────────────

/** Lumpy blob with normals pointing out from its own centre. */
function blob(r: number, sy: number, at: THREE.Vector3, seed: number, detail = 0): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.getAttribute('position');
  const nrm = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.copy(v).normalize();
    const k =
      1 +
      0.2 * Math.sin(v.x * 5.1 / r + seed) * Math.sin(v.z * 4.3 / r + seed * 2) +
      0.12 * Math.sin(v.y * 7 / r + seed) +
      (detail > 0 ? 0.08 * Math.sin(v.x * 13 / r + v.z * 11 / r + seed * 3) : 0);
    v.multiplyScalar(k);
    v.y *= sy;
    // Flat-ish underside: crowns sit on their branches, not on a point
    if (v.y < -r * sy * 0.45) v.y = -r * sy * 0.45 + (v.y + r * sy * 0.45) * 0.3;
    pos.setXYZ(i, v.x + at.x, v.y + at.y, v.z + at.z);
    // Rounded: the blob's own normal leaning up (sky-lit tops)
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
  return g.index ? g.toNonIndexed() : g;
}

/** A tapered limb from a to b (open tube). */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, sides = 5): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true).translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q).translate(a.x, a.y, a.z);
  return g;
}

const BARK = [new THREE.Color(0.075, 0.062, 0.05), new THREE.Color(0.045, 0.037, 0.03)] as const;

/** Chaparral clump: three dense lobes (also sage, and the brush near the eye, by tint). */
function bushGeometry(): THREE.BufferGeometry {
  const g = mergeGeometries([
    blob(0.9, 0.66, new THREE.Vector3(0, 0.5, 0), 1),
    blob(0.66, 0.72, new THREE.Vector3(0.62, 0.38, 0.2), 2),
    blob(0.58, 0.7, new THREE.Vector3(-0.5, 0.32, -0.45), 3),
    blob(0.5, 0.8, new THREE.Vector3(-0.2, 0.75, 0.45), 4),
    blob(0.45, 0.7, new THREE.Vector3(0.3, 0.3, -0.7), 5),
  ]);
  return paint(g, new THREE.Color(0.075, 0.095, 0.04), new THREE.Color(0.02, 0.028, 0.012), 0, 1.1);
}

/** Dry grass clump: a fan of thin bent blades (two-sided). */
function grassGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const rnd = seeded(3, 9);
  const base = new THREE.Color(0.3, 0.22, 0.1);
  const tip = new THREE.Color(0.62, 0.5, 0.28);
  for (let b = 0; b < 9; b++) {
    const a = rnd() * Math.PI * 2;
    const lean = 0.15 + rnd() * 0.35;
    const h = 0.45 + rnd() * 0.45;
    const r = rnd() * 0.12;
    const ox = Math.cos(a) * r;
    const oz = Math.sin(a) * r;
    const sx = -Math.sin(a) * 0.035;
    const sz = Math.cos(a) * 0.035;
    const mid = [ox + Math.cos(a) * lean * h * 0.4, h * 0.55, oz + Math.sin(a) * lean * h * 0.4];
    const top = [ox + Math.cos(a) * lean * h, h, oz + Math.sin(a) * lean * h];
    const quad = [
      [ox - sx, 0, oz - sz],
      [ox + sx, 0, oz + sz],
      [mid[0] + sx * 0.7, mid[1], mid[2] + sz * 0.7],
      [mid[0] - sx * 0.7, mid[1], mid[2] - sz * 0.7],
    ];
    const tris = [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3], quad[3], quad[2], top];
    for (const flip of [false, true]) {
      for (let t = 0; t < tris.length; t += 3) {
        const tri = flip ? [tris[t], tris[t + 2], tris[t + 1]] : tris.slice(t, t + 3);
        for (const v of tri) {
          pos.push(v[0], v[1], v[2]);
          // Blades light like the ground they stand on (sky-lit, soft)
          nrm.push(Math.cos(a) * 0.3, 0.95, Math.sin(a) * 0.3);
          const c = base.clone().lerp(tip, v[1] / h);
          col.push(c.r, c.g, c.b);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Coast live oak: short trunk forking into limbs under a broad, flat-topped, lumpy crown. */
function oakGeometry(): THREE.BufferGeometry {
  const base = new THREE.Vector3(0, 0, 0);
  const fork = new THREE.Vector3(0.1, 2.0, 0);
  const wood = [
    limb(base, fork, 0.34, 0.26, 6),
    limb(fork, new THREE.Vector3(2.0, 3.9, 0.7), 0.2, 0.09),
    limb(fork, new THREE.Vector3(-1.8, 4.0, -0.8), 0.19, 0.08),
    limb(fork, new THREE.Vector3(0.3, 4.4, -1.6), 0.16, 0.07),
  ].map((g) => paint(g, BARK[0], BARK[1], 0, 3));
  const canopy = mergeGeometries([
    blob(2.6, 0.85, new THREE.Vector3(0.1, 4.9, 0), 3, 1),
    blob(2.0, 0.8, new THREE.Vector3(2.2, 4.2, 0.8), 4, 1),
    blob(1.9, 0.8, new THREE.Vector3(-2.0, 4.3, -0.9), 5),
    blob(1.7, 0.85, new THREE.Vector3(0.5, 4.8, -2.0), 6),
    blob(1.7, 0.8, new THREE.Vector3(-0.8, 4.5, 2.0), 7),
    blob(1.4, 0.85, new THREE.Vector3(3.1, 3.9, -0.9), 8),
    blob(1.7, 0.85, new THREE.Vector3(0.6, 6.4, 0.4), 9),
    blob(1.3, 0.85, new THREE.Vector3(-1.4, 6.0, -0.6), 10),
  ]);
  const crown = paint(canopy, new THREE.Color(0.1, 0.13, 0.05), new THREE.Color(0.022, 0.032, 0.014), 2.8, 6.6);
  return mergeGeometries([...wood, crown]);
}

/** A star-rimmed cone: needled tiers read ragged, not like party hats. */
function tier(r: number, h: number, y: number, seed: number): THREE.BufferGeometry {
  const c = new THREE.ConeGeometry(r, h, 10, 1, true).translate(0, y, 0);
  const pos = c.getAttribute('position');
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k);
    if (v.y < y) {
      const a = Math.atan2(v.z, v.x);
      const s = 0.72 + 0.28 * (Math.round(((a + Math.PI) / (2 * Math.PI)) * 10) % 2) + 0.08 * Math.sin(a * 3 + seed);
      pos.setXYZ(k, v.x * s, v.y - 0.25 * (1 - s), v.z * s);
    }
  }
  c.computeVertexNormals();
  const n = c.getAttribute('normal');
  for (let k = 0; k < n.count; k++) {
    v.set(n.getX(k), n.getY(k) + 0.5, n.getZ(k)).normalize();
    n.setXYZ(k, v.x, v.y, v.z);
  }
  return c;
}

function pineGeometry(): THREE.BufferGeometry {
  const trunk = paint(limb(new THREE.Vector3(), new THREE.Vector3(0, 3, 0), 0.22, 0.14), BARK[0], BARK[1], 0, 2);
  const crown = mergeGeometries([0, 1, 2, 3].map((i) => tier(2.5 - i * 0.55, 3.4 - i * 0.45, 3.0 + i * 1.75, i)));
  return mergeGeometries([trunk, paint(crown, new THREE.Color(0.06, 0.1, 0.06), new THREE.Color(0.02, 0.035, 0.02), 1.8, 9.5)]);
}

/** Mexican fan palm: a tall, slightly bent trunk under a mop of drooping fronds. */
function palmGeometry(): THREE.BufferGeometry {
  const H = 13;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 7; i++) {
    const t = i / 7;
    pts.push(new THREE.Vector3(0.9 * t * t, H * t, 0.25 * t * t));
  }
  const trunk = mergeGeometries(pts.slice(1).map((p, i) => limb(pts[i], p, 0.24 - i * 0.015, 0.23 - (i + 1) * 0.015, 6)));
  const trunkP = paint(trunk, new THREE.Color(0.12, 0.1, 0.08), new THREE.Color(0.07, 0.06, 0.05), 0, H);
  const top = pts[pts.length - 1];
  // Old fronds: a dead brown skirt under the crown
  const skirt = paint(blob(0.75, 1.2, top.clone().add(new THREE.Vector3(0, -0.7, 0)), 9), new THREE.Color(0.1, 0.075, 0.045), new THREE.Color(0.05, 0.04, 0.03), H - 1.6, H);
  const fronds: THREE.BufferGeometry[] = [];
  const N = 11;
  for (let f = 0; f < N; f++) {
    const a = (f / N) * Math.PI * 2 + (f % 2) * 0.2;
    const lift = f % 3 === 0 ? 0.55 : f % 3 === 1 ? 0.25 : -0.05;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const pos: number[] = [];
    const nrm: number[] = [];
    const SEG = 5;
    const L = 4.0;
    const ring: THREE.Vector3[][] = [];
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      // Out and arching over: up, then drooping at the tip
      const c = top
        .clone()
        .addScaledVector(dir, L * t)
        .add(new THREE.Vector3(0, L * (lift * t - 0.55 * t * t), 0));
      const w = 0.8 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08));
      ring.push([c.clone().addScaledVector(side, -w), c, c.clone().addScaledVector(side, w)]);
    }
    const up = new THREE.Vector3(0, 1, 0);
    const push = (v: THREE.Vector3) => {
      pos.push(v.x, v.y, v.z);
      const n = up.clone().addScaledVector(dir, 0.35).normalize();
      nrm.push(n.x, n.y, n.z);
    };
    for (let s = 0; s < SEG; s++) {
      for (const [i0, i1] of [
        [0, 1],
        [1, 2],
      ]) {
        // Folded leaf: the mid-rib sits a little lower than the edges
        const a0 = ring[s][i0];
        const b0 = ring[s][i1];
        const a1 = ring[s + 1][i0];
        const b1 = ring[s + 1][i1];
        for (const v of [a0, a1, b0, b0, a1, b1]) push(v);
        for (const v of [a0, b0, a1, b0, b1, a1]) push(v); // back face
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    fronds.push(g);
  }
  const crown = paint(mergeGeometries(fronds), new THREE.Color(0.1, 0.14, 0.05), new THREE.Color(0.045, 0.06, 0.025), H - 2, H + 1.5);
  return mergeGeometries([trunkP, skirt, crown]);
}

// ── Shaders ──────────────────────────────────────────────────────────────

const DITHER_GLSL = /* glsl */ `
// Interleaved gradient noise: a per-pixel threshold for the impostors'
// fade-in, stable on screen (no shimmer as the eye moves)
float lodDither() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
`;

const NEAR_VERT_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uEye;
uniform vec4 uFade; // (unused, unused), shrink band (inner, outer)
varying vec3 vInstWorld;
`;
const NEAR_VERT_BEGIN = /* glsl */ `
  vec3 transformed = vec3(position);
  vec3 origin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vInstWorld = origin;
  // Wind: gusts roll across the hills; crowns sway, bases stay planted
  float gust = 0.6 + 0.4 * sin(uTime * 0.37 + origin.x * 0.004 - origin.z * 0.003);
  float ph = uTime * 1.3 + origin.x * 0.05 + origin.z * 0.07;
  float bend = max(position.y - 0.5, 0.0);
  float sway = (sin(ph) * 0.04 + sin(ph * 2.7 + position.x) * 0.012) * bend * gust;
  transformed.x += sway;
  transformed.z += sway * 0.6;
  transformed *= smoothstep(uFade.w, uFade.z, distance(origin, uEye));
`;
const NEAR_FRAG_PARS = /* glsl */ `
uniform sampler2D uBake;
uniform float uWorld;
varying vec3 vInstWorld;
${ATMOSPHERE_GLSL}
`;
const SHADE_GLSL = /* glsl */ `
  vec4 vegBake = texture2D(uBake, vInstWorld.xz / uWorld + 0.5);
  reflectedLight.directDiffuse *= vegBake.r;
  reflectedLight.directSpecular *= vegBake.r;
  reflectedLight.indirectDiffuse *= mix(0.6, 1.0, vegBake.g);
`;

const IMP_VERT_PARS = /* glsl */ `
attribute vec4 iA; // x y z, height scale
attribute vec2 iB; // width scale, kind
attribute vec3 iT; // tint
uniform float uTime;
uniform vec3 uEye;
uniform vec4 uFade; // dither band (start, end), outer shrink (start, end)
uniform vec4 uKinds[4]; // half-width, height, base offset, atlas column
varying vec3 vInstWorld;
varying float vLod;
varying vec2 vAtlas;
varying vec3 vTint;
varying vec3 vRight;
varying vec3 vUpW;
varying vec3 vFwd;
`;
const IMP_VERT_BEGIN = /* glsl */ `
  vec4 K = uKinds[int(iB.y + 0.5)];
  vec3 origin = iA.xyz;
  vInstWorld = origin;
  vTint = iT;
  vec3 toCam = cameraPosition - origin;
  float d = length(toCam);
  vec3 dir = toCam / max(d, 1e-3);
  vec3 flat3 = normalize(vec3(toCam.x, 0.0, toCam.z) + vec3(1e-4, 0.0, 0.0));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), flat3));
  // Upright, leaning back toward the eye when seen from above (no paper-thin crowns)
  vec3 up = normalize(vec3(0.0, 1.0, 0.0) - dir * dir.y * 0.6);
  vec3 fwd = normalize(cross(right, up));
  vRight = right;
  vUpW = up;
  vFwd = fwd;
  float grow = smoothstep(uFade.w, uFade.z, d);
  float w = K.x * iB.x * grow;
  float h = K.y * iA.w * grow;
  float gust = 0.6 + 0.4 * sin(uTime * 0.37 + origin.x * 0.004 - origin.z * 0.003);
  float sway = sin(uTime * 1.3 + origin.x * 0.05 + origin.z * 0.07) * 0.04 * gust * (position.y + 0.5) * h;
  vec3 transformed = origin + right * (position.x * 2.0 * w + sway) + up * (K.z * iA.w + (position.y + 0.5) * h);
  vLod = smoothstep(uFade.x, uFade.y, d);
  vAtlas = vec2((uv.x + K.w) * 0.25, uv.y);
`;
const IMP_FRAG_PARS = /* glsl */ `
uniform sampler2D uBake;
uniform float uWorld;
uniform sampler2D uAtlasC;
uniform sampler2D uAtlasN;
varying vec3 vInstWorld;
varying float vLod;
varying vec2 vAtlas;
varying vec3 vTint;
varying vec3 vRight;
varying vec3 vUpW;
varying vec3 vFwd;
${DITHER_GLSL}
${ATMOSPHERE_GLSL}
`;

// ── Impostor atlas ───────────────────────────────────────────────────────

const ATLAS_CELL = 256;

/** Renders each model side-on into an atlas column: colour (√-encoded) and normals. */
function bakeAtlas(renderer: THREE.WebGLRenderer, geos: THREE.BufferGeometry[]): { color: THREE.Texture; normal: THREE.Texture; kinds: THREE.Vector4[] } {
  const W = ATLAS_CELL * geos.length;
  const make = () =>
    new THREE.WebGLRenderTarget(W, ATLAS_CELL, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
    });
  const color = make();
  const normal = make();
  const vert = /* glsl */ `
    attribute vec3 color;
    varying vec3 vC;
    varying vec3 vN;
    void main() {
      vC = color;
      vN = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const matC = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: 'varying vec3 vC; varying vec3 vN; void main() { gl_FragColor = vec4(sqrt(vC), 1.0); }', side: THREE.DoubleSide });
  const matN = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: 'varying vec3 vC; varying vec3 vN; void main() { vec3 n = normalize(vN); n = gl_FrontFacing ? n : -n; gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }',
    side: THREE.DoubleSide,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geos[0], matC);
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, 0, 0.1, 100);
  const kinds: THREE.Vector4[] = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  for (const rt of [color, normal]) {
    renderer.setRenderTarget(rt);
    renderer.clear();
  }
  geos.forEach((g, i) => {
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const hw = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z) * 1.02;
    const y0 = Math.min(0, b.min.y);
    const h = (b.max.y - y0) * 1.02;
    cam.left = -hw;
    cam.right = hw;
    cam.bottom = y0;
    cam.top = y0 + h;
    cam.position.set(0, 0, 50);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    mesh.geometry = g;
    for (const [rt, m] of [
      [color, matC],
      [normal, matN],
    ] as const) {
      mesh.material = m;
      rt.viewport.set(i * ATLAS_CELL, 0, ATLAS_CELL, ATLAS_CELL);
      rt.scissor.set(i * ATLAS_CELL, 0, ATLAS_CELL, ATLAS_CELL);
      rt.scissorTest = true;
      renderer.setRenderTarget(rt);
      renderer.clearDepth();
      renderer.render(scene, cam);
    }
    kinds.push(new THREE.Vector4(hw, h, y0, i));
  });
  for (const rt of [color, normal]) {
    rt.viewport.set(0, 0, W, ATLAS_CELL);
    rt.scissor.set(0, 0, W, ATLAS_CELL);
    rt.scissorTest = false;
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAutoClear;
  matC.dispose();
  matN.dispose();
  return { color: color.texture, normal: normal.texture, kinds };
}

// ── Placement ────────────────────────────────────────────────────────────

interface CellData {
  x: number;
  z: number;
  minY: number;
  maxY: number;
  near: Record<Kind, Float32Array>;
  imp: Float32Array;
  /** Brush clumps: worked out only once the eye comes near (undefined until then). */
  tuft: { brush: Float32Array; grass: Float32Array } | null | undefined;
  cx: number;
  cz: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Tints (multiplying the models' own colours). */
const TINT = {
  chaparral: [1, 1, 1],
  sage: [1.75, 1.75, 1.95],
  dryBrush: [2.4, 1.75, 1.35],
  greenGrass: [0.7, 0.85, 0.6],
} as const;

export class Vegetation {
  readonly group = new THREE.Group();
  private readonly near: Record<Kind, THREE.InstancedMesh>;
  private readonly tuft: THREE.InstancedMesh;
  private readonly grass: THREE.InstancedMesh;
  private readonly imp: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  private readonly impA: THREE.InstancedBufferAttribute;
  private readonly impB: THREE.InstancedBufferAttribute;
  private readonly impT: THREE.InstancedBufferAttribute;
  private readonly cache = new Map<string, CellData>();
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly lastEye = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastDir = new THREE.Vector3();
  private lastFov = 0;
  /** Cells left unplanted at the last rebuild (over the time budget). */
  private pending = false;
  private readonly frustum = new THREE.Frustum();
  private readonly _vp = new THREE.Matrix4();
  private readonly _dir = new THREE.Vector3();
  private readonly geos: Record<Kind, THREE.BufferGeometry>;
  /** Cells and instances put in the lists at the last rebuild (stats). */
  stats = { cells: 0, near: 0, imp: 0, tuft: 0, rebuilds: 0, buildMs: 0 };

  constructor(
    private readonly field: Heightfield,
    atmosphere: Record<string, THREE.IUniform>,
    renderer?: THREE.WebGLRenderer,
  ) {
    this.uniforms = {
      ...atmosphere,
      uBake: field.uniforms.uBake,
      uWorld: field.uniforms.uWorld,
      uTime: { value: 0 },
      uEye: { value: new THREE.Vector3() },
    };
    this.geos = { bush: bushGeometry(), oak: oakGeometry(), pine: pineGeometry(), palm: palmGeometry() };

    const nearMat = (fade: THREE.Vector4, key: string) => {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
      mat.envMapIntensity = 0.7;
      const u = { ...this.uniforms, uFade: { value: fade } };
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${NEAR_VERT_PARS}`).replace('#include <begin_vertex>', NEAR_VERT_BEGIN);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${NEAR_FRAG_PARS}`)
          .replace('#include <aomap_fragment>', SHADE_GLSL)
          .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vInstWorld);');
      };
      mat.customProgramCacheKey = () => `vegetation-${key}`;
      return mat;
    };
    // The impostors dither in across the LOD band over the models, which then
    // shrink away in its last few metres: no discard in the models' shader
    // (alpha-tested draws lose hidden-surface removal on tiled GPUs)
    const treeMat = nearMat(new THREE.Vector4(1e6, 1e6 + 1, LOD_FAR - 14, LOD_FAR), 'near');
    const tuftMat = nearMat(new THREE.Vector4(1e6, 1e6 + 1, TUFT_R * 0.75, TUFT_R), 'tuft');
    const make = (geo: THREE.BufferGeometry, cap: number, mat: THREE.Material) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      return m;
    };
    this.near = {
      bush: make(this.geos.bush, CAP.bush, treeMat),
      oak: make(this.geos.oak, CAP.oak, treeMat),
      pine: make(this.geos.pine, CAP.pine, treeMat),
      palm: make(this.geos.palm, CAP.palm, treeMat),
    };
    this.tuft = make(this.geos.bush, CAP.tuft, tuftMat);
    this.grass = make(grassGeometry(), CAP.grass, tuftMat);

    // Impostors
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.setAttribute('normal', quad.getAttribute('normal'));
    this.impA = new THREE.InstancedBufferAttribute(new Float32Array(IMP_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.impB = new THREE.InstancedBufferAttribute(new Float32Array(IMP_CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.impT = new THREE.InstancedBufferAttribute(new Float32Array(IMP_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iA', this.impA);
    geo.setAttribute('iB', this.impB);
    geo.setAttribute('iT', this.impT);
    geo.instanceCount = 0;
    const atlas = renderer ? bakeAtlas(renderer, KINDS.map((k) => this.geos[k])) : null;
    const impU = {
      ...this.uniforms,
      uFade: { value: new THREE.Vector4(LOD_NEAR, LOD_FAR, RADIUS * 0.85, RADIUS) },
      uKinds: { value: atlas?.kinds ?? KINDS.map((_, i) => new THREE.Vector4(2, 6, 0, i)) },
      uAtlasC: { value: atlas?.color ?? null },
      uAtlasN: { value: atlas?.normal ?? null },
    };
    const impMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    impMat.envMapIntensity = 0.7;
    impMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, impU);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${IMP_VERT_PARS}`)
        .replace('#include <begin_vertex>', IMP_VERT_BEGIN)
        // World-space positions already: no instance / model transform
        .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${IMP_FRAG_PARS}`)
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          vec4 atl = texture2D(uAtlasC, vAtlas);
          if (atl.a < 0.5 || lodDither() >= vLod) discard;
          vec3 alb = atl.rgb / atl.a;
          diffuseColor.rgb = alb * alb * vTint;`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `
          vec4 an = texture2D(uAtlasN, vAtlas);
          vec3 nl = an.xyz / max(an.a, 1e-3) * 2.0 - 1.0;
          vec3 nw = normalize(vRight * nl.x + vUpW * nl.y + vFwd * nl.z);
          vec3 normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
          float faceDirection = 1.0;`,
        )
        .replace('#include <normal_fragment_maps>', '')
        .replace('#include <aomap_fragment>', SHADE_GLSL)
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, cameraPosition, vInstWorld);');
    };
    impMat.customProgramCacheKey = () => 'vegetation-impostor';
    this.imp = new THREE.Mesh(geo, impMat);
    this.imp.frustumCulled = false;
    // Always ≥ 330 m out: the suit's shadow box never reaches them
    this.imp.receiveShadow = false;
    this.imp.matrixAutoUpdate = false;
    this.imp.visible = !!atlas;
    this.group.add(this.imp);
    this.group.name = 'vegetation';
  }

  /** Everything planted in one cell, computed once and cached. */
  private cell(cx: number, cz: number): CellData {
    const key = `${cx},${cz}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const lists: Record<Kind, number[]> = { bush: [], oak: [], pine: [], palm: [] };
    const imp: number[] = [];
    let minY = Infinity;
    let maxY = -Infinity;
    const rnd = seeded(cx, cz);
    const F = this.field;
    const S = THREE.MathUtils.smoothstep;
    const KI: Record<Kind, number> = { bush: 0, oak: 1, pine: 2, palm: 3 };
    const plant = (kind: Kind, x: number, z: number, h: number, k: number, tint: readonly number[], tilt: boolean) => {
      _s.set(k * (0.85 + rnd() * 0.3), k * (0.8 + rnd() * 0.4), k * (0.85 + rnd() * 0.3));
      _q.setFromAxisAngle(UP, rnd() * Math.PI * 2);
      // Shrubs lean with the slope; trees grow straight up
      if (tilt) _q.premultiply(_tilt.setFromUnitVectors(UP, _n));
      const y = h - 0.25 * k;
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      const v = 0.82 + rnd() * 0.36;
      const r = tint[0] * v;
      const g = tint[1] * v * (0.95 + rnd() * 0.1);
      const b = tint[2] * v;
      const out = lists[kind];
      for (let i = 0; i < 16; i++) out.push(_m.elements[i]);
      out.push(r, g, b);
      imp.push(x, y, z, _s.y, (_s.x + _s.z) / 2, KI[kind], r, g, b);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 14 * k);
    };
    const homeD = (x: number, z: number) => Math.hypot(x - HOME.x, z - HOME.y);
    for (let i = 0; i < 120; i++) {
      const x = (cx + rnd()) * CELL;
      const z = (cz + rnd()) * CELL;
      const r = rnd();
      const h = F.heightAt(x, z);
      if (h < 2.5 || h > 1500) continue;
      if (homeD(x, z) < 90) continue;
      F.normalAt(x, z, _n);
      const slope = 1 - _n.y;
      if (slope > 0.42) continue;
      // The terrain shader's cover map, on the CPU
      const m2 = F.toneAt(x + 517, z + 517, 1130);
      const m3 = F.toneAt(x - 211, z - 211, 430);
      const mid = F.toneAt(x, z, 160);
      const scrub = S(m2 * 0.5 + m3 * 0.35 + mid * 0.15 + slope * 0.35, 0.5, 0.66);
      const ao = F.aoAt(x, z);
      const oakK = (1 - S(ao, 0.52, 0.82)) * (1 - S(slope, 0.16, 0.38)) * (0.45 + 0.55 * m3);
      const high = S(h, 600, 1000);
      // Sun-facing (south, toward the sea) slopes are the dry ones: sage, not chaparral
      const dry = S(_n.z * 3 + (mid - 0.5), 0.05, 0.6) * (1 - oakK);
      // Palms: low, gentle ground along the bluffs and beaches
      // in groves (planted round the beach houses and along the coast road)
      const coastal =
        (1 - S(h, 30, 95)) * (1 - S(slope, 0.14, 0.3)) * (1 - S(Math.abs(coastZ(x) - z), 900, 1600)) * S(F.toneAt(x - 91, z + 37, 260), 0.48, 0.62);
      if (h < 4.5) {
        if (coastal > 0.3 && r < 0.03 * coastal) plant('palm', x, z, h, 0.85 + rnd() * 0.4, TINT.chaparral, false);
        continue;
      }
      if (r < coastal * 0.1) {
        plant('palm', x, z, h, 0.85 + rnd() * 0.4, TINT.chaparral, false);
      } else if (r < oakK * 0.55) {
        plant(high > 0.5 ? 'pine' : 'oak', x, z, h, 0.7 + rnd() * 0.75, TINT.chaparral, false);
      } else if (r < oakK * 0.55 + scrub * 0.6 + 0.06) {
        const sage = rnd() < dry * 0.8;
        plant('bush', x, z, h, sage ? 0.6 + rnd() * 1.0 : 0.8 + rnd() * 1.8, sage ? TINT.sage : TINT.chaparral, true);
      } else if (r > 0.985 && high < 0.5) plant('oak', x, z, h, 0.7 + rnd() * 0.75, TINT.chaparral, false);
      else if (r > 0.97 && high > 0.5) plant('pine', x, z, h, 0.7 + rnd() * 0.75, TINT.chaparral, false);
    }
    const data: CellData = {
      x: (cx + 0.5) * CELL,
      z: (cz + 0.5) * CELL,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
      near: { bush: new Float32Array(lists.bush), oak: new Float32Array(lists.oak), pine: new Float32Array(lists.pine), palm: new Float32Array(lists.palm) },
      imp: new Float32Array(imp),
      tuft: undefined,
      cx,
      cz,
    };
    this.cache.set(key, data);
    if (this.cache.size > 3000) {
      // Forget the oldest cells
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return data;
  }

  /** The dense brush of one cell (drawn only near the eye, so grown only then). */
  private tufts(c: CellData): { brush: Float32Array; grass: Float32Array } | null {
    if (c.tuft !== undefined) return c.tuft;
    const F = this.field;
    const brush: number[] = [];
    const grass: number[] = [];
    const rt = seeded(c.cx, c.cz, 7);
    for (let i = 0; i < 220; i++) {
      const x = (c.cx + rt()) * CELL;
      const z = (c.cz + rt()) * CELL;
      const h = F.heightAt(x, z);
      if (h < 4.5 || h > 1300 || Math.hypot(x - HOME.x, z - HOME.y) < 90) continue;
      F.normalAt(x, z, _n);
      const slope = 1 - _n.y;
      if (slope > 0.5 || rt() > 1 - slope * 1.2) continue;
      const isGrass = rt() < 0.65;
      const k = isGrass ? 0.7 + rt() * 0.7 : 0.4 + rt() * 0.5;
      const tint = isGrass ? (rt() < 0.7 ? TINT.chaparral : TINT.greenGrass) : rt() < 0.5 ? TINT.dryBrush : TINT.sage;
      _s.set(k * (0.85 + rt() * 0.3), k * (0.8 + rt() * 0.4), k * (0.85 + rt() * 0.3));
      _q.setFromAxisAngle(UP, rt() * Math.PI * 2).premultiply(_tilt.setFromUnitVectors(UP, _n));
      _m.compose(_p.set(x, h - (isGrass ? 0.05 : 0.25) * k, z), _q, _s);
      const v = 0.8 + rt() * 0.4;
      const out = isGrass ? grass : brush;
      for (let e = 0; e < 16; e++) out.push(_m.elements[e]);
      out.push(tint[0] * v, tint[1] * v, tint[2] * v);
    }
    c.tuft = brush.length + grass.length ? { brush: new Float32Array(brush), grass: new Float32Array(grass) } : null;
    return c.tuft;
  }

  update(camera: THREE.PerspectiveCamera | THREE.Camera, time: number): void {
    const eye = camera.position;
    this.uniforms.uTime.value = time;
    (this.uniforms.uEye.value as THREE.Vector3).copy(eye);
    const ground = Math.max(0, this.field.heightAt(eye.x, eye.z));
    const alt = eye.y - ground;
    this.group.visible = alt < RADIUS * 0.9;
    if (!this.group.visible) return;
    camera.getWorldDirection(this._dir);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 0;
    if (!this.pending && eye.distanceToSquared(this.lastEye) < REBUILD_MOVE * REBUILD_MOVE && this._dir.dot(this.lastDir) > REBUILD_TURN && fov === this.lastFov) return;
    // A jump (boot, respawn, a teleport) plants the whole ring at once:
    // no point growing it in over seconds behind a cut
    const jumped = eye.distanceToSquared(this.lastEye) > 500 * 500;
    this.lastEye.copy(eye);
    this.lastDir.copy(this._dir);
    this.lastFov = fov;
    this.rebuild(camera, jumped ? Infinity : PLANT_BUDGET_MS);
  }

  /** Visible cells into the instance lists. */
  private rebuild(camera: THREE.Camera, budgetMs: number): void {
    const t0 = performance.now();
    let pending = false;
    const eye = camera.position;
    camera.updateMatrixWorld();
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._vp);
    const planes = this.frustum.planes;
    const cx = Math.floor(eye.x / CELL);
    const cz = Math.floor(eye.z / CELL);
    const reach = Math.ceil(RADIUS / CELL);
    const nearCount: Record<Kind, number> = { bush: 0, oak: 0, pine: 0, palm: 0 };
    let impN = 0;
    let tuftN = 0;
    let grassN = 0;
    let cells = 0;
    const impA = this.impA.array as Float32Array;
    const impB = this.impB.array as Float32Array;
    const impT = this.impT.array as Float32Array;
    const half = CELL * 0.5;
    const centre = _p;
    const copyNear = (mesh: THREE.InstancedMesh, src: Float32Array, at: number, cap: number): number => {
      const n = Math.min(cap - at, src.length / NEAR_STRIDE);
      const m = mesh.instanceMatrix.array as Float32Array;
      const c = mesh.instanceColor!.array as Float32Array;
      for (let i = 0; i < n; i++) {
        const o = i * NEAR_STRIDE;
        m.set(src.subarray(o, o + 16), (at + i) * 16);
        c[(at + i) * 3] = src[o + 16];
        c[(at + i) * 3 + 1] = src[o + 17];
        c[(at + i) * 3 + 2] = src[o + 18];
      }
      return Math.max(0, n);
    };
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const x0 = (cx + i) * CELL;
        const z0 = (cz + j) * CELL;
        const dx = Math.max(x0 - eye.x, 0, eye.x - (x0 + CELL));
        const dz = Math.max(z0 - eye.z, 0, eye.z - (z0 + CELL));
        const flat2 = dx * dx + dz * dz;
        if (flat2 > RADIUS * RADIUS) continue;
        // Planting a cell costs ~1 ms: past the frame's budget, cells out
        // beyond the models' range wait for the next frame (they only grow
        // in at the far edge anyway), so a fast pass never hitches
        const ready = this.cache.get(`${cx + i},${cz + j}`);
        if (!ready && flat2 > LOD_FAR * LOD_FAR && performance.now() - t0 > budgetMs) {
          pending = true;
          continue;
        }
        const c = ready ?? this.cell(cx + i, cz + j);
        if (c.imp.length === 0 && c.tuft === null) continue;
        // Sphere round the cell, widened by a cone so small turns don't need a rebuild
        const midY = (c.minY + c.maxY) * 0.5;
        centre.set(c.x, midY, c.z);
        const dist = centre.distanceTo(eye);
        const rad = Math.hypot(half * Math.SQRT2, (c.maxY - c.minY) * 0.5) + REBUILD_MOVE + dist * CULL_MARGIN;
        let inside = true;
        for (let p = 0; p < 6; p++) {
          if (planes[p].distanceToPoint(centre) < -rad) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;
        cells++;
        const dy = Math.max(c.minY - eye.y, 0, eye.y - c.maxY);
        const dMin = Math.sqrt(flat2 + dy * dy);
        const dMax = Math.hypot(Math.max(Math.abs(c.x - eye.x) + half, 0), Math.max(Math.abs(c.z - eye.z) + half, 0), Math.max(Math.abs(c.minY - eye.y), Math.abs(c.maxY - eye.y)));
        if (dMin < LOD_FAR + REBUILD_MOVE) {
          for (const k of KINDS) nearCount[k] += copyNear(this.near[k], c.near[k], nearCount[k], CAP[k]);
        }
        if (dMax > LOD_NEAR - REBUILD_MOVE && c.imp.length) {
          const n = Math.min(IMP_CAP - impN, c.imp.length / IMP_STRIDE);
          for (let q = 0; q < n; q++) {
            const o = q * IMP_STRIDE;
            const w = impN + q;
            impA[w * 4] = c.imp[o];
            impA[w * 4 + 1] = c.imp[o + 1];
            impA[w * 4 + 2] = c.imp[o + 2];
            impA[w * 4 + 3] = c.imp[o + 3];
            impB[w * 2] = c.imp[o + 4];
            impB[w * 2 + 1] = c.imp[o + 5];
            impT[w * 3] = c.imp[o + 6];
            impT[w * 3 + 1] = c.imp[o + 7];
            impT[w * 3 + 2] = c.imp[o + 8];
          }
          impN += Math.max(0, n);
        }
        if (dMin < TUFT_R + REBUILD_MOVE) {
          const t = this.tufts(c);
          if (t) {
            tuftN += copyNear(this.tuft, t.brush, tuftN, CAP.tuft);
            grassN += copyNear(this.grass, t.grass, grassN, CAP.grass);
          }
        }
      }
    }
    const upload = (attr: THREE.BufferAttribute, n: number) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    };
    for (const k of KINDS) {
      const m = this.near[k];
      m.count = nearCount[k];
      upload(m.instanceMatrix, m.count);
      upload(m.instanceColor!, m.count);
    }
    this.tuft.count = tuftN;
    upload(this.tuft.instanceMatrix, tuftN);
    upload(this.tuft.instanceColor!, tuftN);
    this.grass.count = grassN;
    upload(this.grass.instanceMatrix, grassN);
    upload(this.grass.instanceColor!, grassN);
    this.imp.geometry.instanceCount = impN;
    upload(this.impA, impN);
    upload(this.impB, impN);
    upload(this.impT, impN);
    this.pending = pending;
    const nearN = KINDS.reduce((s, k) => s + nearCount[k], 0);
    this.stats = { cells, near: nearN, imp: impN, tuft: tuftN + grassN, rebuilds: this.stats.rebuilds + 1, buildMs: +(performance.now() - t0).toFixed(2) };
  }

  get instanceCount(): number {
    return this.stats.near + this.stats.imp + this.stats.tuft;
  }
}
