import * as THREE from 'three';
import type { PieceBuffers } from './armorPieces';

/**
 * The source model paints the inside of the armpit (the side wall of the
 * pec / back shells, normally hidden by the arm) in the gold of the upper
 * arm. With the arms raised it shows as a gold hole in the torso. Repaint
 * those faces red: each gold armpit triangle takes the UVs of the nearest
 * red triangle on the same part, so it picks up that plate's exact red,
 * metalness and roughness.
 */
const TORSO = /^(pec\.[LR]|chest\.core|back\.upper|back\.lower)$/;

function texels(map: THREE.Texture | null | undefined): ((u: number, v: number) => [number, number, number]) | null {
  const img = map?.image as CanvasImageSource & { width: number; height: number } | undefined;
  if (!img || typeof document === 'undefined' || !img.width) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const flip = map!.flipY;
  return (u, v) => {
    u -= Math.floor(u);
    v -= Math.floor(v);
    const x = Math.min(c.width - 1, Math.floor(u * c.width));
    const y = Math.min(c.height - 1, Math.floor((flip ? 1 - v : v) * c.height));
    const i = (y * c.width + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
}

const isGold = ([r, g, b]: [number, number, number]) => r > 90 && g > r * 0.55 && b < g * 0.75;
const isRed = ([r, g, b]: [number, number, number]) => r > 40 && g < r * 0.6 && b < r * 0.6;

export function fillArmpits(buffers: PieceBuffers[], material: THREE.Material): void {
  const sample = texels((material as THREE.MeshStandardMaterial).map);
  if (!sample) return;
  for (const buf of buffers) {
    if (!TORSO.test(buf.id)) continue;
    const { positions: P, normals: N, uvs: U, indices: I } = buf;
    const tris = I.length / 3;
    const cen = (t: number, k: number) => (P[I[3 * t] * 3 + k] + P[I[3 * t + 1] * 3 + k] + P[I[3 * t + 2] * 3 + k]) / 3;
    const nrm = (t: number, k: number) => N[I[3 * t] * 3 + k] + N[I[3 * t + 1] * 3 + k] + N[I[3 * t + 2] * 3 + k];
    const uvc = (t: number, k: number) => (U[I[3 * t] * 2 + k] + U[I[3 * t + 1] * 2 + k] + U[I[3 * t + 2] * 2 + k]) / 3;
    const gold: number[] = [];
    const red: number[] = [];
    for (let t = 0; t < tris; t++) {
      const col = sample(uvc(t, 0), uvc(t, 1));
      if (isRed(col)) red.push(t);
      const x = Math.abs(cen(t, 0));
      const y = cen(t, 1);
      if (x < 0.1 || x > 0.3 || y < 1.2 || y > 1.56 || !isGold(col)) continue;
      // Armpit walls face out to the side or down — not the gold trim on
      // the front of the chest
      const nl = Math.hypot(nrm(t, 0), nrm(t, 1), nrm(t, 2)) || 1;
      const nx = Math.abs(nrm(t, 0)) / nl;
      const ny = nrm(t, 1) / nl;
      const nz = nrm(t, 2) / nl;
      if ((nx > 0.35 || ny < -0.3) && nz < 0.6) gold.push(t);
    }
    if (!gold.length || !red.length) continue;
    const redC = red.map((t) => [cen(t, 0), cen(t, 1), cen(t, 2), uvc(t, 0), uvc(t, 1)]);
    for (const t of gold) {
      const x = cen(t, 0);
      const y = cen(t, 1);
      const z = cen(t, 2);
      let best = redC[0];
      let bd = Infinity;
      for (const r of redC) {
        const d = (r[0] - x) ** 2 + (r[1] - y) ** 2 + (r[2] - z) ** 2;
        if (d < bd) {
          bd = d;
          best = r;
        }
      }
      for (let k = 0; k < 3; k++) {
        U[I[3 * t + k] * 2] = best[3];
        U[I[3 * t + k] * 2 + 1] = best[4];
      }
    }
  }
}
