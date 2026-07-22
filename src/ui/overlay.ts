import type { ArmorPiece, PieceWave } from '../suit/waves';
import {
  entryFromPiece,
  formatReclassCard,
  isPieceWave,
  shortPieceId as formatShortId,
  WAVE_ORDER,
  type ReclassEntry,
} from './reclassCard';
import {
  readDirectorPreference,
  writeDirectorPreference,
} from './viewerMode';

export interface DebugActivePiece {
  id: string;
  wave: string;
  localProgress: number;
}

export interface OverlayHandles {
  setLoadingProgress: (p: number) => void;
  hideLoading: () => void;
  showHud: () => void;
  setStatus: (text: string, online?: boolean) => void;
  setIntegrity: (text: string) => void;
  setHintVisible: (v: boolean) => void;
  setReplayEnabled: (v: boolean) => void;
  setSkipEnabled: (v: boolean) => void;
  onReplay: (cb: () => void) => void;
  onSkip: (cb: () => void) => void;
  updateClock: (elapsedSec: number) => void;
  fadeTitle: (hide: boolean) => void;
  /** Whether director tools (audio timeline, reclass, pick meta) are visible. */
  isDirectorMode: () => boolean;
  setDirectorMode: (enabled: boolean) => void;
  onDirectorModeChange: (cb: (enabled: boolean) => void) => void;
  /** Show/hide director chrome based on current mode. */
  syncDirectorChrome: () => void;
  /**
   * Legacy no-op — assembly progress is scrubbed on the audio timeline.
   * Kept so session code can call without branching.
   */
  setDebugProgress: (p: number) => void;
  /**
   * Legacy no-op — pause label lives on the audio timeline toolbar.
   * Session should also call audioTimeline.setPaused when present.
   */
  setDebugPaused: (paused: boolean) => void;
  /** Labels for plates currently mid-flight (director only). */
  setDebugActivePieces: (pieces: DebugActivePiece[]) => void;
  /** Raycast pick readout (null clears to idle hint). */
  setDebugPickedPiece: (info: DebugPickedPiece | null) => void;
  /**
   * Full armor piece for reclass card (geometry measure). Pass null to clear.
   * Prefer this over setDebugPickedPiece when a real shard is selected.
   */
  setReclassPick: (piece: ArmorPiece | null) => void;
  /** Target wave currently selected in the reclass panel. */
  getReclassTargetWave: () => PieceWave;
  /** Cycle target wave (dir +1 / −1). */
  cycleReclassTargetWave: (delta: number) => void;
  /** Queue current pick → target wave. Returns false if nothing to add. */
  addReclassEntry: () => boolean;
}

export interface DebugPickedPiece {
  id: string;
  wave: string;
  /** Mesh name if different from id */
  meshName?: string;
  visible: boolean;
  /** World rest position, rounded for display */
  rest?: { x: number; y: number; z: number };
  note?: string;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function createOverlay(): OverlayHandles {
  const loading = el<HTMLDivElement>('loading');
  const loadingFill = el<HTMLDivElement>('loading-fill');
  const hudTop = el<HTMLElement>('hud-top');
  const hudBottom = el<HTMLElement>('hud-bottom');
  const hudCenter = el<HTMLDivElement>('hud-center');
  const status = el<HTMLParagraphElement>('status');
  const integrity = el<HTMLSpanElement>('integrity');
  const hint = el<HTMLSpanElement>('hint');
  const replayBtn = el<HTMLButtonElement>('replay-btn');
  const skipBtn = el<HTMLButtonElement>('skip-btn');
  const directorBtn = el<HTMLButtonElement>('director-btn');
  const clock = el<HTMLSpanElement>('hud-clock');
  const title = el<HTMLHeadingElement>('title');
  const debugActive = el<HTMLDivElement>('debug-active-piece');
  const debugPicked = el<HTMLDivElement>('debug-picked-piece');
  const hudBottomMeta = el<HTMLDivElement>('hud-bottom-meta');

  let replayHandler: (() => void) | null = null;
  let skipHandler: (() => void) | null = null;
  let directorModeHandler: ((enabled: boolean) => void) | null = null;
  let directorMode = readDirectorPreference();

  const shortPieceId = formatShortId;

  // ── Reclass panel state ────────────────────────────────────────
  const reclassPanel = el<HTMLElement>('reclass-panel');
  const reclassCount = el<HTMLSpanElement>('reclass-count');
  const reclassPicked = el<HTMLParagraphElement>('reclass-picked');
  const reclassWave = el<HTMLSelectElement>('reclass-wave');
  const reclassNote = el<HTMLInputElement>('reclass-note');
  const reclassAdd = el<HTMLButtonElement>('reclass-add');
  const reclassUndo = el<HTMLButtonElement>('reclass-undo');
  const reclassCopy = el<HTMLButtonElement>('reclass-copy');
  const reclassClear = el<HTMLButtonElement>('reclass-clear');
  const reclassList = el<HTMLOListElement>('reclass-list');

  let reclassPick: ArmorPiece | null = null;
  const reclassQueue: ReclassEntry[] = [];

  const getTargetWave = (): PieceWave => {
    const v = reclassWave.value;
    return isPieceWave(v) ? v : 'torso';
  };

  const setTargetWave = (wave: PieceWave) => {
    reclassWave.value = wave;
  };

  const renderReclassList = () => {
    reclassCount.textContent = String(reclassQueue.length);
    reclassList.innerHTML = '';
    for (const e of reclassQueue) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${e.short}</strong> <span class="from-to">${e.from}→${e.to}</span>`;
      if (e.note) {
        li.title = e.note;
        li.innerHTML += ` · ${e.note}`;
      }
      reclassList.appendChild(li);
    }
    reclassUndo.disabled = reclassQueue.length === 0;
    reclassCopy.disabled = reclassQueue.length === 0;
    reclassClear.disabled = reclassQueue.length === 0;
  };

  const renderReclassPick = () => {
    if (!reclassPick) {
      reclassPicked.textContent = 'Click a plate to target it';
      reclassPicked.classList.remove('has-pick');
      reclassAdd.disabled = true;
      return;
    }
    const short = shortPieceId(reclassPick.id, reclassPick.wave);
    const r = reclassPick.restPosition;
    reclassPicked.textContent = `${short} · ${reclassPick.wave} · rest(${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)})`;
    reclassPicked.classList.add('has-pick');
    reclassAdd.disabled = false;
    // Default target away from current wave so ADD always changes something
    if (reclassPick.wave === getTargetWave()) {
      const idx = WAVE_ORDER.indexOf(reclassPick.wave);
      const next = WAVE_ORDER[(idx + 1) % WAVE_ORDER.length];
      setTargetWave(next);
    }
  };

  const addReclassEntry = (): boolean => {
    if (!reclassPick) return false;
    const to = getTargetWave();
    if (to === reclassPick.wave) {
      // Nudge to next wave if user left it same-as-from
      const idx = WAVE_ORDER.indexOf(to);
      setTargetWave(WAVE_ORDER[(idx + 1) % WAVE_ORDER.length]);
    }
    const entry = entryFromPiece(
      reclassPick,
      getTargetWave(),
      reclassNote.value,
    );
    // Replace existing entry for same id
    const existing = reclassQueue.findIndex((e) => e.id === entry.id);
    if (existing >= 0) reclassQueue.splice(existing, 1);
    reclassQueue.push(entry);
    reclassNote.value = '';
    renderReclassList();
    return true;
  };

  const cycleTargetWave = (delta: number) => {
    const cur = getTargetWave();
    const idx = WAVE_ORDER.indexOf(cur);
    const next =
      WAVE_ORDER[(idx + delta + WAVE_ORDER.length) % WAVE_ORDER.length];
    setTargetWave(next);
  };

  reclassAdd.addEventListener('click', () => {
    addReclassEntry();
  });
  reclassUndo.addEventListener('click', () => {
    reclassQueue.pop();
    renderReclassList();
  });
  reclassClear.addEventListener('click', () => {
    reclassQueue.length = 0;
    renderReclassList();
  });
  reclassCopy.addEventListener('click', async () => {
    const card = formatReclassCard(reclassQueue);
    try {
      await navigator.clipboard.writeText(card);
      reclassCopy.textContent = 'COPIED';
      window.setTimeout(() => {
        reclassCopy.textContent = 'COPY';
      }, 1200);
    } catch {
      // Fallback: select-friendly prompt
      window.prompt('Copy reclass card:', card);
    }
  });

  renderReclassList();
  renderReclassPick();

  const applyDirectorChrome = () => {
    document.body.classList.toggle('director-mode', directorMode);
    document.body.classList.toggle('viewer-mode', !directorMode);
    directorBtn.classList.toggle('is-active', directorMode);
    directorBtn.setAttribute('aria-pressed', directorMode ? 'true' : 'false');
    directorBtn.title = directorMode
      ? 'Director mode on — hide tools'
      : 'Director mode — audio timeline & plate pick';

    if (directorMode) {
      hudBottomMeta.classList.remove('hidden');
      reclassPanel.classList.remove('hidden');
    } else {
      hudBottomMeta.classList.add('hidden');
      reclassPanel.classList.add('hidden');
    }
  };

  replayBtn.addEventListener('click', () => {
    replayHandler?.();
  });

  skipBtn.addEventListener('click', () => {
    skipHandler?.();
  });

  directorBtn.addEventListener('click', () => {
    directorMode = !directorMode;
    writeDirectorPreference(directorMode);
    applyDirectorChrome();
    directorModeHandler?.(directorMode);
  });

  applyDirectorChrome();

  return {
    setLoadingProgress: (p: number) => {
      loadingFill.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
    },
    hideLoading: () => {
      loading.classList.add('fade-out');
    },
    showHud: () => {
      hudTop.classList.remove('hidden');
      hudBottom.classList.remove('hidden');
      hudCenter.classList.remove('hidden');
      applyDirectorChrome();
    },
    setStatus: (text: string, online = false) => {
      status.textContent = text;
      status.classList.toggle('online', online);
    },
    setIntegrity: (text: string) => {
      integrity.textContent = text;
    },
    setHintVisible: (v: boolean) => {
      hint.classList.toggle('visible', v);
    },
    setReplayEnabled: (v: boolean) => {
      replayBtn.disabled = !v;
    },
    setSkipEnabled: (v: boolean) => {
      skipBtn.disabled = !v;
      skipBtn.classList.toggle('hidden', !v);
    },
    onReplay: (cb: () => void) => {
      replayHandler = cb;
    },
    onSkip: (cb: () => void) => {
      skipHandler = cb;
    },
    updateClock: (elapsedSec: number) => {
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      const whole = Math.floor(s);
      const frac = Math.floor((s - whole) * 100);
      clock.textContent = `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
    },
    fadeTitle: (hide: boolean) => {
      // Collapse title so only status remains in the top bar (still off the suit)
      title.style.opacity = hide ? '0' : '1';
      title.style.maxHeight = hide ? '0' : '2rem';
      title.style.marginBottom = hide ? '0' : '0.2rem';
      title.style.overflow = 'hidden';
      title.style.transition =
        'opacity 0.8s ease, max-height 0.8s ease, margin 0.8s ease';
    },
    isDirectorMode: () => directorMode,
    setDirectorMode: (enabled: boolean) => {
      directorMode = enabled;
      writeDirectorPreference(enabled);
      applyDirectorChrome();
      directorModeHandler?.(directorMode);
    },
    onDirectorModeChange: (cb: (enabled: boolean) => void) => {
      directorModeHandler = cb;
    },
    syncDirectorChrome: () => {
      applyDirectorChrome();
    },
    setDebugProgress: (_p: number) => {
      /* progress scrub lives on the audio timeline playhead */
    },
    setDebugPaused: (_paused: boolean) => {
      /* pause control lives on the audio timeline toolbar */
    },
    setDebugActivePieces: (pieces: DebugActivePiece[]) => {
      if (!directorMode) return;

      if (pieces.length === 0) {
        debugActive.textContent = 'MOVING — —';
        debugActive.classList.remove('has-active');
        debugActive.title = '';
        return;
      }

      const maxShow = 4;
      const labels = pieces.map((p) => {
        const pct = Math.round(p.localProgress * 100);
        return `${shortPieceId(p.id, p.wave)} ${pct}%`;
      });
      const shown = labels.slice(0, maxShow);
      const extra = pieces.length - shown.length;
      const text =
        extra > 0
          ? `MOVING ${pieces.length} · ${shown.join(' · ')} +${extra}`
          : pieces.length === 1
            ? `MOVING · ${shown[0]}`
            : `MOVING ${pieces.length} · ${shown.join(' · ')}`;

      debugActive.textContent = text;
      debugActive.classList.add('has-active');
      debugActive.title = pieces
        .map(
          (p) =>
            `${p.id} (${p.wave}) ${Math.round(p.localProgress * 100)}%`,
        )
        .join('\n');
    },
    setDebugPickedPiece: (info: DebugPickedPiece | null) => {
      if (!directorMode) {
        debugPicked.textContent = 'PICK · click a plate';
        debugPicked.classList.remove('has-pick');
        debugPicked.title = '';
        return;
      }

      if (!info) {
        debugPicked.textContent = 'PICK · click a plate';
        debugPicked.classList.remove('has-pick');
        debugPicked.title = '';
        return;
      }

      const short = shortPieceId(info.id, info.wave);
      const rest =
        info.rest != null
          ? ` · rest(${info.rest.x.toFixed(2)}, ${info.rest.y.toFixed(2)}, ${info.rest.z.toFixed(2)})`
          : '';
      const vis = info.visible ? 'on' : 'off';
      const note = info.note ? ` · ${info.note}` : '';
      debugPicked.textContent = `PICK · ${short} · ${info.wave} · vis ${vis}${rest}${note}`;
      debugPicked.classList.add('has-pick');
      debugPicked.title = [
        `id: ${info.id}`,
        `wave: ${info.wave}`,
        info.meshName ? `mesh: ${info.meshName}` : null,
        `visible: ${info.visible}`,
        info.rest
          ? `rest: ${info.rest.x.toFixed(3)}, ${info.rest.y.toFixed(3)}, ${info.rest.z.toFixed(3)}`
          : null,
        info.note ?? null,
      ]
        .filter(Boolean)
        .join('\n');
    },
    setReclassPick: (piece: ArmorPiece | null) => {
      reclassPick = piece;
      renderReclassPick();
    },
    getReclassTargetWave: () => getTargetWave(),
    cycleReclassTargetWave: (delta: number) => {
      cycleTargetWave(delta);
    },
    addReclassEntry: () => addReclassEntry(),
  };
}
