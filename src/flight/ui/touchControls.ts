import './touchControls.css';
import type { Input } from '../sim/input';
import { inBoostRing, sideRole, stickOrigin, stickVector, TOUCH_BINDINGS, type TouchAction } from '../sim/touchMath';

/**
 * On-screen controls for touch-first devices, laid over the flight view:
 * a floating stick under one thumb (throttle · roll / strafe; shoved out
 * to its forward ring it boosts, or launches from the ground), a cluster of
 * buttons under the other, and drag-to-aim anywhere else. Everything lands
 * in the Input's touch source (src/flight/sim/touchMath.ts), read through
 * the same path as the keyboard. Each finger is tracked by its pointerId,
 * so the stick, a drag and any buttons all work at once.
 */

interface Button {
  act: TouchAction | 'pause' | 'refit';
  label: string;
  /** Dragging a finger held on it aims too (fire while steering). */
  aims?: boolean;
  /** Held (vs a one-shot tap). */
  hold?: boolean;
}

/** The cluster (placed on a 3 × 2 grid by the CSS, the fire button beside it). */
const CLUSTER: Button[] = [
  { act: 'wave', label: 'WAVE' },
  { act: 'flares', label: 'FLR', hold: true },
  { act: 'unibeam', label: 'BEAM', hold: true, aims: true },
  { act: 'launcher', label: 'POD', hold: true },
  { act: 'brake', label: 'BRAKE', hold: true },
  { act: 'missile', label: 'MSL', hold: true, aims: true },
  { act: 'fire', label: 'FIRE', hold: true, aims: true },
];
const TOP: Button[] = [
  { act: 'pause', label: 'II' },
  { act: 'camera', label: 'CAM' },
  { act: 'land', label: 'LAND' },
  { act: 'refit', label: 'REFIT' },
];
const ALL = new Map([...CLUSTER, ...TOP].map((b) => [b.act, b]));

type Finger =
  | { kind: 'stick'; ox: number; oy: number }
  | { kind: 'look'; x: number; y: number }
  | { kind: 'button'; act: TouchAction; el: HTMLElement; x: number; y: number; aims: boolean };

export class TouchControls {
  readonly root: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly fingers = new Map<number, Finger>();
  private active = false;
  private leftHanded = false;
  private inset = 0;

  constructor(
    private readonly input: Input,
    parent: HTMLElement,
    private readonly onPause: () => void,
    private readonly onRefit: () => void = () => {},
  ) {
    const btn = (b: Button) => `<button type="button" class="tc-btn tc-${b.act}" data-act="${b.act}" aria-label="${b.act}">${b.label}</button>`;
    this.root = document.createElement('div');
    this.root.className = 'tc-layer tc-off';
    this.root.innerHTML = `
      <div class="tc-stick"><i class="tc-ring"></i><i class="tc-knob"></i></div>
      <div class="tc-top">${TOP.map(btn).join('')}</div>
      <div class="tc-cluster">${CLUSTER.map(btn).join('')}</div>`;
    this.stick = this.root.querySelector('.tc-stick')!;
    this.knob = this.root.querySelector('.tc-knob')!;
    parent.append(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    // No compat mouse events / click after a touch: the pause button's tap
    // would land on the menu it just opened (its scrim resumes)
    for (const ev of ['touchstart', 'touchmove'] as const) this.root.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

    this.root.addEventListener('pointerdown', (e) => this.down(e));
    this.root.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.root.addEventListener(ev, (e) => this.up(e));
    window.addEventListener('blur', () => this.releaseAll());
  }

  /** Shown and live only while the pilot is flying (not on the title / pause). */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.root.classList.toggle('tc-off', !on);
    if (!on) this.releaseAll();
    this.measure();
  }

  /** The WAVE button shows only while a wave can be called. */
  setWaveReady(on: boolean): void {
    this.root.classList.toggle('tc-wave-ready', on);
  }

  /** The LAND button shows only while auto-land can take the suit down (or is, to hand it back). */
  setLandReady(on: boolean): void {
    this.root.classList.toggle('tc-land-ready', on);
  }

  /** The REFIT button shows only while the suit can be refitted (on the pad, or lost). */
  setRefitReady(on: boolean): void {
    this.root.classList.toggle('tc-refit-ready', on);
  }

  setOpacity(v: number): void {
    this.root.style.setProperty('--tc-alpha', String(Math.max(0.2, Math.min(1, v))));
  }

  setLeftHanded(on: boolean): void {
    if (on === this.leftHanded) return;
    this.leftHanded = on;
    this.root.classList.toggle('tc-lh', on);
    this.releaseAll();
    this.measure();
  }

  /** The band along the bottom the controls take (CSS px), for the HUD to clear. */
  get bottomInset(): number {
    return this.active ? this.inset : 0;
  }

  /** Fits the layer to the view (CSS px, FlightApp.syncViewport), so the thumbs sit on what's visible. */
  fit(w: number, h: number): void {
    Object.assign(this.root.style, { right: 'auto', bottom: 'auto', width: `${w}px`, height: `${h}px` });
    this.measure();
  }

  private measure(): void {
    requestAnimationFrame(() => {
      const h = this.root.clientHeight || window.innerHeight;
      const tops = [this.stick, this.root.querySelector('.tc-cluster')!].map((el) => el.getBoundingClientRect().top);
      this.inset = Math.max(0, h - Math.min(...tops) + 8);
    });
  }

  private down(e: PointerEvent): void {
    if (!this.active) return;
    e.preventDefault();
    this.root.setPointerCapture?.(e.pointerId);
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (el) {
      const b = ALL.get(el.dataset.act as Button['act'])!;
      buzz(b.act === 'fire' ? 6 : 10);
      el.classList.add('on');
      if (b.act === 'pause' || b.act === 'refit') {
        setTimeout(() => el.classList.remove('on'), 120);
        if (b.act === 'pause') this.onPause();
        else this.onRefit();
        return;
      }
      this.input.queuePress(TOUCH_BINDINGS[b.act]);
      if (!b.hold) {
        setTimeout(() => el.classList.remove('on'), 120);
        return;
      }
      this.input.touch.press(b.act);
      this.fingers.set(e.pointerId, { kind: 'button', act: b.act, el, x: e.clientX, y: e.clientY, aims: !!b.aims });
      return;
    }
    const w = this.root.clientWidth || window.innerWidth;
    const side = e.clientX < w * 0.4 ? 'left' : e.clientX > w * 0.6 ? 'right' : null;
    if (side && sideRole(side, this.leftHanded) === 'stick' && ![...this.fingers.values()].some((f) => f.kind === 'stick')) {
      // Floating stick: the base comes to the thumb
      const r = this.stick.offsetWidth / 2;
      const o = stickOrigin(e.clientX, e.clientY, r + 6, w, this.root.clientHeight || window.innerHeight);
      this.fingers.set(e.pointerId, { kind: 'stick', ox: o.x, oy: o.y });
      this.stick.classList.add('on');
      this.stick.style.transform = `translate(${o.x - this.stickRest().x}px, ${o.y - this.stickRest().y}px)`;
      this.updateStick(e.clientX - o.x, e.clientY - o.y);
      return;
    }
    this.fingers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY });
  }

  private move(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    e.preventDefault();
    if (f.kind === 'stick') {
      this.updateStick(e.clientX - f.ox, e.clientY - f.oy);
    } else if (f.kind === 'look' || f.aims) {
      this.input.touch.lookDX += e.clientX - f.x;
      this.input.touch.lookDY += e.clientY - f.y;
      f.x = e.clientX;
      f.y = e.clientY;
    }
  }

  private up(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    if (f.kind === 'stick') {
      this.input.touch.stickX = this.input.touch.stickY = 0;
      this.setBoost(false);
      this.stick.classList.remove('on');
      this.stick.style.transform = '';
      this.knob.style.transform = '';
    } else if (f.kind === 'button') {
      // Two fingers on one button: it's held until the last lifts
      if (![...this.fingers.values()].some((o) => o.kind === 'button' && o.act === f.act)) {
        this.input.touch.release(f.act);
        f.el.classList.remove('on');
      }
    }
  }

  private updateStick(dx: number, dy: number): void {
    const r = this.stick.offsetWidth / 2;
    const v = stickVector(dx, dy, r, 0.15);
    this.input.touch.stickX = v.x;
    this.input.touch.stickY = v.y;
    this.setBoost(inBoostRing(dx, dy, r, this.input.touch.boost));
    // The knob stops with its rim on the ring
    this.knob.style.transform = `translate(${v.knobX * 0.77}px, ${v.knobY * 0.77}px)`;
  }

  /** The stick's ring: holds boost (Left Shift), lights the ring, ticks on the way in. */
  private setBoost(on: boolean): void {
    const t = this.input.touch;
    if (on === t.boost) return;
    t.boost = on;
    if (on) {
      t.press('boost');
      buzz(18);
    } else {
      t.release('boost');
    }
    this.stick.classList.toggle('tc-boosting', on);
  }

  /** The stick's resting centre (its laid-out place, untransformed). */
  private stickRest(): { x: number; y: number } {
    const el = this.stick;
    const r = el.offsetWidth / 2;
    return { x: el.offsetLeft + r, y: el.offsetTop + r };
  }

  private releaseAll(): void {
    for (const id of this.fingers.keys()) this.up(new PointerEvent('pointercancel', { pointerId: id }));
    this.fingers.clear();
    this.input.touch.clear();
    for (const el of this.root.querySelectorAll('.on')) el.classList.remove('on');
    this.stick.classList.remove('tc-boosting');
    this.stick.style.transform = this.knob.style.transform = '';
  }
}

/** A short tick under the thumb, where the device has one. */
function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not allowed here */
  }
}
