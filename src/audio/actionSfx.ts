import type { SuitUpPlan } from '../animation/suitUpChoreography';
import { FLIGHT_EVENTS, THRUSTER_BURN_SEC, type FlightEvent } from '../animation/flightCheck';
import { STAND_RETRACT_SEC } from '../workshop/cradleStands';
import type { DoffEvent } from '../animation/doffSequence';
import type { PlayRequest } from './engine';

/**
 * Action sound layer: one-shots tied to what is moving on screen, on top
 * of the director SFX mix (which carries the clamp transients the
 * choreography is cut to). Servo whine when an arm sets off, gripper
 * clicks, rivet crackle, vapour hiss with the steam, stands sinking and
 * ring lids shutting, the flight check's servos / flaps / repulsors /
 * thrusters, and the doff: power-down, faceplate, short vent bursts and
 * unclamps as the seals let go, then the extraction's unclamps and
 * set-downs.
 */
export interface SfxCue {
  /** Seconds on the clock the layer is fired against. */
  t: number;
  file: string;
  volume: number;
  pitch?: number;
  /** Seconds of the file to play (defaults to the whole file). */
  duration?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** Library file lengths (s) — the engine needs a play length up front. */
export const SFX_LENGTH: Record<string, number> = {
  'clasp-long-conveyor.mp3': 4.18,
  'connect-hiss.mp3': 2.93,
  'conveyor-hiss.mp3': 2.3,
  'drill-tighten.mp3': 2.38,
  'electric-motor.mp3': 6.22,
  'footstep.mp3': 1.41,
  'impact.mp3': 1.15,
  'light-attach.mp3': 1.85,
  'medium-close.mp3': 1.83,
  'metal-clang.mp3': 2.53,
  'metal-connect.mp3': 1.23,
  'metal-sliding.mp3': 2.12,
  'metal-tighten.mp3': 1.23,
  'repulsor.mp3': 1.46,
  'robot-movement.mp3': 3.37,
  'steam-hiss.mp3': 1.12,
  'steam-release.mp3': 5.75,
  'binary-code-interface.mp3': 98,
  // Derived for this layer (see README › Sound)
  'servo-whir.mp3': 1.33,
  'servo-whine.mp3': 1.65,
  'flap-servo.mp3': 0.47,
  'flap-latch.mp3': 0.21,
  'weapon-deploy.mp3': 0.68,
  'weapon-lock.mp3': 0.73,
  'weapon-stow.mp3': 0.68,
  'unclamp-dry.mp3': 1.15,
  'doff-hum.mp3': 7.55,
  'metal-ring-connect.mp3': 1.72,
  'thruster-ignite.mp3': 1.65,
  'thruster-burn.mp3': 5.04,
  'touchdown.mp3': 1.15,
  'spark-crackle.mp3': 0.84,
  'unclamp.mp3': 1.33,
};

/** Stable per-robot pitch so each arm has its own servo voice. */
const voice = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997;
  return 0.9 + (h % 23) / 100;
};

/** Drop cues of the same file closer than `gap` s (keeps bursts clean). */
function thin(cues: SfxCue[], gap = 0.09): SfxCue[] {
  cues.sort((a, b) => a.t - b.t);
  const last = new Map<string, number>();
  return cues.filter((c) => {
    const p = last.get(c.file);
    if (p !== undefined && c.t - p < gap) return false;
    last.set(c.file, c.t);
    return true;
  });
}

/** Stow track: start / end of each arm's fold-and-sink (seed s). */
function stowSpan(plan: SuitUpPlan, id: string): [number, number] | null {
  const track = plan.robots.find((r) => r.id === id)?.stow;
  if (!track || track.length < 2) return null;
  return [track[0].t, track[track.length - 1].t];
}

/** Cues for the forward suit-up (seed-clock seconds). */
export function assemblyCues(plan: SuitUpPlan): SfxCue[] {
  const cues: SfxCue[] = [];
  for (const r of plan.robots) {
    const p = voice(r.id);
    for (const job of r.jobs) {
      cues.push({ t: job.depart, file: 'servo-whine.mp3', volume: 0.2, pitch: p });
      cues.push({ t: job.grasp, file: 'light-attach.mp3', volume: 0.22, pitch: 1.15 });
      cues.push({ t: job.release, file: 'light-attach.mp3', volume: 0.14, pitch: 1.35 });
      // Its stand sinks once the part is lifted clear, the port lid shuts
      cues.push({ t: job.lift + 0.35, file: 'metal-sliding.mp3', volume: 0.12, pitch: 0.78 });
      cues.push({ t: job.lift + 0.35 + STAND_RETRACT_SEC * 0.85, file: 'medium-close.mp3', volume: 0.1, pitch: 1.25 });
    }
    for (const tool of r.tools) {
      cues.push({ t: tool.depart, file: 'servo-whine.mp3', volume: 0.18, pitch: p * 1.05 });
      for (const s of tool.strikes) cues.push({ t: s, file: 'spark-crackle.mp3', volume: 0.22 });
    }
    const stow = stowSpan(plan, r.id);
    if (stow) {
      cues.push({ t: stow[0], file: 'robot-movement.mp3', volume: 0.2, pitch: 0.82 * p, duration: 2, fadeOut: 0.6 });
      cues.push({ t: stow[1], file: 'medium-close.mp3', volume: 0.16, pitch: 0.9 });
    }
  }
  for (const b of plan.bursts) {
    if (b.kind === 'sparks') cues.push({ t: b.t, file: 'spark-crackle.mp3', volume: 0.28 });
    else cues.push({ t: b.t, file: 'steam-hiss.mp3', volume: 0.3, pitch: 0.95 });
  }
  return thin(cues);
}

/**
 * Cues for the doffing extraction (seed seconds, fired as the clock runs
 * backwards through them): arms rise out of the ring, every loosened part
 * is unclamped, carried off and set down on its stand.
 */
export function doffCues(plan: SuitUpPlan): SfxCue[] {
  // Kept sparse and dry: one low servo as each arm comes up, a dry
  // unclamp per part, a soft set-down click. No hiss / noise beds — the
  // continuous low motor hum is started by the session.
  const cues: SfxCue[] = [];
  for (const r of plan.robots) {
    const p = voice(r.id);
    const stow = stowSpan(plan, r.id);
    if (stow) cues.push({ t: stow[1] - 0.05, file: 'servo-whine.mp3', volume: 0.16, pitch: 0.8 * p, fadeOut: 0.5 });
    for (const job of r.jobs) {
      cues.push({ t: job.contact, file: 'unclamp-dry.mp3', volume: 0.34, pitch: p });
      cues.push({ t: job.grasp, file: 'flap-latch.mp3', volume: 0.3, pitch: 0.8 });
    }
  }
  return thin(cues, 0.3);
}

/** Cues for the doff's opening act (doff seconds, see doffSequence). */
export function doffOpeningCues(events: readonly DoffEvent[]): SfxCue[] {
  const cues = events.flatMap((e): SfxCue[] => {
    switch (e.kind) {
      case 'powerDown':
        // Servo spinning down as the systems drop to standby
        return [{ t: e.t, file: 'servo-whine.mp3', volume: 0.3, pitch: 0.7, fadeOut: 0.8 }];
      case 'faceplateLatch':
        return [{ t: e.t, file: 'flap-latch.mp3', volume: 0.45 }];
      case 'faceplateOpen':
        return [{ t: e.t, file: 'servo-whir.mp3', volume: 0.38, pitch: 0.95 }];
      case 'vent':
        // Short burst per jet, not a hiss bed
        return [{ t: e.t, file: 'steam-hiss.mp3', volume: 0.22, pitch: 1.1, duration: 0.45, fadeOut: 0.25 }];
      case 'release':
        return [{ t: e.t, file: 'unclamp-dry.mp3', volume: 0.2, pitch: 1.1 + 0.15 * ((e.t * 7.3) % 1), duration: 0.5, fadeOut: 0.2 }];
      default:
        return [];
    }
  });
  return thin(cues, 0.06);
}

/** Crossfaded takes of the thruster burn covering `span` seconds from `t0`. */
function burnTakes(t0: number, span: number): SfxCue[] {
  const len = SFX_LENGTH['thruster-burn.mp3'];
  const xf = 0.6;
  // Each take starts as the previous one begins its crossfade
  const step = len - xf;
  const takes = Math.max(1, Math.ceil((span - xf) / step));
  return Array.from({ length: takes }, (_, i): SfxCue => {
    const last = i === takes - 1;
    return {
      t: t0 + i * step,
      file: 'thruster-burn.mp3',
      // Sits well above the flight-control servos it plays under
      volume: 1,
      duration: last ? Math.min(len, span - i * step) : len,
      fadeIn: i === 0 ? 0.05 : xf,
      fadeOut: last ? 0.7 : xf,
    };
  });
}

/** Cues for the flight-control check (flight-check seconds). */
export function flightCues(): SfxCue[] {
  const both = (e: FlightEvent) => e.side === 'both';
  return FLIGHT_EVENTS.flatMap((e): SfxCue[] => {
    switch (e.kind) {
      case 'servo':
        return [{ t: e.t, file: 'servo-whir.mp3', volume: both(e) ? 0.45 : 0.35, pitch: both(e) ? 0.9 : 1.05 }];
      case 'flapOpen':
        // Quick, light control-surface actuator — not a clunk
        return [{ t: e.t, file: 'flap-servo.mp3', volume: both(e) ? 0.38 : 0.3, pitch: both(e) ? 0.95 : 1.05 }];
      case 'flapClose':
        return [
          { t: e.t, file: 'flap-servo.mp3', volume: both(e) ? 0.32 : 0.25, pitch: 0.9 },
          { t: e.t + 0.42, file: 'flap-latch.mp3', volume: 0.35 },
        ];
      case 'weaponDeploy':
        return [{ t: e.t, file: 'weapon-deploy.mp3', volume: both(e) ? 0.55 : 0.45 }];
      case 'weaponLock':
        return [{ t: e.t - 0.05, file: 'weapon-lock.mp3', volume: both(e) ? 0.55 : 0.45, pitch: both(e) ? 0.9 : 1.05 }];
      case 'weaponStow':
        return [{ t: e.t, file: 'weapon-stow.mp3', volume: both(e) ? 0.45 : 0.38 }];
      case 'repulsor':
        return [{ t: e.t - 0.04, file: 'repulsor.mp3', volume: both(e) ? 0.75 : 0.6 }];
      case 'ignite':
        return [{ t: e.t, file: 'thruster-ignite.mp3', volume: 0.95 }];
      case 'liftoff':
        // Burn runs through the whole hover to the cut-off: the clip is
        // shorter than that, so overlapping takes crossfade into each other
        return burnTakes(e.t - 0.3, THRUSTER_BURN_SEC);
      case 'touchdown':
        return [{ t: e.t, file: 'touchdown.mp3', volume: 0.6 }];
      case 'cutoff':
        return [{ t: e.t, file: 'steam-release.mp3', volume: 0.3, duration: 2.2, fadeOut: 1.2 }];
      case 'flare':
        return [
          { t: e.t, file: 'repulsor.mp3', volume: 0.32, pitch: 1.7, duration: 0.6, fadeOut: 0.3 },
          { t: e.t + 0.02, file: 'spark-crackle.mp3', volume: 0.35 },
          { t: e.t + 0.05, file: 'steam-hiss.mp3', volume: 0.18, pitch: 1.3 },
        ];
      case 'nominal':
        return [{ t: e.t, file: 'light-attach.mp3', volume: 0.3, pitch: 0.85 }];
      default:
        return [];
    }
  });
}

/**
 * Fires cues as a clock moves (either direction) through them. Jumps
 * larger than `maxJump` (seeks, restarts) fire nothing.
 */
export function createCuePlayer(play: (req: PlayRequest) => void, maxJump = 0.5) {
  let n = 0;
  const fire = (c: SfxCue) => {
    const len = SFX_LENGTH[c.file] ?? 2;
    const duration = Math.min(len, c.duration ?? len);
    play({
      id: `sfx-${n++}`,
      file: c.file,
      offset: 0,
      duration,
      volume: c.volume,
      pitch: c.pitch ?? 1,
      fadeIn: c.fadeIn ?? 0,
      fadeOut: c.fadeOut ?? 0.05,
      clipDuration: duration,
    });
  };
  return {
    fire,
    /** Fire every cue the clock crossed going from `a` to `b`. */
    between(cues: readonly SfxCue[], a: number, b: number): void {
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || Math.abs(b - a) > maxJump) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (const c of cues) {
        // Forward: (a, b]; backward: [b, a)
        if (b > a ? c.t > lo && c.t <= hi : c.t >= lo && c.t < hi) fire(c);
      }
    },
  };
}
