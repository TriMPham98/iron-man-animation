import * as THREE from 'three';

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });

  renderer.setClearColor(0x0a0e18, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping handled in OutputPass when composer is active; keep a
  // bright baseline for the no-bloom fallback path.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.15;
  renderer.shadowMap.enabled = false;

  const setSize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
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
