import type * as THREE from 'three';
import type { FlightApp } from '../app';
import type { Quality, Settings } from './screens';

/**
 * Wires the pause menu into a built FlightApp (one call from
 * FlightApp.build): the menu's buttons drive the sim, the audio sliders set
 * the mix and the graphics preset caps the resolution.
 */

/** Ceiling on the drawing-buffer pixel ratio per preset (on top of the adaptive guard). */
export const QUALITY_DPR: Record<Quality, number> = { low: 0.7, medium: 1, high: 1.25, ultra: Infinity };

export function bindFlightSettings(app: FlightApp): void {
  const { screens, game, audio, renderer } = app;
  // ── Graphics preset: cap whatever the adaptive resolution asks for ──
  let cap = Infinity;
  const setPixelRatio = renderer.setPixelRatio.bind(renderer);
  renderer.setPixelRatio = (v: number) => setPixelRatio(Math.min(v, cap));
  let quality: Quality | null = null;
  const applyQuality = (q: Quality) => {
    if (q === quality) return;
    const first = quality === null;
    quality = q;
    cap = QUALITY_DPR[q];
    const shadows = q !== 'low';
    if (renderer.shadowMap.enabled !== shadows) {
      renderer.shadowMap.enabled = shadows;
      // Programs are keyed on shadows: rebuild them
      app.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
      });
    }
    // Down at once (through the cap); back up as the adaptive guard allows
    const want = q === 'ultra' ? app.maxDpr : Math.min(app.maxDpr, cap);
    if (!first || q !== 'ultra') {
      setPixelRatio(Math.min(want, cap));
      window.dispatchEvent(new Event('resize'));
    }
  };

  const apply = (s: Settings) => {
    applyQuality(s.quality);
    audio.setEffectsLevel(s.sfx);
  };
  screens.addSettingsListener(apply);
  apply(screens.settings);

  // ── Pause menu actions ──
  screens.actions = {
    restart: () => game.reset(),
    cycleCamera: () => game.rig.cycle(),
    cameraName: () => game.rig.mode,
    forceResume: () => {
      app.paused = false;
      audio.setPaused(false);
      screens.setPaused(false, () => {});
    },
  };

  // ── Pausing without the pointer lock to lose: Esc (flying on after a
  // refused re-lock) or Start on a pad. The menu takes over from there ──
  const pause = () => {
    if (!app.engaged || app.paused || screens.paused || app.director || app.autopilot) return;
    app.paused = true;
    audio.setPaused(true);
    app.input?.releaseLock();
    screens.setPaused(true, () => app.input?.requestLock());
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !e.repeat && !document.pointerLockElement) pause();
  });
  let startWas = true;
  const pollStart = () => {
    requestAnimationFrame(pollStart);
    const pad = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected);
    const start = (pad?.buttons[9]?.value ?? 0) > 0.5;
    if (start && !startWas) pause();
    startWas = start;
  };
  window.addEventListener('gamepadconnected', () => requestAnimationFrame(pollStart), { once: true });
}
