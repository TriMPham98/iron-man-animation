import gsap from 'gsap';
import * as THREE from 'three';
import { setSystemsPower, type SceneLights } from '../scene/createLights';
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
 * Mark III bottom→top timing — slowed for a more mechanical, deliberate suit-up.
 * Total sequence ≈ 18–20s (was ~12s).
 */
const WAVE_START: Record<string, number> = {
  boots: 0.45,
  calves: 1.7,
  thighs: 3.1,
  hips: 4.5,
  torso: 5.8,
  shoulders: 7.6,
  arms: 9.1,
  gauntlets: 10.8,
  helmet: 12.6,
  power: 14.4,
};

/** Longer plate travel = heavier, more mechanical feel */
const PIECE_DURATION = 1.15;

export function createAssemblyTimeline(
  suit: Suit,
  camera: THREE.PerspectiveCamera,
  lights: SceneLights,
  lookTarget: THREE.Vector3,
  callbacks: TimelineCallbacks = {},
): AssemblyController {
  let tl: gsap.core.Timeline | null = null;
  let playing = false;

  /** Wider spacing between plate locks for clank readability */
  const staggerFor = (count: number) => {
    if (count <= 1) return 0;
    // Aim ~1.1–1.4s of stagger window per wave, clamp per-piece delay
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

  const powerProxy = { v: 0 };

  const applyCamera = () => {
    camera.position.set(cameraProxy.x, cameraProxy.y, cameraProxy.z);
    lookTarget.set(cameraProxy.lx, cameraProxy.ly, cameraProxy.lz);
    camera.lookAt(lookTarget);
  };

  const build = (): gsap.core.Timeline => {
    suit.resetToStart();
    powerProxy.v = 0;
    setSystemsPower(lights, 0);

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

    for (const wave of WAVE_ORDER) {
      const pieces = suit.piecesInWave(wave);
      const waveStart = WAVE_START[wave] ?? 0;

      timeline.call(
        () => {
          callbacks.onWave?.(wave);
          callbacks.onStatus?.(WAVE_STATUS[wave]);
        },
        undefined,
        waveStart,
      );

      const stagger = staggerFor(pieces.length);

      pieces.forEach((piece, i) => {
        const t = waveStart + i * stagger;
        const mesh = piece.mesh;

        timeline.set(mesh, { visible: true }, t);

        // Slightly heavier eases — less snappy, more hydraulic
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
            duration: PIECE_DURATION,
            ease: 'power2.inOut',
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
            duration: PIECE_DURATION,
            ease: 'power2.inOut',
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
            duration: PIECE_DURATION * 0.95,
            ease: 'back.out(1.25)',
          },
          t,
        );

        // Lock punch — slightly slower, more weight
        timeline.to(
          mesh.scale,
          {
            x: piece.restScale.x * 1.05,
            y: piece.restScale.y * 1.05,
            z: piece.restScale.z * 1.05,
            duration: 0.1,
            yoyo: true,
            repeat: 1,
            ease: 'power1.inOut',
          },
          t + PIECE_DURATION * 0.94,
        );
      });
    }

    // Camera path — closer orbit / hero shots (synced to slower waves)
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

    timeline.to(
      cameraProxy,
      {
        x: -0.55,
        y: 1.2,
        z: 2.65,
        ly: 1.1,
        duration: 3.6,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      5.2,
    );

    // Bust / reactor hero shot — close, but pulled back enough to keep the head in frame
    timeline.to(
      cameraProxy,
      {
        x: 0.32,
        y: 1.38,
        z: 2.35,
        ly: 1.38,
        lx: 0,
        duration: 2.8,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      11.8,
    );

    // Swap to seamless mesh before power-up
    timeline.call(
      () => {
        suit.showFinal();
        callbacks.onStatus?.('ARMOR LOCKED');
      },
      undefined,
      14.0,
    );

    // Ignite arc reactor, face-mask eyes, hand & foot repulsors
    timeline.to(
      powerProxy,
      {
        v: 1,
        duration: 2.0,
        ease: 'power2.out',
        onUpdate: () => {
          suit.setPowered(powerProxy.v);
          setSystemsPower(lights, powerProxy.v);
        },
      },
      14.4,
    );

    timeline.call(
      () => {
        callbacks.onStatus?.('ARC REACTOR STABLE');
      },
      undefined,
      15.6,
    );

    // Pull back to hero presentation — still closer than before
    timeline.to(
      cameraProxy,
      {
        x: 1.15,
        y: 1.2,
        z: 3.35,
        lx: 0,
        ly: 0.95,
        lz: 0,
        duration: 3.0,
        ease: 'power3.inOut',
        onUpdate: applyCamera,
      },
      16.2,
    );

    timeline.call(
      () => {
        callbacks.onStatus?.('SYSTEMS ONLINE');
      },
      undefined,
      18.4,
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
