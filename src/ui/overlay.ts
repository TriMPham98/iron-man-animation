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
  JARVIS_DISMISS_MS,
  JARVIS_LEAVE_MS,
  shouldHandoffJarvisPanel,
} from './jarvisHud';
import {
  readDirectorPreference,
  writeDirectorPreference,
} from './viewerMode';
import {
  ensureJarvisFont,
  fitHackerLabel,
  playHackerText,
} from './hackerText';

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
  /** Updates integrity strip under the status line. */
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
  /** Assembly progress 0–1 → integrity bar + brand live glow. */
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
  /** JARVIS: systems-online flourish, then auto-dismiss the panel. */
  setSystemsOnline: (online: boolean) => void;
  /**
   * JARVIS: reset state and show the top-bar briefing for a new assembly run.
   * Replaces the old title/status/INT loading strip while visible.
   * @param opts.softProgress Ease the integrity fill 100%→0% (post-showcase restart).
   */
  resetJarvisChrome: (opts?: { softProgress?: boolean }) => void;
  /** First-play hangar gate (INITIATE CTA). Hidden after the user starts. */
  showStartGate: () => void;
  hideStartGate: () => void;
  isStartGateVisible: () => boolean;
  /**
   * True after INITIATE (click / Enter / Space / R) has been accepted.
   * Transport hotkeys (R replay, S skip, scrub) must stay off until then
   * so they cannot start assembly while the gate is still pending/loading.
   */
  hasInitiated: () => boolean;
  /**
   * Fired once when the user initiates via button, Enter, Space, or R.
   * May run after a short exit-animation delay.
   */
  onStart: (cb: () => void) => void;
  /**
   * Fired synchronously on the INITIATE gesture (before exit delay).
   * Use for audio autoplay unlock — setTimeout loses user activation.
   */
  onStartGesture: (cb: () => void) => void;
  /**
   * Cyan holographic toast near the bottom of the viewport.
   * Auto-hides after a short hold; restarts the timer on repeat calls.
   */
  showToast: (message: string, holdMs?: number) => void;
  /**
   * Binary-interface JARVIS ticker (seed-clock driven).
   * Pass null / empty to hide. Same line re-entry does not re-flash.
   */
  setTelemetry: (line: string | null, opts?: { kind?: string }) => void;
  /** Force-hide telemetry (sequence reset / reduced-motion skip). */
  clearTelemetry: () => void;
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

function elOptional<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function createOverlay(): OverlayHandles {
  const loading = el<HTMLDivElement>('loading');
  const loadingFill = el<HTMLDivElement>('loading-fill');
  const hudTop = el<HTMLElement>('hud-top');
  const hudCenter = el<HTMLDivElement>('hud-center');
  const hudFrame = el<HTMLDivElement>('hud-frame');
  const status = el<HTMLParagraphElement>('status');
  const directorBtn = el<HTMLButtonElement>('director-btn');
  const clock = el<HTMLSpanElement>('hud-clock');
  const progressBar = el<HTMLDivElement>('hud-progress');
  const progressFill = el<HTMLDivElement>('hud-progress-fill');
  const startGate = elOptional<HTMLDivElement>('start-gate');
  const startBtn = elOptional<HTMLButtonElement>('start-btn');
  const startLabel =
    startBtn?.querySelector<HTMLElement>('.jarvis-orb-label') ?? null;

  // JARVIS lives in the top-bar center (replaces old title/status/INT strip)
  const jarvisPanel = elOptional<HTMLDivElement>('jarvis-panel');
  const jarvisInt = elOptional<HTMLSpanElement>('jarvis-int');

  let directorModeHandler: ((enabled: boolean) => void) | null = null;
  let directorMode = readDirectorPreference();
  let lastStatus = '';
  let statusFlashTimer = 0;
  let hudBooted = false;
  let lastClockText = '';
  let lastProgressPct = -1;
  let startGateVisible = false;
  let startHandler: (() => void) | null = null;
  let startGestureHandler: (() => void) | null = null;
  let startConsumed = false;

  let systemsOnline = false;
  let dismissTimer = 0;
  /** True once the BCI → top-panel leave has been scheduled (once per run). */
  let bciHandoffScheduled = false;
  let lastProgress = 0;
  let toastTimer = 0;
  let toastHideTimer = 0;

  const reducedMotion = () =>
    document.body.classList.contains('reduced-motion') ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const toastEl = elOptional<HTMLDivElement>('hud-toast');
  const telemetryEl = elOptional<HTMLDivElement>('jarvis-telemetry');
  const telemetryLineEl = elOptional<HTMLSpanElement>('jarvis-telemetry-line');
  let lastTelemetryLine = '';
  let telemetryHideTimer = 0;
  let telemetryPulseTimer = 0;

  const showToast = (message: string, holdMs = 1600) => {
    if (!toastEl) return;
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
    toastEl.textContent = message;
    toastEl.classList.remove('is-hiding');
    toastEl.classList.add('is-visible');
    toastEl.removeAttribute('hidden');
    toastEl.setAttribute('aria-hidden', 'false');
    const hold = Math.max(400, holdMs);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.add('is-hiding');
      toastEl.classList.remove('is-visible');
      toastHideTimer = window.setTimeout(() => {
        toastEl.classList.remove('is-hiding');
        toastEl.setAttribute('hidden', '');
        toastEl.setAttribute('aria-hidden', 'true');
      }, reducedMotion() ? 0 : 280);
    }, hold);
  };

  const hideTelemetryNow = () => {
    if (!telemetryEl) return;
    window.clearTimeout(telemetryHideTimer);
    window.clearTimeout(telemetryPulseTimer);
    telemetryEl.classList.remove('is-visible', 'is-hiding', 'is-pulse');
    telemetryEl.setAttribute('hidden', '');
    telemetryEl.setAttribute('aria-hidden', 'true');
    if (telemetryLineEl) telemetryLineEl.textContent = '';
    lastTelemetryLine = '';
  };

  const clearTelemetry = () => {
    if (!telemetryEl) return;
    // Already gone or mid-exit — don't reset the hide timer every frame.
    if (
      telemetryEl.hasAttribute('hidden') ||
      telemetryEl.classList.contains('is-hiding')
    ) {
      return;
    }
    if (!telemetryEl.classList.contains('is-visible') && !lastTelemetryLine) {
      return;
    }
    if (reducedMotion()) {
      hideTelemetryNow();
      return;
    }
    window.clearTimeout(telemetryPulseTimer);
    lastTelemetryLine = '';
    telemetryEl.classList.add('is-hiding');
    telemetryEl.classList.remove('is-visible', 'is-pulse');
    window.clearTimeout(telemetryHideTimer);
    telemetryHideTimer = window.setTimeout(() => {
      hideTelemetryNow();
    }, 320);
  };

  /**
   * Top SYSTEMS ONLINE ends the instant bottom BCI telemetry takes over
   * (assembly complete). Cancels any fallback dismiss timer. Once per run.
   */
  const handoffJarvisPanelToTelemetry = () => {
    if (!jarvisPanel || bciHandoffScheduled) return;
    const panelVisible =
      !jarvisPanel.classList.contains('is-hidden') &&
      !jarvisPanel.classList.contains('is-leaving');
    if (
      !shouldHandoffJarvisPanel({
        telemetryActive: true,
        panelVisible,
        systemsOnline,
        integrity01: lastProgress,
      })
    ) {
      return;
    }
    bciHandoffScheduled = true;
    window.clearTimeout(dismissTimer);
    dismissTimer = 0;
    hideJarvisPanel(false);
  };

  /**
   * Show / update the binary-interface ticker. Same line is a no-op so
   * the seed-clock render loop can call every frame without re-flashing.
   */
  const setTelemetry = (line: string | null, opts?: { kind?: string }) => {
    if (!telemetryEl || !telemetryLineEl) return;
    const next = (line ?? '').trim();
    if (!next) {
      clearTelemetry();
      return;
    }
    if (next === lastTelemetryLine && telemetryEl.classList.contains('is-visible')) {
      // Integrity may just have hit 100% while this line is held — recheck handoff.
      handoffJarvisPanelToTelemetry();
      return;
    }
    lastTelemetryLine = next;
    window.clearTimeout(telemetryHideTimer);
    telemetryLineEl.textContent = next;
    if (opts?.kind) telemetryEl.dataset.kind = opts.kind;
    else delete telemetryEl.dataset.kind;

    telemetryEl.classList.remove('is-hiding');
    telemetryEl.classList.add('is-visible');
    telemetryEl.removeAttribute('hidden');
    telemetryEl.setAttribute('aria-hidden', 'false');

    // Retrigger flash + scan on each new cue
    telemetryEl.classList.remove('is-pulse');
    void telemetryEl.offsetWidth;
    if (!reducedMotion()) {
      telemetryEl.classList.add('is-pulse');
      window.clearTimeout(telemetryPulseTimer);
      telemetryPulseTimer = window.setTimeout(() => {
        telemetryEl.classList.remove('is-pulse');
      }, 560);
    }

    // First (and subsequent new) BCI lines: yield the top integrity strip.
    handoffJarvisPanelToTelemetry();
  };

  const hideJarvisPanel = (immediate = false) => {
    if (!jarvisPanel) return;
    window.clearTimeout(dismissTimer);
    jarvisPanel.classList.remove('is-visible', 'is-entering');
    hudTop.classList.remove('is-jarvis-live');
    if (immediate || reducedMotion()) {
      jarvisPanel.classList.remove('is-leaving', 'is-complete');
      jarvisPanel.classList.add('is-hidden');
      jarvisPanel.setAttribute('aria-hidden', 'true');
      return;
    }
    // Collapse + fade while still is-complete (cyan finish state)
    jarvisPanel.classList.add('is-leaving');
    jarvisPanel.classList.remove('is-visible');
    window.setTimeout(() => {
      jarvisPanel.classList.add('is-hidden');
      jarvisPanel.classList.remove('is-leaving', 'is-complete');
      jarvisPanel.setAttribute('aria-hidden', 'true');
    }, JARVIS_LEAVE_MS);
  };

  const showJarvisPanel = () => {
    if (!jarvisPanel) return;
    window.clearTimeout(dismissTimer);
    jarvisPanel.classList.remove('is-hidden', 'is-leaving', 'is-complete');
    jarvisPanel.setAttribute('aria-hidden', 'false');
    hudTop.classList.add('is-jarvis-live');
    if (reducedMotion()) {
      jarvisPanel.classList.add('is-visible');
      return;
    }
    // Retrigger enter animation cleanly
    jarvisPanel.classList.remove('is-visible', 'is-entering');
    void jarvisPanel.offsetWidth;
    jarvisPanel.classList.add('is-entering');
    window.setTimeout(() => {
      jarvisPanel.classList.remove('is-entering');
      jarvisPanel.classList.add('is-visible');
    }, 450);
  };

  const setSystemsOnline = (online: boolean) => {
    // Edge-trigger the cyan flourish — assembly end + camera-tail complete
    // both used to call this and fire a second flash.
    const becameOnline = online && !systemsOnline;
    systemsOnline = online;
    document.body.classList.toggle('systems-online', online);

    if (becameOnline) {
      hudFrame.classList.add('is-online-flash');
      window.setTimeout(() => {
        hudFrame.classList.remove('is-online-flash');
      }, 1600);
    } else if (!online) {
      hudFrame.classList.remove('is-online-flash');
    }

    if (becameOnline && jarvisPanel) {
      jarvisPanel.classList.add('is-complete');
      window.clearTimeout(dismissTimer);
      // Bottom already on → hand off now (systems-online end = BCI take-over).
      // Otherwise fallback dismiss if BCI never arrives (skip / reduced motion).
      const telemetryLive =
        !!lastTelemetryLine &&
        !!telemetryEl &&
        telemetryEl.classList.contains('is-visible');
      if (telemetryLive) {
        handoffJarvisPanelToTelemetry();
      } else {
        dismissTimer = window.setTimeout(
          () => hideJarvisPanel(false),
          reducedMotion() ? 500 : JARVIS_DISMISS_MS,
        );
      }
    } else if (!online && jarvisPanel?.classList.contains('is-hidden')) {
      showJarvisPanel();
    }
  };

  const resetJarvisChrome = (opts?: { softProgress?: boolean }) => {
    window.clearTimeout(dismissTimer);
    bciHandoffScheduled = false;
    const prevProgress = lastProgress;
    const soft =
      !!opts?.softProgress &&
      prevProgress > 0.02 &&
      !reducedMotion();

    systemsOnline = false;
    lastStatus = '';
    document.body.classList.remove('systems-online');
    hudFrame.classList.remove('is-online-flash');
    status.textContent = 'STAND BY';
    status.classList.remove('online', 'is-updating');
    // Drop cyan complete styling before the fill eases back to gold
    progressBar.classList.remove('is-complete');
    jarvisPanel?.classList.remove('is-complete');
    // New run — clear any leftover binary-interface ticker
    hideTelemetryNow();

    // Show panel first so a soft drain is visible on re-entry
    if (soft) {
      progressFill.style.width = `${(prevProgress * 100).toFixed(3)}%`;
      lastProgress = prevProgress;
      if (jarvisInt) jarvisInt.textContent = `${Math.round(prevProgress * 100)}%`;
      showJarvisPanel();
      void progressFill.offsetWidth;
      setProgressVisual(0, { drain: true });
    } else {
      setProgressVisual(0);
      showJarvisPanel();
    }
  };

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

  const isTypingTarget = (target: EventTarget | null): boolean => {
    const tag = (target as HTMLElement | null)?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  /**
   * Exit handoff: orb flares → shrinks in place,
   * assembly boots mid-shrink so the JARVIS panel enters as the CTA dissolves.
   */
  const START_EXIT_MS = 920;
  /** When to kick assembly (after the bright pulse, mid continuous shrink). */
  const START_ASSEMBLY_AT_MS = 320;

  let startExitTimer = 0;
  let startAssemblyTimer = 0;

  const hideStartGate = () => {
    startGateVisible = false;
    window.clearTimeout(startExitTimer);
    window.clearTimeout(startAssemblyTimer);
    if (!startGate) return;
    startGate.classList.remove('is-exiting');
    startGate.classList.add('is-hidden');
    startGate.setAttribute('aria-hidden', 'true');
    startBtn?.removeAttribute('disabled');
  };

  /** Cancels in-flight decode scramble (one-shot on gate reveal). */
  let cancelHackerText: (() => void) | null = null;

  const refitStartLabel = () => {
    if (!startLabel || !startGateVisible) return;
    // Gate must be visible so clientWidth reflects the nucleus box.
    fitHackerLabel(startLabel);
  };

  // Keep INITIATE maxed inside the nucleus across orientation / resize.
  window.addEventListener('resize', () => {
    if (!startGateVisible || !startLabel) return;
    refitStartLabel();
  });

  const showStartGate = () => {
    // Never re-open after initiate (e.g. R started assembly during load)
    if (startConsumed || !startGate) return;
    startGateVisible = true;
    startGate.classList.remove('is-hidden', 'is-exiting');
    startGate.setAttribute('aria-hidden', 'false');
    startBtn?.removeAttribute('disabled');

    // One-shot decode when load finishes and INITIATE appears (not on hover).
    // Wait for Michroma so fit measures the real HUD face, not a fallback.
    cancelHackerText?.();
    cancelHackerText = null;
    void ensureJarvisFont().then(() => {
      if (!startGateVisible || !startLabel || startConsumed) return;
      // Double rAF: wait until the un-hidden gate has a real nucleus box.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!startGateVisible || !startLabel || startConsumed) return;
          cancelHackerText?.();
          cancelHackerText = playHackerText(startLabel);
        });
      });
    });

    // Focus after HUD boot so Tab/Enter land on the CTA
    window.requestAnimationFrame(() => {
      if (startGateVisible) startBtn?.focus({ preventScroll: true });
    });
  };

  const fireStart = () => {
    // Allow initiate only while the gate is the active CTA (not during load)
    if (startConsumed || !startGateVisible) return;
    startConsumed = true;
    startGateVisible = false;

    // Snap label to final text if scramble is still running
    cancelHackerText?.();
    cancelHackerText = null;

    // Must run in the gesture turn (autoplay unlock, etc.)
    startGestureHandler?.();

    const runAssembly = () => {
      startHandler?.();
    };

    // Reduced motion / missing markup: hard cut into assembly
    if (!startGate || reducedMotion()) {
      hideStartGate();
      runAssembly();
      return;
    }

    startBtn?.blur();
    startBtn?.setAttribute('disabled', '');
    startGate.setAttribute('aria-hidden', 'true');
    // Retrigger exit animation cleanly if class was stuck
    startGate.classList.remove('is-exiting', 'is-hidden');
    void startGate.offsetWidth;
    startGate.classList.add('is-exiting');

    // Assembly + JARVIS panel enter mid continuous shrink
    window.clearTimeout(startAssemblyTimer);
    startAssemblyTimer = window.setTimeout(runAssembly, START_ASSEMBLY_AT_MS);

    window.clearTimeout(startExitTimer);
    startExitTimer = window.setTimeout(() => {
      startGate.classList.add('is-hidden');
      startGate.classList.remove('is-exiting');
    }, START_EXIT_MS);
  };

  startBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    fireStart();
  });

  // Enter / Space / R while gated — same as clicking INITIATE
  window.addEventListener('keydown', (e) => {
    if (!startGateVisible || startConsumed) return;
    if (e.repeat) return;
    // ⌘R / ⌃R must refresh the page, not fire INITIATE (capture phase).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (
      e.key === 'Enter' ||
      e.code === 'Space' ||
      e.key === ' ' ||
      e.key === 'r' ||
      e.key === 'R'
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fireStart();
    }
  }, true);

  applyDirectorChrome();

  let drainClearTimer = 0;

  const clearProgressDrain = () => {
    window.clearTimeout(drainClearTimer);
    progressFill.classList.remove('is-draining');
  };

  /**
   * @param p Integrity 0–1
   * @param opts.drain Temporarily ease width (restart handoff only)
   */
  const setProgressVisual = (p: number, opts?: { drain?: boolean }) => {
    const clamped = Math.min(1, Math.max(0, p));
    const pct = Math.round(clamped * 100);
    // Continuous width so wave-paced fills don’t stair-step on whole percents
    const widthPct = `${(clamped * 100).toFixed(3)}%`;

    if (opts?.drain && !reducedMotion()) {
      progressFill.classList.add('is-draining');
      window.clearTimeout(drainClearTimer);
      drainClearTimer = window.setTimeout(clearProgressDrain, 900);
    } else if (!opts?.drain) {
      // Live assembly updates must not inherit the drain ease
      clearProgressDrain();
    }

    // Width still tracks smoothly every tick; aria / % only on whole-% change
    lastProgress = clamped;
    progressFill.style.width = widthPct;
    if (pct !== lastProgressPct || opts?.drain) {
      lastProgressPct = pct;
      progressBar.setAttribute('aria-valuenow', String(pct));
      progressBar.classList.toggle('is-complete', clamped >= 0.999);
      if (jarvisInt) jarvisInt.textContent = `${pct}%`;
      hudTop.classList.toggle('is-live', clamped > 0.001 && clamped < 0.999);
    }
  };

  const flashStatus = () => {
    status.classList.remove('is-updating');
    // Force reflow so the animation restarts when status changes rapidly
    void status.offsetWidth;
    status.classList.add('is-updating');
    window.clearTimeout(statusFlashTimer);
    statusFlashTimer = window.setTimeout(() => {
      status.classList.remove('is-updating');
    }, 480);
  };

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
      hudFrame.classList.remove('hidden');
      applyDirectorChrome();
      // JARVIS panel is shown by resetJarvisChrome on sequence start — not permanent

      if (!hudBooted) {
        hudBooted = true;
        hudTop.classList.add('is-booting');
        hudFrame.classList.add('is-booted');
        // After entrance settles, keep progress bar visible without re-running rise-in
        window.setTimeout(() => {
          hudTop.classList.remove('is-booting');
          hudTop.classList.add('is-booted');
        }, 900);
      } else {
        hudTop.classList.add('is-booted');
        hudFrame.classList.add('is-booted');
      }
    },
    setStatus: (text: string, online = false) => {
      const changed = text !== lastStatus;
      lastStatus = text;
      status.textContent = text;
      status.classList.toggle('online', online);
      if (changed && text) flashStatus();
      if (online) setSystemsOnline(true);
    },
    setIntegrity: (text: string) => {
      const match = text.match(/(\d+)\s*%/);
      if (match) {
        const pct = Number(match[1]);
        if (Number.isFinite(pct)) setProgressVisual(pct / 100);
      }
    },
    setHintVisible: (_v: boolean) => {
      /* bottom HUD removed — R / S keys still work */
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
      const text = `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
      // Hundredths often hold for multiple frames — skip identical writes
      if (text === lastClockText) return;
      lastClockText = text;
      clock.textContent = text;
    },
    fadeTitle: (_hide: boolean) => {
      /* Title removed — JARVIS owns the top-center assembly brief */
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
    setDebugProgress: (p: number) => {
      setProgressVisual(p);
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
    setSystemsOnline,
    resetJarvisChrome,
    showStartGate,
    hideStartGate,
    isStartGateVisible: () => startGateVisible,
    hasInitiated: () => startConsumed,
    onStart: (cb: () => void) => {
      startHandler = cb;
    },
    onStartGesture: (cb: () => void) => {
      startGestureHandler = cb;
    },
    showToast,
    setTelemetry,
    clearTelemetry,
  };
}
