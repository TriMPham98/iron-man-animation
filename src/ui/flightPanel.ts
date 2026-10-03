import { FLIGHT_CHECK_STEPS } from '../animation/flightCheck';

/**
 * Pilot-style checklist for the flight-control check: each step lights up
 * while it runs and reads OK once done.
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
  let shown = false;
  let lastIdx = -2;

  const hide = () => {
    if (!root || !shown) return;
    shown = false;
    lastIdx = -2;
    root.classList.remove('is-visible');
    root.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => {
      if (!shown) root.hidden = true;
    }, 450);
  };

  return {
    /** Flight-check clock `t`, or null when the check is not running. */
    update(t: number | null, active: boolean): void {
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
      let idx = -1;
      FLIGHT_CHECK_STEPS.forEach((s, i) => {
        if (t >= s.at) idx = i;
      });
      // Past the end: everything checked
      if (!active) idx = FLIGHT_CHECK_STEPS.length;
      if (idx === lastIdx) return;
      lastIdx = idx;
      rows.forEach((li, i) => {
        li.classList.toggle('is-done', i < idx);
        li.classList.toggle('is-active', i === idx);
        const st = li.querySelector('.flight-state');
        if (st) st.textContent = i < idx ? 'OK' : i === idx ? '···' : '';
      });
      if (count) count.textContent = `${Math.min(idx, rows.length)}/${rows.length}`;
    },
    hide,
  };
}
