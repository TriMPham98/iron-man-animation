import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Controls } from './input';
import {
  applyTouch, BOOST_RING, CLIMB_OUT, inBoostRing, isTouchDevice, LOOK_CLIMB_DEAD, LOOK_DESCENT_MAX, sideRole, stickOrigin, stickVector,
  TOUCH_BINDINGS, TOUCH_LOOK_SENS, touchVertical, TouchState,
} from './touchMath';
import { viewportSize, wideZoom } from '../render/viewport';

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
    expect(t.press('boost')).toBe('ShiftLeft');
    t.press('fire');
    expect([...t.held].sort()).toEqual(['Mouse0', 'ShiftLeft']);
    t.release('boost');
    expect([...t.held]).toEqual(['Mouse0']);
    t.stickX = 1;
    t.clear();
    expect(t.held.size).toBe(0);
    expect(t.stickX).toBe(0);
  });

  it('binds every button to a code the keyboard / mouse already uses', () => {
    expect(TOUCH_BINDINGS).toEqual({
      boost: 'ShiftLeft', brake: 'KeyX', fire: 'Mouse0', missile: 'Mouse2',
      unibeam: 'Space', flares: 'KeyF', launcher: 'KeyG', camera: 'KeyV', wave: 'KeyN',
    });
  });
});

describe('inBoostRing', () => {
  const r = 60;
  it('is off short of the rim and on past ~90% straight forward', () => {
    expect(inBoostRing(0, -r * 0.8, r)).toBe(false);
    expect(inBoostRing(0, -r * (BOOST_RING + 0.01), r)).toBe(true);
    // Past the ring the thumb is still "in" (the knob is clamped, the thumb isn't)
    expect(inBoostRing(0, -r * 1.6, r)).toBe(true);
  });
  it('wants forward: not back, not the side, a little off-axis is fine', () => {
    expect(inBoostRing(0, r, r)).toBe(false);
    expect(inBoostRing(r, 0, r)).toBe(false);
    expect(inBoostRing(-r, 0, r)).toBe(false);
    const a = 0.4; // ~23° off straight up
    expect(inBoostRing(r * Math.sin(a), -r * Math.cos(a), r)).toBe(true);
    const b = 0.9; // ~52°: a roll with throttle, not a boost
    expect(inBoostRing(r * Math.sin(b), -r * Math.cos(b), r)).toBe(false);
  });
  it('holds through the edge once in (hysteresis)', () => {
    expect(inBoostRing(0, -r * 0.87, r, false)).toBe(false);
    expect(inBoostRing(0, -r * 0.87, r, true)).toBe(true);
    expect(inBoostRing(0, -r * 0.8, r, true)).toBe(false);
  });
});

describe('touchVertical (take-off and hover climb without buttons)', () => {
  const state = (sim: Partial<TouchState['sim']>, boost = false) => {
    const t = new TouchState();
    Object.assign(t.sim, { grounded: false, hover: 1, pitch: 0 }, sim);
    t.boost = boost;
    return t;
  };
  it('on the ground: nothing, whatever the look, until the stick reaches its ring', () => {
    expect(touchVertical(state({ grounded: true, pitch: 1 }), 0.016)).toBe(0);
    expect(touchVertical(state({ grounded: true, pitch: -1 }), 0.016)).toBe(0);
    expect(touchVertical(state({ grounded: true }, true), 0.016)).toBe(1);
  });
  it('the ring launches and holds the climb for CLIMB_OUT s off the deck, then lets go', () => {
    const t = state({ grounded: true }, true);
    expect(touchVertical(t, 0.1)).toBe(1);
    // Hopped: airborne, ring released, level look
    t.sim.grounded = false;
    t.boost = false;
    let held = 0;
    while (touchVertical(t, 0.05) === 1 && held < 10) held += 0.05;
    expect(held).toBeCloseTo(CLIMB_OUT, 1);
    expect(touchVertical(t, 0.05)).toBe(0);
  });
  it('the climb-out waits on the ground (a hero-landing crouch) and starts on lift-off', () => {
    const t = state({ grounded: true }, true);
    for (let i = 0; i < 100; i++) touchVertical(t, 0.05);
    expect(t.climbOut).toBe(CLIMB_OUT);
  });
  it('hover: look up climbs, look down descends gently (never a boots-cut fall), level holds', () => {
    expect(touchVertical(state({ pitch: 0 }), 0.016)).toBe(0);
    expect(touchVertical(state({ pitch: LOOK_CLIMB_DEAD - 0.01 }), 0.016)).toBe(0);
    expect(touchVertical(state({ pitch: -0.08 }), 0.016)).toBe(0); // the rig's default look
    expect(touchVertical(state({ pitch: 1 }), 0.016)).toBe(1);
    const up = touchVertical(state({ pitch: 0.35 }), 0.016);
    expect(up).toBeGreaterThan(0);
    expect(up).toBeLessThan(1);
    expect(touchVertical(state({ pitch: -1.2 }), 0.016)).toBe(LOOK_DESCENT_MAX);
    expect(LOOK_DESCENT_MAX).toBeGreaterThan(-0.5); // flightModel FALL_STICK
  });
  it('in flight the look already steers the nose: no extra climb / sink', () => {
    expect(touchVertical(state({ hover: 0, pitch: 1 }), 0.016)).toBe(0);
    expect(touchVertical(state({ hover: 0, pitch: -1 }), 0.016)).toBeCloseTo(0);
  });
  it('reaches the controls through applyTouch, on top of the keys', () => {
    const t = state({ grounded: true }, true);
    const c = controls();
    applyTouch(c, t, 1, false, 0.016);
    expect(c.vertical).toBe(1);
    const k = controls({ vertical: 1 });
    applyTouch(k, state({ pitch: -1 }), 1, false, 0.016);
    expect(k.vertical).toBeCloseTo(1 + LOOK_DESCENT_MAX);
  });
});

describe('viewport', () => {
  it('is the visual viewport (the visible area), unscaled by a pinch', () => {
    expect(viewportSize({ innerWidth: 915, innerHeight: 412, visualViewport: { width: 915, height: 356, scale: 1 } })).toEqual({ w: 915, h: 356 });
    expect(viewportSize({ innerWidth: 915, innerHeight: 412, visualViewport: { width: 457.5, height: 206, scale: 2 } })).toEqual({ w: 915, h: 412 });
    expect(viewportSize({ innerWidth: 1440, innerHeight: 900, visualViewport: null })).toEqual({ w: 1440, h: 900 });
  });
  it('wide zoom only past 16:9', () => {
    expect(wideZoom(1440 / 900)).toBe(1);
    expect(wideZoom(16 / 9)).toBe(1);
    expect(wideZoom(915 / 412)).toBeCloseTo(915 / 412 / (16 / 9));
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

  it('the ring holds boost (Left Shift) and, on the ground, the climb (E) for take-off', async () => {
    const { input } = await make(true);
    input.touch.sim.grounded = true;
    input.touch.boost = true;
    input.touch.press('boost');
    input.touch.stickY = 1;
    const c = input.read(1 / 60);
    expect(c.boost).toBe(true);
    expect(c.vertical).toBe(1);
    expect(c.throttle).toBe(1);
  });

  it('desktop: the touch vertical mapping never runs (E / Q only)', async () => {
    const { input } = await make(false);
    Object.assign(input.touch.sim, { grounded: false, hover: 1, pitch: 1 });
    expect(input.read(1 / 60).vertical).toBe(0);
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

describe('touch take-off / hover / landing on the flight model', () => {
  /** Flies the model on the touch mapping alone: ring, stick throttle, look pitch. */
  const fly = async (seconds: number, set: (t: TouchState, time: number) => { stickY: number; pitch: number }, m?: import('./flightModel').FlightModel) => {
    const THREE = await import('three');
    const { EMPTY_INPUT, FlightModel } = await import('./flightModel');
    const model = m ?? new FlightModel({ surface: () => 0, isWater: () => false, normal: (_x, _z, out: InstanceType<typeof THREE.Vector3>) => out.set(0, 1, 0) });
    if (!m) model.placeOnGround(0, 0, 0);
    const t = new TouchState();
    const input = EMPTY_INPUT();
    const dt = 1 / 120;
    const contacts: string[] = [];
    for (let time = 0; time < seconds; time += dt) {
      const { stickY, pitch } = set(t, time);
      Object.assign(t.sim, { grounded: model.grounded, hover: 1 - model.flightness, pitch });
      input.aim.set(0, Math.sin(pitch), Math.cos(pitch));
      input.throttle = stickY;
      input.boost = t.boost;
      input.vertical = touchVertical(t, dt);
      model.step(dt, input);
      if (model.contact !== 'none' && model.contact !== 'footstep') contacts.push(model.contact);
    }
    return { model, contacts };
  };

  it('full stick to the ring on the ground: lifts off, clears the deck and flies away', async () => {
    const { model } = await fly(4, (t) => ((t.boost = true), { stickY: 1, pitch: 0 }));
    expect(model.grounded).toBe(false);
    expect(model.pos.y).toBeGreaterThan(8);
    expect(model.flightness).toBeGreaterThan(0.5);
  });

  it('partial stick on the ground still walks (no take-off short of the ring)', async () => {
    const { model } = await fly(2, () => ({ stickY: 0.6, pitch: 0.5 }));
    expect(model.grounded).toBe(true);
    expect(model.speed).toBeGreaterThan(0.5);
  });

  it('a flick to the ring hops into a hover; look up climbs, look down settles back onto the boots', async () => {
    const hop = await fly(3, (t, time) => ((t.boost = time < 0.15), { stickY: 0, pitch: 0 }));
    const m = hop.model;
    expect(m.grounded).toBe(false);
    expect(m.flightness).toBeLessThan(0.1);
    const y0 = m.pos.y;
    await fly(2, () => ({ stickY: 0, pitch: 0.7 }), m);
    expect(m.pos.y).toBeGreaterThan(y0 + 15);
    const down = await fly(12, () => ({ stickY: 0, pitch: -0.9 }), m);
    expect(m.grounded).toBe(true);
    expect(down.contacts).toEqual([expect.stringMatching(/^(landed|touchdown)$/)]);
  });
});
