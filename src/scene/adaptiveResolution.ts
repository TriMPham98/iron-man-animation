import type * as THREE from 'three';

/**
 * Dynamic resolution: keeps the frame rate up on weaker GPUs by trimming
 * the drawing-buffer pixel ratio when frames run long, and restores it
 * (up to the configured ceiling) once there is headroom. Fast machines
 * never leave full resolution, so the look is unchanged where it can be.
 */
export function createAdaptiveResolution(
  renderer: THREE.WebGLRenderer,
  onChange: () => void,
  opts: { min?: number; max?: number } = {},
) {
  const max = opts.max ?? renderer.getPixelRatio();
  const min = Math.min(max, opts.min ?? 0.8);
  let dpr = renderer.getPixelRatio();
  let acc = 0;
  let frames = 0;
  let cooldown = 2.5;
  let goodFor = 0;

  return {
    /** Feed the frame delta (s); occasionally changes the pixel ratio. */
    update(dt: number): void {
      // Ignore tab-resume spikes
      if (dt <= 0 || dt > 0.25) return;
      acc += dt;
      frames++;
      cooldown -= dt;
      if (acc < 1) return;
      const ms = (acc / frames) * 1000;
      acc = 0;
      frames = 0;
      if (cooldown > 0) return;
      let next = dpr;
      if (ms > 21) {
        // Under ~48 fps: shed pixels (bigger steps when far behind)
        next = Math.max(min, dpr - (ms > 34 ? 0.25 : 0.12));
        goodFor = 0;
      } else if (ms < 14.5) {
        // Comfortably above 60 fps for a while: give resolution back
        goodFor += 1;
        if (goodFor >= 3) next = Math.min(max, dpr + 0.12);
      } else {
        goodFor = 0;
      }
      if (Math.abs(next - dpr) > 1e-3) {
        dpr = next;
        renderer.setPixelRatio(dpr);
        onChange();
        cooldown = 2;
        goodFor = 0;
      }
    },
    get pixelRatio() {
      return dpr;
    },
  };
}
