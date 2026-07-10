import gsap from 'gsap';
import * as THREE from 'three';
import type { Suit } from '../suit/Suit';
import { WAVE_ORDER, WAVE_STATUS } from '../suit/createPieces';
import { magneticPath } from '../utils/easeHelpers';

export interface TimelineCallbacks {
  onStatus?: (text: string) => void;
  onProgress?: (t: number) => void;
  onComplete?: () => void;
  onWave?: (wave: string) => void;
}

export interface AssemblyController {
  play: () => void;
  kill: () => void;
  isPlaying: () => boolean;
  rebuild: () => void;
}

/**
 * Mark III bottom→top timing — deliberate suit-up with a slower helmet
 * close (movie faceplate beat) and sequenced systems ignition.
 *
 * These are *earliest* start times. Actual start is also gated so each wave
 * waits until the previous wave is mostly locked — plates always have
 * something physical to clamp onto.
 */
const WAVE_EARLIEST: Record<string, number> = {
  boots: 0.5,
  calves: 1.75,
  thighs: 3.25,
  hips: 4.7,
  torso: 6.15,
  shoulders: 8.7,
  arms: 10.5,
  gauntlets: 12.3,
  // Extra pause before the helmet — faceplate is the hero beat
  helmet: 14.7,
  power: 19.5,
};

/**
 * How early the next wave may begin before the previous wave’s last plate
 * finishes locking. Small overlap keeps the suit-up fluid.
 */
const WAVE_OVERLAP = 0.28;

/**
 * Per-wave overlap override. Extremities need the prior stump fully locked
 * (hands must wait for arms) — use 0 so the next wave cannot start early.
 */
const WAVE_OVERLAP_AFTER: Partial<Record<string, number>> = {
  shoulders: 0.12,
  arms: 0,
  gauntlets: 0,
};

/** Extra hold after a wave before the next may start (helmet hero beat). */
const WAVE_PAD_AFTER: Partial<Record<string, number>> = {
  arms: 0.12,
  gauntlets: 0.35,
  helmet: 0.15,
};

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

/** Default plate travel */
const PIECE_DURATION = 1.35;
/** Helmet / faceplate — heavier, more movie-like hydraulic close */
const HELMET_PIECE_DURATION = 2.25;

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

  const staggerFor = (count: number, helmet = false) => {
    if (count <= 1) return 0;
    if (helmet) {
      // Wider gaps so each head plate reads as a separate clamp
      return Math.min(0.32, Math.max(0.1, 1.85 / count));
    }
    return Math.min(0.24, Math.max(0.055, 1.45 / count));
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
      },
      onComplete: () => {
        playing = false;
        callbacks.onStatus?.('SYSTEMS ONLINE');
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
      // Don't start a region until the previous one is almost locked —
      // collar / shoulders / hands can't float before their stump exists.
      const overlap =
        prevWave != null
          ? (WAVE_OVERLAP_AFTER[prevWave] ?? WAVE_OVERLAP)
          : WAVE_OVERLAP;
      const afterPrev =
        prevLockEnd > 0
          ? prevLockEnd - overlap + (WAVE_PAD_AFTER[prevWave ?? ''] ?? 0)
          : 0;
      const waveStart = Math.max(earliest, afterPrev);
      waveStartAt[wave] = waveStart;

      const isHelmet = wave === 'helmet';
      const duration = isHelmet ? HELMET_PIECE_DURATION : PIECE_DURATION;
      const stagger = staggerFor(pieces.length, isHelmet);
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

      pieces.forEach((piece, i) => {
        const t = waveStart + i * stagger;
        const mesh = piece.mesh;
        lastEnd = t + duration;

        const path = magneticPath(
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
      });

      waveLockEnd[wave] = lastEnd;
      prevLockEnd = lastEnd;
      prevWave = wave;
      // Accumulate built structure for later foundation selection
      if (pieces.length > 0) {
        built = built.concat(pieces);
        // Shake when the last plate of this wave clamps home
        addWaveShake(timeline, lastEnd - 0.02, wave);
      }
    }

    // ── Sequenced systems ──────────────────────────────────────────
    // Arc reactor after torso + shoulders are fully locked (chest reads complete)
    // — same “wait for the plates” idea as the faceplate/eyes beat.
    const chestLocked = Math.max(
      waveLockEnd.torso ?? 7.2,
      waveLockEnd.shoulders ?? 9.5,
    );
    const reactorT = chestLocked + 0.45;
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

    // Hand & foot repulsors after gauntlets clamp
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

    // Face-mask eyes after helmet seals (slower, dramatic)
    const eyesT = (waveLockEnd.helmet ?? 16.0) + 0.28;
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
    timeline.call(
      () => {
        suit.showFinal();
        callbacks.onStatus?.('ARMOR LOCKED');
      },
      undefined,
      eyesT + 1.2,
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

    // Favor chest as shoulders lock and reactor ignites
    timeline.to(
      cameraProxy,
      {
        x: 0.45,
        y: 1.25,
        z: 2.55,
        ly: 1.22,
        lx: 0,
        duration: 2.6,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      reactorT - 1.0,
    );

    // Slow push-in on the helmet / faceplate beat
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

  tl = build();

  return {
    play: () => {
      if (!tl) tl = build();
      playing = true;
      tl.play(0);
    },
    kill: () => {
      tl?.kill();
      tl = null;
      playing = false;
    },
    isPlaying: () => playing,
    rebuild: () => {
      tl?.kill();
      tl = build();
      playing = false;
    },
  };
}
