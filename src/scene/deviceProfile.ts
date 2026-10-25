import { isTouchDevice } from '../flight/sim/touchMath';

/**
 * What kind of screen the page is on, read once at boot: the workshop and the
 * flight sim size their drawing buffers and pick their chrome from it.
 *
 * A phone is a touch-first device whose short side is under 600 CSS px; a
 * tablet is any other touch-first one. Everything else is a desktop (a
 * touch-screen laptop with a trackpad included — see {@link isTouchDevice}).
 * `?touch=1` forces the touch tiers on a desktop, for checking them.
 */
export type DeviceTier = 'phone' | 'tablet' | 'desktop';

export interface DeviceProfile {
  tier: DeviceTier;
  touch: boolean;
  /** Ceiling on the workshop's drawing-buffer pixel ratio. */
  maxPixelRatio: number;
  /** Floor the adaptive resolution may shed down to. */
  minPixelRatio: number;
}

/**
 * Ratios: a phone's screen is small enough that 1.35× of its CSS size is
 * already sharp, and a tablet's 1.25× of its (larger) CSS size is about a
 * 1080p desktop's fill — a third to a half of the pixels the full 2–3× would
 * cost, on GPUs that throttle long before a desktop's does.
 */
const PROFILES: Record<DeviceTier, Omit<DeviceProfile, 'tier' | 'touch'>> = {
  phone: { maxPixelRatio: 1.35, minPixelRatio: 0.7 },
  tablet: { maxPixelRatio: 1.25, minPixelRatio: 0.7 },
  desktop: { maxPixelRatio: 1.75, minPixelRatio: 0.8 },
};

export function tierOf(touch: boolean, shortSide: number): DeviceTier {
  if (!touch) return 'desktop';
  return shortSide < 600 ? 'phone' : 'tablet';
}

let cached: DeviceProfile | null = null;

export function deviceProfile(): DeviceProfile {
  if (cached) return cached;
  const touch = isTouchDevice();
  const shortSide = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  const tier = tierOf(touch, shortSide);
  cached = { tier, touch, ...PROFILES[tier] };
  return cached;
}
