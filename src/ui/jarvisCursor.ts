/**
 * JARVIS holographic targeting reticle cursor.
 *
 * Fine-pointer desktops only: hides the system cursor and draws a cyan HUD
 * reticle that lock-on expands over interactive UI. Touch / coarse pointers
 * and reduced-motion keep the native cursor.
 */

export type JarvisCursorMode =
  | 'idle'
  | 'pointer'
  | 'active'
  | 'grab'
  | 'grabbing'
  | 'cross'
  | 'ew'
  | 'text';

const FINE_POINTER_MQ = '(hover: hover) and (pointer: fine)';

/**
 * Idle timeout before the reticle fades out (cinematic auto-hide).
 * Long enough that light pauses don't flicker; short enough the HUD
 * clears during orbit / showcase watching.
 */
const IDLE_FADE_MS = 2500;

/** Elements that should lock-on (clickable HUD chrome). */
const POINTER_SEL =
  'button, a, summary, label, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], .start-btn, .director-btn, .atl-btn, .atl-chip, .atl-field-vol input[type="range"], .atl-field-pitch input[type="range"], .atl-master-vol input[type="range"]';

/** Clip edge / ruler / playhead scrub (checked before grab so handles win). */
const EW_HANDLE_SEL =
  '.atl-clip-handle, .atl-ruler, .atl-playhead, .atl-track-scroll.is-scrubbing, .audio-timeline.is-scrubbing';

/** Empty timeline lane scrub (after clips so grab wins on clips). */
const EW_LANE_SEL = '.atl-lanes';

/** Grab surfaces (clips / track headers). */
const GRAB_SEL = '.atl-clip, .atl-track-header:not(.is-custom)';

/** Crosshair timeline scrubport (when not already scrubbing). */
const CROSS_SEL = '.atl-track-scroll';

/** Text entry. */
const TEXT_SEL =
  'input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="url"], input[type="password"], textarea, [contenteditable="true"]';

function canUseCustomCursor(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia(FINE_POINTER_MQ).matches === false) return false;
  // Keep system cursor for reduced motion — less motion + fewer surprises.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function resolveMode(
  target: EventTarget | null,
  pointerDown: boolean,
): JarvisCursorMode {
  if (!(target instanceof Element)) {
    return pointerDown ? 'active' : 'idle';
  }

  // Priority: text → resize handles → grab → lane scrub → buttons → crosshair.
  if (target.closest(TEXT_SEL)) return 'text';
  if (target.closest(EW_HANDLE_SEL)) return 'ew';
  if (target.closest('.atl-track-header.dragging')) return 'grabbing';
  if (target.closest(GRAB_SEL)) return pointerDown ? 'grabbing' : 'grab';
  if (target.closest(EW_LANE_SEL)) return 'ew';
  if (pointerDown) return 'active';
  if (target.closest(POINTER_SEL)) return 'pointer';
  if (target.closest(CROSS_SEL)) return 'cross';

  return 'idle';
}

function buildCursorEl(): HTMLDivElement {
  const root = document.createElement('div');
  root.id = 'jarvis-cursor';
  root.className = 'jarvis-cursor';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="jarvis-cursor-glow"></div>
    <div class="jarvis-cursor-ring jarvis-cursor-ring-outer"></div>
    <div class="jarvis-cursor-ring jarvis-cursor-ring-inner"></div>
    <div class="jarvis-cursor-cross">
      <span class="jarvis-cursor-arm jarvis-cursor-arm-n"></span>
      <span class="jarvis-cursor-arm jarvis-cursor-arm-e"></span>
      <span class="jarvis-cursor-arm jarvis-cursor-arm-s"></span>
      <span class="jarvis-cursor-arm jarvis-cursor-arm-w"></span>
    </div>
    <div class="jarvis-cursor-brackets" aria-hidden="true">
      <span class="jarvis-cursor-br jarvis-cursor-br-tl"></span>
      <span class="jarvis-cursor-br jarvis-cursor-br-tr"></span>
      <span class="jarvis-cursor-br jarvis-cursor-br-bl"></span>
      <span class="jarvis-cursor-br jarvis-cursor-br-br"></span>
    </div>
    <div class="jarvis-cursor-dot"></div>
    <div class="jarvis-cursor-ew" aria-hidden="true">
      <span class="jarvis-cursor-ew-l"></span>
      <span class="jarvis-cursor-ew-r"></span>
    </div>
  `;
  return root;
}

/**
 * Install the JARVIS cursor. Safe to call once at boot; no-ops on touch
 * devices and when reduced-motion is preferred.
 *
 * @returns dispose function
 */
export function installJarvisCursor(): () => void {
  if (!canUseCustomCursor()) {
    return () => undefined;
  }

  const el = buildCursorEl();
  document.body.appendChild(el);
  document.body.classList.add('jarvis-cursor-active');

  let visible = false;
  let pointerDown = false;
  let mode: JarvisCursorMode = 'idle';
  let idleTimer = 0;

  const setVisible = (next: boolean) => {
    if (visible === next) return;
    visible = next;
    el.classList.toggle('is-visible', next);
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      window.clearTimeout(idleTimer);
      idleTimer = 0;
    }
  };

  /**
   * Show the reticle and (re)arm the idle fade. While a button is held we
   * keep it visible so grab/scrub doesn't vanish mid-gesture.
   */
  const bumpActivity = () => {
    setVisible(true);
    clearIdleTimer();
    if (pointerDown) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      if (!pointerDown) setVisible(false);
    }, IDLE_FADE_MS);
  };

  const setMode = (next: JarvisCursorMode) => {
    if (mode === next) return;
    el.classList.remove(`is-${mode}`);
    mode = next;
    el.classList.add(`is-${mode}`);
    el.dataset.mode = next;
  };

  setMode('idle');

  /** 1:1 with the OS pointer — no lerp / lag. */
  const place = (clientX: number, clientY: number) => {
    el.style.transform = `translate3d(${clientX}px, ${clientY}px, 0)`;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    place(e.clientX, e.clientY);
    bumpActivity();
    setMode(resolveMode(e.target, pointerDown));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    pointerDown = true;
    place(e.clientX, e.clientY);
    bumpActivity();
    setMode(resolveMode(e.target, true));
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    pointerDown = false;
    place(e.clientX, e.clientY);
    bumpActivity();
    setMode(resolveMode(e.target, false));
  };

  const onPointerLeave = () => {
    clearIdleTimer();
    setVisible(false);
    pointerDown = false;
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      clearIdleTimer();
      setVisible(false);
      pointerDown = false;
    }
  };

  // Re-evaluate if the user plugs in a trackpad vs touch, or toggles OS setting.
  const fineMq = window.matchMedia(FINE_POINTER_MQ);
  const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');

  const teardown = () => {
    clearIdleTimer();
    document.body.classList.remove('jarvis-cursor-active');
    el.remove();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    document.documentElement.removeEventListener('mouseleave', onPointerLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    fineMq.removeEventListener('change', onCapabilityChange);
    motionMq.removeEventListener('change', onCapabilityChange);
  };

  const onCapabilityChange = () => {
    if (!canUseCustomCursor()) {
      teardown();
    }
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('pointercancel', onPointerUp, { passive: true });
  document.documentElement.addEventListener('mouseleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  fineMq.addEventListener('change', onCapabilityChange);
  motionMq.addEventListener('change', onCapabilityChange);

  return teardown;
}
