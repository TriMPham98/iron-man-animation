import type * as THREE from 'three';

/**
 * Dynamic resolution: keeps the frame rate up on weaker GPUs by trimming
 * the drawing-buffer pixel ratio when frames run long, and restores it
 * (up to the configured ceiling) once there is headroom. Fast machines
 * never leave full resolution, so the look is unchanged where it can be.
 *
 * Headroom is judged against the display's own refresh, not a fixed 60+ fps:
 * a 60 Hz screen never paces a frame faster than 16.7 ms, so "under 14.5 ms"
 * could never come true there and a single heavy moment (the handoff, a
 * context teardown) cost resolution for good. A step back up is a probe: if
 * it drops frames it is undone, and the next probe waits twice as long, so a
 * GPU on the edge settles instead of reallocating its targets every few
 * seconds (each change is a visible hitch).
 */
export type ResolutionRenderer = Pick<THREE.WebGLRenderer, 'getPixelRatio' | 'setPixelRatio'>;

/** Mean frame over this is under ~48 fps: shed pixels. */
const SLOW_MS = 21;
/** Good windows needed before the first probe up (doubles on each failed one). */
const PROBE_AFTER = 3;
const PROBE_AFTER_MAX = 48;
const STEP_UP = 0.12;

export function createAdaptiveResolution(
  renderer: ResolutionRenderer,
  onChange: () => void,
  opts: { min?: number; max?: number } = {},
) {
  const max = opts.max ?? renderer.getPixelRatio();
  const min = Math.min(max, opts.min ?? 0.8);
  let dpr = renderer.getPixelRatio();
  let acc = 0;
  let frames = 0;
  let shortest = Infinity;
  let cooldown = 2.5;
  let goodFor = 0;
  /** Recent shortest frame intervals: the display's refresh period. */
  const periods: number[] = [];
  let probeAfter = PROBE_AFTER;
  /** Ratio before the last step up, while that step is on trial. */
  let probeFrom = 0;

  const apply = (next: number) => {
    dpr = next;
    renderer.setPixelRatio(dpr);
    onChange();
    cooldown = 2;
    goodFor = 0;
  };

  return {
    /** Feed the frame delta (s); occasionally changes the pixel ratio. */
    update(dt: number): void {
      // Ignore tab-resume spikes
      if (dt <= 0 || dt > 0.25) return;
      acc += dt;
      frames++;
      shortest = Math.min(shortest, dt);
      cooldown -= dt;
      if (acc < 1) return;
      const ms = (acc / frames) * 1000;
      periods.push(Math.max(4, shortest * 1000));
      if (periods.length > 10) periods.shift();
      acc = 0;
      frames = 0;
      shortest = Infinity;
      if (cooldown > 0) return;
      // Paced at (or within a whisker of) the refresh: a 60 Hz screen reads
      // ~16.7-17.5 ms here, a 120 Hz one ~8.3-9
      const refresh = Math.min(...periods);
      const good = ms < Math.min(18, refresh * 1.1);
      if (probeFrom) {
        const from = probeFrom;
        probeFrom = 0;
        if (!good) {
          // The step up cost frames: back to where it held, and wait longer
          probeAfter = Math.min(PROBE_AFTER_MAX, probeAfter * 2);
          apply(from);
          return;
        }
        probeAfter = PROBE_AFTER;
      }
      if (ms > SLOW_MS) {
        // Shed pixels (bigger steps when far behind)
        const next = Math.max(min, dpr - (ms > 34 ? 0.25 : 0.12));
        goodFor = 0;
        if (next < dpr - 1e-3) apply(next);
      } else if (good) {
        goodFor += 1;
        if (goodFor >= probeAfter && dpr < max - 1e-3) {
          probeFrom = dpr;
          apply(Math.min(max, dpr + STEP_UP));
        }
      } else {
        goodFor = 0;
      }
    },
    /** Jump to a ratio (a measured starting point); the probing starts afresh. */
    set(next: number): void {
      next = Math.min(max, Math.max(min, next));
      probeFrom = 0;
      probeAfter = PROBE_AFTER;
      acc = frames = 0;
      shortest = Infinity;
      if (Math.abs(next - dpr) > 1e-3) apply(next);
      cooldown = 2.5;
    },
    get pixelRatio() {
      return dpr;
    },
    get maxPixelRatio() {
      return max;
    },
  };
}
