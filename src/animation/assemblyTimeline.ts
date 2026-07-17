import gsap from 'gsap';
import * as THREE from 'three';
import type { Suit } from '../suit/Suit';
import {
  applyMirroredFlightStarts,
  planSymmetricLaunchGroups,
} from '../suit/assemblyOrder';
import { WAVE_ORDER, WAVE_STATUS } from '../suit/waves';
import {
  magneticPath,
  mirrorPathAroundRest,
  type MagneticPath,
} from '../utils/easeHelpers';

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
  start: number;
  end: number;
}

export interface AssemblyController {
  play: () => void;
  pause: () => void;
  resume: () => void;
  /** Seek to normalized progress 0–1 (pauses). Scrubs plate/camera/systems state. */
  seek: (progress01: number) => void;
  getProgress: () => number;
  getDuration: () => number;
  kill: () => void;
  isPlaying: () => boolean;
  isPaused: () => boolean;
  rebuild: () => void;
}

/**
 * Mark III bottom→top timing — one continuous cascade.
 *
 * Root cause of “section pauses”: next wave was scheduled from previous
 * *lock end* minus a small overlap (~0.45s). With plate travel ~1.1s that
 * left ~0.7s after the last launch of a wave with nothing new starting.
 *
 * Fix: chain each wave to the previous wave’s last *launch* (+ tiny gap),
 * not its last lock. WAVE_EARLIEST is only a soft floor for boots / open.
 */
const WAVE_EARLIEST: Record<string, number> = {
  boots: 0.2,
  calves: 0,
  thighs: 0,
  hips: 0,
  torso: 0,
  shoulders: 0,
  arms: 0,
  gauntlets: 0,
  helmet: 0,
  power: 0,
};

/**
 * Seconds after the previous wave’s last plate *launches* before the next
 * wave’s first plate launches. Keep tiny so sections blend with no idle.
 */
const WAVE_CHAIN_GAP = 0.04;

/** Camera micro-shake amplitude when a wave finishes locking. */
const WAVE_SHAKE: Partial<Record<string, number>> = {
  boots: 0.006,
  calves: 0.007,
  thighs: 0.008,
  hips: 0.01,
  torso: 0.016,
  shoulders: 0.012,
  arms: 0.009,
  gauntlets: 0.01,
  helmet: 0.02,
};

/** Default plate travel — slightly snappier so same-wave clamps read as a burst */
const PIECE_DURATION = 1.12;
/** Helmet / faceplate — heavier, more movie-like hydraulic close */
const HELMET_PIECE_DURATION = 2.05;

/** Fraction of travel spent on the magnetic approach (rest is dock + clamp). */
const APPROACH_FRAC = 0.78;
const HELMET_APPROACH_FRAC = 0.82;

export function createAssemblyTimeline(
  suit: Suit,
  camera: THREE.PerspectiveCamera,
  lookTarget: THREE.Vector3,
  callbacks: TimelineCallbacks = {},
): AssemblyController {
  let tl: gsap.core.Timeline | null = null;
  let playing = false;
  /** Timeline time when seamless final mesh swaps in (for scrub restore). */
  let finalSwapTime = 0;
  /** Launch→lock windows for every plate (rebuilt with the timeline). */
  let motionSpans: PieceMotionSpan[] = [];

  const reportActivePieces = (timeSec: number) => {
    const active: ActivePieceInfo[] = [];
    for (const span of motionSpans) {
      if (timeSec + 1e-6 < span.start || timeSec > span.end + 1e-6) continue;
      const dur = Math.max(span.end - span.start, 1e-6);
      active.push({
        id: span.id,
        wave: span.wave,
        localProgress: THREE.MathUtils.clamp(
          (timeSec - span.start) / dur,
          0,
          1,
        ),
      });
    }
    // Prefer pieces further along their flight (nearest to clamp) first
    active.sort((a, b) => b.localProgress - a.localProgress);
    callbacks.onActivePieces?.(active);
  };

  /**
   * Launch gap between plates *within* the same body section.
   * Kept tight so similar parts stream in as one cascade.
   */
  const staggerFor = (count: number, helmet = false) => {
    if (count <= 1) return 0;
    if (helmet) {
      // Still readable as separate clamps, but not a long wait between each
      return Math.min(0.2, Math.max(0.065, 1.15 / count));
    }
    // Dense waves (thighs/torso/arms) fire almost as a cascade
    return Math.min(0.1, Math.max(0.022, 0.65 / count));
  };

  const cameraProxy = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    lx: lookTarget.x,
    ly: lookTarget.y,
    lz: lookTarget.z,
  };

  /** Additive shake so path tweens stay stable while locks punch the frame. */
  const shake = { x: 0, y: 0, z: 0 };

  // Independent system ramps
  const reactorProxy = { v: 0 };
  const eyesProxy = { v: 0 };
  const repulsorsProxy = { v: 0 };

  const applyCamera = () => {
    camera.position.set(
      cameraProxy.x + shake.x,
      cameraProxy.y + shake.y,
      cameraProxy.z + shake.z,
    );
    lookTarget.set(cameraProxy.lx, cameraProxy.ly, cameraProxy.lz);
    camera.lookAt(lookTarget);
  };

  /** Suit emissive only — scene lights stay constant. */
  const syncSystems = () => {
    suit.setSystemsPower({
      reactor: reactorProxy.v,
      eyes: eyesProxy.v,
      repulsors: repulsorsProxy.v,
    });
  };

  /**
   * Short punchy camera shake when a wave’s last plate clamps.
   * Stronger for torso / helmet so those beats land harder.
   */
  const addWaveShake = (
    timeline: gsap.core.Timeline,
    at: number,
    wave: string,
  ) => {
    const amp = WAVE_SHAKE[wave];
    if (!amp) return;

    const pulses = wave === 'helmet' || wave === 'torso' ? 4 : 3;
    const step = 0.028;
    for (let i = 0; i < pulses; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      const decay = 1 - i / (pulses + 0.5);
      timeline.to(
        shake,
        {
          x: sign * amp * decay,
          y: -sign * amp * 0.55 * decay,
          z: sign * amp * 0.35 * decay,
          duration: step,
          ease: 'power2.out',
          onUpdate: applyCamera,
        },
        at + i * step,
      );
    }
    timeline.to(
      shake,
      {
        x: 0,
        y: 0,
        z: 0,
        duration: 0.06,
        ease: 'power3.out',
        onUpdate: applyCamera,
      },
      at + pulses * step,
    );
  };

  const build = (): gsap.core.Timeline => {
    suit.resetToStart();
    reactorProxy.v = 0;
    eyesProxy.v = 0;
    repulsorsProxy.v = 0;
    shake.x = 0;
    shake.y = 0;
    shake.z = 0;
    motionSpans = [];

    // Opening camera — closer for detail
    cameraProxy.x = 1.85;
    cameraProxy.y = 1.35;
    cameraProxy.z = 4.15;
    cameraProxy.lx = 0;
    cameraProxy.ly = 0.95;
    cameraProxy.lz = 0;
    applyCamera();

    const timeline = gsap.timeline({
      paused: true,
      onUpdate: () => {
        callbacks.onProgress?.(timeline.progress());
        reportActivePieces(timeline.time());
      },
      onComplete: () => {
        playing = false;
        callbacks.onStatus?.('SYSTEMS ONLINE');
        callbacks.onActivePieces?.([]);
        callbacks.onComplete?.();
      },
    });

    timeline.call(() => {
      callbacks.onStatus?.('ASSEMBLY SEQUENCE INITIATED');
    }, undefined, 0);

    /** When each wave's last plate finishes locking */
    const waveLockEnd: Partial<Record<string, number>> = {};
    /** Actual scheduled start per wave (after foundation gating) */
    const waveStartAt: Partial<Record<string, number>> = {};
    /**
     * All plates from completed waves — foundation stumps are selected
     * per-wave (arms←shoulders only, helmet←collar, never gauntlets).
     */
    let built: typeof suit.pieces = [];

    let prevLockEnd = 0;
    /** When the previous wave’s last plate *launched* (not locked). */
    let prevLastLaunch = 0;
    let prevWave: string | null = null;

    for (const wave of WAVE_ORDER) {
      const { ordered: pieces } = suit.planWave(wave, built);
      // Hands fold into the arm wave; skip empty bands (e.g. gauntlets).
      if (pieces.length === 0 && wave !== 'power') {
        waveLockEnd[wave] = prevLockEnd;
        waveStartAt[wave] = prevLockEnd;
        continue;
      }

      const earliest = WAVE_EARLIEST[wave] ?? 0;
      // Chain off previous last *launch* so there’s no ~0.7s dead air while
      // the final plates of a section are still mid-flight.
      const afterPrev =
        prevWave != null ? prevLastLaunch + WAVE_CHAIN_GAP : 0;
      const waveStart = Math.max(earliest, afterPrev);
      waveStartAt[wave] = waveStart;

      const isHelmet = wave === 'helmet';
      const duration = isHelmet ? HELMET_PIECE_DURATION : PIECE_DURATION;
      // Paired L/R launches: stagger between *pairs*, not individual plates
      const launchGroups = planSymmetricLaunchGroups(pieces, wave);
      // Mirror scatter starts so paths can be geometric L↔R reflections
      applyMirroredFlightStarts(launchGroups);
      const stagger = staggerFor(launchGroups.length, isHelmet);
      const approachFrac = isHelmet ? HELMET_APPROACH_FRAC : APPROACH_FRAC;

      timeline.call(
        () => {
          callbacks.onWave?.(wave);
          callbacks.onStatus?.(WAVE_STATUS[wave]);
        },
        undefined,
        waveStart,
      );

      let lastEnd = waveStart;
      let lastLaunch = waveStart;

      launchGroups.forEach((group, groupIndex) => {
        const t = waveStart + groupIndex * stagger;
        lastLaunch = t;
        lastEnd = t + duration;

        // Shared seed path on the left (lower rest X), then mirror for partner
        const leftOfPair =
          group.length === 2
            ? group[0].restPosition.x <= group[1].restPosition.x
              ? group[0]
              : group[1]
            : null;
        const primaryPath =
          leftOfPair != null
            ? magneticPath(
                leftOfPair.startPosition,
                leftOfPair.restPosition,
                leftOfPair.id,
                { helmet: isHelmet },
              )
            : null;

        for (const piece of group) {
          const mesh = piece.mesh;
          motionSpans.push({
            id: piece.id,
            wave,
            start: t,
            end: t + duration,
          });

          const path: MagneticPath =
            leftOfPair != null && primaryPath != null
              ? piece.id === leftOfPair.id
                ? primaryPath
                : mirrorPathAroundRest(
                    primaryPath,
                    leftOfPair.restPosition,
                    piece.restPosition,
                  )
              : magneticPath(
                  piece.startPosition,
                  piece.restPosition,
                  piece.id,
                  { helmet: isHelmet },
                );

          const approachDur = duration * approachFrac;
          const dockDur = duration - approachDur;
          // Split dock: soft overshoot, then settle into socket
          const slamDur = dockDur * (isHelmet ? 0.55 : 0.45);
          const settleDur = dockDur - slamDur;

          // Explicit false at t=0 so reverse scrub restores hidden state
          // (GSAP set() alone does not reliably reverse booleans).
          timeline.set(mesh, { visible: false }, 0);
          timeline.set(mesh, { visible: true }, t);

          // ── Position: magnetic arc → approach → overshoot → rest ──
          // Phase 1a: fly toward curved waypoint (magnetic pull-in)
          const midApproach = approachDur * 0.62;
          const nearApproach = approachDur - midApproach;

          timeline.fromTo(
            mesh.position,
            {
              x: piece.startPosition.x,
              y: piece.startPosition.y,
              z: piece.startPosition.z,
            },
            {
              x: path.waypoint.x,
              y: path.waypoint.y,
              z: path.waypoint.z,
              duration: midApproach,
              ease: isHelmet ? 'power2.inOut' : 'power2.in',
            },
            t,
          );

          // Phase 1b: curve into the near-socket approach point
          timeline.to(
            mesh.position,
            {
              x: path.approach.x,
              y: path.approach.y,
              z: path.approach.z,
              duration: nearApproach,
              ease: isHelmet ? 'power3.inOut' : 'power3.in',
            },
            t + midApproach,
          );

          // Phase 2a: soft overshoot past the socket
          timeline.to(
            mesh.position,
            {
              x: path.overshoot.x,
              y: path.overshoot.y,
              z: path.overshoot.z,
              duration: slamDur,
              ease: isHelmet ? 'power2.in' : 'power2.in',
            },
            t + approachDur,
          );

          // Phase 2b: clamp settle into rest
          timeline.to(
            mesh.position,
            {
              x: piece.restPosition.x,
              y: piece.restPosition.y,
              z: piece.restPosition.z,
              duration: settleDur,
              ease: 'power3.out',
            },
            t + approachDur + slamDur,
          );

          // ── Rotation: mostly during approach, final align on dock ──
          const travelEase = isHelmet ? 'power3.inOut' : 'power2.inOut';
          timeline.fromTo(
            mesh.rotation,
            {
              x: piece.startRotation.x,
              y: piece.startRotation.y,
              z: piece.startRotation.z,
            },
            {
              x: piece.restRotation.x,
              y: piece.restRotation.y,
              z: piece.restRotation.z,
              duration: approachDur + slamDur * 0.5,
              ease: travelEase,
            },
            t,
          );

          // ── Scale: grow on approach, light clamp seat on lock ─────
          const rs = piece.restScale;
          const preLock = isHelmet ? 0.985 : 0.96;
          const punch = isHelmet ? 1.008 : 1.02;

          // Grow from tiny scatter scale → near rest during approach
          timeline.fromTo(
            mesh.scale,
            {
              x: piece.startScale.x,
              y: piece.startScale.y,
              z: piece.startScale.z,
            },
            {
              x: rs.x * preLock,
              y: rs.y * preLock,
              z: rs.z * preLock,
              duration: approachDur,
              ease: isHelmet ? 'power2.inOut' : 'power2.out',
            },
            t,
          );

          // Lock impact: slight punch past rest scale, then seat
          timeline.to(
            mesh.scale,
            {
              x: rs.x * punch,
              y: rs.y * punch,
              z: rs.z * punch,
              duration: slamDur,
              ease: 'power2.in',
            },
            t + approachDur,
          );
          timeline.to(
            mesh.scale,
            {
              x: rs.x,
              y: rs.y,
              z: rs.z,
              duration: settleDur,
              ease: 'power4.out',
            },
            t + approachDur + slamDur,
          );
        }
      });

      waveLockEnd[wave] = lastEnd;
      prevLockEnd = lastEnd;
      prevLastLaunch = lastLaunch;
      prevWave = wave;
      // Accumulate built structure for later foundation selection
      if (pieces.length > 0) {
        built = built.concat(pieces);
        // Shake when the last plate of this wave clamps home
        addWaveShake(timeline, lastEnd - 0.02, wave);
      }
    }

    // ── Sequenced systems ──────────────────────────────────────────
    // Keep the arc reactor COLD until every armor plate has locked —
    // including the helmet. Igniting after shoulders left the chest
    // glowing while helmet shards were still mid-flight (73% scrub).
    const helmetDone = waveLockEnd.helmet ?? 16.0;
    const torsoDone = waveLockEnd.torso ?? 7.2;
    const armorDone = Math.max(
      torsoDone,
      waveLockEnd.shoulders ?? 9.5,
      waveLockEnd.gauntlets ?? 12.5,
      helmetDone,
    );
    const reactorT = armorDone + 0.4;
    timeline.call(
      () => {
        callbacks.onStatus?.('ARC REACTOR IGNITION…');
      },
      undefined,
      reactorT,
    );
    timeline.to(
      reactorProxy,
      {
        v: 1,
        duration: 1.45,
        ease: 'power2.inOut',
        onUpdate: syncSystems,
      },
      reactorT,
    );
    timeline.call(
      () => {
        callbacks.onStatus?.('ARC REACTOR ONLINE');
      },
      undefined,
      reactorT + 1.3,
    );

    // Hand & foot repulsors after gauntlets clamp (still before helmet)
    const handsT = (waveLockEnd.gauntlets ?? 12.5) + 0.1;
    timeline.to(
      repulsorsProxy,
      {
        v: 1,
        duration: 0.85,
        ease: 'power2.out',
        onUpdate: syncSystems,
      },
      handsT,
    );

    // Face-mask eyes after reactor comes online (helmet already sealed)
    const eyesT = reactorT + 1.0;
    timeline.call(
      () => {
        callbacks.onStatus?.('HELMET SEALED — HUD ONLINE…');
      },
      undefined,
      eyesT,
    );
    timeline.to(
      eyesProxy,
      {
        v: 1,
        duration: 1.55,
        ease: 'power2.inOut',
        onUpdate: syncSystems,
      },
      eyesT,
    );

    // Seamless mesh once head systems are lit
    finalSwapTime = eyesT + 1.2;
    timeline.call(
      () => {
        suit.showFinal();
        callbacks.onStatus?.('ARMOR LOCKED');
      },
      undefined,
      finalSwapTime,
    );

    timeline.call(
      () => {
        callbacks.onStatus?.('SYSTEMS ONLINE');
      },
      undefined,
      eyesT + 1.9,
    );

    // ── Camera path ────────────────────────────────────────────────
    timeline.to(
      cameraProxy,
      {
        x: 0.9,
        y: 0.95,
        z: 3.15,
        ly: 0.75,
        duration: 4.2,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      0.3,
    );

    // Slow push-in on the helmet / faceplate beat (reactor still dark)
    timeline.to(
      cameraProxy,
      {
        x: 0.22,
        y: 1.48,
        z: 2.15,
        ly: 1.55,
        lx: 0,
        duration: 3.4,
        ease: 'power3.inOut',
        onUpdate: applyCamera,
      },
      (waveStartAt.helmet ?? WAVE_EARLIEST.helmet ?? 13.2) - 0.4,
    );

    // Favor chest as the reactor ignites (after every plate is home)
    timeline.to(
      cameraProxy,
      {
        x: 0.45,
        y: 1.25,
        z: 2.55,
        ly: 1.22,
        lx: 0,
        duration: 2.2,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      reactorT - 0.55,
    );

    // Hold on the eyes a moment, then pull back to hero
    timeline.to(
      cameraProxy,
      {
        x: 1.15,
        y: 1.2,
        z: 3.35,
        lx: 0,
        ly: 0.95,
        lz: 0,
        duration: 3.2,
        ease: 'power3.inOut',
        onUpdate: applyCamera,
      },
      eyesT + 1.4,
    );

    return timeline;
  };

  const ensureTl = () => {
    if (!tl) tl = build();
    return tl;
  };

  const syncAfterSeek = (progress01: number) => {
    const timeline = ensureTl();
    const p = THREE.MathUtils.clamp(progress01, 0, 1);
    const dur = Math.max(timeline.duration(), 1e-6);
    const t = p * dur;

    // Suppress call()/onComplete — we own final-mesh swap + status while scrubbing.
    if (t >= finalSwapTime - 1e-4 || p >= 0.999) {
      timeline.progress(p, true);
      applyCamera();
      syncSystems();
      suit.showFinal();
    } else {
      // Leaving seamless / end state: showFinal() forced every shard
      // invisible outside GSAP. Re-seed start pose + visible:false, then
      // progress 0 → p so reverse scrub re-applies every fromTo/set.
      suit.resumeAssemblyVisuals();
      for (const piece of suit.pieces) {
        const mesh = piece.mesh;
        mesh.visible = false;
        mesh.position.copy(piece.startPosition);
        mesh.rotation.copy(piece.startRotation);
        mesh.scale.copy(piece.startScale);
      }
      // Invalidate cached start values so the next render samples cleanly
      timeline.progress(0, true);
      timeline.progress(p, true);
      applyCamera();
      syncSystems();
    }

    callbacks.onProgress?.(p);
    reportActivePieces(t);
  };

  tl = build();

  return {
    play: () => {
      const timeline = ensureTl();
      playing = true;
      timeline.play(0);
    },
    pause: () => {
      const timeline = ensureTl();
      timeline.pause();
      playing = false;
    },
    resume: () => {
      const timeline = ensureTl();
      if (timeline.progress() >= 1) {
        // At end — restart so resume always does something useful
        playing = true;
        timeline.play(0);
        return;
      }
      playing = true;
      timeline.paused(false);
      timeline.play();
    },
    seek: (progress01: number) => {
      const timeline = ensureTl();
      timeline.pause();
      playing = false;
      syncAfterSeek(progress01);
    },
    getProgress: () => {
      if (!tl) return 0;
      return tl.progress();
    },
    getDuration: () => {
      if (!tl) return 0;
      return tl.duration();
    },
    kill: () => {
      tl?.kill();
      tl = null;
      playing = false;
    },
    isPlaying: () => playing && !!tl && !tl.paused() && tl.progress() < 1,
    isPaused: () => !!tl && (tl.paused() || !playing),
    rebuild: () => {
      tl?.kill();
      tl = build();
      playing = false;
    },
  };
}
