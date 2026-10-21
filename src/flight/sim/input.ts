import { applyTouch, TouchState } from './touchMath';

/**
 * Keyboard + mouse (pointer lock) + gamepad + touch screen, read as one
 * control state.
 *
 * The same keys mean two things (the flight model reads them by mode):
 * on foot, W/S walk forward and back and A/D sidestep relative to the
 * look, Shift runs and E takes off; in the air, mouse aims (the suit
 * steers toward where you look), W/S set the throttle, A/D roll in flight
 * and strafe in a hover, E climbs, Q cuts the boots (free fall), Shift
 * boosts, X fires the palms forward to brake. LMB repulsors, RMB missile lock
 * (release to fire), Space unibeam, F flares, G forearm launchers.
 * On a pad: right stick aims, left stick strafes / rolls (and moves in a
 * hover), triggers are throttle and brake, A/X climb/descend, L3 boost,
 * RB repulsors, LB missiles, Y unibeam, B flares, R3 camera.
 * On a touch screen the on-screen buttons hold the same key codes, the
 * stick is analog throttle and roll / strafe (its outer ring boosts, and
 * launches from the ground), a drag aims, and in a hover the look's pitch
 * climbs / descends (src/flight/sim/touchMath.ts, src/flight/ui/touchControls.ts).
 */
export interface Controls {
  /** Aim deltas this frame (rad). */
  aimYaw: number;
  aimPitch: number;
  throttle: number;
  lateral: number;
  vertical: number;
  forward: number;
  boost: boolean;
  brake: boolean;
  fire: boolean;
  missile: boolean;
  unibeam: boolean;
  flares: boolean;
  launcher: boolean;
  /** One-shot presses (true for one frame). */
  pressed: Set<string>;
  zoom: number;
}

const MOUSE_SENS = 0.0021;
const PAD_RATE = 2.4;
/**
 * Keys are on/off but the pilot isn't: a held key eases up to full over this
 * long (s) and back down on release, so strafes, rolls and climbs start and
 * stop like a hand on a stick rather than a switch.
 */
const KEY_RAMP = 0.16;

export class Input {
  private readonly keys = new Set<string>();
  private readonly pressedQueue = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private buttons = 0;
  private wheel = 0;
  private padPrev = new Map<number, boolean>();
  /** Ramped (linear) key axes; the output is eased from these. */
  private keyLateral = 0;
  private keyVertical = 0;
  locked = false;
  /** Invert mouse pitch (flight-sim style). */
  invertY = false;
  sensitivity = 1;
  /** Touch-screen source (filled in by the touch overlay). */
  readonly touch = new TouchState();
  /** Touch-first device: no pointer lock, and the touch source is read. */
  touchMode = false;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedQueue.add(e.code);
      if (['Space', 'Tab', 'KeyF', 'KeyG', 'KeyQ', 'KeyE', 'ControlLeft'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons = 0;
      this.touch.clear();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    target.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons |= 1 << e.button;
      if (e.button === 2) this.pressedQueue.add('Mouse2');
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.buttons = 0;
    });
  }

  requestLock(): void {
    if (!this.locked && !this.touchMode) void this.target.requestPointerLock?.();
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** A one-frame press from a source that isn't the keyboard (an on-screen button). */
  queuePress(code: string): void {
    this.pressedQueue.add(code);
  }

  private key(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c) || this.touch.held.has(c));
  }

  read(dt: number): Controls {
    const k = (a: string, b: string) => (this.key(a) ? 1 : 0) - (this.key(b) ? 1 : 0);
    const sens = MOUSE_SENS * this.sensitivity;
    const c: Controls = {
      aimYaw: -this.mouseDX * sens,
      aimPitch: -this.mouseDY * sens * (this.invertY ? -1 : 1),
      throttle: k('KeyW', 'KeyS'),
      lateral: k('KeyD', 'KeyA'),
      vertical: k('KeyE', 'KeyQ') + (this.key('KeyC') || this.key('ControlLeft') ? -1 : 0),
      forward: 0,
      boost: this.key('ShiftLeft', 'ShiftRight'),
      brake: this.key('KeyX'),
      fire: (this.buttons & 1) !== 0,
      missile: (this.buttons & 4) !== 0,
      unibeam: this.key('Space'),
      flares: this.key('KeyF'),
      launcher: this.key('KeyG'),
      pressed: new Set(this.pressedQueue),
      zoom: this.wheel,
    };
    // Right button is the missile lock (hold, release to fire)
    c.missile = c.missile || (this.buttons & 2) !== 0;
    c.fire ||= this.touch.held.has('Mouse0');
    c.missile ||= this.touch.held.has('Mouse2');
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    this.pressedQueue.clear();
    c.vertical = Math.max(-1, Math.min(1, c.vertical));
    this.keyLateral = rampTo(this.keyLateral, c.lateral, dt);
    this.keyVertical = rampTo(this.keyVertical, c.vertical, dt);
    c.lateral = ease(this.keyLateral);
    c.vertical = ease(this.keyVertical);
    if (this.touchMode) applyTouch(c, this.touch, this.sensitivity, this.invertY, dt);
    this.readPad(c, dt);
    return c;
  }

  private readPad(c: Controls, dt: number): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return;
    const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
    const ax = (i: number) => dz(pad.axes[i] ?? 0);
    const btn = (i: number) => pad.buttons[i]?.value ?? 0;
    const shape = (v: number) => Math.sign(v) * v * v;
    c.aimYaw += -shape(ax(2)) * PAD_RATE * dt;
    c.aimPitch += -shape(ax(3)) * PAD_RATE * dt * (this.invertY ? -1 : 1);
    c.lateral += ax(0);
    c.forward += -ax(1);
    c.throttle += btn(7) - btn(6);
    c.vertical += btn(0) - btn(2);
    c.boost ||= btn(10) > 0.5;
    c.brake ||= btn(6) > 0.9;
    c.fire ||= btn(5) > 0.5;
    c.missile ||= btn(4) > 0.5;
    c.unibeam ||= btn(3) > 0.5;
    const edge = (i: number, name: string) => {
      const now = btn(i) > 0.5;
      if (now && !this.padPrev.get(i)) c.pressed.add(name);
      this.padPrev.set(i, now);
    };
    c.flares ||= btn(1) > 0.5;
    edge(11, 'KeyV');
    edge(9, 'Escape');
    edge(8, 'KeyH');
    edge(12, 'KeyN');
    c.vertical = Math.max(-1, Math.min(1, c.vertical));
    c.throttle = Math.max(-1, Math.min(1, c.throttle));
  }
}

/** Step a key axis toward its target at the ramp rate. */
function rampTo(x: number, goal: number, dt: number): number {
  const step = Math.min(dt, 0.1) / KEY_RAMP;
  return x + Math.max(-step, Math.min(step, goal - x));
}
/** Smoothstep the ramp (signed): no edge where the push starts or ends. */
function ease(x: number): number {
  const a = Math.min(1, Math.abs(x));
  return Math.sign(x) * a * a * (3 - 2 * a);
}
