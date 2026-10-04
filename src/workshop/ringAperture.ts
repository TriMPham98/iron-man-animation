import * as THREE from 'three';

/**
 * The cell floor's ring aperture: one wide annular opening round the
 * platform that every floor arm, parts stand and stowed part goes through.
 * Shut, it is a deck of curved iris blades, each lapping over the next like
 * a camera diaphragm; opening, the blades slide out under the outer deck
 * while the whole ring turns, their swept leading edges drawing back into
 * a scalloped spiral.
 *
 * Plane coordinates (a, b) map to world (x, z).
 */

/** Inner / outer radius of the opening (m): platform lip → past the parts stands. */
export const APERTURE_INNER = 1.13;
export const APERTURE_OUTER = 2.45;
/** Iris blades (lined up with the deck's 24 panel seams). */
export const APERTURE_SEGMENTS = 24;
/** Seconds the ring takes to open or shut. */
export const APERTURE_SEC = 1.2;

/** Shut blades run this far under each deck edge. */
const LAP = 0.015;
/** Turn of the ring over a full stroke (rad). */
const TWIST = ((2 * Math.PI) / APERTURE_SEGMENTS) * 1.5;
/** How far each blade's centre line sweeps round from inner to outer edge (rad). */
const SWEEP = 0.5;
/** Share of the next blade's pitch each blade runs on under it. */
const OVERLAP = 0.25;
/**
 * Blade top at its leading edge (just under the deck), how far it steps
 * down across one pitch, and its thickness: the next blade's leading edge
 * sits on this one's trailing lap, so DROP must clear THICK.
 */
const TOP = -0.003;
const DROP = 0.0075;
const THICK = 0.005;
/**
 * Opening starts by unlatching: every blade drops this far off the deck's
 * underside (first share of the stroke) before it slides, and closing ends
 * by lifting it back up into its seat.
 */
const UNLATCH = 0.004;
const UNLATCH_SHARE = 0.14;
/** Raised seal along each blade's exposed inner (leading) edge. */
const SEAL_W = 0.03;
const SEAL_H = 0.0025;

const PITCH = (2 * Math.PI) / APERTURE_SEGMENTS;
const R0 = APERTURE_INNER - LAP;
const R1 = APERTURE_OUTER + LAP;
const S_END = 1 + OVERLAP;

/** Lowest point of a blade's underside, unlatched (world y): anything under the ring must clear it. */
export const APERTURE_UNDERSIDE = TOP - DROP * S_END - THICK - UNLATCH;

const ease = (u: number) => {
  const k = THREE.MathUtils.clamp(u, 0, 1);
  return k * k * (3 - 2 * k);
};

/** Blade-local polar angle at radius r and across-blade position s (0 leading edge → S_END trailing). */
function bladeAngle(r: number, s: number): number {
  return SWEEP * ((r - R0) / (R1 - R0) - 0.5) + (s - 0.5) * PITCH;
}

/** Blade top (local y) at across-blade position s. */
const topAt = (s: number) => TOP - DROP * s;

/** Plane point of a blade at (r, s), blade-local. */
function local(r: number, s: number): [number, number] {
  const a = bladeAngle(r, s);
  return [r * Math.cos(a), r * Math.sin(a)];
}

/** Blade-local outline: leading edge out, outer arc, trailing edge in, inner arc. */
function outline(n = 16): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) pts.push(local(R0 + ((R1 - R0) * i) / n, 0));
  for (let i = 0; i < n; i++) pts.push(local(R1, (S_END * i) / n));
  for (let i = n; i > 0; i--) pts.push(local(R0 + ((R1 - R0) * i) / n, S_END));
  for (let i = n; i > 0; i--) pts.push(local(R0, (S_END * i) / n));
  return pts;
}

/** Radial run that parks every blade clear of the outer deck edge. */
const TRAVEL = (() => {
  const pts = outline();
  for (let run = 0; ; run += 0.01) {
    if (pts.every(([a, b]) => Math.hypot(a + run, b) > APERTURE_OUTER + 0.04)) return run;
  }
})();

/**
 * Blade i's placement at opening u: ring angle, radial run, drop. The
 * blades unlatch (drop clear of their seat), then the ring turns as they
 * draw back into the slot under the outer bezel.
 */
function placement(i: number, u: number): { angle: number; run: number; drop: number } {
  const drop = UNLATCH * ease(u / UNLATCH_SHARE);
  const k = ease((u - UNLATCH_SHARE * 0.7) / (1 - UNLATCH_SHARE * 0.7));
  return { angle: i * PITCH + TWIST * k, run: TRAVEL * k, drop };
}

/** Outline of blade i at opening u (0 shut → 1 open), plane coordinates. */
export function aperturePlatePoints(i: number, u: number): Array<[number, number]> {
  const { angle, run } = placement(i, u);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return outline().map(([a, b]) => [(a + run) * c - b * s, (a + run) * s + b * c]);
}

/**
 * Top and underside (world y) of blade i at opening u over plane point
 * (a, b), or null where the blade is not.
 */
export function apertureBladeSpan(i: number, u: number, a: number, b: number): { top: number; bottom: number } | null {
  const { angle, run, drop } = placement(i, u);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const la = a * c + b * s - run;
  const lb = -a * s + b * c;
  const r = Math.hypot(la, lb);
  if (r < R0 || r > R1) return null;
  const sweep = SWEEP * ((r - R0) / (R1 - R0) - 0.5);
  const x = (Math.atan2(lb, la) - sweep) / PITCH + 0.5;
  if (x < 0 || x > S_END) return null;
  return { top: topAt(x) - drop, bottom: topAt(x) - THICK - drop };
}

/**
 * One blade (or its seal) as a mesh: a stepped top surface over r0..r1 ×
 * s0..s1, a leading-edge wall and an inner-edge wall. Shape (a, b) → world
 * (a, y, b); the instance matrix turns it into place.
 */
function bladeGeometry(r0: number, r1: number, s0: number, s1: number, lift: number, depth: number, nr: number, ns: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d);
  const vert = (r: number, s: number, y: number, u: number, v: number) => {
    const [a, b] = local(r, s);
    pos.push(a, y, b);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };
  // Top
  const base = pos.length / 3;
  for (let i = 0; i <= nr; i++) {
    for (let j = 0; j <= ns; j++) {
      const r = r0 + ((r1 - r0) * i) / nr;
      const s = s0 + ((s1 - s0) * j) / ns;
      vert(r, s, topAt(s) + lift, i / nr, j / ns);
    }
  }
  for (let i = 0; i < nr; i++) {
    for (let j = 0; j < ns; j++) {
      const a = base + i * (ns + 1) + j;
      quad(a, a + 1, a + ns + 2, a + ns + 1);
    }
  }
  // Leading-edge wall (s0), facing back along −s
  const lead = pos.length / 3;
  for (let i = 0; i <= nr; i++) {
    const r = r0 + ((r1 - r0) * i) / nr;
    vert(r, s0, topAt(s0) + lift, i / nr, 0);
    vert(r, s0, topAt(s0) + lift - depth, i / nr, 0.04);
  }
  for (let i = 0; i < nr; i++) quad(lead + 2 * i, lead + 2 * i + 2, lead + 2 * i + 3, lead + 2 * i + 1);
  // Inner-edge wall (r0), facing the platform
  const inner = pos.length / 3;
  for (let j = 0; j <= ns; j++) {
    const s = s0 + ((s1 - s0) * j) / ns;
    vert(r0, s, topAt(s) + lift, 0, j / ns);
    vert(r0, s, topAt(s) + lift - depth, 0.03, j / ns);
  }
  for (let j = 0; j < ns; j++) quad(inner + 2 * j, inner + 2 * j + 1, inner + 2 * j + 3, inner + 2 * j + 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
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
    this.plates = new THREE.InstancedMesh(bladeGeometry(R0, R1, 0, S_END, 0, THICK, 14, 8), plateMat, APERTURE_SEGMENTS);
    const sr0 = APERTURE_INNER + 0.008;
    this.seals = new THREE.InstancedMesh(
      bladeGeometry(sr0, sr0 + SEAL_W, 0.02, 1, SEAL_H, SEAL_H, 1, 8),
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

  /** Opening: 0 shut (iris deck) → 1 fully open. */
  set(u: number): void {
    const k = THREE.MathUtils.clamp(u, 0, 1);
    if (k === this.u) return;
    this.u = k;
    for (let i = 0; i < APERTURE_SEGMENTS; i++) {
      const { angle, run, drop } = placement(i, k);
      // Plane rotation by α is a world rotation about Y by −α
      this._m.makeRotationY(-angle).multiply(this._t.makeTranslation(run, -drop, 0));
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
