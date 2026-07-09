import * as THREE from 'three';
import type { ArmorPiece, PieceWave } from './createPieces';
import { loadSuitModel } from './loadSuitModel';

export class Suit {
  readonly group = new THREE.Group();
  pieces: ArmorPiece[] = [];
  private finalModel: THREE.Group | null = null;
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

    // Slight heroic lean
    suit.group.rotation.x = -0.03;
    return suit;
  }

  piecesInWave(wave: PieceWave): ArmorPiece[] {
    return this.pieces.filter((p) => p.wave === wave);
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
   * Power-up uses reactor light only (see timeline) — no full-body emissive.
   * Full-body emissive + bloom turned every spatial shard into a glowing square.
   */
  setPowered(amount: number): void {
    this.power = THREE.MathUtils.clamp(amount, 0, 1);
  }

  getPower(): number {
    return this.power;
  }

  updateIdle(_time: number): void {
    // Soft idle handled by reactor point light in main.ts
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
