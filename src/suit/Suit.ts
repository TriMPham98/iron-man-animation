import * as THREE from 'three';
import {
  planWaveOrder,
  selectFoundation,
  type WaveOrderResult,
} from './assemblyOrder';
import type { ArmorPiece, PieceWave } from './waves';
import { loadSuitModel, type GlowMaterial } from './loadSuitModel';
import {
  applySystemUniforms,
  type SuitSystem,
  type SystemPowers,
} from './systemsGlow';

export class Suit {
  readonly group = new THREE.Group();
  pieces: ArmorPiece[] = [];
  private finalModel: THREE.Group | null = null;
  private glowMaterials: GlowMaterial[] = [];
  private powers: SystemPowers = { reactor: 0, eyes: 0, repulsors: 0 };
  private assemblyMode = true;

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
    for (const p of this.pieces) {
      p.mesh.visible = false;
    }
    if (this.finalModel) this.finalModel.visible = true;
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
