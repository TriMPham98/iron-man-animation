import * as THREE from 'three';
import { FlightApp } from './app';
import { Screens } from './ui/screens';

/**
 * flight.html on its own: the boot screen while the world builds, then the
 * title over the suit on the pad. (From the workshop the same FlightApp is
 * built in the background and flown into without a load — src/transition.)
 */
async function boot(): Promise<void> {
  // A captured reel is repeatable: one seeded random stream for everything
  if (new URLSearchParams(location.search).has('capture')) {
    let seed = 0x9e3779b9;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const q = new URLSearchParams(location.search);
  const screens = new Screens();
  screens.progress(0.02, 'J.A.R.V.I.S. // FLIGHT SYSTEMS');
  const app = new FlightApp({
    canvas: document.getElementById('flight-canvas') as HTMLCanvasElement,
    hudCanvas: document.getElementById('flight-hud') as HTMLCanvasElement,
    screens,
    progress: (p, line) => screens.progress(p, line),
    pixelRatio: q.has('dpr') ? Number(q.get('dpr')) : undefined,
  });
  // A capture's sound is the sim's own mix, rendered offline in step with
  // the frames (each frame renders exactly its slice of audio, then waits)
  const SR = 48000;
  const offline = q.has('capture') ? new OfflineAudioContext({ numberOfChannels: 2, sampleRate: SR, length: SR * Number(q.get('seconds') ?? 150) }) : null;
  if (offline) app.audio.makeContext = () => offline;
  await app.build();
  (window as unknown as Record<string, unknown>).__flight = app.hooks();

  // Under the boot screen: every program compiled (in parallel), every
  // texture uploaded, every draw's pipeline built and a few frames settled,
  // so the title's first frame is a steady one
  screens.progress(0.75, 'WARMING · SHADERS + PIPELINES');
  await app.warm(3);
  screens.progress(0.95);
  await app.audioReady;
  screens.progress(1, 'SYSTEMS NOMINAL');

  const capture = app.query.has('capture');
  if (capture) {
    // Frame-stepped capture: the page renders one frame per call and hands
    // back everything that happened on it (the sound layer is cued from this)
    screens.hideTitle();
    const director = app.director!;
    const { game, camera } = app;
    const captureDt = 1 / Number(app.query.get('fps') ?? 30);
    const log: Array<Record<string, unknown>> = [];
    let frameNo = 0;
    const right = new THREE.Vector3();
    game.events.on((e) => {
      const entry: Record<string, unknown> = { frame: frameNo, t: +(frameNo * captureDt).toFixed(4), kind: e.kind, value: e.value, side: e.side, text: e.text };
      if (e.at) {
        const rel = e.at.clone().sub(camera.position);
        right.set(1, 0, 0).applyQuaternion(camera.quaternion);
        entry.dist = +rel.length().toFixed(1);
        entry.pan = +(rel.normalize().dot(right)).toFixed(3);
      }
      log.push(entry);
    });
    await app.audio.unlock();
    app.sounds.start();
    // Suspend points sit on render-quantum boundaries (128 samples)
    const quantum = (n: number) => (Math.floor((n * captureDt * SR) / 128) * 128) / SR;
    let rendering: Promise<AudioBuffer> | null = null;
    let mixed: AudioBuffer | null = null;
    (window as unknown as Record<string, unknown>).__capture = {
      frame: async () => {
        app.frame(captureDt);
        frameNo++;
        const ctx = offline!;
        const at = ctx.suspend(quantum(frameNo));
        if (!rendering) rendering = ctx.startRendering();
        else void ctx.resume();
        await at;
        return { frame: frameNo, phase: director.phase, done: director.tail > 1.5 };
      },
      /** Renders out the rest of the buffer; the sound of every frame so far. */
      finish: async () => {
        void offline!.resume();
        mixed = await rendering!;
        return { seconds: frameNo * captureDt, sampleRate: SR };
      },
      /** One channel's samples [from, to) (s) as base64 float32 (chunked: CDP messages have a ceiling). */
      audio: (ch: number, from: number, to: number) => {
        const data = mixed!.getChannelData(ch).subarray(Math.round(from * SR), Math.round(to * SR));
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      },
      log: () => log,
      state: () => ({ phase: director.phase, pos: game.model.pos.toArray(), speed: game.model.speed, armor: +game.combat.armor.toFixed(2), alt: +game.model.pos.y.toFixed(1), cam: game.rig.mode, assist: (game.combat.weapons.assist as { label?: string } | null)?.label ?? null, ships: game.combat.ships.map((f) => ({ pos: f.pos.toArray(), parts: f.parts.map((p) => `${p.role}:${Math.round(p.hp)}`), sinking: f.sinking })) }),
    };
  } else {
    app.start();
  }

  screens.showTitle(() => app.engage(), app.engaged);
  app.bindPointerLock();
}

boot().catch((e) => {
  console.error(e);
  const lines = document.querySelector('#flight-ui .boot .lines');
  if (lines) lines.innerHTML += '<div style="color:#ff6a5a">FAILED TO INIT — SEE CONSOLE</div>';
});
