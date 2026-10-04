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
import type { FlightCheckFrame } from '../animation/flightCheck';
import { armorPieceDef } from './armorPieces';
import { buildFlightFlaps, flapMotion, type Flap } from './flightFlaps';
import { FlightFx, type PalmEmitter } from './flightFx';
import { WeaponsFx } from './weaponsFx';
import { FIT_TASKS } from '../workshop/fittingProgram';
import { FOOT_HATCH_RADIUS } from '../workshop/workshopEnvironment';

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
  private readonly frames = new Map<ArmorPieceId, THREE.Matrix4>();
  /**
   * Dark inside of the shell, drawn wherever the armor is seen from behind
   * (into an open flap, under a raised plate) so the suit never reads as
   * hollow or see-through during the flight check.
   */
  private cavity!: THREE.SkinnedMesh;
  /** Back faces of each moving flap (it swings away from the cavity). */
  private flapBacks = new Map<Flap, THREE.SkinnedMesh>();
  private flightFx!: FlightFx;
  private weapons!: WeaponsFx;
  private flightActive = false;
  private flaps: Flap[] = [];
  private flapRests = new Map<ArmorPieceId, THREE.SkinnedMesh>();
  private flapped = new Set<ArmorPieceId>();
  private readonly _hm = new THREE.Matrix4();

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
    // Flight-check flaps: the model's own panels, split off their parts
    const split = buildFlightFlaps(suit.pieces);
    suit.flaps = split.flaps;
    suit.flapRests = split.rests;
    for (const f of split.flaps) suit.flapped.add(f.piece.id);
    const flapMeshes = [
      ...split.flaps.map((f) => f.mesh),
      ...split.flaps.flatMap((f) => (f.walls ? [f.walls] : [])),
      ...split.rests.values(),
    ];
    for (const m of flapMeshes) suit.model.add(m);
    // Interior shell: back faces only, pushed back in depth so where the
    // model has two layers back to back (one facing in, one out) the outer
    // face always wins and nothing flickers
    const inside = new THREE.MeshStandardMaterial({
      color: 0x14100f,
      metalness: 0.6,
      roughness: 0.55,
      side: THREE.BackSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });
    const shell = (geo: THREE.BufferGeometry, name: string) => {
      const m = new THREE.SkinnedMesh(geo, inside);
      m.name = name;
      m.frustumCulled = false;
      m.visible = false;
      suit.model.add(m);
      return m;
    };
    suit.cavity = shell(loaded.finalMesh.geometry, 'suit-cavity');
    for (const f of split.flaps) {
      const back = shell(f.mesh.geometry, `flap-back-${f.id}`);
      back.matrixAutoUpdate = false;
      suit.flapBacks.set(f, back);
    }
    const meshes: THREE.SkinnedMesh[] = [
      ...flapMeshes,
      suit.cavity,
      ...suit.flapBacks.values(),
      loaded.finalMesh,
      loaded.hologram,
      ...suit.pieces.map((p) => p.mesh as THREE.SkinnedMesh),
    ];
    for (const m of meshes) m.bind(skeleton, bindMatrix);
    suit.kin = new FitKinematics(suit.rig, bindMatrix);
    for (const p of suit.pieces) suit.frames.set(p.id, new THREE.Matrix4());

    suit.overlay = new RigOverlay(suit.rig);
    suit.model.add(suit.overlay.group);
    // Centre hatch glow sits on the platform top (= the soles, model y 0)
    suit.hatches = new FloorHatches(0, 0, FOOT_HATCH_RADIUS, 0.002);
    suit.model.add(suit.hatches.group);
    suit.particles = new SuitParticles();
    suit.model.add(suit.particles.group);
    suit.flightFx = new FlightFx(measurePalms(suit.pieces));
    suit.model.add(suit.flightFx.group);
    suit.weapons = new WeaponsFx(suit.flaps);
    suit.model.add(suit.weapons.group);

    suit.resetToStart();
    return suit;
  }

  // ── Frame application ─────────────────────────────────────────────

  /** Apply one evaluated choreography frame (pose, pieces, FX, systems). */
  applyFrame(frame: SuitUpFrame): void {
    this.endFlightCheck();
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
    // Suit vents fire as pressure jets along their vent direction
    this.particles.burst(b.kind, this._v, b.count, dir, { jet: b.kind === 'steam' });
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

  // ── Flight-control check (showcase turn) ──────────────────────────

  /**
   * Show the finished suit as its seated parts so flaps can actuate, posed
   * by the flight check. `null` / inactive hands back to the seamless suit.
   */
  setFlightCheck(f: FlightCheckFrame | null, t = 0): void {
    if (!f || !f.active) {
      this.endFlightCheck();
      return;
    }
    this.flightActive = true;
    this.setPose(f.pose);
    if (this.finalModel) this.finalModel.visible = false;
    // A part whose flaps are all seated shows as its original, unsplit
    // mesh: no seams and no coincident flap / rest faces. It only splits
    // while one of its flaps is moving. Nothing is drawn in the opening.
    const openPieces = new Set<ArmorPieceId>();
    for (const flap of this.flaps) {
      if ((f.flaps[flap.id] ?? 0) > 1e-4) openPieces.add(flap.piece.id);
    }
    for (const piece of this.pieces) {
      const mesh = piece.mesh as THREE.Mesh;
      mesh.matrix.identity();
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = !openPieces.has(piece.id);
      setFitFx(mesh.material as THREE.Material, NO_CUT);
    }
    for (const [id, rest] of this.flapRests) rest.visible = openPieces.has(id);
    this.cavity.visible = openPieces.size > 0;
    for (const flap of this.flaps) {
      const k = f.flaps[flap.id] ?? 0;
      const m = flap.mesh;
      const back = this.flapBacks.get(flap)!;
      m.visible = openPieces.has(flap.piece.id);
      m.matrixWorldNeedsUpdate = true;
      back.visible = k > 1e-4;
      if (k <= 1e-4) {
        m.matrix.identity();
        // Walls only exist once the plate has left the shell.
        if (flap.walls) flap.walls.visible = false;
        continue;
      }
      // frame = dock · motion; mesh matrix = frame · dock⁻¹
      const frame = this.kin.dock(armorPieceDef(flap.piece.id).anchor, this._tf).multiply(flapMotion(flap, k, this._hm));
      this.kin.meshMatrix(flap.piece.id, frame, m.matrix);
      back.matrix.copy(m.matrix);
      back.matrixWorldNeedsUpdate = true;
      if (flap.walls) {
        flap.walls.visible = true;
        flap.walls.matrix.copy(m.matrix);
        flap.walls.matrixWorldNeedsUpdate = true;
      }
    }
    this.flightFx.update(f, t, this.rig, this.modelInv, this.particles);
    this.weapons.update(f, t, this.rig, this.modelInv, this.particles);
  }

  private endFlightCheck(): void {
    if (!this.flightActive) return;
    this.flightActive = false;
    this.flightFx.hide();
    this.weapons.hide();
    this.cavity.visible = false;
    for (const m of this.flapBacks.values()) m.visible = false;
    for (const m of [
      ...this.flaps.map((f) => f.mesh),
      ...this.flaps.flatMap((f) => (f.walls ? [f.walls] : [])),
      ...this.flapRests.values(),
    ]) m.visible = false;
    for (const p of this.pieces) {
      p.mesh.matrix.identity();
      p.mesh.matrixWorldNeedsUpdate = true;
      p.mesh.visible = false;
    }
    this.setPose(BIND_POSE);
    if (this.finalModel) this.finalModel.visible = true;
  }

  isFlightCheckActive(): boolean {
    return this.flightActive;
  }

  // ── Visibility modes ──────────────────────────────────────────────

  /** Assembly mode with every piece hidden (pad empty). */
  showAssembly(): void {
    this.endFlightCheck();
    this.assemblyMode = true;
    this.stopDiagnosticScan();
    if (this.finalModel) this.finalModel.visible = false;
    for (const p of this.pieces) p.mesh.visible = false;
  }

  /** Leave seamless mode for scrubbing — the next frame decides visibility. */
  resumeAssemblyVisuals(): void {
    this.endFlightCheck();
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
    this.endFlightCheck();
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

  resetToStart(): void {
    this.endFlightCheck();
    this.powers = { reactor: 0, eyes: 0, repulsors: 0 };
    this.applySystems();
    this.showAssembly();
    this.clearFx();
    this.setPose(BIND_POSE);
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

/** Packed emissive atlas (B = repulsors) as pixels, for locating the repulsor. */
function emissivePixels(mat: THREE.Material | undefined): { d: Uint8ClampedArray; w: number; h: number; flipY: boolean } | null {
  const tex = (mat as THREE.MeshStandardMaterial | undefined)?.emissiveMap;
  const img = tex?.image as { width?: number; height?: number } | undefined;
  if (!tex || !img || typeof document === 'undefined') return null;
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (w < 2 || h < 2) return null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img as CanvasImageSource, 0, 0, w, h);
    return { d: g.getImageData(0, 0, w, h).data, w, h, flipY: tex.flipY };
  } catch {
    return null;
  }
}

/**
 * Repulsor centre + normal per hand, measured off the gauntlet: the faces
 * whose emissive texels light up as repulsor (blue channel of the packed
 * glow atlas) on the palm. Falls back to the palm-facing panels.
 */
function measurePalms(pieces: readonly ArmorPiece[]): PalmEmitter[] {
  return (['L', 'R'] as const).map((side) => {
    const s = side === 'L' ? 1 : -1;
    const mesh = pieces.find((p) => p.id === `gauntlet.${side}`)?.mesh as THREE.Mesh | undefined;
    const geo = mesh?.geometry;
    const fallback: PalmEmitter = { bone: `hand.${side}`, at: [s * 0.347, 0.975, 0.035], normal: [-s * 0.98, -0.15, 0.06] };
    if (!geo?.index) return fallback;
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const em = emissivePixels(mesh?.material as THREE.Material);
    const idx = geo.index.array;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const glowing = (i: number) => {
      if (!em || !uv) return 0;
      const u = ((uv.getX(i) % 1) + 1) % 1;
      const v = ((uv.getY(i) % 1) + 1) % 1;
      const px = Math.min(em.w - 1, Math.floor(u * em.w));
      const py = Math.min(em.h - 1, Math.floor((em.flipY ? 1 - v : v) * em.h));
      const k = (py * em.w + px) * 4;
      return em.d[k + 2] / 255;
    };
    const accumulate = (useGlow: boolean) => {
      const sumN = new THREE.Vector3();
      const sumP = new THREE.Vector3();
      let area = 0;
      for (let t = 0; t < idx.length; t += 3) {
        a.fromBufferAttribute(pos, idx[t]);
        b.fromBufferAttribute(pos, idx[t + 1]);
        c.fromBufferAttribute(pos, idx[t + 2]);
        n.subVectors(b, a).cross(c.clone().sub(a));
        const w = n.length() / 2;
        if (w < 1e-9) continue;
        n.normalize();
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        // Palm side of the hand, between wrist and knuckles
        if (n.x * s > -0.3 || cy < 0.92 || cy > 1.03) continue;
        let k = 1;
        if (useGlow) {
          k = (glowing(idx[t]) + glowing(idx[t + 1]) + glowing(idx[t + 2])) / 3;
          if (k < 0.35) continue;
        } else if (n.x * s > -0.6 || Math.abs(cy - 0.975) > 0.04 || cx * s < 0.32 || cx * s > 0.375) continue;
        sumN.addScaledVector(n, w * k);
        sumP.add(new THREE.Vector3(cx, cy, (a.z + b.z + c.z) / 3).multiplyScalar(w * k));
        area += w * k;
      }
      return area > 1e-7 ? { n: sumN.normalize(), p: sumP.divideScalar(area) } : null;
    };
    const r = accumulate(true) ?? accumulate(false);
    if (!r) return fallback;
    return { bone: `hand.${side}`, at: [r.p.x, r.p.y, r.p.z], normal: [r.n.x, r.n.y, r.n.z] };
  });
}
