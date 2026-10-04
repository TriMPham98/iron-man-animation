import type { CyclePhase, CyclePhases } from '../session/assemblySession';

export interface CycleScrubberOptions {
  getCycle: () => { t: number; phase: CyclePhase; phases: CyclePhases; playing: boolean };
  seekCycle: (t: number) => void;
  setCyclePlaying: (play: boolean) => void;
  /** Transport is live (after INITIATE). */
  isEnabled: () => boolean;
}

export interface CycleScrubber {
  /** Per frame: playhead, fills, readout, visibility. */
  update: () => void;
  /** Show the bar for a moment (keyboard scrub / phase jump). */
  poke: () => void;
}

const PHASES: ReadonlyArray<{ id: CyclePhase; label: string }> = [
  { id: 'assembly', label: 'ASSEMBLY' },
  { id: 'flight', label: 'FLIGHT CHECK' },
  { id: 'doff', label: 'DISASSEMBLY' },
];

/** Seconds the bar stays up after the last pointer move near it / key scrub while playing. */
const LINGER_SEC = 2.4;
/** Share of the viewport height (from the bottom) that wakes the bar. */
const WAKE_ZONE = 0.2;
/** Pixels within which a drag snaps onto a phase boundary. */
const SNAP_PX = 7;

const fmt = (s: number) => {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const sec = v - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
};

/**
 * One scrub bar across the whole cycle — assembly, flight check and
 * disassembly as three labelled segments sized by their length. Drag or
 * click anywhere to seek (a playing cycle holds while dragging and plays on
 * from where it is let go); a drag snaps onto phase boundaries. It stays out
 * of the frame while the cycle plays and rises when the pointer comes near
 * the bottom, when held, or while scrubbing from the keyboard.
 */
export function createCycleScrubber(opts: CycleScrubberOptions): CycleScrubber {
  const root = document.createElement('div');
  root.id = 'cycle-scrubber';
  root.className = 'cycle-scrubber';
  root.innerHTML = `
    <div class="cs-head">
      <span class="cs-phase" aria-hidden="true"></span>
      <span class="cs-keys" aria-hidden="true">1 · 2 · 3 jump &nbsp;·&nbsp; ← → step &nbsp;·&nbsp; Space hold</span>
      <span class="cs-time" aria-hidden="true"></span>
    </div>
    <div class="cs-track" role="slider" tabindex="0" aria-label="Sequence position" aria-valuemin="0" aria-valuemax="100">
      ${PHASES.map(
        (p, i) => `<div class="cs-seg" data-phase="${p.id}"><div class="cs-fill"></div><span class="cs-label"><em>0${i + 1}</em>${p.label}</span></div>`,
      ).join('')}
      <div class="cs-playhead"></div>
      <div class="cs-hover" aria-hidden="true"><span></span></div>
    </div>`;
  (document.getElementById('app') ?? document.body).appendChild(root);

  const track = root.querySelector<HTMLDivElement>('.cs-track')!;
  const playhead = root.querySelector<HTMLDivElement>('.cs-playhead')!;
  const hover = root.querySelector<HTMLDivElement>('.cs-hover')!;
  const hoverText = hover.querySelector('span')!;
  const phaseEl = root.querySelector<HTMLSpanElement>('.cs-phase')!;
  const timeEl = root.querySelector<HTMLSpanElement>('.cs-time')!;
  const segs = new Map<CyclePhase, { el: HTMLDivElement; fill: HTMLDivElement }>();
  for (const p of PHASES) {
    const el = root.querySelector<HTMLDivElement>(`.cs-seg[data-phase="${p.id}"]`)!;
    segs.set(p.id, { el, fill: el.querySelector<HTMLDivElement>('.cs-fill')! });
  }

  let lastWake = -Infinity;
  let hovering = false;
  let dragging: { pointer: number; wasPlaying: boolean } | null = null;
  let pendingSeek: number | null = null;
  let lastSizes = '';
  let lastPhase: CyclePhase | null = null;
  const now = () => performance.now() / 1000;
  const wake = () => {
    lastWake = now();
  };

  /** Cycle seconds under a client x (snapping onto phase boundaries while dragging). */
  const timeAt = (clientX: number, snap: boolean): number => {
    const r = track.getBoundingClientRect();
    const { phases } = opts.getCycle();
    const x = Math.min(r.width, Math.max(0, clientX - r.left));
    if (snap) {
      for (const b of [phases.assembly, phases.assembly + phases.flight]) {
        const bx = (b / phases.total) * r.width;
        if (Math.abs(bx - x) < SNAP_PX) return b;
      }
    }
    return (x / Math.max(1, r.width)) * phases.total;
  };
  const phaseAt = (t: number, p: CyclePhases): { id: CyclePhase; local: number } => {
    if (t < p.assembly) return { id: 'assembly', local: t };
    if (t < p.assembly + p.flight || p.doff === 0) return { id: 'flight', local: t - p.assembly };
    return { id: 'doff', local: t - p.assembly - p.flight };
  };
  const labelOf = (id: CyclePhase) => PHASES.find((p) => p.id === id)!.label;

  // Seeks land once per frame however fast the pointer moves
  const flush = () => {
    if (pendingSeek === null) return;
    opts.seekCycle(pendingSeek);
    pendingSeek = null;
  };

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !opts.isEnabled()) return;
    e.preventDefault();
    e.stopPropagation();
    track.setPointerCapture(e.pointerId);
    const wasPlaying = opts.getCycle().playing;
    dragging = { pointer: e.pointerId, wasPlaying };
    root.classList.add('is-dragging');
    if (wasPlaying) opts.setCyclePlaying(false);
    pendingSeek = timeAt(e.clientX, true);
    flush();
    wake();
  });
  track.addEventListener('pointermove', (e) => {
    const t = timeAt(e.clientX, !!dragging);
    const p = opts.getCycle().phases;
    const at = phaseAt(t, p);
    const r = track.getBoundingClientRect();
    hover.style.left = `${((t / p.total) * r.width).toFixed(1)}px`;
    hoverText.textContent = `${labelOf(at.id)} · ${fmt(at.local)}`;
    if (dragging && e.pointerId === dragging.pointer) pendingSeek = t;
    wake();
  });
  const release = (e: PointerEvent) => {
    if (!dragging || e.pointerId !== dragging.pointer) return;
    flush();
    const { wasPlaying } = dragging;
    dragging = null;
    root.classList.remove('is-dragging');
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    // A playing cycle plays on from where it was let go
    if (wasPlaying) opts.setCyclePlaying(true);
    wake();
  };
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  track.addEventListener('pointerenter', () => {
    hovering = true;
    root.classList.add('is-hovering');
  });
  track.addEventListener('pointerleave', () => {
    hovering = false;
    root.classList.remove('is-hovering');
  });
  // Keep the scene's orbit / pick handlers out of it
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.clientY > window.innerHeight * (1 - WAKE_ZONE)) wake();
    },
    { passive: true },
  );

  const update = () => {
    flush();
    const enabled = opts.isEnabled();
    const c = opts.getCycle();
    const p = c.phases;
    const sizes = `${p.assembly.toFixed(2)}|${p.flight.toFixed(2)}|${p.doff.toFixed(2)}`;
    if (sizes !== lastSizes) {
      lastSizes = sizes;
      segs.get('assembly')!.el.style.flexGrow = String(p.assembly);
      segs.get('flight')!.el.style.flexGrow = String(p.flight);
      segs.get('doff')!.el.style.flexGrow = String(p.doff);
      segs.get('flight')!.el.hidden = p.flight <= 0;
      segs.get('doff')!.el.hidden = p.doff <= 0;
    }
    const at = phaseAt(c.t, p);
    const starts: Record<CyclePhase, number> = { assembly: 0, flight: p.assembly, doff: p.assembly + p.flight };
    const lens: Record<CyclePhase, number> = { assembly: p.assembly, flight: p.flight, doff: p.doff };
    for (const ph of PHASES) {
      const s = segs.get(ph.id)!;
      const k = lens[ph.id] > 0 ? Math.min(1, Math.max(0, (c.t - starts[ph.id]) / lens[ph.id])) : 0;
      s.fill.style.transform = `scaleX(${k.toFixed(4)})`;
      s.el.classList.toggle('is-current', ph.id === at.id);
      s.el.classList.toggle('is-done', k >= 1 && ph.id !== at.id);
    }
    playhead.style.left = `${((c.t / Math.max(1e-6, p.total)) * 100).toFixed(3)}%`;
    if (at.id !== lastPhase) {
      lastPhase = at.id;
      phaseEl.textContent = labelOf(at.id);
      root.dataset.phase = at.id;
    }
    timeEl.textContent = `${fmt(at.local)} / ${fmt(lens[at.id])}`;
    track.setAttribute('aria-valuenow', String(Math.round((c.t / Math.max(1e-6, p.total)) * 100)));
    track.setAttribute('aria-valuetext', `${labelOf(at.id)} ${fmt(at.local)}`);

    const show = enabled && (dragging !== null || hovering || !c.playing || now() - lastWake < LINGER_SEC);
    root.classList.toggle('is-visible', show);
    root.classList.toggle('is-held', enabled && !c.playing);
  };

  return { update, poke: wake };
}
