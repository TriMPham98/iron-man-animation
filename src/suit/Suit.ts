import * as THREE from 'three';
import {
  planWaveOrder,
  selectFoundation,
  type WaveOrderResult,
} from './assemblyOrder';
import { WAVE_ORDER, type ArmorPiece, type PieceWave } from './waves';
import { loadSuitModel, type GlowMaterial } from './loadSuitModel';
import {
  applySystemUniforms,
  type SuitSystem,
  type SystemPowers,
} from './systemsGlow';
import { hashSeed } from '../utils/easeHelpers';

/** Arc-reactor height after model normalize — radial explode origin. */
const EXPLODE_ORIGIN = new THREE.Vector3(0, 1.15, 0);

export class Suit {
  readonly group = new THREE.Group();
  pieces: ArmorPiece[] = [];
  private finalModel: THREE.Group | null = null;
  private glowMaterials: GlowMaterial[] = [];
  private powers: SystemPowers = { reactor: 0, eyes: 0, repulsors: 0 };
  private assemblyMode = true;
  private readonly _explodeEnd = new THREE.Vector3();
  private readonly _explodeDir = new THREE.Vector3();
  private readonly _explodeRadial = new THREE.Vector3();
  /**
   * Precomputed explode targets/seeds for the soft-restart burst.
   * Built once in {@link armExplosionFromFinal} so the 3s handoff is not
   * re-hashing ids and re-deriving endpoints every frame.
   */
  private explodeCache: Array<{
    seed: number;
    delay: number;
    span: number;
    end: THREE.Vector3;
    spinSign: number;
    spinY: number;
    spinAmp: number;
  }> | null = null;

  private constructor() {
    this.group.name = 'suit';
  }

  static async create(onProgress?: (r: number) => void): Promise<Suit> {
    const suit = new Suit();
    const loaded = await loadSuitModel(onProgress);
    suit.group.add(loaded.group);
    suit.pieces = loaded.pieces;
    suit.finalModel = loaded.finalModel;
    suit.glowMaterials = loaded.glowMaterials;

    // Slight heroic lean
    suit.group.rotation.x = -0.03;
    return suit;
  }

  /**
   * Pieces in a wave, ordered to attach onto existing structure.
   * Pass `built` (all earlier waves) — foundation stumps are selected
   * per-wave so arms seed from shoulders, helmet from collar, etc.
   */
  piecesInWave(
    wave: PieceWave,
    built: ArmorPiece[] = [],
  ): ArmorPiece[] {
    return this.planWave(wave, built).ordered;
  }

  /**
   * Ordered pieces + seed count for lock-gated launch scheduling.
   */
  planWave(wave: PieceWave, built: ArmorPiece[] = []): WaveOrderResult {
    const foundation = selectFoundation(wave, built);
    return planWaveOrder(
      this.pieces.filter((p) => p.wave === wave),
      wave,
      foundation,
    );
  }

  /** Fly-in shards visible; seamless mesh hidden. */
  showAssembly(): void {
    this.assemblyMode = true;
    this.explodeCache = null;
    if (this.finalModel) this.finalModel.visible = false;
    for (const p of this.pieces) {
      p.mesh.visible = false;
    }
  }

  /**
   * Hide seamless mesh for timeline scrubbing without forcing every shard
   * invisible — GSAP owns piece visibility after a re-applied progress.
   */
  resumeAssemblyVisuals(): void {
    this.assemblyMode = true;
    if (this.finalModel) this.finalModel.visible = false;
  }

  /** Seamless full suit; hide grid shards so bloom can't square-blob them. */
  showFinal(): void {
    this.assemblyMode = false;
    this.explodeCache = null;
    for (const p of this.pieces) {
      p.mesh.visible = false;
    }
    if (this.finalModel) {
      this.finalModel.visible = true;
      this.finalModel.scale.set(1, 1, 1);
      this.finalModel.position.set(0, 0, 0);
    }
  }

  /**
   * Swap seamless mesh → all plates seated at rest, ready for a reverse
   * explode (post-showcase soft restart). Systems stay lit for the burst.
   */
  armExplosionFromFinal(): void {
    this.assemblyMode = true;
    if (this.finalModel) {
      this.finalModel.visible = false;
      this.finalModel.scale.set(1, 1, 1);
      this.finalModel.position.set(0, 0, 0);
    }

    const waveCount = WAVE_ORDER.length;
    this.explodeCache = new Array(this.pieces.length);

    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      p.mesh.visible = true;
      p.mesh.position.copy(p.restPosition);
      p.mesh.rotation.copy(p.restRotation);
      p.mesh.scale.copy(p.restScale);

      const seed = hashSeed(p.id);
      const wi = WAVE_ORDER.indexOf(p.wave);
      // Helmet / face peel first; boots last — reverse of suit-up cascade
      const waveRank =
        wi < 0 ? 0.5 : (waveCount - 1 - wi) / Math.max(1, waveCount - 1);
      const delay = waveRank * 0.12 + seed * 0.05;
      const end = new THREE.Vector3();
      this.explodeTargetFor(p, seed, end);
      this.explodeCache[i] = {
        seed,
        delay,
        span: Math.max(1e-3, 1 - delay),
        end,
        spinSign: seed > 0.5 ? 1 : -1,
        spinY: 1.3 * (seed - 0.5),
        spinAmp: 0.9 + seed * 1.4,
      };
    }
    this.powers = { reactor: 1, eyes: 1, repulsors: 1 };
    this.applySystems();
  }

  /**
   * Drive the reverse-burst: 0 = fully assembled plates, 1 = blown clear.
   * Uses {@link explodeCache} from {@link armExplosionFromFinal} when present.
   */
  setExplosionProgress(amount: number): void {
    const u = THREE.MathUtils.clamp(amount, 0, 1);
    const cache = this.explodeCache;
    const n = this.pieces.length;

    for (let i = 0; i < n; i++) {
      const p = this.pieces[i];
      let delay: number;
      let span: number;
      let end: THREE.Vector3;
      let spinSign: number;
      let spinY: number;
      let spinAmp: number;

      if (cache && cache[i]) {
        const c = cache[i];
        delay = c.delay;
        span = c.span;
        end = c.end;
        spinSign = c.spinSign;
        spinY = c.spinY;
        spinAmp = c.spinAmp;
      } else {
        // Fallback (shouldn't run on the soft-restart path)
        const seed = hashSeed(p.id);
        const wi = WAVE_ORDER.indexOf(p.wave);
        const waveRank =
          wi < 0 ? 0.5 : (WAVE_ORDER.length - 1 - wi) / Math.max(1, WAVE_ORDER.length - 1);
        delay = waveRank * 0.12 + seed * 0.05;
        span = Math.max(1e-3, 1 - delay);
        this.explodeTargetFor(p, seed, this._explodeEnd);
        end = this._explodeEnd;
        spinSign = seed > 0.5 ? 1 : -1;
        spinY = 1.3 * (seed - 0.5);
        spinAmp = 0.9 + seed * 1.4;
      }

      const local = THREE.MathUtils.clamp((u - delay) / span, 0, 1);
      // Mild ease-out only (heavy cubic + master ease-out cleared the pad early)
      const e = 1 - (1 - local) * (1 - local);

      p.mesh.position.lerpVectors(p.restPosition, end, e);

      const sx = THREE.MathUtils.lerp(p.restScale.x, 0.04, e);
      const sy = THREE.MathUtils.lerp(p.restScale.y, 0.04, e);
      const sz = THREE.MathUtils.lerp(p.restScale.z, 0.04, e);
      p.mesh.scale.set(sx, sy, sz);

      const spin = e * spinAmp;
      p.mesh.rotation.set(
        p.restRotation.x + spin * spinSign,
        p.restRotation.y + spin * spinY,
        p.restRotation.z + spin * 0.7,
      );

      p.mesh.visible = e < 0.97;
    }

    // Systems blackout early in the burst
    const glow = THREE.MathUtils.clamp(1 - u * 1.55, 0, 1);
    this.powers = { reactor: glow, eyes: glow, repulsors: glow };
    this.applySystems();
  }

  /** World-ish local target past the assembly scatter start + radial kick. */
  private explodeTargetFor(
    p: ArmorPiece,
    seed: number,
    out: THREE.Vector3,
  ): void {
    // Primary: reverse assembly vector (rest → scatter start), overshoot
    this._explodeDir.subVectors(p.startPosition, p.restPosition);
    if (this._explodeDir.lengthSq() < 0.04) {
      // Degenerate start: pure radial from chest
      this._explodeDir.subVectors(p.restPosition, EXPLODE_ORIGIN);
      if (this._explodeDir.lengthSq() < 1e-6) {
        this._explodeDir.set(seed - 0.5, 0.4, 0.8);
      }
      this._explodeDir.normalize().multiplyScalar(3.2 + seed * 1.4);
    } else {
      // Past the hangar scatter, with extra throw
      this._explodeDir.multiplyScalar(1.75 + seed * 0.55);
      // Radial boost so limbs don't just reverse on rails
      this._explodeRadial
        .subVectors(p.restPosition, EXPLODE_ORIGIN)
        .normalize()
        .multiplyScalar(0.85 + seed * 0.6);
      this._explodeDir.add(this._explodeRadial);
    }
    // Upward kick — explosion reads better than pure reverse-fly
    this._explodeDir.y += 0.55 + seed * 0.9;
    out.copy(p.restPosition).add(this._explodeDir);
  }

  resetToStart(): void {
    this.powers = { reactor: 0, eyes: 0, repulsors: 0 };
    this.applySystems();
    this.showAssembly();
    for (const p of this.pieces) {
      p.mesh.visible = false;
      p.mesh.position.copy(p.startPosition);
      p.mesh.rotation.copy(p.startRotation);
      p.mesh.scale.copy(p.startScale);
    }
  }

  /** Set one system 0–1 (reactor / eyes / repulsors). */
  setSystemPower(system: SuitSystem, amount: number): void {
    this.powers[system] = THREE.MathUtils.clamp(amount, 0, 1);
    this.applySystems();
  }

  /** Set all systems at once (suit emissive only — scene lights unchanged). */
  setSystemsPower(powers: Partial<SystemPowers>): void {
    if (powers.reactor !== undefined) {
      this.powers.reactor = THREE.MathUtils.clamp(powers.reactor, 0, 1);
    }
    if (powers.eyes !== undefined) {
      this.powers.eyes = THREE.MathUtils.clamp(powers.eyes, 0, 1);
    }
    if (powers.repulsors !== undefined) {
      this.powers.repulsors = THREE.MathUtils.clamp(powers.repulsors, 0, 1);
    }
    this.applySystems();
  }

  /**
   * @deprecated Prefer setSystemPower / setSystemsPower for sequenced ignition.
   */
  setPowered(amount: number): void {
    const a = THREE.MathUtils.clamp(amount, 0, 1);
    this.powers = { reactor: a, eyes: a, repulsors: a };
    this.applySystems();
  }

  getSystemPowers(): SystemPowers {
    return { ...this.powers };
  }

  getPower(): number {
    return Math.max(this.powers.reactor, this.powers.eyes, this.powers.repulsors);
  }

  /** No-op — systems hold steady once online (no idle flicker). */
  updateIdle(_time: number): void {}

  private applySystems(): void {
    applySystemUniforms(this.glowMaterials, this.powers, 1);
  }

  isAssemblyMode(): boolean {
    return this.assemblyMode;
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        for (const m of mats) m?.dispose?.();
      }
    });
  }
}
