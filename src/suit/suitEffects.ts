import * as THREE from 'three';
import { BONE_SPECS, type BoneName, type Vec3 } from './rig';
import type { SuitRig } from './rigPose';

/**
 * JARVIS fitting hologram: the full suit rendered as a cyan scan-line ghost,
 * skinned to the rig so it raises its arms with the skeleton. Pieces clamp on
 * over it; the surface is pulled ~4 mm inward so seated armor always wins
 * the depth test (no z-fighting once a plate is home).
 */
export function createHologramMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'suit-hologram',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0x5ad8ff) },
      uOpacity: { value: 0 },
      /** Bind-space height of the materialize front (feet → head). */
      uReveal: { value: 0 },
      uTime: { value: 0 },
      uShrink: { value: 0.004 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      uniform float uShrink;
      varying vec3 vViewNormal;
      varying vec3 vViewDir;
      varying float vBindY;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        // normalize(0) is NaN. A NaN position or varying on this GPU
        // rasterizes as a screen-sized black rectangle, so a zero-length
        // skinned normal must not be divided.
        float shrinkLen = length(objectNormal);
        if (shrinkLen > 1e-5) transformed -= objectNormal * (uShrink / shrinkLen);
        vBindY = position.y;
        #include <project_vertex>
        vViewNormal = vec3(0.0, 0.0, 1.0);
        float nLen = length(transformedNormal);
        if (nLen > 1e-5) vViewNormal = transformedNormal / nLen;
        vViewDir = vec3(0.0, 0.0, 1.0);
        float vLen = length(mvPosition.xyz);
        if (vLen > 1e-5) vViewDir = -mvPosition.xyz / vLen;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uReveal;
      uniform float uTime;
      varying vec3 vViewNormal;
      varying vec3 vViewDir;
      varying float vBindY;
      void main() {
        if (vBindY > uReveal) discard;
        float facing = abs(dot(vViewNormal, vViewDir));
        float rim = pow(1.0 - facing, 2.2);
        float lines = step(0.55, fract(vBindY * 120.0 - uTime * 0.9));
        float front = smoothstep(0.07, 0.0, uReveal - vBindY);
        float a = (0.035 + rim * 0.55) * (0.55 + 0.45 * lines) + front * 0.9;
        vec3 col = uColor * (0.55 + rim * 1.2 + front * 2.2);
        gl_FragColor = vec4(col, a * uOpacity);
      }
    `,
  });
}

/**
 * Bone-and-joint overlay — the rig itself drawn as a cyan armature during
 * the fitting (bones as lines, joints as points). Depth-tested so it sinks
 * out of view as armor clamps over each limb.
 */
export class RigOverlay {
  readonly group = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly joints: THREE.Points;
  private readonly linePos: Float32Array;
  private readonly jointPos: Float32Array;
  private readonly segments: Array<[BoneName, BoneName | Vec3]>;
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly jointMat: THREE.PointsMaterial;
  private readonly _v = new THREE.Vector3();
  private readonly _inv = new THREE.Matrix4();
  private readonly _m = new THREE.Matrix4();

  constructor(private readonly rig: SuitRig) {
    this.group.name = 'rig-overlay';
    // Bone segments: parent joint → child joint; leaf bones → their tail
    this.segments = [];
    for (const spec of BONE_SPECS) {
      if (!spec.deform) continue;
      if (spec.parent && spec.parent !== 'root') {
        this.segments.push([spec.parent, spec.name]);
      }
      const hasChild = BONE_SPECS.some((s) => s.parent === spec.name);
      if (!hasChild) this.segments.push([spec.name, spec.tail]);
    }
    this.linePos = new Float32Array(this.segments.length * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lineMat = new THREE.LineBasicMaterial({
      color: 0x7ee8ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.LineSegments(lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    const jointCount = BONE_SPECS.filter((s) => s.deform).length;
    this.jointPos = new Float32Array(jointCount * 3);
    const jointGeo = new THREE.BufferGeometry();
    jointGeo.setAttribute('position', new THREE.BufferAttribute(this.jointPos, 3));
    this.jointMat = new THREE.PointsMaterial({
      color: 0xd8fbff,
      size: 0.022,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.joints = new THREE.Points(jointGeo, this.jointMat);
    this.joints.frustumCulled = false;
    this.group.add(this.joints);
    this.group.visible = false;
  }

  /** Re-sample bone positions (group-local) and set opacity. */
  update(opacity: number): void {
    this.group.visible = opacity > 0.003;
    if (!this.group.visible) return;
    this.lineMat.opacity = opacity * 0.85;
    this.jointMat.opacity = opacity;
    const parent = this.group.parent;
    this._inv.copy(parent ? parent.matrixWorld : this._m.identity()).invert();

    const jointAt = (name: BoneName, out: THREE.Vector3) =>
      out
        .setFromMatrixPosition(this.rig.bones[name].matrixWorld)
        .applyMatrix4(this._inv);

    let o = 0;
    for (const [a, b] of this.segments) {
      jointAt(a, this._v);
      this.linePos[o++] = this._v.x;
      this.linePos[o++] = this._v.y;
      this.linePos[o++] = this._v.z;
      if (typeof b === 'string') {
        jointAt(b, this._v);
      } else {
        // Leaf tail: carry the bind offset through the bone's rotation
        const spec = BONE_SPECS.find((s) => s.name === a)!;
        this._v
          .set(b[0] - spec.head[0], b[1] - spec.head[1], b[2] - spec.head[2])
          .applyMatrix4(this.rig.bones[a].matrixWorld)
          .applyMatrix4(this._inv);
      }
      this.linePos[o++] = this._v.x;
      this.linePos[o++] = this._v.y;
      this.linePos[o++] = this._v.z;
    }
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    let j = 0;
    for (const spec of BONE_SPECS) {
      if (!spec.deform) continue;
      jointAt(spec.name, this._v);
      this.jointPos[j++] = this._v.x;
      this.jointPos[j++] = this._v.y;
      this.jointPos[j++] = this._v.z;
    }
    (this.joints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.joints.geometry.dispose();
    this.lineMat.dispose();
    this.jointMat.dispose();
  }
}

/**
 * Floor hatches under each boot — the boots rise through these. Ring + soft
 * disc, additive cyan, driven 0–1 by the choreography.
 */
export class FloorHatches {
  readonly group = new THREE.Group();
  private readonly mats: THREE.MeshBasicMaterial[] = [];

  constructor(footXs: readonly number[], footZ: number, floorY: number) {
    this.group.name = 'floor-hatches';
    for (const x of footXs) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.13, 0.155, 48),
        this.material(0x6ee7ff),
      );
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.13, 48),
        this.material(0x1a6f9a),
      );
      for (const m of [ring, disc]) {
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, floorY, footZ);
        m.renderOrder = 2;
        this.group.add(m);
      }
    }
    this.group.visible = false;
  }

  private material(color: number): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mats.push(m);
    return m;
  }

  setOpen(amount: number): void {
    const a = THREE.MathUtils.clamp(amount, 0, 1);
    this.group.visible = a > 0.003;
    this.mats.forEach((m, i) => {
      m.opacity = a * (i % 2 === 0 ? 0.95 : 0.55);
    });
  }

  dispose(): void {
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const m of this.mats) m.dispose();
  }
}

export type BurstKind = 'sparks' | 'steam';

interface ParticlePool {
  points: THREE.Points;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  next: number;
}

const PARTICLE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Tiny CPU particle system for bolt-driver sparks and pressure-vent steam.
 * Bursts are fired from timeline calls on the matching SFX transients.
 */
export class SuitParticles {
  readonly group = new THREE.Group();
  private readonly pools: Record<BurstKind, ParticlePool>;
  private readonly _v = new THREE.Vector3();

  constructor() {
    this.group.name = 'suit-particles';
    this.pools = {
      sparks: this.makePool(
        420,
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: { uScale: { value: 1400 } },
          vertexShader: PARTICLE_VERT,
          fragmentShader: /* glsl */ `
            varying float vAlpha;
            void main() {
              vec2 d = gl_PointCoord - 0.5;
              float r = length(d);
              if (r > 0.5) discard;
              float core = smoothstep(0.5, 0.0, r);
              vec3 hot = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.95, 0.8), core);
              gl_FragColor = vec4(hot * (0.6 + core), core * vAlpha);
            }
          `,
        }),
      ),
      steam: this.makePool(
        220,
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          uniforms: { uScale: { value: 1400 } },
          vertexShader: PARTICLE_VERT,
          fragmentShader: /* glsl */ `
            varying float vAlpha;
            void main() {
              float r = length(gl_PointCoord - 0.5);
              if (r > 0.5) discard;
              float soft = smoothstep(0.5, 0.0, r);
              gl_FragColor = vec4(vec3(0.82, 0.9, 1.0), soft * soft * vAlpha * 0.5);
            }
          `,
        }),
      ),
    };
  }

  private makePool(n: number, mat: THREE.ShaderMaterial): ParticlePool {
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const alpha = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 5;
    this.group.add(points);
    return {
      points,
      pos,
      vel: new Float32Array(n * 3),
      life: new Float32Array(n),
      maxLife: new Float32Array(n),
      size,
      alpha,
      next: 0,
    };
  }

  /**
   * Fire a burst at a group-local point. `dir` biases the spray (e.g. the
   * outward normal of the bolt being driven).
   */
  burst(kind: BurstKind, at: THREE.Vector3, count: number, dir?: THREE.Vector3): void {
    const pool = this.pools[kind];
    const n = pool.life.length;
    for (let i = 0; i < count; i++) {
      const k = pool.next;
      pool.next = (pool.next + 1) % n;
      pool.pos[k * 3] = at.x;
      pool.pos[k * 3 + 1] = at.y;
      pool.pos[k * 3 + 2] = at.z;
      this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      this._v.normalize();
      if (kind === 'sparks') {
        if (dir) this._v.addScaledVector(dir, 1.1).normalize();
        const speed = 0.6 + Math.random() * 1.1;
        this._v.multiplyScalar(speed);
        this._v.y += 0.6;
        pool.maxLife[k] = 0.25 + Math.random() * 0.4;
        pool.size[k] = 0.012 + Math.random() * 0.012;
      } else {
        if (dir) this._v.addScaledVector(dir, 1.6).normalize();
        this._v.multiplyScalar(0.25 + Math.random() * 0.45);
        this._v.y += 0.12;
        pool.maxLife[k] = 0.7 + Math.random() * 0.7;
        pool.size[k] = 0.035 + Math.random() * 0.035;
      }
      pool.vel[k * 3] = this._v.x;
      pool.vel[k * 3 + 1] = this._v.y;
      pool.vel[k * 3 + 2] = this._v.z;
      pool.life[k] = pool.maxLife[k];
    }
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (const kind of ['sparks', 'steam'] as const) {
      const p = this.pools[kind];
      const n = p.life.length;
      const gravity = kind === 'sparks' ? -5.5 : 0.18;
      const drag = kind === 'sparks' ? 0.985 : 0.94;
      let any = false;
      for (let i = 0; i < n; i++) {
        if (p.life[i] <= 0) {
          p.alpha[i] = 0;
          continue;
        }
        any = true;
        p.life[i] -= step;
        const u = Math.max(0, p.life[i] / p.maxLife[i]);
        p.vel[i * 3] *= drag;
        p.vel[i * 3 + 1] = p.vel[i * 3 + 1] * drag + gravity * step;
        p.vel[i * 3 + 2] *= drag;
        p.pos[i * 3] += p.vel[i * 3] * step;
        p.pos[i * 3 + 1] += p.vel[i * 3 + 1] * step;
        p.pos[i * 3 + 2] += p.vel[i * 3 + 2] * step;
        if (kind === 'steam') {
          p.size[i] += step * 0.12;
          p.alpha[i] = Math.sin(u * Math.PI) * 0.9;
        } else {
          p.alpha[i] = u;
        }
      }
      p.points.visible = any;
      const geo = p.points.geometry;
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear(): void {
    for (const kind of ['sparks', 'steam'] as const) {
      const p = this.pools[kind];
      p.life.fill(0);
      p.alpha.fill(0);
      p.points.visible = false;
    }
  }

  /**
   * World-size → pixel scale: drawing-buffer height / (2·tan(fov/2)).
   * Keeps spark size physical across resolutions and lens changes.
   */
  setProjectionScale(scale: number): void {
    for (const kind of ['sparks', 'steam'] as const) {
      (this.pools[kind].points.material as THREE.ShaderMaterial).uniforms.uScale.value =
        scale;
    }
  }

  dispose(): void {
    for (const kind of ['sparks', 'steam'] as const) {
      this.pools[kind].points.geometry.dispose();
      (this.pools[kind].points.material as THREE.Material).dispose();
    }
  }
}
