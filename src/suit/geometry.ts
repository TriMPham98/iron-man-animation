import * as THREE from 'three';

/** Shared high-quality mesh factories for layered armor plates. */

export function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  name?: string,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  if (name) m.name = name;
  return m;
}

export function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  segs = 1,
): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d, segs, segs, segs), mat);
}

export function cyl(
  rt: number,
  rb: number,
  h: number,
  mat: THREE.Material,
  segs = 24,
  open = false,
): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(rt, rb, h, segs, 1, open), mat);
}

export function sphere(
  r: number,
  mat: THREE.Material,
  ws = 32,
  hs = 24,
): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(r, ws, hs), mat);
}

export function capsule(
  r: number,
  length: number,
  mat: THREE.Material,
  capSegs = 8,
  radSegs = 16,
): THREE.Mesh {
  return mesh(new THREE.CapsuleGeometry(r, length, capSegs, radSegs), mat);
}

export function torus(
  r: number,
  tube: number,
  mat: THREE.Material,
  radial = 16,
  tubular = 48,
): THREE.Mesh {
  return mesh(new THREE.TorusGeometry(r, tube, radial, tubular), mat);
}

/** Rounded plate: box with slight Z-scale bias to read as armor thickness. */
export function plate(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
): THREE.Mesh {
  const m = box(w, h, d, mat, 2);
  return m;
}

/** Layer a thinner gold/dark edge under a main plate for panel depth. */
export function layeredPlate(
  w: number,
  h: number,
  d: number,
  main: THREE.Material,
  trim: THREE.Material,
  trimInset = 0.012,
): THREE.Group {
  const g = new THREE.Group();
  const body = plate(w, h, d, main);
  g.add(body);
  const under = plate(w + trimInset, h + trimInset, d * 0.55, trim);
  under.position.z = -d * 0.22;
  g.add(under);
  return g;
}

/** Recessed panel groove on the face of a plate. */
export function groove(
  w: number,
  h: number,
  mat: THREE.Material,
  z = 0.01,
): THREE.Mesh {
  const m = box(w, h, 0.008, mat);
  m.position.z = z;
  return m;
}

/** Small rivet / bolt head detail. */
export function rivet(mat: THREE.Material, r = 0.008): THREE.Mesh {
  return sphere(r, mat, 10, 8);
}

/** Lathed organic armor shell from a 2D profile (x=radius, y=height). */
export function latheShell(
  points: Array<[number, number]>,
  mat: THREE.Material,
  segments = 32,
): THREE.Mesh {
  const pts = points.map(([x, y]) => new THREE.Vector2(x, y));
  return mesh(new THREE.LatheGeometry(pts, segments), mat);
}

/** Trapezoid-ish chest / ab plate via scaled box + slight rotation helper. */
export function addAt(
  parent: THREE.Object3D,
  child: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Object3D {
  child.position.set(x, y, z);
  child.rotation.set(rx, ry, rz);
  parent.add(child);
  return child;
}

/** Soften a box mesh into a more organic plate by non-uniform scale. */
export function sculpt(
  m: THREE.Object3D,
  sx: number,
  sy: number,
  sz: number,
): THREE.Object3D {
  m.scale.set(sx, sy, sz);
  return m;
}
