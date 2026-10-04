import * as THREE from 'three';

/**
 * The cell floor's ring aperture: one wide annular opening round the
 * platform that every floor arm, parts stand and stowed part goes through.
 * Shut, it is a flush deck of curved sector plates; opening, the plates
 * slide out under the outer deck along a spiral, the whole ring turning as
 * it opens like a camera iris run backwards.
 *
 * Plane coordinates (a, b) map to world (x, z).
 */

/** Inner / outer radius of the opening (m): platform lip → past the parts stands. */
export const APERTURE_INNER = 1.13;
export const APERTURE_OUTER = 2.45;
/** Sector plates (lined up with the deck's 24 panel seams). */
export const APERTURE_SEGMENTS = 24;
/** Seconds the ring takes to open or shut. */
export const APERTURE_SEC = 1.2;

/** Shut plates run this far under each deck edge. */
const LAP = 0.015;
/** Radial run out from shut to parked (clear of the outer deck edge). */
const TRAVEL = APERTURE_OUTER - APERTURE_INNER + 2 * LAP + 0.04;
/** Turn of the ring over a full stroke (rad). */
const TWIST = ((2 * Math.PI) / APERTURE_SEGMENTS) * 1.5;
/** Plate top just under the deck, and its thickness. */
const TOP = -0.004;
const THICK = 0.012;
/** Seam between neighbouring plates (m). */
const SEAM = 0.003;
/** Raised seal along each plate's inner (leading) edge. */
const SEAL_W = 0.035;
const SEAL_H = 0.0025;

const HALF = Math.PI / APERTURE_SEGMENTS;
const R0 = APERTURE_INNER - LAP;
const R1 = APERTURE_OUTER + LAP;

const ease = (u: number) => {
  const k = THREE.MathUtils.clamp(u, 0, 1);
  return k * k * (3 - 2 * k);
};

/** Sector outline r0..r1 centred on angle 0, the seam trimmed off both sides. */
function sector(r0: number, r1: number, n = 24): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const a0 = -HALF + SEAM / 2 / r0;
  const a1 = HALF - SEAM / 2 / r0;
  const b0 = -HALF + SEAM / 2 / r1;
  const b1 = HALF - SEAM / 2 / r1;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([r0 * Math.cos(a), r0 * Math.sin(a)]);
  }
  for (let i = n; i >= 0; i--) {
    const a = b0 + ((b1 - b0) * i) / n;
    pts.push([r1 * Math.cos(a), r1 * Math.sin(a)]);
  }
  return pts;
}

/** Plate i's placement at opening u: centre angle + twist, radial run. */
function placement(i: number, u: number): { angle: number; run: number } {
  const k = ease(u);
  return { angle: ((i + 0.5) / APERTURE_SEGMENTS) * Math.PI * 2 + TWIST * k, run: TRAVEL * k };
}

/** Outline of plate i at opening u (0 shut → 1 open), plane coordinates. */
export function aperturePlatePoints(i: number, u: number): Array<[number, number]> {
  const { angle, run } = placement(i, u);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return sector(R0, R1).map(([a, b]) => [(a + run) * c - b * s, (a + run) * s + b * c]);
}

function slab(outline: Array<[number, number]>, y0: number, y1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([a, b]) => new THREE.Vector2(a, b)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 4 });
  // Shape (a, b, z) → world (a, −z, b): flat, thickness downward from y1
  geo.rotateX(Math.PI / 2);
  geo.translate(0, y1, 0);
  return geo;
}

export class RingAperture {
  readonly group = new THREE.Group();
  private readonly plates: THREE.InstancedMesh;
  private readonly seals: THREE.InstancedMesh;
  private u = -1;
  private readonly _m = new THREE.Matrix4();
  private readonly _t = new THREE.Matrix4();

  constructor(plateMat: THREE.Material, sealMat: THREE.Material) {
    this.group.name = 'ring-aperture';
    this.plates = new THREE.InstancedMesh(slab(sector(R0, R1), TOP - THICK, TOP), plateMat, APERTURE_SEGMENTS);
    this.seals = new THREE.InstancedMesh(
      slab(sector(APERTURE_INNER + 0.008, APERTURE_INNER + 0.008 + SEAL_W, 8), TOP, TOP + SEAL_H),
      sealMat,
      APERTURE_SEGMENTS,
    );
    for (const m of [this.plates, this.seals]) {
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.userData.dynamic = true;
      this.group.add(m);
    }
    this.set(0);
  }

  /** Opening: 0 shut (flush deck) → 1 fully open. */
  set(u: number): void {
    const k = THREE.MathUtils.clamp(u, 0, 1);
    if (k === this.u) return;
    this.u = k;
    for (let i = 0; i < APERTURE_SEGMENTS; i++) {
      const { angle, run } = placement(i, k);
      // Plane rotation by α is a world rotation about Y by −α
      this._m.makeRotationY(-angle).multiply(this._t.makeTranslation(run, 0, 0));
      this.plates.setMatrixAt(i, this._m);
      this.seals.setMatrixAt(i, this._m);
    }
    this.plates.instanceMatrix.needsUpdate = true;
    this.seals.instanceMatrix.needsUpdate = true;
    // Parked out of sight under the outer deck once open
    this.group.visible = k < 0.999;
  }

  dispose(): void {
    this.plates.geometry.dispose();
    this.seals.geometry.dispose();
  }
}
