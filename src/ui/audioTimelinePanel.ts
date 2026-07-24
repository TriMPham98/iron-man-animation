import {
  type AudioEngine,
  createAudioEngine,
} from '../audio/engine';
import choreSeed from '../audio/choreTimeline.seed.json';
import {
  assignLanes,
  clipDuration,
  clampCrop,
  createClipFromSound,
  formatExportCard,
  initTimelineClips,
  listTrackRows,
  newClipId,
  saveTimeline,
  type TimelineClip,
  type TrackRow,
} from '../audio/timelineModel';
import { colorForSoundId, SOUNDS } from '../audio/sounds';
import {
  drawGainEnvelope,
  paintClipWaveform,
  prewarmWaveforms,
} from '../audio/waveform';

/** Fixed row height per sample track (scroll when many). */
const LANE_H = 22;
const LANE_GAP = 1;
const RULER_H = 16;
const MIN_CROP = 0.05;

export type AudioTimelinePanel = {
  /** Show/hide with director mode. */
  setVisible: (v: boolean) => void;
  /** Assembly duration in seconds (ruler length). */
  setAssemblyDuration: (sec: number) => void;
  /** Playhead position in assembly seconds. */
  setPlayhead: (sec: number) => void;
  /** Call when assembly starts/resumes from `sec`. */
  onTransportPlay: (sec: number) => void;
  /** Call when assembly pauses or seeks. */
  onTransportStop: () => void;
  /**
   * Fired while the user scrubs the ruler / empty track / playhead.
   * Progress is 0–1 relative to assembly duration.
   */
  onSeek: (cb: (progress01: number) => void) => void;
  /** Play / pause control on the timeline toolbar (Space still works globally). */
  onTogglePause: (cb: () => void) => void;
  /** Reflect assembly pause state on the toolbar button. */
  setPaused: (paused: boolean) => void;
  /**
   * Fired when LOOP is toggled. When enabled, assembly should restart
   * immediately at the end of the full sequence (no idle spin showcase).
   */
  onLoopChange: (cb: (enabled: boolean) => void) => void;
  isLooping: () => boolean;
  /** True while the user is dragging the audio playhead. */
  isScrubbing: () => boolean;
  /** Preview single library pad (optional). */
  engine: AudioEngine;
  destroy: () => void;
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function fmt(sec: number, digits = 2): string {
  return sec.toFixed(digits);
}

/**
 * Director-mode audio timeline: one track line per sample (shortest → longest),
 * move clips, crop with edge handles, sync playhead to assembly transport.
 */
export function createAudioTimelinePanel(): AudioTimelinePanel {
  const root = el<HTMLElement>('audio-timeline');
  const trackScroll = el<HTMLDivElement>('atl-track-scroll');
  const trackInner = el<HTMLDivElement>('atl-track-inner');
  const headersEl = el<HTMLDivElement>('atl-headers');
  const rulerEl = el<HTMLDivElement>('atl-ruler');
  const lanesEl = el<HTMLDivElement>('atl-lanes');
  const playheadEl = el<HTMLDivElement>('atl-playhead');
  const dropHint = el<HTMLDivElement>('atl-drop-hint');
  const timelineCol = trackInner.querySelector(
    '.atl-timeline-col',
  ) as HTMLElement | null;
  const labelsCol = trackInner.querySelector(
    '.atl-labels-col',
  ) as HTMLElement | null;
  const metaEl = el<HTMLDivElement>('atl-meta');
  const cropInInput = el<HTMLInputElement>('atl-crop-in');
  const cropOutInput = el<HTMLInputElement>('atl-crop-out');
  const startInput = el<HTMLInputElement>('atl-start');
  const volInput = el<HTMLInputElement>('atl-vol');
  const volReadout = el<HTMLElement>('atl-vol-readout');
  const fadeInInput = el<HTMLInputElement>('atl-fade-in');
  const fadeOutInput = el<HTMLInputElement>('atl-fade-out');
  const fadePresetBtns = [
    ...root.querySelectorAll<HTMLButtonElement>('.atl-fade-preset'),
  ];
  const btnPause = el<HTMLButtonElement>('atl-pause');
  const btnLoop = el<HTMLButtonElement>('atl-loop');
  const btnMute = el<HTMLButtonElement>('atl-mute');
  const btnClear = el<HTMLButtonElement>('atl-clear');
  const btnCopy = el<HTMLButtonElement>('atl-copy');
  const btnDelete = el<HTMLButtonElement>('atl-delete');
  const btnZoomIn = el<HTMLButtonElement>('atl-zoom-in');
  const btnZoomOut = el<HTMLButtonElement>('atl-zoom-out');
  const clipCountEl = el<HTMLSpanElement>('atl-clip-count');

  const LOOP_STORAGE_KEY = 'mark-suit-audio-loop';

  const engine = createAudioEngine();
  /**
   * Persistence (localStorage):
   * - First visit: seed → write snapshot (including empty).
   * - Every edit (add / move / crop / delete / clear): full list rewrite.
   * - Refresh: load snapshot only — never re-seed over user deletes.
   */
  let clips: TimelineClip[] = initTimelineClips(
    (choreSeed as { clips?: unknown }).clips,
  );

  let selectedId: string | null = null;
  let assemblyDuration = 30;
  let playheadSec = 0;
  /** Zoom multiplier on fit-to-width scale (1 = timeline spans full track). */
  let zoomMul = 1;
  let pxPerSec = 48;
  let muted = false;
  let loopEnabled = false;
  try {
    loopEnabled = window.localStorage.getItem(LOOP_STORAGE_KEY) === '1';
  } catch {
    loopEnabled = false;
  }
  let seekHandler: ((progress01: number) => void) | null = null;
  let togglePauseHandler: (() => void) | null = null;
  let loopChangeHandler: ((enabled: boolean) => void) | null = null;
  let scrubbing = false;

  const applyLoopVisual = () => {
    btnLoop.classList.toggle('is-active', loopEnabled);
    btnLoop.setAttribute('aria-pressed', loopEnabled ? 'true' : 'false');
    btnLoop.title = loopEnabled
      ? 'Loop on — full assembly restarts at end (click to disable)'
      : 'Loop full assembly cycle (no idle spin)';
  };
  applyLoopVisual();

  /** Source durations cache (file → seconds). */
  const durationCache = new Map<string, number>();
  /**
   * Catalog track order: shortest sample first (stable by label).
   * Rebuilt when durations finish probing.
   */
  let catalogOrder: string[] = SOUNDS.map((s) => s.id);

  type DragMode = 'move' | 'crop-in' | 'crop-out' | null;
  let dragMode: DragMode = null;
  let dragClipId: string | null = null;
  let dragOriginX = 0;
  let dragStartSnapshot: TimelineClip | null = null;

  const getDuration = async (file: string): Promise<number> => {
    const hit = durationCache.get(file);
    if (hit != null) return hit;
    const d = await engine.probeDuration(file);
    durationCache.set(file, d);
    return d;
  };

  const refreshCatalogOrder = async (): Promise<void> => {
    const ranked = await Promise.all(
      SOUNDS.map(async (def) => ({
        id: def.id,
        label: def.label,
        dur: await getDuration(def.file),
      })),
    );
    ranked.sort(
      (a, b) => a.dur - b.dur || a.label.localeCompare(b.label),
    );
    const next = ranked.map((r) => r.id);
    const same =
      next.length === catalogOrder.length &&
      next.every((id, i) => id === catalogOrder[i]);
    if (same) return;
    catalogOrder = next;
    clips = assignLanes(clips, catalogOrder);
    renderClips();
  };

  // Pre-warm catalog durations + waveform peaks (shared decode cache)
  for (const s of SOUNDS) {
    void getDuration(s.file);
  }
  prewarmWaveforms(SOUNDS.map((s) => s.file));
  void refreshCatalogOrder();

  const persist = (): boolean => {
    // Always write full list (including empty after delete/clear)
    const ok = saveTimeline(clips);
    if (!ok) {
      console.warn(
        '[audio-timeline] could not persist clips — deletes may not survive refresh',
      );
    }
    return ok;
  };

  // Flush on navigation / refresh so the last edit is never lost mid-frame
  const flushPersist = () => {
    saveTimeline(clips);
  };
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);

  const select = (id: string | null) => {
    selectedId = id;
    renderClips();
    renderMeta();
  };

  const selected = (): TimelineClip | null =>
    clips.find((c) => c.id === selectedId) ?? null;

  /** Timeline column width (excludes sticky track labels). */
  const timelineViewportW = () => {
    const labelW = labelsCol?.offsetWidth ?? 88;
    return Math.max((trackScroll.clientWidth || 0) - labelW, 160);
  };

  /** Last layout sizes — skip no-op ResizeObserver re-renders that thrash scrollbars. */
  let lastLayoutKey = '';

  /** px/sec so full assembly spans the track (or wider when zoomed in). */
  const syncScale = () => {
    const vw = timelineViewportW();
    const fit = assemblyDuration > 0 ? vw / assemblyDuration : 48;
    // Floor so fit-to-width never exceeds the viewport by a subpixel
    // (subpixel oversize is enough to toggle H-scroll → layout loop).
    pxPerSec = Math.max(8, Math.floor(fit * zoomMul * 1000) / 1000);
  };

  const contentWidth = () => {
    syncScale();
    const vw = timelineViewportW();
    // Always at least full viewport so the track never ends short of the edge.
    // Floor the timed width so we never request 1px past the scrollport.
    return Math.max(vw, Math.floor(assemblyDuration * pxPerSec));
  };

  const renderRuler = () => {
    const w = contentWidth();
    const labelW = labelsCol?.offsetWidth ?? 100;
    // Fit zoom: fill the scrollport. Zoomed in: grow past it for H-scroll.
    if (zoomMul <= 1 + 1e-6) {
      trackInner.style.width = '100%';
      if (timelineCol) {
        timelineCol.style.width = 'auto';
        timelineCol.style.flex = '1 1 auto';
      }
    } else {
      trackInner.style.width = `${labelW + w}px`;
      if (timelineCol) {
        timelineCol.style.width = `${w}px`;
        timelineCol.style.flex = `0 0 ${w}px`;
      }
    }
    rulerEl.style.width = '100%';
    lanesEl.style.width = '100%';

    rulerEl.replaceChildren();
    const step = pxPerSec >= 64 ? 0.5 : pxPerSec >= 36 ? 1 : 2;
    for (let t = 0; t <= assemblyDuration + 1e-6; t += step) {
      const mark = document.createElement('div');
      mark.className = 'atl-tick' + (Math.abs(t % 1) < 1e-6 ? ' major' : '');
      mark.style.left = `${t * pxPerSec}px`;
      if (Math.abs(t % 1) < 1e-6 || step >= 1) {
        mark.innerHTML = `<span>${fmt(t, step < 1 ? 1 : 0)}</span>`;
      }
      rulerEl.appendChild(mark);
    }
  };

  const trackRows = (): TrackRow[] => listTrackRows(clips, catalogOrder);

  const trackCount = () => trackRows().length;

  const bandH = () => LANE_H + LANE_GAP;

  const layoutLanes = () => {
    clips = assignLanes(clips, catalogOrder);
    const n = trackCount();
    const contentH = LANE_GAP + n * bandH();
    lanesEl.style.height = `${contentH}px`;
    lanesEl.style.minHeight = `${contentH}px`;
    headersEl.style.height = `${contentH}px`;
    // Content taller than viewport → vertical scroll inside track-scroll
    trackInner.style.minHeight = '100%';
    trackInner.style.height = `${RULER_H + contentH}px`;

    const stops: string[] = [];
    for (let i = 0; i < n; i++) {
      const y0 = LANE_GAP + i * bandH();
      const y1 = y0 + LANE_H;
      const fill =
        i % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.028)';
      stops.push(
        `transparent ${y0}px`,
        `${fill} ${y0}px`,
        `${fill} ${y1}px`,
        `transparent ${y1}px`,
      );
    }
    lanesEl.style.backgroundImage =
      stops.length > 0
        ? `linear-gradient(to bottom, ${stops.join(', ')})`
        : 'none';
    lanesEl.style.backgroundSize = '100% 100%';
    lanesEl.style.backgroundRepeat = 'no-repeat';
  };

  const renderTrackHeaders = () => {
    const rows = trackRows();
    headersEl.replaceChildren();
    // Padding + gap mirror lane band geometry (LANE_GAP + n * (LANE_H + LANE_GAP))
    headersEl.style.gap = `${LANE_GAP}px`;
    headersEl.style.paddingTop = `${LANE_GAP}px`;
    headersEl.style.paddingBottom = '0';
    headersEl.style.boxSizing = 'border-box';
    for (const row of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'atl-track-header' + (row.kind === 'custom' ? ' is-custom' : '');
      btn.dataset.soundId = row.soundId;
      btn.dataset.lane = String(row.lane);
      btn.style.setProperty('--chip', colorForSoundId(row.soundId));
      btn.style.height = `${LANE_H}px`;
      btn.style.flex = `0 0 ${LANE_H}px`;

      const def =
        row.kind === 'catalog'
          ? SOUNDS.find((s) => s.id === row.soundId)
          : undefined;
      const fileDur = def
        ? durationCache.get(def.file)
        : undefined;
      const durLabel =
        fileDur != null ? fmt(fileDur, fileDur >= 10 ? 1 : 2) : null;

      btn.title =
        row.kind === 'catalog'
          ? `${row.label}${durLabel ? ` · ${durLabel}s` : ''} — drag onto timeline · click to audition`
          : `${row.label} (imported)`;
      btn.innerHTML = `<span class="atl-track-name">${escapeHtml(row.label)}</span>${
        durLabel
          ? `<span class="atl-track-dur">${durLabel}s</span>`
          : ''
      }`;

      if (def) {
        btn.draggable = true;
        btn.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('application/x-suit-sound', def.id);
          e.dataTransfer?.setData('text/plain', def.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
          btn.classList.add('dragging');
        });
        btn.addEventListener('dragend', () => {
          btn.classList.remove('dragging');
          dropHint.classList.remove('active');
        });
        btn.addEventListener('click', async () => {
          const srcDur = await getDuration(def.file);
          engine.stop('audition');
          engine.play({
            id: 'audition',
            file: def.file,
            offset: 0,
            duration: Math.max(0.05, srcDur),
          });
        });
      }
      headersEl.appendChild(btn);
    }
  };

  const renderClips = () => {
    layoutLanes();
    renderTrackHeaders();
    syncScale();

    // Remove old clip nodes (keep playhead)
    for (const node of [...lanesEl.querySelectorAll('.atl-clip')]) {
      node.remove();
    }

    for (const c of clips) {
      const node = document.createElement('div');
      node.className = 'atl-clip' + (c.id === selectedId ? ' selected' : '');
      node.dataset.id = c.id;
      const dur = clipDuration(c);
      const left = c.start * pxPerSec;
      const width = Math.max(8, dur * pxPerSec);
      const top = LANE_GAP + c.lane * bandH();
      node.style.left = `${left}px`;
      node.style.width = `${width}px`;
      node.style.top = `${top}px`;
      node.style.height = `${LANE_H}px`;
      node.style.setProperty('--clip', colorForSoundId(c.soundId));

      const trimmed =
        c.cropIn > 0.001 || c.cropOut < c.sourceDuration - 0.001;

      const wave = document.createElement('canvas');
      wave.className = 'atl-clip-wave';
      wave.setAttribute('aria-hidden', 'true');

      const gainEl = document.createElement('canvas');
      gainEl.className = 'atl-clip-gain';
      gainEl.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'atl-clip-label';
      const volPct = Math.round(c.volume * 100);
      const gainBits: string[] = [];
      if (volPct !== 100) gainBits.push(`${volPct}%`);
      if (c.fadeIn > 0.001) gainBits.push(`↑${fmt(c.fadeIn, 2)}`);
      if (c.fadeOut > 0.001) gainBits.push(`↓${fmt(c.fadeOut, 2)}`);
      label.innerHTML = `${escapeHtml(c.label)}${
        trimmed
          ? ` <em class="atl-clip-crop-tag">${fmt(c.cropIn, 2)}–${fmt(c.cropOut, 2)}</em>`
          : ''
      }${
        gainBits.length
          ? ` <em class="atl-clip-gain-tag">${gainBits.join(' · ')}</em>`
          : ''
      }`;

      const handleIn = document.createElement('span');
      handleIn.className = 'atl-clip-handle left';
      handleIn.dataset.handle = 'in';
      handleIn.title = 'Crop in';

      const handleOut = document.createElement('span');
      handleOut.className = 'atl-clip-handle right';
      handleOut.dataset.handle = 'out';
      handleOut.title = 'Crop out';

      node.append(wave, gainEl, label, handleIn, handleOut);

      node.addEventListener('pointerdown', (e) => {
        const t = e.target as HTMLElement;
        if (t.dataset.handle === 'in') {
          beginDrag(e, c.id, 'crop-in');
        } else if (t.dataset.handle === 'out') {
          beginDrag(e, c.id, 'crop-out');
        } else {
          beginDrag(e, c.id, 'move');
        }
      });

      lanesEl.appendChild(node);

      // Paint after layout so canvas has a real CSS size
      requestAnimationFrame(() => {
        void paintClipWaveform(
          wave,
          c.file,
          c.cropIn,
          c.cropOut,
          c.sourceDuration,
          {
            color: 'rgba(255, 255, 255, 0.5)',
            fillColor: 'rgba(255, 255, 255, 0.14)',
          },
        );
        drawGainEnvelope(gainEl, {
          volume: c.volume,
          fadeIn: c.fadeIn,
          fadeOut: c.fadeOut,
          duration: Math.max(1e-3, dur),
        });
      });
    }

    clipCountEl.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'}`;
    updatePlayheadDom();
  };

  const setMetaEnabled = (on: boolean) => {
    cropInInput.disabled = !on;
    cropOutInput.disabled = !on;
    startInput.disabled = !on;
    volInput.disabled = !on;
    fadeInInput.disabled = !on;
    fadeOutInput.disabled = !on;
    btnDelete.disabled = !on;
    for (const b of fadePresetBtns) b.disabled = !on;
  };

  const renderMeta = () => {
    const c = selected();
    if (!c) {
      metaEl.classList.add('empty');
      setMetaEnabled(false);
      cropInInput.value = '';
      cropOutInput.value = '';
      startInput.value = '';
      volInput.value = '100';
      volReadout.textContent = '100%';
      fadeInInput.value = '';
      fadeOutInput.value = '';
      return;
    }
    metaEl.classList.remove('empty');
    setMetaEnabled(true);
    cropInInput.value = fmt(c.cropIn, 3);
    cropOutInput.value = fmt(c.cropOut, 3);
    startInput.value = fmt(c.start, 3);
    const pct = Math.round(c.volume * 100);
    volInput.value = String(pct);
    volReadout.textContent = `${pct}%`;
    fadeInInput.value = fmt(c.fadeIn, 3);
    fadeOutInput.value = fmt(c.fadeOut, 3);
    cropInInput.max = String(Math.max(MIN_CROP, c.cropOut - MIN_CROP));
    cropOutInput.min = String(c.cropIn + MIN_CROP);
    cropOutInput.max = String(c.sourceDuration);
    const maxFade = Math.max(0, clipDuration(c));
    fadeInInput.max = String(maxFade);
    fadeOutInput.max = String(maxFade);
  };

  const updatePlayheadDom = () => {
    // Keep the playhead center within [0, assembly end]. The 10px hit target
    // (margin-left -5) is clipped by track-inner so t=end never inflates
    // scrollWidth. Height is CSS top/bottom:0 — never set a px height that
    // can exceed the track and thrash the vertical scrollbar every frame.
    const t = Math.max(0, Math.min(playheadSec, assemblyDuration));
    playheadEl.style.left = `${t * pxPerSec}px`;
    playheadEl.style.height = '';
  };

  const clientXToTime = (clientX: number): number => {
    // Measure against the lanes column (labels are sticky and excluded).
    const rect = lanesEl.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(assemblyDuration, x / pxPerSec));
  };

  const emitSeekToTime = (sec: number) => {
    playheadSec = sec;
    updatePlayheadDom();
    const dur = Math.max(assemblyDuration, 1e-6);
    seekHandler?.(sec / dur);
  };

  const beginScrub = (e: PointerEvent) => {
    // Don't steal horizontal scroll gestures starting as pan on track — only primary button
    if (e.button !== 0) return;
    e.preventDefault();
    scrubbing = true;
    root.classList.add('is-scrubbing');
    trackScroll.classList.add('is-scrubbing');
    select(null);
    emitSeekToTime(clientXToTime(e.clientX));
    try {
      trackScroll.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const beginDrag = (e: PointerEvent, id: string, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    const c = clips.find((x) => x.id === id);
    if (!c || !mode) return;
    select(id);
    dragMode = mode;
    dragClipId = id;
    dragOriginX = e.clientX;
    dragStartSnapshot = { ...c };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (scrubbing) {
      emitSeekToTime(clientXToTime(e.clientX));
      return;
    }
    if (!dragMode || !dragClipId || !dragStartSnapshot) return;
    const dx = e.clientX - dragOriginX;
    const dt = dx / pxPerSec;
    const base = dragStartSnapshot;
    let next: TimelineClip = { ...base };

    if (dragMode === 'move') {
      next.start = Math.max(0, base.start + dt);
    } else if (dragMode === 'crop-in') {
      // Drag left edge: change cropIn; keep right edge fixed on timeline
      const maxIn = base.cropOut - MIN_CROP;
      let newIn = base.cropIn + dt;
      newIn = Math.min(maxIn, Math.max(0, newIn));
      const delta = newIn - base.cropIn;
      next.cropIn = newIn;
      next.start = Math.max(0, base.start + delta);
    } else if (dragMode === 'crop-out') {
      const minOut = base.cropIn + MIN_CROP;
      let newOut = base.cropOut + dt;
      newOut = Math.min(base.sourceDuration, Math.max(minOut, newOut));
      next.cropOut = newOut;
    }

    next = clampCrop(next);
    clips = clips.map((c) => (c.id === dragClipId ? next : c));
    renderClips();
    renderMeta();
  };

  const onPointerUp = () => {
    if (scrubbing) {
      scrubbing = false;
      root.classList.remove('is-scrubbing');
      trackScroll.classList.remove('is-scrubbing');
      // Final seek already applied on last move / down
      return;
    }
    if (dragMode) {
      dragMode = null;
      dragClipId = null;
      dragStartSnapshot = null;
      clips = assignLanes(clips, catalogOrder);
      persist();
      renderClips();
      renderMeta();
    }
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // Scrub: ruler, empty lane area, or playhead (clips stopPropagation)
  rulerEl.addEventListener('pointerdown', beginScrub);
  lanesEl.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.atl-clip')) return;
    beginScrub(e);
  });
  playheadEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    beginScrub(e);
  });

  const addSoundAt = async (soundId: string, startSec: number) => {
    const def = SOUNDS.find((s) => s.id === soundId);
    if (!def) return;
    const srcDur = await getDuration(def.file);
    const clip = createClipFromSound(soundId, startSec, srcDur);
    if (!clip) return;
    clips = assignLanes([...clips, clip], catalogOrder);
    persist();
    select(clip.id);
    renderClips();
    renderMeta();
  };

  // Drop from library
  trackScroll.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropHint.classList.add('active');
  });
  trackScroll.addEventListener('dragleave', () => {
    dropHint.classList.remove('active');
  });
  trackScroll.addEventListener('drop', (e) => {
    e.preventDefault();
    dropHint.classList.remove('active');
    const soundId =
      e.dataTransfer?.getData('application/x-suit-sound') ||
      e.dataTransfer?.getData('text/plain');
    if (soundId && SOUNDS.some((s) => s.id === soundId)) {
      void addSoundAt(soundId, clientXToTime(e.clientX));
      return;
    }
    // External audio files
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      void importExternalFiles(files, clientXToTime(e.clientX));
    }
  });

  // Also allow drop on library area? skip

  const importExternalFiles = async (files: FileList, startSec: number) => {
    let t = startSec;
    for (const file of [...files]) {
      if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a)$/i.test(file.name)) {
        continue;
      }
      const url = URL.createObjectURL(file);
      const srcDur = await probeBlobDuration(url);
      durationCache.set(url, srcDur);
      const clip: TimelineClip = clampCrop({
        id: newClipId(),
        soundId: `custom-${file.name}`,
        label: file.name.replace(/\.[^.]+$/, ''),
        file: url, // engine must accept absolute URLs
        start: t,
        cropIn: 0,
        cropOut: srcDur,
        sourceDuration: srcDur,
        lane: 0,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
      });
      clips.push(clip);
      t += clipDuration(clip) + 0.05;
      select(clip.id);
    }
    clips = assignLanes(clips, catalogOrder);
    persist();
    renderClips();
    renderMeta();
  };

  const probeBlobDuration = (url: string): Promise<number> =>
    new Promise((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      a.addEventListener(
        'loadedmetadata',
        () => {
          const d = a.duration;
          resolve(Number.isFinite(d) && d > 0 ? d : 1);
        },
        { once: true },
      );
      a.addEventListener('error', () => resolve(1), { once: true });
      a.src = url;
    });

  // Meta inputs (timing + Logic-style gain)
  const applyMetaFromInputs = () => {
    const c = selected();
    if (!c) return;
    const start = Number(startInput.value);
    const cropIn = Number(cropInInput.value);
    const cropOut = Number(cropOutInput.value);
    const volume = Number(volInput.value) / 100;
    const fadeIn = Number(fadeInInput.value);
    const fadeOut = Number(fadeOutInput.value);
    if (
      [start, cropIn, cropOut, volume, fadeIn, fadeOut].some((n) =>
        Number.isNaN(n),
      )
    ) {
      return;
    }
    const next = clampCrop({
      ...c,
      start,
      cropIn,
      cropOut,
      volume,
      fadeIn,
      fadeOut,
    });
    clips = assignLanes(
      clips.map((x) => (x.id === c.id ? next : x)),
      catalogOrder,
    );
    persist();
    renderClips();
    renderMeta();
  };

  const applyVolumeLive = () => {
    const c = selected();
    if (!c) return;
    const volume = Number(volInput.value) / 100;
    if (Number.isNaN(volume)) return;
    volReadout.textContent = `${Math.round(volume * 100)}%`;
    const next = clampCrop({ ...c, volume });
    clips = clips.map((x) => (x.id === c.id ? next : x));
    // Live envelope while dragging the fader; persist on change/pointerup
    const node = lanesEl.querySelector(
      `.atl-clip[data-id="${CSS.escape(c.id)}"] .atl-clip-gain`,
    ) as HTMLCanvasElement | null;
    if (node) {
      drawGainEnvelope(node, {
        volume: next.volume,
        fadeIn: next.fadeIn,
        fadeOut: next.fadeOut,
        duration: Math.max(1e-3, clipDuration(next)),
      });
    }
  };

  cropInInput.addEventListener('change', applyMetaFromInputs);
  cropOutInput.addEventListener('change', applyMetaFromInputs);
  startInput.addEventListener('change', applyMetaFromInputs);
  fadeInInput.addEventListener('change', applyMetaFromInputs);
  fadeOutInput.addEventListener('change', applyMetaFromInputs);
  volInput.addEventListener('input', applyVolumeLive);
  volInput.addEventListener('change', applyMetaFromInputs);

  for (const btn of fadePresetBtns) {
    btn.addEventListener('click', () => {
      const c = selected();
      if (!c) return;
      const sec = Number(btn.dataset.fade);
      if (Number.isNaN(sec)) return;
      const next = clampCrop({ ...c, fadeIn: sec, fadeOut: sec });
      clips = assignLanes(
        clips.map((x) => (x.id === c.id ? next : x)),
        catalogOrder,
      );
      persist();
      renderClips();
      renderMeta();
    });
  }

  const deleteSelected = (): boolean => {
    if (!selectedId) return false;
    // Stop playback if this instance was sounding
    engine.stop(selectedId);
    clips = clips.filter((c) => c.id !== selectedId);
    selectedId = null;
    persist();
    renderClips();
    renderMeta();
    return true;
  };

  btnDelete.addEventListener('click', () => {
    deleteSelected();
  });

  btnClear.addEventListener('click', () => {
    if (clips.length === 0) return;
    if (!window.confirm('Clear all audio clips from the timeline?')) return;
    clips = [];
    selectedId = null;
    engine.stop();
    persist();
    renderClips();
    renderMeta();
  });

  btnCopy.addEventListener('click', async () => {
    const card = formatExportCard(clips, assemblyDuration);
    try {
      await navigator.clipboard.writeText(card);
      const prev = btnCopy.textContent;
      btnCopy.textContent = 'COPIED';
      window.setTimeout(() => {
        btnCopy.textContent = prev;
      }, 1200);
    } catch {
      window.prompt('Copy audio timeline card:', card);
    }
  });

  btnPause.addEventListener('click', () => {
    togglePauseHandler?.();
  });

  btnLoop.addEventListener('click', () => {
    loopEnabled = !loopEnabled;
    try {
      window.localStorage.setItem(LOOP_STORAGE_KEY, loopEnabled ? '1' : '0');
    } catch {
      /* private mode */
    }
    applyLoopVisual();
    loopChangeHandler?.(loopEnabled);
  });

  btnMute.addEventListener('click', () => {
    muted = !muted;
    engine.setMuted(muted);
    btnMute.classList.toggle('is-muted', muted);
    btnMute.textContent = muted ? 'UNMUTE' : 'MUTE';
    btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  });

  btnZoomIn.addEventListener('click', () => {
    zoomMul = Math.min(4, zoomMul * 1.25);
    renderRuler();
    renderClips();
  });
  btnZoomOut.addEventListener('click', () => {
    // Never zoom out past fit-to-width — track always reaches the edge
    zoomMul = Math.max(1, zoomMul / 1.25);
    renderRuler();
    renderClips();
  });

  const relayoutFromSize = () => {
    // Debounce identity: same viewport + duration + zoom ⇒ skip full rebuild.
    // Without this, scrollbar show/hide can re-fire RO forever at t=end.
    const key = `${trackScroll.clientWidth}x${trackScroll.clientHeight}:${assemblyDuration}:${zoomMul}:${trackCount()}`;
    if (key === lastLayoutKey) {
      updatePlayheadDom();
      return;
    }
    lastLayoutKey = key;
    renderRuler();
    renderClips();
  };

  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          relayoutFromSize();
        })
      : null;
  ro?.observe(trackScroll);

  // Delete / Backspace removes the highlighted clip (global while panel open)
  const onWindowKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (root.classList.contains('hidden')) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!selectedId) return;
    e.preventDefault();
    e.stopPropagation();
    deleteSelected();
  };
  window.addEventListener('keydown', onWindowKeydown, true);

  // ── Transport sync ──────────────────────────────────────────────
  let scheduled: number[] = [];
  let playingFrom: number | null = null;

  const cancelSchedule = () => {
    for (const id of scheduled) window.clearTimeout(id);
    scheduled = [];
    playingFrom = null;
  };

  const onTransportStop = () => {
    cancelSchedule();
    engine.stop();
  };

  const onTransportPlay = (sec: number) => {
    cancelSchedule();
    engine.stop();
    if (muted) return;
    playingFrom = sec;

    for (const c of clips) {
      const dur = clipDuration(c);
      const end = c.start + dur;
      if (end <= sec + 1e-4) continue;

      const gain = {
        volume: c.volume,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
        clipDuration: dur,
      };

      if (c.start >= sec - 1e-4) {
        const delay = (c.start - sec) * 1000;
        const tid = window.setTimeout(() => {
          if (playingFrom == null) return;
          engine.play({
            id: c.id,
            file: c.file,
            offset: c.cropIn,
            duration: dur,
            clipOffset: 0,
            ...gain,
          });
        }, Math.max(0, delay));
        scheduled.push(tid);
      } else {
        // Mid-clip: start immediately at offset into crop (continue fade ramp)
        const into = sec - c.start;
        const remain = dur - into;
        if (remain > 0.02) {
          engine.play({
            id: c.id,
            file: c.file,
            offset: c.cropIn + into,
            duration: remain,
            clipOffset: into,
            ...gain,
          });
        }
      }
    }
  };

  renderRuler();
  renderClips();
  renderMeta();

  return {
    setVisible: (v: boolean) => {
      // Authoring chrome only — never stop transport when leaving director.
      root.classList.toggle('hidden', !v);
      if (v) {
        // Layout after becoming visible (clientWidth was 0 while hidden)
        requestAnimationFrame(() => {
          renderRuler();
          renderClips();
        });
      }
    },
    setAssemblyDuration: (sec: number) => {
      assemblyDuration = Math.max(1, sec);
      // Re-fit so the full cycle spans the track width
      renderRuler();
      renderClips();
    },
    setPlayhead: (sec: number) => {
      // Don't fight the user's drag
      if (scrubbing) return;
      playheadSec = Math.max(0, sec);
      updatePlayheadDom();
    },
    onTransportPlay,
    onTransportStop,
    onSeek: (cb) => {
      seekHandler = cb;
    },
    onTogglePause: (cb) => {
      togglePauseHandler = cb;
    },
    setPaused: (paused: boolean) => {
      btnPause.textContent = paused ? 'PLAY' : 'PAUSE';
      btnPause.classList.toggle('is-paused', paused);
    },
    onLoopChange: (cb) => {
      loopChangeHandler = cb;
      // Sync initial preference into session immediately
      cb(loopEnabled);
    },
    isLooping: () => loopEnabled,
    isScrubbing: () => scrubbing,
    engine,
    destroy: () => {
      flushPersist();
      onTransportStop();
      ro?.disconnect();
      window.removeEventListener('pagehide', flushPersist);
      window.removeEventListener('beforeunload', flushPersist);
      window.removeEventListener('keydown', onWindowKeydown, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
