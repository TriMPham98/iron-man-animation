import * as THREE from 'three';
import { withLogDepth } from '../render/depth';
import { HEIGHT_RES, WORLD_SIZE } from './config';
import type { Heightfield } from './heightfield';
import { Cdlod, landTest } from './ocean/cdlod';
import { FOAM_LEVELS, OceanSim } from './ocean/sim';
import { seaHeightAt } from './ocean/spectrum';
import { SURFACE_FRAG, SURFACE_VERT } from './ocean/surface';

/**
 * The Pacific: a Tessendorf FFT sea (four cascades from a kilometre swell
 * down to centimetre ripples, simulated on the GPU every frame) drawn on a
 * CDLOD quadtree that reaches the horizon, with LEAN-mapped glitter, Jacobian
 * whitecaps and drifting world-space foam. The technique, shading and most of
 * the shader code are ported from web-ocean by Maksymilian Dendura
 * (https://github.com/Noniv/web-ocean, MIT — see ./ocean/LICENSE), adapted to
 * this coast: the swell lies down over the shelf and breaks into surf, the
 * sand shows through the shallows, cliffs shade the water, the sky is the
 * baked sky cube and the air the shared haze.
 */

const GRID = 32;
const CDLOD = {
  leaf: 4,
  grid: GRID,
  rangeK: 6,
  levels: 17,
  maxDist: 1200000,
  maxNodes: 3072,
  heightBound: 4,
  sideBound: 4,
};

function gridGeometry(): THREE.InstancedBufferGeometry {
  const pos = new Float32Array((GRID + 1) * (GRID + 1) * 3);
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const o = (j * (GRID + 1) + i) * 3;
      pos[o] = i;
      pos[o + 2] = j;
    }
  }
  const idx = new Uint16Array(GRID * GRID * 6);
  let k = 0;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = i + j * (GRID + 1);
      const b = a + 1;
      const c = a + GRID + 1;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = d;
      idx[k++] = a;
      idx[k++] = d;
      idx[k++] = b;
    }
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly sim: OceanSim | null;
  private readonly cdlod: Cdlod;
  private readonly nodes: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private lastTime = -1;
  private readonly eye = new THREE.Vector3();

  constructor(field: Heightfield, atmosphere: Record<string, THREE.IUniform>, renderer?: THREE.WebGLRenderer) {
    this.sim = renderer ? new OceanSim(renderer) : null;
    const sim = this.sim;
    this.cdlod = new Cdlod(CDLOD, landTest(field.texels, HEIGHT_RES, WORLD_SIZE, 7));
    this.uniforms = {
      ...field.uniforms,
      ...atmosphere,
      uTime: { value: 0 },
      uDisp: { value: sim?.disp.texture ?? null },
      uDeriv: { value: sim?.deriv.texture ?? null },
      uMom: { value: sim?.mom.texture ?? null },
      uFoamTex: { value: sim?.foamTex ?? null },
      uFoamW0: { value: sim?.foamWorld[0] ?? null },
      uFoamW1: { value: sim?.foamWorld[1] ?? null },
      uCascL: { value: sim?.cascL ?? new THREE.Vector4(1, 1, 1, 1) },
      uWind: { value: sim?.wind ?? new THREE.Vector3(1, 0, 7) },
      uFoamLevels: { value: new THREE.Vector2(FOAM_LEVELS[0], FOAM_LEVELS[1]) },
      uGrid: { value: GRID },
      uR0: { value: this.cdlod.r0 },
      uFarClamp: { value: 130000 },
      // deep body scatter (clear, faintly green coastal water), unresolved slope variance
      uWater: { value: new THREE.Vector4(0.012, 0.06, 0.075, 0.0024) },
      uSss: { value: new THREE.Vector4(0.035, 0.12, 0.085, 2.6) },
      uFoamP: { value: new THREE.Vector4(0.48, 2.5, 1.0, 0) },
      // sky reflection clamp, glitter clamp, body gain
      uTune: { value: new THREE.Vector4(8, 400, 1.6, 0) },
    };
    const mat = withLogDepth(
      new THREE.ShaderMaterial({
        vertexShader: SURFACE_VERT,
        fragmentShader: SURFACE_FRAG,
        uniforms: this.uniforms,
      }),
    );
    this.geo = gridGeometry();
    this.nodes = new THREE.InstancedBufferAttribute(this.cdlod.data, 4);
    this.nodes.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aNode', this.nodes);
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ocean';
    // Drawn after the land so most of it fails the depth test early
    this.mesh.renderOrder = 1;
    this.mesh.visible = !!sim;
  }

  /**
   * Advance the sea and pick the surface patches for this view. Pass the
   * camera (a bare eye position still advances the sea, but keeps last
   * frame's patches).
   */
  update(view: THREE.Camera | THREE.Vector3, time: number): void {
    this.uniforms.uTime.value = time;
    const cam = (view as THREE.Camera).isCamera ? (view as THREE.Camera) : null;
    if (cam) cam.getWorldPosition(this.eye);
    else this.eye.copy(view as THREE.Vector3);
    const dt = this.lastTime < 0 ? 1 / 60 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    if (this.sim) {
      this.sim.step(time, dt, this.eye);
      this.uniforms.uFoamW0.value = this.sim.foamWorld[0];
      this.uniforms.uFoamW1.value = this.sim.foamWorld[1];
    }
    if (cam) {
      const far = (cam as THREE.PerspectiveCamera).far;
      if (far) this.uniforms.uFarClamp.value = far * 0.9;
      const n = this.cdlod.select(cam);
      this.geo.instanceCount = n;
      this.nodes.clearUpdateRanges();
      this.nodes.addUpdateRange(0, n * 4);
      this.nodes.needsUpdate = true;
      this.mesh.visible = !!this.sim && n > 0;
    }
  }

  /** Patches drawn and simulation passes run last frame (diagnostics). */
  stats(): { nodes: number; simPasses: number } {
    return { nodes: this.cdlod.count, simPasses: this.sim?.passes ?? 0 };
  }

  dispose(): void {
    this.sim?.dispose();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  /** Sea surface height at a point (the swell), for spray and splashes. */
  static heightAt(x: number, z: number, time: number): number {
    return seaHeightAt(x, z, time);
  }
}
