import type { Object3D } from 'three';
import type { ArmorPiece, PieceWave } from '../suit/waves';
import { WAVE_ORDER } from '../suit/waves';

/** One pending reclass entry for the pasteable director card. */
export interface ReclassEntry {
  /** Full id, e.g. shard-392-helmet */
  id: string;
  /** Compact label, e.g. helmet#392 */
  short: string;
  from: PieceWave;
  to: PieceWave;
  rest: { x: number; y: number; z: number };
  /** Max |world X| of shard vertices (laterality). */
  maxAbsX: number;
  verts: number;
  bbox: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
  /** Optional free-text note from the director. */
  note?: string;
}

export function shortPieceId(id: string, wave: string): string {
  const m = /^shard-(\d+)-(.+)$/.exec(id);
  if (m) return `${m[2]}#${m[1]}`;
  if (id.startsWith(wave)) return id;
  return `${wave}/${id}`;
}

/**
 * Measure rest-local geometry → world rest-space bounds + max |x|.
 * Shard verts live relative to restPosition (mesh.position at rest).
 */
export function measurePieceGeometry(piece: ArmorPiece): {
  maxAbsX: number;
  verts: number;
  bbox: ReclassEntry['bbox'];
} {
  const mesh = piece.mesh as Object3D & {
    geometry?: {
      getAttribute: (name: string) => {
        count: number;
        getX: (i: number) => number;
        getY: (i: number) => number;
        getZ: (i: number) => number;
      } | null;
    };
  };
  const pos = mesh.geometry?.getAttribute?.('position');
  const rx = piece.restPosition.x;
  const ry = piece.restPosition.y;
  const rz = piece.restPosition.z;

  if (!pos || pos.count < 1) {
    return {
      maxAbsX: Math.abs(rx),
      verts: 0,
      bbox: {
        minX: rx,
        maxX: rx,
        minY: ry,
        maxY: ry,
        minZ: rz,
        maxZ: rz,
      },
    };
  }

  let maxAbsX = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + rx;
    const y = pos.getY(i) + ry;
    const z = pos.getZ(i) + rz;
    maxAbsX = Math.max(maxAbsX, Math.abs(x));
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  return {
    maxAbsX,
    verts: pos.count,
    bbox: { minX, maxX, minY, maxY, minZ, maxZ },
  };
}

export function entryFromPiece(
  piece: ArmorPiece,
  to: PieceWave,
  note?: string,
): ReclassEntry {
  const geo = measurePieceGeometry(piece);
  return {
    id: piece.id,
    short: shortPieceId(piece.id, piece.wave),
    from: piece.wave,
    to,
    rest: {
      x: piece.restPosition.x,
      y: piece.restPosition.y,
      z: piece.restPosition.z,
    },
    maxAbsX: geo.maxAbsX,
    verts: geo.verts,
    bbox: geo.bbox,
    note: note?.trim() || undefined,
  };
}

/**
 * Human + machine card the director pastes into chat so reclass can be
 * implemented without re-measuring the model.
 */
export function formatReclassCard(entries: ReclassEntry[]): string {
  if (entries.length === 0) {
    return '### RECLASS CARD\n\n(no entries — pick plates in DIR mode and add them)\n';
  }

  const lines: string[] = [
    '### RECLASS CARD',
    '',
    'Paste this to reclassify assembly pieces. Prefer `to` wave; keep rest/maxAbsX/bbox for the classifyWave gate.',
    '',
  ];

  entries.forEach((e, i) => {
    const r = e.rest;
    const b = e.bbox;
    lines.push(`${i + 1}. **${e.short}** \`${e.from}\` → \`${e.to}\``);
    lines.push(`   - id: \`${e.id}\``);
    lines.push(
      `   - rest: (${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)})`,
    );
    lines.push(
      `   - maxAbsX: ${e.maxAbsX.toFixed(4)} · verts: ${e.verts}`,
    );
    lines.push(
      `   - bbox: X[${b.minX.toFixed(3)}, ${b.maxX.toFixed(3)}] Y[${b.minY.toFixed(3)}, ${b.maxY.toFixed(3)}] Z[${b.minZ.toFixed(3)}, ${b.maxZ.toFixed(3)}]`,
    );
    if (e.note) lines.push(`   - note: ${e.note}`);
    lines.push('');
  });

  // Compact machine block for reliable parsing
  const payload = entries.map((e) => ({
    short: e.short,
    id: e.id,
    from: e.from,
    to: e.to,
    rest: [
      Number(e.rest.x.toFixed(4)),
      Number(e.rest.y.toFixed(4)),
      Number(e.rest.z.toFixed(4)),
    ],
    maxAbsX: Number(e.maxAbsX.toFixed(4)),
    verts: e.verts,
    bbox: {
      x: [Number(e.bbox.minX.toFixed(3)), Number(e.bbox.maxX.toFixed(3))],
      y: [Number(e.bbox.minY.toFixed(3)), Number(e.bbox.maxY.toFixed(3))],
      z: [Number(e.bbox.minZ.toFixed(3)), Number(e.bbox.maxZ.toFixed(3))],
    },
    note: e.note ?? null,
  }));

  lines.push('```json');
  lines.push(JSON.stringify({ reclass: payload }, null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

export function isPieceWave(v: string): v is PieceWave {
  return (WAVE_ORDER as string[]).includes(v);
}

export { WAVE_ORDER };
