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
  ui.setLoadingProgress(0.05);
  ui.setStatus('LOADING SUIT MESH…');

  const renderer = createRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = createCamera();
  const lookTarget = new THREE.Vector3(0, 0.95, 0);

  createEnvironment(scene);
  const lights = createLights();
  scene.add(lights.group);

  // Studio env with warm keys so gold metal keeps color in reflections
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0a0e18);
  envScene.add(new THREE.HemisphereLight(0xc0d4f0, 0x1a1018, 1.8));
  const envKey = new THREE.DirectionalLight(0xfff2dc, 4.0);
  envKey.position.set(3, 8, 2);
  envScene.add(envKey);
  const envKey2 = new THREE.DirectionalLight(0xffe8c8, 2.4);
  envKey2.position.set(-2, 4, 5);
  envScene.add(envKey2);
  const envRim = new THREE.DirectionalLight(0x66d0e8, 2.2);
  envRim.position.set(-5, 3, -3);
  envScene.add(envRim);
  const envHot = new THREE.DirectionalLight(0xfff0e0, 2.8);
  envHot.position.set(0, 2, 6);
  envScene.add(envHot);
  const envMap = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 1.15;
  pmrem.dispose();

  ui.setLoadingProgress(0.15);

  const suit = await Suit.create((r) => {
    ui.setLoadingProgress(0.15 + r * 0.55);
  });
  scene.add(suit.group);

  ui.setLoadingProgress(0.75);

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

  ui.setLoadingProgress(0.9);

  let assemblyComplete = false;
  let clockStart = 0;
  const clock = new THREE.Clock();

  const assembly = createAssemblyTimeline(suit, camera, lights, lookTarget, {
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
      suit.showFinal(); // seamless mesh — no grid-shard square blooms
      controls.target.copy(lookTarget);
      controls.enabled = true;
      controls.autoRotate = true;
      ui.setReplayEnabled(true);
      ui.setHintVisible(true);
      ui.fadeTitle(true);
      ui.setIntegrity('INTEGRITY 100%');
      ui.setStatus('SYSTEMS ONLINE', true);
    },
  });

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
      lights.reactor.intensity = 3.5 + Math.sin(t * 3.2) * 0.4;
    }

    ui.updateClock(Math.max(0, t - clockStart));
    post.render(delta);
  };

  ui.setLoadingProgress(1);

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
