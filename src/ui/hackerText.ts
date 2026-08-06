/**
 * Decode-style scramble (from TriMPham98/hacker-text).
 * Letters resolve left → right from random A–Z into the original string.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export type HackerTextOptions = {
  /** Interval between scramble frames (ms). Default 30. */
  intervalMs?: number;
  /** Characters resolved per frame. Default 1/3 (matches original). */
  step?: number;
};

function prefersReducedMotion(): boolean {
  return (
    document.body.classList.contains('reduced-motion') ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Em tracking on the label (must match CSS `.jarvis-orb-label`). */
const LABEL_LETTER_SPACING_EM = 0.12;

/**
 * Nucleus content width for the label glyphs.
 * Prefers live layout; falls back to the orb button geometry so a 0×0
 * measure (hidden/display:none parent mid-frame) never collapses type to 8px.
 */
function availableLabelWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const laidOut = el.clientWidth - padL - padR;
  if (laidOut >= 8) return laidOut;

  const orb =
    el.closest('.jarvis-orb') ??
    el.closest('.start-btn') ??
    el.parentElement;
  if (orb instanceof HTMLElement && orb.clientWidth > 0) {
    // Label uses inset: 25% → 50% of orb; padding ~4% of label each side.
    return orb.clientWidth * 0.5 * 0.92;
  }
  // Last resort: CSS --orb-size on the button (may be a min() expression).
  if (orb instanceof HTMLElement) {
    const raw = getComputedStyle(orb).getPropertyValue('--orb-size').trim();
    // Browser resolves used size on width; clientWidth already tried.
    void raw;
  }
  return 0;
}

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  const c = document.createElement('canvas');
  measureCtx = c.getContext('2d');
  return measureCtx;
}

/**
 * Width of `sample` at `fontSizePx` with the label face + em tracking.
 * Uses canvas so flex/overflow on the live node cannot skew the result.
 * Letter-spacing counted between characters only (n−1 gaps) — matches CSS.
 */
function measureSampleWidth(
  el: HTMLElement,
  sample: string,
  fontSizePx: number,
): number {
  const cs = getComputedStyle(el);
  const ctx = getMeasureCtx();
  if (!ctx) {
    // Fallback: detached span
    const probe = document.createElement('span');
    probe.textContent = sample;
    probe.style.cssText = [
      'position:absolute',
      'left:-9999px',
      'visibility:hidden',
      'white-space:nowrap',
      `font-family:${cs.fontFamily}`,
      `font-weight:${cs.fontWeight}`,
      `font-size:${fontSizePx}px`,
      `letter-spacing:${LABEL_LETTER_SPACING_EM * fontSizePx}px`,
      'text-transform:uppercase',
    ].join(';');
    document.body.appendChild(probe);
    const w = probe.offsetWidth;
    probe.remove();
    return w;
  }

  const weight = cs.fontWeight || '400';
  const family = cs.fontFamily || 'Michroma, sans-serif';
  ctx.font = `${weight} ${fontSizePx}px ${family}`;
  const base = ctx.measureText(sample).width;
  const gaps = Math.max(0, sample.length - 1);
  return base + gaps * LABEL_LETTER_SPACING_EM * fontSizePx;
}

/**
 * Binary-search the largest font-size (px) that keeps `sample` inside the
 * nucleus. Fits the *final* label (not WWW…); circular clip catches brief
 * wider scramble frames.
 */
export function fitLabelFontSize(
  el: HTMLElement,
  sample: string,
  opts?: { minPx?: number; maxPx?: number; safety?: number },
): number {
  const minPx = opts?.minPx ?? 10;
  // Slight under-fill so glow / AA don't kiss the rim; NOT a huge W-margin.
  const safety = opts?.safety ?? 0.97;
  const available = availableLabelWidth(el) * safety;

  if (available < 4) {
    // Still try a readable default rather than collapsing to unreadable.
    const fallback = Math.max(minPx, 16);
    el.style.fontSize = `${fallback}px`;
    return fallback;
  }

  // Allow type nearly as tall as the content box — width search is the clamp.
  const maxPx = opts?.maxPx ?? Math.max(minPx, available * 0.62);

  let lo = minPx;
  let hi = maxPx;

  if (measureSampleWidth(el, sample, hi) <= available) {
    el.style.fontSize = `${hi}px`;
    return hi;
  }

  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (measureSampleWidth(el, sample, mid) <= available) lo = mid;
    else hi = mid;
  }

  const fitted = Math.max(minPx, Math.round(lo * 100) / 100);
  el.style.fontSize = `${fitted}px`;
  return fitted;
}

/**
 * Wait for the JARVIS display face so measureText is accurate.
 */
export async function ensureJarvisFont(): Promise<void> {
  try {
    if (!document.fonts?.load) return;
    await document.fonts.load('400 48px Michroma');
    await document.fonts.ready;
  } catch {
    /* offline / blocked fonts — fall through with fallback stack */
  }
}

/**
 * Maximize label type inside its nucleus for the given final string.
 */
export function fitHackerLabel(el: HTMLElement, finalText?: string): number {
  const raw = (finalText ?? el.dataset.value ?? el.textContent ?? '').trim();
  const original = raw.toUpperCase();
  if (!original) return 0;
  el.dataset.value = original;
  // Fit the real word — overflow:hidden on the nucleus handles scramble spikes.
  return fitLabelFontSize(el, original);
}

/**
 * Play a one-shot scramble on `el` (no hover).
 * Uses `data-value` as the resolved string (falls back to textContent).
 * Returns a cancel fn that restores the final label and clears the timer.
 */
export function playHackerText(
  el: HTMLElement,
  options: HackerTextOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 30;
  const step = options.step ?? 1 / 3;

  const raw = (el.dataset.value ?? el.textContent ?? '').trim();
  const original = raw.toUpperCase();
  el.dataset.value = original;

  // Size against widest scramble glyphs before the first frame paints.
  fitHackerLabel(el, original);

  let timer = 0;
  let cancelled = false;

  const finish = () => {
    if (timer) {
      window.clearInterval(timer);
      timer = 0;
    }
    if (!cancelled) el.textContent = original;
  };

  if (prefersReducedMotion() || original.length === 0) {
    el.textContent = original;
    return () => {
      cancelled = true;
    };
  }

  // Start fully scrambled so the decode is visible immediately
  el.textContent = original
    .split('')
    .map((ch) =>
      ch === ' ' || ch === '.' || ch === '-' || ch === '_'
        ? ch
        : LETTERS[Math.floor(Math.random() * LETTERS.length)]!,
    )
    .join('');

  let iterations = 0;
  timer = window.setInterval(() => {
    if (cancelled) {
      finish();
      return;
    }
    el.textContent = original
      .split('')
      .map((ch, index) => {
        if (ch === ' ' || ch === '.' || ch === '-' || ch === '_') return ch;
        if (index < iterations) return original[index]!;
        return LETTERS[Math.floor(Math.random() * LETTERS.length)]!;
      })
      .join('');

    if (iterations >= original.length) {
      finish();
      return;
    }
    iterations += step;
  }, intervalMs);

  return () => {
    cancelled = true;
    finish();
  };
}
