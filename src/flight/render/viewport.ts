/**
 * The one size the flight view is drawn at: the visible viewport, in CSS px.
 *
 * Everything that has an aspect (the canvases' CSS boxes, the WebGL drawing
 * buffer, the camera, the HUD) takes it from here, so they can't disagree.
 * They used to read window.innerWidth / innerHeight on 'resize' while the
 * canvases were laid out by CSS (`position: fixed; 100%`) — on a phone the
 * two come apart (Chrome Android's toolbar and rotation: the layout box and
 * innerHeight are different viewports, and the visual viewport changes
 * without a window 'resize'), and the browser stretched the buffer into
 * whatever box it had.
 */

type ViewportWindow = Pick<Window, 'innerWidth' | 'innerHeight'> & {
  visualViewport?: Pick<VisualViewport, 'width' | 'height' | 'scale'> | null;
};

export function viewportSize(win: ViewportWindow = window): { w: number; h: number } {
  const vv = win.visualViewport;
  // Pinch zoom shrinks the visual viewport but not the page: undo the scale
  const w = vv && vv.width > 0 ? vv.width * (vv.scale || 1) : win.innerWidth;
  const h = vv && vv.height > 0 ? vv.height * (vv.scale || 1) : win.innerHeight;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** Touch screens wider than this get no wider a view than this would (ultra-wide phones). */
export const TOUCH_MAX_ASPECT = 16 / 9;

/**
 * Camera zoom that keeps a wide phone's horizontal field of view to what the
 * same vertical one gives at {@link TOUCH_MAX_ASPECT} (a 19.5:9 screen at a
 * fixed vertical fov is ~106° across — fish-eye at the edges). 1 below it.
 */
export function wideZoom(aspect: number, maxAspect = TOUCH_MAX_ASPECT): number {
  return aspect > maxAspect ? aspect / maxAspect : 1;
}

/** Screens narrower than this (portrait) see at least as far across as this would. */
export const PORTRAIT_MIN_ASPECT = 0.7;

/**
 * Camera zoom (< 1: wider) that keeps a portrait screen's horizontal field of
 * view to what the same vertical one gives at {@link PORTRAIT_MIN_ASPECT}. A
 * phone held upright (~0.46) at a fixed vertical fov sees a sliver across —
 * the suit's shoulders and the arms beside it fall out of the frame. 1 above it.
 */
export function portraitZoom(aspect: number, minAspect = PORTRAIT_MIN_ASPECT): number {
  return aspect < minAspect ? aspect / minAspect : 1;
}
