import './soundboard.css';
import { soundUrl } from '../audio/sounds';
import { SOUNDS, type SequenceEvent, type SoundDef } from './sounds';

const padsEl = document.getElementById('pads')!;
const speedEl = document.getElementById('speed') as HTMLInputElement;
const speedValueEl = document.getElementById('speed-value')!;
const export1xEl = document.getElementById('export-1x') as HTMLInputElement;
const btnRec = document.getElementById('btn-rec') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const btnReplay = document.getElementById('btn-replay') as HTMLButtonElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;
const recStatus = document.getElementById('rec-status')!;
const recClock = document.getElementById('rec-clock')!;
const eventList = document.getElementById('event-list')!;
const eventCount = document.getElementById('event-count')!;
const exportOut = document.getElementById('export-out') as HTMLTextAreaElement;

let playbackRate = 1;
let recording = false;
let recStart = 0;
let clockRaf = 0;
const events: SequenceEvent[] = [];
/** Active HTMLAudioElements so we can stop/replay cleanly. */
const active: HTMLAudioElement[] = [];
let replayTimers: number[] = [];

function fmt(sec: number, digits = 3): string {
  return sec.toFixed(digits);
}

function setSpeed(rate: number): void {
  playbackRate = rate;
  speedValueEl.textContent = `${rate.toFixed(2)}×`;
}

function stopAllAudio(): void {
  for (const a of active) {
    a.pause();
    a.src = '';
  }
  active.length = 0;
}

function cancelReplay(): void {
  for (const id of replayTimers) window.clearTimeout(id);
  replayTimers = [];
}

function playSound(def: SoundDef, rate = playbackRate): HTMLAudioElement {
  const audio = new Audio(soundUrl(def.file));
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  active.push(audio);
  audio.addEventListener(
    'ended',
    () => {
      const i = active.indexOf(audio);
      if (i >= 0) active.splice(i, 1);
    },
    { once: true },
  );
  void audio.play().catch(() => {
    /* autoplay blocked until first gesture — ignore */
  });
  return audio;
}

function flashPad(id: string): void {
  const pad = padsEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (!pad) return;
  pad.classList.remove('hit');
  // reflow so rapid re-hits restart the flash animation
  void pad.offsetWidth;
  pad.classList.add('hit');
  const onEnd = () => {
    pad.classList.remove('hit');
    pad.removeEventListener('animationend', onEnd);
  };
  pad.addEventListener('animationend', onEnd);
}

function onPad(def: SoundDef): void {
  playSound(def);
  flashPad(def.id);

  if (!recording) return;

  const wallT = (performance.now() - recStart) / 1000;
  const rate = playbackRate;
  const ev: SequenceEvent = {
    wallT,
    t1x: wallT * rate,
    id: def.id,
    label: def.label,
    rate,
  };
  events.push(ev);
  renderEvents();
  renderExport();
}

function renderPads(): void {
  padsEl.replaceChildren();
  for (const def of SOUNDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pad';
    btn.dataset.id = def.id;
    btn.setAttribute('aria-label', `${def.label} (${def.key})`);
    btn.innerHTML = `
      <span class="pad-key">${escapeHtml(def.key.toUpperCase())}</span>
      <span class="pad-label">${escapeHtml(def.label)}</span>
      <span class="pad-id">${escapeHtml(def.id)}</span>
    `;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onPad(def);
    });
    padsEl.appendChild(btn);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderEvents(): void {
  eventList.replaceChildren();
  eventCount.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  btnReplay.disabled = events.length === 0;
  btnCopy.disabled = events.length === 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const li = document.createElement('li');
    li.className = 'sb-event';
    li.innerHTML = `
      <span class="ev-i">${String(i + 1).padStart(2, '0')}</span>
      <span class="ev-t" title="wall / 1×">${fmt(ev.wallT)}s · 1× ${fmt(ev.t1x)}s</span>
      <span class="ev-id">${escapeHtml(ev.id)}</span>
      <button type="button" class="ev-del" data-i="${i}" aria-label="Remove event">×</button>
    `;
    eventList.appendChild(li);
  }
}

function buildCard(): string {
  const use1x = export1xEl.checked;
  const lines: string[] = [
    '## Sound sequence',
    '',
    `playbackRate: ${playbackRate.toFixed(2)} (last UI speed)`,
    `exportScale: ${use1x ? '1x (wallT × rate at hit)' : 'wall-clock'}`,
    `events: ${events.length}`,
    '',
  ];

  if (events.length === 0) {
    lines.push('(no events)');
    return lines.join('\n');
  }

  lines.push('| # | t (s) | id | label |');
  lines.push('|---|------:|----|-------|');
  events.forEach((ev, i) => {
    const t = use1x ? ev.t1x : ev.wallT;
    lines.push(
      `| ${i + 1} | ${fmt(t)} | \`${ev.id}\` | ${ev.label} |`,
    );
  });

  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        unit: 'seconds',
        scale: use1x ? '1x' : 'wall',
        events: events.map((ev) => ({
          t: Number((use1x ? ev.t1x : ev.wallT).toFixed(3)),
          id: ev.id,
          wallT: Number(ev.wallT.toFixed(3)),
          t1x: Number(ev.t1x.toFixed(3)),
          rate: ev.rate,
        })),
      },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('');
  lines.push('<!-- paste this card in chat for animation timing -->');

  return lines.join('\n');
}

function renderExport(): void {
  exportOut.value = buildCard();
}

function tickClock(): void {
  if (!recording) return;
  const t = (performance.now() - recStart) / 1000;
  recClock.textContent = `${fmt(t)}s`;
  clockRaf = requestAnimationFrame(tickClock);
}

function startRec(): void {
  cancelReplay();
  stopAllAudio();
  events.length = 0;
  recording = true;
  recStart = performance.now();
  recStatus.textContent = 'recording';
  recStatus.classList.add('live');
  btnRec.disabled = true;
  btnStop.disabled = false;
  renderEvents();
  renderExport();
  cancelAnimationFrame(clockRaf);
  tickClock();
}

function stopRec(): void {
  recording = false;
  recStatus.textContent = events.length ? 'stopped' : 'idle';
  recStatus.classList.remove('live');
  btnRec.disabled = false;
  btnStop.disabled = true;
  cancelAnimationFrame(clockRaf);
  renderExport();
}

function clearAll(): void {
  stopRec();
  cancelReplay();
  stopAllAudio();
  events.length = 0;
  recClock.textContent = '0.000s';
  recStatus.textContent = 'idle';
  renderEvents();
  renderExport();
}

function replaySequence(): void {
  if (events.length === 0) return;
  cancelReplay();
  stopAllAudio();

  const use1x = export1xEl.checked;
  // Replay at current UI speed relative to the chosen time scale.
  // wall times → delay = wallT / rate; 1x times → delay = t1x / rate
  const rate = playbackRate;

  recStatus.textContent = 'replaying';
  for (const ev of events) {
    const baseT = use1x ? ev.t1x : ev.wallT;
    const delayMs = (baseT / rate) * 1000;
    const def = SOUNDS.find((s) => s.id === ev.id);
    if (!def) continue;
    const timer = window.setTimeout(() => {
      playSound(def, rate);
      flashPad(def.id);
    }, delayMs);
    replayTimers.push(timer);
  }

  const last = events[events.length - 1]!;
  const endT = (use1x ? last.t1x : last.wallT) / rate;
  const done = window.setTimeout(() => {
    recStatus.textContent = recording ? 'recording' : 'stopped';
  }, endT * 1000 + 50);
  replayTimers.push(done);
}

async function copyCard(): Promise<void> {
  renderExport();
  const text = exportOut.value;
  try {
    await navigator.clipboard.writeText(text);
    const prev = btnCopy.textContent;
    btnCopy.textContent = 'COPIED';
    window.setTimeout(() => {
      btnCopy.textContent = prev;
    }, 1200);
  } catch {
    exportOut.select();
    document.execCommand('copy');
  }
}

// —— wire UI ——
speedEl.addEventListener('input', () => {
  setSpeed(Number(speedEl.value));
});
export1xEl.addEventListener('change', renderExport);
btnRec.addEventListener('click', startRec);
btnStop.addEventListener('click', stopRec);
btnClear.addEventListener('click', clearAll);
btnReplay.addEventListener('click', replaySequence);
btnCopy.addEventListener('click', () => {
  void copyCard();
});

eventList.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (!t.classList.contains('ev-del')) return;
  const i = Number(t.dataset.i);
  if (Number.isNaN(i)) return;
  events.splice(i, 1);
  renderEvents();
  renderExport();
});

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (recording) stopRec();
    else startRec();
    return;
  }
  if (e.key === 'Escape') {
    if (recording) stopRec();
    return;
  }
  if (e.key === 'Backspace' && events.length && !recording) {
    e.preventDefault();
    events.pop();
    renderEvents();
    renderExport();
    return;
  }

  const key = e.key.toLowerCase();
  const def = SOUNDS.find((s) => s.key === key);
  if (def) {
    e.preventDefault();
    onPad(def);
  }
});

setSpeed(Number(speedEl.value));
renderPads();
renderEvents();
renderExport();
