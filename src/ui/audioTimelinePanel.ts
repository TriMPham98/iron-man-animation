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
  newClipId,
  saveTimeline,
  type TimelineClip,
} from '../audio/timelineModel';
import { colorForSoundId, SOUNDS } from '../audio/sounds';
import { paintClipWaveform, prewarmWaveforms } from '../audio/waveform';

const LANE_H_MIN = 18;
const LANE_GAP = 2;
const RULER_H = 16;
const MIN_CROP = 0.05;
/** Max simultaneous clip layers (includes room for a 4th layer). */
const MAX_LANES = 4;

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
 * Director-mode audio timeline: drag library SFX onto a multi-lane track,
 * move clips, crop with edge handles, sync playhead to assembly transport.
 */
export function createAudioTimelinePanel(): AudioTimelinePanel {
  const root = el<HTMLElement>('audio-timeline');
  const libraryEl = el<HTMLDivElement>('atl-library');
  const trackScroll = el<HTMLDivElement>('atl-track-scroll');
  const trackInner = el<HTMLDivElement>('atl-track-inner');
  const rulerEl = el<HTMLDivElement>('atl-ruler');
  const lanesEl = el<HTMLDivElement>('atl-lanes');
  const playheadEl = el<HTMLDivElement>('atl-playhead');
  const dropHint = el<HTMLDivElement>('atl-drop-hint');
  const metaEl = el<HTMLDivElement>('atl-meta');
  const cropInInput = el<HTMLInputElement>('atl-crop-in');
  const cropOutInput = el<HTMLInputElement>('atl-crop-out');
  const startInput = el<HTMLInputElement>('atl-start');
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
  /** Dynamic lane height (grows so few tracks fill the track pane). */
  let laneH = LANE_H_MIN;
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

  // Pre-warm catalog durations + waveform peaks (shared decode cache)
  for (const s of SOUNDS) {
    void getDuration(s.file);
  }
  prewarmWaveforms(SOUNDS.map((s) => s.file));

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

  const trackViewportW = () => Math.max(trackScroll.clientWidth || 0, 200);

  const trackViewportH = () => Math.max(trackScroll.clientHeight || 0, 48);

  /** Last layout sizes — skip no-op ResizeObserver re-renders that thrash scrollbars. */
  let lastLayoutKey = '';

  /** px/sec so full assembly spans the track (or wider when zoomed in). */
  const syncScale = () => {
    const vw = trackViewportW();
    const fit = assemblyDuration > 0 ? vw / assemblyDuration : 48;
    // Floor so fit-to-width never exceeds the viewport by a subpixel
    // (subpixel oversize is enough to toggle H-scroll → layout loop).
    pxPerSec = Math.max(8, Math.floor(fit * zoomMul * 1000) / 1000);
  };

  const contentWidth = () => {
    syncScale();
    const vw = trackViewportW();
    // Always at least full viewport so the track never ends short of the edge.
    // Floor the timed width so we never request 1px past the scrollport.
    return Math.max(vw, Math.floor(assemblyDuration * pxPerSec));
  };

  const renderRuler = () => {
    const w = contentWidth();
    // Fit zoom: width 100% tracks the scrollport exactly (no px rounding fight).
    // Zoomed in: explicit px width so the track can scroll horizontally.
    const widthCss = zoomMul <= 1 + 1e-6 ? '100%' : `${w}px`;
    trackInner.style.width = widthCss;
    rulerEl.style.width = widthCss;
    lanesEl.style.width = widthCss;

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

  const renderLibrary = () => {
    libraryEl.replaceChildren();
    for (const def of SOUNDS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'atl-lib-chip';
      chip.draggable = true;
      chip.dataset.soundId = def.id;
      chip.style.setProperty('--chip', colorForSoundId(def.id));
      chip.innerHTML = `<span class="atl-lib-label">${escapeHtml(def.label)}</span>`;
      chip.title = `${def.label} — drag onto timeline (or click to audition)`;

      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('application/x-suit-sound', def.id);
        e.dataTransfer?.setData('text/plain', def.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
        chip.classList.add('dragging');
      });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        dropHint.classList.remove('active');
      });
      chip.addEventListener('click', async () => {
        const srcDur = await getDuration(def.file);
        engine.stop('audition');
        engine.play({
          id: 'audition',
          file: def.file,
          offset: 0,
          duration: Math.max(0.05, srcDur),
        });
      });
      libraryEl.appendChild(chip);
    }
  };

  /** Greedy pack into ≤ maxLanes rows (may overlap if more simultaneous than max). */
  const packIntoLanes = (list: TimelineClip[], maxLanes: number): TimelineClip[] => {
    const sorted = [...list].sort(
      (a, b) => a.start - b.start || a.id.localeCompare(b.id),
    );
    const laneEnds = Array.from({ length: maxLanes }, () => 0);
    const out: TimelineClip[] = [];
    for (const c of sorted) {
      const end = c.start + Math.max(0, c.cropOut - c.cropIn);
      let free = -1;
      for (let i = 0; i < maxLanes; i++) {
        if (laneEnds[i]! <= c.start + 1e-4) {
          free = i;
          break;
        }
      }
      let lane: number;
      if (free >= 0) {
        lane = free;
      } else {
        // All busy — stack on the lane that frees first
        let best = 0;
        for (let i = 1; i < maxLanes; i++) {
          if (laneEnds[i]! < laneEnds[best]!) best = i;
        }
        lane = best;
      }
      laneEnds[lane] = Math.max(laneEnds[lane]!, end);
      out.push({ ...c, lane });
    }
    return out;
  };

  /** Occupied clip rows (0…MAX_LANES). */
  const occupiedLaneCount = () => {
    if (clips.length === 0) return 0;
    return Math.min(
      MAX_LANES,
      clips.reduce((m, c) => Math.max(m, c.lane), 0) + 1,
    );
  };

  /**
   * Visible rows = occupied + one spare drop lane (until all 4 layers used).
   * Lane height flexes: fewer rows → taller bars; more rows → shorter bars.
   */
  const visibleLaneCount = () => {
    const used = occupiedLaneCount();
    if (used === 0) return 1; // single empty drop row
    if (used >= MAX_LANES) return MAX_LANES;
    return used + 1; // spare track for the next layer
  };

  const layoutLanes = () => {
    clips = packIntoLanes(clips, MAX_LANES);
    const n = visibleLaneCount();
    // Use clientHeight (scrollbar-gutter stable) so lane fill matches the
    // scrollport without oscillating when overflow toggles.
    const viewportLanes = Math.max(0, trackViewportH() - RULER_H);
    const minContent = n * LANE_H_MIN + LANE_GAP * (n + 1);
    const avail = Math.max(viewportLanes, minContent);
    const gaps = LANE_GAP * (n + 1);
    // Flex row height across however many tracks are showing
    laneH = Math.max(LANE_H_MIN, Math.floor((avail - gaps) / n));
    const contentH = n * (laneH + LANE_GAP) + LANE_GAP;
    // Only force a min-height when clips need more room than the viewport.
    // Filling with height:100% alone avoids minHeight === clientHeight edge
    // cases that can flip the vertical scrollbar on subpixel layouts.
    if (contentH > viewportLanes) {
      lanesEl.style.minHeight = `${contentH}px`;
      // Grow track-inner so overflow:hidden still allows vertical scroll
      // (height:100% alone would clip extra lanes inside the scrollport).
      trackInner.style.height = `${RULER_H + contentH}px`;
    } else {
      lanesEl.style.minHeight = '';
      trackInner.style.height = '100%';
    }
    lanesEl.style.height = '100%';

    const band = laneH + LANE_GAP;
    const used = occupiedLaneCount();
    const stops: string[] = [];
    for (let i = 0; i < n; i++) {
      const y0 = LANE_GAP + i * band;
      const y1 = y0 + laneH;
      // Spare (empty) row slightly quieter so it reads as a drop target
      const fill =
        i < used || used === 0
          ? 'rgba(255,255,255,0.05)'
          : 'rgba(255,255,255,0.028)';
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

  const renderClips = () => {
    layoutLanes();
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
      const top = LANE_GAP + c.lane * (laneH + LANE_GAP);
      node.style.left = `${left}px`;
      node.style.width = `${width}px`;
      node.style.top = `${top}px`;
      node.style.height = `${laneH}px`;
      node.style.setProperty('--clip', colorForSoundId(c.soundId));

      const trimmed =
        c.cropIn > 0.001 || c.cropOut < c.sourceDuration - 0.001;

      const wave = document.createElement('canvas');
      wave.className = 'atl-clip-wave';
      wave.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'atl-clip-label';
      label.innerHTML = `${escapeHtml(c.label)}${
        trimmed
          ? ` <em class="atl-clip-crop-tag">${fmt(c.cropIn, 2)}–${fmt(c.cropOut, 2)}</em>`
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

      node.append(wave, label, handleIn, handleOut);

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
      });
    }

    clipCountEl.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'}`;
    updatePlayheadDom();
  };

  const renderMeta = () => {
    const c = selected();
    if (!c) {
      metaEl.classList.add('empty');
      cropInInput.disabled = true;
      cropOutInput.disabled = true;
      startInput.disabled = true;
      btnDelete.disabled = true;
      cropInInput.value = '';
      cropOutInput.value = '';
      startInput.value = '';
      return;
    }
    metaEl.classList.remove('empty');
    cropInInput.disabled = false;
    cropOutInput.disabled = false;
    startInput.disabled = false;
    btnDelete.disabled = false;
    cropInInput.value = fmt(c.cropIn, 3);
    cropOutInput.value = fmt(c.cropOut, 3);
    startInput.value = fmt(c.start, 3);
    cropInInput.max = String(Math.max(MIN_CROP, c.cropOut - MIN_CROP));
    cropOutInput.min = String(c.cropIn + MIN_CROP);
    cropOutInput.max = String(c.sourceDuration);
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
    const rect = trackScroll.getBoundingClientRect();
    const x = clientX - rect.left + trackScroll.scrollLeft;
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
      clips = assignLanes(clips);
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
    clips = assignLanes([...clips, clip]);
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
      });
      clips.push(clip);
      t += clipDuration(clip) + 0.05;
      select(clip.id);
    }
    clips = assignLanes(clips);
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

  // Meta inputs
  const applyMetaFromInputs = () => {
    const c = selected();
    if (!c) return;
    const start = Number(startInput.value);
    const cropIn = Number(cropInInput.value);
    const cropOut = Number(cropOutInput.value);
    if ([start, cropIn, cropOut].some((n) => Number.isNaN(n))) return;
    const next = clampCrop({ ...c, start, cropIn, cropOut });
    clips = assignLanes(clips.map((x) => (x.id === c.id ? next : x)));
    persist();
    renderClips();
    renderMeta();
  };

  cropInInput.addEventListener('change', applyMetaFromInputs);
  cropOutInput.addEventListener('change', applyMetaFromInputs);
  startInput.addEventListener('change', applyMetaFromInputs);

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
    const key = `${trackScroll.clientWidth}x${trackScroll.clientHeight}:${assemblyDuration}:${zoomMul}:${visibleLaneCount()}`;
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

      if (c.start >= sec - 1e-4) {
        const delay = (c.start - sec) * 1000;
        const tid = window.setTimeout(() => {
          if (playingFrom == null) return;
          engine.play({
            id: c.id,
            file: c.file,
            offset: c.cropIn,
            duration: dur,
          });
        }, Math.max(0, delay));
        scheduled.push(tid);
      } else {
        // Mid-clip: start immediately at offset into crop
        const into = sec - c.start;
        const remain = dur - into;
        if (remain > 0.02) {
          engine.play({
            id: c.id,
            file: c.file,
            offset: c.cropIn + into,
            duration: remain,
          });
        }
      }
    }
  };

  renderLibrary();
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
