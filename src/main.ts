import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createAssemblyTimeline } from './animation/assemblyTimeline';
import { createCamera, updateCameraAspect } from './scene/createCamera';
import { createEnvironment } from './scene/createEnvironment';
import { createLights } from './scene/createLights';
import { createPostProcessing } from './scene/postProcessing';
import { createRenderer } from './scene/createRenderer';
import { Suit } from './suit/Suit';
import { createOverlay } from './ui/overlay';

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('Canvas not found');

  const ui = createOverlay();
  ui.setLoadingProgress(0.1);

  const renderer = createRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = createCamera();
  const lookTarget = new THREE.Vector3(0, 0.95, 0);

  ui.setLoadingProgress(0.25);

  createEnvironment(scene);
  const lights = createLights();
  scene.add(lights.group);

  // Soft environment reflections for metals
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.HemisphereLight(0xaabbdd, 0x332222, 1.6));
  const envLight = new THREE.DirectionalLight(0xfff5ee, 2.0);
  envLight.position.set(2, 4, 3);
  envScene.add(envLight);
  const envFill = new THREE.DirectionalLight(0xccddff, 1.0);
  envFill.position.set(-3, 2, -2);
  envScene.add(envFill);
  const envMap = pmrem.fromScene(envScene, 0.04).texture;
  scene.environment = envMap;
  pmrem.dispose();

  ui.setLoadingProgress(0.45);

  const suit = new Suit();
  scene.add(suit.group);

  ui.setLoadingProgress(0.65);

  const post = createPostProcessing(renderer, scene, camera, true);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 2.2;
  controls.maxDistance = 8;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.target.copy(lookTarget);
  controls.enabled = false;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.6;

  ui.setLoadingProgress(0.8);

  let assemblyComplete = false;
  let clockStart = 0;
  const clock = new THREE.Clock();

  const assembly = createAssemblyTimeline(
    suit,
    camera,
    lights,
    lookTarget,
    {
      onStatus: (text) => {
        const online = text.includes('ONLINE') || text.includes('STABLE');
        ui.setStatus(text, online);
      },
      onProgress: (t) => {
        const pct = Math.round(t * 100);
        ui.setIntegrity(`INTEGRITY ${String(pct).padStart(3, ' ')}%`);
      },
      onComplete: () => {
        assemblyComplete = true;
        controls.target.copy(lookTarget);
        controls.enabled = true;
        controls.autoRotate = true;
        ui.setReplayEnabled(true);
        ui.setHintVisible(true);
        ui.fadeTitle(true);
        ui.setIntegrity('INTEGRITY 100%');
        ui.setStatus('SYSTEMS ONLINE', true);
      },
    },
  );

  const startSequence = () => {
    assemblyComplete = false;
    controls.enabled = false;
    controls.autoRotate = false;
    ui.setReplayEnabled(false);
    ui.setHintVisible(false);
    ui.fadeTitle(false);
    ui.setIntegrity('INTEGRITY   0%');
    ui.setStatus('ASSEMBLY SEQUENCE INITIATED');
    assembly.rebuild();
    assembly.play();
    clockStart = clock.getElapsedTime();
  };

  ui.onReplay(() => {
    startSequence();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      startSequence();
    }
  });

  // User grab disables auto-rotate until sequence restarts
  controls.addEventListener('start', () => {
    if (assemblyComplete) controls.autoRotate = false;
  });

  const onResize = () => {
    updateCameraAspect(camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    post.resize(w, h);
  };
  window.addEventListener('resize', onResize);

  let raf = 0;
  let visible = true;

  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState === 'visible';
    if (visible) {
      clock.getDelta();
      loop();
    } else {
      cancelAnimationFrame(raf);
    }
  });

  const loop = () => {
    if (!visible) return;
    raf = requestAnimationFrame(loop);

    const t = clock.getElapsedTime();
    const delta = clock.getDelta();

    if (assemblyComplete) {
      controls.update();
      lookTarget.copy(controls.target);
      suit.updateIdle(t);
      // Gentle reactor light pulse
      lights.reactor.intensity = 3.4 + Math.sin(t * 3.2) * 0.45;
    }

    ui.updateClock(Math.max(0, t - clockStart));

    // Keep controls target synced during cinematic
    if (!controls.enabled) {
      // camera driven by GSAP
    }

    post.render(delta);
  };

  ui.setLoadingProgress(1);

  // Warm first frame then reveal
  post.render();
  await new Promise((r) => setTimeout(r, 280));

  ui.hideLoading();
  ui.showHud();
  await new Promise((r) => setTimeout(r, 400));

  clockStart = clock.getElapsedTime();
  startSequence();
  loop();
}

boot().catch((err) => {
  console.error(err);
  const loading = document.getElementById('loading');
  if (loading) {
    loading.innerHTML = `<p style="color:#c9a227;font-family:monospace;letter-spacing:0.15em">FAILED TO INIT — SEE CONSOLE</p>`;
  }
});
