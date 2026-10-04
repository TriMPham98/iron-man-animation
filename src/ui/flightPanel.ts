import { FLIGHT_CHECK_STEPS, FLIGHT_STEP_SIDES, type FlapId, type FlightCheckFrame } from '../animation/flightCheck';

/** Telemetry opens with the stabilizer step and stays through the hover. */
const TELEMETRY_FROM = FLIGHT_CHECK_STEPS[2].at;
/** Stabilizer surfaces shown as L / R deflection bars, top to bottom. */
const SURFACES: ReadonlyArray<readonly [string, string]> = [
  ['SHLDR', 'shoulder'],
  ['DORSAL', 'back'],
  ['THIGH', 'thigh'],
  ['CALF', 'calf'],
];
/** Attitude indicator scale: viewBox units per degree of pitch. */
const PX_PER_DEG = 3;
const DEG = 180 / Math.PI;

const ADI_SVG = `
<svg class="flight-adi" viewBox="-50 -50 100 100" aria-hidden="true">
  <defs><clipPath id="adi-clip"><circle r="42" /></clipPath></defs>
  <g clip-path="url(#adi-clip)">
    <g class="adi-world">
      <rect class="adi-sky" x="-120" y="-240" width="240" height="240" />
      <rect class="adi-ground" x="-120" y="0" width="240" height="240" />
      <line class="adi-horizon" x1="-120" x2="120" y1="0" y2="0" />
      ${[-20, -10, 10, 20]
        .map((d) => `<line class="adi-ladder" x1="${-Math.abs(d) / 2 - 6}" x2="${Math.abs(d) / 2 + 6}" y1="${-d * PX_PER_DEG}" y2="${-d * PX_PER_DEG}" />`)
        .join('')}
    </g>
  </g>
  <circle class="adi-ring" r="42" />
  <path class="adi-pointer" d="M0 -42 L-3 -47 L3 -47 Z" />
  <path class="adi-aircraft" d="M-22 0 H-8 L0 6 L8 0 H22" />
  <circle class="adi-dot" r="1.4" />
</svg>`;

/**
 * Pilot-style checklist for the flight-control check: each step lights up
 * while it runs and reads OK once done; per-side steps tick L and R off
 * separately. From the stabilizer step on, a telemetry block shows the
 * suit's attitude (artificial horizon), altitude and every stabilizer's
 * deflection, so the hover's gust corrections read as the controls working.
 */
export function createFlightPanel() {
  const root = document.getElementById('flight-panel');
  const list = document.getElementById('flight-list');
  const count = document.getElementById('flight-count');
  const rows: HTMLLIElement[] = [];
  if (list) {
    list.textContent = '';
    for (const step of FLIGHT_CHECK_STEPS) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="flight-item">${step.item}</span><span class="flight-group">${step.group}</span><span class="flight-state"></span>`;
      list.appendChild(li);
      rows.push(li);
    }
  }

  // Telemetry block (built here so the markup lives with its updater)
  const tele = document.createElement('div');
  tele.className = 'flight-telemetry';
  tele.innerHTML = `
    ${ADI_SVG}
    <div class="flight-tele-side">
      <dl class="flight-readouts">
        <div><dt>PITCH</dt><dd data-k="pitch">+0.0°</dd></div>
        <div><dt>ROLL</dt><dd data-k="roll">+0.0°</dd></div>
        <div><dt>ALT</dt><dd data-k="alt">0 CM</dd></div>
      </dl>
      <div class="flight-flaps">
        ${SURFACES.map(
          ([label, id]) =>
            `<div class="flight-flap"><span class="flap-bar flap-l"><i data-f="${id}.L"></i></span><span class="flap-name">${label}</span><span class="flap-bar flap-r"><i data-f="${id}.R"></i></span></div>`,
        ).join('')}
      </div>
    </div>`;
  root?.appendChild(tele);
  const world = tele.querySelector<SVGGElement>('.adi-world');
  const readout = (k: string) => tele.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
  const pitchEl = readout('pitch');
  const rollEl = readout('roll');
  const altEl = readout('alt');
  const bars = [...tele.querySelectorAll<HTMLElement>('[data-f]')].map((el) => ({
    el,
    id: el.dataset.f as FlapId,
  }));
  let teleOn = false;
  let lastText = '';

  let shown = false;
  let lastIdx = -2;
  let lastSides = '';

  const hide = () => {
    if (!root || !shown) return;
    shown = false;
    lastIdx = -2;
    lastSides = '';
    root.classList.remove('is-visible');
    root.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => {
      if (!shown) root.hidden = true;
    }, 450);
  };

  const sign = (v: number, digits: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

  const updateTelemetry = (f: FlightCheckFrame | undefined, on: boolean) => {
    if (on !== teleOn) {
      teleOn = on;
      tele.classList.toggle('is-open', on);
    }
    if (!on || !f) return;
    const pitch = (f.pose.pitch ?? 0) * DEG;
    const roll = (f.pose.roll ?? 0) * DEG;
    // The horizon banks against the suit and rides down as the nose drops
    world?.setAttribute('transform', `rotate(${(-roll).toFixed(2)}) translate(0 ${(-pitch * PX_PER_DEG).toFixed(2)})`);
    const alt = Math.max(0, Math.round((f.pose.lift ?? 0) * 100));
    const text = `${sign(pitch, 1)}|${sign(roll, 1)}|${alt}`;
    if (text !== lastText) {
      lastText = text;
      pitchEl.textContent = `${sign(pitch, 1)}°`;
      rollEl.textContent = `${sign(roll, 1)}°`;
      altEl.textContent = `${alt} CM`;
    }
    for (const b of bars) b.el.style.transform = `scaleX(${(f.flaps[b.id] ?? 0).toFixed(3)})`;
  };

  return {
    /** Flight-check clock `t`, or null when the check is not running. */
    update(t: number | null, active: boolean, f?: FlightCheckFrame): void {
      if (!root) return;
      if (t === null || (!active && t < FLIGHT_CHECK_STEPS[0].at)) {
        hide();
        return;
      }
      if (!shown) {
        shown = true;
        root.hidden = false;
        void root.offsetWidth;
        root.classList.add('is-visible');
        root.setAttribute('aria-hidden', 'false');
      }
      updateTelemetry(f, active && t >= TELEMETRY_FROM);
      let idx = -1;
      FLIGHT_CHECK_STEPS.forEach((s, i) => {
        if (t >= s.at) idx = i;
      });
      // Past the end: everything checked
      if (!active) idx = FLIGHT_CHECK_STEPS.length;
      // Per-side progress of the running step (L / R tick off separately)
      const sides = active ? FLIGHT_STEP_SIDES[idx] : null;
      const sideKey = sides ? `${t >= sides[0] ? 1 : 0}${t >= sides[1] ? 1 : 0}` : '';
      if (idx === lastIdx && sideKey === lastSides) return;
      lastIdx = idx;
      lastSides = sideKey;
      rows.forEach((li, i) => {
        li.classList.toggle('is-done', i < idx);
        li.classList.toggle('is-active', i === idx);
        const st = li.querySelector('.flight-state');
        if (!st) return;
        if (i === idx && sides) {
          st.innerHTML = `<b class="${sideKey[0] === '1' ? 'is-ok' : ''}">L</b><b class="${sideKey[1] === '1' ? 'is-ok' : ''}">R</b>`;
        } else {
          st.textContent = i < idx ? 'OK' : i === idx ? '···' : '';
        }
      });
      if (count) count.textContent = `${Math.min(idx, rows.length)}/${rows.length}`;
    },
    hide,
  };
}
