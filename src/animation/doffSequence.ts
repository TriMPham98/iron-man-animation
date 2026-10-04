import type { ArmorPieceId } from '../suit/armorPieces';
import type { BoneName, Vec3 } from '../suit/rig';
import type { SystemPowers } from '../suit/systemsGlow';
import type { FitTiming, FxBurst, RobotTrack, SuitUpFrame } from './suitUpChoreography';

/**
 * Doffing: the finished suit is taken off the way it went on, but with its
 * own opening act before the robots come back for the parts.
 *
 *   power-down (eyes gutter out, repulsors fade; the arc reactor surges,
 *     browns out and winds down coil by coil to a standby glow)
 *   → faceplate unlatches and swings up
 *   → pressure seals vent: jets blast straight down off the suit, collar to
 *     boots, and every part's locks let go in the same wave — each plate
 *     pops a centimetre proud of its seat (clamshells crack open)
 *   → extraction: the fitting runs backwards — the grippers (already up
 *     from the ring before the doff begins) lift each loosened part off and
 *     set it back on its stand, which then sinks through its port with the
 *     part; each arm folds away once its last part is home, the boots sink
 *     into the hatch. The riveters stay stowed throughout.
 *
 * Times are wall-clock seconds from the start of the doff. The opening act
 * is a pure function of time ({@link evaluateDoff}); the extraction reuses
 * the suit-up evaluator with the clock running backwards, and the released
 * state is laid over it so loosened parts stay loose until they are taken.
 */

/** Opening act: power-down → faceplate → seal release. */
export const DOFF_RELEASE_SEC = 2.6;
/**
 * The extraction plays the fitting backwards at the assembly's own speed
 * (one second of suit-up per second), so it lasts as long as the build.
 */
export const DOFF_EXTRACT_RATE = 1;

/**
 * Seed seconds (the extraction clock runs backwards) between a part being
 * set down — the gripper back at its hover over the cradle — and its stand
 * starting to sink with it.
 */
const STAND_SINK_DELAY = 0.1;
/** Rest at home after an arm's last part before it folds away (s). */
const ARM_STOW_DELAY = 0.15;
/** Fold-and-sink stroke of a gripper at the end of its doff work (s). */
export const DOFF_ARM_STOW_SEC = { floor: 1.2, ceiling: 0.9 } as const;

/** Seed time a doffed part's stand starts to sink (clock running backwards). */
export function doffStandSinkAt(job: Pick<FitTiming, 'preGrasp'>): number {
  return job.preGrasp - STAND_SINK_DELAY;
}

/**
 * Seed time a gripper starts folding away after the doff (clock running
 * backwards): once it is home from its first job of the build. Null for
 * arms with no carry jobs (riveters, which never deploy for the doff).
 */
export function doffArmStowAt(track: Pick<RobotTrack, 'jobs'>): number | null {
  return track.jobs.length ? track.jobs[0].depart - ARM_STOW_DELAY : null;
}

/**
 * Seed time by which every floor arm and stand of `tracks` is down on the
 * doff clock. The clock runs backwards, so this is the earliest finish (the
 * last one reached), never the latest: the ring may only shut after it.
 */
export function doffFloorDownAt(tracks: ReadonlyArray<Pick<RobotTrack, 'jobs'>>, standSec: number): number {
  let at = Infinity;
  for (const track of tracks) {
    const stow = doffArmStowAt(track);
    if (stow != null) at = Math.min(at, stow - DOFF_ARM_STOW_SEC.floor);
    for (const job of track.jobs) at = Math.min(at, doffStandSinkAt(job) - standSec);
  }
  return at;
}

const POWER_DOWN = 0.1;
/** Arc reactor: coils wind down and go dark one by one, then the core collapses (doff s). */
export const REACTOR_SPIN = [0.5, 1.2] as const;
export const REACTOR_COLLAPSE = [1.2, 1.38] as const;
/** Standby glow the reactor keeps until its housing comes off. */
const REACTOR_STANDBY = 0.12;
/** Brown-out: the core dips and catches twice before it starts to fail. */
const BROWNOUT: ReadonlyArray<readonly [number, number]> = [
  [0.28, 0.35],
  [0.31, 0.95],
  [0.36, 0.25],
  [0.4, 0.85],
];
const FACEPLATE_LATCH = 0.55;
const FACEPLATE_OPEN = [0.62, 1.45] as const;
/** Seal-release wave: crown at the start, soles at the end. */
const RELEASE_WAVE = [1.25, 2.3] as const;
/** How far a released plate stands proud of its seat (m). */
export const RELEASE_GAP = 0.011;
/** Suit height the release wave runs down (bind m). */
const CROWN_Y = 1.8;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, t: number) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * (3 - 2 * u);
};

/** Arc reactor core power at doff time `t`: surge, brown-out, wind-down, collapse to standby. */
export function reactorCore(t: number): number {
  if (t < BROWNOUT[0][0]) return 1;
  if (t < REACTOR_SPIN[0]) {
    let v = 1;
    for (const [at, k] of BROWNOUT) if (t >= at) v = k;
    return v;
  }
  const wind = 0.85 - 0.5 * smooth(REACTOR_SPIN[0], REACTOR_SPIN[1], t);
  return wind - (wind - REACTOR_STANDBY) * smooth(REACTOR_COLLAPSE[0], REACTOR_COLLAPSE[1], t);
}

/**
 * Share of the reactor's light carried by its power-down overlay (the glass
 * itself is dimmed under it so the coils read): in as the surge starts, out
 * once the core has sat at standby for a beat.
 */
export function reactorOverlayShare(t: number): number {
  return smooth(0.12, 0.3, t) * (1 - smooth(REACTOR_COLLAPSE[1] + 0.4, REACTOR_COLLAPSE[1] + 1.2, t));
}

/** When the release wave reaches a bind height. */
export function releaseAt(y: number): number {
  return RELEASE_WAVE[0] + (RELEASE_WAVE[1] - RELEASE_WAVE[0]) * clamp01((CROWN_Y - y) / CROWN_Y);
}

/** Lock let go: snaps past the gap, rebounds, settles proud (0 → 1). */
function popCurve(t: number, at: number): number {
  const u = t - at;
  if (u <= 0) return 0;
  if (u < 0.05) return 1.5 * smooth(0, 0.05, u);
  return 1 + 0.5 * Math.exp(-(u - 0.05) / 0.05) * Math.cos((u - 0.05) * 38);
}

export interface DoffPart {
  id: ArmorPieceId;
  /** Bind-space height of the part's centre (orders the release wave). */
  y: number;
  /** Insert-channel units per metre (1 / insert stroke length). */
  perMetre: number;
  /** Boots ride the floor lift: they are never popped. */
  lift?: boolean;
}

export interface DoffOverlay {
  /** Minimum insert channel per part (released gap). */
  release: Map<ArmorPieceId, number>;
  /** Faceplate hinge floor (1 = open). */
  faceplate: number;
  /** Ceiling on each system's glow. */
  systems: SystemPowers;
}

/** The opening act's hold on the suit at doff time `t` (carried through the extraction). */
export function evaluateDoff(t: number, parts: readonly DoffPart[]): DoffOverlay {
  const release = new Map<ArmorPieceId, number>();
  for (const p of parts) {
    if (p.lift) continue;
    const k = popCurve(t, releaseAt(p.y));
    if (k > 0) release.set(p.id, k * RELEASE_GAP * p.perMetre);
  }
  // Eyes gutter: two dying flickers, then dark
  const u = t - POWER_DOWN;
  const flicker = u < 0 ? 1 : u < 0.08 ? 0.25 : u < 0.16 ? 0.9 : u < 0.22 ? 0.1 : u < 0.3 ? 0.55 : Math.max(0, 0.55 - (u - 0.3) * 3);
  return {
    release,
    // The latch snaps the mask off its seal a hair, then it swings up
    faceplate: Math.max(smooth(FACEPLATE_OPEN[0], FACEPLATE_OPEN[1], t), t > FACEPLATE_LATCH ? 0.035 : 0),
    systems: {
      eyes: flicker,
      repulsors: 1 - smooth(POWER_DOWN, POWER_DOWN + 0.6, t),
      // Reactor winds down to a standby glow that stays lit until the housing comes off
      reactor: reactorCore(t) * (1 - 0.7 * reactorOverlayShare(t)),
    },
  };
}

/** Lay the doff state over an evaluated suit-up frame (in place). */
export function applyDoff(frame: SuitUpFrame, o: DoffOverlay): SuitUpFrame {
  for (const pf of frame.pieces) {
    const r = o.release.get(pf.id);
    if (r !== undefined && pf.insert < r) pf.insert = r;
    if (pf.id === 'faceplate') pf.hinge = Math.max(pf.hinge, o.faceplate);
  }
  frame.systems = {
    reactor: Math.min(frame.systems.reactor, o.systems.reactor),
    eyes: Math.min(frame.systems.eyes, o.systems.eyes),
    repulsors: Math.min(frame.systems.repulsors, o.systems.repulsors),
  };
  return frame;
}

/** Pressure jets of the seal release, each fired as the wave passes its height. */
const VENTS: ReadonlyArray<{ bone: BoneName; at: Vec3; dir: Vec3; count: number; both?: boolean }> = [
  { bone: 'neck', at: [0.075, 1.6, -0.11], dir: [0.2, -1, -0.5], count: 26, both: true },
  { bone: 'chest', at: [0.2, 1.42, -0.09], dir: [0.35, -1, -0.25], count: 16, both: true },
  { bone: 'spine', at: [0.16, 1.15, 0.1], dir: [0.3, -1, 0.3], count: 12, both: true },
  { bone: 'hips', at: [0.2, 0.93, 0.0], dir: [0.3, -1, 0.02], count: 16, both: true },
  { bone: 'shin.L', at: [0.2, 0.48, -0.03], dir: [0.3, -1, -0.1], count: 12 },
  { bone: 'shin.R', at: [-0.2, 0.48, -0.03], dir: [-0.3, -1, -0.1], count: 12 },
  { bone: 'foot.L', at: [0.16, 0.07, 0.0], dir: [0.35, -1, 0.15], count: 14 },
  { bone: 'foot.R', at: [-0.16, 0.07, 0.0], dir: [-0.35, -1, 0.15], count: 14 },
];

/** Seal-release bursts (and the reactor's collapse spark) on the doff clock (`t` = doff seconds). */
export function doffBursts(): FxBurst[] {
  // A few sparks off the reactor ring as its core collapses
  const out: FxBurst[] = [
    { t: REACTOR_COLLAPSE[0] + 0.01, kind: 'sparks', bone: 'chest', at: [0, 1.436, 0.18], count: 9, dir: [0, -0.2, 1] },
  ];
  for (const v of VENTS) {
    const t = releaseAt(v.at[1]) - 0.02;
    out.push({ t, kind: 'steam', bone: v.bone, at: v.at, count: v.count, dir: v.dir });
    if (v.both) {
      out.push({
        t: t + 0.015,
        kind: 'steam',
        bone: v.bone,
        at: [-v.at[0], v.at[1], v.at[2]],
        count: v.count,
        dir: [-v.dir[0], v.dir[1], v.dir[2]],
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Sound events of the opening act (doff seconds). */
export interface DoffEvent {
  t: number;
  kind: 'powerDown' | 'reactorSpinDown' | 'reactorCollapse' | 'faceplateLatch' | 'faceplateOpen' | 'vent' | 'release' | 'armRise';
}

export function doffEvents(parts: readonly DoffPart[]): DoffEvent[] {
  const ev: DoffEvent[] = [
    { t: POWER_DOWN, kind: 'powerDown' },
    { t: REACTOR_SPIN[0], kind: 'reactorSpinDown' },
    { t: REACTOR_COLLAPSE[0], kind: 'reactorCollapse' },
    { t: FACEPLATE_LATCH, kind: 'faceplateLatch' },
    { t: FACEPLATE_OPEN[0], kind: 'faceplateOpen' },
  ];
  // One vent cue per jet height (pairs fire together)
  const seen = new Set<number>();
  for (const b of doffBursts()) {
    if (b.kind !== 'steam') continue;
    const k = Math.round(b.t * 20);
    if (seen.has(k)) continue;
    seen.add(k);
    ev.push({ t: b.t, kind: 'vent' });
  }
  for (const p of parts) if (!p.lift) ev.push({ t: releaseAt(p.y), kind: 'release' });
  return ev.sort((a, b) => a.t - b.t);
}

/** JARVIS lines for the doff (doff seconds). */
export const DOFF_STATUSES: ReadonlyArray<{ t: number; text: string }> = [
  { t: 0, text: 'DOFFING SEQUENCE INITIATED' },
  { t: POWER_DOWN + 0.2, text: 'ARC REACTOR · POWER DOWN' },
  { t: FACEPLATE_LATCH, text: 'FACEPLATE RELEASE' },
  { t: RELEASE_WAVE[0], text: 'PRESSURE SEALS · VENTING' },
  { t: DOFF_RELEASE_SEC, text: 'ARMOR EXTRACTION' },
];
