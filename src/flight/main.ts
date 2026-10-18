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
  const screens = new Screens();
  screens.progress(0.02, 'J.A.R.V.I.S. // FLIGHT SYSTEMS');
  const app = new FlightApp({
    canvas: document.getElementById('flight-canvas') as HTMLCanvasElement,
    hudCanvas: document.getElementById('flight-hud') as HTMLCanvasElement,
    screens,
    progress: (p, line) => screens.progress(p, line),
  });
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
    (window as unknown as Record<string, unknown>).__capture = {
      frame: () => {
        app.frame(captureDt);
        frameNo++;
        return { frame: frameNo, phase: director.phase, done: director.tail > 1.5 };
      },
      log: () => log,
      state: () => ({ phase: director.phase, pos: game.model.pos.toArray(), speed: game.model.speed }),
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
