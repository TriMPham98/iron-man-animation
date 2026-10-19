import './screens.css';

/**
 * Boot, title and pause screens over the sim: JARVIS-styled, quiet, and out
 * of the way the moment the suit is flying.
 *
 * The pause menu is a holographic panel: resume / restart / camera, the
 * controls reference (ground and flight), audio levels (master, effects,
 * JARVIS's voice) and a graphics preset. Mouse, keyboard (arrows, Enter,
 * Esc) and gamepad (D-pad / left stick, A, B, Start) all drive it; every
 * setting persists in localStorage. Styles: ./screens.css.
 */

type Row = [key: string, action: string];

/**
 * The controls reference. GROUND = on foot (the movement keys walk; Space
 * takes off and they fly), FLIGHT = in the air, ANY TIME = both.
 */
export const CONTROLS: { ground: Row[]; flight: Row[]; always: Row[] } = {
  ground: [
    ['MOUSE', 'look · turn'],
    ['W A S D', 'walk · sidestep'],
    ['SHIFT', 'run'],
    ['SPACE', 'take off'],
  ],
  flight: [
    ['MOUSE', 'aim / steer'],
    ['W / S', 'throttle'],
    ['A / D', 'roll · strafe'],
    ['SPACE', 'climb'],
    ['C', 'descend · land'],
    ['SHIFT', 'boost'],
    ['X', 'air brake · hover'],
    ['LMB', 'repulsors'],
    ['RMB', 'paint · fire rockets'],
    ['Q', 'unibeam'],
    ['F', 'flares'],
    ['G', 'forearm launchers'],
  ],
  always: [
    ['V', 'camera'],
    ['WHEEL', 'camera distance'],
    ['R', 'reset to the house'],
    ['N', 'call a wave'],
    ['ESC', 'pause'],
  ],
};

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY: Record<Quality, { label: string; note: string }> = {
  low: { label: 'LOW', note: '0.7× res · no shadows' },
  medium: { label: 'MEDIUM', note: '1.0× res' },
  high: { label: 'HIGH', note: '1.25× res' },
  ultra: { label: 'ULTRA', note: 'native' },
};

export interface Settings {
  invertY: boolean;
  sensitivity: number;
  /** Master volume (0–1). */
  volume: number;
  /** Effects volume (0–1). */
  sfx: number;
  /** JARVIS's voice volume (0–1). */
  voice: number;
  quality: Quality;
}

const DEFAULTS: Settings = { invertY: false, sensitivity: 1, volume: 0.9, sfx: 1, voice: 1, quality: 'ultra' };
const STORE = 'mk3-flight-settings';

/** What the pause menu's buttons do (wired by the app: src/flight/ui/flightSettings.ts). */
export interface PauseActions {
  restart?: () => void;
  /** Next camera; returns its name. */
  cycleCamera?: () => string;
  cameraName?: () => string;
  /** Resume without pointer lock (a pad or a key that can't take the lock). */
  forceResume?: () => void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const rows = (r: Row[]) => r.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('');

export class Screens {
  private readonly root: HTMLElement;
  private readonly boot: HTMLElement;
  private readonly title: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly lines: HTMLElement;
  private readonly bar: HTMLElement;
  private log: string[] = [];
  private readonly listeners: Array<(s: Settings) => void> = [];
  private onResume: () => void = () => {};
  private padRaf = 0;
  private padPrev: boolean[] = [];
  private padRepeat = 0;
  private padAxisHeld = 0;
  private lastFocus: HTMLElement | null = null;
  settings: Settings;
  /** The app's settings hook (kept for the app; others use {@link addSettingsListener}). */
  onSettings: (s: Settings) => void = () => {};
  actions: PauseActions = {};

  /**
   * @param root The UI layer (defaults to #flight-ui).
   * @param opts.embedded Flown into from the workshop: no boot screen.
   */
  constructor(root?: HTMLElement, opts: { embedded?: boolean } = {}) {
    this.root = root ?? document.getElementById('flight-ui')!;
    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Settings> | null;
      } catch {
        return null;
      }
    })();
    this.settings = { ...DEFAULTS, ...(saved ?? {}) };
    if (!(this.settings.quality in QUALITY)) this.settings.quality = DEFAULTS.quality;
    const keyCell = ([k, v]: Row) => `<div><b>${esc(k)}</b>${esc(v)}</div>`;
    const titleKeys =
      `<div class="kh">GROUND</div>${CONTROLS.ground.map(keyCell).join('')}` +
      `<div class="kh">FLIGHT</div>${CONTROLS.flight.slice(1).map(keyCell).join('')}` +
      `<div class="kh">ANY TIME</div>${CONTROLS.always.map(keyCell).join('')}`;
    const pct = (k: 'volume' | 'sfx' | 'voice', label: string, id: string) => `
      <div class="fp-field"><label for="${id}">${label}</label>
        <input class="fp-range" id="${id}" type="range" min="0" max="1" step="0.05" data-k="${k}">
        <output for="${id}"></output></div>`;
    this.root.innerHTML = `
      <div class="screen boot"><div class="ring"><div class="core"></div></div><div class="lines"></div><div class="bar"><i></i></div></div>
      <div class="screen title hidden"><a class="back" href="/" title="Back to the workshop">&#x2190; WORKSHOP</a><h1>MARK III</h1><div class="sub">FLIGHT · MALIBU · GOLDEN HOUR</div><div class="cta">CLICK TO ENGAGE</div><div class="keys">${titleKeys}</div></div>
      <div class="screen pause hidden" role="dialog" aria-modal="true" aria-labelledby="fp-title">
        <div class="fp-scrim" data-act="resume" title="Resume"></div>
        <div class="fp-panel">
          <i class="fp-sweep"></i><i class="fp-sweep2"></i>
          <i class="fp-corner tl"></i><i class="fp-corner tr"></i><i class="fp-corner bl"></i><i class="fp-corner br"></i>
          <header class="fp-head">
            <div class="fp-reactor" aria-hidden="true"></div>
            <div>
              <div class="fp-eyebrow">J.A.R.V.I.S. · FLIGHT SYSTEMS</div>
              <h2 id="fp-title">PAUSED</h2>
              <div class="fp-status"><span class="dot"></span>SIM HELD · MK III · <span data-cam-name></span> CAM</div>
            </div>
          </header>
          <div class="fp-body">
            <nav class="fp-nav" aria-label="Pause menu">
              <button class="fp-btn primary" data-act="resume">RESUME <kbd>ESC</kbd></button>
              <button class="fp-btn" data-act="restart">RESTART <small>at the house</small></button>
              <button class="fp-btn" data-act="camera">CAMERA <span class="val" data-cam-name></span></button>
              <div class="fp-sep"></div>
              <button class="fp-btn" data-tab="controls" role="tab" aria-selected="true" aria-controls="fp-controls">CONTROLS</button>
              <button class="fp-btn" data-tab="audio" role="tab" aria-selected="false" aria-controls="fp-audio">AUDIO</button>
              <button class="fp-btn" data-tab="graphics" role="tab" aria-selected="false" aria-controls="fp-graphics">GRAPHICS</button>
              <div class="fp-sep"></div>
              <a class="fp-btn exit" href="/" data-act="workshop">&#x2190; BACK TO WORKSHOP</a>
            </nav>
            <div class="fp-panes">
              <section class="fp-pane on" id="fp-controls" role="tabpanel" data-pane="controls">
                <div class="fp-h">AIM</div>
                <div class="fp-field"><label for="fp-sens">SENSITIVITY</label>
                  <input class="fp-range" id="fp-sens" type="range" min="0.3" max="2.5" step="0.05" data-k="sensitivity"><output for="fp-sens"></output></div>
                <div class="fp-field toggle"><span class="lbl" id="fp-inv-l">INVERT PITCH</span>
                  <button class="fp-switch" role="switch" aria-labelledby="fp-inv-l" data-k="invertY"></button></div>
                <div class="fp-ref" style="margin-top:16px">
                  <section><div class="fp-h">GROUND</div><div class="fp-rows" data-rows="ground">${rows(CONTROLS.ground)}</div></section>
                  <section><div class="fp-h">FLIGHT</div><div class="fp-rows" data-rows="flight">${rows(CONTROLS.flight)}</div></section>
                  <section class="wide"><div class="fp-h">ANY TIME</div><div class="fp-rows" data-rows="always">${rows(CONTROLS.always)}</div></section>
                  <section class="wide"><div class="fp-h">GAMEPAD</div><div class="fp-rows">${rows([
                    ['R STICK', 'aim'],
                    ['L STICK', 'move · strafe · roll'],
                    ['RT / LT', 'throttle · brake'],
                    ['A / X', 'climb · descend'],
                    ['RB / LB', 'repulsors · rockets'],
                    ['Y / B', 'unibeam · flares'],
                    ['L3 / R3', 'boost · camera'],
                    ['START', 'pause'],
                  ])}</div></section>
                </div>
              </section>
              <section class="fp-pane" id="fp-audio" role="tabpanel" data-pane="audio">
                <div class="fp-h">LEVELS</div>
                ${pct('volume', 'MASTER', 'fp-vol')}
                ${pct('sfx', 'EFFECTS', 'fp-sfx')}
                ${pct('voice', 'J.A.R.V.I.S.', 'fp-voice')}
                <p class="fp-note">Effects duck under JARVIS while he speaks.</p>
              </section>
              <section class="fp-pane" id="fp-graphics" role="tabpanel" data-pane="graphics">
                <div class="fp-h">QUALITY PRESET</div>
                <p class="fp-note">Resolution scale on top of the automatic frame-rate guard.</p>
                <div class="fp-seg" role="radiogroup" aria-label="Graphics quality">
                  ${(Object.keys(QUALITY) as Quality[])
                    .map((q) => `<button role="radio" data-q="${q}" aria-checked="false">${QUALITY[q].label}<small>${QUALITY[q].note}</small></button>`)
                    .join('')}
                </div>
              </section>
            </div>
          </div>
          <footer class="fp-foot">
            <span class="kb"><b>&#x2191;&#x2193;</b>navigate</span><span class="kb"><b>&#x2190;&#x2192;</b>adjust</span><span class="kb"><b>ENTER</b>select</span><span class="kb"><b>ESC</b>resume</span>
            <span class="pad"><b>D-PAD</b>navigate · adjust</span><span class="pad"><b>A</b>select</span><span class="pad"><b>B</b>back</span><span class="pad"><b>START</b>resume</span>
          </footer>
        </div>
      </div>`;
    this.boot = this.root.querySelector('.boot')!;
    this.title = this.root.querySelector('.title')!;
    this.pause = this.root.querySelector('.pause')!;
    this.lines = this.root.querySelector('.boot .lines')!;
    this.bar = this.root.querySelector('.boot .bar i')!;
    if (opts.embedded) {
      this.boot.style.transition = 'none';
      this.boot.classList.add('hidden');
    }
    this.bindPause();
    this.syncInputs();
  }

  /** Called with the settings whenever one changes (and not at once). */
  addSettingsListener(fn: (s: Settings) => void): void {
    this.listeners.push(fn);
  }

  private save(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.settings));
    } catch {
      /* private mode */
    }
    this.onSettings(this.settings);
    for (const fn of this.listeners) fn(this.settings);
  }

  private set<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.settings[k] = v;
    this.syncInputs();
    this.save();
  }

  /** Every control shows the current settings. */
  private syncInputs(): void {
    const s = this.settings;
    for (const input of this.pause.querySelectorAll<HTMLInputElement>('input.fp-range')) {
      const k = input.dataset.k as 'volume' | 'sfx' | 'voice' | 'sensitivity';
      input.value = String(s[k]);
      const p = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
      input.style.setProperty('--v', `${(p * 100).toFixed(1)}%`);
      const out = input.parentElement!.querySelector('output')!;
      out.textContent = k === 'sensitivity' ? `${s[k].toFixed(2)}×` : `${Math.round(s[k] * 100)}%`;
      input.setAttribute('aria-valuetext', out.textContent);
    }
    this.pause.querySelector('.fp-switch')!.setAttribute('aria-checked', String(s.invertY));
    for (const b of this.pause.querySelectorAll<HTMLElement>('[data-q]')) {
      const on = b.dataset.q === s.quality;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  private bindPause(): void {
    const p = this.pause;
    for (const input of p.querySelectorAll<HTMLInputElement>('input.fp-range')) {
      input.addEventListener('input', () => this.set(input.dataset.k as 'volume', Number(input.value)));
    }
    p.querySelector('.fp-switch')!.addEventListener('click', () => this.set('invertY', !this.settings.invertY));
    for (const b of p.querySelectorAll<HTMLElement>('[data-q]')) b.addEventListener('click', () => this.set('quality', b.dataset.q as Quality));
    for (const b of p.querySelectorAll<HTMLElement>('[data-tab]')) {
      b.addEventListener('click', () => this.showTab(b.dataset.tab!));
      b.addEventListener('focus', () => this.showTab(b.dataset.tab!));
    }
    p.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'resume') this.resume();
      else if (act === 'restart') {
        this.actions.restart?.();
        this.resume();
      } else if (act === 'camera') {
        this.actions.cycleCamera?.();
        this.showCamera();
      }
      // 'workshop' is a plain link
    });
    // On the window: focus may be anywhere (the canvas, the body) when it opens
    window.addEventListener('keydown', (e) => {
      if (this.paused) this.onKey(e);
    });
    p.addEventListener('pointermove', () => p.classList.remove('gamepad'));
  }

  private showTab(tab: string): void {
    for (const b of this.pause.querySelectorAll<HTMLElement>('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const s of this.pause.querySelectorAll<HTMLElement>('[data-pane]')) s.classList.toggle('on', s.dataset.pane === tab);
  }

  private showCamera(): void {
    const name = (this.actions.cameraName?.() ?? '').toUpperCase();
    for (const el of this.pause.querySelectorAll('[data-cam-name]')) el.textContent = name;
  }

  private resume(): void {
    if (!this.paused) return;
    this.onResume();
    // Pointer lock can be refused (no gesture: a pad, Esc, Chrome's re-lock
    // cooldown): resume anyway — a click on the view takes the mouse again
    setTimeout(() => {
      if (this.paused) this.actions.forceResume?.();
    }, 300);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  private navItems(): HTMLElement[] {
    return [...this.pause.querySelectorAll<HTMLElement>('.fp-nav .fp-btn')];
  }

  /** The focusable controls of the open pane, in order (a radio group is one stop). */
  private paneItems(): HTMLElement[] {
    const pane = this.pause.querySelector<HTMLElement>('.fp-pane.on');
    if (!pane) return [];
    return [...pane.querySelectorAll<HTMLElement>('input.fp-range, .fp-switch, [data-q][aria-checked="true"]')];
  }

  private focus(el: HTMLElement | undefined, pad = false): void {
    if (!el) return;
    for (const x of this.pause.querySelectorAll('.pad-focus')) x.classList.remove('pad-focus');
    if (pad) el.classList.add('pad-focus');
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
    this.lastFocus = el;
  }

  /** Moves focus up/down within the current column (the menu, or the open pane). */
  private move(dir: 1 | -1, pad = false): void {
    const active = document.activeElement as HTMLElement | null;
    const cur = active && this.pause.contains(active) ? active : this.lastFocus;
    const inPane = !!cur?.closest('.fp-panes');
    const list = inPane ? this.paneItems() : this.navItems();
    const i = cur ? list.indexOf(cur) : -1;
    this.focus(list[i < 0 ? 0 : (i + dir + list.length) % list.length], pad);
  }

  /** Left/right: adjust the focused control, or cross between the menu and the pane. */
  private adjust(dir: 1 | -1, pad = false): boolean {
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !this.pause.contains(cur)) return false;
    if (cur instanceof HTMLInputElement && cur.type === 'range') {
      const step = Number(cur.step) || 0.05;
      const v = Math.min(Number(cur.max), Math.max(Number(cur.min), Number(cur.value) + dir * step));
      this.set(cur.dataset.k as 'volume', +(Math.round(v / step) * step).toFixed(3));
      return true;
    }
    if (cur.dataset.q) {
      const qs = Object.keys(QUALITY) as Quality[];
      const i = qs.indexOf(cur.dataset.q as Quality);
      if (dir < 0 && i === 0) return this.toNav(pad);
      const next = qs[Math.min(qs.length - 1, Math.max(0, i + dir))];
      this.set('quality', next);
      this.focus(this.pause.querySelector<HTMLElement>(`[data-q="${next}"]`)!, pad);
      return true;
    }
    if (cur.classList.contains('fp-switch')) {
      if (dir < 0 && !this.settings.invertY) return this.toNav(pad);
      this.set('invertY', dir > 0);
      return true;
    }
    if (cur.dataset.act === 'camera') {
      this.actions.cycleCamera?.();
      this.showCamera();
      return true;
    }
    if (cur.dataset.tab && dir > 0) {
      this.focus(this.paneItems()[0], pad);
      return true;
    }
    return false;
  }

  private toNav(pad: boolean): boolean {
    const tab = this.pause.querySelector<HTMLElement>('[data-tab][aria-selected="true"]');
    this.focus(tab ?? this.navItems()[0], pad);
    return true;
  }

  /** B / Esc / Backspace: out of a pane first, then resume. */
  private back(pad = false): void {
    if ((document.activeElement as HTMLElement | null)?.closest('.fp-panes')) this.toNav(pad);
    else this.resume();
  }

  private onKey(e: KeyboardEvent): void {
    this.pause.classList.remove('gamepad');
    for (const x of this.pause.querySelectorAll('.pad-focus')) x.classList.remove('pad-focus');
    const k = e.key;
    let handled = true;
    if (k === 'ArrowDown') this.move(1);
    else if (k === 'ArrowUp') this.move(-1);
    else if (k === 'ArrowRight') handled = this.adjust(1);
    else if (k === 'ArrowLeft') handled = this.adjust(-1);
    else if (k === 'Escape' || k === 'Backspace') this.back();
    else if (k === 'Enter' || k === ' ') {
      const el = document.activeElement as HTMLElement | null;
      if (el && this.pause.contains(el) && !(el instanceof HTMLInputElement)) el.click();
      else handled = false;
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  /** Gamepad, while the menu is open: D-pad / left stick, A, B, Start. */
  private pollPad = (): void => {
    this.padRaf = requestAnimationFrame(this.pollPad);
    const pad = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected);
    if (!pad) return;
    const down = (i: number) => (pad.buttons[i]?.value ?? 0) > 0.5;
    const edge = (i: number) => {
      const now = down(i);
      const was = this.padPrev[i] ?? true; // held from before the menu opened: wait for a release
      this.padPrev[i] = now;
      return now && !was;
    };
    // Stick as a D-pad, with key-repeat
    const ay = pad.axes[1] ?? 0;
    const ax = pad.axes[0] ?? 0;
    const dirs: Array<[boolean, () => void]> = [
      [down(12) || ay < -0.6, () => this.move(-1, true)],
      [down(13) || ay > 0.6, () => this.move(1, true)],
      [down(14) || ax < -0.6, () => void this.adjust(-1, true)],
      [down(15) || ax > 0.6, () => void this.adjust(1, true)],
    ];
    const held = dirs.findIndex(([on]) => on);
    const now = performance.now();
    if (held >= 0) {
      if (this.padAxisHeld !== held + 1 || now > this.padRepeat) {
        this.padRepeat = now + (this.padAxisHeld === held + 1 ? 110 : 380);
        this.padAxisHeld = held + 1;
        this.pause.classList.add('gamepad');
        if (!this.pause.contains(document.activeElement)) this.focus(this.navItems()[0], true);
        else dirs[held][1]();
      }
    } else {
      this.padAxisHeld = 0;
    }
    if (edge(0)) {
      this.pause.classList.add('gamepad');
      const el = document.activeElement as HTMLElement | null;
      if (el && this.pause.contains(el)) el.click();
      else this.focus(this.navItems()[0], true);
    }
    if (edge(1)) this.back(true);
    if (edge(9)) this.resume();
  };

  // ── Boot / title ────────────────────────────────────────────────────────

  progress(p: number, line?: string): void {
    this.bar.style.width = `${Math.round(p * 100)}%`;
    if (line) {
      this.log.push(line);
      this.log = this.log.slice(-5);
      this.lines.innerHTML = this.log.map((l, i) => `<div style="opacity:${0.45 + (i / this.log.length) * 0.55}">${l}</div>`).join('');
    }
  }

  showTitle(onEngage: () => void, skip = false, opts: { handoff?: boolean } = {}): void {
    this.boot.classList.add('hidden');
    if (skip) return;
    if (opts.handoff) {
      // Arrived from the workshop: a lighter card over the hovering suit
      this.title.classList.add('handoff');
      this.title.querySelector('.cta')!.textContent = 'CLICK TO TAKE CONTROL';
    }
    this.title.classList.remove('hidden');
    const go = (e: Event) => {
      // The workshop link leaves; anywhere else engages
      if ((e.target as HTMLElement).closest('a')) return;
      this.title.removeEventListener('click', go);
      this.title.classList.add('hidden');
      onEngage();
    };
    this.title.addEventListener('click', go);
  }

  hideTitle(): void {
    this.boot.style.transition = 'none';
    this.boot.classList.add('hidden');
    this.title.classList.add('hidden');
  }

  /** Whether the pause menu is up. */
  get paused(): boolean {
    return !this.pause.classList.contains('hidden');
  }

  setPaused(paused: boolean, onResume: () => void): void {
    const was = this.paused;
    this.onResume = onResume;
    this.pause.classList.toggle('hidden', !paused);
    cancelAnimationFrame(this.padRaf);
    if (paused) {
      this.showCamera();
      this.syncInputs();
      if (!was) {
        this.padPrev = [];
        this.padAxisHeld = 0;
        this.pause.classList.toggle(
          'gamepad',
          [...(navigator.getGamepads?.() ?? [])].some((g) => g && g.connected),
        );
        // Focus lands on Resume (drawn as focused only for keys / pad)
        requestAnimationFrame(() => this.focus(this.navItems()[0], this.pause.classList.contains('gamepad')));
      }
      this.padRaf = requestAnimationFrame(this.pollPad);
    } else if (this.pause.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }

  fail(msg: string): void {
    this.progress(1, `<span style="color:#ff6a5a">${msg}</span>`);
  }
}
