import * as THREE from 'three';

/**
 * Small geometry kit for the robot castings: lathe-turned housings, beveled
 * slabs extruded across X (link side plates, yoke cheeks), cable runs and
 * bolt circles. Everything is built so no two same-facing surfaces of
 * different parts share a plane (no z-fighting once merged).
 */

export type Profile = Array<[number, number]>;

/** Lathe-turned solid around local Y from (radius, y) pairs, bottom → top. */
export function lathe(profile: Profile, m: THREE.Material, seg = 32): THREE.Mesh {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  return new THREE.Mesh(new THREE.LatheGeometry(pts, seg), m);
}

/** Closed lathe cylinder r over [y0, y1] with a small chamfer on both rims. */
export function drum(r: number, y0: number, y1: number, m: THREE.Material, chamfer = 0.004, seg = 32): THREE.Mesh {
  const c = Math.min(chamfer, (y1 - y0) / 3, r / 3);
  return lathe(
    [
      [0, y0],
      [r - c, y0],
      [r, y0 + c],
      [r, y1 - c],
      [r - c, y1],
      [0, y1],
    ],
    m,
    seg,
  );
}

/** {@link drum} turned onto the X axis, spanning x0 → x1 (joint hubs). */
export function hubX(r: number, x0: number, x1: number, m: THREE.Material, chamfer = 0.004, seg = 32): THREE.Mesh {
  const mesh = drum(r, x0, x1, m, chamfer, seg);
  mesh.geometry.rotateZ(-Math.PI / 2);
  return mesh;
}

/** Convex hull (monotone chain) of 2D points, counter-clockwise. */
export function hull(points: Array<[number, number]>): Array<[number, number]> {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Outline (z, y) of a tapered capsule: circle r0 at y0 → circle r1 at y1. */
export function capsuleOutline(r0: number, y0: number, r1: number, y1: number, z = 0, n = 24): Profile {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([z + Math.cos(a) * r0, y0 + Math.sin(a) * r0]);
    pts.push([z + Math.cos(a) * r1, y1 + Math.sin(a) * r1]);
  }
  return hull(pts);
}

/** Outline (z, y) of a rounded rectangle centred at (cz, cy). */
export function roundedRect(w: number, h: number, r: number, cz = 0, cy = 0, n = 5): Profile {
  const pts: Array<[number, number]> = [];
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const corners: Array<[number, number, number]> = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, (Math.PI * 3) / 2],
  ];
  for (const [x, y, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([cz + x + Math.cos(a) * r, cy + y + Math.sin(a) * r]);
    }
  }
  return pts;
}

/**
 * A beveled plate with outline (z, y) extruded across x0 → x1. The bevel is
 * inset so the outline is the true silhouette.
 */
export function slabX(outline: Profile, x0: number, x1: number, m: THREE.Material, bevel = 0.005): THREE.Mesh {
  const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(-z, y)));
  const b = Math.min(bevel, (x1 - x0) / 3);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, x1 - x0 - 2 * b),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 2,
    curveSegments: 8,
  });
  // Shape (−z, y) extruded along +Z → rotate the extrusion onto +X
  geo.rotateY(Math.PI / 2);
  geo.translate(x0 + b, 0, 0);
  geo.clearGroups();
  return new THREE.Mesh(geo, m);
}

/** Same plate extruded along Y (outline in x, z) from y0 to y1. */
export function slabY(outline: Profile, y0: number, y1: number, m: THREE.Material, bevel = 0.005): THREE.Mesh {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)));
  const b = Math.min(bevel, (y1 - y0) / 3);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, y1 - y0 - 2 * b),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 2,
    curveSegments: 8,
  });
  // Shape (x, z) in XY extruded along +Z; rotateX(+90°) maps
  // (x, y, e) → (x, −e, y), so the extrusion runs down from y1
  geo.rotateX(Math.PI / 2);
  geo.translate(0, y1 - b, 0);
  geo.clearGroups();
  return new THREE.Mesh(geo, m);
}

/** Flexible line (cable, hose) through control points. */
export function cable(points: Array<[number, number, number]>, r: number, m: THREE.Material, seg = 24): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.Mesh(new THREE.TubeGeometry(curve, seg, r, 8, false), m);
}

/**
 * Hex bolt heads on a circle. `axis` is the direction the heads face;
 * `at` is the seating plane centre.
 */
export function boltCircle(
  n: number,
  radius: number,
  at: [number, number, number],
  axis: 'x' | 'y' | 'z' | '-x' | '-y' | '-z',
  m: THREE.Material,
  head = 0.007,
  phase = 0,
): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const geo = new THREE.CylinderGeometry(head, head, head * 0.8, 6);
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const u = Math.cos(a) * radius;
    const v = Math.sin(a) * radius;
    const mesh = new THREE.Mesh(geo, m);
    const h = head * 0.4;
    switch (axis) {
      case 'y':
      case '-y': {
        const s = axis === 'y' ? 1 : -1;
        mesh.position.set(at[0] + u, at[1] + s * h, at[2] + v);
        break;
      }
      case 'x':
      case '-x': {
        const s = axis === 'x' ? 1 : -1;
        mesh.rotation.z = Math.PI / 2;
        mesh.position.set(at[0] + s * h, at[1] + u, at[2] + v);
        break;
      }
      default: {
        const s = axis === 'z' ? 1 : -1;
        mesh.rotation.x = Math.PI / 2;
        mesh.position.set(at[0] + u, at[1] + v, at[2] + s * h);
      }
    }
    out.push(mesh);
  }
  return out;
}

/** Plain box centred at (x, y, z). */
export function block(
  w: number,
  h: number,
  d: number,
  m: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}
