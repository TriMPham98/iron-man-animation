import { WAVE_ORDER, type PieceWave } from '../suit/waves';

/** Max visible lines in the compact ephemeral log. */
export const JARVIS_LOG_CAP = 2;

/** How long the panel stays after systems online before auto-hide (ms). */
export const JARVIS_DISMISS_MS = 2200;

/** Short labels for the left pipeline rail. */
export const WAVE_SHORT: Record<PieceWave, string> = {
  boots: 'BOOTS',
  calves: 'CALVES',
  thighs: 'THIGHS',
  hips: 'HIPS',
  torso: 'TORSO',
  shoulders: 'SHOULDERS',
  arms: 'ARMS',
  gauntlets: 'GAUNTLETS',
  helmet: 'HELMET',
  power: 'POWER',
};

export type SystemLamp = 'arc' | 'hud' | 'rep';

export type WaveNodeState = 'idle' | 'active' | 'done';

/**
 * Map a wave to node states for the pipeline UI.
 * `activeWave` null + complete → all done; null + incomplete → all idle.
 */
export function waveNodeStates(
  activeWave: PieceWave | null,
  complete: boolean,
): Record<PieceWave, WaveNodeState> {
  const out = {} as Record<PieceWave, WaveNodeState>;
  if (complete) {
    for (const w of WAVE_ORDER) out[w] = 'done';
    return out;
  }
  if (!activeWave) {
    for (const w of WAVE_ORDER) out[w] = 'idle';
    return out;
  }
  const idx = WAVE_ORDER.indexOf(activeWave);
  for (let i = 0; i < WAVE_ORDER.length; i++) {
    const w = WAVE_ORDER[i];
    if (i < idx) out[w] = 'done';
    else if (i === idx) out[w] = 'active';
    else out[w] = 'idle';
  }
  return out;
}

/** Append a line to a ring buffer; de-dupes consecutive identical lines. */
export function appendLogLine(
  lines: string[],
  line: string,
  cap = JARVIS_LOG_CAP,
): string[] {
  const trimmed = line.trim();
  if (!trimmed) return lines.slice();
  if (lines.length > 0 && lines[lines.length - 1] === trimmed) {
    return lines.slice();
  }
  const next = [...lines, trimmed];
  if (next.length > cap) return next.slice(next.length - cap);
  return next;
}

export function isPieceWave(value: string): value is PieceWave {
  return (WAVE_ORDER as string[]).includes(value);
}

/** Progress thresholds (0–1) that light system lamps mid-sequence. */
export function lampsForProgress(p: number, systemsOnline: boolean): Set<SystemLamp> {
  const lit = new Set<SystemLamp>();
  if (systemsOnline || p >= 0.999) {
    lit.add('arc');
    lit.add('hud');
    lit.add('rep');
    return lit;
  }
  // Torso / reactor roughly mid-late cascade
  if (p >= 0.42) lit.add('arc');
  // Helmet seal near end
  if (p >= 0.78) lit.add('hud');
  // Repulsors after gauntlets
  if (p >= 0.88) lit.add('rep');
  return lit;
}

/** Build compact horizontal pipeline nodes into a container. */
export function mountPipeline(list: HTMLOListElement): Map<PieceWave, HTMLLIElement> {
  list.innerHTML = '';
  const map = new Map<PieceWave, HTMLLIElement>();
  for (const wave of WAVE_ORDER) {
    const li = document.createElement('li');
    li.className = 'jarvis-pipe-node is-idle';
    li.dataset.wave = wave;
    li.title = WAVE_SHORT[wave];
    li.innerHTML = `
      <span class="jarvis-pipe-dot" aria-hidden="true"></span>
      <span class="jarvis-pipe-label">${WAVE_SHORT[wave]}</span>
    `;
    list.appendChild(li);
    map.set(wave, li);
  }
  return map;
}

export function applyPipelineStates(
  nodes: Map<PieceWave, HTMLLIElement>,
  activeWave: PieceWave | null,
  complete: boolean,
): void {
  const states = waveNodeStates(activeWave, complete);
  for (const wave of WAVE_ORDER) {
    const el = nodes.get(wave);
    if (!el) continue;
    const state = states[wave];
    el.classList.toggle('is-idle', state === 'idle');
    el.classList.toggle('is-active', state === 'active');
    el.classList.toggle('is-done', state === 'done');
  }
}
