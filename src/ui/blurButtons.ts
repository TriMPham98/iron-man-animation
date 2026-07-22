/**
 * After a pointer activation, drop focus from buttons so Space/Enter
 * cannot re-fire them. Keyboard users still Tab into controls; we only
 * clear sticky focus from mouse / touch / pen.
 */
export function installButtonFocusRelease(): void {
  const release = (target: EventTarget | null) => {
    const el =
      target instanceof Element
        ? target.closest('button, [role="button"]')
        : null;
    if (!(el instanceof HTMLElement)) return;
    // After the click/activate has completed
    requestAnimationFrame(() => {
      if (document.activeElement === el) el.blur();
    });
  };

  document.addEventListener(
    'pointerup',
    (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') {
        release(e.target);
      }
    },
    true,
  );

  // Fallback for environments that only synthesize click
  document.addEventListener(
    'click',
    (e) => {
      release(e.target);
    },
    true,
  );
}
