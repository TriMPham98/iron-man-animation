import gsap from 'gsap';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  audioTimelineOffset,
  createAssemblyTimeline,
  OPEN_WIDE_CAM,
  type AssemblyController,
} from '../animation/assemblyTimeline';
import type { Suit } from '../suit/Suit';
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
const SHOWCASE_ORBIT_SEC = 28;
/** When remaining yaw is under this, ease spin to a stop (≈ half prior). */
const SPIN_EASE_OUT_RAD = 0.275;
/** Plates burst outward (reverse cascade) — slow, linear flight (no ease-out coast). */
const HANDOFF_EXPLODE_SEC = 3.12;
/** Hangar pull (final ease) — snappy; ends with the last plates. */
const HANDOFF_CAM_SEC = 0.6;
/** Pull while debris is still in flight so empty-pad time is near zero. */
const HANDOFF_CAM_DELAY = HANDOFF_EXPLODE_SEC - HANDOFF_CAM_SEC;

const VIEWER_HINT =
  'Drag to orbit · R replay · Space pause · S skip · M mute · ←→ scrub';
const DIRECTOR_HINT =
  'Drag to orbit · plate · RECLASS · AUDIO scrub · A add · [ ] wave · M mute · ←→ · R · Space · S';

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
}

export interface AssemblySession {
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
  let completeSpinAccum = 0;
  /** True when Space froze showcase spin (not a free-look cancel). */
  let showcaseSpinPaused = false;
  /** GSAP handoff: dematerialize + hangar pull before rebuild. */
  let handoffTween: gsap.core.Timeline | null = null;
  const _spinOffset = new THREE.Vector3();
  const _spinAxis = new THREE.Vector3(0, 1, 0);

  const killHandoff = () => {
    handoffTween?.kill();
    handoffTween = null;
  };

  const stopCompleteSpinTracking = () => {
    completeSpinActive = false;
    completeSpinAccum = 0;
    showcaseSpinPaused = false;
    // Never leave OrbitControls auto-spin on — we own the showcase orbit.
    controls.autoRotate = false;
  };

  const startCompleteSpinTracking = () => {
    // Reduced motion lands on the finished suit instantly — no loop churn.
    if (reducedMotion) {
      stopCompleteSpinTracking();
      return;
    }
    completeSpinActive = true;
    completeSpinAccum = 0;
    showcaseSpinPaused = false;
    controls.autoRotate = false;
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
    // Complete showcase: Space freeze; assembly: GSAP pause.
    const paused = assemblyComplete
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
    // Status may already be SYSTEMS ONLINE from assemblyEndTime — avoid a
    // second cyan flash; setSystemsOnline is edge-triggered either way.
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
    // Keep orbit live so a mid-play drag can override the cinematic path
    setOrbitMode('free', { preserveTarget: opts?.preserveTarget });
    ui.setReplayEnabled(false);
    ui.setSkipEnabled(true);
    ui.setHintVisible(false);
    ui.fadeTitle(false);
    ui.setSystemsOnline(false);
  };

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
  });

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

  /**
   * After the finished-suit idle 360° (or R from complete):
   * 1) Plates explode outward (reverse cascade — helmet first)
   * 2) Pull camera to hangar open over the empty pad
   * 3) Drain integrity + restart assembly
   */
  const softRestartFromShowcase = () => {
    killHandoff();
    stopCompleteSpinTracking();
    controls.autoRotate = false;
    clearPick();
    // Keep assemblyComplete until handoff ends so Space doesn't re-engage spin
    assemblyComplete = true;
    assembly.setUserOwnsCamera(false);

    // JARVIS re-entry + integrity drain while plates are bursting clear.
    // Do not call setIntegrity/setDebugProgress here — they would cancel the drain.
    ui.resetJarvisChrome({ softProgress: true });
    ui.setStatus('STANDBY // HANGAR LOCK');
    ui.setReplayEnabled(false);
    ui.setSkipEnabled(true);
    ui.setHintVisible(false);
    ui.fadeTitle(false);
    ui.setSystemsOnline(false);
    audioStop();
    syncDebugPauseLabel();

    // Seamless → seated shards for the reverse burst
    suit.armExplosionFromFinal();

    const proxy = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      lx: lookTarget.x,
      ly: lookTarget.y,
      lz: lookTarget.z,
      fov: camera.fov,
    };

    const applyHandoffCam = () => {
      camera.position.set(proxy.x, proxy.y, proxy.z);
      lookTarget.set(proxy.lx, proxy.ly, proxy.lz);
      controls.target.copy(lookTarget);
      camera.lookAt(lookTarget);
      if (Math.abs(camera.fov - proxy.fov) > 1e-4) {
        camera.fov = proxy.fov;
        camera.updateProjectionMatrix();
      }
    };

    // Orbit would fight the cinematic handoff
    controls.enabled = false;

    const explode = { t: 0 };
    handoffTween = gsap.timeline({
      onComplete: () => {
        handoffTween = null;
        applyHandoffCam();
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

    // 1) Linear burst — ease-out used to empty the pad early, then sit dead
    //    until t=end. Linear keeps plates in flight for the full duration.
    handoffTween.to(
      explode,
      {
        t: 1,
        duration: HANDOFF_EXPLODE_SEC,
        ease: 'none',
        onUpdate: () => {
          suit.setExplosionProgress(explode.t);
        },
      },
      0,
    );

    // 2) Hangar pull ends with the last plates → next cycle starts immediately
    handoffTween.to(
      proxy,
      {
        x: OPEN_WIDE_CAM.x,
        y: OPEN_WIDE_CAM.y,
        z: OPEN_WIDE_CAM.z,
        lx: OPEN_WIDE_CAM.lx,
        ly: OPEN_WIDE_CAM.ly,
        lz: OPEN_WIDE_CAM.lz,
        fov: OPEN_WIDE_CAM.fov,
        duration: HANDOFF_CAM_SEC,
        ease: 'power2.inOut',
        onUpdate: applyHandoffCam,
      },
      HANDOFF_CAM_DELAY,
    );
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
    assembly.seek(1);
    applyCompleteUi();
  };

  const togglePause = () => {
    // Mid handoff: treat Space as cancel → stay on open pad and start assembly
    if (handoffTween) {
      killHandoff();
      runAssemblySequence({ softProgress: false });
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
    suit.showFinal();
    stopCompleteSpinTracking();
    // Keep the cinematic end pose; only reseed pivot for the next free-look.
    setOrbitMode('free', { preserveTarget: false });
    ui.setReplayEnabled(true);
    ui.setSkipEnabled(false);
    ui.setHintVisible(true);
    ui.fadeTitle(true);
    ui.setIntegrity('INTEGRITY 100%');
    ui.setStatus('SYSTEMS ONLINE', true);
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
      // Camera tail — suit is done; edge-triggered so no re-flash.
      ui.setStatus('SYSTEMS ONLINE', true);
    } else {
      ui.setSystemsOnline(false);
      ui.setStatus('DEBUG SCRUB', false);
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
    killHandoff();
    clearPick();
    audioStop();
    const full = fullDuration();
    // After complete, timeline time is already at the end — step back from there.
    const cur = Math.min(full, Math.max(0, assembly.getTime()));
    const next = THREE.MathUtils.clamp(cur + deltaSec, 0, full);
    assembly.seekTime(next, { preserveCamera: false });
    audioPlayheadFromTime();
    syncDebugPauseLabel();
    applyScrubUiAtTime(next);
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

  /**
   * Manually yaws the camera around the suit for {@link SHOWCASE_ORBIT_SEC},
   * then soft-restarts. (Disabled while AUDIO LOOP is on.)
   * @returns true if this frame owned the camera (caller should skip controls.update).
   */
  const update = (deltaSec: number): boolean => {
    if (loopFullCycle) return false;
    if (handoffTween) return false;
    if (!completeSpinActive || !assemblyComplete) return false;

    // Space pause: freeze accum mid-turn; do not treat as free-look cancel.
    if (showcaseSpinPaused) return false;

    // User drag claimed free-look — stay on finished suit, no auto-replay.
    if (assembly.userOwnsCamera()) {
      stopCompleteSpinTracking();
      return false;
    }

    // Clamp tab-resume spikes so we don't skip most of the orbit in one frame
    const dt = Math.min(0.05, Math.max(0, deltaSec));
    if (dt <= 0) return true;

    // Ease spin down as the turn completes so the handoff doesn’t cut hard
    const remaining = Math.PI * 2 - completeSpinAccum;
    let speedMul = 1;
    if (remaining < SPIN_EASE_OUT_RAD && remaining > 0) {
      const t = remaining / SPIN_EASE_OUT_RAD;
      // Smoothstep ease-out
      const ease = t * t * (3 - 2 * t);
      speedMul = Math.max(0.12, ease);
    }

    // Same sign as OrbitControls._rotateLeft (theta decreases → CW from above)
    const angle = (-(Math.PI * 2) / SHOWCASE_ORBIT_SEC) * dt * speedMul;

    // Orbit about the cinematic pivot; keep controls.target in sync
    const pivot = lookTarget;
    controls.target.copy(pivot);
    _spinOffset.copy(camera.position).sub(pivot);
    _spinOffset.applyAxisAngle(_spinAxis, angle);
    camera.position.copy(pivot).add(_spinOffset);
    camera.lookAt(pivot);

    completeSpinAccum += Math.abs(angle);

    if (completeSpinAccum >= Math.PI * 2 - 1e-3) {
      stopCompleteSpinTracking();
      softRestartFromShowcase();
      return false;
    }
    return true;
  };

  return {
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
