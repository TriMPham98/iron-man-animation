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
  onReplay: (cb: () => void) => void;
  updateClock: (elapsedSec: number) => void;
  fadeTitle: (hide: boolean) => void;
  /** Show debug scrubber (progress + pause). */
  showDebugScrubber: () => void;
  /** Update slider from live timeline progress (ignored while user drags). */
  setDebugProgress: (p: number) => void;
  setDebugPaused: (paused: boolean) => void;
  /** Labels for plates currently mid-flight. */
  setDebugActivePieces: (pieces: DebugActivePiece[]) => void;
  /** Raycast pick readout (null clears to idle hint). */
  setDebugPickedPiece: (info: DebugPickedPiece | null) => void;
  /** Fired while scrubbing / on commit — progress 0–1. */
  onDebugSeek: (cb: (progress01: number) => void) => void;
  onDebugTogglePause: (cb: () => void) => void;
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
  const clock = el<HTMLSpanElement>('hud-clock');
  const title = el<HTMLHeadingElement>('title');
  const debugScrubber = el<HTMLDivElement>('debug-scrubber');
  const debugPauseBtn = el<HTMLButtonElement>('debug-pause-btn');
  const debugProgress = el<HTMLInputElement>('debug-progress');
  const debugLabel = el<HTMLSpanElement>('debug-progress-label');
  const debugActive = el<HTMLDivElement>('debug-active-piece');
  const debugPicked = el<HTMLDivElement>('debug-picked-piece');

  let replayHandler: (() => void) | null = null;
  let seekHandler: ((p: number) => void) | null = null;
  let togglePauseHandler: (() => void) | null = null;
  let userScrubbing = false;

  const formatPct = (p: number) =>
    `${Math.round(THREE_Math_clamp01(p) * 100)}%`;

  const shortPieceId = (id: string, wave: string) => {
    // shard-12-shoulders → shoulders#12 ; keep compact custom ids as-is
    const m = /^shard-(\d+)-(.+)$/.exec(id);
    if (m) return `${m[2]}#${m[1]}`;
    if (id.startsWith(wave)) return id;
    return `${wave}/${id}`;
  };

  const applySliderVisual = (p: number) => {
    const clamped = THREE_Math_clamp01(p);
    debugProgress.value = String(Math.round(clamped * 1000));
    debugLabel.textContent = formatPct(clamped);
  };

  replayBtn.addEventListener('click', () => {
    replayHandler?.();
  });

  debugPauseBtn.addEventListener('click', () => {
    togglePauseHandler?.();
  });

  const emitSeek = () => {
    const p = Number(debugProgress.value) / 1000;
    debugLabel.textContent = formatPct(p);
    seekHandler?.(p);
  };

  debugProgress.addEventListener('pointerdown', () => {
    userScrubbing = true;
  });
  debugProgress.addEventListener('pointerup', () => {
    userScrubbing = false;
    emitSeek();
  });
  debugProgress.addEventListener('pointercancel', () => {
    userScrubbing = false;
  });
  // Live scrub while dragging
  debugProgress.addEventListener('input', () => {
    userScrubbing = true;
    emitSeek();
  });
  debugProgress.addEventListener('change', () => {
    userScrubbing = false;
    emitSeek();
  });

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
      // status lives inside top bar — no floating overlay over the suit
      hudCenter.classList.remove('hidden');
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
    onReplay: (cb: () => void) => {
      replayHandler = cb;
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
    showDebugScrubber: () => {
      debugScrubber.classList.remove('hidden');
    },
    setDebugProgress: (p: number) => {
      if (userScrubbing) return;
      applySliderVisual(p);
    },
    setDebugPaused: (paused: boolean) => {
      debugPauseBtn.textContent = paused ? 'PLAY' : 'PAUSE';
      debugPauseBtn.classList.toggle('is-paused', paused);
    },
    setDebugActivePieces: (pieces: DebugActivePiece[]) => {
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
    onDebugSeek: (cb: (progress01: number) => void) => {
      seekHandler = cb;
    },
    onDebugTogglePause: (cb: () => void) => {
      togglePauseHandler = cb;
    },
  };
}

function THREE_Math_clamp01(p: number): number {
  return Math.min(1, Math.max(0, p));
}
