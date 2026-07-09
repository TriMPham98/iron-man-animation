import gsap from 'gsap';
import * as THREE from 'three';
import type { Suit } from '../suit/Suit';
import { WAVE_ORDER, WAVE_STATUS } from '../suit/createPieces';

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
 */
const WAVE_START: Record<string, number> = {
  boots: 0.45,
  calves: 1.7,
  thighs: 3.1,
  hips: 4.5,
  torso: 5.8,
  shoulders: 8.2,
  arms: 9.8,
  gauntlets: 11.5,
  // Extra pause before the helmet — faceplate is the hero beat
  helmet: 13.6,
  power: 18.2,
};

/** Default plate travel */
const PIECE_DURATION = 1.15;
/** Helmet / faceplate — heavier, more movie-like hydraulic close */
const HELMET_PIECE_DURATION = 1.95;

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
      return Math.min(0.28, Math.max(0.08, 1.6 / count));
    }
    return Math.min(0.2, Math.max(0.045, 1.25 / count));
  };

  const cameraProxy = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    lx: lookTarget.x,
    ly: lookTarget.y,
    lz: lookTarget.z,
  };

  // Independent system ramps
  const reactorProxy = { v: 0 };
  const eyesProxy = { v: 0 };
  const repulsorsProxy = { v: 0 };

  const applyCamera = () => {
    camera.position.set(cameraProxy.x, cameraProxy.y, cameraProxy.z);
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

  const build = (): gsap.core.Timeline => {
    suit.resetToStart();
    reactorProxy.v = 0;
    eyesProxy.v = 0;
    repulsorsProxy.v = 0;

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

    for (const wave of WAVE_ORDER) {
      const pieces = suit.piecesInWave(wave);
      const waveStart = WAVE_START[wave] ?? 0;
      const isHelmet = wave === 'helmet';
      const duration = isHelmet ? HELMET_PIECE_DURATION : PIECE_DURATION;
      const stagger = staggerFor(pieces.length, isHelmet);

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

        timeline.set(mesh, { visible: true }, t);

        const ease = isHelmet ? 'power3.inOut' : 'power2.inOut';
        const scaleEase = isHelmet ? 'power2.out' : 'back.out(1.25)';

        timeline.fromTo(
          mesh.position,
          {
            x: piece.startPosition.x,
            y: piece.startPosition.y,
            z: piece.startPosition.z,
          },
          {
            x: piece.restPosition.x,
            y: piece.restPosition.y,
            z: piece.restPosition.z,
            duration,
            ease,
          },
          t,
        );

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
            duration,
            ease,
          },
          t,
        );

        timeline.fromTo(
          mesh.scale,
          {
            x: piece.startScale.x,
            y: piece.startScale.y,
            z: piece.startScale.z,
          },
          {
            x: piece.restScale.x,
            y: piece.restScale.y,
            z: piece.restScale.z,
            duration: duration * (isHelmet ? 0.98 : 0.95),
            ease: scaleEase,
          },
          t,
        );

        // Lock punch — softer / longer on helmet
        timeline.to(
          mesh.scale,
          {
            x: piece.restScale.x * (isHelmet ? 1.03 : 1.05),
            y: piece.restScale.y * (isHelmet ? 1.03 : 1.05),
            z: piece.restScale.z * (isHelmet ? 1.03 : 1.05),
            duration: isHelmet ? 0.14 : 0.1,
            yoyo: true,
            repeat: 1,
            ease: 'power1.inOut',
          },
          t + duration * 0.94,
        );
      });

      waveLockEnd[wave] = lastEnd;
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
      (WAVE_START.helmet ?? 13.6) - 0.4,
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
