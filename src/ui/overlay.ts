import type { ArmorPiece, PieceWave } from '../suit/waves';
import {
  entryFromPiece,
  formatReclassCard,
  isPieceWave,
  shortPieceId,
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
  /** Legacy no-op — bottom HUD bar removed. */
  setIntegrity: (text: string) => void;
  setHintVisible: (v: boolean) => void;
  /** Legacy no-op — R / S keys still work via bindInput. */
  setReplayEnabled: (v: boolean) => void;
  setSkipEnabled: (v: boolean) => void;
  onReplay: (cb: () => void) => void;
  onSkip: (cb: () => void) => void;
  updateClock: (elapsedSec: number) => void;
  fadeTitle: (hide: boolean) => void;
  /** Whether director tools (audio timeline, reclass) are visible. */
  isDirectorMode: () => boolean;
  setDirectorMode: (enabled: boolean) => void;
  onDirectorModeChange: (cb: (enabled: boolean) => void) => void;
  /** Show/hide director chrome based on current mode. */
  syncDirectorChrome: () => void;
  /** Legacy no-ops — bottom bar / scrubber chrome removed or lives on the DAW. */
  setDebugProgress: (p: number) => void;
  setDebugPaused: (paused: boolean) => void;
  setDebugActivePieces: (pieces: DebugActivePiece[]) => void;
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
  /** Expand/collapse the reclass card (chip when collapsed). */
  setReclassCollapsed: (collapsed: boolean) => void;
  toggleReclassCollapsed: () => void;
  isReclassCollapsed: () => boolean;
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
  const hudCenter = el<HTMLDivElement>('hud-center');
  const status = el<HTMLParagraphElement>('status');
  const directorBtn = el<HTMLButtonElement>('director-btn');
  const clock = el<HTMLSpanElement>('hud-clock');
  const title = el<HTMLHeadingElement>('title');

  let directorModeHandler: ((enabled: boolean) => void) | null = null;
  let directorMode = readDirectorPreference();

  // ── Reclass panel state ────────────────────────────────────────
  const RECLASS_COLLAPSE_KEY = 'mark-suit-reclass-collapsed';
  const reclassPanel = el<HTMLElement>('reclass-panel');
  const reclassToggle = el<HTMLButtonElement>('reclass-toggle');
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

  const readReclassCollapsed = (): boolean => {
    try {
      const v = window.localStorage.getItem(RECLASS_COLLAPSE_KEY);
      // Default collapsed so the 3D view stays clear until needed
      if (v === null) return true;
      return v === '1';
    } catch {
      return true;
    }
  };

  const writeReclassCollapsed = (collapsed: boolean) => {
    try {
      window.localStorage.setItem(RECLASS_COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // private mode / blocked storage — ignore
    }
  };

  let reclassCollapsed = readReclassCollapsed();

  const applyReclassCollapsed = () => {
    reclassPanel.classList.toggle('is-collapsed', reclassCollapsed);
    reclassToggle.setAttribute('aria-expanded', reclassCollapsed ? 'false' : 'true');
    reclassToggle.title = reclassCollapsed
      ? 'Expand reclass panel (M)'
      : 'Minimize reclass panel (M)';
  };

  const setReclassCollapsed = (collapsed: boolean) => {
    reclassCollapsed = collapsed;
    writeReclassCollapsed(collapsed);
    applyReclassCollapsed();
  };

  const toggleReclassCollapsed = () => {
    setReclassCollapsed(!reclassCollapsed);
  };

  applyReclassCollapsed();

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

  reclassToggle.addEventListener('click', () => {
    toggleReclassCollapsed();
  });
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
      reclassPanel.classList.remove('hidden');
    } else {
      reclassPanel.classList.add('hidden');
    }
  };

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
      hudCenter.classList.remove('hidden');
      applyDirectorChrome();
    },
    setStatus: (text: string, online = false) => {
      status.textContent = text;
      status.classList.toggle('online', online);
    },
    setIntegrity: (_text: string) => {
      /* bottom HUD removed */
    },
    setHintVisible: (_v: boolean) => {
      /* bottom HUD removed — R / S / Space still work */
    },
    setReplayEnabled: (_v: boolean) => {
      /* use R */
    },
    setSkipEnabled: (_v: boolean) => {
      /* use S */
    },
    onReplay: (_cb: () => void) => {
      /* session wires R via bindInput */
    },
    onSkip: (_cb: () => void) => {
      /* session wires S via bindInput */
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
    setDebugActivePieces: (_pieces: DebugActivePiece[]) => {
      /* bottom MOVING readout removed */
    },
    setDebugPickedPiece: (_info: DebugPickedPiece | null) => {
      /* bottom PICK readout removed — reclass panel still shows the target */
    },
    setReclassPick: (piece: ArmorPiece | null) => {
      reclassPick = piece;
      renderReclassPick();
      // Expand so TO/ADD are visible when the director targets a plate
      if (piece && reclassCollapsed) setReclassCollapsed(false);
    },
    getReclassTargetWave: () => getTargetWave(),
    cycleReclassTargetWave: (delta: number) => {
      cycleTargetWave(delta);
    },
    addReclassEntry: () => addReclassEntry(),
    setReclassCollapsed,
    toggleReclassCollapsed,
    isReclassCollapsed: () => reclassCollapsed,
  };
}
