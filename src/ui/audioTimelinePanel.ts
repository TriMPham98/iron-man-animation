import gsap from 'gsap';
import {
  type AudioEngine,
  createAudioEngine,
} from '../audio/engine';
import choreSeed from '../audio/choreTimeline.seed.json';
import {
  assignLanes,
  clipDuration,
  clampCrop,
  clampPitchValue,
  createClipFromSound,
  formatExportCard,
  initTimelineClips,
  listTrackRows,
  newClipId,
  PITCH_MAX,
  PITCH_MIN,
  saveTimeline,
  type TimelineClip,
  type TrackRow,
} from '../audio/timelineModel';
import { JARVIS_STARTUP_VOICE_ID } from '../audio/jarvisStartup';
import { colorForSoundId, SOUNDS } from '../audio/sounds';
import {
  collectSnapTargets,
  snapClipStart,
  snapTime,
  type SnapTarget,
} from '../audio/snapping';
import {
  drawGainEnvelope,
  paintClipWaveform,
  prewarmWaveforms,
} from '../audio/waveform';

/**
 * How many sample tracks fit in the viewport before scrolling.
 * Row height flexes so these rows fill the track pane.
 */
const VISIBLE_LANES = 5;
const LANE_H_MIN = 26;
const LANE_GAP = 2;
const RULER_H = 16;
const MIN_CROP = 0.05;
/** Snap magnet radius in pixels — converted to seconds per zoom level. */
const SNAP_PX = 7;
/** Undo depth. Each entry is a clip-array snapshot (small, plain objects). */
const HISTORY_LIMIT = 100;

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
  /** Toggle full-cycle loop (persisted). Returns the new loop state. */
  toggleLoop: () => boolean;
  /** True while the user is dragging the audio playhead. */
  isScrubbing: () => boolean;
  /** Toggle assembly SFX mute (persisted). Returns the new muted state. */
  toggleMute: () => boolean;
  /** Current mute state (toolbar + engine + localStorage). */
  isMuted: () => boolean;
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
  const trackTop = trackInner.querySelector(
    '.atl-track-top',
  ) as HTMLElement | null;
  const trackBody = trackInner.querySelector(
    '.atl-track-body',
  ) as HTMLElement | null;
  const timelineCol = trackInner.querySelector(
    '.atl-timeline-col',
  ) as HTMLElement | null;
  const labelsCol = trackInner.querySelector(
    '.atl-labels-col',
  ) as HTMLElement | null;
  const labelCorner = trackInner.querySelector(
    '.atl-label-corner',
  ) as HTMLElement | null;
  const metaEl = el<HTMLDivElement>('atl-meta');
  const cropInInput = el<HTMLInputElement>('atl-crop-in');
  const cropOutInput = el<HTMLInputElement>('atl-crop-out');
  const startInput = el<HTMLInputElement>('atl-start');
  const volInput = el<HTMLInputElement>('atl-vol');
  const volReadout = el<HTMLElement>('atl-vol-readout');
  const pitchInput = el<HTMLInputElement>('atl-pitch');
  const pitchReadout = el<HTMLElement>('atl-pitch-readout');
  const fadeInInput = el<HTMLInputElement>('atl-fade-in');
  const fadeOutInput = el<HTMLInputElement>('atl-fade-out');
  const fadePresetBtns = [
    ...root.querySelectorAll<HTMLButtonElement>('.atl-fade-preset'),
  ];
  const btnPause = el<HTMLButtonElement>('atl-pause');
  const btnLoop = el<HTMLButtonElement>('atl-loop');
  const btnMute = el<HTMLButtonElement>('atl-mute');
  const masterVolInput = el<HTMLInputElement>('atl-master-vol');
  const masterVolReadout = el<HTMLElement>('atl-master-vol-readout');
  const btnClear = el<HTMLButtonElement>('atl-clear');
  const btnCopy = el<HTMLButtonElement>('atl-copy');
  const btnDelete = el<HTMLButtonElement>('atl-delete');
  const btnZoomIn = el<HTMLButtonElement>('atl-zoom-in');
  const btnZoomOut = el<HTMLButtonElement>('atl-zoom-out');
  const btnSnap = el<HTMLButtonElement>('atl-snap');
  const btnUndo = el<HTMLButtonElement>('atl-undo');
  const btnRedo = el<HTMLButtonElement>('atl-redo');
  const snapGuideEl = el<HTMLDivElement>('atl-snap-guide');
  const clipCountEl = el<HTMLSpanElement>('atl-clip-count');

  const LOOP_STORAGE_KEY = 'mark-suit-audio-loop';
  const SNAP_STORAGE_KEY = 'mark-suit-audio-snap';
  const MUTE_STORAGE_KEY = 'mark-suit-audio-mute';
  const MASTER_VOL_STORAGE_KEY = 'mark-suit-audio-master-vol';

  const engine = createAudioEngine();
  const seedChoreVersion =
    typeof (choreSeed as { choreVersion?: unknown }).choreVersion === 'number'
      ? (choreSeed as { choreVersion: number }).choreVersion
      : undefined;

  /**
   * Persistence (localStorage), source of truth for transport:
   * - Seed from repo is written on first visit / when choreVersion advances.
   * - Director edits rewrite storage; Vercel ships the committed seed so
   *   production matches the authoring mix once the seed is updated.
   * - Loop / snap / mute / master volume toolbar toggles also persist
   *   across reloads.
   */
  let clips: TimelineClip[] = initTimelineClips(
    (choreSeed as { clips?: unknown }).clips,
    seedChoreVersion,
  );

  let selectedId: string | null = null;
  let assemblyDuration = 30;
  let playheadSec = 0;
  /** Zoom multiplier on fit-to-width scale (1 = timeline spans full track). */
  let zoomMul = 1;
  let pxPerSec = 48;
  /** Dynamic row height — sized so ~VISIBLE_LANES fill the track pane. */
  let laneH = LANE_H_MIN;
  let muted = false;
  try {
    muted = window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    muted = false;
  }
  /** Master gain 0–1 (multiplies every clip envelope). Default full. */
  let masterVolume = 1;
  try {
    const raw = window.localStorage.getItem(MASTER_VOL_STORAGE_KEY);
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n)) masterVolume = Math.min(1, Math.max(0, n));
    }
  } catch {
    masterVolume = 1;
  }
  let loopEnabled = false;
  try {
    loopEnabled = window.localStorage.getItem(LOOP_STORAGE_KEY) === '1';
  } catch {
    loopEnabled = false;
  }
  let snapEnabled = true;
  try {
    snapEnabled = window.localStorage.getItem(SNAP_STORAGE_KEY) !== '0';
  } catch {
    snapEnabled = true;
  }
  let seekHandler: ((progress01: number) => void) | null = null;
  let togglePauseHandler: (() => void) | null = null;
  let loopChangeHandler: ((enabled: boolean) => void) | null = null;
  let scrubbing = false;

  /**
   * Undo/redo over whole clip-list snapshots. Clips are plain objects that
   * every mutation path already replaces immutably, so a shallow array copy
   * is a complete restore point.
   */
  const undoStack: TimelineClip[][] = [];
  const redoStack: TimelineClip[][] = [];
  /**
   * Snapshot taken before a continuous gesture (fader drag, clip drag) so
   * undo rewinds the whole gesture rather than its last frame.
   */
  let gestureBase: TimelineClip[] | null = null;

  /** Object URLs minted for imported files — revoked on destroy. */
  const objectUrls = new Set<string>();

  const applyLoopVisual = () => {
    btnLoop.classList.toggle('is-active', loopEnabled);
    btnLoop.setAttribute('aria-pressed', loopEnabled ? 'true' : 'false');
    btnLoop.title = loopEnabled
      ? 'Loop on — full assembly restarts at end (L or click to disable)'
      : 'Loop full assembly cycle (no idle spin) (L)';
  };

  const setLoopState = (next: boolean): boolean => {
    loopEnabled = next;
    try {
      window.localStorage.setItem(LOOP_STORAGE_KEY, loopEnabled ? '1' : '0');
    } catch {
      /* private mode */
    }
    applyLoopVisual();
    loopChangeHandler?.(loopEnabled);
    return loopEnabled;
  };

  const toggleLoop = (): boolean => setLoopState(!loopEnabled);

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
  /** Snap targets frozen at drag start — other clips can't move mid-gesture. */
  let dragSnapTargets: SnapTarget[] = [];

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

  /**
   * Catalog durations + waveform peaks are only needed for director DAW chrome.
   * Defer off the viewer boot path so first paint / SFX are not blocked by
   * decoding all 23 samples. First director open (or idle) warms them.
   */
  let catalogWarmed = false;
  const warmCatalogAssets = () => {
    if (catalogWarmed) return;
    catalogWarmed = true;
    for (const s of SOUNDS) {
      void getDuration(s.file);
    }
    prewarmWaveforms(SOUNDS.map((s) => s.file));
    void refreshCatalogOrder();
  };
  // Idle after first paint when the browser is quiet (still warms before
  // most directors open the panel). Falls back to first setVisible(true).
  const scheduleCatalogWarm = () => {
    const ric = (
      window as Window & {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout: number },
        ) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => warmCatalogAssets(), { timeout: 4000 });
    } else {
      window.setTimeout(warmCatalogAssets, 1500);
    }
  };
  scheduleCatalogWarm();

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

  const syncHistoryButtons = () => {
    btnUndo.disabled = undoStack.length === 0;
    btnRedo.disabled = redoStack.length === 0;
    btnUndo.title = undoStack.length
      ? `Undo (⌘Z) — ${undoStack.length} step${undoStack.length === 1 ? '' : 's'}`
      : 'Nothing to undo';
    btnRedo.title = redoStack.length ? 'Redo (⇧⌘Z)' : 'Nothing to redo';
  };
  syncHistoryButtons();

  /**
   * Record a restore point. Pass `base` to rewind past a whole gesture
   * (the pre-drag snapshot) instead of the already-mutated current list.
   */
  const pushHistory = (base?: TimelineClip[] | null) => {
    undoStack.push([...(base ?? clips)]);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    // Any fresh edit invalidates the redo branch.
    redoStack.length = 0;
    syncHistoryButtons();
  };

  /**
   * Re-arm the transport schedule after an edit.
   *
   * `onTransportPlay` bakes the whole clip schedule into timers when it
   * runs, so a move/gain/crop change made mid-playback would otherwise stay
   * silent until the next seek. Re-running it from the live playhead lets
   * the director tune while listening.
   */
  const rescheduleIfPlaying = () => {
    if (playingFrom == null) return;
    onTransportPlay(playheadSec);
  };

  /** Shared tail of every mutation: save, repaint, re-arm audio. */
  const commit = (opts?: { skipRender?: boolean }) => {
    persist();
    if (!opts?.skipRender) {
      renderClips();
      renderMeta();
    }
    rescheduleIfPlaying();
  };

  const restoreSnapshot = (next: TimelineClip[]) => {
    clips = assignLanes(next, catalogOrder);
    // Selection may point at a clip that no longer exists in this snapshot.
    if (selectedId && !clips.some((c) => c.id === selectedId)) {
      selectedId = null;
    }
    engine.stop();
    commit();
    syncHistoryButtons();
  };

  const undo = () => {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push([...clips]);
    restoreSnapshot(prev);
  };

  const redo = () => {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push([...clips]);
    restoreSnapshot(next);
  };

  /**
   * Selection is a CSS class, not a reason to rebuild the track.
   *
   * This used to call `renderClips()`, which tore down every clip node —
   * including the one that had just received `pointerdown`. Capturing the
   * pointer on a detached element throws InvalidStateError, so the whole
   * drag silently failed to engage.
   */
  const select = (id: string | null) => {
    selectedId = id;
    for (const node of lanesEl.querySelectorAll<HTMLElement>('.atl-clip')) {
      node.classList.toggle('selected', node.dataset.id === id);
    }
    renderMeta();
  };

  const selected = (): TimelineClip | null =>
    clips.find((c) => c.id === selectedId) ?? null;

  /** Cached label rail width — invalidate on resize/layout (offsetWidth is layout-forcing). */
  let cachedLabelRailW = 0;
  const invalidateLabelRailW = () => {
    cachedLabelRailW = 0;
  };
  const labelRailW = () => {
    if (cachedLabelRailW > 0) return cachedLabelRailW;
    cachedLabelRailW =
      labelsCol?.offsetWidth || labelCorner?.offsetWidth || 116;
    return cachedLabelRailW;
  };

  /** Timeline column width (excludes sticky track labels). */
  const timelineViewportW = () => {
    return Math.max((trackScroll.clientWidth || 0) - labelRailW(), 160);
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

  /**
   * Ruler minor-tick spacing in seconds. Always keeps 1s major ticks; adds
   * 0.5s minors when zoomed enough. Never drops to 2s-only — second marks
   * stay readable while scrubbing. Doubles as the snap grid.
   */
  const gridStep = () => (pxPerSec >= 48 ? 0.5 : pxPerSec >= 22 ? 1 : 2);

  const renderRuler = () => {
    const w = contentWidth();
    const labelW = labelRailW();
    // Fit zoom: fill the scrollport. Zoomed in: grow past it for H-scroll.
    if (zoomMul <= 1 + 1e-6) {
      trackInner.style.width = '100%';
      if (trackTop) trackTop.style.width = '100%';
      if (trackBody) trackBody.style.width = '100%';
      if (timelineCol) {
        timelineCol.style.width = 'auto';
        timelineCol.style.flex = '1 1 auto';
      }
      rulerEl.style.width = 'auto';
      rulerEl.style.flex = '1 1 auto';
    } else {
      trackInner.style.width = `${labelW + w}px`;
      if (trackTop) trackTop.style.width = `${labelW + w}px`;
      if (trackBody) trackBody.style.width = `${labelW + w}px`;
      if (timelineCol) {
        timelineCol.style.width = `${w}px`;
        timelineCol.style.flex = `0 0 ${w}px`;
      }
      rulerEl.style.width = `${w}px`;
      rulerEl.style.flex = `0 0 ${w}px`;
    }
    lanesEl.style.width = '100%';

    rulerEl.replaceChildren();
    const minorStep = gridStep();
    const majorEvery = minorStep <= 1 ? 1 : 2;
    for (let t = 0; t <= assemblyDuration + 1e-6; t += minorStep) {
      const mark = document.createElement('div');
      const isMajor = Math.abs(t % majorEvery) < 1e-6;
      mark.className = 'atl-tick' + (isMajor ? ' major' : ' minor');
      mark.style.left = `${t * pxPerSec}px`;
      if (isMajor) {
        mark.innerHTML = `<span>${fmt(t, minorStep < 1 ? 1 : 0)}</span>`;
      }
      rulerEl.appendChild(mark);
    }
  };

  const trackRows = (): TrackRow[] => listTrackRows(clips, catalogOrder);

  const trackCount = () => trackRows().length;

  const bandH = () => laneH + LANE_GAP;

  const layoutLanes = () => {
    clips = assignLanes(clips, catalogOrder);
    const n = trackCount();
    // Size each row so VISIBLE_LANES fill the track scrollport (taller rows).
    const viewportLanes = Math.max(
      0,
      (trackScroll.clientHeight || 0) - RULER_H,
    );
    const gaps = LANE_GAP * (VISIBLE_LANES + 1);
    laneH = Math.max(
      LANE_H_MIN,
      Math.floor((viewportLanes - gaps) / VISIBLE_LANES),
    );
    const contentH = LANE_GAP + n * bandH();
    lanesEl.style.height = `${contentH}px`;
    lanesEl.style.minHeight = `${contentH}px`;
    headersEl.style.height = `${contentH}px`;
    // Content taller than viewport → vertical scroll for remaining samples
    trackInner.style.minHeight = '100%';
    trackInner.style.height = `${RULER_H + contentH}px`;

    const stops: string[] = [];
    for (let i = 0; i < n; i++) {
      const y0 = LANE_GAP + i * bandH();
      const y1 = y0 + laneH;
      const fill =
        i % 2 === 0 ? 'rgba(255,255,255,0.028)' : 'rgba(255,255,255,0.014)';
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
    // Padding + gap mirror lane band geometry (LANE_GAP + n * (laneH + LANE_GAP))
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
      btn.style.height = `${laneH}px`;
      btn.style.flex = `0 0 ${laneH}px`;

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

  /** Clip caption: name + crop range + any non-default gain/pitch/fades. */
  const clipLabelHtml = (c: TimelineClip): string => {
    const volPct = Math.round(c.volume * 100);
    const pitch = clampPitchValue(c.pitch);
    const gainBits: string[] = [];
    if (volPct !== 100) gainBits.push(`${volPct}%`);
    if (Math.abs(pitch - 1) > 0.005) gainBits.push(`${pitch.toFixed(2)}×`);
    if (c.fadeIn > 0.001) gainBits.push(`↑${fmt(c.fadeIn, 2)}`);
    if (c.fadeOut > 0.001) gainBits.push(`↓${fmt(c.fadeOut, 2)}`);
    const trimmed = c.cropIn > 0.001 || c.cropOut < c.sourceDuration - 0.001;
    return `${escapeHtml(c.label)}${
      trimmed
        ? ` <em class="atl-clip-crop-tag">${fmt(c.cropIn, 2)}–${fmt(c.cropOut, 2)}</em>`
        : ''
    }${
      gainBits.length
        ? ` <em class="atl-clip-gain-tag">${gainBits.join(' · ')}</em>`
        : ''
    }`;
  };

  const clipNode = (id: string): HTMLElement | null =>
    lanesEl.querySelector(`.atl-clip[data-id="${CSS.escape(id)}"]`);

  /**
   * Patch one clip's DOM in place.
   *
   * Drag used to call `renderClips()` per pointermove, which tore down and
   * rebuilt every track header and every clip node (plus a canvas repaint
   * each) to move a single rectangle — and destroyed the very node holding
   * the pointer capture. Geometry-only updates keep dragging cheap.
   */
  const updateClipNode = (c: TimelineClip, opts?: { repaintWave?: boolean }) => {
    const node = clipNode(c.id);
    if (!node) return;
    const dur = clipDuration(c);
    node.style.left = `${c.start * pxPerSec}px`;
    node.style.width = `${Math.max(8, dur * pxPerSec)}px`;

    const label = node.querySelector('.atl-clip-label');
    if (label) label.innerHTML = clipLabelHtml(c);

    const gainEl = node.querySelector(
      '.atl-clip-gain',
    ) as HTMLCanvasElement | null;
    if (gainEl) {
      drawGainEnvelope(gainEl, {
        volume: c.volume,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
        duration: Math.max(1e-3, dur),
      });
    }

    // Only crop drags change which slice of the source is visible.
    if (opts?.repaintWave) {
      const wave = node.querySelector(
        '.atl-clip-wave',
      ) as HTMLCanvasElement | null;
      if (wave) {
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
      }
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
      node.style.height = `${laneH}px`;
      node.style.setProperty('--clip', colorForSoundId(c.soundId));

      const wave = document.createElement('canvas');
      wave.className = 'atl-clip-wave';
      wave.setAttribute('aria-hidden', 'true');

      const gainEl = document.createElement('canvas');
      gainEl.className = 'atl-clip-gain';
      gainEl.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'atl-clip-label';
      label.innerHTML = clipLabelHtml(c);

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
    pitchInput.disabled = !on;
    fadeInInput.disabled = !on;
    fadeOutInput.disabled = !on;
    btnDelete.disabled = !on;
    for (const b of fadePresetBtns) b.disabled = !on;
  };

  const pitchToSlider = (pitch: number) =>
    String(Math.round(clampPitchValue(pitch) * 100));

  const sliderToPitch = (raw: string) =>
    clampPitchValue(Number(raw) / 100);

  const formatPitchReadout = (pitch: number) =>
    `${clampPitchValue(pitch).toFixed(2)}×`;

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
      pitchInput.value = '100';
      pitchReadout.textContent = '1.00×';
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
    const pitch = clampPitchValue(c.pitch);
    pitchInput.value = pitchToSlider(pitch);
    pitchInput.min = String(Math.round(PITCH_MIN * 100));
    pitchInput.max = String(Math.round(PITCH_MAX * 100));
    pitchReadout.textContent = formatPitchReadout(pitch);
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
    // Playhead lives on track-inner (ruler + lanes). Offset past the label rail.
    // Hit target is 10px wide (margin-left -5); keep center in [0, assembly end].
    const t = Math.max(0, Math.min(playheadSec, assemblyDuration));
    // Whole CSS pixels — subpixel thrash does not improve look
    const x = Math.round(labelRailW() + t * pxPerSec);
    playheadEl.style.left = `${x}px`;
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

  /** Snap tolerance in seconds — a fixed pixel radius at any zoom. */
  const snapToleranceSec = () => SNAP_PX / Math.max(1e-6, pxPerSec);

  const showSnapGuide = (target: SnapTarget | null) => {
    if (!target) {
      snapGuideEl.classList.remove('is-active');
      return;
    }
    snapGuideEl.className = `atl-snap-guide is-active kind-${target.kind}`;
    snapGuideEl.style.left = `${labelRailW() + target.time * pxPerSec}px`;
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
    // Rewind point for the gesture as a whole, banked on pointerup.
    gestureBase = [...clips];
    dragSnapTargets = collectSnapTargets({
      clips,
      excludeId: id,
      playheadSec,
      assemblyDuration,
      gridStep: gridStep(),
    });
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is an optimisation — window-level move/up listeners still
      // drive the drag if the pointer is already gone.
    }
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

    // Alt bypasses the magnet for fine placement (Logic / Ableton habit).
    const tol = snapEnabled && !e.altKey ? snapToleranceSec() : 0;
    let hit: SnapTarget | null = null;

    if (dragMode === 'move') {
      const raw = Math.max(0, base.start + dt);
      const snapped = snapClipStart(
        raw,
        clipDuration(base),
        dragSnapTargets,
        tol,
      );
      next.start = snapped.time;
      hit = snapped.target;
    } else if (dragMode === 'crop-in') {
      // Drag left edge: change cropIn; keep right edge fixed on timeline
      const rawStart = Math.max(0, base.start + dt);
      const snapped = snapTime(rawStart, dragSnapTargets, tol);
      hit = snapped.target;
      const delta = snapped.time - base.start;
      const maxIn = base.cropOut - MIN_CROP;
      const newIn = Math.min(maxIn, Math.max(0, base.cropIn + delta));
      // Re-derive start from the clamped crop so the right edge holds still.
      next.cropIn = newIn;
      next.start = Math.max(0, base.start + (newIn - base.cropIn));
      if (Math.abs(next.start - snapped.time) > 1e-6) hit = null;
    } else if (dragMode === 'crop-out') {
      const rawEnd = base.start + (base.cropOut + dt - base.cropIn);
      const snapped = snapTime(rawEnd, dragSnapTargets, tol);
      hit = snapped.target;
      const minOut = base.cropIn + MIN_CROP;
      const newOut = Math.min(
        base.sourceDuration,
        Math.max(minOut, base.cropIn + (snapped.time - base.start)),
      );
      next.cropOut = newOut;
      if (Math.abs(base.start + newOut - base.cropIn - snapped.time) > 1e-6) {
        hit = null;
      }
    }

    next = clampCrop(next);
    clips = clips.map((c) => (c.id === dragClipId ? next : c));
    // Geometry-only patch — no full rebuild while the pointer is down.
    updateClipNode(next, { repaintWave: dragMode !== 'move' });
    showSnapGuide(hit);
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
      const moved =
        gestureBase != null &&
        JSON.stringify(gestureBase) !== JSON.stringify(clips);
      dragMode = null;
      dragClipId = null;
      dragStartSnapshot = null;
      dragSnapTargets = [];
      showSnapGuide(null);
      clips = assignLanes(clips, catalogOrder);
      // A click that never moved the clip shouldn't burn an undo step.
      if (moved) pushHistory(gestureBase);
      gestureBase = null;
      commit();
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
    pushHistory();
    clips = assignLanes([...clips, clip], catalogOrder);
    selectedId = clip.id;
    commit();
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
    const before = [...clips];
    let added = false;
    for (const file of [...files]) {
      if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a)$/i.test(file.name)) {
        continue;
      }
      const url = URL.createObjectURL(file);
      objectUrls.add(url);
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
        pitch: 1,
      });
      clips = [...clips, clip];
      added = true;
      t += clipDuration(clip) + 0.05;
      selectedId = clip.id;
    }
    if (!added) return;
    pushHistory(before);
    clips = assignLanes(clips, catalogOrder);
    commit();
  };

  /** Prefer engine probe so blob / file drops get the Infinity→seek fix. */
  const probeBlobDuration = (url: string): Promise<number> =>
    engine.probeDuration(url);

  // Meta inputs (timing + Logic-style gain + pitch)
  const applyMetaFromInputs = () => {
    const c = selected();
    if (!c) return;
    const start = Number(startInput.value);
    const cropIn = Number(cropInInput.value);
    const cropOut = Number(cropOutInput.value);
    const volume = Number(volInput.value) / 100;
    const pitch = sliderToPitch(pitchInput.value);
    const fadeIn = Number(fadeInInput.value);
    const fadeOut = Number(fadeOutInput.value);
    if (
      [start, cropIn, cropOut, volume, pitch, fadeIn, fadeOut].some((n) =>
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
      pitch,
      fadeIn,
      fadeOut,
    });
    // A fader drag already mutated `clips` live — rewind to the pre-drag
    // snapshot so one undo covers the whole gesture.
    const before = gestureBase;
    gestureBase = null;
    const candidate = assignLanes(
      clips.map((x) => (x.id === c.id ? next : x)),
      catalogOrder,
    );
    if (JSON.stringify(candidate) === JSON.stringify(before ?? clips)) {
      clips = candidate;
      renderClips();
      renderMeta();
      return;
    }
    pushHistory(before);
    clips = candidate;
    commit();
  };

  const applyVolumeLive = () => {
    const c = selected();
    if (!c) return;
    const volume = Number(volInput.value) / 100;
    if (Number.isNaN(volume)) return;
    // First frame of the fader gesture — bank a rewind point.
    if (!gestureBase) gestureBase = [...clips];
    volReadout.textContent = `${Math.round(volume * 100)}%`;
    const next = clampCrop({ ...c, volume });
    clips = clips.map((x) => (x.id === c.id ? next : x));
    // Live envelope while dragging the fader; persist on change/pointerup
    updateClipNode(next);
  };

  const applyPitchLive = () => {
    const c = selected();
    if (!c) return;
    const pitch = sliderToPitch(pitchInput.value);
    if (Number.isNaN(pitch)) return;
    if (!gestureBase) gestureBase = [...clips];
    pitchReadout.textContent = formatPitchReadout(pitch);
    const next = clampCrop({ ...c, pitch });
    clips = clips.map((x) => (x.id === c.id ? next : x));
    // Refresh label pitch tag while dragging
    updateClipNode(next);
  };

  cropInInput.addEventListener('change', applyMetaFromInputs);
  cropOutInput.addEventListener('change', applyMetaFromInputs);
  startInput.addEventListener('change', applyMetaFromInputs);
  fadeInInput.addEventListener('change', applyMetaFromInputs);
  fadeOutInput.addEventListener('change', applyMetaFromInputs);
  volInput.addEventListener('input', applyVolumeLive);
  volInput.addEventListener('change', applyMetaFromInputs);
  pitchInput.addEventListener('input', applyPitchLive);
  pitchInput.addEventListener('change', applyMetaFromInputs);

  for (const btn of fadePresetBtns) {
    btn.addEventListener('click', () => {
      const c = selected();
      if (!c) return;
      const sec = Number(btn.dataset.fade);
      if (Number.isNaN(sec)) return;
      const next = clampCrop({ ...c, fadeIn: sec, fadeOut: sec });
      pushHistory();
      clips = assignLanes(
        clips.map((x) => (x.id === c.id ? next : x)),
        catalogOrder,
      );
      commit();
    });
  }

  const deleteSelected = (): boolean => {
    if (!selectedId) return false;
    // Stop playback if this instance was sounding
    engine.stop(selectedId);
    pushHistory();
    clips = clips.filter((c) => c.id !== selectedId);
    selectedId = null;
    commit();
    return true;
  };

  btnDelete.addEventListener('click', () => {
    deleteSelected();
  });

  btnClear.addEventListener('click', () => {
    if (clips.length === 0) return;
    if (!window.confirm('Clear all audio clips from the timeline?')) return;
    pushHistory();
    clips = [];
    selectedId = null;
    engine.stop();
    commit();
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
    toggleLoop();
  });

  const applyMuteVisual = () => {
    engine.setMuted(muted);
    btnMute.classList.toggle('is-muted', muted);
    btnMute.textContent = muted ? 'UNMUTE' : 'MUTE';
    btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btnMute.title = muted
      ? 'Muted — click or press M to restore assembly SFX'
      : 'Mute assembly SFX (M)';
  };

  const applyMasterVolumeVisual = () => {
    const pct = Math.round(masterVolume * 100);
    masterVolInput.value = String(pct);
    masterVolReadout.textContent = `${pct}%`;
    engine.setMasterVolume(masterVolume);
  };

  const setMasterVolumeState = (v: number): number => {
    masterVolume = Math.min(1, Math.max(0, v));
    try {
      window.localStorage.setItem(
        MASTER_VOL_STORAGE_KEY,
        String(masterVolume),
      );
    } catch {
      /* private mode */
    }
    applyMasterVolumeVisual();
    return masterVolume;
  };

  /**
   * Drop pending delayedCalls while muted (transport stays “live” via
   * playingFrom). Assigned after the transport block initializes.
   */
  let silenceScheduledForMute: (() => void) | null = null;

  const setMutedState = (next: boolean): boolean => {
    muted = next;
    try {
      window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (muted) {
      // Stop voices + kill pending cues; keep playingFrom so unmute re-arms.
      silenceScheduledForMute?.();
    }
    applyMuteVisual();
    // Muting stops every voice and the engine refuses to start new ones, so
    // unmuting has to rebuild the schedule from the live playhead — otherwise
    // the transport stays silent until the next seek or replay.
    if (!muted) rescheduleIfPlaying();
    return muted;
  };

  const toggleMute = (): boolean => setMutedState(!muted);

  applyMuteVisual();
  applyMasterVolumeVisual();

  btnMute.addEventListener('click', () => {
    toggleMute();
  });

  masterVolInput.addEventListener('input', () => {
    const n = Number(masterVolInput.value);
    if (Number.isNaN(n)) return;
    // Live fader — write engine + readout immediately; persist on same path.
    setMasterVolumeState(n / 100);
  });

  const applySnapVisual = () => {
    btnSnap.classList.toggle('is-active', snapEnabled);
    btnSnap.setAttribute('aria-pressed', snapEnabled ? 'true' : 'false');
    btnSnap.title = snapEnabled
      ? 'Snap on — ticks, playhead, clip edges (hold Alt to bypass)'
      : 'Snap off — free placement';
  };
  applySnapVisual();

  btnSnap.addEventListener('click', () => {
    snapEnabled = !snapEnabled;
    try {
      window.localStorage.setItem(SNAP_STORAGE_KEY, snapEnabled ? '1' : '0');
    } catch {
      /* private mode */
    }
    applySnapVisual();
  });

  btnUndo.addEventListener('click', () => {
    undo();
  });
  btnRedo.addEventListener('click', () => {
    redo();
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
    invalidateLabelRailW();
    const key = `${trackScroll.clientWidth}x${trackScroll.clientHeight}:${assemblyDuration}:${zoomMul}:${trackCount()}:${laneH}`;
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

  // Delete / Backspace removes the highlighted clip; ⌘Z / ⇧⌘Z walk history
  // (global while the panel is open)
  const onWindowKeydown = (e: KeyboardEvent) => {
    if (root.classList.contains('hidden')) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    // Windows/Linux redo convention
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      e.stopPropagation();
      redo();
      return;
    }

    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!selectedId) return;
    e.preventDefault();
    e.stopPropagation();
    deleteSelected();
  };
  window.addEventListener('keydown', onWindowKeydown, true);

  // ── Transport sync ──────────────────────────────────────────────
  // Use GSAP delayedCall (same ticker / lagSmoothing as the assembly timeline)
  // instead of window.setTimeout — under main-thread load, setTimeout drifts
  // relative to GSAP and plate hits / SFX fall out of sync.
  let scheduled: gsap.core.Tween[] = [];
  /**
   * Non-null while assembly transport wants audio (play/resume), even if
   * muted. Must survive a muted onTransportPlay so unmute can re-arm.
   */
  let playingFrom: number | null = null;

  const killScheduled = () => {
    for (const tw of scheduled) tw.kill();
    scheduled = [];
  };

  const cancelSchedule = () => {
    killScheduled();
    playingFrom = null;
  };

  /**
   * Voices that outlive timeline transport (INITIATE one-shots).
   * engine.stop() would cut them the moment assembly boots.
   */
  const transportKeepVoices = [JARVIS_STARTUP_VOICE_ID] as const;

  const onTransportStop = () => {
    cancelSchedule();
    engine.stopAllExcept(transportKeepVoices);
  };

  const onTransportPlay = (sec: number) => {
    killScheduled();
    engine.stopAllExcept(transportKeepVoices);
    // `sec` is the seed/cascade clock. May be negative during a hangar hold
    // so clip delays stay authored against original plate times.
    // Keep this set even when muted — otherwise unmute cannot resume mid-run
    // (cancelSchedule used to null it before the muted early-return).
    playingFrom = sec;
    if (muted) return;

    // Ensure autoplay is unlocked (INITIATE gesture may have already done this)
    void engine.unlock();

    for (const c of clips) {
      const dur = clipDuration(c);
      const end = c.start + dur;
      if (end <= sec + 1e-4) continue;

      const pitch = clampPitchValue(c.pitch);
      const gain = {
        volume: c.volume,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
        pitch,
        clipDuration: dur,
      };

      if (c.start >= sec - 1e-4) {
        // Negative playhead → longer delay (silent lead-in before cascade)
        const delaySec = Math.max(0, c.start - sec);
        const tw = gsap.delayedCall(delaySec, () => {
          if (playingFrom == null || muted) return;
          engine.play({
            id: c.id,
            file: c.file,
            offset: c.cropIn,
            duration: dur,
            clipOffset: 0,
            ...gain,
          });
        });
        scheduled.push(tw);
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

  // Mute/unmute handlers are registered above (before this block) via closure;
  // rebind the mute-side schedule kill now that killScheduled exists.
  silenceScheduledForMute = () => {
    killScheduled();
  };

  renderRuler();
  renderClips();
  renderMeta();

  // Preload cue files so cold Vercel deploys don't miss the first hits
  const preloaded = new Set<string>();
  for (const c of clips) {
    if (preloaded.has(c.file)) continue;
    preloaded.add(c.file);
    engine.preload(c.file);
  }

  return {
    setVisible: (v: boolean) => {
      // Authoring chrome only — never stop transport when leaving director.
      root.classList.toggle('hidden', !v);
      if (v) {
        warmCatalogAssets();
        invalidateLabelRailW();
        // Layout after becoming visible (clientWidth was 0 while hidden)
        requestAnimationFrame(() => {
          invalidateLabelRailW();
          renderRuler();
          renderClips();
        });
      }
    },
    setAssemblyDuration: (sec: number) => {
      assemblyDuration = Math.max(1, sec);
      invalidateLabelRailW();
      // Re-fit so the full cycle spans the track width
      renderRuler();
      renderClips();
    },
    setPlayhead: (sec: number) => {
      // Don't fight the user's drag
      if (scrubbing) return;
      playheadSec = Math.max(0, sec);
      // Viewer path: panel is hidden — skip layout-touching style writes
      if (root.classList.contains('hidden')) return;
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
    toggleLoop,
    isScrubbing: () => scrubbing,
    toggleMute,
    isMuted: () => muted,
    engine,
    destroy: () => {
      flushPersist();
      onTransportStop();
      // Held for the panel's lifetime because undo can resurrect a deleted
      // imported clip — only safe to release once the panel is going away.
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
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
