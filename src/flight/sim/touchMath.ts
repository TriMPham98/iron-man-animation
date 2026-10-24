import type { Controls } from './input';

/**
 * The touch screen as one more control source, kept free of the DOM so it
 * can be tested: the on-screen buttons hold the same key / mouse codes the
 * keyboard does (so they ramp, latch and edge exactly like the keys), the
 * stick adds analog throttle and roll / strafe on top (like a pad's left
 * stick) and a drag anywhere else is mouse look. The overlay that fills
 * this in is src/flight/ui/touchControls.ts.
 *
 * There are no climb / descend buttons: the stick's outer ring (full
 * forward) holds boost, and on the ground launches the suit; in a hover the
 * look's pitch climbs and descends (in flight the nose already follows it).
 * See {@link touchVertical}.
 */

/** Every on-screen control and the existing binding it stands in for (boost is the stick's ring). */
export const TOUCH_BINDINGS = {
  boost: 'ShiftLeft',
  brake: 'KeyX',
  fire: 'Mouse0',
  missile: 'Mouse2',
  unibeam: 'Space',
  flares: 'KeyF',
  launcher: 'KeyG',
  camera: 'KeyV',
  wave: 'KeyN',
  land: 'KeyL',
} as const;

export type TouchAction = keyof typeof TOUCH_BINDINGS;

/** Aim per dragged CSS pixel (rad), before the sensitivity setting. */
export const TOUCH_LOOK_SENS = 0.005;

/** The stick's boost ring: in past this much of the radius, within this angle (rad) of straight forward. */
export const BOOST_RING = 0.9;
/** ...and out again only below this (no flicker on the edge). */
export const BOOST_RING_OUT = 0.85;
export const BOOST_ARC = 0.6;
/** Take-off from the ring: the climb is held this long (s) after the hop, to clear the deck. */
export const CLIMB_OUT = 1.2;
/** Hover: look pitch (rad) dead band, and where the climb / descent is full. */
export const LOOK_CLIMB_DEAD = 0.18;
export const LOOK_CLIMB_FULL = 0.6;
/** Deepest look-down descent: a settle onto the boots, never a boots-cut fall (flightModel FALL_STICK). */
export const LOOK_DESCENT_MAX = -0.4;

/** What the suit is doing, fed to the touch source each frame (the takeoff / hover mapping reads it). */
export interface TouchSim {
  grounded: boolean;
  /** 0 = in flight … 1 = hovering. */
  hover: number;
  /** Look / aim pitch (rad, up positive). */
  pitch: number;
}

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
  /** The stick is in its boost ring (holds {@link TOUCH_BINDINGS}.boost). */
  boost = false;
  /** The suit's state, set by the app before each read. */
  sim: TouchSim = { grounded: false, hover: 0, pitch: 0 };
  /** Seconds of take-off climb left. */
  climbOut = 0;

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
    this.boost = false;
    this.climbOut = 0;
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
 * Whether a thumb at (dx, dy) px from the stick's centre (screen axes) is in
 * the boost ring: pushed out to the rim, roughly straight forward. `wasOn`
 * gives it a little hysteresis.
 */
export function inBoostRing(dx: number, dy: number, radius: number, wasOn = false): boolean {
  const raw = Math.hypot(dx, dy) / radius;
  if (raw < (wasOn ? BOOST_RING_OUT : BOOST_RING)) return false;
  // Angle off straight up (screen y is down)
  return Math.abs(Math.atan2(dx, -dy)) <= BOOST_ARC;
}

/**
 * The climb / descend command from the touch source, standing in for E / Q:
 *  - on the ground, the stick in its ring launches (the same hop E gives)
 *    and holds the climb for {@link CLIMB_OUT} s so the suit clears the deck
 *    before the throttle carries it into flight;
 *  - in a hover, the look's pitch climbs / descends (past a dead band), so
 *    "fly where you look" holds there as it does in flight — down is capped
 *    at a gentle settle, so looking down lands rather than cuts the boots;
 *  - in flight it is nothing (the nose follows the look already).
 */
export function touchVertical(t: TouchState, dt: number): number {
  const { grounded, hover, pitch } = t.sim;
  if (grounded && t.boost) t.climbOut = CLIMB_OUT;
  if (t.climbOut > 0) {
    if (!grounded) t.climbOut = Math.max(0, t.climbOut - dt);
    return 1;
  }
  if (grounded) return 0;
  const a = Math.abs(pitch);
  if (a <= LOOK_CLIMB_DEAD) return 0;
  const k = Math.min(1, (a - LOOK_CLIMB_DEAD) / (LOOK_CLIMB_FULL - LOOK_CLIMB_DEAD));
  return Math.max(LOOK_DESCENT_MAX, Math.sign(pitch) * k) * Math.max(0, Math.min(1, hover));
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
export function applyTouch(c: Controls, t: TouchState, sensitivity: number, invertY: boolean, dt = 0): void {
  const sens = TOUCH_LOOK_SENS * sensitivity;
  c.vertical = Math.max(-1, Math.min(1, c.vertical + touchVertical(t, dt)));
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
