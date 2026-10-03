import type { ArmorPieceId } from '../suit/armorPieces';
import { boneAxis, type Vec3 } from '../suit/rig';

/**
 * The workshop cell: where each robot stands and what it does.
 *
 * Coordinates are world space with the floor at y = 0 and the suit centred on
 * the platform facing +Z (the suit's own left is +X). Every task names the
 * SFX beat its clamp lands on (see `SFX_ONSETS` in the choreography).
 *
 * Two kinds of arm share the cell: grippers carry and seat parts, riveters
 * punch rivets on the ratchet clicks. The
 * build goes inside → out: the reactor housing before the pecs, shoulders
 * before biceps before forearms before gauntlets.
 */

export type RobotId =
  | 'bl'
  | 'br'
  | 'sl'
  | 'sr'
  | 'fl'
  | 'fr'
  | 'cl'
  | 'cr'
  | 'cf'
  | 'cb'
  | 'rl'
  | 'rr';

export type ToolKind = 'gripper' | 'riveter';

export interface RobotStation {
  id: RobotId;
  label: string;
  /** Mount point (top of the pedestal, or the mast flange for ceiling arms). */
  base: Vec3;
  mount: 'floor' | 'ceiling';
  /** Pedestal height under a floor arm (visual + reach). */
  pedestal: number;
  tool: ToolKind;
}

/** Arm geometry shared by every station (6-axis, KUKA-class proportions). */
export const ARM_DIMS = {
  /** Mount → shoulder axis. */
  shoulder: 0.42,
  upper: 0.76,
  fore: 0.76,
  /** Wrist centre → tool centre point (flange + gripper). */
  wristToTcp: 0.28,
} as const;

/** Long-reach model for the riveters, parked further out. */
export const TOOL_ARM_DIMS = {
  shoulder: 0.42,
  upper: 0.88,
  fore: 0.88,
  wristToTcp: 0.28,
} as const;

/** Arm proportions for a station. */
export function armDims(st: RobotStation): typeof ARM_DIMS | typeof TOOL_ARM_DIMS {
  return st.tool === 'gripper' ? ARM_DIMS : TOOL_ARM_DIMS;
}

/** Mast flange height the ceiling arms hang from. */
export const GANTRY_Y = 3.05;

/**
 * Floor arms all rise from one concentric ring trench around the platform
 * (as in the film) — every floor base sits on this radius.
 */
export const ROBOT_RING_RADIUS = 1.45;

/** Floor base at `deg` around the ring (0° = +X, 90° = +Z). */
const onRing = (deg: number, pedestal: number): Vec3 => {
  const a = (deg * Math.PI) / 180;
  return [
    +(Math.cos(a) * ROBOT_RING_RADIUS).toFixed(4),
    pedestal,
    +(Math.sin(a) * ROBOT_RING_RADIUS).toFixed(4),
  ];
};

export const ROBOTS: readonly RobotStation[] = [
  { id: 'bl', label: 'gripper · rear left', base: onRing(-52.3, 0.25), mount: 'floor', pedestal: 0.25, tool: 'gripper' },
  { id: 'br', label: 'gripper · rear right', base: onRing(-127.7, 0.25), mount: 'floor', pedestal: 0.25, tool: 'gripper' },
  { id: 'sl', label: 'gripper · left', base: onRing(-16.2, 0.55), mount: 'floor', pedestal: 0.55, tool: 'gripper' },
  { id: 'sr', label: 'gripper · right', base: onRing(-163.8, 0.55), mount: 'floor', pedestal: 0.55, tool: 'gripper' },
  { id: 'fl', label: 'gripper · front left', base: onRing(22.9, 0.25), mount: 'floor', pedestal: 0.25, tool: 'gripper' },
  { id: 'fr', label: 'gripper · front right', base: onRing(157.1, 0.25), mount: 'floor', pedestal: 0.25, tool: 'gripper' },
  { id: 'cl', label: 'gripper · overhead left', base: [0.72, GANTRY_Y, -0.2], mount: 'ceiling', pedestal: 0, tool: 'gripper' },
  { id: 'cr', label: 'gripper · overhead right', base: [-0.72, GANTRY_Y, -0.2], mount: 'ceiling', pedestal: 0, tool: 'gripper' },
  { id: 'cf', label: 'gripper · overhead front', base: [0, GANTRY_Y, 0.88], mount: 'ceiling', pedestal: 0, tool: 'gripper' },
  { id: 'cb', label: 'gripper · overhead rear', base: [0, GANTRY_Y, -0.88], mount: 'ceiling', pedestal: 0, tool: 'gripper' },
  { id: 'rl', label: 'riveter · front left', base: onRing(51.1, 0.35), mount: 'floor', pedestal: 0.35, tool: 'riveter' },
  { id: 'rr', label: 'riveter · front right', base: onRing(128.9, 0.35), mount: 'floor', pedestal: 0.35, tool: 'riveter' },
];

export function robotStation(id: RobotId): RobotStation {
  const r = ROBOTS.find((s) => s.id === id);
  if (!r) throw new Error(`Unknown robot ${id}`);
  return r;
}

/**
 * How the part is presented to the suit:
 * - `clamp`  one plate driven straight onto its socket
 * - `pair`   a clamshell fixture carries both halves open, then the jaws close
 * - `slide`  a sleeve slid along the limb and screwed home
 * - `helmet` helmet + hinged faceplate carried as one unit
 * - `lift`   floor lift raises a boot through its hatch (no arm)
 */
export type FitKind = 'clamp' | 'pair' | 'slide' | 'helmet' | 'lift';

export interface FitTask {
  id: string;
  robot: RobotId | null;
  kind: FitKind;
  pieces: ArmorPieceId[];
  /** Choreography beat key (clamp contact). */
  beat: string;
  /** Carry-frame origin in bind space — the part's reference point. */
  origin: Vec3;
  /**
   * Gripper standoff in the part's own (bind) frame: the tool centre sits
   * `standoff` along `dir` from the origin and approaches along −dir; `up`
   * orients the jaws. The grasp is rigid, so the tool rides the part.
   */
  grip: { dir: Vec3; standoff: number; up: Vec3 };
  /** Which side of its arm the parts cradle stands on (default alternates). */
  cradleSide?: 1 | -1;
}

const model = (v: Vec3): Vec3 => v;
const anchor = (v: Vec3): Vec3 => v;

/** Unit vector ⊥ `axis`, leaning toward `toward` (bind space). */
function perpendicular(axis: Vec3, toward: Vec3): Vec3 {
  const d = axis[0] * toward[0] + axis[1] * toward[1] + axis[2] * toward[2];
  const v: Vec3 = [toward[0] - axis[0] * d, toward[1] - axis[1] * d, toward[2] - axis[2] * d];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function sideTasks(side: 'L' | 'R'): FitTask[] {
  const s = side === 'L' ? 1 : -1;
  const x = (v: number) => v * s;
  const out: Vec3 = [s, 0, 0];
  const forearm = boneAxis(`forearm.${side}`);
  const hand = boneAxis(`hand.${side}`);
  const r = (id: RobotId): RobotId => (side === 'L' ? id : (id.replace(/l$/, 'r') as RobotId));
  return [
    {
      id: `boot.${side}`,
      robot: null,
      kind: 'lift',
      pieces: [`boot.${side}`],
      beat: `boot${side}`,
      origin: [x(0.166), 0.093, 0.025],
      grip: { dir: model([0, 1, 0]), standoff: 0, up: model([0, 0, 1]) },
    },
    {
      id: `shin.${side}`,
      robot: r('bl'),
      kind: 'pair',
      pieces: [`shin.${side}.front`, `shin.${side}.back`],
      beat: 'shins',
      origin: [x(0.148), 0.33, -0.035],
      grip: { dir: anchor(out), standoff: 0.08, up: anchor([0, 1, 0]) },
    },
    {
      id: `thigh.${side}`,
      robot: r('sl'),
      kind: 'pair',
      pieces: [`thigh.${side}.front`, `thigh.${side}.back`],
      beat: 'thighs',
      origin: [x(0.113), 0.68, 0.005],
      grip: { dir: anchor(out), standoff: 0.1, up: anchor([0, 1, 0]) },
    },
    {
      id: `pec.${side}`,
      // Pecs close over the reactor housing together on the impact
      robot: side === 'L' ? 'fl' : 'cr',
      kind: 'clamp',
      pieces: [`pec.${side}`],
      beat: 'chestSlam',
      origin: [x(0.164), 1.436, 0.086],
      // Left pec from the front-left floor arm; right pec by the gantry arm,
      // which reaches over the top edge to stay clear of the right arm
      grip:
        side === 'L'
          ? { dir: model([0.3, 0, 1]), standoff: 0.11, up: model([0, 1, 0]) }
          : { dir: model([-0.1, 1, 0.35]), standoff: 0.22, up: model([0, 0, 1]) },
    },
    {
      // From above: in the stance the arm's outer side faces the gantry
      id: `upperArm.${side}`,
      robot: side === 'L' ? 'cf' : 'cr',
      kind: 'pair',
      pieces: [`upperArm.${side}.front`, `upperArm.${side}.back`],
      beat: `upperArm${side}`,
      // Racked on the same side as the arm it fits (no reach across the head)
      cradleSide: side === 'L' ? -1 : undefined,
      origin: [x(0.257), 1.326, -0.03],
      grip: { dir: anchor(out), standoff: 0.1, up: anchor([0, 1, 0]) },
    },
    {
      id: `forearm.${side}`,
      robot: r('sl'),
      kind: 'slide',
      pieces: [`forearm.${side}`],
      beat: `forearm${side}`,
      origin: [x(0.317), 1.159, -0.028],
      grip: { dir: anchor(perpendicular(forearm, out)), standoff: 0.09, up: anchor(forearm) },
    },
    {
      id: `gauntlet.${side}`,
      robot: r('fl'),
      kind: 'slide',
      pieces: [`gauntlet.${side}`],
      beat: `gauntlet${side}`,
      origin: [x(0.372), 0.948, 0.038],
      grip: { dir: anchor(perpendicular(hand, out)), standoff: 0.065, up: anchor(hand) },
    },
    {
      // Shoulder first: the bicep plates hang off the pauldron mount
      id: `pauldron.${side}`,
      robot: side === 'L' ? 'cl' : 'cb',
      kind: 'clamp',
      pieces: [`pauldron.${side}`],
      beat: `pauldron${side}`,
      origin: [x(0.227), 1.502, -0.004],
      grip: { dir: model([0, 1, 0]), standoff: 0.1, up: model([0, 0, 1]) },
    },
  ];
}

export const FIT_TASKS: readonly FitTask[] = [
  ...sideTasks('L'),
  ...sideTasks('R'),
  {
    // Pelvis clamshell: fixture comes in from the left hip, codpiece and
    // seat plate close front/back around the hips
    id: 'hips',
    robot: 'fl',
    kind: 'pair',
    pieces: ['hips.front', 'hips.back'],
    beat: 'hips',
    origin: [0, 0.915, 0.007],
    grip: { dir: model([1, 0, 0]), standoff: 0.2, up: model([0, 1, 0]) },
  },
  {
    id: 'back.lower',
    robot: 'bl',
    kind: 'clamp',
    pieces: ['back.lower'],
    beat: 'backLower',
    cradleSide: 1,
    origin: [0, 1.15, -0.092],
    grip: { dir: model([0, 0, -1]), standoff: 0.075, up: model([0, 1, 0]) },
  },
  {
    id: 'back.upper',
    robot: 'cb',
    kind: 'clamp',
    pieces: ['back.upper'],
    beat: 'backClamp',
    origin: [0, 1.465, -0.111],
    grip: { dir: model([0, 0.35, -1]), standoff: 0.1, up: model([0, 1, 0]) },
  },
  {
    id: 'abdomen',
    robot: 'fr',
    kind: 'clamp',
    pieces: ['abdomen'],
    beat: 'abdomen',
    origin: [0, 1.125, 0.076],
    grip: { dir: model([0, -0.2, 1]), standoff: 0.1, up: model([0, 1, 0]) },
  },
  {
    // Inner first: the reactor housing seats before the pecs close over it
    id: 'chest.core',
    robot: 'cf',
    kind: 'clamp',
    pieces: ['chest.core'],
    beat: 'chestCore',
    cradleSide: 1,
    origin: [0, 1.414, 0.091],
    // Held by its top edge so the reactor stays in view as it drives home
    grip: { dir: model([0, 1, 0.3]), standoff: 0.2, up: model([0, 0, 1]) },
  },
  {
    id: 'helmet',
    robot: 'cb',
    kind: 'helmet',
    pieces: ['helmet', 'faceplate'],
    beat: 'helmetSeat',
    origin: [0, 1.73, -0.03],
    grip: { dir: model([0, 0.75, -0.66]), standoff: 0.14, up: model([1, 0, 0]) },
  },
];

export function fitTask(id: string): FitTask {
  const t = FIT_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown fit task ${id}`);
  return t;
}

/** Task that fits a given piece. */
export function taskForPiece(piece: ArmorPieceId): FitTask {
  const t = FIT_TASKS.find((x) => x.pieces.includes(piece));
  if (!t) throw new Error(`No fit task for ${piece}`);
  return t;
}

/**
 * Parts cradle for a task: racks stand behind-and-beside each floor arm
 * (alternating sides per job, ~115° off the line to the suit so the arm
 * never swings through its own ±180° yaw), shelves hang beside each
 * ceiling arm. Returns the world point the task origin rests on.
 */
/** Floor parts cradles stand on a ring just outside the robot ring. */
export const CRADLE_RING_RADIUS = 2.05;
/** Least angular spacing between neighbouring floor cradles (deg). */
const CRADLE_MIN_GAP_DEG = 10;

let floorCradleAngles: Map<string, number> | null = null;

/**
 * Angle (deg) of every floor cradle: beside its arm (alternating sides,
 * further jobs fanning out), then relaxed so neighbours keep
 * {@link CRADLE_MIN_GAP_DEG} — each stand gets its own port.
 */
function cradleAngles(): Map<string, number> {
  if (floorCradleAngles) return floorCradleAngles;
  const want: Array<{ id: string; a: number }> = [];
  for (const st of ROBOTS.filter((r) => r.mount === 'floor')) {
    const jobs = FIT_TASKS.filter((t) => t.robot === st.id);
    const base = (Math.atan2(st.base[2], st.base[0]) * 180) / Math.PI;
    const sideOf = (t: FitTask, i: number) => t.cradleSide ?? (i % 2 === 0 ? 1 : -1);
    jobs.forEach((task, k) => {
      const sign = sideOf(task, k);
      const slot = jobs.slice(0, k).filter((t, i) => sideOf(t, i) === sign).length;
      // cradleSide is relative to the arm facing the suit: +1 = its left
      want.push({ id: task.id, a: base - sign * (13 + slot * CRADLE_MIN_GAP_DEG) });
    });
  }
  want.sort((a, b) => a.a - b.a);
  // Push apart until every gap is respected (a few sweeps both ways)
  for (let it = 0; it < 20; it++) {
    for (let i = 1; i < want.length; i++) {
      const gap = want[i].a - want[i - 1].a;
      if (gap < CRADLE_MIN_GAP_DEG) {
        const push = (CRADLE_MIN_GAP_DEG - gap) / 2;
        want[i].a += push;
        want[i - 1].a -= push;
      }
    }
  }
  floorCradleAngles = new Map(want.map((w) => [w.id, w.a]));
  return floorCradleAngles;
}

export function cradleFor(task: FitTask): Vec3 {
  if (!task.robot) {
    // Boot lifts park under the platform hatch
    return [task.origin[0], task.origin[1] - LIFT_DEPTH, task.origin[2]];
  }
  const st = robotStation(task.robot);
  if (st.mount === 'floor') {
    const a = (cradleAngles().get(task.id)! * Math.PI) / 180;
    return [Math.cos(a) * CRADLE_RING_RADIUS, 0.95, Math.sin(a) * CRADLE_RING_RADIUS];
  }
  const jobs = FIT_TASKS.filter((t) => t.robot === task.robot);
  const sideOf = (t: FitTask, i: number) => t.cradleSide ?? (i % 2 === 0 ? 1 : -1);
  const k = jobs.indexOf(task);
  const sign = sideOf(task, k);
  // Further racks on the same side fan out by another 20°
  const slot = jobs.slice(0, k).filter((t, i) => sideOf(t, i) === sign).length;
  const face = Math.atan2(-st.base[0], -st.base[2]);
  const a = face + sign * (Math.PI * 0.64 + slot * 0.35);
  const reach = 0.66;
  const x = st.base[0] + Math.sin(a) * reach;
  const z = st.base[2] + Math.cos(a) * reach;
  return [x, 2.05, z];
}

/** How far below the platform the boot lifts start. */
export const LIFT_DEPTH = 0.6;

// ── Riveting jobs ────────────────────────────────────────────────────────

/** Ratchet click trains (see the choreography) a riveter strikes on. */
export type ClickTrain = 'shins' | 'thighs' | 'arms';

export interface ToolJob {
  id: string;
  robot: RobotId;
  kind: 'rivet';
  /** Part being worked — the tool rides its frame. */
  piece: ArmorPieceId;
  /**
   * Bind-space rivet sites near the part surface (snapped onto it at load
   * by a ray along −normal).
   */
  points: Vec3[];
  /** Outward surface normal (bind); the tool approaches along −normal. */
  normal: Vec3;
  /** One strike per point on this click train (index parity). */
  clicks: { train: ClickTrain; parity: 0 | 1 };
}

function rivetLeg(
  train: ClickTrain,
  piece: 'shin' | 'thigh',
  side: 'L' | 'R',
  ys: number[],
  x: number,
  z: number,
): ToolJob {
  const s = side === 'L' ? 1 : -1;
  return {
    id: `rivet.${piece}.${side}`,
    robot: side === 'L' ? 'rl' : 'rr',
    kind: 'rivet',
    piece: `${piece}.${side}.front`,
    points: ys.map((y) => [x * s, y, z] as Vec3),
    normal: [0.25 * s, 0, 1],
    clicks: { train, parity: side === 'L' ? 0 : 1 },
  };
}

function rivetPec(side: 'L' | 'R'): ToolJob {
  const s = side === 'L' ? 1 : -1;
  return {
    id: `rivet.pec.${side}`,
    robot: side === 'L' ? 'rl' : 'rr',
    kind: 'rivet',
    piece: `pec.${side}`,
    points: [
      [0.12 * s, 1.3, 0.2],
      [0.16 * s, 1.4, 0.2],
      [0.12 * s, 1.5, 0.2],
    ],
    normal: [0.3 * s, 0, 1],
    clicks: { train: 'arms', parity: side === 'L' ? 0 : 1 },
  };
}

export const TOOL_JOBS: readonly ToolJob[] = [
  rivetLeg('shins', 'shin', 'L', [0.27, 0.34, 0.41], 0.15, 0.1),
  rivetLeg('shins', 'shin', 'R', [0.27, 0.34, 0.41], 0.15, 0.1),
  rivetLeg('thighs', 'thigh', 'L', [0.6, 0.69, 0.78], 0.12, 0.2),
  rivetLeg('thighs', 'thigh', 'R', [0.6, 0.69, 0.78], 0.12, 0.2),
  rivetPec('L'),
  rivetPec('R'),
];

export function toolJob(id: string): ToolJob {
  const j = TOOL_JOBS.find((x) => x.id === id);
  if (!j) throw new Error(`Unknown tool job ${id}`);
  return j;
}
