import {
  type AudioEngine,
  createAudioEngine,
} from '../audio/engine';
import {
  assignLanes,
  clipDuration,
  clampCrop,
  createClipFromSound,
  formatExportCard,
  loadTimeline,
  newClipId,
  saveTimeline,
  type TimelineClip,
} from '../audio/timelineModel';
import { colorForSoundId, SOUNDS } from '../audio/sounds';

const LANE_H = 28;
const LANE_GAP = 4;
const RULER_H = 22;
const MIN_CROP = 0.05;
const PX_PER_SEC_DEFAULT = 48;

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
  const btnMute = el<HTMLButtonElement>('atl-mute');
  const btnClear = el<HTMLButtonElement>('atl-clear');
  const btnCopy = el<HTMLButtonElement>('atl-copy');
  const btnDelete = el<HTMLButtonElement>('atl-delete');
  const btnZoomIn = el<HTMLButtonElement>('atl-zoom-in');
  const btnZoomOut = el<HTMLButtonElement>('atl-zoom-out');
  const clipCountEl = el<HTMLSpanElement>('atl-clip-count');

  const engine = createAudioEngine();
  let clips: TimelineClip[] = loadTimeline();
  let selectedId: string | null = null;
  let assemblyDuration = 30;
  let playheadSec = 0;
  let pxPerSec = PX_PER_SEC_DEFAULT;
  let muted = false;
  let seekHandler: ((progress01: number) => void) | null = null;
  let scrubbing = false;

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

  // Pre-warm catalog durations
  for (const s of SOUNDS) {
    void getDuration(s.file);
  }

  const persist = () => {
    saveTimeline(clips);
  };

  const select = (id: string | null) => {
    selectedId = id;
    renderClips();
    renderMeta();
  };

  const selected = (): TimelineClip | null =>
    clips.find((c) => c.id === selectedId) ?? null;

  const contentWidth = () => Math.max(320, assemblyDuration * pxPerSec + 80);

  const renderRuler = () => {
    const w = contentWidth();
    trackInner.style.width = `${w}px`;
    rulerEl.style.width = `${w}px`;
    lanesEl.style.width = `${w}px`;

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
          duration: Math.min(srcDur, 2.5),
        });
      });
      libraryEl.appendChild(chip);
    }
  };

  const maxLane = () =>
    clips.reduce((m, c) => Math.max(m, c.lane), -1) + 1;

  const renderLanesBg = () => {
    const n = Math.max(2, maxLane() + 1, 2);
    const h = n * (LANE_H + LANE_GAP) + LANE_GAP;
    lanesEl.style.height = `${h}px`;
    lanesEl.style.backgroundImage = `repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent ${LANE_GAP}px,
      rgba(255,255,255,0.03) ${LANE_GAP}px,
      rgba(255,255,255,0.03) ${LANE_GAP + LANE_H}px
    )`;
  };

  const renderClips = () => {
    clips = assignLanes(clips);
    renderLanesBg();

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
      const top = LANE_GAP + c.lane * (LANE_H + LANE_GAP);
      node.style.left = `${left}px`;
      node.style.width = `${width}px`;
      node.style.top = `${top}px`;
      node.style.height = `${LANE_H}px`;
      node.style.setProperty('--clip', colorForSoundId(c.soundId));

      const trimmed =
        c.cropIn > 0.001 || c.cropOut < c.sourceDuration - 0.001;
      node.innerHTML = `
        <span class="atl-clip-label">${escapeHtml(c.label)}${
          trimmed
            ? ` <em class="atl-clip-crop-tag">${fmt(c.cropIn, 2)}–${fmt(c.cropOut, 2)}</em>`
            : ''
        }</span>
        <span class="atl-clip-handle left" data-handle="in" title="Crop in"></span>
        <span class="atl-clip-handle right" data-handle="out" title="Crop out"></span>
      `;

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
    playheadEl.style.left = `${playheadSec * pxPerSec}px`;
    playheadEl.style.height = `${RULER_H + (lanesEl.offsetHeight || 64)}px`;
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

  btnDelete.addEventListener('click', () => {
    if (!selectedId) return;
    clips = clips.filter((c) => c.id !== selectedId);
    selectedId = null;
    persist();
    renderClips();
    renderMeta();
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

  btnMute.addEventListener('click', () => {
    muted = !muted;
    engine.setMuted(muted);
    btnMute.classList.toggle('is-muted', muted);
    btnMute.textContent = muted ? 'UNMUTE' : 'MUTE';
    btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  });

  btnZoomIn.addEventListener('click', () => {
    pxPerSec = Math.min(160, pxPerSec + 12);
    renderRuler();
    renderClips();
  });
  btnZoomOut.addEventListener('click', () => {
    pxPerSec = Math.max(16, pxPerSec - 12);
    renderRuler();
    renderClips();
  });

  // Keyboard: Delete / Backspace removes selected when panel focused
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (selectedId) {
        e.preventDefault();
        btnDelete.click();
      }
    }
  });

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
    },
    setAssemblyDuration: (sec: number) => {
      assemblyDuration = Math.max(1, sec);
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
    isScrubbing: () => scrubbing,
    engine,
    destroy: () => {
      onTransportStop();
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
