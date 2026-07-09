import * as THREE from 'three';
import { sortPiecesInWave } from './assemblyOrder';
import type { ArmorPiece, PieceWave } from './createPieces';
import { loadSuitModel, type GlowMaterial } from './loadSuitModel';

/** Mild boost so systems read as lit without blowing out bloom. */
const POWER_EMISSIVE_BOOST = 1.05;

export class Suit {
  readonly group = new THREE.Group();
  pieces: ArmorPiece[] = [];
  private finalModel: THREE.Group | null = null;
  private glowMaterials: GlowMaterial[] = [];
  private power = 0;
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

  piecesInWave(wave: PieceWave): ArmorPiece[] {
    // Mark III waves are bottom→top; within each wave still hybrid
    // (spine + proximal→distal) so arms grow shoulder→hand, legs hip→boot.
    return sortPiecesInWave(
      this.pieces.filter((p) => p.wave === wave),
      wave,
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

  /** Seamless full suit; hide grid shards so bloom can't square-blob them. */
  showFinal(): void {
    this.assemblyMode = false;
    for (const p of this.pieces) {
      p.mesh.visible = false;
    }
    if (this.finalModel) this.finalModel.visible = true;
  }

  resetToStart(): void {
    this.power = 0;
    this.setPowered(0);
    this.showAssembly();
    for (const p of this.pieces) {
      p.mesh.visible = false;
      p.mesh.position.copy(p.startPosition);
      p.mesh.rotation.copy(p.startRotation);
      p.mesh.scale.copy(p.startScale);
    }
  }

  /**
   * 0 = dark, 1 = systems online.
   * Only the seamless final mesh uses the GLB emissive map (arc reactor,
   * face-mask eye slits, hand & foot repulsors). Fly-in shards stay dark so
   * bloom never turns them into glowing squares.
   */
  setPowered(amount: number): void {
    this.power = THREE.MathUtils.clamp(amount, 0, 1);
    this.applyEmissive(1);
  }

  getPower(): number {
    return this.power;
  }

  /** Soft arc-reactor pulse after systems online. */
  updateIdle(time: number): void {
    if (this.power < 0.01) return;
    const pulse = 1 + Math.sin(time * 3.2) * 0.08;
    this.applyEmissive(pulse);
  }

  private applyEmissive(pulse: number): void {
    for (const { material, baseIntensity } of this.glowMaterials) {
      material.emissiveIntensity =
        this.power * baseIntensity * POWER_EMISSIVE_BOOST * pulse;
    }
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
