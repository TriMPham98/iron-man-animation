import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Controls } from './input';
import { applyTouch, isTouchDevice, sideRole, stickOrigin, stickVector, TOUCH_BINDINGS, TOUCH_LOOK_SENS, TouchState } from './touchMath';

const controls = (over: Partial<Controls> = {}): Controls => ({
  aimYaw: 0, aimPitch: 0, throttle: 0, lateral: 0, vertical: 0, forward: 0,
  boost: false, brake: false, fire: false, missile: false, unibeam: false, flares: false, launcher: false,
  pressed: new Set(), zoom: 0, ...over,
});

describe('stickVector', () => {
  it('is dead inside the deadzone', () => {
    const v = stickVector(5, -5, 60, 0.15);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
    expect(v.mag).toBe(0);
    // ...but the knob still follows the thumb
    expect(v.knobX).toBe(5);
  });

  it('rescales from the deadzone edge, so it starts near zero', () => {
    const v = stickVector(60 * 0.16, 0, 60, 0.15);
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeLessThan(0.02);
  });

  it('flips y to up-positive and is full at the ring', () => {
    const v = stickVector(0, -60, 60, 0.15);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
    expect(v.mag).toBeCloseTo(1);
  });

  it('clamps radially past the ring, keeping the direction', () => {
    const v = stickVector(300, 400, 50, 0.1);
    expect(Math.hypot(v.knobX, v.knobY)).toBeCloseTo(50);
    expect(v.knobX / v.knobY).toBeCloseTo(0.75);
    expect(v.mag).toBe(1);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(0.6);
    expect(v.y).toBeCloseTo(-0.8);
  });

  it('never exceeds unit length on a diagonal', () => {
    const v = stickVector(80, -80, 60);
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(v.x)).toBeLessThan(1);
  });

  it('handles the exact centre', () => {
    expect(stickVector(0, 0, 60, 0)).toMatchObject({ x: 0, y: 0, mag: 0 });
  });
});

describe('sideRole / stickOrigin', () => {
  it('puts the stick on the left, or the right when left-handed', () => {
    expect(sideRole('left', false)).toBe('stick');
    expect(sideRole('right', false)).toBe('buttons');
    expect(sideRole('left', true)).toBe('buttons');
    expect(sideRole('right', true)).toBe('stick');
  });

  it('keeps a floating stick fully on screen', () => {
    expect(stickOrigin(5, 390, 60, 852, 393)).toEqual({ x: 60, y: 333 });
    expect(stickOrigin(400, 200, 60, 852, 393)).toEqual({ x: 400, y: 200 });
    expect(stickOrigin(850, 0, 60, 852, 393)).toEqual({ x: 792, y: 60 });
  });
});

describe('applyTouch', () => {
  it('adds the stick as analog roll / strafe and throttle, clamped', () => {
    const t = new TouchState();
    t.stickX = 0.5;
    t.stickY = -0.25;
    const c = controls();
    applyTouch(c, t, 1, false);
    expect(c.lateral).toBe(0.5);
    expect(c.throttle).toBe(-0.25);
    t.stickX = 0.8;
    const c2 = controls({ lateral: 0.6, throttle: 1 });
    t.stickY = 1;
    applyTouch(c2, t, 1, false);
    expect(c2.lateral).toBe(1);
    expect(c2.throttle).toBe(1);
  });

  it('turns a drag into aim like the mouse (right = yaw right, down = pitch down), then drains it', () => {
    const t = new TouchState();
    t.lookDX = 100;
    t.lookDY = 40;
    const c = controls();
    applyTouch(c, t, 2, false);
    expect(c.aimYaw).toBeCloseTo(-100 * TOUCH_LOOK_SENS * 2);
    expect(c.aimPitch).toBeCloseTo(-40 * TOUCH_LOOK_SENS * 2);
    expect(t.lookDX).toBe(0);
    const inv = controls();
    t.lookDY = 40;
    applyTouch(inv, t, 1, true);
    expect(inv.aimPitch).toBeCloseTo(40 * TOUCH_LOOK_SENS);
  });

  it('press / release hold the bound codes', () => {
    const t = new TouchState();
    expect(t.press('climb')).toBe('KeyE');
    t.press('fire');
    expect([...t.held].sort()).toEqual(['KeyE', 'Mouse0']);
    t.release('climb');
    expect([...t.held]).toEqual(['Mouse0']);
    t.stickX = 1;
    t.clear();
    expect(t.held.size).toBe(0);
    expect(t.stickX).toBe(0);
  });

  it('binds every button to a code the keyboard / mouse already uses', () => {
    expect(TOUCH_BINDINGS).toEqual({
      boost: 'ShiftLeft', climb: 'KeyE', dive: 'KeyQ', brake: 'KeyX', fire: 'Mouse0', missile: 'Mouse2',
      unibeam: 'Space', flares: 'KeyF', launcher: 'KeyG', camera: 'KeyV',
    });
  });
});

describe('isTouchDevice', () => {
  const win = (q: Record<string, boolean>, touchPoints: number, search = '') => ({
    matchMedia: (s: string) => ({ matches: !!q[s] }) as MediaQueryList,
    location: { search } as Location,
    navigator: { maxTouchPoints: touchPoints },
  });
  it('is on for a coarse primary pointer', () => {
    expect(isTouchDevice(win({ '(pointer: coarse)': true }, 5))).toBe(true);
  });
  it('is off for a touch-screen laptop with a mouse, and for a desktop', () => {
    expect(isTouchDevice(win({ '(any-pointer: fine)': true }, 10))).toBe(false);
    expect(isTouchDevice(win({ '(any-pointer: fine)': true }, 0))).toBe(false);
  });
  it('is on for touch with no fine pointer, and can be forced', () => {
    expect(isTouchDevice(win({}, 5))).toBe(true);
    expect(isTouchDevice(win({ '(pointer: coarse)': true }, 5, '?touch=0'))).toBe(false);
    expect(isTouchDevice(win({}, 0, '?touch=1'))).toBe(true);
  });
});

describe('Input with the touch source', () => {
  // Input wires DOM listeners in its constructor: just enough of a page
  beforeAll(() => {
    const target = { addEventListener: () => {} };
    vi.stubGlobal('window', { addEventListener: () => {} });
    vi.stubGlobal('document', { addEventListener: () => {}, pointerLockElement: null, exitPointerLock: () => {} });
    vi.stubGlobal('navigator', { getGamepads: () => [] });
    (globalThis as Record<string, unknown>).__target = target;
  });
  afterAll(() => vi.unstubAllGlobals());

  const make = async (touchMode: boolean) => {
    const { Input } = await import('./input');
    const target = (globalThis as Record<string, unknown>).__target as HTMLElement;
    target.requestPointerLock = vi.fn() as unknown as HTMLElement['requestPointerLock'];
    const input = new Input(target);
    input.touchMode = touchMode;
    return { input, target };
  };

  it('held buttons read exactly like the keys and mouse buttons', async () => {
    const { input } = await make(true);
    input.touch.press('boost');
    input.touch.press('fire');
    input.touch.press('missile');
    input.touch.press('unibeam');
    input.touch.press('brake');
    const c = input.read(1 / 60);
    expect(c).toMatchObject({ boost: true, fire: true, missile: true, unibeam: true, brake: true, flares: false });
  });

  it('climb / dive ramp in like the E / Q keys', async () => {
    const { input } = await make(true);
    input.touch.press('climb');
    const first = input.read(0.04).vertical;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    input.read(0.1);
    expect(input.read(0.1).vertical).toBe(1);
    input.touch.release('climb');
    input.touch.press('dive');
    for (let i = 0; i < 3; i++) input.read(0.1);
    expect(input.read(0.1).vertical).toBe(-1);
  });

  it('a tapped button is a one-frame press', async () => {
    const { input } = await make(true);
    input.queuePress(TOUCH_BINDINGS.camera);
    expect(input.read(1 / 60).pressed.has('KeyV')).toBe(true);
    expect(input.read(1 / 60).pressed.size).toBe(0);
  });

  it('stick and drag reach the controls in touch mode', async () => {
    const { input } = await make(true);
    input.touch.stickX = -0.5;
    input.touch.stickY = 0.75;
    input.touch.lookDX = 10;
    const c = input.read(1 / 60);
    expect(c.lateral).toBe(-0.5);
    expect(c.throttle).toBe(0.75);
    expect(c.aimYaw).toBeCloseTo(-10 * TOUCH_LOOK_SENS);
  });

  it('desktop: no touch analog, and pointer lock is still requested', async () => {
    const { input, target } = await make(false);
    input.touch.stickX = 1;
    input.touch.lookDX = 50;
    const c = input.read(1 / 60);
    expect(c.lateral).toBe(0);
    expect(Math.abs(c.aimYaw)).toBe(0); // -0 from the (idle) mouse term
    input.requestLock();
    expect(target.requestPointerLock).toHaveBeenCalledTimes(1);
  });

  it('touch mode never asks for pointer lock', async () => {
    const { input, target } = await make(true);
    input.requestLock();
    expect(target.requestPointerLock).not.toHaveBeenCalled();
  });
});
