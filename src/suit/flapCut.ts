import * as THREE from 'three';

/**
 * Clean-edged flap cutting. A flight-control surface on a real suit is a
 * machined plate with straight edges, so instead of picking whatever UV
 * patches fall in a box, the part's surface is clipped (Sutherland–Hodgman)
 * by a convex outline drawn on it. The outline is given in a 2D view — the
 * part seen along one axis — plus a depth window so only the outer shell on
 * that side is cut. The plate gets a short side wall along its cut edges so
 * it reads as solid armor when it swings out.
 */
export interface FlapCut {
  /** View axis the outline is drawn along. */
  along: 'x' | 'z';
  /**
   * Convex outline, counter-clockwise or clockwise, in the view's 2D coords:
   * (x, y) when looking along z, (z, y) when looking along x.
   */
  outline: ReadonlyArray<readonly [number, number]>;
  /** Triangles whose centroid lies in this range along the view axis are cut. */
  depth: readonly [number, number];
  /** Side wall depth (m) on the plate's cut edges. */
  wall?: number;
}

interface Vert {
  p: THREE.Vector3;
  n: THREE.Vector3;
  uv: THREE.Vector2;
  si: [number, number, number, number];
  sw: [number, number, number, number];
}

/** A triangle soup carrying every attribute of a skinned piece. */
export type Soup = Vert[][];

export function soupFrom(geo: THREE.BufferGeometry, index: ArrayLike<number>, keep: (t: number) => boolean): Soup {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const vert = (i: number): Vert => ({
    p: new THREE.Vector3().fromBufferAttribute(pos, i),
    n: new THREE.Vector3().fromBufferAttribute(nrm, i),
    uv: new THREE.Vector2(uv.getX(i), uv.getY(i)),
    si: [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)],
    sw: [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)],
  });
  const cache = new Map<number, Vert>();
  const get = (i: number) => {
    let v = cache.get(i);
    if (!v) cache.set(i, (v = vert(i)));
    return v;
  };
  const out: Soup = [];
  for (let t = 0; t < index.length / 3; t++) {
    if (keep(t)) out.push([get(index[3 * t]), get(index[3 * t + 1]), get(index[3 * t + 2])]);
  }
  return out;
}

function lerpVert(a: Vert, b: Vert, t: number): Vert {
  // Skinning can't be interpolated index-wise: the new vertex rides the
  // nearer end (flapped plates sit on one bone anyway)
  const near = t < 0.5 ? a : b;
  return {
    p: a.p.clone().lerp(b.p, t),
    n: a.n.clone().lerp(b.n, t).normalize(),
    uv: a.uv.clone().lerp(b.uv, t),
    si: [...near.si],
    sw: [...near.sw],
  };
}

/** Signed plane: dot(n, p) − d (inside where ≥ 0). */
interface Plane {
  n: THREE.Vector3;
  d: number;
}

function planesOf(cut: FlapCut): Plane[] {
  const o = cut.outline;
  // Outline centroid decides which side of each edge is inside
  let cx = 0;
  let cy = 0;
  for (const [a, b] of o) {
    cx += a;
    cy += b;
  }
  cx /= o.length;
  cy /= o.length;
  const to3 = (a: number, b: number) => (cut.along === 'z' ? new THREE.Vector3(a, b, 0) : new THREE.Vector3(0, b, a));
  const axis = cut.along === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const c = to3(cx, cy);
  return o.map((p, i) => {
    const q = o[(i + 1) % o.length];
    const pa = to3(p[0], p[1]);
    const edge = to3(q[0], q[1]).sub(pa);
    const n = new THREE.Vector3().crossVectors(edge, axis).normalize();
    if (n.dot(c.clone().sub(pa)) < 0) n.negate();
    return { n, d: n.dot(pa) };
  });
}

const dist = (pl: Plane, v: Vert) => pl.n.dot(v.p) - pl.d;

/** Split a polygon by a plane → [inside, outside]. */
function split(poly: Vert[], pl: Plane, seam: Map<string, Vert>): [Vert[], Vert[]] {
  const inside: Vert[] = [];
  const outside: Vert[] = [];
  const f = poly.map((v) => dist(pl, v));
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = f[i];
    const db = f[(i + 1) % poly.length];
    if (da >= 0) inside.push(a);
    else outside.push(a);
    if ((da >= 0) !== (db >= 0)) {
      // Shared per edge so both sides of the cut stay welded
      const key = a.p.x < b.p.x || (a.p.x === b.p.x && a.p.y < b.p.y) ? `${a.p.toArray()}|${b.p.toArray()}` : `${b.p.toArray()}|${a.p.toArray()}`;
      let s = seam.get(key);
      if (!s) seam.set(key, (s = lerpVert(a, b, da / (da - db))));
      inside.push(s);
      outside.push(s);
    }
  }
  return [inside, outside];
}

const fan = (poly: Vert[], out: Soup) => {
  for (let k = 1; k + 1 < poly.length; k++) out.push([poly[0], poly[k], poly[k + 1]]);
};

/** Cut a soup into the plate inside the outline and everything else. */
export function cutSoup(soup: Soup, cut: FlapCut): { plate: Soup; rest: Soup; edges: Array<[Vert, Vert]> } {
  const planes = planesOf(cut);
  const ax = cut.along === 'z' ? 'z' : 'x';
  const plate: Soup = [];
  const rest: Soup = [];
  const seam = new Map<string, Vert>();
  // Stacked shell layers (outer skin + a liner a millimetre under it) must
  // go to the same side, or a seated flap z-fights with the layer left on
  // the suit. Decide depth per small column in the view plane, by the
  // column's outermost triangle, not per triangle.
  const u = cut.along === 'z' ? 'x' : 'z';
  const col = (tri: Vert[]) => {
    const a = (tri[0].p[u] + tri[1].p[u] + tri[2].p[u]) / 3;
    const b = (tri[0].p.y + tri[1].p.y + tri[2].p.y) / 3;
    return `${Math.round(a / 0.004)},${Math.round(b / 0.004)}`;
  };
  const depthOf = (tri: Vert[]) => (tri[0].p[ax] + tri[1].p[ax] + tri[2].p[ax]) / 3;
  const inWindow = (c: number) => c >= cut.depth[0] && c <= cut.depth[1];
  const colIn = new Map<string, boolean>();
  for (const tri of soup) if (inWindow(depthOf(tri))) colIn.set(col(tri), true);
  for (const tri of soup) {
    const c = depthOf(tri);
    // In the window, or directly stacked over a triangle that is
    const near = c >= cut.depth[0] - 0.02 && c <= cut.depth[1] + 0.02;
    if (!(inWindow(c) || (near && colIn.get(col(tri))))) {
      rest.push(tri);
      continue;
    }
    let poly: Vert[] = tri;
    for (const pl of planes) {
      const [inside, outside] = split(poly, pl, seam);
      if (outside.length >= 3) fan(outside, rest);
      poly = inside;
      if (poly.length < 3) break;
    }
    if (poly.length >= 3) fan(poly, plate);
  }
  // Cut edges of the plate: its open boundary edges lying on an outline plane
  const onCut = (v: Vert) => planes.some((pl) => Math.abs(dist(pl, v)) < 1e-6);
  const count = new Map<string, { a: Vert; b: Vert; n: number }>();
  for (const tri of plate) {
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      const key = [a.p.toArray().join(), b.p.toArray().join()].sort().join('|');
      const e = count.get(key);
      if (e) e.n++;
      else count.set(key, { a, b, n: 1 });
    }
  }
  const open: Array<[Vert, Vert]> = [];
  for (const e of count.values()) if (e.n === 1 && onCut(e.a) && onCut(e.b)) open.push([e.a, e.b]);
  return { plate, rest, edges: outermost(open, (cut.wall ?? 0.006) + 0.002) };
}

/**
 * Drop cut edges lying under another one along the surface normal. The
 * shell is stacked (outer skin + a liner a millimetre beneath), so the cut
 * crosses both and each layer's edge would grow its own wall — two walls in
 * one plane, flickering against each other. Only the outer layer's stays.
 */
function outermost(edges: Array<[Vert, Vert]>, reach: number): Array<[Vert, Vert]> {
  const info = edges.map(([a, b]) => {
    const t = b.p.clone().sub(a.p);
    const len = t.length();
    const n = a.n.clone().add(b.n).normalize();
    return { m: a.p.clone().add(b.p).multiplyScalar(0.5), n, t: t.divideScalar(len || 1), len };
  });
  const d = new THREE.Vector3();
  const across = new THREE.Vector3();
  return edges.filter((_, i) => {
    const e = info[i];
    across.crossVectors(e.n, e.t);
    return !info.some((o, j) => {
      if (j === i) return false;
      d.subVectors(o.m, e.m);
      const up = d.dot(e.n);
      if (up < 0.0002 || up > reach) return false;
      // Same run of the outline (not a neighbouring edge round a corner)
      return Math.abs(d.dot(across)) < 0.002 && Math.abs(d.dot(e.t)) < (e.len + o.len) / 2;
    });
  });
}

/** Side wall under each cut edge, pushed into the suit along -normal. */
export function wallFor(edges: Array<[Vert, Vert]>, depth: number, inset = 0, view?: THREE.Vector3): Soup {
  const out: Soup = [];
  // Every wall sinks straight in along the view axis, so the walls of one
  // outline edge all lie in its cut plane, end to end, never overlapping
  const inward = view ? view.clone().multiplyScalar(-Math.sign(edges.reduce((a, [v]) => a + v.n.dot(view), 0)) || 1) : null;
  const sink = (v: Vert): Vert => ({
    ...v,
    p: inward ? v.p.clone().addScaledVector(inward, depth) : v.p.clone().addScaledVector(v.n, -depth),
    si: [...v.si],
    sw: [...v.sw],
  });
  for (const [a0, b0] of edges) {
    // Where the outline runs over a grazing flank (the surface turns away
    // from the view axis) a wall would lie in the neighbouring armor's
    // surface and z-fight with it — the shell's own edge is enough there
    if (view && Math.abs(a0.n.dot(view)) < 0.45 && Math.abs(b0.n.dot(view)) < 0.45) continue;
    // Wall faces outward from the plate: perpendicular to the edge and the
    // surface normal
    const along = b0.p.clone().sub(a0.p);
    const side = new THREE.Vector3().crossVectors(along, a0.n).normalize();
    // Optional inset (toward the plate) so a plate's wall never shares a
    // surface with its well's wall
    const pull = (v: Vert): Vert => (inset ? { ...v, p: v.p.clone().addScaledVector(side, -inset) } : v);
    const a = pull(a0);
    const b = pull(b0);
    const a2 = sink(a);
    const b2 = sink(b);
    const n = side;
    const w = (v: Vert): Vert => ({ ...v, n: n.clone() });
    // Both windings: the wall is seen from either side as the plate swings
    out.push([w(a), w(b), w(b2)], [w(a), w(b2), w(a2)]);
    out.push([w(a), w(b2), w(b)], [w(a), w(a2), w(b2)]);
  }
  return out;
}

export function soupGeometry(soup: Soup): THREE.BufferGeometry {
  const ids = new Map<Vert, number>();
  const verts: Vert[] = [];
  const index: number[] = [];
  for (const tri of soup) {
    for (const v of tri) {
      let i = ids.get(v);
      if (i === undefined) {
        i = verts.length;
        ids.set(v, i);
        verts.push(v);
      }
      index.push(i);
    }
  }
  const n = verts.length;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  verts.forEach((v, i) => {
    v.p.toArray(pos, i * 3);
    v.n.toArray(nrm, i * 3);
    v.uv.toArray(uv, i * 2);
    si.set(v.si, i * 4);
    sw.set(v.sw, i * 4);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(index);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
