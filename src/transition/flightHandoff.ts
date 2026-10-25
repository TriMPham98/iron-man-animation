import * as THREE from 'three';
import type { FlightApp } from '../flight/app';
import { createFrameStats } from './frameStats';
import { burnAt, checkAt, CLIMB_SEC, climbAt, FOLLOW_FOV, followPose, launchPlan, roofAt, workshopLens, type LaunchPlan } from './launchProfile';

/**
 * Workshop → flight, in one page and without a load: the flight sim is
 * built behind the workshop (its own WebGL context, hidden), a step at a
 * time — the cheap steps in idle time, the few long synchronous ones (the
 * terrain / sky bakes, the first full frame) only in quiet windows (the
 * boot loader, the INITIATE gate, a hidden tab) — and the finished suit is
 * flown straight into it:
 *
 *  1. CUE      the cycle holds, the workshop chrome falls away, JARVIS arms
 *              flight systems and the lens eases onto the hero framing,
 *              then keeps drifting in.
 *  2. HUD      the helmet HUD draws on over the picture.
 *  3. FLARE    sunlight floods in from above (the bay opening) — and under
 *              it the two worlds dissolve, the flight camera matched to the
 *              workshop one relative to the suit, still drifting in, so the
 *              suit holds its place in frame as the hangar becomes the coast.
 *  4. REVEAL   the flare burns off, the workshop HUD hands over to the
 *              flight HUD, the mixes cross (workshop down, wind and sea up)
 *              and the workshop's GPU resources are released.
 *  5. LIFT     a calm arc round to the shoulder view as the boot jets light
 *              and the suit lifts into a hover off the pad.
 *  6. HANDOVER the controls card slides in; a click takes the stick.
 *
 * From the hover test on, the suit flies itself out instead (LAUNCH, see
 * launchProfile.ts): the check runs into its settled hover, the roof iris
 * opens on the launch shaft and daylight comes down it, the suit climbs
 * out with the lens low under it and then up after it, and the flight sim
 * takes the picture inside the shaft — the same framing on its suit, just
 * up out of the landing pad's hub iris, which shuts under it as the lens
 * swings round to the shoulder.
 */
export interface WorkshopHandle {
  camera: THREE.PerspectiveCamera;
  /** The workshop suit's root (its facing). */
  suitRoot: THREE.Object3D;
  /** The workshop suit's head, world (the matched framing is relative to it). */
  headPoint(out: THREE.Vector3): THREE.Vector3;
  reducedMotion: boolean;
  /** Hold the cycle and keep the session / orbit / intro off the camera. */
  freeze(): void;
  /** Workshop mix level 0–1. */
  setVolume(v: number): void;
  /** Off screen for good: stop the loop, free the GPU. */
  retire(): void;
  /** Is now a moment where a long synchronous step would go unseen? */
  isQuiet(): boolean;
  /** Flight-check clock (s) when the suit can fly itself out from here, else null. */
  launchFrom(): number | null;
  /** The launch frame: check clock, climb over the hover (m), boot burn floor, effects clock. */
  poseLaunch(check: number, climb: number, burn: number, fx: number): void;
  /** Mast heads clear (0–1), roof iris (0–1), daylight down the shaft (0–1). */
  setRoof(s: { masts: number; iris: number; daylight: number }): void;
  /** A one-shot from the workshop's library. */
  cue(file: string, o: { offset?: number; duration: number; volume: number; fadeIn?: number; fadeOut?: number }): void;
}

/** Steps that block the main thread for long and only run in quiet windows. */
const HEAVY = new Set(['world', 'pipelines', 'sim', 'settle0', 'gauge']);

const smooth = (x: number) => {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const sine = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * THREE.MathUtils.clamp(x, 0, 1));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const idle = () =>
  new Promise<void>((r) => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => r(), { timeout: 1200 });
    else setTimeout(r, 40);
  });
const UP = new THREE.Vector3(0, 1, 0);

/** Yaw of an object's +Z (its facing) in world space. */
function yawOf(o: THREE.Object3D): number {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
  return Math.atan2(f.x, f.z);
}

function buildOverlay(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'flight-handoff';
  el.setAttribute('aria-hidden', 'true');
  const ticks = Array.from({ length: 13 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
  el.innerHTML = `
    <div class="ho-flare"></div>
    <div class="ho-hud">
      <span class="ho-corner ho-tl"></span><span class="ho-corner ho-tr"></span>
      <span class="ho-corner ho-bl"></span><span class="ho-corner ho-br"></span>
      <div class="ho-ribbon">${ticks}<b>HDG</b></div>
      <div class="ho-ladder ho-ladder-l"></div><div class="ho-ladder ho-ladder-r"></div>
      <div class="ho-reticle">
        <svg viewBox="0 0 200 200"><circle class="r1" cx="100" cy="100" r="92"/><circle class="r2" cx="100" cy="100" r="74"/><circle class="r3" cx="100" cy="100" r="54"/><path class="r4" d="M100 4v18M100 178v18M4 100h18M178 100h18"/></svg>
      </div>
      <div class="ho-lines">
        <div>J.A.R.V.I.S. // FLIGHT HANDOFF</div>
        <div>BOOT THRUSTERS · ARMED</div>
        <div>STABILIZERS · LIVE</div>
        <div>NAV · MALIBU · PAD 01</div>
        <div class="ho-sync">FLIGHT SYSTEMS · SYNCING</div>
      </div>
      <div class="ho-status">FLIGHT SYSTEMS ARMED · OPENING THE BAY</div>
    </div>
    <div class="ho-scan"></div>`;
  return el;
}

/**
 * Created at boot (so the preload can start under the loader); the
 * workshop is attached once its scene exists.
 */
export function createFlightHandoff(opts: { reducedMotion: boolean }) {
  let ws: WorkshopHandle | null = null;
  const stats = createFrameStats();
  (window as unknown as { __handoffStats: unknown }).__handoffStats = stats;

  // The flight sim's layer: above the workshop, invisible until the dissolve
  const layer = document.createElement('div');
  layer.id = 'flight-layer';
  layer.innerHTML = '<canvas id="flight-canvas"></canvas><canvas id="flight-hud"></canvas><div id="flight-ui"></div>';
  document.body.appendChild(layer);
  const overlay = buildOverlay();
  document.body.appendChild(overlay);

  let app: FlightApp | null = null;
  let loading: Promise<FlightApp> | null = null;
  /** Under the flare: no reason left to wait for a quiet window. */
  let urgent = false;
  const buildLog: Record<string, number> = {};

  /** Idle time for every step; quiet windows for the long ones. */
  const pace = async (step: string) => {
    for (;;) {
      if (urgent) return;
      await idle();
      // Before the workshop is attached its loader is still up: quiet
      if (urgent || !HEAVY.has(step) || !ws || ws.isQuiet()) return;
      await sleep(150);
    }
  };

  const preload = (): Promise<FlightApp> => {
    loading ??= (async () => {
      const t0 = performance.now();
      const [{ FlightApp }, { Screens }] = await Promise.all([import('../flight/app'), import('../flight/ui/screens')]);
      buildLog.import = Math.round(performance.now() - t0);
      const screens = new Screens(layer.querySelector<HTMLElement>('#flight-ui')!, { embedded: true });
      const a = new FlightApp({
        canvas: layer.querySelector<HTMLCanvasElement>('#flight-canvas')!,
        hudCanvas: layer.querySelector<HTMLCanvasElement>('#flight-hud')!,
        screens,
        pace,
        embedded: true,
        maxPixelRatio: 1.5,
      });
      await a.build();
      await a.warm(2);
      Object.assign(buildLog, a.timings, { total: Math.round(performance.now() - t0) });
      console.info('[handoff] flight ready', JSON.stringify(buildLog));
      (window as unknown as { __flight: unknown }).__flight = a.hooks();
      app = a;
      return a;
    })();
    loading.catch((e) => console.error('[handoff] flight preload failed', e));
    return loading;
  };

  // ── Beats (s from the click). Reduced motion: a plain dissolve. ─────────
  const rm = opts.reducedMotion;
  const B = rm
    ? { camEase: 0, hud: 0, flare: 0, start: 0.05, swap: 0.25, fade: 0.6, flareOff: 0.4, hudOff: 0.4, arcFrom: 0.6, arcLen: 1.6, lift: 0.4, card: 2.4 }
    : // flight-side times (arcFrom, arcLen, lift, card) are from the swap
      { camEase: 1.9, hud: 0.45, flare: 1.35, start: 1.85, swap: 2.15, fade: 0.75, flareOff: 0.55, hudOff: 0.85, arcFrom: 1.3, arcLen: 3.9, lift: 2.3, card: 5.4 };
  /** Lens drift after the ease (m/s), carried across the dissolve. */
  const DRIFT = rm ? 0 : 0.11;
  const drift = (t: number) => {
    const s = t - B.camEase;
    return s <= 0 ? 0 : DRIFT * (s - 0.7 * (1 - Math.exp(-s / 0.7)));
  };

  /** Launch: the plan, and the flight-side beats (s from the swap). */
  let plan: LaunchPlan | null = null;
  const L = { fade: 0.75, flareLead: 0.7, flareOff: 0.35, hudOff: 0.8, arcFrom: 0.45, arcLen: 3.3, irisFrom: 0.9, irisLen: 1.3, card: 4.3 };
  /** Boots this far over the deck as the flight sim takes the picture (m). */
  const EXIT_BOOTS = 0.85;
  let cues: Array<{ at: number; run: () => void }> = [];

  let active = false;
  let t = 0;
  let last = 0;
  let raf = 0;
  let swapped = false;
  let flightStarted = false;
  let retired = false;
  let carded = false;
  let lifted = false;
  let said = false;
  let held = false;

  // Workshop lens: start pose → hero framing → drift
  const camFrom = new THREE.Vector3();
  const lookFrom = new THREE.Vector3();
  let fovFrom = 35;
  /** Hero framing relative to the suit's head, in the suit's own yaw frame. */
  const heroRel = new THREE.Vector3(1.15, 0.0, 3.35);
  const heroLookRel = new THREE.Vector3(0, 0, 0);
  let heroFov = 35;
  const rootW = new THREE.Vector3();
  let yawW = 0;
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  const workshopPose = (time: number, cam: THREE.PerspectiveCamera) => {
    if (!ws) return;
    const e = B.camEase > 0 ? sine(time / B.camEase) : 1;
    const heroPos = tmp.copy(heroRel).applyAxisAngle(UP, yawW).add(rootW);
    const heroLook = tmp2.copy(heroLookRel).applyAxisAngle(UP, yawW).add(rootW);
    // Round the suit, not through it (the click can come from behind it,
    // mid showcase turn): radius / azimuth / elevation about the chest
    const pv = new THREE.Vector3().copy(rootW);
    pv.y -= 0.55;
    const sa = new THREE.Spherical().setFromVector3(new THREE.Vector3().copy(camFrom).sub(pv));
    const sb = new THREE.Spherical().setFromVector3(new THREE.Vector3().copy(heroPos).sub(pv));
    const dth = Math.atan2(Math.sin(sb.theta - sa.theta), Math.cos(sb.theta - sa.theta));
    cam.position
      .setFromSpherical(new THREE.Spherical(THREE.MathUtils.lerp(sa.radius, sb.radius, e), THREE.MathUtils.lerp(sa.phi, sb.phi, e), sa.theta + dth * e))
      .add(pv);
    const look = new THREE.Vector3().lerpVectors(lookFrom, heroLook, e);
    // Drift in along the view
    const dir = look.clone().sub(cam.position).normalize();
    cam.position.addScaledVector(dir, drift(time));
    cam.fov = THREE.MathUtils.lerp(fovFrom, heroFov, e);
    cam.updateProjectionMatrix();
    cam.up.copy(UP);
    cam.lookAt(look);
  };

  // Flight lens: the same framing on the flight suit, then the arc to the rig
  const pivot = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const rigPos = new THREE.Vector3();
  const rigFwd = new THREE.Vector3();
  const matchPos = new THREE.Vector3();
  const matchLook = new THREE.Vector3();
  const rigLook = new THREE.Vector3();
  const lookNow = new THREE.Vector3();
  const sphA = new THREE.Spherical();
  const sphB = new THREE.Spherical();
  const flightCamera = (fa: FlightApp) => (cam: THREE.PerspectiveCamera) => {
    const ft = t - B.swap;
    const rootF = fa.game.head;
    const yawF = yawOf(fa.suit.group);
    // Matched: the workshop's hero framing (plus its drift) on this suit
    matchLook.copy(heroLookRel).applyAxisAngle(UP, yawF).add(rootF);
    matchPos.copy(heroRel).applyAxisAngle(UP, yawF).add(rootF);
    matchPos.addScaledVector(tmp.copy(matchLook).sub(matchPos).normalize(), drift(t));
    // The rig has already placed the camera where the pilot's view is
    rigPos.copy(cam.position);
    cam.getWorldDirection(rigFwd);
    pivot.copy(rootF).y -= 0.55;
    const w = smooth((ft - B.arcFrom) / B.arcLen);
    rigLook.copy(rigPos).addScaledVector(rigFwd, rigPos.distanceTo(pivot));
    // Round the suit: blend radius / azimuth / elevation about the chest
    sphA.setFromVector3(a.copy(matchPos).sub(pivot));
    sphB.setFromVector3(b.copy(rigPos).sub(pivot));
    let dTheta = sphB.theta - sphA.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const sph = new THREE.Spherical(
      THREE.MathUtils.lerp(sphA.radius, sphB.radius, w),
      THREE.MathUtils.lerp(sphA.phi, sphB.phi, w),
      sphA.theta + dTheta * w,
    );
    const rigFov = cam.fov;
    cam.position.setFromSpherical(sph).add(pivot);
    lookNow.lerpVectors(matchLook, rigLook, w);
    cam.up.copy(UP);
    cam.lookAt(lookNow);
    cam.fov = THREE.MathUtils.lerp(heroFov, rigFov, w);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    if (ft >= B.arcFrom + B.arcLen) fa.cameraOverride = null;
  };

  // Launch: the follow framing under this suit, then the arc to the rig
  const followPos = new THREE.Vector3();
  const followLook = new THREE.Vector3();
  const launchCamera = (fa: FlightApp) => (cam: THREE.PerspectiveCamera) => {
    const ft = t - plan!.swap;
    followPose(fa.game.head, yawOf(fa.suit.group), followPos, followLook);
    rigPos.copy(cam.position);
    cam.getWorldDirection(rigFwd);
    pivot.copy(fa.game.head).y -= 0.55;
    const w = smooth((ft - L.arcFrom) / L.arcLen);
    rigLook.copy(rigPos).addScaledVector(rigFwd, rigPos.distanceTo(pivot));
    sphA.setFromVector3(a.copy(followPos).sub(pivot));
    sphB.setFromVector3(b.copy(rigPos).sub(pivot));
    const dTheta = Math.atan2(Math.sin(sphB.theta - sphA.theta), Math.cos(sphB.theta - sphA.theta));
    const rigFov = cam.fov;
    cam.position
      .setFromSpherical(new THREE.Spherical(THREE.MathUtils.lerp(sphA.radius, sphB.radius, w), THREE.MathUtils.lerp(sphA.phi, sphB.phi, w), sphA.theta + dTheta * w))
      .add(pivot);
    lookNow.lerpVectors(followLook, rigLook, w);
    cam.up.copy(UP);
    cam.lookAt(lookNow);
    cam.fov = THREE.MathUtils.lerp(FOLLOW_FOV, rigFov, w);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    if (ft >= L.arcFrom + L.arcLen) fa.cameraOverride = null;
  };

  // Launch: held coming up out of the hub at the climb's exit speed until the
  // picture is the sim's, then the hover computer catches it
  const launchPilot = (fa: FlightApp) => {
    const v = (climbAt(plan!, plan!.swap + 0.01) - climbAt(plan!, plan!.swap)) / 0.01;
    return (_dt: number, c: { vertical: number }) => {
      const m = fa.game.model;
      const ft = t - plan!.swap;
      // (the pad centre, without pulling the coast's modules into this one)
      const pad = fa.hud.pad!;
      const y0 = pad.y + m.hipHeight();
      if (ft < 0) {
        m.pos.set(pad.x, y0 + EXIT_BOOTS, pad.z);
        m.vel.set(0, v, 0);
        m.grounded = false;
        m.flightness = 0;
        return;
      }
      if (!lifted) {
        lifted = true;
        stats.mark('liftoff');
      }
      const target = y0 + 3.4;
      c.vertical = THREE.MathUtils.clamp((target - m.pos.y) * 0.6 - m.vel.y * 0.5, -0.6, 1);
    };
  };

  // Lift-off and a hover held off the pad until the pilot takes over
  const flightPilot = (fa: FlightApp) => {
    let y0 = Number.NaN;
    return (_dt: number, c: { vertical: number }) => {
      const m = fa.game.model;
      if (Number.isNaN(y0)) y0 = m.pos.y;
      const ft = t - B.swap;
      if (ft < B.lift) return;
      if (!lifted) {
        lifted = true;
        stats.mark('liftoff');
      }
      const target = y0 + 3.2;
      c.vertical = m.pos.y < y0 + 1.2 ? 1 : THREE.MathUtils.clamp((target - m.pos.y) * 0.6 - m.vel.y * 0.5, -0.6, 1);
    };
  };

  const startFlight = (fa: FlightApp) => {
    flightStarted = true;
    fa.attachInput().read(0); // drop keys pressed in the workshop
    fa.game.rig.mode = 'shoulder';
    fa.hudGoal = 0;
    fa.hud.alpha = 0;
    fa.volumeScale = 0;
    fa.applyVolume();
    void fa.audio.unlock().then(() => fa.sounds.start());
    fa.holdResolution = true;
    fa.cameraOverride = plan ? launchCamera(fa) : flightCamera(fa);
    fa.handoffPilot = plan ? launchPilot(fa) : flightPilot(fa);
    if (plan) fa.world.pad.setIris(1);
    fa.onFrame = null;
    fa.start();
  };

  const finishCard = (fa: FlightApp) => {
    carded = true;
    stats.mark('handover');
    const screens = fa.screens;
    fa.holdResolution = false;
    fa.bindPointerLock();
    screens.showTitle(() => fa.engage('The coast is yours, sir.'), false, { handoff: true });
    try {
      history.pushState({ flight: true }, '', '/flight.html');
      window.addEventListener('popstate', () => location.reload());
    } catch {
      /* file:// or sandboxed */
    }
    document.title = 'MK III — Flight';
    // Keep recording a beat into the pilot's hands, then report
    window.setTimeout(() => {
      stats.stop();
      console.info('[handoff] frame times', JSON.stringify(stats.summary()), JSON.stringify(stats.byBeat()));
    }, 1500);
  };

  const lensOut = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 35 };
  const lensFrom = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 35 };
  const headNow = new THREE.Vector3();

  /** The launch, one frame (t already advanced). */
  const launchTick = (w: WorkshopHandle) => {
    const p = plan!;
    while (cues.length && t >= cues[0].at) cues.shift()!.run();
    if (!retired) {
      w.poseLaunch(checkAt(p, t), climbAt(p, t), burnAt(p, t), p.from + t);
      w.setRoof(roofAt(p, t));
      w.headPoint(headNow);
      const cam = w.camera;
      workshopLens(p, t, headNow, yawW, lensFrom, lensOut);
      cam.position.copy(lensOut.pos);
      cam.fov = lensOut.fov;
      cam.updateProjectionMatrix();
      cam.up.copy(UP);
      cam.lookAt(lensOut.look);
      w.setVolume(1 - sine((t - p.swap + 0.5) / 1.3));
    }
    if (t >= 0.3) overlay.classList.add('is-hud');
    if (t >= p.swap - L.flareLead) {
      if (!overlay.classList.contains('is-flare')) stats.mark('flare');
      overlay.classList.add('is-flare', 'is-launch');
      urgent = true;
    }
    if (app && !flightStarted && t >= p.swap - 0.3) {
      stats.mark('flight-start');
      startFlight(app);
    }
    if (app && flightStarted && !swapped && t >= p.swap) {
      swapped = true;
      stats.mark('swap');
      layer.classList.add('is-live');
    }
    if (!swapped || !app) return;
    const ft = t - p.swap;
    app.volumeScale = sine((ft + 0.3) / 2.2);
    app.applyVolume();
    if (ft >= L.flareOff) overlay.classList.add('is-open');
    if (ft >= L.hudOff) {
      overlay.classList.add('is-done');
      app.hudGoal = 1;
    }
    // The hub iris shuts under the suit
    const shut = THREE.MathUtils.clamp((ft - L.irisFrom) / L.irisLen, 0, 1);
    app.world.pad.setIris(1 - shut);
    if (!said && ft >= 1.1) {
      said = true;
      app.game.events.emit('jarvis', { text: 'Flight systems online. Good evening, sir.' });
    }
    if (!retired && ft >= L.fade * 0.6) {
      retired = true;
      stats.mark('retire');
      w.setVolume(0);
      idle().then(() => {
        const t0 = performance.now();
        w.retire();
        buildLog.retireMs = Math.round(performance.now() - t0);
        console.info(`[handoff] workshop retired in ${buildLog.retireMs} ms`);
        stats.mark('flight');
      });
    }
    if (!carded && ft >= L.card) {
      finishCard(app);
      overlay.remove();
      cancelAnimationFrame(raf);
    }
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (!ws) return;
    const w = ws;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (plan) {
      // Hold under the flare until the flight sim is ready
      if (!held && t + dt >= plan.swap - 0.3 && !app) {
        held = true;
        urgent = true;
        overlay.classList.add('is-hold', 'is-flare');
        stats.mark('hold');
      }
      if (held && app) {
        held = false;
        overlay.classList.remove('is-hold');
      }
      if (!held) t += dt;
      launchTick(w);
      return;
    }
    // Hold under the flare until the flight sim is ready
    if (!held && t + dt >= B.start && !app) {
      held = true;
      urgent = true;
      overlay.classList.add('is-hold');
      stats.mark('hold');
    }
    if (held && app) {
      held = false;
      overlay.classList.remove('is-hold');
    }
    if (!held) t += dt;

    // Workshop beats
    if (!swapped || t < B.swap + B.fade) {
      if (!retired) workshopPose(t, w.camera);
      w.setVolume(1 - sine(t / 2.6));
    }
    if (t >= B.hud) overlay.classList.add('is-hud');
    if (t >= B.flare && !rm) {
      if (!overlay.classList.contains('is-flare')) {
        stats.mark('flare');
        // The bay letting go: a library hiss under the light
        app?.cue('steamRelease', 0.55);
      }
      overlay.classList.add('is-flare');
      urgent = true;
    }
    if (app && !flightStarted && t >= B.start) {
      stats.mark('flight-start');
      startFlight(app);
    }
    if (app && flightStarted && !swapped && t >= B.swap) {
      swapped = true;
      stats.mark('swap');
      layer.classList.add('is-live');
    }
    if (swapped && app) {
      const ft = t - B.swap;
      app.volumeScale = sine((ft + 0.3) / 2.8);
      app.applyVolume();
      if (ft >= B.flareOff) overlay.classList.add('is-open');
      if (ft >= B.hudOff) {
        overlay.classList.add('is-done');
        app.hudGoal = 1;
      }
      if (!said && ft >= 1.1) {
        said = true;
        app.game.events.emit('jarvis', { text: 'Flight systems online. Good evening, sir.' });
      }
      // The workshop stops drawing as soon as it can't be seen (the flight
      // layer ~80% in, under the flare): only ~0.75 s of both renderers
      if (!retired && ft >= B.fade * 0.6) {
        retired = true;
        stats.mark('retire');
        w.setVolume(0);
        idle().then(() => {
          const t0 = performance.now();
          w.retire();
          buildLog.retireMs = Math.round(performance.now() - t0);
          console.info(`[handoff] workshop retired in ${buildLog.retireMs} ms`);
          stats.mark('flight');
        });
      }
      if (!carded && ft >= B.card) {
        finishCard(app);
        overlay.remove();
        cancelAnimationFrame(raf);
      }
    }
  };

  const begin = () => {
    if (active || !ws) return;
    active = true;
    stats.start();
    stats.mark('cue');
    // Inside the click: unlock the flight mix now if it exists (else the page's
    // sticky activation lets it start unmuted later)
    void app?.audio.unlock();
    void preload().catch(() => {
      location.href = '/flight.html';
    });
    ws.freeze();
    const cam = ws.camera;
    const from = rm ? null : ws.launchFrom();
    if (from !== null) {
      plan = launchPlan(from);
      lensFrom.pos.copy(cam.position);
      ws.headPoint(rootW);
      lensFrom.look.copy(cam.position).addScaledVector(cam.getWorldDirection(tmp), cam.position.distanceTo(rootW));
      lensFrom.fov = cam.fov;
      const p = plan;
      const w = ws;
      // The library's own: mast heads, the iris unlatching and drawing back, the boots
      cues = [
        { at: p.masts, run: () => w.cue('metal-sliding.mp3', { duration: 0.7, volume: 0.45, fadeOut: 0.3 }) },
        { at: p.irisFrom, run: () => w.cue('unclamp.mp3', { duration: 0.9, volume: 0.6, fadeOut: 0.3 }) },
        { at: p.irisFrom + 0.2, run: () => w.cue('metal-sliding.mp3', { duration: 1.4, volume: 0.6, fadeOut: 0.5 }) },
        { at: p.irisOpen - 0.3, run: () => w.cue('steam-release.mp3', { duration: 1.6, volume: 0.4, fadeOut: 0.8 }) },
        { at: p.climb - 0.35, run: () => w.cue('thruster-ignite.mp3', { duration: 1.2, volume: 0.8, fadeOut: 0.4 }) },
        { at: p.climb - 0.05, run: () => w.cue('thruster-burn.mp3', { duration: CLIMB_SEC + 1.2, volume: 0.9, fadeIn: 0.15, fadeOut: 0.9 }) },
      ];
    }
    camFrom.copy(cam.position);
    ws.headPoint(rootW);
    lookFrom.copy(cam.position).addScaledVector(cam.getWorldDirection(tmp), cam.position.distanceTo(rootW));
    fovFrom = cam.fov;
    yawW = yawOf(ws.suitRoot);
    document.body.classList.add('flight-handoff');
    overlay.classList.add('is-cue');
    last = 0;
    raf = requestAnimationFrame(tick);
  };

  /** Set the hero framing (a world pose, with the suit's head at `head`). */
  const setHeroFraming = (pos: THREE.Vector3, look: THREE.Vector3, fov: number, head: THREE.Vector3) => {
    heroRel.copy(pos).sub(head);
    heroLookRel.copy(look).sub(head);
    heroFov = fov;
  };

  return {
    preload,
    begin,
    setHeroFraming,
    attach: (handle: WorkshopHandle) => {
      ws = handle;
    },
    isActive: () => active,
    isReady: () => !!app,
    /** The cover is up: nothing of the workshop is on show any more. */
    isCovered: () => urgent,
    stats,
    buildLog,
  };
}

export type FlightHandoff = ReturnType<typeof createFlightHandoff>;
