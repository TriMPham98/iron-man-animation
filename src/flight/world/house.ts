import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HOME, HOME_HEIGHT } from './heightfield';

/**
 * The house on the bluff: white cantilevered floors stepping out over the
 * cliff, curved terraces, floor-to-ceiling glass catching the sky, warm
 * interior light coming on at sunset, an infinity pool on the edge — and
 * the landing pad out front, ringed in the reactor's blue, where the suit
 * stands at the start. Built from a handful of merged meshes.
 */

/** Where the suit stands (world xz) and the pad's height. */
export const PAD = new THREE.Vector2(HOME.x, HOME.y + 14);
export const PAD_Y = HOME_HEIGHT + 0.35;

const HOUSE_AT = new THREE.Vector2(HOME.x, HOME.y - 16);
const HOUSE_YAW = 0.12;

/**
 * Tops of the built surfaces (pad deck, house roofs) at a point, or −∞: the
 * flight model lands on them like ground.
 */
export function structureTop(x: number, z: number): number {
  if (Math.hypot(x - PAD.x, z - PAD.y) < 7) return PAD_Y + 0.35;
  // Into the house frame
  const dx = x - HOUSE_AT.x;
  const dz = z - HOUSE_AT.y;
  const c = Math.cos(HOUSE_YAW);
  const sn = Math.sin(HOUSE_YAW);
  const lx = c * dx - sn * dz;
  const lz = sn * dx + c * dz;
  if (Math.abs(lx - 2) < 12 && Math.abs(lz - 0.5) < 9) return HOME_HEIGHT + 8.15;
  if (Math.abs(lx) < 15 && Math.abs(lz + 3) < 7.5) return HOME_HEIGHT + 4.25;
  if (Math.abs(lx) < 17 && Math.abs(lz + 2) < 10) return HOME_HEIGHT + 0.7;
  return -Infinity;
}

export function buildHouse(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'house';
  const white = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.55, metalness: 0 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x8c877e, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1418, roughness: 0.04, metalness: 0.1, envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.02 });
  const warm = new THREE.MeshStandardMaterial({ color: 0x1a120a, emissive: new THREE.Color(1, 0.62, 0.32), emissiveIntensity: 1.3, roughness: 0.9 });
  const pool = new THREE.MeshPhysicalMaterial({ color: 0x3fb5c8, roughness: 0.03, metalness: 0, emissive: new THREE.Color(0.05, 0.35, 0.42), emissiveIntensity: 0.6, envMapIntensity: 1.4, clearcoat: 1 });
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.6, 2.2) });

  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  // House frame: +z toward the sea. Origin at the house centre on the terrace
  const base = HOME_HEIGHT;
  const whites: THREE.BufferGeometry[] = [
    box(34, 1.2, 20, 0, 0.1, -2), // plinth
    box(30, 0.5, 15, 0, 4.0, -3), // level 1 roof / level 2 floor
    box(24, 0.5, 18, 2, 7.9, 0.5), // level 2 roof, cantilevered toward the sea
    box(1.2, 4, 1.2, -14, 2, -10), // columns
    box(1.2, 4, 1.2, 14, 2, -10),
    box(0.6, 3.6, 15, -12.5, 5.9, -3),
    box(8, 3.6, 0.6, -6, 5.9, -10.3),
  ];
  // Curved terraces stepping out (the house's signature)
  for (const [r, y, th] of [
    [13, 4.0, 1.6],
    [10, 7.9, 1.25],
  ] as const) {
    const curve = new THREE.CylinderGeometry(r, r, 0.5, 48, 1, false, Math.PI / 2 - th / 2, th).translate(6, y, 2);
    whites.push(curve);
  }
  const house = new THREE.Mesh(mergeGeometries(whites.map((x) => x.toNonIndexed())), white);
  const glassGeo = mergeGeometries([
    box(26, 3.2, 0.12, 0, 2.0, 4.4),
    box(0.12, 3.2, 12, 14.6, 2.0, -2),
    box(20, 3.2, 0.12, 3, 5.95, 9.2),
    box(0.12, 3.2, 16, 13.8, 5.95, 0.5),
  ]);
  const glassMesh = new THREE.Mesh(glassGeo, glass);
  // Lit interior just behind the glass
  const warmGeo = mergeGeometries([box(24, 2.6, 0.1, 0, 1.9, 3.6), box(18, 2.4, 0.1, 3, 5.8, 8.4)]);
  const interior = new THREE.Mesh(warmGeo, warm);
  const poolGeo = box(16, 0.3, 4, -6, 0.75, 9.5);
  const poolEdge = box(17, 0.9, 5, -6, 0.3, 9.5);
  const poolMesh = new THREE.Mesh(poolGeo, pool);
  const edgeMesh = new THREE.Mesh(poolEdge, stone);
  const steps = new THREE.Mesh(mergeGeometries([box(6, 0.4, 3, 12, 0.5, 9), box(6, 0.4, 3, 12, 0.3, 12)].map((x) => x.toNonIndexed())), stone);
  const rail = new THREE.Mesh(mergeGeometries([box(0.08, 1.0, 18, 14.2, 8.6, 0.5), box(20, 1.0, 0.08, 4, 8.6, 9.6)].map((x) => x.toNonIndexed())), glass);
  const houseGroup = new THREE.Group();
  houseGroup.add(house, glassMesh, interior, poolMesh, edgeMesh, steps, rail);
  houseGroup.position.set(HOUSE_AT.x, base, HOUSE_AT.y);
  houseGroup.rotation.y = HOUSE_YAW;
  g.add(houseGroup);

  // Landing pad
  const padGroup = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, 0.7, 64), dark);
  disc.position.y = 0;
  const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 5.85, 96).rotateX(-Math.PI / 2), ringMat);
  ring.position.y = 0.36;
  const inner = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.62, 64).rotateX(-Math.PI / 2), ringMat);
  inner.position.y = 0.36;
  // Approach ticks
  const ticks: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    ticks.push(new THREE.PlaneGeometry(0.12, i % 6 === 0 ? 0.9 : 0.4).rotateX(-Math.PI / 2).rotateY(-a).translate(Math.sin(a) * 6.4, 0.361, Math.cos(a) * 6.4));
  }
  const tickMesh = new THREE.Mesh(mergeGeometries(ticks), ringMat);
  padGroup.add(disc, ring, inner, tickMesh);
  padGroup.position.set(PAD.x, PAD_Y - 0.35, PAD.y);
  g.add(padGroup);

  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = false;
    m.receiveShadow = true;
  });
  return g;
}
