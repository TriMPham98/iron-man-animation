import type { Controls } from './input';

/**
 * The touch screen as one more control source, kept free of the DOM so it
 * can be tested: the on-screen buttons hold the same key / mouse codes the
 * keyboard does (so they ramp, latch and edge exactly like the keys), the
 * stick adds analog throttle and roll / strafe on top (like a pad's left
 * stick) and a drag anywhere else is mouse look. The overlay that fills
 * this in is src/flight/ui/touchControls.ts.
 */

/** Every on-screen button and the existing binding it stands in for. */
export const TOUCH_BINDINGS = {
  boost: 'ShiftLeft',
  climb: 'KeyE',
  dive: 'KeyQ',
  brake: 'KeyX',
  fire: 'Mouse0',
  missile: 'Mouse2',
  unibeam: 'Space',
  flares: 'KeyF',
  launcher: 'KeyG',
  camera: 'KeyV',
} as const;

export type TouchAction = keyof typeof TOUCH_BINDINGS;

/** Aim per dragged CSS pixel (rad), before the sensitivity setting. */
export const TOUCH_LOOK_SENS = 0.005;

/** What the touch overlay is holding / has done since the last read. */
export class TouchState {
  /** Codes held down by on-screen buttons (see {@link TOUCH_BINDINGS}). */
  readonly held = new Set<string>();
  /** Stick, -1..1 each (x right, y up), after the deadzone. */
  stickX = 0;
  stickY = 0;
  /** Look drag since the last read (CSS px). */
  lookDX = 0;
  lookDY = 0;

  press(action: TouchAction): string {
    const code = TOUCH_BINDINGS[action];
    this.held.add(code);
    return code;
  }

  release(action: TouchAction): void {
    this.held.delete(TOUCH_BINDINGS[action]);
  }

  clear(): void {
    this.held.clear();
    this.stickX = this.stickY = 0;
    this.lookDX = this.lookDY = 0;
  }
}

export interface Stick {
  x: number;
  y: number;
  /** 0–1 after the deadzone. */
  mag: number;
  /** The knob's offset from the base (px, clamped to the radius). */
  knobX: number;
  knobY: number;
}

/**
 * A thumb at (dx, dy) px from the stick's centre (screen axes: y down) →
 * the stick's value: clamped to the ring, the deadzone cut out and the rest
 * rescaled to 0–1 so the first motion past it is a small one, y flipped to
 * up-positive.
 */
export function stickVector(dx: number, dy: number, radius: number, deadzone = 0.15): Stick {
  const len = Math.hypot(dx, dy);
  const k = len > radius ? radius / len : 1;
  const knobX = dx * k;
  const knobY = dy * k;
  const raw = Math.min(1, len / radius);
  if (raw <= deadzone || len === 0) return { x: 0, y: 0, mag: 0, knobX, knobY };
  const mag = (raw - deadzone) / (1 - deadzone);
  return { x: (dx / len) * mag, y: (-dy / len) * mag, mag, knobX, knobY };
}

/**
 * Left-handed: the stick moves to the right thumb and the buttons to the
 * left, so a screen side → the control on it.
 */
export function sideRole(side: 'left' | 'right', leftHanded: boolean): 'stick' | 'buttons' {
  return (side === 'left') !== leftHanded ? 'stick' : 'buttons';
}

/**
 * Where a floating stick's base lands for a touch at (x, y): under the thumb,
 * but pushed in from the screen edges so the whole ring stays on screen.
 */
export function stickOrigin(x: number, y: number, radius: number, w: number, h: number): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  return { x: clamp(x, radius, w - radius), y: clamp(y, radius, h - radius) };
}

/**
 * Adds the stick and the look drag to a frame's controls (after the keys,
 * held buttons included, have been read), and drains the drag.
 */
export function applyTouch(c: Controls, t: TouchState, sensitivity: number, invertY: boolean): void {
  const sens = TOUCH_LOOK_SENS * sensitivity;
  c.aimYaw += -t.lookDX * sens;
  c.aimPitch += -t.lookDY * sens * (invertY ? -1 : 1);
  c.lateral = Math.max(-1, Math.min(1, c.lateral + t.stickX));
  c.throttle = Math.max(-1, Math.min(1, c.throttle + t.stickY));
  t.lookDX = t.lookDY = 0;
}

/**
 * A touch-first device: a coarse primary pointer, or touch with no fine
 * pointer at all. A touch-screen laptop (mouse or trackpad = fine) stays on
 * the keyboard and mouse. `?touch=1` / `?touch=0` force it either way.
 */
export function isTouchDevice(win: Pick<Window, 'matchMedia' | 'location'> & { navigator: Pick<Navigator, 'maxTouchPoints'> } = window): boolean {
  const force = new URLSearchParams(win.location?.search ?? '').get('touch');
  if (force === '1') return true;
  if (force === '0') return false;
  const mq = (q: string) => win.matchMedia?.(q).matches ?? false;
  if (mq('(pointer: coarse)')) return true;
  return (win.navigator.maxTouchPoints ?? 0) > 0 && !mq('(any-pointer: fine)');
}
