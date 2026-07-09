import gsap from 'gsap';
import * as THREE from 'three';
import type { SceneLights } from '../scene/createLights';
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

/** Mark III bottom→top timing: legs → torso → arms → helmet → power */
const WAVE_START: Record<string, number> = {
  boots: 0.3,
  calves: 1.1,
  thighs: 1.9,
  hips: 2.7,
  torso: 3.5,
  shoulders: 4.6,
  arms: 5.5,
  gauntlets: 6.5,
  helmet: 7.6,
  power: 8.8,
};

const PIECE_DURATION = 0.7;

export function createAssemblyTimeline(
  suit: Suit,
  camera: THREE.PerspectiveCamera,
  lights: SceneLights,
  lookTarget: THREE.Vector3,
  callbacks: TimelineCallbacks = {},
): AssemblyController {
  let tl: gsap.core.Timeline | null = null;
  let playing = false;

  /** Keep total assembly ~10–12s even with many GLB shards. */
  const staggerFor = (count: number) => {
    if (count <= 1) return 0;
    return Math.min(0.14, Math.max(0.02, 0.9 / count));
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
    lights.reactor.intensity = 0;

    // Opening camera
    cameraProxy.x = 2.8;
    cameraProxy.y = 1.6;
    cameraProxy.z = 5.8;
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
            ease: 'power3.out',
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
            ease: 'power2.out',
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
            duration: PIECE_DURATION * 0.9,
            ease: 'back.out(1.6)',
          },
          t,
        );

        // Lock punch
        timeline.to(
          mesh.scale,
          {
            x: piece.restScale.x * 1.06,
            y: piece.restScale.y * 1.06,
            z: piece.restScale.z * 1.06,
            duration: 0.08,
            yoyo: true,
            repeat: 1,
            ease: 'power1.inOut',
          },
          t + PIECE_DURATION * 0.92,
        );
      });
    }

    // Camera path
    timeline.to(
      cameraProxy,
      {
        x: 1.2,
        y: 1.1,
        z: 4.2,
        ly: 0.85,
        duration: 2.8,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      0.2,
    );

    timeline.to(
      cameraProxy,
      {
        x: -0.6,
        y: 1.35,
        z: 3.4,
        ly: 1.15,
        duration: 2.4,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      3.2,
    );

    // Hero close on chest / reactor
    timeline.to(
      cameraProxy,
      {
        x: 0.35,
        y: 1.3,
        z: 2.35,
        ly: 1.25,
        lx: 0,
        duration: 1.8,
        ease: 'power2.inOut',
        onUpdate: applyCamera,
      },
      7.2,
    );

    // Swap to seamless mesh before power-up so glow isn't grid-shaped
    timeline.call(
      () => {
        suit.showFinal();
        callbacks.onStatus?.('ARMOR LOCKED');
      },
      undefined,
      8.6,
    );

    // Power-up — reactor point light only (no full-body emissive squares)
    timeline.to(
      powerProxy,
      {
        v: 1,
        duration: 1.4,
        ease: 'power2.out',
        onUpdate: () => {
          suit.setPowered(powerProxy.v);
          lights.reactor.intensity = powerProxy.v * 4.5;
        },
      },
      8.9,
    );

    timeline.call(
      () => {
        callbacks.onStatus?.('ARC REACTOR STABLE');
      },
      undefined,
      9.6,
    );

    // Pull back to hero presentation
    timeline.to(
      cameraProxy,
      {
        x: 1.8,
        y: 1.45,
        z: 4.6,
        lx: 0,
        ly: 1.0,
        lz: 0,
        duration: 2.2,
        ease: 'power3.inOut',
        onUpdate: applyCamera,
      },
      10.2,
    );

    timeline.call(
      () => {
        callbacks.onStatus?.('SYSTEMS ONLINE');
      },
      undefined,
      11.6,
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
