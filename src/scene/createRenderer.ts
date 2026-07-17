import * as THREE from 'three';

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
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });

  // Match page shell so WebGL never flashes white on first frame
  renderer.setClearColor(0x050508, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping handled in OutputPass when composer is active; keep a
  // bright baseline for the no-bloom fallback path.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // High enough to read dark metal; low enough that gold doesn't clip white
  renderer.toneMappingExposure = 1.7;
  renderer.shadowMap.enabled = false;

  const setSize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
  };

  setSize();
  window.addEventListener('resize', setSize);

  return renderer;
}

export function getViewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}
