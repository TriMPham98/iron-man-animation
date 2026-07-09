import * as THREE from 'three';
import type { ArmorPiece, PieceWave } from './createPieces';
import { loadSuitModel } from './loadSuitModel';

export class Suit {
  readonly group = new THREE.Group();
  pieces: ArmorPiece[] = [];
  private power = 0;
  private emissiveMats: THREE.MeshStandardMaterial[] = [];

  private constructor() {
    this.group.name = 'suit';
  }

  static async create(onProgress?: (r: number) => void): Promise<Suit> {
    const suit = new Suit();
    const loaded = await loadSuitModel(onProgress);
    suit.group.add(loaded.group);
    suit.pieces = loaded.pieces;

    // Collect materials that can take emissive pulse (bright / named glow)
    const seen = new Set<THREE.Material>();
    suit.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat || seen.has(mat)) continue;
        seen.add(mat);
        const m = mat as THREE.MeshStandardMaterial;
        if ('emissive' in m) {
          suit.emissiveMats.push(m);
        }
      }
    });

    // Slight heroic lean
    suit.group.rotation.x = -0.03;
    return suit;
  }

  piecesInWave(wave: PieceWave): ArmorPiece[] {
    return this.pieces.filter((p) => p.wave === wave);
  }

  resetToStart(): void {
    this.power = 0;
    this.setPowered(0);
    for (const p of this.pieces) {
      p.mesh.visible = false;
      p.mesh.position.copy(p.startPosition);
      p.mesh.rotation.copy(p.startRotation);
      p.mesh.scale.copy(p.startScale);
    }
  }

  /** 0 = off, 1 = full power — boosts emissive on suit materials */
  setPowered(amount: number): void {
    this.power = THREE.MathUtils.clamp(amount, 0, 1);
    for (const m of this.emissiveMats) {
      // Soft cyan/white glow that bloom can pick up on bright textured areas
      m.emissive = new THREE.Color(0x1a3040);
      m.emissiveIntensity = this.power * 0.55;
      m.needsUpdate = true;
    }
  }

  getPower(): number {
    return this.power;
  }

  updateIdle(time: number): void {
    if (this.power < 0.5) return;
    const pulse = 1 + Math.sin(time * 3.2) * 0.12;
    for (const m of this.emissiveMats) {
      m.emissiveIntensity = this.power * 0.55 * pulse;
    }
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
