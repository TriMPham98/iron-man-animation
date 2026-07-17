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

export interface CreatePostProcessingOptions {
  /** Prefer enabling bloom (still disabled on software GL). Default true. */
  preferBloom?: boolean;
  /**
   * Run UnrealBloom at half resolution (cheaper mips). Used on medium tier.
   * High stays full-res so look is identical to today.
   */
  halfResBloom?: boolean;
}

export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  preferBloomOrOptions: boolean | CreatePostProcessingOptions = true,
): PostStack {
  const options: CreatePostProcessingOptions =
    typeof preferBloomOrOptions === 'boolean'
      ? { preferBloom: preferBloomOrOptions, halfResBloom: false }
      : preferBloomOrOptions;

  let useBloom = options.preferBloom !== false;
  const halfResBloom = options.halfResBloom === true;
  const bloomScale = halfResBloom ? 0.5 : 1;

  try {
    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const rendererStr = gl.getParameter(
        debugInfo.UNMASKED_RENDERER_WEBGL,
      ) as string;
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

  // Avoid double tone-mapping: RenderPass writes HDR, OutputPass tone-maps once.
  const previousToneMapping = renderer.toneMapping;
  const previousExposure = renderer.toneMappingExposure;
  renderer.toneMapping = THREE.NoToneMapping;

  const composer = new EffectComposer(renderer);
  composer.setSize(size.x, size.y);
  composer.setPixelRatio(renderer.getPixelRatio());

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Very restrained bloom — soft glint on powered systems only.
  // halfResBloom: allocate bloom RTs at 0.5× so mips cost less.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * bloomScale, size.y * bloomScale),
    0.12,
    0.4,
    0.94,
  );
  composer.addPass(bloom);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // Restore exposure used by OutputPass via renderer state it reads
  renderer.toneMapping = previousToneMapping;
  renderer.toneMappingExposure = Math.max(previousExposure, 1.7);

  const syncBloomSize = (w: number, h: number) => {
    const bw = Math.max(1, Math.round(w * bloomScale));
    const bh = Math.max(1, Math.round(h * bloomScale));
    // Prefer setSize so internal render targets actually resize
    if (typeof bloom.setSize === 'function') {
      bloom.setSize(bw, bh);
    }
    bloom.resolution.set(bw, bh);
  };

  return {
    composer,
    bloom,
    useBloom: true,
    resize: (w: number, h: number) => {
      composer.setSize(w, h);
      composer.setPixelRatio(renderer.getPixelRatio());
      syncBloomSize(w, h);
    },
    render: () => {
      // RenderPass must not apply tone mapping mid-pipeline
      const tm = renderer.toneMapping;
      const exp = renderer.toneMappingExposure;
      renderer.toneMapping = THREE.NoToneMapping;
      composer.render();
      renderer.toneMapping = tm;
      renderer.toneMappingExposure = exp;
    },
    setBloomStrength: (v: number) => {
      bloom.strength = v;
    },
  };
}
