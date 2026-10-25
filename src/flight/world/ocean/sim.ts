/**
 * Runs the FFT ocean on the GPU each frame (WebGL2 render-to-texture).
 *
 * Ported from web-ocean (https://github.com/Noniv/web-ocean, js/main.js
 * encodeSim / foam clipmaps), MIT License, Copyright (c) 2026 Maksymilian
 * Dendura. See ./LICENSE.
 *
 * Per frame: 1 evolve + 2·log2(N) FFT stages over an atlas holding every
 * cascade, 3 assemble passes per cascade into mip-mapped texture arrays
 * (displacement, derivatives, slope moments), and one update per foam
 * clipmap level.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ASSEMBLE_FRAG, EVOLVE_FRAG, FFT_FRAG, FOAM_STAMPS, FOAM_TEX_FRAG, FOAM_UPDATE_FRAG, FSQ_VERT } from './simShaders';
import { buildH0, CASCADE_L, CASCADES, dominantModes, LOG_N, LOOP, N, SEA, setModes } from './spectrum';

/** Foam clipmaps: texels per side and world span of each level (m). */
export const FOAM_RES = 512;
export const FOAM_LEVELS = [128, 1024] as const;

const raw = (frag: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial =>
  new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FSQ_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });

function arrayTarget(): THREE.WebGLArrayRenderTarget {
  const rt = new THREE.WebGLArrayRenderTarget(N, N, CASCADES, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
  });
  const t = rt.texture;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  return rt;
}

export class OceanSim {
  readonly disp: THREE.WebGLArrayRenderTarget;
  readonly deriv: THREE.WebGLArrayRenderTarget;
  readonly mom: THREE.WebGLArrayRenderTarget;
  readonly foamTex: THREE.Texture;
  /** Current foam clipmap texture per level. */
  readonly foamWorld: THREE.Texture[] = [];
  readonly cascL = new THREE.Vector4(...CASCADE_L);
  /** Wind direction (unit, xz) and speed. */
  readonly wind = new THREE.Vector3(Math.cos((SEA.windDir * Math.PI) / 180), Math.sin((SEA.windDir * Math.PI) / 180), SEA.windSpeed);
  /** GPU passes issued last step. */
  passes = 0;

  private readonly h0: THREE.DataTexture;
  private readonly ping: THREE.WebGLRenderTarget;
  private readonly pong: THREE.WebGLRenderTarget;
  private readonly quad: FullScreenQuad;
  private readonly evolve: THREE.RawShaderMaterial;
  private readonly fft: THREE.RawShaderMaterial;
  private readonly assemble: THREE.RawShaderMaterial;
  private readonly foamUpd: THREE.RawShaderMaterial;
  private readonly foamRt: THREE.WebGLRenderTarget[][];
  private foamCur = 0;
  private readonly foamSnap = [0, 0, 0, 0];
  private foamFirst = true;
  private foamTexRt: THREE.WebGLRenderTarget | null;
  private readonly stampA = Array.from({ length: FOAM_STAMPS }, () => new THREE.Vector4());
  private readonly stampB = Array.from({ length: FOAM_STAMPS }, () => new THREE.Vector4());
  private stamps = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const h0 = buildH0();
    setModes(dominantModes(h0));
    this.h0 = new THREE.DataTexture(h0, N, N * CASCADES, THREE.RGBAFormat, THREE.FloatType);
    this.h0.minFilter = this.h0.magFilter = THREE.NearestFilter;
    this.h0.needsUpdate = true;

    const atlas = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(N, N * CASCADES, {
        count: 2,
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
    this.ping = atlas();
    this.pong = atlas();
    this.disp = arrayTarget();
    this.deriv = arrayTarget();
    this.mom = arrayTarget();

    this.evolve = raw(EVOLVE_FRAG, {
      uH0: { value: this.h0 },
      uL: { value: this.cascL },
      uTime: { value: 0 },
      uLoop: { value: LOOP },
      uChoppy: { value: SEA.choppy },
    });
    this.fft = raw(FFT_FRAG, { uA: { value: null }, uB: { value: null }, uSize: { value: 2 }, uHoriz: { value: 1 } });
    this.assemble = raw(ASSEMBLE_FRAG, { uA: { value: null }, uB: { value: null }, uCascade: { value: 0 }, uMode: { value: 0 } });
    this.foamUpd = raw(FOAM_UPDATE_FRAG, {
      uPrev: { value: null },
      uDisp: { value: this.disp.texture },
      uDeriv: { value: this.deriv.texture },
      uSnap: { value: [0, 0, 0, 0] },
      uRes: { value: FOAM_RES },
      uTexel: { value: 1 },
      uDt: { value: 0 },
      uDecay: { value: 0.22 },
      uInject: { value: new THREE.Vector3(0.68, 2.0, 1.0) },
      uDrift: { value: new THREE.Vector2(this.wind.x, this.wind.y).multiplyScalar(0.03 * SEA.windSpeed) },
      uCascL: { value: this.cascL },
      uFirst: { value: 1 },
      uStampA: { value: this.stampA },
      uStampB: { value: this.stampB },
      uStamps: { value: 0 },
    });
    this.quad = new FullScreenQuad(this.evolve);

    this.foamRt = FOAM_LEVELS.map(() =>
      [0, 1].map(() => {
        const rt = new THREE.WebGLRenderTarget(FOAM_RES, FOAM_RES, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          depthBuffer: false,
          minFilter: THREE.LinearMipmapLinearFilter,
          magFilter: THREE.LinearFilter,
          generateMipmaps: true,
          wrapS: THREE.RepeatWrapping,
          wrapT: THREE.RepeatWrapping,
        });
        return rt;
      }),
    );
    for (let l = 0; l < FOAM_LEVELS.length; l++) this.foamWorld.push(this.foamRt[l][0].texture);

    // Foam micro-structure, generated once
    this.foamTexRt = new THREE.WebGLRenderTarget(512, 512, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      anisotropy: 8,
    });
    this.foamTex = this.foamTexRt.texture;
    const foamGen = raw(FOAM_TEX_FRAG, {});
    this.pass(foamGen, this.foamTexRt);
    foamGen.dispose();
  }

  /**
   * Churn the water white for the next step: a disc of `radius` swept from
   * (ax, az) to (bx, bz), or with `inner` set a ring. `amount` 0–1.5 (1 is
   * fresh, dense foam). Past {@link FOAM_STAMPS} a step, the faintest goes.
   */
  stamp(ax: number, az: number, bx: number, bz: number, radius: number, amount: number, inner = 0): void {
    let i = this.stamps;
    if (i >= FOAM_STAMPS) {
      i = 0;
      for (let j = 1; j < FOAM_STAMPS; j++) if (this.stampB[j].z < this.stampB[i].z) i = j;
      if (this.stampB[i].z >= amount) return;
    } else this.stamps++;
    this.stampA[i].set(ax, az, bx, bz);
    this.stampB[i].set(radius, inner, amount, 0);
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null, layer = 0): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target, layer);
    this.quad.render(this.renderer);
    this.passes++;
  }

  /** Advance the sea to `time` and refresh the foam around the eye. */
  step(time: number, dt: number, eye: THREE.Vector3): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.autoClear;
    r.autoClear = false;
    this.passes = 0;

    const t = ((time % LOOP) + LOOP) % LOOP;
    this.evolve.uniforms.uTime.value = t;
    this.pass(this.evolve, this.ping);
    let src = this.ping;
    let dst = this.pong;
    const u = this.fft.uniforms;
    for (const horiz of [1, 0]) {
      u.uHoriz.value = horiz;
      for (let s = 1; s <= LOG_N; s++) {
        u.uSize.value = 1 << s;
        u.uA.value = src.textures[0];
        u.uB.value = src.textures[1];
        this.pass(this.fft, dst);
        [src, dst] = [dst, src];
      }
    }
    const a = this.assemble.uniforms;
    a.uA.value = src.textures[0];
    a.uB.value = src.textures[1];
    const outs = [this.disp, this.deriv, this.mom];
    for (let m = 0; m < 3; m++) {
      a.uMode.value = m;
      const tex = outs[m].texture;
      for (let c = 0; c < CASCADES; c++) {
        a.uCascade.value = c;
        // mips once, after the last layer
        tex.generateMipmaps = c === CASCADES - 1;
        this.pass(this.assemble, outs[m], c);
      }
    }

    // Foam clipmaps (ping-pong)
    const f = this.foamUpd.uniforms;
    const next = 1 - this.foamCur;
    f.uDt.value = Math.min(dt, 0.1);
    f.uFirst.value = this.foamFirst ? 1 : 0;
    f.uStamps.value = this.stamps;
    for (let l = 0; l < FOAM_LEVELS.length; l++) {
      const ts = FOAM_LEVELS[l] / FOAM_RES;
      const cx = Math.floor(eye.x / ts);
      const cz = Math.floor(eye.z / ts);
      // Teleports (more than half a window): start fresh
      const jump = Math.abs(cx - this.foamSnap[l * 2]) > FOAM_RES / 2 || Math.abs(cz - this.foamSnap[l * 2 + 1]) > FOAM_RES / 2;
      f.uSnap.value = [cx, cz, this.foamSnap[l * 2], this.foamSnap[l * 2 + 1]];
      f.uFirst.value = this.foamFirst || jump ? 1 : 0;
      this.foamSnap[l * 2] = cx;
      this.foamSnap[l * 2 + 1] = cz;
      f.uTexel.value = ts;
      f.uPrev.value = this.foamRt[l][this.foamCur].texture;
      this.pass(this.foamUpd, this.foamRt[l][next]);
      this.foamWorld[l] = this.foamRt[l][next].texture;
    }
    this.foamCur = next;
    this.foamFirst = false;
    this.stamps = 0;

    r.setRenderTarget(prevTarget);
    r.autoClear = prevClear;
  }

  dispose(): void {
    for (const rt of [this.ping, this.pong, this.disp, this.deriv, this.mom, ...this.foamRt.flat()]) rt.dispose();
    this.foamTexRt?.dispose();
    this.foamTexRt = null;
    this.h0.dispose();
    for (const m of [this.evolve, this.fft, this.assemble, this.foamUpd]) m.dispose();
    this.quad.dispose();
  }
}
