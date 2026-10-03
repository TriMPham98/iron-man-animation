import * as THREE from 'three';
import type {
  FxBurst,
  PieceFrame,
  SuitUpFrame,
} from '../animation/suitUpChoreography';
import type { ArmorPieceId } from './armorPieces';
import type { ArmorPiece } from './waves';
import {
  loadSuitModel,
  SUIT_GROUND_CLEARANCE,
  type GlowMaterial,
} from './loadSuitModel';
import { boneSpec } from './rig';
import { applyPose, BIND_POSE, bindRig, type SuitPose, type SuitRig } from './rigPose';
import { FloorHatches, RigOverlay, SuitParticles } from './suitEffects';
import {
  applySystemUniforms,
  setFitFx,
  type SuitSystem,
  type SystemPowers,
} from './systemsGlow';
import {
  createDiagnosticScan,
  type DiagnosticScan,
} from './diagnosticScan';
import { FitKinematics } from '../workshop/fittingKinematics';
import { FIT_TASKS } from '../workshop/fittingProgram';

/** Dissolve heights (bind y) — above the helmet and under the soles. */
const CUT_TOP = 1.95;
const CUT_BOTTOM = -0.05;
const NO_CUT = 99;

/**
 * The rigged Mark III: skinned seamless mesh, skinned suit-up pieces, the
 * fitting hologram and its effects. Choreography drives it one frame at a
 * time through {@link applyFrame}; robots read the same part frames through
 * {@link kin}.
 */
export class Suit {
  readonly group = new THREE.Group();
  pieces: ArmorPiece[] = [];
  rig!: SuitRig;
  /** Part frames (cradle → carry → socket) on the posed rig. */
  kin!: FitKinematics;
  private model!: THREE.Group;
  private modelInv = new THREE.Matrix4();
  private finalModel: THREE.Group | null = null;
  private finalMesh!: THREE.SkinnedMesh;
  private hologram!: THREE.SkinnedMesh;
  private hologramMat!: THREE.ShaderMaterial;
  private overlay!: RigOverlay;
  private hatches!: FloorHatches;
  private particles!: SuitParticles;
  private glowMaterials: GlowMaterial[] = [];
  private powers: SystemPowers = { reactor: 0, eyes: 0, repulsors: 0 };
  private assemblyMode = true;
  private diagnostic: DiagnosticScan | null = null;
  /** Frame with every part waiting on its cradle (reset target). */
  private restFrame: SuitUpFrame | null = null;
  private resetArmed = false;
  private readonly frames = new Map<ArmorPieceId, THREE.Matrix4>();

  private readonly _bm = new THREE.Matrix4();
  private readonly _tf = new THREE.Matrix4();
  private readonly _v = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();

  private constructor() {
    this.group.name = 'suit';
  }

  static async create(onProgress?: (r: number) => void): Promise<Suit> {
    const suit = new Suit();
    const loaded = await loadSuitModel(onProgress);
    suit.model = loaded.group;
    suit.group.add(loaded.group);
    suit.pieces = loaded.pieces;
    suit.finalModel = loaded.finalModel;
    suit.glowMaterials = loaded.glowMaterials;
    suit.rig = loaded.rig;
    suit.hologram = loaded.hologram;
    suit.finalMesh = loaded.finalMesh;
    suit.hologramMat = loaded.hologram.material as THREE.ShaderMaterial;

    // Lift whole rig in world space only — bind pose stays feet-at-0.
    suit.group.position.y = SUIT_GROUND_CLEARANCE;
    // Slight heroic lean
    suit.group.rotation.x = -0.03;

    // Bind once the rig sits at its final world placement. Every skinned
    // mesh shares the skeleton and binds against the model group, so a
    // piece's own matrix (identity when docked) composes on top of skinning.
    suit.group.updateMatrixWorld(true);
    const skeleton = bindRig(suit.rig);
    const bindMatrix = suit.model.matrixWorld.clone();
    suit.modelInv.copy(bindMatrix).invert();
    const meshes: THREE.SkinnedMesh[] = [
      loaded.finalMesh,
      loaded.hologram,
      ...suit.pieces.map((p) => p.mesh as THREE.SkinnedMesh),
    ];
    for (const m of meshes) m.bind(skeleton, bindMatrix);
    suit.kin = new FitKinematics(suit.rig, bindMatrix);
    for (const p of suit.pieces) suit.frames.set(p.id, new THREE.Matrix4());

    suit.overlay = new RigOverlay(suit.rig);
    suit.model.add(suit.overlay.group);
    // Hatch rings sit on the platform top (= the soles, model y 0)
    const boots = FIT_TASKS.filter((t) => t.kind === 'lift');
    suit.hatches = new FloorHatches(
      boots.map((t) => t.origin[0]),
      boots[0]?.origin[2] ?? 0.02,
      0.002,
    );
    suit.model.add(suit.hatches.group);
    suit.particles = new SuitParticles();
    suit.model.add(suit.particles.group);

    suit.resetToStart();
    return suit;
  }

  // ── Frame application ─────────────────────────────────────────────

  /** Apply one evaluated choreography frame (pose, pieces, FX, systems). */
  applyFrame(frame: SuitUpFrame): void {
    this.resetArmed = false;
    this.setPose(frame.pose);
    setFitFx(this.finalMesh.material as THREE.Material, NO_CUT);

    if (frame.final) {
      this.showFinal();
    } else {
      this.assemblyMode = true;
      if (this.finalModel) this.finalModel.visible = false;
      this.placePieces(frame.pieces);
    }

    this.hologramMat.uniforms.uReveal.value = frame.hologramReveal;
    this.hologramMat.uniforms.uOpacity.value = frame.hologramOpacity;
    this.hologram.visible =
      !frame.final && frame.hologramOpacity > 0.003 && frame.hologramReveal > 0;
    this.overlay.update(frame.final ? 0 : frame.rigOpacity);
    this.hatches.setOpen(frame.hatch);
    this.setSystemsPower(frame.systems);
  }

  /**
   * Put every part where its fitting channels say: cradle, robot carry,
   * insertion, or seated. Mesh matrix = frame · dock⁻¹ (identity when home).
   */
  private placePieces(pieceFrames: readonly PieceFrame[], cutY?: (id: ArmorPieceId) => number): void {
    const byId = new Map(pieceFrames.map((p) => [p.id, p] as const));
    for (const task of FIT_TASKS) {
      const lead = byId.get(task.pieces[0]);
      if (!lead) continue;
      this.kin.taskFrame(task, lead, this._tf);
      for (const id of task.pieces) {
        const pf = byId.get(id);
        const piece = this.pieces.find((p) => p.id === id);
        if (!pf || !piece) continue;
        const frame = this.frames.get(id)!;
        this.kin.pieceFrame(task, this._tf, pf, frame);
        this.kin.meshMatrix(id, frame, piece.mesh.matrix);
        piece.mesh.matrixWorldNeedsUpdate = true;
        piece.mesh.visible = this.assemblyMode;
        setFitFx((piece.mesh as THREE.Mesh).material as THREE.Material, cutY ? cutY(id) : NO_CUT);
      }
    }
  }

  /** Seamless suit geometry (bind pose, model space). */
  get finalGeometry(): THREE.BufferGeometry {
    return this.finalMesh.geometry;
  }

  /** Bind-pose bounds of a part (model space). */
  pieceBounds(id: ArmorPieceId): THREE.Box3 | null {
    const piece = this.pieces.find((p) => p.id === id);
    const geo = (piece?.mesh as THREE.Mesh | undefined)?.geometry;
    if (!geo) return null;
    if (!geo.boundingBox) geo.computeBoundingBox();
    return geo.boundingBox;
  }

  /** Pose the skeleton and refresh bone world matrices. */
  setPose(pose: SuitPose): void {
    applyPose(this.rig, pose);
    this.rig.root.updateWorldMatrix(true, true);
  }

  /** Fire a spark / steam burst at a bone-carried bind-space point. */
  emitBurst(b: FxBurst): void {
    const spec = boneSpec(b.bone);
    this._bm.multiplyMatrices(this.modelInv, this.rig.bones[b.bone].matrixWorld);
    this._v
      .set(b.at[0] - spec.head[0], b.at[1] - spec.head[1], b.at[2] - spec.head[2])
      .applyMatrix4(this._bm);
    const dir = b.dir ? this._dir.set(b.dir[0], b.dir[1], b.dir[2]).normalize() : undefined;
    this.particles.burst(b.kind, this._v, b.count, dir);
  }

  clearFx(): void {
    this.particles.clear();
  }

  /** Burst at a world point (robot tools — rivet strikes). */
  emitWorld(kind: 'sparks' | 'steam', world: THREE.Vector3, count: number, dirWorld?: THREE.Vector3): void {
    this._v.copy(world).applyMatrix4(this.modelInv);
    const dir = dirWorld ? this._dir.copy(dirWorld).normalize() : undefined;
    this.particles.burst(kind, this._v, count, dir);
  }

  /** World position of a part's centre as currently placed. */
  pieceWorldPosition(id: ArmorPieceId, out: THREE.Vector3): THREE.Vector3 | null {
    const piece = this.pieces.find((p) => p.id === id);
    const frame = this.frames.get(id);
    if (!piece || !frame) return null;
    return out.copy(piece.restPosition).applyMatrix4(frame).applyMatrix4(this.model.matrixWorld);
  }

  /**
   * Per-frame: particles + hologram scanlines. `projectionScale` is the
   * drawing-buffer height / (2·tan(fov/2)) so sparks keep a physical size.
   */
  update(dt: number, projectionScale?: number): void {
    if (projectionScale) this.particles.setProjectionScale(projectionScale);
    this.particles.update(dt);
    this.hologramMat.uniforms.uTime.value += dt;
  }

  // ── Visibility modes ──────────────────────────────────────────────

  /** Assembly mode with every piece hidden (pad empty). */
  showAssembly(): void {
    this.assemblyMode = true;
    this.stopDiagnosticScan();
    if (this.finalModel) this.finalModel.visible = false;
    for (const p of this.pieces) p.mesh.visible = false;
  }

  /** Leave seamless mode for scrubbing — the next frame decides visibility. */
  resumeAssemblyVisuals(): void {
    this.assemblyMode = true;
    this.stopDiagnosticScan();
    if (this.finalModel) this.finalModel.visible = false;
  }

  /** Seamless skinned suit; hide pieces + fitting FX. */
  showFinal(): void {
    this.assemblyMode = false;
    for (const p of this.pieces) p.mesh.visible = false;
    if (this.finalModel) this.finalModel.visible = true;
    this.hologram.visible = false;
    this.overlay.update(0);
  }

  // ── Diagnostic wireframe (showcase orbit) ─────────────────────────

  /**
   * Build wireframe geometry once while still hidden.
   * Call at showcase-orbit start so the ease-out scan has no first-frame hitch.
   */
  prepareDiagnosticScan(): void {
    if (!this.finalModel) return;
    if (!this.diagnostic) {
      this.diagnostic = createDiagnosticScan(this.finalModel);
    }
    this.diagnostic.setProgress(0);
    this.diagnostic.setVisible(false);
  }

  /**
   * Ensure the wireframe overlay exists and is visible.
   * Does **not** reset progress — use {@link setDiagnosticScanProgress}.
   */
  startDiagnosticScan(): void {
    if (!this.finalModel) return;
    // Wireframe is built from bind-pose geometry
    this.setPose(BIND_POSE);
    this.finalModel.visible = true;
    if (!this.diagnostic) {
      this.diagnostic = createDiagnosticScan(this.finalModel);
    }
    this.diagnostic.setVisible(true);
  }

  /** Drive diagnostic reveal 0–1 (no-op if scan was never started). */
  setDiagnosticScanProgress(amount: number): void {
    this.diagnostic?.setProgress(amount);
  }

  /** Hide overlay; keeps the built wireframe for the next pass. */
  stopDiagnosticScan(): void {
    if (!this.diagnostic) return;
    this.diagnostic.setProgress(0);
    this.diagnostic.setVisible(false);
  }

  isDiagnosticScanActive(): boolean {
    return !!this.diagnostic?.group.visible;
  }

  // ── Soft-restart reset ────────────────────────────────────────────

  /** Frame whose part layout is the "all parts on their cradles" state. */
  setRestFrame(frame: SuitUpFrame): void {
    this.restFrame = frame;
  }

  /**
   * Seamless suit in the bind pose, ready for the JARVIS reset: it
   * dissolves top → bottom while every part re-materializes on its cradle.
   */
  armExplosionFromFinal(): void {
    this.stopDiagnosticScan();
    this.clearFx();
    this.setPose(BIND_POSE);
    if (this.finalModel) this.finalModel.visible = true;
    this.hologram.visible = false;
    this.overlay.update(0);
    this.hatches.setOpen(0);
    this.powers = { reactor: 1, eyes: 1, repulsors: 1 };
    this.applySystems();
    this.resetArmed = true;
  }

  /** Reset dissolve 0 = suit assembled, 1 = parts back on their cradles. */
  setExplosionProgress(amount: number): void {
    const u = THREE.MathUtils.clamp(amount, 0, 1);
    if (!this.resetArmed) this.armExplosionFromFinal();
    const out = THREE.MathUtils.clamp(u / 0.62, 0, 1);
    const cut = THREE.MathUtils.lerp(CUT_TOP, CUT_BOTTOM, out * out * (3 - 2 * out));
    if (this.finalModel) this.finalModel.visible = out < 1;
    setFitFx(this.finalMesh.material as THREE.Material, cut);

    if (this.restFrame) {
      const back = THREE.MathUtils.clamp((u - 0.38) / 0.62, 0, 1);
      const e = back * back * (3 - 2 * back);
      this.assemblyMode = true;
      this.placePieces(this.restFrame.pieces, (id) => {
        const box = this.pieceBounds(id);
        if (!box) return NO_CUT;
        return e >= 1 ? NO_CUT : THREE.MathUtils.lerp(box.min.y - 0.01, box.max.y + 0.01, e);
      });
      for (const p of this.pieces) p.mesh.visible = back > 0;
    }

    const glow = THREE.MathUtils.clamp(1 - u * 1.8, 0, 1);
    this.powers = { reactor: glow, eyes: glow, repulsors: glow };
    this.applySystems();
  }

  resetToStart(): void {
    this.powers = { reactor: 0, eyes: 0, repulsors: 0 };
    this.applySystems();
    this.showAssembly();
    this.clearFx();
    this.setPose(BIND_POSE);
    this.resetArmed = false;
    setFitFx(this.finalMesh.material as THREE.Material, NO_CUT);
    this.hologram.visible = false;
    this.hologramMat.uniforms.uReveal.value = 0;
    this.overlay.update(0);
    this.hatches.setOpen(0);
    if (this.restFrame) this.placePieces(this.restFrame.pieces);
  }

  // ── Systems glow ──────────────────────────────────────────────────

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

  getSystemPowers(): SystemPowers {
    return { ...this.powers };
  }

  getPower(): number {
    return Math.max(this.powers.reactor, this.powers.eyes, this.powers.repulsors);
  }

  private applySystems(): void {
    applySystemUniforms(this.glowMaterials, this.powers, 1);
  }

  isAssemblyMode(): boolean {
    return this.assemblyMode;
  }

  dispose(): void {
    this.diagnostic?.dispose();
    this.diagnostic = null;
    this.overlay.dispose();
    this.hatches.dispose();
    this.particles.dispose();
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
