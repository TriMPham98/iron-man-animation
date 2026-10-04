import type { FlightPose } from '../suit/rigPose';

/**
 * JARVIS flight-control check, run on the finished suit while the camera
 * makes its showcase turn (the Mark II "flight stabilizers" test in the
 * film). Paced like a pilot's control check: every move is one deliberate
 * servo stroke — travel, hold, return — one side at a time, never a wiggle.
 *
 * Steps run in pre-flight order — ground checks from the hands outward,
 * then everything at once, then flight:
 *
 *   hand + neck servos → repulsor alignment (L, R, both) → stabilizer
 *   flaps (one rolling sweep down the suit: shoulder, dorsal, thigh, calf)
 *   → weapons (a forearm armor panel rises on
 *   the anti-tank launcher; each trapezius cap rises on a forward-facing
 *   mini-rocket silo; the round hip plates push out on their flare drums,
 *   which turn and test-pop) → all surfaces (every flap and every weapon
 *   deployed together) → hover test (palms turn to the deck and the
 *   repulsors light before the boots ignite; lift off to ~45 cm and hold.
 *   Gusts tilt and drift the suit, and the flaps and the left / right
 *   repulsor balance are computed from that attitude each frame, so the
 *   controls visibly level it in real time) → nominal
 *
 * The suit breathes throughout (chest swell, shoulders) so it never reads
 * as a statue.
 *
 * Times are seconds from the start of the turn. Everything settles back to
 * the bind pose by {@link FLIGHT_CHECK_END} — before the turn eases out and
 * the wireframe diagnostic (built from the bind pose) takes over. The
 * faceplate stays shut throughout.
 */

/** Flight-control surfaces (small flaps cut on the model's panel lines). */
export type FlapId =
  | 'back.L'
  | 'back.R'
  | 'shoulder.L'
  | 'shoulder.R'
  | 'calf.L'
  | 'calf.R'
  /** Hamstring air brake on the back of each thigh. */
  | 'thigh.L'
  | 'thigh.R'
  /** Forearm armor panel that rises as the anti-tank launcher's housing. */
  | 'launcher.L'
  | 'launcher.R'
  /** Trapezius panel that lifts as the lid of the mini-rocket silo. */
  | 'trap.L'
  | 'trap.R'
  /** Hip panel that slides out over the flare dispenser. */
  | 'flare.L'
  | 'flare.R';

export interface FlightCheckFrame {
  pose: FlightPose;
  /** Flap opening 0 (seated) → 1 (full deflection). */
  flaps: Record<FlapId, number>;
  /** Palm repulsor glow 0–1 (flash or stabilizer burn). */
  repulsorL: number;
  repulsorR: number;
  /** Boot thruster burn 0–1. */
  thrusters: number;
  /** Per-boot burn (the low side pushes harder to level the suit). */
  thrusterL: number;
  thrusterR: number;
  /** JARVIS status line for this step. */
  status: string;
  /** False before the first step and after the last. */
  active: boolean;
}

export const FLIGHT_CHECK_START = 0.6;
/**
 * The hover runs to the end of the turn: the suit sets down and the check
 * reads nominal just as the orbit begins its ease-out, where the wireframe
 * diagnostic (built from the bind pose) takes over — remaining yaw 0.275 rad
 * of a 35 s turn ≈ 33.47 s.
 */
export const FLIGHT_CHECK_END = 33.4;
/** Hover height of the thruster test (m). */
export const HOVER_HEIGHT = 0.45;

/** Step starts (flight-check seconds). */
const AT_SERVOS = 0.6;
const AT_REPULSORS = 4.6;
/**
 * All the stabilizers in one step: a single sweep down the suit, each pair
 * of surfaces starting as the one above it reaches full travel. (Three
 * separate steps cost the hover ~3.5 s.)
 */
const AT_STABILIZERS = 9.4;
const AT_WEAPONS = 12.8;
const AT_ALL = 19.7;
const AT_HOVER = 22.2;
const AT_NOMINAL = 32.75;

/** Status lines with the time each step starts. */
export const FLIGHT_CHECK_STEPS: ReadonlyArray<{ at: number; status: string; item: string; group: string }> = [
  { at: AT_SERVOS, status: 'FLIGHT CONTROL CHECK · HAND + NECK SERVOS', item: 'HAND / NECK SERVOS', group: 'SERVOS' },
  { at: AT_REPULSORS, status: 'REPULSOR ALIGNMENT · L / R', item: 'REPULSORS L / R', group: 'HANDS' },
  {
    at: AT_STABILIZERS,
    status: 'FLIGHT STABILIZERS · SHOULDER / DORSAL / LEG FLAPS',
    item: 'STABILIZER FLAPS',
    group: 'STABILIZERS',
  },
  { at: AT_WEAPONS, status: 'WEAPONS · ARMING CHECK', item: 'LAUNCHER / SILOS / FLARES', group: 'WEAPONS' },
  { at: AT_ALL, status: 'ALL SURFACES + WEAPONS · FULL DEFLECTION', item: 'FULL DEFLECTION', group: 'ALL SYSTEMS' },
  { at: AT_HOVER, status: 'BOOT THRUSTERS · HOVER TEST · STABILIZERS LIVE', item: 'HOVER TEST', group: 'THRUSTERS' },
  { at: AT_NOMINAL, status: 'FLIGHT CONTROLS NOMINAL', item: 'FLIGHT CONTROLS', group: 'NOMINAL' },
];

/**
 * Timed events the sound layer cues on (flight-check seconds). `kind`
 * names the action, `side` which unit moved.
 */
export interface FlightEvent {
  t: number;
  kind:
    | 'servo'
    | 'flapOpen'
    | 'flapClose'
    | 'repulsor'
    | 'weaponDeploy'
    | 'weaponLock'
    | 'weaponStow'
    | 'flare'
    | 'ignite'
    | 'liftoff'
    | 'touchdown'
    | 'cutoff'
    | 'nominal';
  side?: 'L' | 'R' | 'both';
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Servo stroke ease: smooth start, smooth stop (quintic smootherstep). */
const stroke = (a: number, b: number, t: number) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
/** Travel over [a, b], hold, return over [c, d]. */
const move = (t: number, a: number, b: number, c: number, d: number) =>
  t < c ? stroke(a, b, t) : 1 - stroke(c, d, t);

/** Keyframed scalar: [t, value] pairs, servo-eased between them. */
function keyed(t: number, keys: ReadonlyArray<readonly [number, number]>): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return v0 + (v1 - v0) * stroke(t0, t1, t);
    }
  }
  return keys[keys.length - 1][1];
}

// ── Choreography (seconds into the turn) ───────────────────────────────

type Keys = ReadonlyArray<readonly [number, number]>;
type Stroke = readonly [number, number, number, number];
/** Stroke/keys authored relative to a step start. */
const at = (base: number, k: Stroke): Stroke => [base + k[0], base + k[1], base + k[2], base + k[3]];
const keysAt = (base: number, keys: Keys): Keys => keys.map(([t, v]) => [base + t, v] as const);

// Hover test. Pre-hover first: arms tuck in and the palms turn to the
// deck, the repulsors light, then the boots ignite and spool — the suit only
// leaves the pad once both are pushing. Then lift off, hold, set down.
const PALMS_DOWN = AT_HOVER + 0.1;
const PALMS_SET = AT_HOVER + 0.9;
const IGNITE = AT_HOVER + 1.0;
const SPOOL = IGNITE + 0.6;
const LIFTOFF = IGNITE + 0.9;
const HOVER = IGNITE + 2.2;
const DESCEND = IGNITE + 7.7;
const TOUCHDOWN = IGNITE + 9.1;
const CUTOFF = IGNITE + 9.4;
/** Seconds the boot thrusters burn (lift-off spool → cut-off). */
export const THRUSTER_BURN_SEC = CUTOFF - LIFTOFF + 0.3;

/**
 * Air disturbances [start, axis, amplitude (rad), period (s), decay (s)]:
 * the lift-off kick, a gust that rocks the hover, a second correction and
 * the landing flare. The suit's attitude is their sum; the flaps and the
 * repulsor balance are computed from that attitude every frame, so the
 * controls visibly fight each tilt as it happens.
 */
const GUSTS: ReadonlyArray<readonly [number, 'pitch' | 'roll', number, number, number]> = [
  [LIFTOFF + 0.1, 'pitch', 0.09, 1.9, 1.0],
  [LIFTOFF + 0.25, 'roll', 0.11, 1.6, 0.9],
  [HOVER + 0.5, 'roll', -0.12, 1.5, 0.8],
  [HOVER + 1.4, 'pitch', -0.08, 1.7, 0.8],
  [HOVER + 2.0, 'roll', 0.09, 1.4, 0.7],
  // Long hold: a big cross-gust from the right, caught and levelled
  [HOVER + 3.1, 'roll', -0.14, 1.7, 0.9],
  [HOVER + 3.3, 'pitch', 0.07, 1.9, 0.9],
  [HOVER + 4.5, 'roll', 0.08, 1.5, 0.7],
  [DESCEND + 0.2, 'pitch', -0.06, 1.8, 0.9],
];
/** Boots come together only for the hover (as in the film). */
const LEGS_IN: Keys = [
  [PALMS_DOWN + 0.2, 0],
  [IGNITE + 0.3, 1],
  [TOUCHDOWN + 0.1, 1],
  [TOUCHDOWN + 0.9, 0],
];

const NECK_YAW: Keys = keysAt(AT_SERVOS, [
  [0.8, 0],
  [1.5, 0.4], // look left
  [1.9, 0.4],
  [2.8, -0.4], // look right
  [3.1, -0.4],
  [3.6, 0],
]);
const NECK_PITCH: Keys = keysAt(AT_SERVOS, [
  [3.0, 0],
  [3.4, 0.12], // check down
  [3.7, 0.12],
  [4.0, 0],
]);
/** Finger servo check: a fist rolls closed pinky → thumb, then opens. */
const FIST_L = at(AT_SERVOS, [0.4, 0.95, 1.4, 1.85]);

// Repulsors: arms out, each palm up and fires, then both
const R = AT_REPULSORS - 0.1;
const WRIST_L: Keys = keysAt(R, [
  [1.2, 0],
  [1.6, 1],
  [2.1, 1],
  [2.5, 0],
  [2.9, 0],
  [3.3, 1],
  [3.6, 1],
  [4.0, 0],
]);
const WRIST_R: Keys = keysAt(R, [
  [2.1, 0],
  [2.5, 1],
  [3.6, 1],
  [4.0, 0],
]);
/** Palm discharge times. */
const FLASH_L = [R + 1.65, R + 3.4];
const FLASH_R = [R + 2.55, R + 3.4];

// Weapons: launchers L then R, trap silos rise, hip flare drums push out
const W = AT_WEAPONS;
const LAUNCH_L = at(W, [0.6, 1.3, 5.4, 6.0]);
const LAUNCH_R = at(W, [1.0, 1.7, 5.5, 6.1]);
const SILOS = at(W, [1.8, 2.6, 5.1, 5.9]);
// Flare dispensers: hip drums push out and turn, test pops, slide home
const FLARE_DRUMS = at(W, [2.9, 3.4, 4.9, 5.4]);
/** Flare pops (flight-check s) per side. */
export const FLARE_POPS: ReadonlyArray<{ t: number; side: 'L' | 'R' }> = [
  { t: W + 3.55, side: 'L' },
  { t: W + 3.85, side: 'R' },
  { t: W + 4.2, side: 'L' },
  { t: W + 4.3, side: 'R' },
];

/**
 * Where JARVIS has the pilot look, step by step: [time, yaw, pitch, roll,
 * move s]. Yaw + = to the suit's left, pitch + = chin down, roll + = ear
 * to the left shoulder. Glances are quick (~0.3 s, like a real head turn)
 * and hold while the part works; the head always comes home before the
 * diagnostic.
 */
const GAZE: ReadonlyArray<readonly [number, number, number, number, number?]> = [
  // Unhurried and economical: one look per job, then eyes front
  [R + 1.1, 0.32, 0.08, 0.03, 0.8], // left palm
  [R + 2.0, -0.32, 0.08, -0.03, 1.0], // right palm
  [R + 3.0, 0, 0.02, 0, 0.8], // both, dead ahead
  [AT_STABILIZERS + 0.05, 0.4, 0.1, -0.04, 0.8], // left shoulder flap
  [AT_STABILIZERS + 0.75, -0.4, 0.1, 0.04, 1.0], // right
  [AT_STABILIZERS + 1.8, 0, 0.24, 0, 0.9], // down as the sweep reaches the legs
  [AT_STABILIZERS + 3.0, 0, 0, 0, 0.8],
  [W + 0.5, 0.34, 0.14, 0.03, 0.8], // left launcher
  [W + 1.2, -0.34, 0.14, -0.03, 1.0], // right launcher
  [W + 2.0, 0, -0.04, 0, 0.8], // silos, eyes front
  [W + 3.0, 0, 0.22, 0, 0.8], // down at the flare drums
  [W + 4.8, 0, 0, 0, 0.8],
  [PALMS_DOWN, 0, 0.2, 0, 0.8], // checks the deck as the palms set
  [IGNITE + 0.5, 0, -0.03, 0, 0.9], // eyes up for the lift
  [HOVER + 0.8, 0.14, 0, 0, 1.0], // one easy look round
  [HOVER + 2.2, 0, 0, 0, 1.0],
  [HOVER + 3.4, -0.12, 0.05, 0, 1.0], // toward the gust as it hits
  [HOVER + 5.0, 0, 0, 0, 1.0],
  [DESCEND + 0.2, 0, 0.16, 0, 0.9], // watches the deck come up
  [TOUCHDOWN + 0.25, 0, 0, 0, 0.75],
];

/** Gaze channel (0 yaw, 1 pitch, 2 roll) at t: ease between holds. */
function gaze(t: number, ch: 1 | 2 | 3): number {
  let v = 0;
  for (const g of GAZE) {
    const dur = g[4] ?? 0.8;
    if (t <= g[0]) break;
    v = v + (g[ch] - v) * stroke(g[0], g[0] + dur, t);
  }
  return v;
}

const ARMS: Keys = [
  ...keysAt(R, [
    [0, 0],
    [1.0, 0.8], // arms out for the repulsors
    [3.9, 0.8],
    [4.7, 0],
  ]),
  ...keysAt(W, [
    [0, 0],
    [0.8, 0.8], // arms out for the launchers
    [6.0, 0.8],
    [6.8, 0],
  ]),
];

// Flaps: one side, then the other — open, hold, close
// Staggered: the right side follows the left a beat later, overlapping
const STAGGER = 0.35;
const lag = (k: Stroke) => at(STAGGER, k);
const FIST_R = lag(FIST_L);
/** Stabilizer sweep: each pair starts `SWEEP` s after the one above it. */
const SWEEP = 0.5;
const stab = (row: number) => at(AT_STABILIZERS + row * SWEEP, [0.1, 0.65, 1.25, 1.75]);
const SHOULDER_L = stab(0);
const SHOULDER_R = lag(SHOULDER_L);
const BACK_L = stab(1);
const BACK_R = lag(BACK_L);
const THIGH_L = stab(2);
const THIGH_R = lag(THIGH_L);
const CALF_L = stab(2.6);
const CALF_R = lag(CALF_L);

/** Full deflection: every flap and every weapon out together, held, stowed. */
const ALL = at(AT_ALL, [0.1, 0.8, 1.6, 2.3]);

/** Sound / FX cue sheet for the check (flight-check seconds). */
export const FLIGHT_EVENTS: readonly FlightEvent[] = ([
  { t: IGNITE, kind: 'ignite' },
  { t: LIFTOFF, kind: 'liftoff' },
  { t: TOUCHDOWN, kind: 'touchdown' },
  { t: CUTOFF, kind: 'cutoff' },
  { t: AT_SERVOS, kind: 'servo', side: 'both' },
  { t: FIST_L[0], kind: 'servo', side: 'L' },
  { t: FIST_R[0], kind: 'servo', side: 'R' },
  { t: NECK_YAW[0][0], kind: 'servo' },
  { t: NECK_YAW[2][0], kind: 'servo' },
  { t: NECK_YAW[4][0], kind: 'servo' },
  { t: R, kind: 'servo', side: 'both' },
  { t: FLASH_L[0], kind: 'repulsor', side: 'L' },
  { t: FLASH_R[0], kind: 'repulsor', side: 'R' },
  { t: FLASH_L[1], kind: 'repulsor', side: 'both' },
  { t: R + 3.9, kind: 'servo', side: 'both' },
  ...([
    [CALF_L, 'L'],
    [CALF_R, 'R'],
    [THIGH_L, 'L'],
    [THIGH_R, 'R'],
    [BACK_L, 'L'],
    [BACK_R, 'R'],
    [SHOULDER_L, 'L'],
    [SHOULDER_R, 'R'],
    [FLARE_DRUMS, 'both'],
    [ALL, 'both'],
  ] as const).flatMap(([k, side]): FlightEvent[] => [
    { t: k[0], kind: 'flapOpen', side },
    { t: k[2], kind: 'flapClose', side },
  ]),
  { t: W, kind: 'servo', side: 'both' },
  { t: LAUNCH_L[0], kind: 'weaponDeploy', side: 'L' },
  { t: LAUNCH_L[1], kind: 'weaponLock', side: 'L' },
  { t: LAUNCH_R[0], kind: 'weaponDeploy', side: 'R' },
  { t: LAUNCH_R[1], kind: 'weaponLock', side: 'R' },
  { t: SILOS[0], kind: 'weaponDeploy', side: 'both' },
  { t: SILOS[1], kind: 'weaponLock', side: 'both' },
  { t: SILOS[2], kind: 'weaponStow', side: 'both' },
  ...FLARE_POPS.map((p): FlightEvent => ({ t: p.t, kind: 'flare', side: p.side })),
  { t: LAUNCH_L[2], kind: 'weaponStow', side: 'L' },
  { t: LAUNCH_R[2], kind: 'weaponStow', side: 'R' },
  { t: W + 6.0, kind: 'servo', side: 'both' },
  { t: ALL[0], kind: 'weaponDeploy', side: 'both' },
  { t: ALL[1], kind: 'weaponLock', side: 'both' },
  { t: ALL[2], kind: 'weaponStow', side: 'both' },
  // Each gust draws a correction from the surfaces on the low side
  ...GUSTS.map(([t0, axis, amp]): FlightEvent => ({
    t: t0 + 0.12,
    kind: 'flapOpen',
    side: axis === 'pitch' ? 'both' : amp > 0 ? 'R' : 'L',
  })),
  { t: AT_NOMINAL, kind: 'nominal' },
] satisfies FlightEvent[]).sort((a, b) => a.t - b.t);

/** Wrist bend for the hover (1 = repulsor gesture, ~1.45 = full L). */
const HOVER_WRIST = 1.45;

/** Ripple delay per finger [thumb, index, middle, ring, pinky] (s). */
const RIPPLE = [0.2, 0.15, 0.1, 0.05, 0];

/** Resting hand: fingers fall into a loose, natural curl (pinky most). */
const RELAXED = [0.08, 0.12, 0.15, 0.18, 0.2];

function fingers(t: number, side: 'L' | 'R', palms: number, easy: number): number[] {
  const fist = side === 'L' ? FIST_L : FIST_R;
  // Palms flat (fingers straight) for repulsor shots and in the air
  const wrist = Math.min(1, keyed(t, side === 'L' ? WRIST_L : WRIST_R));
  const flat = -0.25 * Math.max(wrist, palms);
  const rest = easy * (1 - wrist);
  return RIPPLE.map((d, i) => {
    const k = move(t, fist[0] + d, fist[1] + d, fist[2] + d * 0.5, fist[3] + d * 0.5);
    return Math.max(k * (i === 0 ? 0.8 : 1), 0) + (flat + RELAXED[i] * rest) * (1 - k);
  });
}

/** Sum of the gusts' damped swings on one axis; each builds in smoothly. */
function sway(t: number, axis: 'pitch' | 'roll'): number {
  let v = 0;
  for (const [t0, ax, amp, period, decay] of GUSTS) {
    if (ax !== axis || t <= t0) continue;
    const u = t - t0;
    const onset = stroke(t0, t0 + 0.8, t);
    v += amp * onset * Math.exp(-u / decay) * Math.sin(((Math.PI * 2) / period) * u);
  }
  return v;
}

/** Hover attitude (and its rate), faded in with the height so it is level on the pad. */
function attitude(t: number, lift: number) {
  const env = stroke(0, 0.18, lift);
  const h = 1 / 120;
  const p = sway(t, 'pitch');
  const r = sway(t, 'roll');
  return {
    pitch: p * env,
    roll: r * env,
    dPitch: ((p - sway(t - h, 'pitch')) / h) * env,
    dRoll: ((r - sway(t - h, 'roll')) / h) * env,
  };
}

/** Breathing cycle (s) and its swell, eased in and out with the check. */
const BREATH_PERIOD = 3.6;
const breathEnvelope = (t: number) =>
  move(t, FLIGHT_CHECK_START, FLIGHT_CHECK_START + 1.2, FLIGHT_CHECK_END - 1.4, FLIGHT_CHECK_END - 0.3);
function breathing(t: number): number {
  const env = breathEnvelope(t);
  // Inhale quicker than the exhale: a skewed sine
  const ph = ((t - FLIGHT_CHECK_START) / BREATH_PERIOD) * Math.PI * 2;
  return env * Math.sin(ph + 0.35 * Math.sin(ph));
}

export function evaluateFlightCheck(t: number): FlightCheckFrame {
  const active = t >= FLIGHT_CHECK_START && t < FLIGHT_CHECK_END;

  // Neck: the servo check (left, right, a glance down), then the pilot's
  // gaze follows each part under test; a faint drift keeps it alive
  const live = breathEnvelope(t);
  // Slow, barely-there drift (attention settling, not twitching)
  let headYaw = keyed(t, NECK_YAW) + gaze(t, 1) + live * 0.006 * Math.sin(t * 0.55 + 1);
  let headPitch = keyed(t, NECK_PITCH) + gaze(t, 2) + live * 0.004 * Math.sin(t * 0.4 + 0.5);
  let headRoll = gaze(t, 3) + live * 0.004 * Math.sin(t * 0.33 + 2);

  // Repulsors: arms out, each palm up and fires, then both
  let stance = keyed(t, ARMS);
  let wristL = keyed(t, WRIST_L);
  let wristR = keyed(t, WRIST_R);
  const flash = (a: number) => (t >= a ? Math.exp(-(t - a) * 5) : 0);
  let repulsorL = Math.max(...FLASH_L.map(flash));
  let repulsorR = Math.max(...FLASH_R.map(flash));

  const ignite = t >= IGNITE && t < SPOOL ? (t < IGNITE + 0.18 || (t > IGNITE + 0.32 && t < IGNITE + 0.5) ? 0.5 : 0.15) : 0;
  // Throttles back on the way down, flares to arrest the descent, then
  // spools down once the boots carry the weight
  const burn = keyed(t, [
    [SPOOL, 0],
    [LIFTOFF, 1],
    [HOVER, 0.9],
    [DESCEND + 0.4, 0.78],
    [TOUCHDOWN - 0.6, 1],
    [TOUCHDOWN + 0.05, 0.7],
    [CUTOFF, 0],
  ]);
  const thrusters = Math.max(ignite, burn);
  // Climb overshoots a touch and settles, like a real controller would
  const climb = keyed(t, [
    [LIFTOFF, 0],
    [HOVER - 0.2, 1.06],
    [HOVER + 0.6, 0.97],
    [HOVER + 1.3, 1],
    [DESCEND, 1],
    // Arrests a hand's breadth off the deck, then sets down softly
    [TOUCHDOWN - 0.7, 0.14],
    [TOUCHDOWN - 0.25, 0.05],
    [TOUCHDOWN, 0],
  ]);
  const bob = t > HOVER - 0.3 && t < DESCEND + 0.3 ? 0.012 * Math.sin((t - HOVER) * Math.PI * 1.3) * move(t, HOVER - 0.3, HOVER, DESCEND, DESCEND + 0.3) : 0;
  const lift = HOVER_HEIGHT * climb + bob;
  // Palms turn to the deck before anything lifts and stay there until the
  // boots are down; arms tuck in close (wrists bent in an L)
  const palms = keyed(t, [
    [PALMS_DOWN, 0],
    [PALMS_SET, 1],
    [TOUCHDOWN + 0.1, 1],
    [CUTOFF + 0.6, 0],
  ]);

  // ── Attitude + live stabilisation ──
  const { pitch, roll, dPitch, dRoll } = attitude(t, lift);
  // Controls act on the error and its rate (PD): they lead the tilt and
  // ease off as the suit levels
  const uRoll = 10 * roll + 1.4 * dRoll;
  const uPitch = 10 * pitch + 1.4 * dPitch;
  // Low side works harder: + roll leans to the suit's right
  const repBase = keyed(t, [
    [PALMS_SET - 0.1, 0],
    [IGNITE, 0.35],
    [LIFTOFF, 0.8],
    [HOVER, 0.55],
    [TOUCHDOWN - 0.6, 0.72],
    [TOUCHDOWN + 0.1, 0.5],
    [CUTOFF + 0.4, 0],
  ]);
  stance = Math.max(stance, 0.1 * palms);
  // Wrists vector the palm thrust against the roll as well
  // Bounded balance trim: a steady burn that leans, never gutters out
  const trimRoll = Math.max(-1, Math.min(1, uRoll));
  wristL = Math.max(wristL, palms * (HOVER_WRIST + 0.1 * trimRoll));
  wristR = Math.max(wristR, palms * (HOVER_WRIST - 0.1 * trimRoll));
  repulsorL = Math.max(repulsorL, repBase * (1 - 0.3 * trimRoll));
  repulsorR = Math.max(repulsorR, repBase * (1 + 0.3 * trimRoll));
  // Drift: the suit slides a few cm toward its lean, then is brought back
  const driftX = -0.35 * roll;
  const driftZ = 0.3 * pitch;

  // Head stays level with the horizon while the body rocks (vestibular
  // reflex), with a slight lag so it reads as muscle, not a gimbal
  const lagged = attitude(t - 0.12, lift);
  headRoll -= 0.5 * lagged.roll;
  headPitch -= 0.4 * lagged.pitch;

  // ── Limbs: alive in the air ──
  const air = stroke(0, 0.18, lift);
  // Pre-hover crouch, the push-off, and the knees soaking up the landing
  const crouch =
    keyed(t, [
      [IGNITE, 0],
      [SPOOL + 0.2, 0.2],
      [LIFTOFF + 0.25, 0],
    ]) +
    keyed(t, [
      [TOUCHDOWN - 0.05, 0],
      [TOUCHDOWN + 0.2, 0.22],
      [TOUCHDOWN + 1.0, 0],
    ]);
  // Dangling legs: soft knees, toes dropped, legs lag the body's tilt
  const sway = (k: number, ph: number) => air * k * Math.sin(t * 1.9 + ph);
  const knee = crouch + air * 0.16 + sway(0.03, 0);
  const kneeL = knee + sway(0.02, 1.1);
  const kneeR = knee + sway(0.02, 2.3);
  // Feet vector the boot thrust against the tilt
  const ankle = air * (0.14 + 0.25 * uPitch);
  const limbs = {
    // The low side's arm reaches out for balance; elbows stay soft
    armL: air * (0.08 + 0.22 * clamp01(-uRoll)) + sway(0.015, 0.4),
    armR: air * (0.08 + 0.22 * clamp01(uRoll)) + sway(0.015, 1.4),
    elbowL: air * 0.18 + sway(0.03, 2),
    elbowR: air * 0.18 + sway(0.03, 3),
    hipL: kneeL / 2 + 0.7 * pitch,
    hipR: kneeR / 2 + 0.7 * pitch,
    hipOutL: -0.7 * roll,
    hipOutR: 0.7 * roll,
    kneeL,
    kneeR,
    ankleL: ankle,
    ankleR: ankle,
    footRollL: air * 0.2 * uRoll,
    footRollR: air * 0.2 * uRoll,
  };
  // ── On the deck between checks: a pilot standing easy ──
  // Weight drifts slowly from foot to foot; the loaded leg locks, the other
  // knee softens; elbows stay relaxed. Off while airborne / in pre-hover.
  const easy = live * (1 - air) * (1 - palms);
  const shift = Math.sin(((t - FLIGHT_CHECK_START) / 7.5) * Math.PI * 2) * easy;
  const shiftX = 0.012 * shift;
  limbs.hipOutL -= shiftX / 0.88;
  limbs.hipOutR += shiftX / 0.88;
  const softL = 0.06 * Math.max(0, -shift);
  const softR = 0.06 * Math.max(0, shift);
  limbs.kneeL += softL;
  limbs.kneeR += softR;
  limbs.hipL += softL / 2;
  limbs.hipR += softR / 2;
  limbs.elbowL += 0.07 * easy + 0.012 * shift;
  limbs.elbowR += 0.07 * easy - 0.012 * shift;
  limbs.armL += 0.008 * shift;
  limbs.armR -= 0.008 * shift;

  // Bent knees on the deck lower the hips a touch
  const sink = 0.035 * crouch * (1 - air);
  // Boots: the low side burns harder too
  const thrusterL = burn * clamp01(1 - 0.2 * trimRoll);
  const thrusterR = burn * clamp01(1 + 0.2 * trimRoll);

  const flap = (k: readonly [number, number, number, number]) => clamp01(move(t, k[0], k[1], k[2], k[3]));
  // Full deflection drives every flap and every weapon together
  const all = flap(ALL);
  const rollR = clamp01(uRoll);
  const rollL = clamp01(-uRoll);
  const fwd = clamp01(uPitch);
  const aft = clamp01(-uPitch);
  const flaps: Record<FlapId, number> = {
    'shoulder.L': Math.max(flap(SHOULDER_L), all, 0.8 * aft, 0.6 * rollL),
    'shoulder.R': Math.max(flap(SHOULDER_R), all, 0.8 * aft, 0.6 * rollR),
    'back.L': Math.max(flap(BACK_L), all, rollL),
    'back.R': Math.max(flap(BACK_R), all, rollR),
    'launcher.L': Math.max(flap(LAUNCH_L), all),
    'launcher.R': Math.max(flap(LAUNCH_R), all),
    'trap.L': Math.max(flap(SILOS), all),
    'trap.R': Math.max(flap(SILOS), all),
    'calf.L': Math.max(flap(CALF_L), all, fwd, 0.5 * rollL),
    'calf.R': Math.max(flap(CALF_R), all, fwd, 0.5 * rollR),
    // Hamstring brakes lead the calf flaps a beat on the leg check and
    // share the pitch trim with them in flight
    'thigh.L': Math.max(flap(THIGH_L), all, 0.8 * fwd, 0.4 * rollL),
    'thigh.R': Math.max(flap(THIGH_R), all, 0.8 * fwd, 0.4 * rollR),
    'flare.L': Math.max(flap(FLARE_DRUMS), all),
    'flare.R': Math.max(flap(FLARE_DRUMS), all),
  };

  let status = '';
  for (const s of FLIGHT_CHECK_STEPS) if (t >= s.at) status = s.status;

  return {
    pose: {
      stance,
      chestRecoil: 0,
      headPitch,
      headYaw,
      headRoll,
      limbs,
      wristL: Math.max(0, wristL),
      wristR: Math.max(0, wristR),
      lift: lift - sink,
      pitch,
      roll,
      driftX: driftX + shiftX,
      driftZ,
      breath: breathing(t),
      legsIn: keyed(t, LEGS_IN),
      fingersL: fingers(t, 'L', palms, easy),
      fingersR: fingers(t, 'R', palms, easy),
    },
    flaps,
    repulsorL: clamp01(repulsorL),
    repulsorR: clamp01(repulsorR),
    thrusters,
    thrusterL: Math.max(thrusterL, ignite),
    thrusterR: Math.max(thrusterR, ignite),
    status: active ? status : '',
    active,
  };
}
