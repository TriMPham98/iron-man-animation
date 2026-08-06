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
