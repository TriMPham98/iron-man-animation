import gsap from 'gsap';
import * as THREE from 'three';
import { assemblyCues, type SfxCue } from '../audio/actionSfx';
import type { Suit } from '../suit/Suit';
import { isSystemsOnlineStatus } from '../ui/jarvisHud';
import {
  audioTimelineOffset,
  sequenceGsapDuration,
  type CameraPose,
} from './sequenceClock';
import {
  buildSuitUpPlan,
  evaluateCamera,
  evaluateSuitUp,
  type SuitUpFrame,
  type SuitUpPlan,
} from './suitUpChoreography';
import type { Workshop } from '../workshop/Workshop';

export {
  AUDIO_SEED_ORIGIN,
  audioTimelineOffset,
  BASE_CAM_FOV,
  HERO_END_CAM,
  OPEN_WIDE_CAM,
  OPENING_HOLD,
  SEQUENCE_SEED_DURATION,
  sequenceGsapDuration,
} from './sequenceClock';

/** A plate currently mid-flight (between launch and lock). */
export interface ActivePieceInfo {
  id: string;
  wave: string;
  /** 0 at launch → 1 at lock */
  localProgress: number;
}

export interface TimelineCallbacks {
  onStatus?: (text: string) => void;
  onProgress?: (t: number) => void;
  onComplete?: () => void;
  onWave?: (wave: string) => void;
  /** Pieces whose travel tween is active at the current timeline time. */
  onActivePieces?: (pieces: ActivePieceInfo[]) => void;
}

interface PieceMotionSpan {
  id: string;
  wave: string;
  /** GSAP seconds: carry starts → clamp contact. */
  start: number;
  end: number;
}

/** Options for seek/resume when free-look should keep the live framing. */
export interface CameraControlOptions {
  /**
   * Keep the live camera/orbit framing instead of snapping back onto the
   * cinematic path. Used while free-look is active (viewport orbit).
   * Timeline scrub always passes false so the path re-attaches.
   */
  preserveCamera?: boolean;
}

export interface AssemblyController {
  play: () => void;
  pause: () => void;
  resume: (opts?: CameraControlOptions) => void;
  /**
   * Seek to normalized integrity progress 0–1 (pauses). Scrubs plate/systems
   * state. Re-applies the cinematic camera unless `preserveCamera` is set.
   * Progress is wave-paced (matches pipeline dots), not pure wall-clock.
   */
  seek: (progress01: number, opts?: CameraControlOptions) => void;
  /**
   * Seek to raw GSAP timeline seconds (pauses). Used by audio DAW scrub
   * which owns a seed-clock ruler separate from integrity %.
   */
  seekTime: (timeSec: number, opts?: CameraControlOptions) => void;
  getProgress: () => number;
  /**
   * Visual integrity span — systems online (excludes trailing camera pullback).
   * HUD progress / skip-to-end use this mark.
   */
  getDuration: () => number;
  /**
   * Full GSAP wall-clock length including post–systems-online camera tail.
   * Audio DAW ruler + seed-clock scrub use this so SFX can cover the hero pullback.
   */
  getFullDuration: () => number;
  /** Raw GSAP playhead seconds (includes opening hold). */
  getTime: () => number;
  kill: () => void;
  isPlaying: () => boolean;
  isPaused: () => boolean;
  rebuild: () => void;
  /** True after free-look orbit — cinematic camera writes are suppressed. */
  userOwnsCamera: () => boolean;
  setUserOwnsCamera: (owns: boolean) => void;
  /**
   * World-space samples of a piece's carry (appear → clamp), evaluated on
   * the posed rig. Director pick draws this; the current frame is restored.
   */
  samplePiecePath: (id: string, segments?: number) => THREE.Vector3[];
  /**
   * Pose suit + robot cell at a GSAP time without moving the transport or
   * the camera (the reverse "doffing" handoff between cycles drives this).
   */
  renderSuitAt: (gsapT: number, edit?: (frame: SuitUpFrame) => void) => void;
  /** Seed time of a GSAP time. */
  toSeed: (gsapT: number) => number;
  /** GSAP time the seamless suit swaps in (last frame with real parts). */
  getFinalSwapTime: () => number;
  /** The cinematic camera pose at a GSAP time (not applied). */
  cameraAt: (gsapT: number) => CameraPose;
}

/**
 * Integrity bar 0–1 from timeline time, paced by pipeline wave starts so the
 * orange fill tracks the dots (wave i active ≈ progress in [i/n, (i+1)/n]).
 * Hits 1 at `assemblyEnd` (systems online), not the camera tail.
 */
export function integrityProgressAtTime(
  timeSec: number,
  waveStarts: readonly number[],
  assemblyEnd: number,
): number {
  const end = Math.max(assemblyEnd, 1e-6);
  const t = Math.max(0, timeSec);
  if (t >= end - 1e-9) return 1;

  const n = waveStarts.length;
  if (n === 0) return THREE.MathUtils.clamp(t / end, 0, 1);

  // Hangar hold before first plate wave — stay at 0% with the idle pipeline
  if (t <= waveStarts[0]) return 0;

  for (let i = 0; i < n - 1; i++) {
    const t0 = waveStarts[i];
    const t1 = waveStarts[i + 1];
    if (t < t1 - 1e-12) {
      const u = (t - t0) / Math.max(t1 - t0, 1e-6);
      return (i + THREE.MathUtils.clamp(u, 0, 1)) / n;
    }
  }

  // Last wave → systems online
  const t0 = waveStarts[n - 1];
  const u = (t - t0) / Math.max(end - t0, 1e-6);
  return THREE.MathUtils.clamp((n - 1 + u) / n, 0, 1);
}

/**
 * Inverse of {@link integrityProgressAtTime} — map integrity 0–1 → timeline sec.
 */
export function timeAtIntegrityProgress(
  progress01: number,
  waveStarts: readonly number[],
  assemblyEnd: number,
): number {
  const end = Math.max(assemblyEnd, 1e-6);
  const p = THREE.MathUtils.clamp(progress01, 0, 1);
  if (p >= 0.999) return end;

  const n = waveStarts.length;
  if (n === 0) return p * end;
  if (p <= 0) return 0;

  // First wave starts at progress 0; segment i covers [i/n, (i+1)/n]
  const idx = Math.min(n - 1, Math.floor(p * n - 1e-12));
  const p0 = idx / n;
  const p1 = (idx + 1) / n;
  const u = (p - p0) / Math.max(p1 - p0, 1e-6);

  if (idx < n - 1) {
    const t0 = waveStarts[idx];
    const t1 = waveStarts[idx + 1];
    return t0 + u * (t1 - t0);
  }

  const t0 = waveStarts[n - 1];
  return t0 + u * (end - t0);
}

/**
 * Rigged Mark III suit-up timeline.
 *
 * All motion is evaluated from {@link SuitUpPlan} as a pure function of time
 * (pose, pieces, systems, FX, camera). GSAP is only the transport: it owns the
 * playhead, status / wave callbacks and the spark / steam bursts that fire on
 * live playback. Scrubbing re-evaluates the exact frame at the playhead.
 */
export function createAssemblyTimeline(
  suit: Suit,
  camera: THREE.PerspectiveCamera,
  lookTarget: THREE.Vector3,
  callbacks: TimelineCallbacks = {},
  opts: { plan?: SuitUpPlan; workshop?: Workshop | null; sfx?: (cue: SfxCue) => void } = {},
): AssemblyController {
  let tl: gsap.core.Timeline | null = null;
  let playing = false;
  /**
   * When true, the suit still animates but cinematic camera writes are
   * skipped so free-look framing survives pause/resume/scrub.
   */
  let userOwnsCamera = false;

  const plan: SuitUpPlan = opts.plan ?? buildSuitUpPlan();
  const workshop = opts.workshop ?? null;
  // Parts waiting on their cradles = the reset target between cycles
  suit.setRestFrame(evaluateSuitUp(plan, plan.preRoll));
  const offset = audioTimelineOffset();
  const actionCues = assemblyCues(plan);
  const toGsap = (seedT: number) => seedT + offset;

  /** Timeline time when seamless final mesh swaps in. */
  const finalSwapTime = toGsap(plan.finalSwapAt);
  /** Integrity 100% — eyes ignite / SYSTEMS ONLINE. */
  const assemblyEndTime = toGsap(plan.systemsOnlineAt);
  /** Pipeline wave starts (GSAP), in WAVE_ORDER. */
  const waveStartTimes = plan.waves.map((w) => toGsap(w.t));
  const motionSpans: PieceMotionSpan[] = plan.fits.flatMap((f) =>
    f.pieces.map((id) => ({
      id,
      wave: f.wave,
      start: toGsap(f.lift),
      end: toGsap(f.contact),
    })),
  );

  /** Integrity / UI progress 0–1 (hits 1 at systems online, not camera tail). */
  const assemblyProgressAt = (timeSec: number): number =>
    integrityProgressAtTime(timeSec, waveStartTimes, assemblyEndTime);

  const reportActivePieces = (timeSec: number) => {
    // Consumer is optional (viewer HUD no-ops it) — skip the O(N) scan + alloc.
    if (!callbacks.onActivePieces) return;
    const active: ActivePieceInfo[] = [];
    for (const span of motionSpans) {
      if (timeSec + 1e-6 < span.start || timeSec > span.end + 1e-6) continue;
      const dur = Math.max(span.end - span.start, 1e-6);
      active.push({
        id: span.id,
        wave: span.wave,
        localProgress: THREE.MathUtils.clamp((timeSec - span.start) / dur, 0, 1),
      });
    }
    active.sort((a, b) => b.localProgress - a.localProgress);
    callbacks.onActivePieces(active);
  };

  const applyCamera = (gsapT: number) => {
    // Free-look orbit (including mid-play takeover): never overwrite framing
    if (userOwnsCamera) return;
    const pose = evaluateCamera(plan, gsapT - offset);
    camera.position.set(pose.x, pose.y, pose.z);
    lookTarget.set(pose.lx, pose.ly, pose.lz);
    camera.lookAt(lookTarget);
    if (Math.abs(camera.fov - pose.fov) > 1e-4) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
  };

  /** Evaluate + apply the whole suit-up at a GSAP time. */
  const render = (gsapT: number) => {
    const frame = evaluateSuitUp(plan, gsapT - offset);
    suit.applyFrame(frame);
    workshop?.apply(frame);
    applyCamera(gsapT);
  };

  const build = (): gsap.core.Timeline => {
    suit.resetToStart();
    const fullDur = sequenceGsapDuration();
    const clock = { t: 0 };

    const timeline = gsap.timeline({
      paused: true,
      onUpdate: () => {
        const t = timeline.time();
        render(t);
        // Normalize to assembly end — not full timeline (camera pullback tail).
        callbacks.onProgress?.(assemblyProgressAt(t));
        reportActivePieces(t);
      },
      onComplete: () => {
        playing = false;
        // SYSTEMS ONLINE already fired at assemblyEndTime (integrity 100%).
        callbacks.onProgress?.(1);
        callbacks.onActivePieces?.([]);
        callbacks.onComplete?.();
      },
    });

    // Transport span: seed clock 0 → SEQUENCE_SEED_DURATION plus the pre-roll
    timeline.to(clock, { t: 1, duration: fullDur, ease: 'none' }, 0);

    for (const { wave, t } of plan.waves) {
      timeline.call(() => callbacks.onWave?.(wave), undefined, Math.max(0, toGsap(t)));
    }
    for (const { t, text } of plan.statuses) {
      timeline.call(
        () => {
          callbacks.onStatus?.(text);
          if (isSystemsOnlineStatus(text)) callbacks.onProgress?.(1);
        },
        undefined,
        Math.max(0, toGsap(t)),
      );
    }
    // Action sounds (servos, grippers, crackle, hiss) — live transport only
    if (opts.sfx) {
      const sfx = opts.sfx;
      for (const cue of actionCues) {
        timeline.call(() => sfx(cue), undefined, Math.max(0, toGsap(cue.t)));
      }
    }
    // Sparks / steam ride the live transport only (scrub suppresses calls)
    for (const burst of plan.bursts) {
      timeline.call(() => suit.emitBurst(burst), undefined, Math.max(0, toGsap(burst.t)));
    }

    return timeline;
  };

  const ensureTl = () => {
    if (!tl) tl = build();
    return tl;
  };

  const syncAfterTime = (timeSec: number, forceComplete = false) => {
    const timeline = ensureTl();
    const fullDur = Math.max(timeline.duration(), 1e-6);
    const t = forceComplete
      ? Math.min(fullDur, Math.max(assemblyEndTime, finalSwapTime, timeSec))
      : THREE.MathUtils.clamp(timeSec, 0, fullDur);

    // Bursts are transient — drop any in flight when the playhead jumps
    suit.clearFx();
    // Suppress call()s — scrub owns status / final swap via the evaluator
    timeline.progress(t / fullDur, true);
    if (t < finalSwapTime - 1e-4) suit.resumeAssemblyVisuals();
    render(t);

    callbacks.onProgress?.(assemblyProgressAt(timeline.time()));
    reportActivePieces(timeline.time());
  };

  const syncAfterSeek = (progress01: number) => {
    const uiP = THREE.MathUtils.clamp(progress01, 0, 1);
    // Scrub 0–1 is integrity progress (wave-paced), not pure wall-clock.
    if (uiP >= 0.999) {
      syncAfterTime(assemblyEndTime, true);
      return;
    }
    syncAfterTime(timeAtIntegrityProgress(uiP, waveStartTimes, assemblyEndTime));
  };

  tl = build();

  return {
    play: () => {
      const timeline = ensureTl();
      // Fresh play-from-start reclaims the cinematic path
      userOwnsCamera = false;
      playing = true;
      timeline.pause();
      timeline.progress(0, true);
      suit.clearFx();
      render(0);
      timeline.play();
    },
    pause: () => {
      const timeline = ensureTl();
      timeline.pause();
      playing = false;
    },
    resume: (opts?: CameraControlOptions) => {
      const timeline = ensureTl();
      if (opts?.preserveCamera) {
        userOwnsCamera = true;
      } else {
        // Snap back onto the path immediately (drops free-look offset)
        userOwnsCamera = false;
        applyCamera(timeline.time());
      }
      if (timeline.progress() >= 1) {
        // At end — restart so resume always does something useful
        userOwnsCamera = false;
        playing = true;
        timeline.play(0);
        return;
      }
      playing = true;
      timeline.paused(false);
      timeline.play();
    },
    seek: (progress01: number, opts?: CameraControlOptions) => {
      const timeline = ensureTl();
      timeline.pause();
      playing = false;
      // Scrub re-attaches to the cinematic path unless explicitly preserving
      // free-look. Orbit (bindInput) is what claims ownership again.
      userOwnsCamera = !!opts?.preserveCamera;
      syncAfterSeek(progress01);
    },
    seekTime: (timeSec: number, opts?: CameraControlOptions) => {
      const timeline = ensureTl();
      timeline.pause();
      playing = false;
      userOwnsCamera = !!opts?.preserveCamera;
      syncAfterTime(Math.max(0, timeSec), false);
    },
    getProgress: () => {
      if (!tl) return 0;
      return assemblyProgressAt(tl.time());
    },
    getDuration: () => {
      if (!tl) return 0;
      // Assembly span for the HUD so 100% lines up with systems online.
      return Math.max(assemblyEndTime, 1e-6);
    },
    getFullDuration: () => {
      if (!tl) return 0;
      return Math.max(tl.duration(), assemblyEndTime, sequenceGsapDuration(), 1e-6);
    },
    getTime: () => {
      if (!tl) return 0;
      return Math.max(0, tl.time());
    },
    kill: () => {
      tl?.kill();
      tl = null;
      playing = false;
      userOwnsCamera = false;
    },
    isPlaying: () => playing && !!tl && !tl.paused() && tl.progress() < 1,
    isPaused: () => !!tl && (tl.paused() || !playing),
    rebuild: () => {
      tl?.kill();
      userOwnsCamera = false;
      tl = build();
      playing = false;
    },
    userOwnsCamera: () => userOwnsCamera,
    samplePiecePath: (id: string, segments = 48) => {
      const fit = plan.fits.find((f) => (f.pieces as string[]).includes(id));
      if (!fit) return [];
      const points: THREE.Vector3[] = [];
      const start = fit.grasp;
      const end = fit.contact + 0.2;
      for (let i = 0; i <= segments; i++) {
        const seedT = start + ((end - start) * i) / segments;
        suit.applyFrame(evaluateSuitUp(plan, seedT));
        const p = suit.pieceWorldPosition(fit.pieces.find((x) => x === id)!, new THREE.Vector3());
        if (p) points.push(p);
      }
      // Restore the live frame without touching the camera
      const owns = userOwnsCamera;
      userOwnsCamera = true;
      render(tl ? tl.time() : 0);
      userOwnsCamera = owns;
      return points;
    },
    renderSuitAt: (gsapT: number, edit?: (frame: SuitUpFrame) => void) => {
      const frame = evaluateSuitUp(plan, gsapT - offset);
      edit?.(frame);
      suit.applyFrame(frame);
      workshop?.apply(frame);
    },
    getFinalSwapTime: () => finalSwapTime,
    cameraAt: (gsapT: number) => evaluateCamera(plan, gsapT - offset),
    toSeed: (gsapT: number) => gsapT - offset,
    setUserOwnsCamera: (owns: boolean) => {
      userOwnsCamera = owns;
      // Releasing free-look does not by itself move the camera — callers that
      // want the path (seek / play / resume) apply framing explicitly.
    },
  };
}
