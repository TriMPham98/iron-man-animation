import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import { coastZ, type Heightfield } from '../world/heightfield';
import type { Round } from './drones';
import type { Explosions } from './explosions';
import type { Missiles } from './missiles';
import { beam, box, frustum, loft, merge, paint, panelOn, quad, type Frustum, type Paint, type V3 } from './modelKit';
import type { DamageKind, Hostile, PlayerTarget } from './types';

/**
 * The Hammer frigate: a 130 m warship steaming a slow circuit a few
 * kilometres off the coast, fought part by part.
 *  - Two CIWS mounts (on the bridge roof and the hangar) hose tracer at the
 *    suit inside 2 km. Flares do nothing to a gun: break line of sight
 *    behind the cliffs, out-turn the mount's slew, or skim the waves — under
 *    14 m it loses you in the sea clutter beyond 250 m.
 *  - A vertical launcher on the foredeck ripples heat seekers out of its
 *    cells, straight up and over onto the suit. Flares work on these.
 *  - The search radar on the mast cues both: shot away, the guns lose half
 *    their reach and spray wide, and the launcher can only fire on what the
 *    deck can see close in.
 *  - The hull is armoured while any weapon still fights (the unibeam bites
 *    through it better than anything); once the guns and cells are gone it
 *    opens up, and when it fails the ship burns, lists and goes down.
 */

const mats = {
  paint: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x0b0e12, metalness: 0.9, roughness: 0.12 }),
  charred: new THREE.MeshStandardMaterial({ color: 0x0d0c0b, metalness: 0.3, roughness: 0.9 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0x220000, emissive: new THREE.Color(1, 0.08, 0.02), emissiveIntensity: 4 }),
};

/** Deck height above the waterline, and the hull's half-beam and ends (m, ship frame, +Z bow). */
const DECK = 6;
const STERN = -62;
const BOW = 64;

/** Steaming speed (m/s), the patrol circle (m), the deepest-water check. */
const SPEED = 9;
const PATROL_R = 1600;

/** CIWS: reach with / without the radar (m), slew (rad/s), round speed (m/s), rate (rounds/s), burst/pause (s). */
const CIWS_RANGE = 2000;
const CIWS_RANGE_BLIND = 1100;
const CIWS_SLEW = 0.75;
const CIWS_ROUND = 1100;
const CIWS_RATE = 20;
const CIWS_BURST = 2.4;
const CIWS_PAUSE = 1.6;
const CIWS_DAMAGE = 2;
/** Below this height over the sea, and beyond {@link CLUTTER_RANGE}, the gun radar can't hold the suit. */
const CLUTTER_HEIGHT = 14;
const CLUTTER_RANGE = 250;

/** VLS: reach with / without the radar (m), salvo size, gap (s), reload (s). */
const VLS_RANGE = 5000;
const VLS_RANGE_BLIND = 1600;
const VLS_SALVO = 4;
const VLS_GAP = 0.55;

const C = {
  hull: 0x737a82,
  hullLight: 0x80878f,
  boot: 0x24262a,
  deck: 0x45494e,
  dark: 0x17191b,
  door: 0x5d636a,
  white: 0xd4d6d8,
  mark: 0xc9c9c0,
  rhib: 0xa4501f,
  rhibHull: 0x3a3d40,
};

/**
 * Hull stations stern to bow: z, then half-beams at the deck edge, the
 * knuckle (y 3), the boot-top (y 0.7), the bilge (y −2.2) and the keel
 * shoulder (y −3.5), and the deck height (the foc'sle rises to the stem).
 */
type Station = readonly [z: number, bd: number, bm: number, bw: number, bb: number, bk: number, d: number];
const STATIONS: readonly Station[] = [
  [STERN, 6.6, 6.6, 6.3, 5.0, 1.5, DECK],
  [-45, 7.4, 7.4, 7.2, 6.2, 2.0, DECK],
  [-20, 7.6, 7.6, 7.4, 6.6, 2.2, DECK],
  [10, 7.6, 7.6, 7.4, 6.6, 2.2, DECK],
  [30, 7.2, 6.9, 6.2, 4.8, 1.4, DECK],
  [44, 5.9, 5.1, 4.0, 2.6, 0.8, DECK],
  [54, 3.9, 2.8, 1.8, 0.9, 0.3, DECK + 0.6],
  [60, 2.0, 1.0, 0.4, 0.15, 0.05, DECK + 1.0],
  [BOW, 0.12, 0.08, 0.05, 0.04, 0.02, DECK + 1.2],
];

function station(z: number): Station {
  let i = 0;
  while (i < STATIONS.length - 2 && z > STATIONS[i + 1][0]) i++;
  const a = STATIONS[i];
  const b = STATIONS[i + 1];
  const t = THREE.MathUtils.clamp((z - a[0]) / (b[0] - a[0]), 0, 1);
  return a.map((v, k) => v + (b[k] - v) * t) as unknown as Station;
}

/** The stem rakes: toward the bow, the lower a point the further aft of its station it sits. */
const rake = (z: number, y: number, d: number) => z - THREE.MathUtils.clamp((z - 40) / 24, 0, 1) * 7 * ((d - y) / (d + 3.6));

function hullRing(st: Station): V3[] {
  const [z, bd, bm, bw, bb, bk, d] = st;
  const half: [number, number][] = [[bk, -3.5], [bb, -2.2], [bw, 0.7], [bm, 3], [bd, d]];
  const pts: V3[] = [[0, -3.6, rake(z, -3.6, d)]];
  for (const [x, y] of half) pts.push([x, y, rake(z, y, d)]);
  for (const [x, y] of [...half].reverse()) pts.push([-x, y, rake(z, y, d)]);
  return pts;
}

/** A point on the topsides (between the knuckle, t = 0, and the deck edge, t = 1) on side s. */
function topside(z: number, t: number, s: number): THREE.Vector3 {
  const [, bd, bm, , , , d] = station(z);
  const y = 3 + (d - 3) * t;
  return new THREE.Vector3(s * (bm + (bd - bm) * t), y, rake(z, y, d));
}

/** A painted patch on the topsides: z0…z1 along, t0…t1 up, lifted off the plating. */
function topsidePatch(z0: number, z1: number, t0: number, t1: number, s: number, color: Paint): THREE.BufferGeometry {
  const a = topside(z0, t0, s);
  const b = topside(z1, t0, s);
  const c = topside(z1, t1, s);
  const d = topside(z0, t1, s);
  const n = new THREE.Vector3().crossVectors(b.clone().sub(a), d.clone().sub(a)).normalize();
  if (n.x * s < 0) n.negate();
  return quad(a.addScaledVector(n, 0.06), b.addScaledVector(n, 0.06), c.addScaledVector(n, 0.06), d.addScaledVector(n, 0.06), n, color);
}

/** Superstructure blocks (also the collision boxes' shapes, sloped in a little). */
const BRIDGE: Frustum = { hw0: 6, z0: -13, z1: 9, y0: DECK, hw1: 5.3, z2: -12.4, z3: 8, y1: DECK + 9 };
const PILOTHOUSE: Frustum = { hw0: 4.5, z0: -10.5, z1: -1.5, y0: DECK + 9, hw1: 4.0, z2: -10, z3: -2.2, y1: DECK + 12 };
const MAST: Frustum = { hw0: 3.0, z0: -9.2, z1: -2.8, y0: DECK + 12, hw1: 1.3, z2: -6.9, z3: -5.1, y1: DECK + 24.6 };
const HANGAR: Frustum = { hw0: 6.5, z0: -38, z1: -22, y0: DECK, hw1: 6.0, z2: -37.6, z3: -22.4, y1: DECK + 7 };

/** CIWS pivot in the yaw frame (as the sim expects it). */
const CIWS_PIVOT = new THREE.Vector3(0, 0.9, 0.5);

interface FrigateGeometry {
  hull: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  number: THREE.BufferGeometry;
  lid: THREE.BufferGeometry;
  radar: THREE.BufferGeometry;
  ciwsBase: THREE.BufferGeometry;
  ciwsYaw: THREE.BufferGeometry;
  ciwsPitch: THREE.BufferGeometry;
}

let geoCache: FrigateGeometry | null = null;
let numberMat: THREE.MeshStandardMaterial | null = null;

/** The VLS block's place on the foredeck, and its cells (x, z from the block's centre). */
const VLS_AT = new THREE.Vector3(0, DECK, 30);
const VLS_CELLS: readonly [number, number][] = Array.from({ length: 8 }, (_, i) => [i % 2 ? 1.2 : -1.2, -3 + Math.floor(i / 2) * 2]);

function frigateGeometry(): FrigateGeometry {
  if (geoCache) return geoCache;
  const hull: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];

  // Hull: flared, knuckled topsides over a dark boot-top, raked stem, flat transom
  const zs = STATIONS.map((s) => s[0]);
  hull.push(
    loft(
      zs.map((z) => hullRing(station(z))),
      (e, seg) => (seg < 0 ? C.hull : e === 5 ? C.deck : e === 3 || e === 4 || e === 6 || e === 7 ? C.hull : C.boot),
      [true, false],
      (c) => c.set(0, THREE.MathUtils.clamp(c.y, -2, DECK - 1), c.z),
    ),
  );
  // Openings in the transom (the stern mooring deck) and a few hull-side doors
  hull.push(quad(new THREE.Vector3(-4, 3.4, STERN - 0.05), new THREE.Vector3(4, 3.4, STERN - 0.05), new THREE.Vector3(4, 5.0, STERN - 0.05), new THREE.Vector3(-4, 5.0, STERN - 0.05), new THREE.Vector3(0, 0, -1), C.dark));
  for (const s of [-1, 1]) {
    hull.push(topsidePatch(-8, -6.6, 0.05, 0.7, s, C.door), topsidePatch(-40, -38.6, 0.05, 0.7, s, C.door), topsidePatch(-56, -50, 0.35, 0.75, s, C.dark));
  }
  // Guard rails round the deck edge and across the stern
  for (const s of [-1, 1]) {
    let prev: THREE.Vector3 | null = null;
    for (let z = STERN + 0.4; z <= 61; z += 3.05) {
      const st = station(z);
      const p = new THREE.Vector3(s * (st[1] - 0.12), st[6], z);
      hull.push(beam([p.x, p.y, p.z], [p.x, p.y + 1.05, p.z], 0.035, C.hull));
      if (prev) for (const h of [0.5, 1.05]) hull.push(beam([prev.x, prev.y + h, prev.z], [p.x, p.y + h, p.z], 0.028, C.hull));
      prev = p;
    }
  }
  for (const h of [0.5, 1.05]) hull.push(beam([-6.4, DECK + h, STERN + 0.4], [6.4, DECK + h, STERN + 0.4], 0.028, C.hull));
  // Mooring bollards
  for (const z of [50, 40, -48, -58]) {
    const hw = station(z)[1] - 1.1;
    for (const s of [-1, 1]) for (const dz of [-0.35, 0.35]) hull.push(paint(new THREE.CylinderGeometry(0.2, 0.22, 0.55, 8).translate(s * hw, station(z)[6] + 0.27, z + dz), C.dark));
  }

  // Bow gun: a faceted stealth turret
  const gun = (y: number, pts: [number, number][]): V3[] => pts.map(([x, z]) => [x, y, z + 45] as V3);
  hull.push(
    paint(new THREE.CylinderGeometry(2.1, 2.2, 0.3, 16).translate(0, DECK + 0.15, 45), C.hull),
    loft(
      [
        gun(DECK + 0.3, [[1.0, 2.4], [-1.0, 2.4], [-1.8, 0.2], [-1.6, -2.3], [1.6, -2.3], [1.8, 0.2]]),
        gun(DECK + 2.0, [[0.6, 1.7], [-0.6, 1.7], [-1.35, 0.1], [-1.25, -2.0], [1.25, -2.0], [1.35, 0.1]]),
      ],
      (e, seg) => (seg === 1 ? C.hullLight : e === 0 ? C.hull : C.hullLight),
    ),
    paint(new THREE.CylinderGeometry(0.32, 0.32, 1.0, 10).rotateX(Math.PI / 2).translate(0, DECK + 1.05, 47), C.hull),
    paint(new THREE.CylinderGeometry(0.13, 0.17, 6.2, 10).rotateX(Math.PI / 2).translate(0, DECK + 1.05, 50), C.dark),
    paint(new THREE.CylinderGeometry(0.2, 0.2, 0.45, 10).rotateX(Math.PI / 2).translate(0, DECK + 1.05, 52.9), C.dark),
  );

  // Harpoon racks angled out over either beam
  for (const s of [-1, 1]) {
    hull.push(box(1.7, 0.8, 2.2, C.hull, s * 2.6, DECK + 0.4, 17));
    for (const x of [-0.36, 0.36]) {
      for (const y of [-0.34, 0.34]) {
        const tube = paint(new THREE.CylinderGeometry(0.32, 0.32, 4.4, 10).rotateX(Math.PI / 2).translate(x, y, 0), C.hullLight);
        const end = paint(new THREE.CircleGeometry(0.29, 10).translate(x, y, 2.21), C.dark);
        for (const g of [tube, end]) hull.push(g.rotateX(-0.2).rotateY(s * 0.45).translate(s * 2.6, DECK + 1.5, 17));
      }
    }
  }

  // VLS block on the foredeck: 2 × 4 cell hatches round which the lids hinge
  hull.push(box(5.4, 0.8, 8.4, C.deck, VLS_AT.x, DECK + 0.4, VLS_AT.z));
  for (const [x, z] of VLS_CELLS) hull.push(box(1.9, 0.05, 1.7, C.dark, x, DECK + 0.83, VLS_AT.z + z));

  // Bridge block, pilothouse, the enclosed mast and its sensor faces
  hull.push(frustum(BRIDGE, C.hull), frustum(PILOTHOUSE, C.hullLight), frustum(MAST, C.hull));
  glass.push(panelOn(BRIDGE, 'f', -0.82, 0.82, 0.78, 0.9, 0), panelOn(BRIDGE, 'l', -0.95, -0.6, 0.78, 0.9, 0), panelOn(BRIDGE, 'r', 0.6, 0.95, 0.78, 0.9, 0));
  glass.push(panelOn(PILOTHOUSE, 'f', -0.8, 0.8, 0.4, 0.72, 0), panelOn(PILOTHOUSE, 'l', -0.9, -0.4, 0.4, 0.72, 0), panelOn(PILOTHOUSE, 'r', 0.4, 0.9, 0.4, 0.72, 0));
  for (const f of ['l', 'r'] as const) hull.push(panelOn(BRIDGE, f, -0.25, -0.15, 0, 0.24, C.door), panelOn(BRIDGE, f, 0.45, 0.55, 0, 0.24, C.door));
  for (const f of ['f', 'b', 'l', 'r'] as const) hull.push(panelOn(MAST, f, -0.55, 0.55, 0.52, 0.72, C.dark));
  hull.push(box(4.0, 0.35, 4.0, C.hull, 0, DECK + 24.75, -6), paint(new THREE.CylinderGeometry(0.55, 0.7, 2.4, 10).translate(0, DECK + 26.1, -6), C.hull));
  hull.push(beam([-4.2, DECK + 22.5, -6.3], [4.2, DECK + 22.5, -6.3], 0.1, C.hull));
  for (const s of [-1, 1]) {
    hull.push(beam([s * 4.0, DECK + 22.5, -6.3], [s * 4.1, DECK + 26.8, -6.3], 0.03, C.dark));
    // Satcom domes on sponsons either side of the mast
    hull.push(box(1.4, 0.2, 1.4, C.hull, s * 2.75, DECK + 16.9, -4.6), paint(new THREE.SphereGeometry(0.8, 14, 10).translate(s * 2.75, DECK + 17.75, -4.6), C.white));
  }

  // Funnel: chamfered, raked aft, black-capped
  const oct = (y: number, hx: number, hz: number, zc: number): V3[] => {
    const c = 0.35 * Math.min(hx, hz);
    return [
      [hx, y, zc + hz - c], [hx - c, y, zc + hz], [-hx + c, y, zc + hz], [-hx, y, zc + hz - c],
      [-hx, y, zc - hz + c], [-hx + c, y, zc - hz], [hx - c, y, zc - hz], [hx, y, zc - hz + c],
    ];
  };
  hull.push(loft([oct(DECK, 3.0, 3.3, -18), oct(DECK + 7.6, 2.4, 2.75, -18.8), oct(DECK + 8.6, 2.3, 2.65, -18.9)], (_e, seg) => (seg >= 1 ? C.dark : C.hull)));
  for (const s of [-1, 1]) hull.push(paint(new THREE.CylinderGeometry(0.45, 0.45, 1.0, 10).translate(s * 0.9, DECK + 9.0, -19.1), C.dark));

  // RHIBs on davits abreast the funnel
  for (const s of [-1, 1]) {
    const sec = (z: number, w: number, lift: number): V3[] =>
      [[0, -0.5], [0.7, -0.2], [1.0, 0.25], [1.05, 0.55], [0.75, 0.75], [-0.75, 0.75], [-1.05, 0.55], [-1.0, 0.25], [-0.7, -0.2]].map(([x, y]) => [s * 5.3 + x * w, DECK + 1.4 + y + lift, -18 + z] as V3);
    hull.push(loft([sec(-3.4, 0.85, 0), sec(1.0, 1, 0), sec(2.6, 0.7, 0.15), sec(3.6, 0.15, 0.3)], (e) => (e >= 2 && e <= 6 && e !== 4 ? C.rhib : e === 4 ? C.dark : C.rhibHull)));
    hull.push(box(0.6, 0.5, 0.7, C.rhibHull, s * 5.3, DECK + 2.4, -18.6));
    for (const dz of [-2.4, 2.4]) {
      hull.push(
        beam([s * 7.0, DECK, -18 + dz], [s * 7.0, DECK + 3.3, -18 + dz], 0.1, C.hull),
        beam([s * 7.0, DECK + 3.3, -18 + dz], [s * 5.3, DECK + 3.6, -18 + dz], 0.1, C.hull),
        beam([s * 5.3, DECK + 3.6, -18 + dz], [s * 5.3, DECK + 2.1, -18 + dz], 0.02, C.dark),
      );
    }
  }

  // Hangar, its rolling door, life-raft canisters along the roof edges
  hull.push(frustum(HANGAR, C.hull), panelOn(HANGAR, 'b', -0.68, 0.68, 0, 0.78, C.door));
  for (let k = 1; k < 7; k++) hull.push(panelOn(HANGAR, 'b', -0.68, 0.68, k * 0.11, k * 0.11 + 0.012, C.dark, 0.05));
  for (const s of [-1, 1]) for (let z = -24.5; z > -36; z -= 2.1) hull.push(paint(new THREE.CylinderGeometry(0.32, 0.32, 1.0, 10).rotateZ(Math.PI / 2).translate(s * 5.4, DECK + 7.35, z), C.white));
  // Flight deck: touchdown circle and lines
  hull.push(
    paint(new THREE.RingGeometry(3.4, 3.7, 32).rotateX(-Math.PI / 2).translate(0, DECK + 0.03, -50), C.mark),
    box(0.25, 0.02, 21, C.mark, 0, DECK + 0.02, -50.5),
    box(8, 0.02, 0.25, C.mark, 0, DECK + 0.02, -50),
  );

  // CIWS: pedestal (static), turntable + trunnions (yaw), radome + gatling (pitch)
  const ciwsBase = merge([paint(new THREE.CylinderGeometry(1.3, 1.5, 1.2, 14).translate(0, 0.6, 0), C.hull), paint(new THREE.CylinderGeometry(1.2, 1.3, 0.12, 14).translate(0, 1.2, 0), C.dark)]);
  const ciwsYaw = merge([
    paint(new THREE.CylinderGeometry(1.1, 1.1, 0.3, 16).translate(0, 0.15, 0), C.white),
    box(0.22, 1.0, 0.8, C.white, 0.85, 0.65, CIWS_PIVOT.z - 0.1),
    box(0.22, 1.0, 0.8, C.white, -0.85, 0.65, CIWS_PIVOT.z - 0.1),
    box(1.2, 0.8, 0.6, C.white, 0, 0.55, -0.75),
  ]);
  const pitch: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(0.95, 0.95, 1.5, 18).translate(0, 0.9, -0.5), C.white),
    paint(new THREE.SphereGeometry(0.95, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.65, -0.5), C.white),
    paint(new THREE.CylinderGeometry(0.97, 0.97, 0.12, 18).translate(0, 0.3, -0.5), C.dark),
    paint(new THREE.CylinderGeometry(0.35, 0.35, 1.1, 12).rotateX(Math.PI / 2).translate(0, -0.25, -0.6), C.white),
    box(0.55, 0.45, 0.9, C.dark, 0, 0, -0.05),
    paint(new THREE.CylinderGeometry(0.19, 0.19, 0.12, 10).rotateX(Math.PI / 2).translate(0, 0, 0.6), C.dark),
    paint(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 10).rotateX(Math.PI / 2).translate(0, 0, 2.25), C.dark),
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    pitch.push(paint(new THREE.CylinderGeometry(0.04, 0.04, 2.3, 6).rotateX(Math.PI / 2).translate(Math.cos(a) * 0.12, Math.sin(a) * 0.12, 1.25), C.dark));
  }

  // Search radar: a twin-faced, back-tilted array on a bearing
  const arr = (x: number): V3[] => [[x, -0.95, 0.5], [x, 0.95, 0.12], [x, 0.95, -0.12], [x, -0.95, -0.5]];
  const radar = merge([
    paint(new THREE.CylinderGeometry(0.4, 0.45, 0.9, 12).translate(0, -1.4, 0), C.hull),
    loft([arr(-2.6), arr(2.6)], (e, seg) => (seg < 0 || seg > 0 || e === 1 || e === 3 ? C.hull : C.dark)),
  ]);

  // Hull number either side of the bow
  const pos: number[] = [];
  const uv: number[] = [];
  for (const s of [-1, 1]) {
    const [z0, z1] = s > 0 ? [51.4, 44.6] : [44.6, 51.4];
    const corner = (u: number, v: number) => topside(z0 + (z1 - z0) * u, 0.2 + v * 0.65, s);
    const n = new THREE.Vector3().crossVectors(corner(1, 0).sub(corner(0, 0)), corner(0, 1).sub(corner(0, 0))).normalize();
    const flip = n.x * s < 0;
    if (flip) n.negate();
    const tri = (pts: [number, number][]) => {
      for (const [u, v] of flip ? [pts[0], pts[2], pts[1]] : pts) {
        pos.push(...corner(u, v).addScaledVector(n, 0.08).toArray());
        uv.push(u, v);
      }
    };
    tri([[0, 0], [1, 0], [1, 1]]);
    tri([[0, 0], [1, 1], [0, 1]]);
  }
  const number = new THREE.BufferGeometry();
  number.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  number.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  number.computeVertexNormals();

  geoCache = {
    hull: merge(hull),
    glass: merge(glass),
    number,
    lid: box(1.9, 0.12, 1.7, C.hull, 0, 0.06, 0),
    radar,
    ciwsBase,
    ciwsYaw,
    ciwsPitch: merge(pitch),
  };
  return geoCache;
}

/** The pennant number painted on the bow. */
function numberMaterial(): THREE.MeshStandardMaterial {
  if (!numberMat) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 160;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.font = 'bold 128px "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('H 47', 256, 86);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    numberMat = new THREE.MeshStandardMaterial({ map, color: 0xe2e2dc, alphaTest: 0.45, roughness: 0.7, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  return numberMat;
}

type PartRole = 'radar' | 'ciws' | 'vls' | 'hull';

const PART_STATS: Record<PartRole, { hp: number; radius: number; label: string }> = {
  radar: { hp: 260, radius: 3.6, label: 'RADAR' },
  ciws: { hp: 300, radius: 3, label: 'CIWS' },
  vls: { hp: 450, radius: 5, label: 'VLS' },
  hull: { hp: 2600, radius: 9, label: 'HULL' },
};

let nextId = 5000;

/** One lockable, destructible piece of the ship. */
export class ShipPart implements Hostile {
  readonly id = nextId++;
  readonly kind = 'ship' as const;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius: number;
  readonly maxHp: number;
  hp: number;
  alive = true;
  threatened = 0;
  readonly span?: readonly [THREE.Vector3, THREE.Vector3];
  /** Burning since it was knocked out (s). */
  burnT = 0;

  constructor(
    readonly ship: Frigate,
    readonly role: PartRole,
    /** Hit centre in the ship's frame. */
    readonly local: THREE.Vector3,
    /** What gets hidden when it's shot away. */
    readonly visual: THREE.Object3D | null,
  ) {
    const s = PART_STATS[role];
    this.radius = s.radius;
    this.maxHp = this.hp = s.hp;
    if (role === 'hull') this.span = [new THREE.Vector3(), new THREE.Vector3()];
  }

  get label(): string {
    return this.role === 'hull' && this.ship.armed ? 'HULL ARMD' : PART_STATS[this.role].label;
  }

  damage(amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (!this.alive) return false;
    void at;
    // Belt armour: a fighting ship shrugs off most of it; the beam cuts best
    if (this.role === 'hull' && this.ship.armed) amount *= kind === 'unibeam' ? 0.5 : 0.12;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;
    }
    return false;
  }
}

interface Ciws {
  part: ShipPart;
  /** Yaw and pitch groups, and the muzzle in the pitch group's frame. */
  yaw: THREE.Group;
  pitch: THREE.Group;
  /** Forward mount (it can't fire aft past the mast), or aft (can't fire forward past the bridge). */
  fwd: boolean;
  fireT: number;
  pauseT: number;
  roundAcc: number;
  soundT: number;
  track: number;
}

interface Cell {
  lid: THREE.Group;
  at: THREE.Vector3;
  open: number;
  firing: number;
}

export class Frigate {
  readonly mesh = new THREE.Group();
  readonly parts: ShipPart[] = [];
  readonly hull: ShipPart;
  readonly radar: ShipPart;
  readonly vls: ShipPart;
  /** Waterline origin, velocity and heading (rad, +Z = 0). */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  heading = 0;
  sinking = false;
  /** The hull's armour is open (announced once). */
  private opened = false;
  /** Gone under (the manager removes it). */
  sunk = false;
  private sinkT = 0;
  private speed = SPEED;
  private readonly centre = new THREE.Vector3();
  private readonly ciws: Ciws[] = [];
  private readonly cells: Cell[] = [];
  private readonly radarHead = new THREE.Group();
  private readonly lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), mats.lamp);
  private vlsReload = 6;
  private vlsSalvo = 0;
  private vlsT = 0;
  private nextCell = 0;
  private wakeT = 0;
  private burnT = 0;
  private list = 0;
  private trim = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _q2 = new THREE.Vector3();
  private readonly _qi = new THREE.Quaternion();

  constructor(field: Heightfield, near: THREE.Vector3) {
    this.build();
    this.hull = this.parts.find((p) => p.role === 'hull')!;
    this.radar = this.parts.find((p) => p.role === 'radar')!;
    this.vls = this.parts.find((p) => p.role === 'vls')!;
    // Patrol: a circle of deep water off the coast, entered at the point nearest the suit
    this.centre.set(near.x, 0, coastZ(near.x) + PATROL_R + 1100);
    for (let k = 0; k < 24 && !this.deep(field, this.centre, PATROL_R); k++) this.centre.z += 400;
    const a = Math.atan2(near.z - this.centre.z, near.x - this.centre.x);
    this.pos.set(this.centre.x + Math.cos(a) * PATROL_R, 0, this.centre.z + Math.sin(a) * PATROL_R);
    // Anticlockwise round the circle (seen from above, +X right, +Z down)
    this.heading = Math.atan2(-Math.sin(a), Math.cos(a));
    this.place(0);
  }

  /** The guns and cells still fight (the hull is armoured while they do). */
  get armed(): boolean {
    return this.parts.some((p) => p.alive && (p.role === 'ciws' || p.role === 'vls'));
  }

  private deep(field: Heightfield, c: THREE.Vector3, r: number): boolean {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      for (const f of [0.75, 1, 1.25]) if (field.heightAt(c.x + Math.cos(a) * r * f, c.z + Math.sin(a) * r * f) > -18) return false;
    }
    return true;
  }

  // ── Model ────────────────────────────────────────────────────────────
  private build(): void {
    const g = frigateGeometry();
    this.mesh.add(new THREE.Mesh(g.hull, mats.paint), new THREE.Mesh(g.glass, mats.glass), new THREE.Mesh(g.number, numberMaterial()));

    // VLS lids, hinged at their outboard edges
    for (const [x, z] of VLS_CELLS) {
      const lid = new THREE.Group();
      lid.position.set(VLS_AT.x + x + (x > 0 ? 0.95 : -0.95), DECK + 0.86, VLS_AT.z + z);
      const plate = new THREE.Mesh(g.lid, mats.paint);
      plate.position.x = x > 0 ? -0.95 : 0.95;
      lid.add(plate);
      this.mesh.add(lid);
      this.cells.push({ lid, at: new THREE.Vector3(VLS_AT.x + x, DECK + 1, VLS_AT.z + z), open: 0, firing: 0 });
    }
    this.parts.push(new ShipPart(this, 'vls', new THREE.Vector3(0, DECK + 1.2, 30), null));

    // The mast's search radar
    this.radarHead.position.set(0, DECK + 28.3, -6);
    this.radarHead.add(new THREE.Mesh(g.radar, mats.paint));
    this.lamp.position.set(0, 1.2, 0);
    this.radarHead.add(this.lamp);
    this.mesh.add(this.radarHead);
    this.parts.push(new ShipPart(this, 'radar', new THREE.Vector3(0, DECK + 28.3, -6), this.radarHead));

    // CIWS mounts: forward on the bridge roof, aft on the hangar
    this.addCiws(new THREE.Vector3(0, DECK + 9, 6), true);
    this.addCiws(new THREE.Vector3(0, DECK + 7, -33), false);

    this.parts.push(new ShipPart(this, 'hull', new THREE.Vector3(0, DECK + 2, -2), null));
    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
  }

  private addCiws(at: THREE.Vector3, fwd: boolean): void {
    const g = frigateGeometry();
    const root = new THREE.Group();
    root.position.copy(at);
    root.add(new THREE.Mesh(g.ciwsBase, mats.paint));
    const yaw = new THREE.Group();
    yaw.position.y = 1.2;
    yaw.rotation.y = fwd ? 0 : Math.PI;
    yaw.add(new THREE.Mesh(g.ciwsYaw, mats.paint));
    const pitch = new THREE.Group();
    pitch.position.copy(CIWS_PIVOT);
    pitch.add(new THREE.Mesh(g.ciwsPitch, mats.paint));
    yaw.add(pitch);
    root.add(yaw);
    this.mesh.add(root);
    const part = new ShipPart(this, 'ciws', at.clone().add(new THREE.Vector3(0, 2, 0)), yaw);
    this.parts.push(part);
    this.ciws.push({ part, yaw, pitch, fwd, fireT: 0, pauseT: 1 + Math.random(), roundAcc: 0, soundT: 0, track: 0 });
  }

  // ── Sim ──────────────────────────────────────────────────────────────
  update(dt: number, t: number, player: PlayerTarget, field: Heightfield, rounds: Round[], missiles: Missiles, particles: Particles, explosions: Explosions, events: EventBus): void {
    if (this.sunk) return;
    if (!this.sinking && !this.hull.alive) this.scuttle(explosions, events);
    this.steer(dt, field);
    this.place(t);
    if (this.sinking) {
      this.sink(dt, particles, explosions);
      return;
    }
    const radar = this.radar.alive;
    this.radarHead.rotation.y = radar ? t * 2.2 : this.radarHead.rotation.y;
    (this.lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = 3 + 2 * Math.sin(t * 6);
    for (const c of this.ciws) if (c.part.alive) this.updateCiws(c, dt, player, field, rounds, particles, events, radar);
    if (this.vls.alive) this.updateVls(dt, player, field, missiles, particles, explosions, events, radar);
    this.wake(dt, particles);
    this.burn(dt, particles);
  }

  /** Round the patrol circle, turning seaward off any shoal. */
  private steer(dt: number, field: Heightfield): void {
    if (this.sinking) this.speed = Math.max(0, this.speed - dt * 0.4);
    const rx = this.pos.x - this.centre.x;
    const rz = this.pos.z - this.centre.z;
    const r = Math.hypot(rx, rz);
    // Tangent (anticlockwise), pulled in or out onto the circle
    let wx = -rz / r - (rx / r) * ((r - PATROL_R) / PATROL_R) * 3;
    let wz = rx / r - (rz / r) * ((r - PATROL_R) / PATROL_R) * 3;
    const ax = this.pos.x + Math.sin(this.heading) * 300;
    const az = this.pos.z + Math.cos(this.heading) * 300;
    if (field.heightAt(ax, az) > -14) {
      wx = -rx;
      wz = -rz;
    }
    const want = Math.atan2(wx, wz);
    const turn = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
    this.heading += THREE.MathUtils.clamp(turn, -0.04 * dt, 0.04 * dt);
    this.vel.set(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
  }

  /** Ride the swell; carry every part's hit point along. */
  private place(t: number): void {
    const bob = Math.sin(t * 0.52) * 0.35 + Math.sin(t * 0.83 + 1.3) * 0.15;
    const pitch = Math.sin(t * 0.37) * 0.012 + this.trim;
    const roll = Math.sin(t * 0.29 + 1) * 0.028 + this.list;
    this.mesh.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.mesh.rotation.set(-pitch, this.heading, roll, 'YXZ');
    this.mesh.updateMatrixWorld();
    for (const p of this.parts) {
      p.pos.copy(p.local).applyMatrix4(this.mesh.matrixWorld);
      p.vel.copy(this.vel);
      if (p.span) {
        (p.span[0] as THREE.Vector3).set(0, DECK - 1, STERN + 6).applyMatrix4(this.mesh.matrixWorld);
        (p.span[1] as THREE.Vector3).set(0, DECK - 1, BOW - 8).applyMatrix4(this.mesh.matrixWorld);
      }
    }
  }

  private updateCiws(c: Ciws, dt: number, player: PlayerTarget, field: Heightfield, rounds: Round[], particles: Particles, events: EventBus, radar: boolean): void {
    const at = c.part.pos;
    const to = this._v.copy(player.pos).sub(at);
    const dist = to.length();
    const flat = Math.hypot(to.x, to.z);
    let can = player.alive && dist < (radar ? CIWS_RANGE : CIWS_RANGE_BLIND);
    // Lost in the sea clutter
    if (can && player.pos.y < CLUTTER_HEIGHT && flat > CLUTTER_RANGE) can = false;
    // Lead, in the ship's frame
    const tgo = dist / CIWS_ROUND;
    const lead = this._w.copy(player.pos).addScaledVector(player.vel, tgo).addScaledVector(this.vel, -tgo).sub(at);
    this._qi.copy(this.mesh.quaternion).invert();
    const local = lead.applyQuaternion(this._qi);
    const elev = Math.atan2(local.y, Math.hypot(local.x, local.z));
    // Arcs: the mast and funnel mask the forward mount aft, the bridge the aft one forward
    const ahead = local.z / Math.max(1e-3, Math.hypot(local.x, local.z));
    if (can && elev < 0.35 && (c.fwd ? ahead < -0.6 : ahead > 0.6)) can = false;
    if (can && field.raycast(at, this._v.copy(to).normalize(), dist - 5) >= 0) can = false;
    if (can) {
      c.track += dt;
      const wantYaw = Math.atan2(local.x, local.z);
      const wantPitch = THREE.MathUtils.clamp(elev, -0.15, 1.35);
      const dy = Math.atan2(Math.sin(wantYaw - c.yaw.rotation.y), Math.cos(wantYaw - c.yaw.rotation.y));
      c.yaw.rotation.y += THREE.MathUtils.clamp(dy, -CIWS_SLEW * dt, CIWS_SLEW * dt);
      const dp = -wantPitch - c.pitch.rotation.x;
      c.pitch.rotation.x += THREE.MathUtils.clamp(dp, -CIWS_SLEW * dt, CIWS_SLEW * dt);
      const err = Math.hypot(dy * Math.cos(elev), dp);
      // Bursts on, pauses off, while it has the suit in the barrels
      if (c.fireT > 0) {
        c.fireT -= dt;
        if (c.fireT <= 0) this.ceaseFire(c, events);
      } else if (c.pauseT > 0) c.pauseT -= dt;
      else if (err < 0.06 && c.track > 0.8) {
        c.fireT = CIWS_BURST;
        c.pauseT = CIWS_PAUSE;
      }
    } else {
      c.track = 0;
      if (c.fireT > 0) this.ceaseFire(c, events);
      c.fireT = 0;
      c.pauseT = Math.max(c.pauseT, 0.6);
    }
    if (c.fireT <= 0) return;
    c.yaw.updateMatrixWorld();
    const muzzle = this._w.set(0, 0, 2.6).applyMatrix4(c.pitch.matrixWorld);
    const dir = this._v.set(0, 0, 1).transformDirection(c.pitch.matrixWorld);
    const spread = radar ? 0.004 : 0.012;
    c.roundAcc += dt * CIWS_RATE;
    while (c.roundAcc >= 1) {
      c.roundAcc--;
      const d = dir.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spread * 2)).normalize();
      rounds.push({ p: muzzle.clone(), v: d.multiplyScalar(CIWS_ROUND).add(this.vel), life: 1.9, dmg: CIWS_DAMAGE });
      if (Math.random() < 0.5) particles.emit('flash', muzzle, this.vel, { scale: 0.12 });
    }
    if (Math.random() < dt * 8) particles.emit('smoke', muzzle, this.vel, { scale: 0.35, life: 0.5 });
    // The buzz-saw is laid down in overlapping slices (see Soundscape)
    c.soundT -= dt;
    if (c.soundT <= 0) {
      c.soundT += 0.24;
      if (c.soundT <= 0) c.soundT = 0.24;
      events.emit('enemyFire', { at: muzzle.clone(), text: 'ciws' });
    }
  }

  /** A burst stops: its echo rolls back off the land. */
  private ceaseFire(c: Ciws, events: EventBus): void {
    c.soundT = 0;
    events.emit('enemyFire', { at: c.part.pos.clone(), text: 'ciwsCease' });
  }

  /** Fire-control radars that have the suit (the RWR's lock warning). */
  *trackers(): Generator<THREE.Vector3> {
    for (const c of this.ciws) if (c.part.alive && c.track > 0.3) yield c.part.pos;
  }

  private updateVls(dt: number, player: PlayerTarget, field: Heightfield, missiles: Missiles, particles: Particles, explosions: Explosions, events: EventBus, radar: boolean): void {
    // Lids: open a beat before a round leaves, shut after
    for (const cell of this.cells) {
      cell.firing = Math.max(0, cell.firing - dt);
      cell.open += ((cell.firing > 0 ? 1 : 0) - cell.open) * Math.min(1, dt * 6);
      cell.lid.rotation.z = cell.open * (cell.lid.position.x > 0 ? -1.9 : 1.9);
    }
    this.vlsReload -= dt;
    const dist = player.pos.distanceTo(this.vls.pos);
    // Cued by the mast radar from its height, else only what the deck can see close in
    const eye = radar ? this.radar.pos : this.vls.pos;
    const range = radar ? VLS_RANGE : VLS_RANGE_BLIND;
    if (this.vlsSalvo === 0 && this.vlsReload <= 0 && player.alive && dist < range) {
      const to = this._v.copy(player.pos).sub(eye);
      const d = to.length();
      if (field.raycast(eye, to.normalize(), d - 5) < 0) {
        this.vlsSalvo = VLS_SALVO;
        this.vlsT = 0.35;
        this.vlsReload = 15 + Math.random() * 6;
        // The salvo's lids open first
        for (let k = 0; k < VLS_SALVO; k++) this.cells[(this.nextCell + k) % this.cells.length].firing = 0.35 + k * VLS_GAP + 0.6;
      }
    }
    if (this.vlsSalvo <= 0) return;
    this.vlsT -= dt;
    if (this.vlsT > 0) return;
    this.vlsSalvo--;
    this.vlsT = VLS_GAP;
    const cell = this.cells[this.nextCell++ % this.cells.length];
    const from = cell.at.clone().applyMatrix4(this.mesh.matrixWorld);
    const up = this._w.set(0, 1, 0).transformDirection(this.mesh.matrixWorld);
    missiles.launch({ team: 'enemy', from, vel: up.clone().multiplyScalar(42).add(this.vel), target: player, coast: 0.6 });
    explosions.muzzle(from, up, 2.2);
    particles.burst('smoke', from, 6, 6, up, 1.2, { scale: 0.9 });
    events.emit('enemyMissile', { at: from, value: 1 });
  }

  /** Bow wave down both sides and the white water of the screws. */
  private wake(dt: number, particles: Particles): void {
    if (this.speed < 1) return;
    this.wakeT += dt;
    while (this.wakeT > 0.09) {
      this.wakeT -= 0.09;
      for (const s of [-1, 1]) {
        const at = this._v.set(s * 3.5, 0.6, BOW - 10).applyMatrix4(this.mesh.matrixWorld);
        const out = this._w.set(s * 4, 2, 2).transformDirection(this.mesh.matrixWorld).multiplyScalar(5).add(this.vel);
        particles.emit('spray', at, out, { scale: 1.6 });
      }
      const stern = this._v.set((Math.random() - 0.5) * 8, 0.4, STERN - 2).applyMatrix4(this.mesh.matrixWorld);
      particles.emit('mist', stern, this._w.set(0, 0.6, 0), { scale: 1.6, life: 2.5 });
    }
  }

  /** Smoke and fire off anything shot away. */
  private burn(dt: number, particles: Particles): void {
    this.burnT += dt;
    if (this.burnT < 0.06) return;
    const step = this.burnT;
    this.burnT = 0;
    for (const p of this.parts) {
      if (p.alive || p.role === 'hull') continue;
      p.burnT += step;
      const k = Math.max(0.3, 1 - p.burnT / 40);
      particles.emit('darkSmoke', p.pos, this._v.set(0, 3, 0).add(this.vel), { scale: 0.7 * k });
      if (Math.random() < 0.7 * k) particles.emit('fire', p.pos, this._w.set(0, 2, 0).add(this.vel), { scale: 0.7 * k });
    }
  }

  /** A part was shot away: it blows, and what's left of it is scorched black. */
  partDestroyed(p: ShipPart, explosions: Explosions, events: EventBus): void {
    explosions.blast(p.pos, p.role === 'vls' ? 12 : 8, { debris: 12, vel: this.vel });
    if (p.visual) {
      p.visual.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mats.charred;
      });
      if (p.role === 'ciws') p.visual.rotation.z = 0.5;
      if (p.role === 'radar') p.visual.rotation.x = 0.8;
    }
    if (p.role === 'radar') events.emit('jarvis', { text: 'Their search radar is down. The guns are firing blind.' });
    else if (p.role !== 'hull' && !this.armed && !this.opened) {
      this.opened = true;
      events.emit('jarvis', { text: 'She is disarmed, sir. The hull armour is open.' });
    }
  }

  private scuttle(explosions: Explosions, events: EventBus): void {
    this.sinking = true;
    this.sinkT = 0;
    for (const p of this.parts) p.alive = false;
    explosions.blast(this.hull.pos, 22, { debris: 30, burn: false, vel: this.vel });
    events.emit('jarvis', { text: 'Her back is broken. The frigate is going down.' });
  }

  private sink(dt: number, particles: Particles, explosions: Explosions): void {
    this.sinkT += dt;
    const k = this.sinkT;
    // Lists to port, settles by the stern, and goes
    this.list = Math.min(0.42, k * 0.02);
    this.trim = -Math.min(0.14, k * 0.006);
    this.pos.y = -0.04 * k * k;
    // Secondaries along the deck while she still floats
    if (k < 14 && Math.random() < dt * 0.9) {
      const at = this._v.set((Math.random() - 0.5) * 10, DECK + 2, STERN + Math.random() * (BOW - STERN)).applyMatrix4(this.mesh.matrixWorld);
      explosions.blast(at, 6 + Math.random() * 6, { debris: 6, vel: this.vel });
    }
    this.burnT += dt;
    if (this.burnT > 0.05) {
      this.burnT = 0;
      const fade = Math.max(0, 1 - k / 40);
      for (let i = 0; i < 3; i++) {
        const at = this._v.set((Math.random() - 0.5) * 10, DECK + 3, STERN + Math.random() * (BOW - STERN)).applyMatrix4(this.mesh.matrixWorld);
        if (at.y < -1) continue;
        particles.emit('darkSmoke', at, this._w.set(0, 4, 0), { scale: 1.3 * fade + 0.3 });
        if (Math.random() < 0.6) particles.emit('fire', at, this._w.set(0, 2.5, 0), { scale: 1.2 });
      }
      if (this.pos.y > -12) {
        const at = this._v.set((Math.random() - 0.5) * 14, 0, STERN + Math.random() * (BOW - STERN)).applyMatrix4(this.mesh.matrixWorld).setY(0.3);
        particles.emit('mist', at, this._w.set(0, 1.5, 0), { scale: 2 });
      }
    }
    if (k > 42) {
      this.sunk = true;
      this.mesh.visible = false;
    }
  }

  // ── Contact ──────────────────────────────────────────────────────────
  /** Keep the suit out of the steel: push it clear of the hull and the blocks on deck. */
  collide(p: THREE.Vector3, v: THREE.Vector3): void {
    if (this.sunk || p.distanceToSquared(this.mesh.position) > 90 * 90) return;
    this._qi.copy(this.mesh.quaternion).invert();
    const local = this._v.copy(p).sub(this.mesh.position).applyQuaternion(this._qi);
    const boxes: [number, number, number, number, number, number][] = [
      // x half-width, y0, y1, z0, z1, extra pad
      [7.6, -4, DECK, STERN, BOW, 0],
      [6, DECK, DECK + 9, -13, 9, 0],
      [4.5, DECK + 9, DECK + 12, -10.5, -1.5, 0],
      [6.5, DECK, DECK + 7, -38, -22, 0],
    ];
    const pad = 1.2;
    for (const [hw, y0, y1, z0, z1] of boxes) {
      const pen = [
        local.x + hw + pad, hw + pad - local.x,
        local.y - (y0 - pad), y1 + pad - local.y,
        local.z - (z0 - pad), z1 + pad - local.z,
      ];
      if (pen.some((d) => d <= 0)) continue;
      let best = 0;
      for (let i = 1; i < 6; i++) if (pen[i] < pen[best]) best = i;
      const axis = this._w.set(0, 0, 0);
      const sign = best % 2 ? 1 : -1;
      axis.setComponent(Math.floor(best / 2), sign);
      local.addScaledVector(axis, pen[best]);
      // Back to the world; kill the speed into the steel (relative to the ship)
      const n = axis.applyQuaternion(this.mesh.quaternion);
      const into = this._q2.copy(v).sub(this.vel).dot(n);
      if (into < 0) v.addScaledVector(n, -into);
    }
    p.copy(local.applyQuaternion(this.mesh.quaternion).add(this.mesh.position));
  }
}
