import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

/** Layer the contact-shadow camera sees (casters are added to it). */
export const CONTACT_SHADOW_LAYER = 3;

export interface ContactShadowOptions {
  /** Plane height (world y) — the deck the shadow lies on. */
  y: number;
  /** Side of the square capture area (m), centred on the origin. */
  size: number;
  /** How far above the deck geometry still darkens it (m). */
  height: number;
  resolution?: number;
  /** Blur step in texels of a 256 map (two passes). */
  blur?: number;
  darkness?: number;
  opacity?: number;
}

export interface ContactShadow {
  mesh: THREE.Mesh;
  /** Re-capture the casters (once per frame, before the main render). */
  update(): void;
}

/**
 * Soft contact shadow: the casters' undersides rendered from beneath the
 * deck as depth-weighted darkness, blurred, and laid on the floor as a
 * transparent overlay. Darkens whatever lights the deck (env, emissive
 * paint), so it reads on the metallic floor, and it fades as the suit
 * lifts off in the hover test.
 */
export function createContactShadow(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  opts: ContactShadowOptions,
): ContactShadow {
  const res = opts.resolution ?? 512;
  const blur = opts.blur ?? 1.2;
  const rt = new THREE.WebGLRenderTarget(res, res);
  rt.texture.generateMipmaps = false;
  const rtBlur = new THREE.WebGLRenderTarget(res, res);
  rtBlur.texture.generateMipmaps = false;

  const plane = new THREE.PlaneGeometry(opts.size, opts.size).rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(
    plane,
    new THREE.MeshBasicMaterial({
      map: rt.texture,
      opacity: opts.opacity ?? 0.85,
      transparent: true,
      depthWrite: false,
    }),
  );
  mesh.name = 'contact-shadow';
  mesh.renderOrder = 1;
  // The camera looks up from the deck — flip so the map lands the right way round
  mesh.scale.y = -1;
  mesh.position.y = opts.y;

  const half = opts.size / 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0, opts.height);
  cam.rotation.x = Math.PI / 2;
  cam.position.y = opts.y;
  cam.layers.set(CONTACT_SHADOW_LAYER);
  cam.updateMatrixWorld();

  const depthMat = new THREE.MeshDepthMaterial();
  const darkness = { value: opts.darkness ?? 1.4 };
  depthMat.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = darkness;
    shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
      'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
      'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
    )}`;
  };
  depthMat.depthTest = false;
  depthMat.depthWrite = false;

  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  hBlur.depthTest = false;
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  vBlur.depthTest = false;
  // Drawn with the capture camera, so it sits on the caster layer too
  // (at the camera's own height: it renders on the near plane)
  const blurPlane = new THREE.Mesh(plane);
  blurPlane.layers.set(CONTACT_SHADOW_LAYER);
  blurPlane.position.y = opts.y;

  const blurPass = (amount: number) => {
    blurPlane.material = hBlur;
    hBlur.uniforms.tDiffuse.value = rt.texture;
    hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(rtBlur);
    renderer.render(blurPlane, cam);
    blurPlane.material = vBlur;
    vBlur.uniforms.tDiffuse.value = rtBlur.texture;
    vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(rt);
    renderer.render(blurPlane, cam);
  };

  const clear = new THREE.Color();

  return {
    mesh,
    update() {
      const prevTarget = renderer.getRenderTarget();
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clear);
      const prevBg = scene.background;
      const prevFog = scene.fog;
      scene.background = null;
      scene.fog = null;
      scene.overrideMaterial = depthMat;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
      scene.overrideMaterial = null;
      scene.background = prevBg;
      scene.fog = prevFog;
      blurPass(blur);
      blurPass(blur * 0.4);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clear, prevAlpha);
    },
  };
}
