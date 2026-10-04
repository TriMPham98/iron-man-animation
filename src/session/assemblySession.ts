import gsap from 'gsap';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  audioTimelineOffset,
  createAssemblyTimeline,
  HERO_END_CAM,
  OPEN_WIDE_CAM,
  type AssemblyController,
} from '../animation/assemblyTimeline';
import type { Suit } from '../suit/Suit';
import type { SuitUpPlan } from '../animation/suitUpChoreography';
import type { Workshop } from '../workshop/Workshop';
import { diagnosticStatusForProgress } from '../suit/diagnosticScan';
import { evaluateFlightCheck, FLIGHT_CHECK_STEPS } from '../animation/flightCheck';
import { createCuePlayer, doffCues, doffOpeningCues, doffPrepCues, flightCues, redeployCues, type SfxCue } from '../audio/actionSfx';
import {
  applyDoff,
  DOFF_EXTRACT_RATE,
  DOFF_RELEASE_SEC,
  DOFF_STATUSES,
  doffBursts,
  doffEvents,
  evaluateDoff,
  type DoffPart,
} from '../animation/doffSequence';
import { gy } from '../animation/sequenceClock';
import { armorPieceDef } from '../suit/armorPieces';
import { FIT_TASKS } from '../workshop/fittingProgram';
import { createFlightPanel } from '../ui/flightPanel';
import { createWeaponReticles } from '../ui/weaponReticles';
import { statusForIntegrityProgress } from '../suit/waves';
import type { AudioTimelinePanel } from '../ui/audioTimelinePanel';
import type { OverlayHandles } from '../ui/overlay';
import { isSystemsOnlineStatus } from '../ui/jarvisHud';

/**
 * Wall-clock duration of the finished-suit showcase orbit (full 360°).
 * Driven manually in {@link createAssemblySession}'s update — not via
 * OrbitControls.autoRotate.
 *
 * Historical note: OrbitControls without deltaTime was *per frame*, so a
 * 120Hz display at autoRotateSpeed=1 finished in ~30s while 60Hz took ~60s.
 * Forcing wall-clock at 38–60s felt *slower* than the old high-refresh feel.
 * ~28s matches “just under 40s” with headroom and the pre-tier snappy loop.
 */
const SHOWCASE_ORBIT_SEC = 35;
/**
 * When remaining yaw is under this, ease spin to a stop.
 * The wireframe diagnostic starts here and hits 1.0 as remaining → 0
 * (same window as the orbit ease-out).
 */
const SPIN_EASE_OUT_RAD = 0.275;
/** Full-speed yaw rate of the showcase turn (rad/s). */
const SPIN_RATE = (Math.PI * 2) / SHOWCASE_ORBIT_SEC;
/** Wall seconds of full-speed turn before the ease-out. */
const SPIN_FULL_SEC = (Math.PI * 2 - SPIN_EASE_OUT_RAD) / SPIN_RATE;
/**
 * The ease-out decelerates evenly to rest over its last yaw (twice the
 * full-speed time for that arc), so it lands in a fixed time with no crawl
 * at the end; the head-to-toe diagnostic runs at an even pace across it.
 */
const SPIN_EASE_OUT_SEC = (2 * SPIN_EASE_OUT_RAD) / SPIN_RATE;
/** Wall seconds of the whole showcase turn. */
const SHOWCASE_TURN_SEC = SPIN_FULL_SEC + SPIN_EASE_OUT_SEC;

/** Yaw travelled (rad) and ease-out progress (0–1) `t` wall seconds into the turn. */
function showcaseYaw(t: number): { yaw: number; ease: number } {
  if (t <= SPIN_FULL_SEC) return { yaw: SPIN_RATE * Math.max(0, t), ease: 0 };
  const ease = Math.min(1, (t - SPIN_FULL_SEC) / SPIN_EASE_OUT_SEC);
  return { yaw: Math.PI * 2 - SPIN_EASE_OUT_RAD * (1 - ease) * (1 - ease), ease };
}
/**
 * Doff camera: close on the helmet and chest for the power-down (the arc
 * reactor winding down) and the faceplate.
 */
const DOFF_HEAD_CAM = { x: 0.7, y: gy(1.66), z: 2.0, lx: 0, ly: gy(1.54), lz: 0, fov: 30 } as const;
/**
 * Doff camera: eases back to the whole suit, helmet to boots, as the seals
 * vent down it (the extraction then rides the assembly's own path).
 */
const DOFF_VENT_CAM = { x: 1.3, y: gy(1.2), z: 3.7, lx: 0, ly: gy(1.0), lz: 0, fov: 34 } as const;
/** Seconds the doff camera takes to blend onto the reversed assembly path. */
const DOFF_PATH_BLEND = 3.2;
/**
 * Lag (s) of the doff camera behind the reversed path: it drifts after the
 * framing instead of retracing every cut and push of the build, so the
 * teardown reads calm. The shakes are dropped too.
 */
const DOFF_CAM_LAG = 1.8;
/**
 * Flight-check seconds the grippers start coming up out of the ring for the
 * doff: as the check reads nominal, so they are in place, ready to take the
 * suit apart, as the turn settles (the riveters stay down).
 */
const DOFF_PREP_FROM = FLIGHT_CHECK_STEPS[FLIGHT_CHECK_STEPS.length - 1].at + 0.1;
/**
 * The doff's reversed fitting clock starts running inside the opening act,
 * so the build's idle tail (systems online, the stance settling) plays out
 * under the power-down and the vents, and the first gripper moves in just as
 * the seals finish letting go. It never starts before this (doff s).
 */
const DOFF_CLOCK_EARLIEST = 0.45;
/**
 * Cell reset between cycles (s): every stand sinks with its part as soon as
 * the part is set down and every arm folds away once its last part is home
 * (both during the doff) and the floor's ring aperture turns shut over them;
 * the pad then sits empty for a beat before the aperture opens again and the
 * cell rises for the next build.
 */
const RESET_HOLD_SEC = 0.5;
const RESET_RISE_SEC = 3.6;


/** A camera pose as the cinematic paths author it. */
type CamPose = { x: number; y: number; z: number; lx: number; ly: number; lz: number; fov: number };
const CAM_KEYS = ['x', 'y', 'z', 'lx', 'ly', 'lz', 'fov'] as const;

const VIEWER_HINT =
  'Drag to orbit · R replay · Space pause · S skip · M mute · L loop · ←→ scrub · 1 2 3 phase';
const DIRECTOR_HINT =
  'Drag to orbit · plate · RECLASS · AUDIO scrub · A add · [ ] wave · M mute · L loop · ←→ · R · Space · S';

export interface AssemblySessionOptions {
  suit: Suit;
  camera: THREE.PerspectiveCamera;
  lookTarget: THREE.Vector3;
  controls: OrbitControls;
  ui: OverlayHandles;
  clock: THREE.Clock;
  reducedMotion: boolean;
  onClearPick: () => void;
  /** Optional director audio timeline (playhead + transport sync). */
  audioTimeline?: AudioTimelinePanel | null;
  /** Robot cell driven alongside the suit. */
  workshop?: Workshop | null;
  plan?: SuitUpPlan;
}

/** The three phases of a cycle, in order. */
export type CyclePhase = 'assembly' | 'flight' | 'doff';
/** Phase lengths on the cycle clock (s). */
export interface CyclePhases {
  assembly: number;
  flight: number;
  doff: number;
  total: number;
}

export interface AssemblySession {
  /** Cycle clock (s), current phase, phase lengths and whether it is running. */
  getCycle: () => { t: number; phase: CyclePhase; phases: CyclePhases; playing: boolean };
  /** Seek anywhere in assembly → flight check → disassembly, held there. */
  seekCycle: (t: number) => void;
  /** Play / hold the cycle wherever it is. */
  setCyclePlaying: (play: boolean) => void;
  startSequence: () => void;
  skipToEnd: () => void;
  togglePause: () => void;
  seek: (progress01: number) => void;
  /**
   * Arrow-key scrub: step the raw GSAP playhead by wall-clock seconds across
   * the full cycle (including camera tail). Integrity % alone plateaus at
   * systems online, so progress-based scrub used to jump straight to the end.
   */
  scrubBySeconds: (deltaSec: number) => void;
  /**
   * Per-frame: advances the showcase orbit (wall-clock) and restarts assembly
   * after a full 360°. Pass frame delta in seconds.
   * @returns true when this frame drove the showcase orbit (skip OrbitControls.update).
   */
  update: (deltaSec: number) => boolean;
  /** True while the post-assembly showcase orbit is running (not Space-paused). */
  isShowcaseOrbiting: () => boolean;
  assembly: AssemblyController;
  isComplete: () => boolean;
  /**
   * HUD timer seconds — same seed/audio clock as the DAW playhead (not raw
   * GSAP). Hangar hold maps to 0; cascade + camera tail match the ruler.
   * After complete, keeps counting through the showcase.
   */
  getHudElapsed: () => number;
  /** @deprecated Prefer getHudElapsed — kept for boot handoff. */
  getClockStart: () => number;
  setClockStart: (t: number) => void;
  refreshHintCopy: () => void;
}

/**
 * Owns assembly complete/UI state, sequence controls, and timeline ↔ HUD wiring.
 * Behavior matches the former inline logic in main.ts.
 */
export function createAssemblySession(
  options: AssemblySessionOptions,
): AssemblySession {
  const {
    suit,
    camera,
    lookTarget,
    controls,
    ui,
    clock,
    reducedMotion,
    onClearPick,
    audioTimeline = null,
    workshop = null,
    plan,
  } = options;

  let assemblyComplete = false;
  let clockStart = 0;
  /**
   * When true (AUDIO timeline LOOP), restart the full assembly as soon as
   * the sequence ends — skip idle 360° showcase spin.
   */
  let loopFullCycle = false;
  /**
   * Wall-clock stamp when we enter true complete (camera tail done / skip).
   * HUD continues from {@link completeBaseElapsed} through the showcase spin.
   */
  let completeAnchor: number | null = null;
  /** GSAP time (sec) frozen at the moment we entered complete. */
  let completeBaseElapsed = 0;

  /**
   * After assembly finishes we orbit the finished suit for
   * {@link SHOWCASE_ORBIT_SEC}, then soft-restart.
   * Spin is applied manually each frame (not OrbitControls.autoRotate) so
   * the period is exact wall-clock and independent of damping / FPS.
   * Free-look (user drag) cancels this auto-replay.
   * Space pauses/resumes the spin without restarting (R still replays).
   */
  let completeSpinActive = false;
  /** Wall seconds into the showcase turn (frozen by Space). */
  let completeSpinT = 0;
  /** True when Space froze showcase spin (not a free-look cancel). */
  let showcaseSpinPaused = false;
  /**
   * Wireframe diagnostic armed for the current showcase orbit ease-out.
   * Starts when remaining yaw enters {@link SPIN_EASE_OUT_RAD}; ends with
   * the orbit (progress 1 as it comes to rest).
   */
  let orbitScanArmed = false;
  let lastOrbitScanStatus = '';
  /** GSAP handoff: dematerialize + hangar pull before rebuild. */
  let handoffTween: gsap.core.Timeline | null = null;
  const _spinOffset = new THREE.Vector3();
  const _spinAxis = new THREE.Vector3(0, 1, 0);
  const _heroLook = new THREE.Vector3(
    HERO_END_CAM.lx,
    HERO_END_CAM.ly,
    HERO_END_CAM.lz,
  );
  const _heroPos = new THREE.Vector3(
    HERO_END_CAM.x,
    HERO_END_CAM.y,
    HERO_END_CAM.z,
  );
  const _openWidePos = new THREE.Vector3(
    OPEN_WIDE_CAM.x,
    OPEN_WIDE_CAM.y,
    OPEN_WIDE_CAM.z,
  );
  const _openWideLook = new THREE.Vector3(
    OPEN_WIDE_CAM.lx,
    OPEN_WIDE_CAM.ly,
    OPEN_WIDE_CAM.lz,
  );

  const killHandoff = () => {
    handoffTween?.kill();
    handoffTween = null;
    workshop?.setDoffClock(null);
    suit.setReactorPowerDown(null);
    suit.stopDiagnosticScan();
  };

  /**
   * Lock camera + look + FOV to the authored hero end pose so the loop always
   * exits orbit from a known frame (no FP drift into the hangar pull).
   */
  const applyHeroEndCam = () => {
    camera.position.copy(_heroPos);
    lookTarget.copy(_heroLook);
    controls.target.copy(lookTarget);
    if (Math.abs(camera.fov - HERO_END_CAM.fov) > 1e-4) {
      camera.fov = HERO_END_CAM.fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(lookTarget);
  };

  /**
   * Lock to hangar open framing — same pose assembly t=0 sets — so rebuild
   * never hard-snaps the lens.
   */
  const applyOpenWideCam = () => {
    camera.position.copy(_openWidePos);
    lookTarget.copy(_openWideLook);
    controls.target.copy(lookTarget);
    if (Math.abs(camera.fov - OPEN_WIDE_CAM.fov) > 1e-4) {
      camera.fov = OPEN_WIDE_CAM.fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(lookTarget);
  };

  const stopOrbitDiagnostic = () => {
    orbitScanArmed = false;
    lastOrbitScanStatus = '';
    suit.stopDiagnosticScan();
  };

  /**
   * Drive scan 0→1 over the spin ease-out window, at an even pace in time.
   * Geometry is prebuilt at orbit start — arming only toggles visibility.
   */
  const updateOrbitDiagnostic = (t: number) => {
    if (reducedMotion) return;
    if (t <= 0) {
      // Still full-speed orbit — no scan yet
      return;
    }
    if (!orbitScanArmed) {
      orbitScanArmed = true;
      // Prebuilt at showcase start — show only (no EdgesGeometry hitch)
      suit.startDiagnosticScan();
      lastOrbitScanStatus = '';
    }
    suit.setDiagnosticScanProgress(t);
    const line = diagnosticStatusForProgress(t);
    if (line !== lastOrbitScanStatus) {
      lastOrbitScanStatus = line;
      ui.setStatus(line, false);
    }
  };

  /** Last flight-check status line shown (avoids re-setting every frame). */
  let lastFlightStatus = '';

  /**
   * Flight-control check rides the turn: its clock is the yaw travelled, so
   * a Space pause freezes it mid-step and drags cancel it with the orbit.
   */
  const updateFlightCheck = () => {
    const t = completeSpinT;
    const f = evaluateFlightCheck(t);
    suit.setFlightCheck(f, t);
    // Keep the suit framed while it hovers: the orbit pivot and the lens
    // ride up with it (and come back down as it lands)
    flightCamLift = f.active ? f.pose.lift ?? 0 : 0;
    cues.between(flightSfx, lastFlightT, t);
    // The grippers come up for the doff as the check wraps up (held down
    // before then, so a scrub back from the prep stows them again)
    if (workshop) {
      workshop.prepareDoff(Math.max(0, (t - DOFF_PREP_FROM) / (SHOWCASE_TURN_SEC - DOFF_PREP_FROM)));
      cues.between(doffPrepSfx, lastFlightT, t);
    }
    lastFlightT = t;
    // Checklist holds "all OK" until the diagnostic takes over
    if (orbitScanArmed) flightPanel.hide();
    else flightPanel.update(t, f.active, f);
    // Target boxes over each weapon through the arming step only
    if (!orbitScanArmed && t >= WEAPONS_FROM && t < WEAPONS_TO) weaponReticles.update(suit.weaponTargets(f));
    else weaponReticles.hide();
    if (f.status && f.status !== lastFlightStatus && !orbitScanArmed) {
      lastFlightStatus = f.status;
      ui.setStatus(f.status, false);
    }
  };

  const stopCompleteSpinTracking = () => {
    suit.setFlightCheck(null);
    flightPanel.hide();
    weaponReticles.hide();
    if (flightCamLift !== 0) {
      lookTarget.y -= flightCamLift;
      camera.position.y -= flightCamLift * 0.75;
      flightCamLift = 0;
    }
    lastFlightStatus = '';
    lastFlightT = Number.NaN;
    completeSpinActive = false;
    completeSpinT = 0;
    showcaseSpinPaused = false;
    // Never leave OrbitControls auto-spin on — we own the showcase orbit.
    controls.autoRotate = false;
  };

  /**
   * The showcase turn at `t` wall seconds in, as a pure function of `t` so it
   * plays and scrubs alike: the camera orbits the hero framing about its
   * pivot (lifted with the hover), the flight check and the doff prep run on
   * the same clock and the diagnostic sweeps the ease-out.
   */
  const renderShowcase = (t: number, opts?: { scrub?: boolean }) => {
    completeSpinT = THREE.MathUtils.clamp(t, 0, SHOWCASE_TURN_SEC);
    const { yaw, ease } = showcaseYaw(completeSpinT);
    if (opts?.scrub) lastFlightT = Number.NaN;
    // Scrubbed back out of the ease-out: the flight check takes over again
    if (ease <= 0 && orbitScanArmed) stopOrbitDiagnostic();
    // Diagnostic locked to the ease-out window
    updateOrbitDiagnostic(ease);
    updateFlightCheck();
    // Same sign as OrbitControls._rotateLeft (theta decreases → CW from above)
    _spinOffset.copy(_heroPos).sub(_heroLook).applyAxisAngle(_spinAxis, -yaw);
    lookTarget.copy(_heroLook);
    lookTarget.y += flightCamLift;
    camera.position.copy(_heroLook).add(_spinOffset);
    camera.position.y += flightCamLift * 0.75;
    if (Math.abs(camera.fov - HERO_END_CAM.fov) > 1e-4) {
      camera.fov = HERO_END_CAM.fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(lookTarget);
    controls.target.copy(lookTarget);
  };

  const startCompleteSpinTracking = () => {
    // Reduced motion lands on the finished suit instantly — no loop churn.
    if (reducedMotion) {
      stopCompleteSpinTracking();
      return;
    }
    stopOrbitDiagnostic();
    completeSpinActive = true;
    completeSpinT = 0;
    showcaseSpinPaused = false;
    controls.autoRotate = false;
    // Warm wireframe while the long full-speed orbit runs so ease-out is free
    suit.prepareDiagnosticScan();
  };

  /** Freeze finished-suit orbit in place (Space while complete). */
  const pauseShowcaseSpin = () => {
    showcaseSpinPaused = true;
    controls.autoRotate = false;
    // Keep completeSpinActive + accum so resume continues the same turn.
  };

  /** Resume finished-suit idle orbit after a Space pause. */
  const resumeShowcaseSpin = () => {
    if (reducedMotion || loopFullCycle) return;
    showcaseSpinPaused = false;
    controls.autoRotate = false;
    if (!completeSpinActive) {
      // Drag killed tracking earlier — start a fresh full-turn watch.
      startCompleteSpinTracking();
    }
  };

  const refreshHintCopy = () => {
    const hintEl = document.getElementById('hint');
    if (hintEl) {
      hintEl.textContent = ui.isDirectorMode() ? DIRECTOR_HINT : VIEWER_HINT;
    }
  };

  /**
   * Orbit is always available during assembly and after complete.
   * While the cinematic path is playing, the first drag claims free-look
   * (`userOwnsCamera`) and overrides the progress-driven camera.
   * `preserveTarget` keeps the current orbit pivot instead of re-seeding
   * from the cinematic lookTarget.
   */
  const setOrbitMode = (
    _mode: 'free' | 'complete',
    opts?: { preserveTarget?: boolean },
  ) => {
    if (!opts?.preserveTarget) {
      controls.target.copy(lookTarget);
    }
    controls.enabled = true;
    // Showcase yaw is manual in update() — never use OrbitControls.autoRotate
    // (enableDamping made autoRotateSpeed feel inert / FPS-coupled).
    controls.autoRotate = false;
  };

  // Declared before callbacks so they can call into the controller once assigned.
  let assembly!: ReturnType<typeof createAssemblyTimeline>;

  /** Full sequence including post–systems-online camera pullback. */
  const fullDuration = () => Math.max(assembly.getFullDuration(), 1e-6);

  /**
   * SFX seed was authored before OPENING_HOLD. Map GSAP time onto that clock
   * so plate hits stay aligned; hangar hold is silent lead-in.
   */
  const sfxOffset = () => audioTimelineOffset();
  /**
   * Audio ruler length on the seed clock (cascade + camera tail + pad).
   * Targets {@link SEQUENCE_SEED_DURATION} (18.5s) via getFullDuration padding.
   */
  const audioDuration = () => Math.max(fullDuration() - sfxOffset(), 1e-6);
  const toAudioSec = (gsapTime: number) => gsapTime - sfxOffset();
  const fromAudioSec = (audioSec: number) => audioSec + sfxOffset();

  const syncAudioDuration = () => {
    if (!audioTimeline) return;
    const dur = audioDuration();
    if (dur > 0) audioTimeline.setAssemblyDuration(dur);
  };

  const audioPlayFromTime = (gsapTime?: number) => {
    // Play in viewer and director — panel is authoring UI only.
    // Pass seed-clock seconds (may be negative during the hangar hold so
    // clip delays keep original absolute starts vs the cascade).
    // Integrity progress is wave-paced — always drive SFX from raw GSAP time.
    if (!audioTimeline) return;
    const gsapT = gsapTime ?? assembly.getTime();
    audioTimeline.onTransportPlay(toAudioSec(gsapT));
  };

  const audioStop = () => {
    audioTimeline?.onTransportStop();
  };

  /** Sync playhead from live GSAP time (integrity % is wave-paced, not linear). */
  const audioPlayheadFromTime = (gsapTime?: number) => {
    if (!audioTimeline) return;
    const gsapT = gsapTime ?? assembly.getTime();
    // Ruler playhead stays ≥ 0 (hold shows 0 until cascade clock starts).
    audioTimeline.setPlayhead(Math.max(0, toAudioSec(gsapT)));
  };

  const syncDebugPauseLabel = () => {
    // Doff: its timeline; complete showcase: Space freeze; assembly: GSAP pause.
    const paused = handoffTween
      ? handoffTween.paused()
      : assemblyComplete
        ? showcaseSpinPaused || !completeSpinActive
        : assembly.isPaused() || !assembly.isPlaying();
    ui.setDebugPaused(paused);
    audioTimeline?.setPaused(paused);
  };

  const markCompleteClock = () => {
    // Only stamp once per complete stretch so scrubbing to end mid-showcase
    // does not zero the post-duration counter.
    if (completeAnchor == null) {
      completeAnchor = clock.getElapsedTime();
      // Prefer live GSAP time so the camera-tail seconds already counted
      // are kept (do not snap back to integrity-only assemblyDuration).
      completeBaseElapsed = Math.max(assembly.getTime(), assembly.getDuration());
    }
  };

  const clearCompleteClock = () => {
    completeAnchor = null;
    completeBaseElapsed = 0;
  };

  const getHudElapsed = (): number => {
    // Same seed clock as the audio DAW playhead (gsap − sfxOffset, ≥ 0).
    // Raw GSAP includes the hangar hold, so the top-right timer used to read
    // ~0.68s ahead of the sound timeline for the whole run.
    if (assemblyComplete && completeAnchor != null) {
      const base = Math.max(0, toAudioSec(completeBaseElapsed));
      return base + Math.max(0, clock.getElapsedTime() - completeAnchor);
    }
    // Live seed time through cascade + camera tail (hold stays at 0:00).
    return Math.max(0, toAudioSec(assembly.getTime()));
  };

  const applyCompleteUi = (opts?: { preserveCamera?: boolean }) => {
    assemblyComplete = true;
    markCompleteClock();
    suit.stopDiagnosticScan();
    suit.showFinal(); // seamless mesh — no grid-shard square blooms
    // Preserve free-look framing (no idle auto-rotate snap)
    const preserve = opts?.preserveCamera || assembly.userOwnsCamera();
    if (preserve) {
      setOrbitMode('free', { preserveTarget: true });
      stopCompleteSpinTracking();
    } else {
      setOrbitMode('complete');
      startCompleteSpinTracking();
    }
    ui.setReplayEnabled(true);
    ui.setSkipEnabled(false);
    ui.setHintVisible(true);
    ui.fadeTitle(true);
    ui.setIntegrity('INTEGRITY 100%');
    // Status may already be SYSTEMS ONLINE / DIAGNOSTIC COMPLETE from the
    // timeline — avoid a second cyan flash; setSystemsOnline is edge-triggered.
    ui.setStatus('SYSTEMS ONLINE', true);
    ui.setDebugProgress(1);
    audioStop();
    // Park the DAW playhead at the end of the full cycle (incl. camera tail).
    audioPlayheadFromTime(fullDuration());
    syncDebugPauseLabel();
    refreshHintCopy();
  };

  const applyAssemblyUi = (opts?: { preserveTarget?: boolean }) => {
    assemblyComplete = false;
    clearCompleteClock();
    stopCompleteSpinTracking();
    suit.stopDiagnosticScan();
    // Keep orbit live so a mid-play drag can override the cinematic path
    setOrbitMode('free', { preserveTarget: opts?.preserveTarget });
    ui.setReplayEnabled(false);
    ui.setSkipEnabled(true);
    ui.setHintVisible(false);
    ui.fadeTitle(false);
    ui.setSystemsOnline(false);
  };

  // Action sound layer (servos, flaps, thrusters, unclamps) on the engine
  /** Held while scrubbing so a seek never fires the cues it passes over. */
  let sfxMuted = false;
  const cues = createCuePlayer((req) => {
    if (!sfxMuted) audioTimeline?.engine.play(req);
  });
  const flightSfx = flightCues();
  const doffSfx = plan ? doffCues(plan) : [];
  // Each part's height orders the seal-release wave; its insert stroke
  // converts the released gap into channel units
  const doffParts: DoffPart[] = suit.pieces.map((p) => {
    const def = armorPieceDef(p.id);
    const stroke = Math.hypot(...def.insert.v) || 0.1;
    const b = suit.pieceBounds(p.id);
    return {
      id: p.id,
      y: b ? (b.min.y + b.max.y) / 2 : 1,
      perMetre: 1 / stroke,
      lift: FIT_TASKS.some((t) => t.kind === 'lift' && t.pieces.includes(p.id)),
    };
  });
  const doffFx = doffBursts();
  const doffOpenSfx = doffOpeningCues(doffEvents(doffParts));
  const doffPrepSfx = workshop
    ? doffPrepCues(
        // Each servo cue as its arm starts up out of the ring
        workshop.doffPrepOrder().map(({ id, rise }) => ({
          id,
          t: DOFF_PREP_FROM + rise * (SHOWCASE_TURN_SEC - DOFF_PREP_FROM),
        })),
      )
    : [];
  let lastFlightT = Number.NaN;
  /** Camera height offset currently applied for the hover. */
  let flightCamLift = 0;
  const flightPanel = createFlightPanel();
  const weaponReticles = createWeaponReticles(camera);
  const WEAPONS_FROM = FLIGHT_CHECK_STEPS[3].at;
  const WEAPONS_TO = FLIGHT_CHECK_STEPS[4].at;

  assembly = createAssemblyTimeline(suit, camera, lookTarget, {
    onStatus: (text) => {
      // Only final SYSTEMS ONLINE dismisses the progress panel — not
      // intermediate * ONLINE beats (reactor, repulsors, J.A.R.V.I.S., etc.).
      ui.setStatus(text, isSystemsOnlineStatus(text));
    },
    onProgress: (t) => {
      // Single path into the integrity bar (setIntegrity also drives setProgressVisual).
      // Avoid dual string+regex + second setDebugProgress every GSAP tick.
      ui.setDebugProgress(t);
      // Seed clock from live GSAP time so hold doesn’t skew SFX vs plates
      audioPlayheadFromTime();
      if (t < 0.999 && assemblyComplete) {
        // Scrubbed back from the end — keep free-look if user owns the camera
        applyAssemblyUi({
          preserveTarget: assembly.userOwnsCamera(),
        });
      }
    },
    // onActivePieces omitted — overlay setDebugActivePieces is a no-op; skip O(N)/frame
    onComplete: () => {
      if (loopFullCycle) {
        // Full assembly cycle only — restart immediately, no idle spin.
        startSequence();
        return;
      }
      applyCompleteUi({ preserveCamera: assembly.userOwnsCamera() });
    },
  }, { plan, workshop, sfx: (cue) => cues.fire(cue) });

  syncAudioDuration();

  const clearPick = () => {
    onClearPick();
    ui.setDebugPickedPiece(null);
    ui.setReclassPick(null);
  };

  const finishInstantly = () => {
    killHandoff();
    clearPick();
    clearCompleteClock();
    assembly.seek(1);
    applyCompleteUi();
    clockStart = clock.getElapsedTime();
  };

  /**
   * Core assembly boot: empty pad, rebuild timeline, play from hangar open.
   * Caller owns camera framing (hard snap via rebuild, or already eased in).
   */
  const runAssemblySequence = (opts?: { softProgress?: boolean }) => {
    clearPick();
    clearCompleteClock();
    ui.resetJarvisChrome({ softProgress: opts?.softProgress });

    if (reducedMotion) {
      finishInstantly();
      ui.setStatus('SYSTEMS ONLINE — REDUCED MOTION', true);
      return;
    }

    applyAssemblyUi();
    ui.setIntegrity('INTEGRITY   0%');
    // Opening hold copy — timeline stages J.A.R.V.I.S. / INITIATED next
    ui.setStatus('STANDBY // HANGAR LOCK');
    ui.setDebugProgress(0);
    assembly.rebuild();
    syncAudioDuration();
    audioStop();
    assembly.play();
    audioPlayFromTime(0);
    audioPlayheadFromTime(0);
    syncDebugPauseLabel();
    clockStart = clock.getElapsedTime();
  };

  /** Timing of the doff + cell reset (doff seconds), fixed for a built timeline. */
  const doffTiming = () => {
    // Rewind from the last frame with real parts to GSAP 0 (= what play()
    // renders first), so the next cycle starts without a cut.
    const rewindFrom = Math.max(0, assembly.getFinalSwapTime() - 0.02);
    const seedFrom = assembly.toSeed(rewindFrom);
    // Start the reversed clock early enough that the first gripper move
    // lands as the opening act ends (no dead beat while the tail rewinds)
    const idleTail = workshop ? Math.max(0, seedFrom - workshop.doffFirstMoveAt()) / DOFF_EXTRACT_RATE : 0;
    const clockFrom = Math.max(DOFF_CLOCK_EARLIEST, DOFF_RELEASE_SEC - idleTail);
    // Extraction runs the fitting backwards at the speed it was built
    const extractEnd = clockFrom + rewindFrom / DOFF_EXTRACT_RATE;
    // The cell clock runs on past the build's first frame until the last
    // stand has sunk and the last arm has folded away
    const cellTail = workshop ? Math.max(0, assembly.toSeed(0) - workshop.doffSettledAt()) + 0.1 : 0;
    const totalSec = extractEnd + cellTail;
    const riseAt = totalSec + RESET_HOLD_SEC;
    const endSec = workshop ? riseAt + RESET_RISE_SEC : totalSec;
    return { rewindFrom, seedFrom, clockFrom, extractEnd, totalSec, riseAt, endSec };
  };

  /** Authored doff camera (before the drift onto the reversed path) at doff time `t`. */
  const doffPoseAt = (t: number, out: CamPose): CamPose => {
    const sine = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * THREE.MathUtils.clamp(u, 0, 1));
    const a = sine(t / 1.5);
    const b = sine((t - 1.5) / (DOFF_RELEASE_SEC - 1.5 + 0.9));
    for (const k of CAM_KEYS) {
      const head = HERO_END_CAM[k] + (DOFF_HEAD_CAM[k] - HERO_END_CAM[k]) * a;
      out[k] = head + (DOFF_VENT_CAM[k] - head) * b;
    }
    return out;
  };

  /**
   * After the finished-suit idle 360° (or R from complete):
   * Diagnostic already ran over the orbit ease-out (if the full spin played).
   * 1) Doffing (see doffSequence): power-down, faceplate up, the seals vent
   *    down the suit and every lock lets go; then the fitting runs
   *    backwards — the grippers (already up from the end of the turn) take
   *    every part off and set it back on its stand, which sinks with it;
   *    each arm folds away when done, boots sink into the hatch
   * 2) Camera works in on the helmet, down with the vents, then out to the
   *    hangar framing as the last parts come off
   * 3) Drain integrity + restart assembly on the exact same frame
   *
   * Everything on screen is a function of the doff clock, so the handoff can
   * be scrubbed both ways (`opts.paused` builds it held at its first frame).
   */
  const softRestartFromShowcase = (opts?: { paused?: boolean }) => {
    killHandoff();
    stopOrbitDiagnostic();
    stopCompleteSpinTracking();
    controls.autoRotate = false;
    clearPick();
    // Keep assemblyComplete until handoff ends so Space doesn't re-engage spin
    assemblyComplete = true;
    assembly.setUserOwnsCamera(false);

    // JARVIS re-entry + integrity drain while plates are bursting clear.
    // Do not call setIntegrity/setDebugProgress here — they would cancel the drain.
    ui.resetJarvisChrome({ softProgress: true });
    ui.setReplayEnabled(false);
    ui.setSkipEnabled(true);
    ui.setHintVisible(false);
    ui.fadeTitle(false);
    ui.setSystemsOnline(false);
    audioStop();

    // Seamless suit → its seated parts for the reverse fitting
    suit.resumeAssemblyVisuals();
    // Always pull from authored hero end (orbit seals this pose) so the
    // hangar open ease is a clean, repeatable loop join.
    applyHeroEndCam();
    // Orbit would fight the cinematic handoff
    controls.enabled = false;

    const { rewindFrom, seedFrom, clockFrom, extractEnd, totalSec, riseAt, endSec } = doffTiming();
    /** GSAP time of the cell (unclamped: negative through the tail) at doff time `t`. */
    const cellAt = (t: number) => rewindFrom - Math.max(0, t - clockFrom) * DOFF_EXTRACT_RATE;
    /** GSAP time of the suit-up shown at doff time `t`. */
    const fittingAt = (t: number) => Math.max(0, cellAt(t));
    // Grippers not yet up (R before the turn finished) come up through the opening act
    const prep0 = workshop?.doffPrepProgress() ?? 1;
    const endOverlay = evaluateDoff(totalSec, doffParts);

    /**
     * Camera: the authored poses through the opening act, then the
     * assembly's own path run backwards with the fitting (no shakes),
     * followed with a lag so it drifts rather than retracing every move; it
     * settles on the open-wide frame through the cell reset, which is where
     * the next cycle starts. The lag is integrated in fixed steps from the
     * start, so a scrubbed frame matches the played one.
     */
    const pose: CamPose = { ...HERO_END_CAM };
    const smooth: CamPose = { ...HERO_END_CAM };
    let smoothT = 0;
    const CAM_STEP = 1 / 60;
    const stepCam = (t: number, dt: number) => {
      doffPoseAt(t, pose);
      const k = THREE.MathUtils.smoothstep(t, DOFF_RELEASE_SEC, DOFF_RELEASE_SEC + DOFF_PATH_BLEND);
      const path = k > 0 ? assembly.cameraAt(fittingAt(Math.min(t, totalSec)), false) : null;
      // Tighter lag through the reset so it lands exactly on open-wide
      const lag = t > extractEnd ? DOFF_CAM_LAG / 2 : DOFF_CAM_LAG;
      const a = t <= DOFF_RELEASE_SEC ? 1 : 1 - Math.exp(-dt / lag);
      for (const key of CAM_KEYS) {
        const target = path ? pose[key] + (path[key] - pose[key]) * k : pose[key];
        smooth[key] += (target - smooth[key]) * a;
      }
    };
    const cameraTo = (t: number) => {
      if (t < smoothT || t - smoothT > 0.25) {
        // Jumped (scrub): re-run the lag from the top
        Object.assign(smooth, HERO_END_CAM);
        smoothT = 0;
      }
      while (smoothT + CAM_STEP < t) {
        smoothT += CAM_STEP;
        stepCam(smoothT, CAM_STEP);
      }
      stepCam(t, t - smoothT);
      smoothT = t;
      camera.position.set(smooth.x, smooth.y, smooth.z);
      lookTarget.set(smooth.lx, smooth.ly, smooth.lz);
      controls.target.copy(lookTarget);
      camera.lookAt(lookTarget);
      if (Math.abs(camera.fov - smooth.fov) > 1e-4) {
        camera.fov = smooth.fov;
        camera.updateProjectionMatrix();
      }
    };

    /** JARVIS line in force at doff time `t`. */
    const statusAt = (t: number): string => {
      if (workshop && t >= riseAt) return 'CELL DEPLOY // NEXT FITTING';
      if (workshop && t >= extractEnd) return 'CELL STOW // PARTS TO STORAGE';
      let line = DOFF_STATUSES[0].text;
      for (const s of DOFF_STATUSES) if (s.t <= t) line = s.text;
      return line;
    };
    let lastStatus = '';
    let lastDoffT = 0;
    let lastSeed = seedFrom;
    // Low motor bed under the extraction (no hiss): crossfaded takes of the hum
    const humLen = 7.55;
    const humSec = totalSec - DOFF_RELEASE_SEC;
    const hum: SfxCue[] = [];
    for (let at = 0; at < humSec - 0.5; at += humLen - 0.8) {
      const left = humSec - at;
      hum.push({
        t: DOFF_RELEASE_SEC + at,
        file: 'doff-hum.mp3',
        volume: 0.32,
        duration: Math.min(humLen, left),
        fadeIn: at === 0 ? 0.4 : 0.8,
        fadeOut: left <= humLen ? 1.2 : 0.8,
      });
    }
    const resetSfx = workshop ? redeployCues(RESET_RISE_SEC).map((c) => ({ ...c, t: riseAt + c.t })) : [];

    const render = () => {
      const t = doffClock.t;
      const scrub = sfxMuted;
      if (t <= totalSec) {
        // 1) Power-down → faceplate → seal release, then the extraction
        //    (stands sinking with their parts, arms folding away as they finish)
        const overlay = evaluateDoff(t, doffParts);
        const seed = assembly.toSeed(cellAt(t));
        if (workshop) {
          workshop.setDoffClock(seed);
          workshop.setDoffPrep(prep0 + (1 - prep0) * THREE.MathUtils.smoothstep(t, 0, DOFF_RELEASE_SEC * 0.8));
        }
        assembly.renderSuitAt(fittingAt(t), (frame) => applyDoff(frame, overlay));
        suit.setReactorPowerDown(t);
        // Parts set back down ride their stands away
        if (workshop) suit.rideStands((task) => workshop.standShift(task));
        // Opening act on the doff clock, extraction on the (backwards) seed clock
        cues.between(doffOpenSfx, lastDoffT, t);
        if (!scrub) for (const b of doffFx) if (b.t > lastDoffT && b.t <= t) suit.emitBurst(b);
        cues.between(doffSfx, lastSeed, seed);
        lastSeed = seed;
      } else if (workshop) {
        // 2) Cell reset on the open-wide frame: a beat on the empty pad, then
        //    the cell redeploys for the next build
        workshop.setDoffClock(null);
        suit.setReactorPowerDown(null);
        assembly.renderSuitAt(0, (frame) => applyDoff(frame, endOverlay));
        const u = THREE.MathUtils.clamp((t - riseAt) / RESET_RISE_SEC, 0, 1);
        workshop.setRedeployProgress(0.5 - 0.5 * Math.cos(Math.PI * u));
        suit.rideStands((task) => workshop.standShift(task));
        lastSeed = assembly.toSeed(cellAt(totalSec));
      }
      cues.between(hum, lastDoffT, t);
      cues.between(resetSfx, lastDoffT, t);
      lastDoffT = t;
      const line = statusAt(t);
      if (line !== lastStatus) {
        lastStatus = line;
        ui.setStatus(line);
      }
      cameraTo(t);
    };

    const doffClock = { t: 0 };
    handoffTween = gsap.timeline({
      paused: !!opts?.paused,
      onComplete: () => {
        // A scrub that lands on the last frame holds there; only a played
        // handoff hands over to the next build
        if (sfxMuted) return;
        handoffTween = null;
        workshop?.setDoffClock(null);
        suit.setReactorPowerDown(null);
        // Exact open-wide lock so assembly t=0 OPEN_WIDE is invisible
        applyOpenWideCam();
        suit.showAssembly();
        // Soft UI already applied — skip a second panel flash / drain
        clearCompleteClock();
        applyAssemblyUi({ preserveTarget: true });
        ui.setStatus('STANDBY // HANGAR LOCK');
        assembly.rebuild();
        syncAudioDuration();
        audioStop();
        assembly.play();
        audioPlayFromTime(0);
        audioPlayheadFromTime(0);
        syncDebugPauseLabel();
        clockStart = clock.getElapsedTime();
      },
    });
    // One driver for the whole handoff (doff + cell reset)
    handoffTween.to(doffClock, { t: endSec, duration: endSec, ease: 'none', onUpdate: render }, 0);
    render();
    syncDebugPauseLabel();
  };

  const startSequence = () => {
    killHandoff();

    if (reducedMotion) {
      runAssemblySequence();
      return;
    }

    // Soft handoff only when leaving the finished-suit showcase (post-360 / R)
    if (assemblyComplete) {
      softRestartFromShowcase();
      return;
    }

    runAssemblySequence();
  };

  const skipToEnd = () => {
    if (assemblyComplete && !handoffTween) return;
    killHandoff();
    clearPick();
    audioStop();
    // Integrity seek(1) only parks at systems-online / finalSwap cam — not the
    // authored hero end composition. Jump to full GSAP end, then seal HERO_END
    // so free-look / mid-path framing never sticks after S.
    assembly.seekTime(fullDuration(), { preserveCamera: false });
    applyHeroEndCam();
    applyCompleteUi({ preserveCamera: false });
  };

  const togglePause = () => {
    // Mid handoff: hold / play the doff where it is
    if (handoffTween) {
      handoffTween.paused(!handoffTween.paused());
      syncDebugPauseLabel();
      return;
    }
    if (assembly.isPlaying()) {
      assembly.pause();
      audioStop();
      // Orbit stays enabled; path is frozen at this frame until resume
      setOrbitMode('free', {
        preserveTarget: assembly.userOwnsCamera(),
      });
    } else if (assemblyComplete) {
      // True complete only (after camera tail / skip). Integrity can hit 100%
      // while the hero pullback still runs — that window must resume GSAP,
      // not toggle showcase spin (Space would otherwise strand the timeline).
      if (completeSpinActive && !showcaseSpinPaused) {
        pauseShowcaseSpin();
      } else {
        resumeShowcaseSpin();
      }
    } else {
      // Mid-assembly or post-systems-online camera tail: resume the path.
      // Free-look only if the user claimed orbit; otherwise re-attach.
      const preserveCamera = assembly.userOwnsCamera();
      // Don't wipe complete chrome mid-tail — only re-apply free orbit mode
      // when we are still in the active assembly UI state.
      if (!assemblyComplete) {
        setOrbitMode('free', { preserveTarget: preserveCamera });
      }
      assembly.resume({ preserveCamera });
      audioPlayFromTime();
    }
    syncDebugPauseLabel();
  };

  /**
   * Park at the final GSAP frame while scrubbing — finished suit + complete
   * chrome, but no showcase spin kick (that yaw felt like a camera jerk when
   * ←/→ reached the end of the extended ruler).
   */
  const parkScrubAtEnd = () => {
    assemblyComplete = true;
    markCompleteClock();
    suit.stopDiagnosticScan();
    suit.showFinal();
    stopCompleteSpinTracking();
    // Keep the cinematic end pose; only reseed pivot for the next free-look.
    setOrbitMode('free', { preserveTarget: false });
    ui.setReplayEnabled(true);
    ui.setSkipEnabled(false);
    ui.setHintVisible(true);
    ui.fadeTitle(true);
    ui.setIntegrity('INTEGRITY 100%');
    ui.setStatus('SYSTEMS ONLINE', true, { scrub: true });
    ui.setDebugProgress(1);
    audioStop();
    audioPlayheadFromTime(fullDuration());
    syncDebugPauseLabel();
    refreshHintCopy();
  };

  /**
   * HUD chrome for a scrubbed GSAP time.
   * Complete chrome only at the true full-cycle end — not systems online.
   * Integrity plateaus at 100% through the camera tail; scrubbing there must
   * stay on the cinematic path (no spin jump / orbit clamp fight).
   */
  const applyScrubUiAtTime = (gsapT: number) => {
    const full = fullDuration();
    if (gsapT >= full - 1e-3) {
      parkScrubAtEnd();
      return;
    }

    // Mid-cycle (plates or camera tail): path owns framing, no showcase spin.
    // Avoid applyAssemblyUi — it clears systems-online and re-flashes cyan
    // every arrow key while scrubbing the tail.
    const wasComplete = assemblyComplete;
    assemblyComplete = false;
    clearCompleteClock();
    if (wasComplete || completeSpinActive) {
      stopCompleteSpinTracking();
    }
    // Only reseed the orbit pivot when leaving complete / spin. Doing it every
    // step is unnecessary — seekTime already applied the cinematic camera, and
    // main.ts skips controls.update while paused so the pose sticks.
    if (wasComplete) {
      setOrbitMode('free', { preserveTarget: false });
    } else {
      controls.target.copy(lookTarget);
    }
    ui.setReplayEnabled(false);
    ui.setSkipEnabled(true);
    ui.setHintVisible(false);
    ui.fadeTitle(false);

    const p = assembly.getProgress();
    const pct = Math.round(p * 100);
    ui.setIntegrity(`INTEGRITY ${String(pct).padStart(3, ' ')}%`);
    ui.setDebugProgress(p);
    if (p >= 0.999) {
      // Camera tail — suit is done; scrub skips staged baton delays.
      ui.setStatus('SYSTEMS ONLINE', true, { scrub: true });
    } else {
      // Wave-paced phase label so scrub shows where you are.
      ui.setStatus(statusForIntegrityProgress(p), false, { scrub: true });
    }
  };

  /** Seek visual integrity progress 0–1 (wave-paced; includes hangar hold at 0%). */
  const seek = (p: number) => {
    killHandoff();
    // Scrub invalidates overlay parents / visibility — drop selection
    clearPick();
    // Timeline scrub always re-attaches to the cinematic camera. Orbiting
    // the viewport (bindInput controls 'start') is what detaches free-look.
    audioStop();
    assembly.seek(p, { preserveCamera: false });
    audioPlayheadFromTime();
    syncDebugPauseLabel();
    // Integrity 1 maps to systems online — still allow skip-style end via seek(1).
    if (p >= 0.999) {
      applyCompleteUi({ preserveCamera: false });
    } else {
      applyScrubUiAtTime(assembly.getTime());
    }
  };

  /**
   * Step the GSAP playhead by wall-clock seconds (full cycle, incl. camera tail).
   * Used by ←/→ so scrubbing past systems online continues through the pullback
   * instead of treating integrity 100% as "jump to end".
   */
  const scrubBySeconds = (deltaSec: number) => {
    seekCycle(cycleNow().t + deltaSec);
  };

  /**
   * Audio DAW scrub is 0–1 on the *seed* clock (no hangar hold).
   * Seek by absolute GSAP time (integrity % is wave-paced, not linear time).
   */
  const seekFromAudioProgress = (audioProgress01: number) => {
    killHandoff();
    const audioT = Math.max(0, Math.min(1, audioProgress01)) * audioDuration();
    const gsapT = fromAudioSec(audioT);
    clearPick();
    audioStop();
    assembly.seekTime(gsapT, { preserveCamera: false });
    audioPlayheadFromTime();
    syncDebugPauseLabel();
    applyScrubUiAtTime(gsapT);
  };

  ui.onReplay(() => {
    startSequence();
  });

  ui.onSkip(() => {
    skipToEnd();
  });

  ui.onDirectorModeChange((enabled) => {
    if (!enabled) {
      clearPick();
      // Keep SFX transport running — director only toggles authoring chrome.
    } else {
      syncAudioDuration();
      audioPlayheadFromTime();
    }
    audioTimeline?.setVisible(enabled);
    refreshHintCopy();
  });

  // Panel chrome follows director preference; audio duration always tracked.
  audioTimeline?.setVisible(ui.isDirectorMode());
  syncAudioDuration();

  audioTimeline?.onSeek((p) => {
    seekFromAudioProgress(p);
  });

  audioTimeline?.onTogglePause(() => {
    togglePause();
  });

  audioTimeline?.onLoopChange((enabled) => {
    loopFullCycle = enabled;
    // If already sitting on the finished suit with loop just enabled, kick
    // a fresh cycle so the director does not wait for a spin.
    if (enabled && assemblyComplete) {
      startSequence();
    }
  });

  // ── Cycle clock: assembly → flight check → disassembly ─────────────

  /** Phase lengths on the cycle clock (s): assembly (incl. camera tail), flight check turn, doff + cell reset. */
  const cyclePhases = (): CyclePhases => {
    const assemblySec = fullDuration();
    const flightSec = reducedMotion ? 0 : SHOWCASE_TURN_SEC;
    const doffSec = reducedMotion ? 0 : doffTiming().endSec;
    return { assembly: assemblySec, flight: flightSec, doff: doffSec, total: assemblySec + flightSec + doffSec };
  };

  /** Where the cycle is now. A finished suit held in free-look sits at the start of the flight check. */
  const cycleNow = (): { t: number; phase: CyclePhase } => {
    const p = cyclePhases();
    if (handoffTween) return { t: p.assembly + p.flight + handoffTween.time(), phase: 'doff' };
    if (assemblyComplete) return { t: p.assembly + (completeSpinActive ? completeSpinT : 0), phase: 'flight' };
    return { t: THREE.MathUtils.clamp(assembly.getTime(), 0, p.assembly), phase: 'assembly' };
  };

  const isCyclePlaying = (): boolean => {
    if (handoffTween) return !handoffTween.paused();
    if (assemblyComplete) return completeSpinActive && !showcaseSpinPaused && !assembly.userOwnsCamera();
    return assembly.isPlaying() && !assembly.isPaused();
  };

  /** Finished suit at the end of the build, showcase turn held at `t` (s). */
  const enterShowcaseAt = (t: number) => {
    if (handoffTween) killHandoff();
    if (!assemblyComplete || !completeSpinActive || assembly.userOwnsCamera()) {
      clearPick();
      audioStop();
      assembly.setUserOwnsCamera(false);
      assembly.seekTime(fullDuration(), { preserveCamera: false });
      applyHeroEndCam();
      applyCompleteUi({ preserveCamera: false });
    }
    if (reducedMotion) return;
    // A scrub holds the frame; Space (or letting go of a playing drag) plays on
    showcaseSpinPaused = true;
    renderShowcase(t, { scrub: true });
  };

  /** Seek the whole cycle to `t` (s on the cycle clock), held there. */
  const seekCycle = (t: number) => {
    const p = cyclePhases();
    const at = THREE.MathUtils.clamp(t, 0, p.total);
    sfxMuted = true;
    try {
      if (at < p.assembly - 1e-4 || p.flight + p.doff === 0) {
        // Build: scrub the assembly timeline (leaving the turn / doff)
        killHandoff();
        stopOrbitDiagnostic();
        clearPick();
        audioStop();
        assembly.seekTime(at, { preserveCamera: false });
        audioPlayheadFromTime();
        applyScrubUiAtTime(at);
      } else if (at < p.assembly + p.flight) {
        enterShowcaseAt(at - p.assembly);
      } else {
        if (!handoffTween) {
          // Build the doff from the turn's last frame, held
          enterShowcaseAt(p.flight);
          softRestartFromShowcase({ paused: true });
        }
        const tl = handoffTween!;
        tl.pause();
        // Never onto the very last frame: that one hands over to the next build
        tl.seek(Math.min(at - p.assembly - p.flight, tl.duration() - 1e-3), false);
      }
    } finally {
      sfxMuted = false;
    }
    syncDebugPauseLabel();
  };

  /** Play / hold the cycle wherever it is. */
  const setCyclePlaying = (play: boolean) => {
    if (play === isCyclePlaying()) return;
    togglePause();
  };

  /**
   * Manually yaws the camera around the suit for {@link SHOWCASE_TURN_SEC},
   * then soft-restarts. (Disabled while AUDIO LOOP is on.)
   *
   * Wireframe diagnostic starts when remaining yaw enters
   * {@link SPIN_EASE_OUT_RAD} (spin slowdown) and reaches 1 as the orbit
   * ease ends — same window, no separate post-orbit scan phase.
   *
   * @returns true if this frame owned the camera (caller should skip controls.update).
   */
  const update = (deltaSec: number): boolean => {
    if (loopFullCycle) return false;
    if (handoffTween) return false;
    if (!completeSpinActive || !assemblyComplete) return false;

    // Space pause: freeze accum mid-turn; do not treat as free-look cancel.
    // Scan holds at the current progress (still armed).
    if (showcaseSpinPaused) return false;

    // User drag claimed free-look — stay on finished suit, no auto-replay.
    if (assembly.userOwnsCamera()) {
      stopOrbitDiagnostic();
      stopCompleteSpinTracking();
      return false;
    }

    // Clamp tab-resume spikes so we don't skip most of the orbit in one frame
    const dt = Math.min(0.05, Math.max(0, deltaSec));
    if (dt <= 0) return true;

    // Ease spin down as the turn completes so the handoff doesn’t cut hard:
    // an even deceleration that comes to rest on the exact frame the turn
    // ends (no crawl through the last degrees)
    renderShowcase(Math.min(SHOWCASE_TURN_SEC, completeSpinT + dt));

    // Finish when the turn has come to rest
    if (completeSpinT >= SHOWCASE_TURN_SEC) {
      // Scan landed at 1; seal hero framing, then dematerialize → hangar open
      applyHeroEndCam();
      stopCompleteSpinTracking();
      softRestartFromShowcase();
      return false;
    }
    return true;
  };

  return {
    getCycle: () => ({ ...cycleNow(), phases: cyclePhases(), playing: isCyclePlaying() }),
    seekCycle,
    setCyclePlaying,
    startSequence,
    skipToEnd,
    togglePause,
    seek,
    scrubBySeconds,
    update,
    isShowcaseOrbiting: () =>
      completeSpinActive &&
      assemblyComplete &&
      !showcaseSpinPaused &&
      !assembly.userOwnsCamera(),
    assembly,
    isComplete: () => assemblyComplete,
    getHudElapsed,
    getClockStart: () => clockStart,
    setClockStart: (t: number) => {
      clockStart = t;
    },
    refreshHintCopy,
  };
}
