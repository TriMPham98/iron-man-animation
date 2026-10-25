import * as THREE from 'three';
import { wallTextures } from './aperturePit';
import { IrisShape, RingAperture } from './ringAperture';

/**
 * The way out: an iris in the workshop ceiling over the platform and the
 * launch shaft above it, up to the light. Shut, the iris is a disc of the
 * same lapped blades as the floor's ring; opening, they draw back under the
 * ceiling and the shaft's lit rings and the sky at its head come into view.
 * The flight handoff opens it and flies the suit up through it.
 */

/** Opening radius (m): inside the truss (x ±1.35) with room round the suit. */
export const ROOF_IRIS_R = 1.2;
export const ROOF_IRIS_SEGMENTS = 16;
/** Where the mast heads park, clear of the opening (radius, m). */
export const MAST_PARK_R = ROOF_IRIS_R + 0.42;
/** Shaft height above the ceiling (m). */
export const SHAFT_H = 4.8;
/** Seconds the roof iris takes to open. */
export const ROOF_IRIS_SEC = 1.5;

export const ROOF_IRIS = new IrisShape(0, ROOF_IRIS_R, ROOF_IRIS_SEGMENTS);

export interface RoofIris {
  group: THREE.Group;
  /** Iris opening, 0 shut → 1 open. */
  setOpen(u: number): void;
  /** Daylight down the shaft, 0 none → 1 full. */
  setDaylight(k: number): void;
}

export function roofIris(
  ceilingY: number,
  mats: { trim: THREE.Material; seal: THREE.Material; strip: THREE.MeshBasicMaterial },
  keep: <T extends { dispose: () => void }>(x: T) => T,
): RoofIris {
  const group = new THREE.Group();
  group.name = 'roof-iris';
  const R = ROOF_IRIS_R;

  // Blades: the floor's iris turned over, seated just above the ceiling
  const iris = keep(new RingAperture(mats.trim, mats.seal, ROOF_IRIS));
  iris.group.scale.y = -1;
  iris.group.position.y = ceilingY;
  group.add(iris.group);

  // Collar round the opening, hung just under the ceiling, a lit strip in it
  const collar = [
    [R + 0.22, ceilingY - 0.002],
    [R + 0.18, ceilingY - 0.05],
    [R + 0.02, ceilingY - 0.05],
    [R, ceilingY - 0.03],
    [R, ceilingY + 0.02],
  ];
  group.add(
    new THREE.Mesh(
      keep(new THREE.LatheGeometry(collar.map(([r, y]) => new THREE.Vector2(r, y)).reverse(), 96)),
      mats.trim,
    ),
  );
  const strip = new THREE.Mesh(keep(new THREE.TorusGeometry(R + 0.1, 0.012, 6, 128).rotateX(Math.PI / 2)), mats.strip);
  strip.position.y = ceilingY - 0.052;
  group.add(strip);

  // ── Above the blades: only drawn while they are open ──
  const shaft = new THREE.Group();
  shaft.name = 'roof-shaft';
  shaft.userData.dynamic = true;
  group.add(shaft);
  const tex = wallTextures();
  for (const t of [tex.map, tex.emissive]) {
    keep(t);
    t.repeat.set(ROOF_IRIS_SEGMENTS, 1);
  }
  const wallMat = keep(
    new THREE.MeshStandardMaterial({
      map: tex.map,
      emissiveMap: tex.emissive,
      emissive: 0xffffff,
      emissiveIntensity: 1.4,
      metalness: 0.6,
      roughness: 0.6,
      side: THREE.BackSide,
    }),
  );
  const wall = new THREE.Mesh(keep(new THREE.CylinderGeometry(R + 0.03, R + 0.03, SHAFT_H, ROOF_IRIS_SEGMENTS * 4, 1, true)), wallMat);
  wall.position.y = ceilingY + SHAFT_H / 2;
  shaft.add(wall);
  // Ribs between the bays, and lit rings up the shaft (they stream past on the way up)
  const ribGeo = keep(new THREE.BoxGeometry(0.05, SHAFT_H, 0.03));
  for (let i = 0; i < ROOF_IRIS_SEGMENTS; i++) {
    const a = (i / ROOF_IRIS_SEGMENTS) * Math.PI * 2;
    const rib = new THREE.Mesh(ribGeo, mats.trim);
    rib.position.set(Math.cos(a) * (R + 0.015), ceilingY + SHAFT_H / 2, Math.sin(a) * (R + 0.015));
    rib.rotation.y = -a + Math.PI / 2;
    shaft.add(rib);
  }
  const ringGeo = keep(new THREE.TorusGeometry(R - 0.005, 0.014, 6, 96).rotateX(Math.PI / 2));
  for (let y = 0.7; y < SHAFT_H - 0.3; y += 0.85) {
    const ring = new THREE.Mesh(ringGeo, mats.strip);
    ring.position.y = ceilingY + y;
    shaft.add(ring);
  }
  // The head of the shaft: open sky, far too bright to look into
  const skyMat = keep(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }));
  const sky = new THREE.Mesh(keep(new THREE.CircleGeometry(R + 0.04, 64).rotateX(Math.PI / 2)), skyMat);
  sky.position.y = ceilingY + SHAFT_H;
  shaft.add(sky);
  shaft.visible = false;

  // Daylight down the shaft (always in the scene, so switching it on never
  // recompiles a program; no shadow)
  const sun = new THREE.SpotLight(0xffe6c4, 0, 0, 0.36, 0.7, 1.2);
  sun.position.set(0, ceilingY + SHAFT_H, 0);
  sun.target.position.set(0, 0, 0);
  group.add(sun, sun.target);

  const SKY = new THREE.Color(5.2, 4.6, 3.8);
  return {
    group,
    setOpen(u) {
      iris.set(u);
      shaft.visible = u > 0;
    },
    setDaylight(k) {
      skyMat.color.copy(SKY).multiplyScalar(k);
      sun.intensity = 420 * k;
    },
  };
}
