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

  /** Glow on the single centre boot hatch (model space). */
  constructor(cx: number, cz: number, radius: number, floorY: number) {
    this.group.name = 'floor-hatches';
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.022, 96), this.material(0x6ee7ff));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), this.material(0x1a6f9a));
    for (const m of [ring, disc]) {
      m.rotation.x = -Math.PI / 2;
      m.position.set(cx, floorY, cz);
      m.renderOrder = 2;
      this.group.add(m);
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

export { SuitParticles, type BurstKind } from './particles';
