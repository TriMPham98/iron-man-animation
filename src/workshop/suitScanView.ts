import * as THREE from 'three';

/**
 * Live JARVIS diagnostic feed for the workshop monitors: the suit's own
 * edge wireframe (same look as the end-of-cycle diagnostic scan) slowly
 * turning on a turntable while a scan band sweeps head → feet, rendered
 * into a small offscreen target the screen shaders sample.
 */
export class SuitScanView {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly rig = new THREE.Group();
  private readonly wireMat: THREE.ShaderMaterial;
  private readonly ring: THREE.Mesh;
  private time = 0;
  private sinceRender = Infinity;
  private frames = 0;
  private readonly height: number;

  constructor(suitGeometry: THREE.BufferGeometry, width = 512, height = 288) {
    this.target = new THREE.WebGLRenderTarget(width, height);
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0x020b12);

    suitGeometry.computeBoundingBox();
    const box = suitGeometry.boundingBox!;
    this.height = box.max.y - box.min.y;

    // Feature edges only (≈ panel lines), like the diagnostic overlay
    const edges = longEdges(new THREE.EdgesGeometry(suitGeometry, 38), 0.012);
    this.wireMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uScanY: { value: 2 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying float vY;
        void main() {
          vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uScanY;
        uniform float uTime;
        varying float vY;
        void main() {
          float d = vY - uScanY;
          // Bright band at the front; scanned region (above) stays lit
          float band = exp(-d * d * 900.0);
          float scanned = smoothstep(-0.02, 0.06, d);
          float base = mix(0.16, 0.42, scanned);
          vec3 col = vec3(0.35, 0.85, 1.0) * (base + band * 2.2);
          col += vec3(1.0, 0.75, 0.35) * band * 0.6 * step(0.5, fract(uTime * 3.0));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const wire = new THREE.LineSegments(edges, this.wireMat);
    wire.position.y = -box.min.y;
    this.rig.add(wire);
    this.scene.add(this.rig);

    // Scan disc + turntable rings
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x5ad8ff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.47, 64), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.scene.add(this.ring);
    for (const r of [0.55, 0.7]) {
      const floor = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.012, 64), ringMat);
      floor.rotation.x = -Math.PI / 2;
      this.scene.add(floor);
    }
    const grid = new THREE.GridHelper(3, 24, 0x0f3c52, 0x0a2433);
    this.scene.add(grid);

    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
    this.camera.position.set(0, this.height * 0.62, 4.4);
    this.camera.lookAt(0, this.height * 0.5, 0);
  }

  /** Advance the turntable + scan; re-render at most `hz` times a second. */
  update(dt: number, renderer: THREE.WebGLRenderer, hz = 12): void {
    this.time += dt;
    this.rig.rotation.y = this.time * 0.45;
    // Head → feet sweep, 3.2 s per pass with a short hold at the feet
    const u = (this.time % 3.6) / 3.2;
    const scanY = THREE.MathUtils.lerp(this.height + 0.05, -0.02, Math.min(1, u));
    this.wireMat.uniforms.uScanY.value = scanY;
    this.wireMat.uniforms.uTime.value = this.time;
    this.ring.position.y = Math.max(0.002, scanY);
    this.ring.scale.setScalar(0.85 + 0.25 * Math.sin(Math.min(1, u) * Math.PI));

    // Throttled by time and by frame count so slow GPUs never pay every frame
    this.sinceRender += dt;
    this.frames++;
    if (this.sinceRender < 1 / hz || this.frames < 3) return;
    this.sinceRender = 0;
    this.frames = 0;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.target.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
  }
}

/** Keep only edges longer than `min` (m) — drops micro-detail line noise. */
function longEdges(edges: THREE.BufferGeometry, min: number): THREE.BufferGeometry {
  const src = edges.getAttribute('position') as THREE.BufferAttribute;
  const keep: number[] = [];
  for (let i = 0; i + 1 < src.count; i += 2) {
    const dx = src.getX(i + 1) - src.getX(i);
    const dy = src.getY(i + 1) - src.getY(i);
    const dz = src.getZ(i + 1) - src.getZ(i);
    if (dx * dx + dy * dy + dz * dz < min * min) continue;
    keep.push(src.getX(i), src.getY(i), src.getZ(i), src.getX(i + 1), src.getY(i + 1), src.getZ(i + 1));
  }
  edges.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  return out;
}
