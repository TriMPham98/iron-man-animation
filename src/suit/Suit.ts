import * as THREE from 'three';
import {
  createArmorPieces,
  type ArmorPiece,
  type PieceWave,
} from './createPieces';
import { createCoreBody } from './createCoreBody';
import { createSuitMaterials, type SuitMaterials } from './materials';

export class Suit {
  readonly group = new THREE.Group();
  readonly materials: SuitMaterials;
  readonly pieces: ArmorPiece[];
  readonly reactorGroup: THREE.Group;
  readonly eyeMeshes: THREE.Mesh[];
  readonly coreBody: THREE.Group;

  private power = 0;

  constructor() {
    this.group.name = 'suit';
    this.materials = createSuitMaterials();
    this.coreBody = createCoreBody(this.materials);
    this.group.add(this.coreBody);

    const { pieces, reactorGroup, eyeMeshes } = createArmorPieces(
      this.materials,
    );
    this.pieces = pieces;
    this.reactorGroup = reactorGroup;
    this.eyeMeshes = eyeMeshes;

    for (const p of pieces) {
      this.group.add(p.mesh);
    }

    // Slight heroic stance: lean back a hair
    this.group.rotation.x = -0.04;
    this.group.position.y = 0;
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

  /** 0 = off, 1 = full power */
  setPowered(amount: number): void {
    this.power = THREE.MathUtils.clamp(amount, 0, 1);
    this.materials.reactorCore.emissiveIntensity = this.power * 3.5;
    this.materials.reactorRing.emissiveIntensity = this.power * 1.8;
    this.materials.eye.emissiveIntensity = this.power * 2.8;
  }

  getPower(): number {
    return this.power;
  }

  /** Subtle idle pulse after assembly */
  updateIdle(time: number): void {
    if (this.power < 0.5) return;
    const pulse = 1 + Math.sin(time * 3.2) * 0.12;
    this.materials.reactorCore.emissiveIntensity = this.power * 3.5 * pulse;
    this.materials.reactorRing.emissiveIntensity =
      this.power * 1.8 * (0.9 + Math.sin(time * 2.4) * 0.1);
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
      }
    });
    this.materials.dispose();
  }
}
