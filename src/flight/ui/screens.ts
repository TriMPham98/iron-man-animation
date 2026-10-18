/**
 * Boot, title and pause screens over the sim: JARVIS-styled, quiet, and out
 * of the way the moment the suit is flying.
 */

const CSS = /* css */ `
#flight-ui { position: fixed; inset: 0; z-index: 5; pointer-events: none; font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; color: #e8f6ff; }
#flight-ui .screen { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity 0.9s ease; }
#flight-ui .screen.hidden { opacity: 0; pointer-events: none !important; }
#flight-ui .boot { background: #050a12; pointer-events: auto; }
#flight-ui .boot .ring { width: 92px; height: 92px; border-radius: 50%; border: 1px solid rgba(126,232,255,0.25); position: relative; margin-bottom: 28px; box-shadow: 0 0 40px rgba(126,232,255,0.15) inset; }
#flight-ui .boot .ring::after { content: ''; position: absolute; inset: 10px; border-radius: 50%; border: 2px solid transparent; border-top-color: #7ee8ff; animation: fspin 1.1s linear infinite; }
#flight-ui .boot .core { position: absolute; inset: 34px; border-radius: 50%; background: radial-gradient(circle, #e8fcff 0%, #7ee8ff 45%, rgba(126,232,255,0) 75%); filter: blur(0.5px); }
@keyframes fspin { to { transform: rotate(360deg); } }
#flight-ui .boot .lines { font-size: 11px; letter-spacing: 0.12em; color: rgba(126,232,255,0.75); min-height: 7.5em; text-align: left; width: min(26rem, 86vw); line-height: 1.5; }
#flight-ui .boot .bar { width: min(26rem, 86vw); height: 2px; background: rgba(126,232,255,0.15); margin-top: 14px; }
#flight-ui .boot .bar i { display: block; height: 100%; width: 0; background: #7ee8ff; box-shadow: 0 0 10px #7ee8ff; transition: width 0.3s ease; }
#flight-ui .title { pointer-events: auto; cursor: pointer; background: linear-gradient(90deg, rgba(3,8,14,0.62) 0%, rgba(3,8,14,0.2) 42%, rgba(3,8,14,0) 60%); justify-content: center; align-items: flex-start; padding-left: 7vw; }
#flight-ui .title h1 { font-family: Michroma, sans-serif; font-weight: 400; font-size: clamp(30px, 4.6vw, 66px); letter-spacing: 0.3em; margin: 0; color: #fff; text-shadow: 0 0 30px rgba(126,232,255,0.35); }
#flight-ui .title .sub { font-family: Michroma, sans-serif; font-size: clamp(9px, 1vw, 12px); letter-spacing: 0.5em; color: rgba(126,232,255,0.85); margin: 12px 0 34px 0.2em; }
#flight-ui .title .cta { font-family: Michroma, sans-serif; font-size: 12px; letter-spacing: 0.4em; padding: 14px 30px 14px 34px; border: 1px solid rgba(126,232,255,0.55); color: #e8fcff; background: rgba(6,16,26,0.35); animation: fpulse 2.4s ease-in-out infinite; }
@keyframes fpulse { 50% { box-shadow: 0 0 26px rgba(126,232,255,0.35); border-color: rgba(126,232,255,0.95); } }
#flight-ui .keys { display: grid; grid-template-columns: repeat(2, auto); gap: 6px 26px; margin-top: 34px; font-size: 10.5px; letter-spacing: 0.06em; color: rgba(232,246,255,0.72); }
#flight-ui .keys b { color: #7ee8ff; font-weight: 600; margin-right: 8px; }
#flight-ui .pause .keys { grid-template-columns: repeat(4, auto); }
#flight-ui .pause { pointer-events: auto; cursor: pointer; background: rgba(3,8,14,0.62); backdrop-filter: blur(3px); }
#flight-ui .pause h2 { font-family: Michroma, sans-serif; font-weight: 400; letter-spacing: 0.4em; font-size: 20px; margin: 0 0 8px; }
#flight-ui .pause .hint { font-size: 11px; color: rgba(126,232,255,0.8); letter-spacing: 0.2em; }
#flight-ui .opts { display: flex; gap: 22px; margin-top: 26px; font-size: 11px; pointer-events: auto; }
#flight-ui .opts label { display: flex; align-items: center; gap: 8px; color: rgba(232,246,255,0.8); cursor: pointer; }
#flight-ui .opts input[type=range] { accent-color: #7ee8ff; width: 110px; }
#flight-ui .opts input[type=checkbox] { accent-color: #7ee8ff; }
@media (max-width: 720px) { #flight-ui .keys { grid-template-columns: repeat(2, auto); } }
`;

const KEYS: Array<[string, string]> = [
  ['MOUSE', 'aim / steer'],
  ['W / S', 'throttle'],
  ['A / D', 'roll · strafe'],
  ['SPACE / C', 'climb · descend'],
  ['SHIFT', 'boost'],
  ['X', 'air brake · hover'],
  ['LMB', 'repulsors'],
  ['RMB', 'paint · fire rockets'],
  ['Q', 'unibeam'],
  ['F', 'flares'],
  ['G', 'forearm launchers'],
  ['V', 'camera'],
  ['N', 'call a wave'],
  ['R', 'reset to the house'],
  ['WHEEL', 'camera distance'],
  ['ESC', 'pause'],
];

export interface Settings {
  invertY: boolean;
  sensitivity: number;
  volume: number;
}

export class Screens {
  private readonly root: HTMLElement;
  private readonly boot: HTMLElement;
  private readonly title: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly lines: HTMLElement;
  private readonly bar: HTMLElement;
  private log: string[] = [];
  settings: Settings;
  onSettings: (s: Settings) => void = () => {};

  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.getElementById('flight-ui')!;
    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem('mk3-flight-settings') ?? 'null') as Settings | null;
      } catch {
        return null;
      }
    })();
    this.settings = { invertY: false, sensitivity: 1, volume: 0.9, ...(saved ?? {}) };
    const keys = KEYS.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
    this.root.innerHTML = `
      <div class="screen boot"><div class="ring"><div class="core"></div></div><div class="lines"></div><div class="bar"><i></i></div></div>
      <div class="screen title hidden"><h1>MARK III</h1><div class="sub">FLIGHT · MALIBU · GOLDEN HOUR</div><div class="cta">CLICK TO ENGAGE</div><div class="keys">${keys}</div></div>
      <div class="screen pause hidden"><h2>PAUSED</h2><div class="hint">CLICK TO RESUME</div><div class="keys">${keys}</div>
        <div class="opts">
          <label><input type="checkbox" data-k="invertY"> invert pitch</label>
          <label>sensitivity <input type="range" min="0.3" max="2.5" step="0.05" data-k="sensitivity"></label>
          <label>volume <input type="range" min="0" max="1" step="0.02" data-k="volume"></label>
        </div></div>`;
    this.boot = this.root.querySelector('.boot')!;
    this.title = this.root.querySelector('.title')!;
    this.pause = this.root.querySelector('.pause')!;
    this.lines = this.root.querySelector('.boot .lines')!;
    this.bar = this.root.querySelector('.boot .bar i')!;
    for (const input of this.root.querySelectorAll<HTMLInputElement>('.opts input')) {
      const k = input.dataset.k as keyof Settings;
      if (input.type === 'checkbox') input.checked = this.settings[k] as boolean;
      else input.value = String(this.settings[k]);
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('input', () => {
        (this.settings as unknown as Record<string, unknown>)[k] = input.type === 'checkbox' ? input.checked : Number(input.value);
        try {
          localStorage.setItem('mk3-flight-settings', JSON.stringify(this.settings));
        } catch {
          /* private mode */
        }
        this.onSettings(this.settings);
      });
    }
    for (const label of this.root.querySelectorAll('.opts label')) label.addEventListener('click', (e) => e.stopPropagation());
  }

  progress(p: number, line?: string): void {
    this.bar.style.width = `${Math.round(p * 100)}%`;
    if (line) {
      this.log.push(line);
      this.log = this.log.slice(-5);
      this.lines.innerHTML = this.log.map((l, i) => `<div style="opacity:${0.45 + (i / this.log.length) * 0.55}">${l}</div>`).join('');
    }
  }

  showTitle(onEngage: () => void, skip = false): void {
    this.boot.classList.add('hidden');
    if (skip) return;
    this.title.classList.remove('hidden');
    const go = () => {
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

  setPaused(paused: boolean, onResume: () => void): void {
    this.pause.classList.toggle('hidden', !paused);
    this.pause.onclick = paused ? onResume : null;
  }

  fail(msg: string): void {
    this.progress(1, `<span style="color:#ff6a5a">${msg}</span>`);
  }
}
