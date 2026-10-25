import * as THREE from 'three';
import { COLORS } from '../utils/colors';

export interface CreateRendererOptions {
  /** Upper bound for devicePixelRatio (default 1.75 = high tier). */
  maxPixelRatio?: number;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions = {},
): THREE.WebGLRenderer {
  const maxPixelRatio = options.maxPixelRatio ?? 1.75;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    // The scene is drawn into the composer's own targets; the canvas only
    // receives the full-screen output quad, so a multisampled backbuffer
    // would be resolved every frame for nothing
    antialias: false,
    stencil: false,
    alpha: false,
    powerPreference: 'high-performance',
  });

  // Match page shell + scene void so WebGL never flashes a mismatched clear
  renderer.setClearColor(COLORS.bg, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping handled in OutputPass when composer is active; keep a
  // bright baseline for the no-bloom fallback path.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // High enough to read dark metal; low enough that gold doesn't clip white
  renderer.toneMappingExposure = 1.7;
  renderer.shadowMap.enabled = false;
  // JARVIS diagnostic wireframe uses material clippingPlanes for the reveal.
  renderer.localClippingEnabled = true;

  const setSize = (first: boolean) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    // After the first size the adaptive resolution owns the ratio: a resize
    // (a phone's toolbar or rotation) keeps what it has settled on rather
    // than snapping back to the ceiling and shedding it again
    renderer.setPixelRatio(first ? dpr : Math.min(renderer.getPixelRatio(), dpr));
    renderer.setSize(w, h, false);
  };

  setSize(true);
  window.addEventListener('resize', () => setSize(false));

  return renderer;
}

export function getViewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}
