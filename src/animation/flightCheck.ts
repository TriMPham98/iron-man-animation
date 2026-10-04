import type { FlightPose } from '../suit/rigPose';

/**
 * JARVIS flight-control check, run on the finished suit while the camera
 * makes its showcase turn (the Mark II "flight stabilizers" test in the
 * film). Paced like a pilot's control check: every move is one deliberate
 * servo stroke — travel, hold, return — one side at a time, never a wiggle.
 *
 *   feet together → neck servos → repulsor alignment (L, R, both) →
 *   shoulder flaps (L, R) → dorsal flaps (L, R) → calf flaps → weapons
 *   (a forearm armor panel rises on the anti-tank launcher; each trapezius
 *   panel shifts up on a forward-facing mini-rocket silo; hip panels slide
 *   out over the flare dispensers, which test-pop) → thruster hover
 *   test (lift off to ~45 cm, hold, set down) → all surfaces → nominal
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
  /** JARVIS status line for this step. */
  status: string;
  /** False before the first step and after the last. */
  active: boolean;
}

export const FLIGHT_CHECK_START = 0.6;
export const FLIGHT_CHECK_END = 31.9;
/** Hover height of the thruster test (m). */
export const HOVER_HEIGHT = 0.45;

/** Status lines with the time each step starts. */
export const FLIGHT_CHECK_STEPS: ReadonlyArray<{ at: number; status: string; item: string; group: string }> = [
  { at: 0.6, status: 'FLIGHT CONTROL CHECK · HAND + NECK SERVOS', item: 'HAND / NECK SERVOS', group: 'SERVOS' },
  { at: 4.5, status: 'REPULSOR ALIGNMENT · L / R', item: 'REPULSORS L / R', group: 'HANDS' },
  { at: 9.2, status: 'FLIGHT STABILIZERS · SHOULDER FLAPS', item: 'SHOULDER FLAPS', group: 'STABILIZERS' },
  { at: 11.8, status: 'FLIGHT STABILIZERS · DORSAL FLAPS', item: 'DORSAL FLAPS', group: 'STABILIZERS' },
  { at: 14.4, status: 'FLIGHT STABILIZERS · CALF FLAPS', item: 'CALF FLAPS', group: 'STABILIZERS' },
  { at: 17.0, status: 'WEAPONS · ARMING CHECK', item: 'LAUNCHER / ROCKET SILOS', group: 'WEAPONS' },
  { at: 24.0, status: 'BOOT THRUSTERS · HOVER TEST', item: 'HOVER TEST', group: 'THRUSTERS' },
  { at: 29.6, status: 'ALL SURFACES · FULL DEFLECTION', item: 'FULL DEFLECTION', group: 'ALL SURFACES' },
  { at: 31.2, status: 'FLIGHT CONTROLS NOMINAL', item: 'FLIGHT CONTROLS', group: 'NOMINAL' },
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

/** Boots come together only for the hover (as in the film). */
const LEGS_IN: Keys = [
  [23.9, 0],
  [25.2, 1],
  [29.0, 1],
  [29.9, 0],
];

const NECK_YAW: Keys = [
  [1.4, 0],
  [2.0, 0.5], // look left
  [2.5, 0.5],
  [3.3, -0.5], // look right
  [3.7, -0.5],
  [4.2, 0],
];
const NECK_PITCH: Keys = [
  [3.6, 0],
  [4.0, 0.12], // check down
  [4.3, 0.12],
  [4.6, 0],
];

const ARMS: Keys = [
  [4.6, 0],
  [5.6, 0.8], // arms out
  [8.5, 0.8],
  [9.3, 0],
  [17.0, 0],
  [17.8, 0.8], // arms out for the launchers
  [23.0, 0.8],
  [23.8, 0],
];
const WRIST_L: Keys = [
  [5.7, 0],
  [6.1, 1],
  [6.6, 1],
  [7.0, 0],
  [7.4, 0],
  [7.8, 1],
  [8.1, 1],
  [8.5, 0],
];
const WRIST_R: Keys = [
  [6.6, 0],
  [7.0, 1],
  [8.1, 1],
  [8.5, 0],
];
/** Palm discharge times. */
const FLASH_L = [6.15, 7.9];
const FLASH_R = [7.05, 7.9];

// Flaps: one side, then the other — open, hold, close
// Staggered: the right side follows the left a beat later, overlapping
const STAGGER = 0.35;
const lag = (k: readonly [number, number, number, number]) =>
  [k[0] + STAGGER, k[1] + STAGGER, k[2] + STAGGER, k[3] + STAGGER] as const;
const SHOULDER_L = [9.4, 9.95, 10.55, 11.05] as const;
const SHOULDER_R = lag(SHOULDER_L);
const BACK_L = [11.9, 12.45, 13.05, 13.55] as const;
const BACK_R = lag(BACK_L);
const CALF_L = [14.5, 15.05, 15.75, 16.25] as const;
const CALF_R = lag(CALF_L);
/** Finger servo check: a fist rolls closed pinky → thumb, then opens. */
const FIST_L = [1.0, 1.55, 2.0, 2.45] as const;
const FIST_R = lag(FIST_L);

const ALL = [29.7, 30.3, 30.6, 31.2] as const;

// Weapons: launchers L then R; dorsal flaps open, guns rise, traverse, stow
const LAUNCH_L = [17.6, 18.3, 22.4, 23.0] as const;
const LAUNCH_R = [18.0, 18.7, 22.5, 23.1] as const;
const SILOS = [18.8, 19.6, 22.1, 22.9] as const;
// Flare dispensers: hip panels slide out, test pops, slide home
const FLARE_DOORS = [19.9, 20.3, 21.9, 22.3] as const;
/** Flare pops (flight-check s) per side. */
export const FLARE_POPS: ReadonlyArray<{ t: number; side: 'L' | 'R' }> = [
  { t: 20.55, side: 'L' },
  { t: 20.85, side: 'R' },
  { t: 21.2, side: 'L' },
  { t: 21.3, side: 'R' },
];

// Hover test
const IGNITE = 24.3;
const SPOOL = 24.9;
const LIFTOFF = 25.2;
const HOVER = 26.5;
const DESCEND = 27.8;
const TOUCHDOWN = 28.8;
const CUTOFF = 29.2;

/** Sound / FX cue sheet for the check (flight-check seconds). */
export const FLIGHT_EVENTS: readonly FlightEvent[] = [
  { t: 0.6, kind: 'servo', side: 'both' },
  { t: FIST_L[0], kind: 'servo', side: 'L' },
  { t: FIST_L[0] + STAGGER, kind: 'servo', side: 'R' },
  { t: 1.4, kind: 'servo' },
  { t: 2.5, kind: 'servo' },
  { t: 3.7, kind: 'servo' },
  { t: 4.6, kind: 'servo', side: 'both' },
  { t: FLASH_L[0], kind: 'repulsor', side: 'L' },
  { t: FLASH_R[0], kind: 'repulsor', side: 'R' },
  { t: FLASH_L[1], kind: 'repulsor', side: 'both' },
  { t: 8.5, kind: 'servo', side: 'both' },
  ...([
    [SHOULDER_L, 'L'],
    [SHOULDER_R, 'R'],
    [BACK_L, 'L'],
    [BACK_R, 'R'],
    [CALF_L, 'L'],
    [CALF_R, 'R'],
    [FLARE_DOORS, 'both'],
    [ALL, 'both'],
  ] as const).flatMap(([k, side]): FlightEvent[] => [
    { t: k[0], kind: 'flapOpen', side },
    { t: k[2], kind: 'flapClose', side },
  ]),
  { t: 17.0, kind: 'servo', side: 'both' },
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
  { t: 23.0, kind: 'servo', side: 'both' },
  { t: IGNITE, kind: 'ignite' },
  { t: LIFTOFF, kind: 'liftoff' },
  { t: TOUCHDOWN, kind: 'touchdown' },
  { t: CUTOFF, kind: 'cutoff' },
  { t: 31.2, kind: 'nominal' },
];

/** Wrist bend for the hover (1 = repulsor gesture, ~1.45 = full L). */
const HOVER_WRIST = 1.45;

/** Ripple delay per finger [thumb, index, middle, ring, pinky] (s). */
const RIPPLE = [0.2, 0.15, 0.1, 0.05, 0];

function fingers(t: number, side: 'L' | 'R', air: number): number[] {
  const fist = side === 'L' ? FIST_L : FIST_R;
  // Palms flat (fingers straight) for repulsor shots and in the air
  const wrist = keyed(t, side === 'L' ? WRIST_L : WRIST_R);
  const flat = -0.25 * Math.max(Math.min(1, wrist), air);
  return RIPPLE.map((d, i) => {
    const k = move(t, fist[0] + d, fist[1] + d, fist[2] + d * 0.5, fist[3] + d * 0.5);
    return Math.max(k * (i === 0 ? 0.8 : 1), 0) + flat * (1 - k);
  });
}

export function evaluateFlightCheck(t: number): FlightCheckFrame {
  const active = t >= FLIGHT_CHECK_START && t < FLIGHT_CHECK_END;

  // Neck: left, right, a glance down, centre
  const headYaw = keyed(t, NECK_YAW);
  const headPitch = keyed(t, NECK_PITCH);

  // Repulsors: arms out, each palm up and fires, then both
  let stance = keyed(t, ARMS);
  let wristL = keyed(t, WRIST_L);
  let wristR = keyed(t, WRIST_R);
  const flash = (a: number) => (t >= a ? Math.exp(-(t - a) * 5) : 0);
  let repulsorL = Math.max(...FLASH_L.map(flash));
  let repulsorR = Math.max(...FLASH_R.map(flash));

  // Hover: ignition, spool, lift off, hold with a slow trim bob, set down
  const ignite = t >= IGNITE && t < SPOOL ? (t < IGNITE + 0.18 || (t > IGNITE + 0.32 && t < IGNITE + 0.5) ? 0.5 : 0.15) : 0;
  const burn = keyed(t, [
    [SPOOL, 0],
    [LIFTOFF, 1],
    [TOUCHDOWN, 1],
    [CUTOFF, 0],
  ]);
  const thrusters = Math.max(ignite, burn);
  const climb = keyed(t, [
    [LIFTOFF, 0],
    [HOVER, 1],
    [DESCEND, 1],
    [TOUCHDOWN, 0],
  ]);
  const bob = t > HOVER - 0.3 && t < DESCEND + 0.3 ? 0.015 * Math.sin((t - HOVER) * Math.PI * 1.3) * move(t, HOVER - 0.3, HOVER, DESCEND, DESCEND + 0.3) : 0;
  const lift = HOVER_HEIGHT * climb + bob;
  // Arms ease out a little, palms down as stabilizers while airborne
  const air = keyed(t, [
    [SPOOL, 0],
    [LIFTOFF + 0.4, 1],
    [DESCEND + 0.4, 1],
    [CUTOFF, 0],
  ]);
  // Hover pose: arms in close, hands bent up in an L so the repulsors
  // point straight down at the deck
  stance = Math.max(stance, 0.1 * air);
  wristL = Math.max(wristL, HOVER_WRIST * air);
  wristR = Math.max(wristR, HOVER_WRIST * air);
  repulsorL = Math.max(repulsorL, 0.55 * air);
  repulsorR = Math.max(repulsorR, 0.55 * air);

  const flap = (k: readonly [number, number, number, number]) => clamp01(move(t, k[0], k[1], k[2], k[3]));
  const all = flap(ALL);
  const flaps: Record<FlapId, number> = {
    'shoulder.L': Math.max(flap(SHOULDER_L), all),
    'shoulder.R': Math.max(flap(SHOULDER_R), all),
    'back.L': Math.max(flap(BACK_L), all),
    'back.R': Math.max(flap(BACK_R), all),
    'launcher.L': flap(LAUNCH_L),
    'launcher.R': flap(LAUNCH_R),
    'trap.L': flap(SILOS),
    'trap.R': flap(SILOS),
    'calf.L': Math.max(flap(CALF_L), all),
    'calf.R': Math.max(flap(CALF_R), all),
    'flare.L': flap(FLARE_DOORS),
    'flare.R': flap(FLARE_DOORS),
  };

  let status = '';
  for (const s of FLIGHT_CHECK_STEPS) if (t >= s.at) status = s.status;

  return {
    pose: {
      stance,
      chestRecoil: 0,
      headPitch,
      headYaw,
      wristL: Math.max(0, wristL),
      wristR: Math.max(0, wristR),
      lift,
      legsIn: keyed(t, LEGS_IN),
      fingersL: fingers(t, 'L', air),
      fingersR: fingers(t, 'R', air),
    },
    flaps,
    repulsorL: clamp01(repulsorL),
    repulsorR: clamp01(repulsorR),
    thrusters,
    status: active ? status : '',
    active,
  };
}
