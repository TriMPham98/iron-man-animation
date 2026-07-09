import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface PostStack {
  composer: EffectComposer | null;
  bloom: UnrealBloomPass | null;
  useBloom: boolean;
  resize: (w: number, h: number) => void;
  render: (delta?: number) => void;
  setBloomStrength: (v: number) => void;
}

export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  preferBloom = true,
): PostStack {
  let useBloom = preferBloom;

  // Lightweight capability gate
  try {
    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const rendererStr = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
      if (/SwiftShader|llvmpipe|Software/i.test(rendererStr)) {
        useBloom = false;
      }
    }
  } catch {
    // keep default
  }

  if (!useBloom) {
    return {
      composer: null,
      bloom: null,
      useBloom: false,
      resize: () => {},
      render: () => {
        renderer.render(scene, camera);
      },
      setBloomStrength: () => {},
    };
  }

  const size = new THREE.Vector2();
  renderer.getSize(size);

  const composer = new EffectComposer(renderer);
  composer.setSize(size.x, size.y);
  composer.setPixelRatio(renderer.getPixelRatio());

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    0.55, // strength
    0.4, // radius
    0.82, // threshold — only bright emissives bloom
  );
  composer.addPass(bloom);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  return {
    composer,
    bloom,
    useBloom: true,
    resize: (w: number, h: number) => {
      composer.setSize(w, h);
      composer.setPixelRatio(renderer.getPixelRatio());
      bloom.resolution.set(w, h);
    },
    render: () => {
      composer.render();
    },
    setBloomStrength: (v: number) => {
      bloom.strength = v;
    },
  };
}
