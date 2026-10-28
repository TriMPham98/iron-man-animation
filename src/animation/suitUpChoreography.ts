import choreSeed from '../audio/choreTimeline.seed.json';
import { armorPieceDef, type ArmorPieceId } from '../suit/armorPieces';
import type { BoneName, Vec3 } from '../suit/rig';
import {
  cradleFor,
  FIT_TASKS,
  ROBOTS,
  TOOL_JOBS,
  type ClickTrain,
  type FitKind,
  type FitTask,
  type RobotId,
} from '../workshop/fittingProgram';
import type { SuitPose } from '../suit/rigPose';
import type { SystemPowers } from '../suit/systemsGlow';
import {
  FACEPLATE_STATUS,
  REPULSOR_STATUS,
  WAVE_ORDER,
  WAVE_STATUS,
  type PieceWave,
} from '../suit/waves';
import {
  monotoneCubic,
  sampleTrack,
  type EaseName,
  type Key,
  type Track,
} from './keyframes';
import {
  audioTimelineOffset,
  gy,
  HERO_END_CAM,
  OPEN_WIDE_CAM,
  type CameraPose,
} from './sequenceClock';

/**
 * Mark III suit-up (Iron Man, 2008) choreographed onto the director SFX mix.
 *
 * Every mechanical beat is pinned to a measured transient inside a clip of
 * `choreTimeline.seed.json` (spectral-flux / peak-envelope onsets, in seconds
 * into the source file). Beats resolve through the seed's clip start, crop and
 * pitch, so promoting a re-timed mix moves the animation with it.
 *
 * All times here are on the **seed clock** (HUD timer / audio ruler).
 */

interface SeedClip {
  id: string;
  start: number;
  cropIn: number;
  pitch: number;
}

interface SfxOnset {
  /** Seed clip id. */
  clip: string;
  /** Transient position inside the source file (s). */
  src: number;
  /** Seed time used if the clip is missing from the seed. */
  fallback: number;
}

const SEED_CLIPS: SeedClip[] = (choreSeed as { clips: SeedClip[] }).clips;

/** Seed-clock time of a transient inside a seed clip. */
export function seedOnset(o: SfxOnset, clips: readonly SeedClip[] = SEED_CLIPS): number {
  const c = clips.find((x) => x.id === o.clip);
  if (!c) return o.fallback;
  const pitch = c.pitch > 0 ? c.pitch : 1;
  return c.start + (o.src - c.cropIn) / pitch;
}

/**
 * Measured transients → suit-up beats. `src` offsets come from onset analysis
 * of each source file; comments name the sound that sells the beat.
 */
export const SFX_ONSETS = {
  /** Clasp swell crest — left boot lift locks under the ankle. */
  bootL: { clip: 'clip-seed-v5-01', src: 0.4, fallback: 0.22 },
  /** Second clasp bite — right boot. */
  bootR: { clip: 'clip-seed-v5-01', src: 0.58, fallback: 0.4 },
  /** Ratchet strike — shin clamshells close. */
  shins: { clip: 'clip-seed-v5-02', src: 0.045, fallback: 1.223 },
  /** Low ratchet strike — thigh clamshells close. */
  thighs: { clip: 'clip-seed-v5-04', src: 0.045, fallback: 2.749 },
  /** Conveyor-hiss crest — pneumatic waist seal. */
  hips: { clip: 'clip-seed-v5-03', src: 0.656, fallback: 3.091 },
  /** Robot-arm servo start — the torso cell spins up. */
  torsoStart: { clip: 'clip-seed-v5-05', src: 0.02, fallback: 3.696 },
  /** Connect-hiss first accent — lower back plate seats. */
  backLower: { clip: 'clip-seed-v5-06', src: 0.82, fallback: 4.583 },
  /** Robot-arm accent — upper back plate locks. */
  backClamp: { clip: 'clip-seed-v5-05', src: 1.4, fallback: 5.076 },
  /** Connect-hiss accent — abdomen plate seats. */
  abdomen: { clip: 'clip-seed-v5-06', src: 1.46, fallback: 5.223 },
  /** Robot-arm accent — reactor housing seats (inner layer first). */
  chestCore: { clip: 'clip-seed-v5-05', src: 1.718, fallback: 5.394 },
  /** Impact — both pecs slam home over the housing. */
  chestSlam: { clip: 'clip-seed-v5-07', src: 0.17, fallback: 5.925 },
  /** Repulsor attack — arc reactor catches. */
  reactorIgnite: { clip: 'clip-seed-v5-08', src: 0.08, fallback: 6.496 },
  /** Repulsor bloom — reactor at full. */
  reactorPeak: { clip: 'clip-seed-v5-08', src: 0.17, fallback: 6.586 },
  /** Low ratchet strike — shoulder servos brace; pec rivets ride its clicks. */
  armBrace: { clip: 'clip-seed-v5-09', src: 0.045, fallback: 6.859 },
  /** Metal two-hits #1 — left pauldron (shoulder before bicep). */
  pauldronL: { clip: 'clip-seed-v5-10', src: 0.43, fallback: 7.448 },
  /** Metal two-hits #2 — right pauldron. */
  pauldronR: { clip: 'clip-seed-v5-10', src: 0.73, fallback: 7.748 },
  /** Metal-tighten attack (+ motor accent) — left upper-arm clamshell. */
  upperArmL: { clip: 'clip-seed-v5-12', src: 0.02, fallback: 8.533 },
  /** Metal-tighten second bite — right upper-arm clamshell. */
  upperArmR: { clip: 'clip-seed-v5-12', src: 0.5, fallback: 9.013 },
  /** Drill bite — left forearm sleeve screws home. */
  forearmL: { clip: 'clip-seed-v5-13', src: 0.29, fallback: 9.337 },
  /** Drill second run — right forearm sleeve. */
  forearmR: { clip: 'clip-seed-v5-13', src: 0.63, fallback: 9.677 },
  /** Metal-connect first hit — left gauntlet. */
  gauntletL: { clip: 'clip-seed-v5-15', src: 0.24, fallback: 10.175 },
  /** Metal-connect peak — right gauntlet. */
  gauntletR: { clip: 'clip-seed-v5-15', src: 0.38, fallback: 10.315 },
  /** Metal-resonate swell crest — helmet seats. */
  helmetSeat: { clip: 'clip-seed-v5-14', src: 1.02, fallback: 10.94 },
  /** Clang pre-hit — arms lock at the sides, faceplate latch releases. */
  armsLock: { clip: 'clip-seed-v5-16', src: 0.813, fallback: 11.821 },
  /** Clang — faceplate slams shut. */
  faceplate: { clip: 'clip-seed-v5-16', src: 1.085, fallback: 12.093 },
  /** First BCI beep — eyes flicker on. */
  eyesOn: { clip: 'clip-seed-v5-17', src: 0.1, fallback: 12.175 },
  /** BCI phrase accent — eyes at full. */
  eyesFull: { clip: 'clip-seed-v5-17', src: 0.43, fallback: 12.505 },
  /** Steam hiss — helmet pressure vents. */
  steamVent: { clip: 'clip-seed-v5-18', src: 0.1, fallback: 12.753 },
} as const satisfies Record<string, SfxOnset>;

export type SuitUpBeat = keyof typeof SFX_ONSETS;
export type SuitUpBeats = Record<SuitUpBeat, number>;

/** Ratchet click train (source seconds) — shared by all three ratchet clips. */
const RATCHET_CLICKS_SRC = [0.18, 0.273, 0.377, 0.47, 0.563, 0.644] as const;
/** Drill bites per hand (source seconds into drill-tighten). */
const DRILL_L_SRC = [0.319, 0.441, 0.575] as const;
const DRILL_R_SRC = [0.697, 0.784, 0.871, 0.952] as const;

export function resolveBeats(clips: readonly SeedClip[] = SEED_CLIPS): SuitUpBeats {
  const out = {} as SuitUpBeats;
  for (const key of Object.keys(SFX_ONSETS) as SuitUpBeat[]) {
    out[key] = seedOnset(SFX_ONSETS[key], clips);
  }
  return out;
}

function clicks(clip: string, srcs: readonly number[], clips: readonly SeedClip[]): number[] {
  return srcs.map((src) => seedOnset({ clip, src, fallback: NaN }, clips)).filter(Number.isFinite);
}

// ── Plan types ───────────────────────────────────────────────────────────

/**
 * One robot job on the seed clock. A cycle reads like a real cell program:
 * transit → hover over the cradle → descend + close the gripper → lift and
 * carry to the staging pose → straight insertion that lands on the SFX hit →
 * hold while the part locks (nut runner spins, sparks) → open → back off.
 */
export interface FitTiming {
  task: string;
  robot: RobotId | null;
  kind: FitKind;
  pieces: ArmorPieceId[];
  wave: PieceWave;
  /** Leaves its previous pose for this cradle. */
  depart: number;
  /** Hovering above the cradle. */
  preGrasp: number;
  /** At the grasp pose — gripper starts closing. */
  grasp: number;
  /** Gripper closed; carry begins. */
  lift: number;
  /** Staging pose reached. */
  stage: number;
  /** Insertion begins. */
  insert: number;
  /** Clamp contact — the SFX transient. */
  contact: number;
  /** Gripper starts opening (part locked). */
  release: number;
  /** Gripper open — backing off. */
  retreat: number;
  /** Clear of the suit. */
  clear: number;
}

export interface PieceTrack {
  id: ArmorPieceId;
  task: string;
  wave: PieceWave;
  /** Carry 0 (on cradle) → 1 (staging pose). */
  carry: Track;
  /** Insertion 1 (staged / jaws open) → 0 (seated). */
  insert: Track;
  hinge: Track;
  twist: Track;
}

/** A riveting pass on a seated part. */
export interface ToolTiming {
  job: string;
  robot: RobotId;
  kind: 'rivet';
  piece: ArmorPieceId;
  /** Leaves home / the previous job. */
  depart: number;
  /** Hovering over the first site. */
  arrive: number;
  /** First strike. */
  start: number;
  /** Last strike done. */
  end: number;
  /** Backed off the part. */
  clear: number;
  /** Rivet strike times (one per site). */
  strikes: number[];
}

export interface RobotTrack {
  id: RobotId;
  /** Carry jobs in time order (grippers). */
  jobs: FitTiming[];
  /** Rivet passes in time order. */
  tools: ToolTiming[];
  /** 0 = deployed, 1 = folded and stowed below the floor / into the ceiling. */
  stow: Track;
  /** Gripper 0 = closed, 1 = open. */
  gripper: Track;
  /** Driver spindle angle (rad). */
  spindle: Track;
}

export interface FxBurst {
  t: number;
  kind: 'sparks' | 'steam';
  bone: BoneName;
  /** Bind-space emission point (carried by the bone's current pose). */
  at: Vec3;
  count: number;
  /** Spray bias in the model frame. */
  dir?: Vec3;
}

export interface CameraKey {
  t: number;
  /** Orbit azimuth around the look target (deg, 0 = front, + toward +X). */
  az: number;
  /** Horizontal distance from the look target. */
  r: number;
  /** Camera height. */
  y: number;
  look: Vec3;
  fov: number;
}

export interface SuitUpPlan {
  beats: SuitUpBeats;
  /** Seed time of GSAP 0 (start of the hangar pre-roll). */
  preRoll: number;
  fits: FitTiming[];
  tools: ToolTiming[];
  pieces: PieceTrack[];
  robots: RobotTrack[];
  pose: Record<keyof SuitPose, Track>;
  systems: Record<keyof SystemPowers, Track>;
  hologramReveal: Track;
  hologramOpacity: Track;
  rigOpacity: Track;
  hatch: Track;
  waves: Array<{ wave: PieceWave; t: number }>;
  statuses: Array<{ t: number; text: string }>;
  bursts: FxBurst[];
  shakes: Array<{ t: number; amp: number }>;
  camera: CameraKey[];
  /** Eyes ignite — integrity 100% / SYSTEMS ONLINE. */
  systemsOnlineAt: number;
  /** Swap pieces → seamless final mesh. */
  finalSwapAt: number;
}

// ── Robot cycle timing ───────────────────────────────────────────────────

/** Seconds per phase of a robot job (fast industrial cell, not cartoon). */
export const CYCLE = {
  transit: 0.42,
  descend: 0.1,
  grip: 0.12,
  stageHold: 0.03,
  connect: 0.28,
  open: 0.08,
  retreat: 0.18,
  /** Retreat → home when the next job is far off. */
  home: 0.65,
} as const;

const INSERT_SEC: Record<FitKind, number> = {
  clamp: 0.2,
  pair: 0.22,
  slide: 0.28,
  helmet: 0.24,
  lift: 0.12,
};

/** Carry duration from cradle → socket distance (m). */
export function carrySeconds(dist: number): number {
  return Math.min(1.0, Math.max(0.55, 0.42 + dist * 0.33));
}

function timingFor(task: FitTask, contact: number): Omit<FitTiming, 'depart'> & { depart: number } {
  const wave = armorPieceDef(task.pieces[0]).wave;
  const insertDur = INSERT_SEC[task.kind];
  if (task.kind === 'lift') {
    const lift = contact - insertDur - 0.73;
    return {
      task: task.id,
      robot: null,
      kind: task.kind,
      pieces: task.pieces,
      wave,
      depart: lift,
      preGrasp: lift,
      grasp: lift,
      lift,
      stage: contact - insertDur,
      insert: contact - insertDur,
      contact,
      release: contact,
      retreat: contact,
      clear: contact,
    };
  }
  const c = cradleFor(task);
  const dist = Math.hypot(c[0] - task.origin[0], c[1] - task.origin[1], c[2] - task.origin[2]);
  const insert = contact - insertDur;
  const stage = insert - CYCLE.stageHold;
  const lift = stage - carrySeconds(dist);
  const grasp = lift - CYCLE.grip;
  const preGrasp = grasp - CYCLE.descend;
  const release = contact + CYCLE.connect;
  const retreat = release + CYCLE.open;
  return {
    task: task.id,
    robot: task.robot,
    kind: task.kind,
    pieces: task.pieces,
    wave,
    depart: preGrasp - CYCLE.transit,
    preGrasp,
    grasp,
    lift,
    stage,
    insert,
    contact,
    release,
    retreat,
    clear: retreat + CYCLE.retreat,
  };
}

/** Tiny rotational "bites" on each ratchet / drill click. */
function tighten(ticks: readonly number[], amp = 0.035): Key[] {
  const out: Key[] = [];
  for (const t of ticks) {
    out.push({ t: t - 0.001, v: 0 });
    out.push({ t: t + 0.03, v: amp, ease: 'out2' });
    out.push({ t: t + 0.09, v: 0, ease: 'inOut2' });
  }
  return out;
}

const sorted = (keys: Key[]): Track => [...keys].sort((a, b) => a.t - b.t);
const mirror = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

export function buildSuitUpPlan(clips: readonly SeedClip[] = SEED_CLIPS): SuitUpPlan {
  const B = resolveBeats(clips);
  const preRoll = -audioTimelineOffset();
  const beatOf = (key: string): number => {
    const v = (B as Record<string, number>)[key];
    if (v === undefined) throw new Error(`Unknown beat ${key}`);
    return v;
  };

  const ratchetShins = clicks('clip-seed-v5-02', RATCHET_CLICKS_SRC, clips);
  const ratchetThighs = clicks('clip-seed-v5-04', RATCHET_CLICKS_SRC, clips);
  const ratchetArms = clicks('clip-seed-v5-09', RATCHET_CLICKS_SRC, clips);
  const drillL = clicks('clip-seed-v5-13', DRILL_L_SRC, clips);
  const drillR = clicks('clip-seed-v5-13', DRILL_R_SRC, clips);

  // ── Robot jobs ─────────────────────────────────────────────────────
  const fits = FIT_TASKS.map((task) => timingFor(task, beatOf(task.beat))).sort(
    (a, b) => a.contact - b.contact,
  );

  const pieces: PieceTrack[] = [];
  for (const f of fits) {
    const task = FIT_TASKS.find((t) => t.id === f.task)!;
    const insertEase: EaseName = f.kind === 'slide' ? 'inOut2' : 'in2';
    const carryEase: EaseName = f.kind === 'lift' ? 'out3' : 'inOut2';
    for (const id of task.pieces) {
      const def = armorPieceDef(id);
      let hinge: Track = [{ t: 0, v: 0 }];
      let twist: Track = [{ t: 0, v: 0 }];
      if (def.hinge) {
        // Open on the cradle and through the carry; latch releases on the
        // clang pre-hit and the mask slams on the clang itself.
        hinge = [
          { t: B.armsLock, v: 1 },
          { t: B.faceplate, v: 0, ease: 'in3' },
          { t: B.faceplate + 0.04, v: -0.012, ease: 'out2' },
          { t: B.faceplate + 0.16, v: 0, ease: 'inOut2' },
        ];
      }
      if (def.twist) {
        const side = id.endsWith('L') ? 'L' : 'R';
        // Forearm sleeves are drilled home; gauntlets bite twice
        const ticks =
          def.wave === 'arms'
            ? side === 'L'
              ? drillL
              : drillR
            : [f.contact + 0.1, f.contact + 0.2];
        twist = sorted([
          { t: f.insert, v: 1 },
          { t: f.contact, v: 0, ease: 'inOut2' },
          ...tighten(ticks.filter((t) => t > f.contact + 0.01 && t < f.release)),
        ]);
      }
      // Halves seat a hair apart: the back half bites first
      const jawLead = f.kind === 'pair' && id.endsWith('back') ? 0.015 : 0;
      pieces.push({
        id,
        task: f.task,
        wave: def.wave,
        carry: [
          { t: f.lift, v: 0 },
          { t: f.stage, v: 1, ease: carryEase },
        ],
        insert: [
          { t: f.insert, v: 1 },
          { t: f.contact - jawLead, v: 0, ease: insertEase },
          { t: f.contact - jawLead + 0.04, v: -0.05, ease: 'out2' },
          { t: f.contact - jawLead + 0.16, v: 0, ease: 'inOut2' },
        ],
        hinge,
        twist,
      });
    }
  }

  // ── Rivet passes ───────────────────────────────────────────────────
  const trains: Record<ClickTrain, number[]> = {
    shins: ratchetShins,
    thighs: ratchetThighs,
    arms: ratchetArms,
  };
  const tools: ToolTiming[] = TOOL_JOBS.map((job) => {
    const strikes = trains[job.clicks.train]
      .filter((_, i) => i % 2 === job.clicks.parity)
      .slice(0, job.points.length);
    const start = strikes[0];
    const end = strikes[strikes.length - 1] + 0.08;
    const arrive = start - 0.12;
    return {
      job: job.id,
      robot: job.robot,
      kind: job.kind,
      piece: job.piece,
      depart: arrive - CYCLE.transit,
      arrive,
      start,
      end,
      clear: end + CYCLE.retreat,
      strikes,
    };
  }).sort((a, b) => a.start - b.start);

  const robots: RobotTrack[] = ROBOTS.map((st) => {
    const jobs = fits.filter((f) => f.robot === st.id);
    const toolJobs = tools.filter((t) => t.robot === st.id);
    // Adjacent passes hop straight across (no full retreat)
    for (let k = 1; k < toolJobs.length; k++) {
      toolJobs[k].depart = Math.max(toolJobs[k].depart, toolJobs[k - 1].end + 0.02);
    }
    // Back-to-back jobs: leave straight from the retreat (shorter transit)
    for (let k = 1; k < jobs.length; k++) {
      jobs[k].depart = Math.max(jobs[k].depart, jobs[k - 1].clear);
    }
    const gripper: Key[] = [{ t: preRoll, v: 1 }];
    const spindle: Key[] = [{ t: preRoll, v: 0 }];
    let turns = 0;
    for (const j of jobs) {
      gripper.push({ t: j.grasp, v: 1 }, { t: j.lift - 0.02, v: 0, ease: 'inOut2' });
      gripper.push({ t: j.release, v: 0 }, { t: j.retreat, v: 1, ease: 'out2' });
      // Integrated nut runner spins up while the part locks
      spindle.push({ t: j.contact + 0.03, v: turns });
      turns += Math.PI * 2 * 3;
      spindle.push({ t: j.release, v: turns, ease: 'inOut2' });
    }
    // Once its last job is done the arm folds and stows out of shot
    const last = Math.max(
      preRoll,
      ...jobs.map((j) => j.clear),
      ...toolJobs.map((j) => j.clear),
    );
    // Floor arms fold home first; mast arms climb straight out of the shot
    const stowAt = st.mount === 'ceiling' ? last + 0.05 : last + CYCLE.home + 0.1;
    const stow: Track = [
      { t: stowAt, v: 0 },
      { t: stowAt + (st.mount === 'ceiling' ? 0.9 : 1.4), v: 1, ease: 'inOut2' },
    ];
    return {
      id: st.id,
      jobs,
      tools: toolJobs,
      stow,
      gripper: sorted(gripper),
      spindle: sorted(spindle),
    };
  });

  // ── Pose ───────────────────────────────────────────────────────────
  const armsDownStart = B.helmetSeat;
  const pose: Record<keyof SuitPose, Track> = {
    stance: [
      { t: preRoll + 0.12, v: 0 },
      { t: -0.12, v: 1, ease: 'inOut2' },
      { t: B.armBrace, v: 1 },
      { t: B.armBrace + 0.07, v: 1.04, ease: 'out2' },
      { t: B.armBrace + 0.32, v: 1, ease: 'inOut2' },
      { t: armsDownStart, v: 1 },
      { t: B.armsLock, v: 0, ease: 'inOut3' },
      { t: B.armsLock + 0.05, v: -0.02, ease: 'out2' },
      { t: B.armsLock + 0.22, v: 0, ease: 'inOut2' },
    ],
    chestRecoil: [
      { t: B.chestSlam, v: 0 },
      { t: B.chestSlam + 0.05, v: 1, ease: 'out2' },
      { t: B.chestSlam + 0.38, v: 0, ease: 'inOut2' },
    ],
    headPitch: [
      { t: B.faceplate, v: 0 },
      { t: B.faceplate + 0.04, v: 0.05, ease: 'out2' },
      { t: B.faceplate + 0.24, v: 0, ease: 'inOut2' },
      { t: B.steamVent, v: 0 },
      { t: B.steamVent + 0.85, v: -0.11, ease: 'inOut2' },
      { t: 15.3, v: -0.11 },
      { t: 16.9, v: 0, ease: 'inOut2' },
    ],
    // Repulsor check: palms flex once each gauntlet arm has backed clear
    wristL: [
      { t: B.gauntletL + 0.56, v: 0 },
      { t: B.gauntletL + 0.76, v: 0.6, ease: 'out3' },
      { t: armsDownStart + 0.1, v: 0.6 },
      { t: armsDownStart + 0.45, v: 0, ease: 'inOut2' },
    ],
    wristR: [
      { t: B.gauntletR + 0.56, v: 0 },
      { t: B.gauntletR + 0.74, v: 0.6, ease: 'out3' },
      { t: armsDownStart + 0.12, v: 0.6 },
      { t: armsDownStart + 0.47, v: 0, ease: 'inOut2' },
    ],
  };

  // ── Systems ────────────────────────────────────────────────────────
  const repulsorT = B.gauntletR + 0.5;
  const systems: Record<keyof SystemPowers, Track> = {
    reactor: [
      { t: B.reactorIgnite, v: 0 },
      { t: B.reactorIgnite + 0.03, v: 0.55, ease: 'out2' },
      { t: B.reactorIgnite + 0.065, v: 0.18 },
      { t: B.reactorPeak, v: 1, ease: 'out2' },
    ],
    eyes: [
      { t: B.eyesOn, v: 0 },
      { t: B.eyesOn + 0.03, v: 0.75, ease: 'out2' },
      { t: B.eyesOn + 0.09, v: 0.12 },
      { t: B.eyesOn + 0.16, v: 0.85, ease: 'out2' },
      { t: B.eyesFull, v: 1, ease: 'inOut2' },
    ],
    repulsors: [
      { t: repulsorT, v: 0 },
      { t: repulsorT + 0.12, v: 0.45, ease: 'out2' },
      { t: repulsorT + 0.45, v: 1, ease: 'inOut2' },
    ],
  };

  // ── Fitting FX ─────────────────────────────────────────────────────
  const hologramReveal: Track = [
    { t: preRoll, v: -0.05 },
    { t: preRoll + 0.6, v: 1.95, ease: 'inOut2' },
  ];
  const hologramOpacity: Track = [
    { t: preRoll, v: 1 },
    { t: B.helmetSeat, v: 1 },
    { t: B.faceplate + 0.12, v: 0, ease: 'inOut2' },
  ];
  const rigOpacity: Track = [
    { t: preRoll + 0.12, v: 0 },
    { t: preRoll + 0.5, v: 1, ease: 'out2' },
    { t: B.gauntletR, v: 0.85 },
    { t: B.helmetSeat, v: 0, ease: 'inOut2' },
  ];
  const hatch: Track = [
    { t: preRoll + 0.2, v: 0 },
    { t: preRoll + 0.45, v: 1, ease: 'out2' },
    { t: B.bootR + 0.25, v: 1 },
    { t: B.bootR + 0.75, v: 0, ease: 'inOut2' },
  ];

  // ── Waves (pipeline dots) + JARVIS status ─────────────────────────
  const waveStart = (w: PieceWave) =>
    Math.min(...fits.filter((f) => f.wave === w).map((f) => f.lift));
  const waves = WAVE_ORDER.map((wave) => ({
    wave,
    t: wave === 'power' ? B.armsLock : waveStart(wave),
  }));

  const statuses: Array<{ t: number; text: string }> = [
    { t: preRoll, text: 'STANDBY // HANGAR LOCK' },
    { t: preRoll + 0.3, text: 'J.A.R.V.I.S. ONLINE' },
    { t: preRoll + 0.7, text: 'ASSEMBLY SEQUENCE INITIATED' },
    { t: waveStart('boots'), text: WAVE_STATUS.boots },
    { t: waveStart('calves'), text: WAVE_STATUS.calves },
    { t: waveStart('thighs'), text: WAVE_STATUS.thighs },
    { t: waveStart('hips'), text: WAVE_STATUS.hips },
    { t: waveStart('torso'), text: WAVE_STATUS.torso },
    { t: B.reactorIgnite - 0.04, text: 'ARC REACTOR IGNITION…' },
    { t: B.reactorPeak + 0.18, text: 'ARC REACTOR ONLINE' },
    { t: B.armBrace + 0.12, text: WAVE_STATUS.arms },
    { t: waveStart('gauntlets'), text: WAVE_STATUS.gauntlets },
    { t: waveStart('shoulders'), text: WAVE_STATUS.shoulders },
    { t: repulsorT, text: REPULSOR_STATUS },
    { t: B.helmetSeat - 0.3, text: WAVE_STATUS.helmet },
    { t: B.armsLock, text: FACEPLATE_STATUS },
    { t: B.eyesOn, text: 'SYSTEMS ONLINE' },
  ].sort((a, b) => a.t - b.t);

  // ── Sparks / steam on the transients ──────────────────────────────
  const bursts: FxBurst[] = [];
  const both = (
    t: number,
    kind: FxBurst['kind'],
    bone: (s: 'L' | 'R') => BoneName,
    at: Vec3,
    count: number,
    dir?: Vec3,
  ) => {
    bursts.push({ t, kind, bone: bone('L'), at, count, dir });
    bursts.push({
      t: t + 0.012,
      kind,
      bone: bone('R'),
      at: mirror(at),
      count,
      dir: dir ? mirror(dir) : undefined,
    });
  };
  const one = (t: number, kind: FxBurst['kind'], bone: BoneName, at: Vec3, count: number, dir?: Vec3) =>
    bursts.push({ t, kind, bone, at, count, dir });

  // Pressure vents blast straight down off the suit (and fan out on the deck)
  one(B.bootL, 'steam', 'foot.L', [0.16, 0.06, 0.0], 16, [0.35, -1, 0.15]);
  one(B.bootR, 'steam', 'foot.R', [-0.16, 0.06, 0.0], 16, [-0.35, -1, 0.15]);
  // Clamshell seams: sparks where front meets back on both sides of the limb
  both(B.shins, 'sparks', (s) => `shin.${s}`, [0.215, 0.36, -0.03], 16, [1, 0.2, 0]);
  both(B.shins + 0.02, 'sparks', (s) => `shin.${s}`, [0.075, 0.3, -0.03], 8, [-0.3, 0.2, 1]);
  both(B.thighs, 'sparks', (s) => `thigh.${s}`, [0.205, 0.7, 0.0], 16, [1, 0.2, 0]);
  both(B.hips, 'steam', () => 'hips', [0.2, 0.93, 0.0], 14, [0.3, -1, 0.02]);
  one(B.hips, 'sparks', 'hips', [0.195, 0.9, 0.0], 14, [1, 0.3, 0]);
  both(B.backLower, 'sparks', () => 'spine', [0.15, 1.12, -0.1], 12, [0.6, 0.2, -1]);
  both(B.backClamp, 'sparks', () => 'chest', [0.17, 1.33, -0.15], 16, [0.5, 0.2, -1]);
  both(B.abdomen, 'sparks', () => 'spine', [0.15, 1.1, 0.1], 10, [0.6, 0, 0.8]);
  one(B.chestCore, 'sparks', 'chest', [0, 1.5, 0.17], 14, [0, 0.6, 1]);
  both(B.chestSlam, 'sparks', () => 'chest', [0.085, 1.33, 0.16], 30, [1, 0.3, 0.6]);
  both(B.chestSlam + 0.02, 'steam', () => 'chest', [0.2, 1.42, -0.08], 14, [0.35, -1, -0.25]);
  one(B.pauldronL, 'sparks', 'upperArm.L', [0.25, 1.52, 0.0], 22, [0.5, 1, 0.4]);
  one(B.pauldronR, 'sparks', 'upperArm.R', [-0.25, 1.52, 0.0], 22, [-0.5, 1, 0.4]);
  one(B.upperArmL, 'sparks', 'upperArm.L', [0.3, 1.36, -0.03], 18, [1, 0.4, 0]);
  one(B.upperArmR, 'sparks', 'upperArm.R', [-0.3, 1.36, -0.03], 18, [-1, 0.4, 0]);
  for (const t of [B.forearmL, ...drillL.filter((x) => x > B.forearmL + 0.01)]) {
    one(t, 'sparks', 'forearm.L', [0.285, 1.24, 0.0], 14, [0, 0.5, 1]);
  }
  for (const t of [B.forearmR, ...drillR.filter((x) => x > B.forearmR + 0.01)]) {
    one(t, 'sparks', 'forearm.R', [-0.285, 1.24, 0.0], 14, [0, 0.5, 1]);
  }
  one(B.gauntletL, 'sparks', 'hand.L', [0.375, 1.03, 0.03], 16, [0, 0.6, 1]);
  one(B.gauntletR, 'sparks', 'hand.R', [-0.375, 1.03, 0.03], 16, [0, 0.6, 1]);
  both(B.helmetSeat, 'steam', () => 'neck', [0.08, 1.58, -0.1], 14, [0.25, -1, -0.45]);
  both(B.faceplate, 'sparks', () => 'head', [0.075, 1.7, 0.06], 10, [1, 0.2, 0.5]);
  both(B.steamVent, 'steam', () => 'neck', [0.07, 1.6, -0.11], 26, [0.2, -1, -0.5]);
  both(B.steamVent + 0.04, 'steam', () => 'chest', [0.2, 1.42, -0.09], 14, [0.35, -1, -0.25]);
  bursts.sort((a, b) => a.t - b.t);

  // ── Camera shake on the heavy beats ───────────────────────────────
  const shakes = [
    { t: B.bootL, amp: 0.003 },
    { t: B.bootR, amp: 0.003 },
    { t: B.shins, amp: 0.005 },
    { t: B.thighs, amp: 0.006 },
    { t: B.hips, amp: 0.005 },
    { t: B.backLower, amp: 0.004 },
    { t: B.backClamp, amp: 0.007 },
    { t: B.abdomen, amp: 0.004 },
    { t: B.chestCore, amp: 0.006 },
    { t: B.chestSlam, amp: 0.02 },
    { t: B.reactorIgnite, amp: 0.004 },
    { t: B.upperArmL, amp: 0.005 },
    { t: B.upperArmR, amp: 0.005 },
    { t: B.forearmL, amp: 0.004 },
    { t: B.forearmR, amp: 0.004 },
    { t: B.gauntletL, amp: 0.005 },
    { t: B.gauntletR, amp: 0.005 },
    { t: B.pauldronL, amp: 0.006 },
    { t: B.pauldronR, amp: 0.006 },
    { t: B.helmetSeat, amp: 0.01 },
    { t: B.armsLock, amp: 0.004 },
    { t: B.faceplate, amp: 0.017 },
  ].sort((a, b) => a.t - b.t);

  // ── Camera (orbit keys around a moving look target) ───────────────
  const camera: CameraKey[] = [
    { ...orbitFromPose(OPEN_WIDE_CAM), t: preRoll },
    // Establish: rig in the stance inside the robot cell, hatches open
    { t: -0.25, az: 16, r: 3.85, y: gy(1.2), look: [0, gy(0.88), 0], fov: 36 },
    // Boots up through the floor
    { t: B.bootR - 0.1, az: 10, r: 2.2, y: gy(0.45), look: [0, gy(0.3), 0.02], fov: 32 },
    // Shin clamshells close
    { t: B.shins + 0.1, az: 6, r: 2.15, y: gy(0.6), look: [0, gy(0.45), 0], fov: 32 },
    // Thighs and pelvis straight on — riveters frame the shot either side
    { t: B.thighs + 0.1, az: -6, r: 2.3, y: gy(0.9), look: [0, gy(0.74), 0], fov: 32 },
    { t: B.hips + 0.15, az: 4, r: 2.4, y: gy(1.1), look: [0, gy(0.92), 0], fov: 32 },
    // High front for the back plates and abdomen
    { t: B.backLower, az: 16, r: 3.1, y: gy(2.15), look: [0, gy(1.15), -0.04], fov: 33 },
    { t: B.backClamp, az: 12, r: 3.0, y: gy(2.05), look: [0, gy(1.22), -0.02], fov: 32 },
    // Front for the chest; push into the reactor
    { t: B.chestSlam + 0.05, az: 8, r: 2.25, y: gy(1.35), look: [0, gy(1.26), 0.02], fov: 30 },
    { t: B.reactorPeak + 0.1, az: 4, r: 1.95, y: gy(1.3), look: [0, gy(1.28), 0.05], fov: 27 },
    // Shoulders: overhead arms lower the pauldrons
    { t: B.pauldronL + 0.05, az: 14, r: 3.0, y: gy(1.75), look: [0, gy(1.4), 0], fov: 34 },
    // Track out along the left arm: bicep, forearm sleeve
    { t: B.upperArmL + 0.05, az: 12, r: 2.6, y: gy(1.62), look: [0.35, gy(1.32), 0], fov: 31 },
    { t: B.forearmL + 0.05, az: 4, r: 2.4, y: gy(1.5), look: [0.5, gy(1.26), 0.04], fov: 30 },
    // Wide: both gauntlets, repulsor check
    { t: B.gauntletL + 0.05, az: 12, r: 3.0, y: gy(1.6), look: [0, gy(1.36), 0], fov: 35 },
    { t: B.helmetSeat - 0.3, az: 10, r: 2.75, y: gy(1.7), look: [0, gy(1.46), 0], fov: 33 },
    // Arms come down; push to the face for the faceplate
    { t: B.armsLock - 0.25, az: 6, r: 2.2, y: gy(1.74), look: [0, gy(1.62), 0], fov: 29 },
    { t: B.faceplate + 0.05, az: 3, r: 1.9, y: gy(1.73), look: [0, gy(1.72), 0.03], fov: 22 },
    { t: B.steamVent + 0.55, az: 2, r: 1.88, y: gy(1.72), look: [0, gy(1.72), 0.03], fov: 21.5 },
    // Hero pullback, held through the tail
    { ...orbitFromPose(HERO_END_CAM), t: 16.7 },
    { ...orbitFromPose(HERO_END_CAM), t: 18.5 },
  ];

  return {
    beats: B,
    preRoll,
    fits,
    tools,
    pieces,
    robots,
    pose,
    systems,
    hologramReveal,
    hologramOpacity,
    rigOpacity,
    hatch,
    waves,
    statuses,
    bursts,
    shakes,
    camera,
    systemsOnlineAt: B.eyesOn,
    finalSwapAt: B.eyesFull + 0.9,
  };
}

/** Express a Cartesian camera pose as an orbit key (t filled by caller). */
export function orbitFromPose(p: Readonly<CameraPose>): Omit<CameraKey, 't'> {
  const dx = p.x - p.lx;
  const dz = p.z - p.lz;
  return {
    az: (Math.atan2(dx, dz) * 180) / Math.PI,
    r: Math.hypot(dx, dz),
    y: p.y,
    look: [p.lx, p.ly, p.lz],
    fov: p.fov,
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────

export interface PieceFrame {
  id: ArmorPieceId;
  task: string;
  carry: number;
  insert: number;
  hinge: number;
  twist: number;
}

export interface RobotFrame {
  id: RobotId;
  gripper: number;
  spindle: number;
  stow: number;
}

export interface SuitUpFrame {
  /** Seed-clock time this frame was evaluated at. */
  t: number;
  pose: SuitPose;
  pieces: PieceFrame[];
  robots: RobotFrame[];
  systems: SystemPowers;
  hologramReveal: number;
  hologramOpacity: number;
  rigOpacity: number;
  hatch: number;
  /** Seamless final mesh replaces the pieces. */
  final: boolean;
}

/** Pose channels only (cheap — used when baking robot waypoints). */
export function evaluatePose(plan: SuitUpPlan, t: number): SuitPose {
  return {
    stance: sampleTrack(plan.pose.stance, t),
    chestRecoil: sampleTrack(plan.pose.chestRecoil, t),
    headPitch: sampleTrack(plan.pose.headPitch, t),
    wristL: sampleTrack(plan.pose.wristL, t),
    wristR: sampleTrack(plan.pose.wristR, t),
  };
}

/** Pure: the full suit-up state at a seed-clock time. */
export function evaluateSuitUp(plan: SuitUpPlan, t: number): SuitUpFrame {
  return {
    t,
    pose: evaluatePose(plan, t),
    pieces: plan.pieces.map((p) => ({
      id: p.id,
      task: p.task,
      carry: sampleTrack(p.carry, t),
      insert: sampleTrack(p.insert, t),
      hinge: sampleTrack(p.hinge, t),
      twist: sampleTrack(p.twist, t),
    })),
    robots: plan.robots.map((r) => ({
      id: r.id,
      gripper: sampleTrack(r.gripper, t),
      spindle: sampleTrack(r.spindle, t),
      stow: sampleTrack(r.stow, t),
    })),
    systems: {
      reactor: clamp01(sampleTrack(plan.systems.reactor, t)),
      eyes: clamp01(sampleTrack(plan.systems.eyes, t)),
      repulsors: clamp01(sampleTrack(plan.systems.repulsors, t)),
    },
    hologramReveal: sampleTrack(plan.hologramReveal, t),
    hologramOpacity: sampleTrack(plan.hologramOpacity, t),
    rigOpacity: sampleTrack(plan.rigOpacity, t),
    hatch: sampleTrack(plan.hatch, t),
    final: t >= plan.finalSwapAt,
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Decaying multi-axis shake summed over recent heavy beats. */
export function shakeOffset(
  shakes: SuitUpPlan['shakes'],
  t: number,
): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const s of shakes) {
    const dt = t - s.t;
    if (dt < 0 || dt > 0.45) continue;
    const env = s.amp * Math.exp(-dt / 0.075);
    x += env * Math.sin(2 * Math.PI * 23 * dt);
    y += env * 0.6 * Math.sin(2 * Math.PI * 17 * dt + 1.3);
    z += env * 0.35 * Math.sin(2 * Math.PI * 19 * dt + 2.1);
  }
  return [x, y, z];
}

/** Pure: cinematic camera pose at a seed time (shake included). */
export function evaluateCamera(plan: SuitUpPlan, t: number, shake = true): CameraPose {
  const keys = plan.camera;
  const ts = keys.map((k) => k.t);
  const ch = (f: (k: CameraKey) => number) => monotoneCubic(ts, keys.map(f), t);
  const az = (ch((k) => k.az) * Math.PI) / 180;
  const r = ch((k) => k.r);
  const lx = ch((k) => k.look[0]);
  const ly = ch((k) => k.look[1]);
  const lz = ch((k) => k.look[2]);
  const [sx, sy, sz] = shake ? shakeOffset(plan.shakes, t) : [0, 0, 0];
  return {
    x: lx + Math.sin(az) * r + sx,
    y: ch((k) => k.y) + sy,
    z: lz + Math.cos(az) * r + sz,
    lx,
    ly,
    lz,
    fov: ch((k) => k.fov),
  };
}
