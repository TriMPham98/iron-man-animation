import * as THREE from 'three';
import { longEdges } from '../../workshop/suitScanView';

/**
 * The suit's own edge wireframe — the panel lines the assembly's diagnostic
 * scan draws — flattened once into a 2D figure for the helmet HUD. Seen
 * from behind, as the pilot wears it: his left on the left. Drawn into
 * offscreen canvases per colour (armour state) and a bright copy the scan
 * band reveals a slice of.
 */
export interface SuitPoints {
  palmL: readonly [number, number, number];
  palmR: readonly [number, number, number];
  bootL: readonly [number, number, number];
  bootR: readonly [number, number, number];
}

export class SuitWireframe {
  /** Figure height in canvas px (the HUD scales it down). */
  static readonly PX = 360;
  readonly width: number;
  readonly height = SuitWireframe.PX;
  /** Thruster points in figure px (0,0 = the canvas's top left). */
  readonly pips: Record<keyof SuitPoints, { x: number; y: number }>;
  private readonly segs: Float32Array;
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly scale: number;
  private readonly x0: number;
  private readonly y1: number;

  constructor(geometry: THREE.BufferGeometry, points: SuitPoints) {
    const edges = longEdges(new THREE.EdgesGeometry(geometry, 38), 0.012);
    const pos = edges.getAttribute('position') as THREE.BufferAttribute;
    edges.computeBoundingBox();
    const box = edges.boundingBox!;
    edges.dispose();
    const pad = 6;
    this.scale = (this.height - pad * 2) / (box.max.y - box.min.y);
    this.width = Math.ceil((box.max.x - box.min.x) * this.scale + pad * 2);
    // From behind: model +X (the suit's left) is screen left
    this.x0 = box.max.x * this.scale + pad;
    this.y1 = box.max.y * this.scale + pad;
    this.segs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      this.segs[i * 2] = this.x0 - pos.getX(i) * this.scale;
      this.segs[i * 2 + 1] = this.y1 - pos.getY(i) * this.scale;
    }
    const at = (p: readonly [number, number, number]) => ({ x: this.x0 - p[0] * this.scale, y: this.y1 - p[1] * this.scale });
    this.pips = { palmL: at(points.palmL), palmR: at(points.palmR), bootL: at(points.bootL), bootR: at(points.bootR) };
  }

  /** The figure in one colour (`rgb` as "r, g, b"), built on first use. */
  canvas(rgb: string, alpha: number): HTMLCanvasElement {
    const key = `${rgb}|${alpha}`;
    let c = this.cache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    const g = c.getContext('2d')!;
    // Overlapping lines build up where the plating is dense, like the scan
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = `rgba(${rgb}, ${alpha})`;
    g.lineWidth = 0.8;
    g.beginPath();
    const s = this.segs;
    for (let i = 0; i + 3 < s.length; i += 4) {
      g.moveTo(s[i], s[i + 1]);
      g.lineTo(s[i + 2], s[i + 3]);
    }
    g.stroke();
    this.cache.set(key, c);
    return c;
  }
}
