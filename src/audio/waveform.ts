import { soundUrl } from './sounds';

/** Full-source peak envelope cached per resolved URL. */
export type WaveformPeaks = {
  /** Normalized peak magnitudes 0..1 across the full file. */
  peaks: Float32Array;
  /** Decoded duration in seconds. */
  duration: number;
};

/** Dense enough for zoomed timeline; downsampled per draw. */
const FULL_BINS = 2048;

const peakCache = new Map<string, WaveformPeaks | Promise<WaveformPeaks>>();

let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) throw new Error('Web Audio API unavailable');
  sharedCtx = new AC();
  return sharedCtx;
}

function resolveSrc(file: string): string {
  if (
    file.startsWith('blob:') ||
    file.startsWith('http://') ||
    file.startsWith('https://') ||
    file.startsWith('data:') ||
    file.startsWith('/')
  ) {
    return file;
  }
  return soundUrl(file);
}

/**
 * Build a peak envelope from a decoded buffer (max abs sample per bin).
 * Uses channel 0, or max-of-channels when stereo.
 */
export function computePeaksFromBuffer(
  buffer: AudioBuffer,
  bins = FULL_BINS,
): Float32Array {
  const nBins = Math.max(8, bins);
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const peaks = new Float32Array(nBins);
  if (length === 0) return peaks;

  const block = length / nBins;
  for (let i = 0; i < nBins; i++) {
    const start = Math.floor(i * block);
    const end = Math.min(length, Math.floor((i + 1) * block));
    let peak = 0;
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]!);
        if (v > peak) peak = v;
      }
    }
    peaks[i] = peak;
  }

  let max = 0;
  for (let i = 0; i < nBins; i++) {
    if (peaks[i]! > max) max = peaks[i]!;
  }
  if (max > 1e-8) {
    for (let i = 0; i < nBins; i++) peaks[i]! /= max;
  }
  return peaks;
}

/**
 * Resample a crop window of full-file peaks into `outBins` columns
 * (one per horizontal pixel bucket).
 */
export function peaksForRegion(
  full: Float32Array,
  duration: number,
  cropIn: number,
  cropOut: number,
  outBins: number,
): Float32Array {
  const nOut = Math.max(1, outBins | 0);
  const out = new Float32Array(nOut);
  if (full.length === 0 || duration <= 0) return out;

  const t0 = Math.max(0, Math.min(duration, cropIn)) / duration;
  const t1 = Math.max(t0 + 1e-6, Math.min(duration, cropOut)) / duration;
  const i0 = Math.floor(t0 * full.length);
  const i1 = Math.max(i0 + 1, Math.ceil(t1 * full.length));
  const span = i1 - i0;

  for (let i = 0; i < nOut; i++) {
    const a = i0 + Math.floor((i / nOut) * span);
    const b = i0 + Math.floor(((i + 1) / nOut) * span);
    let peak = 0;
    const end = Math.max(a + 1, b);
    for (let j = a; j < end && j < full.length; j++) {
      const v = full[j]!;
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

async function decodePeaks(file: string): Promise<WaveformPeaks> {
  const url = resolveSrc(file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`waveform fetch failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  const ctx = getAudioContext();
  // copy: true — some browsers detach the buffer
  const buffer = await ctx.decodeAudioData(ab.slice(0));
  return {
    peaks: computePeaksFromBuffer(buffer, FULL_BINS),
    duration: buffer.duration > 0 ? buffer.duration : 1,
  };
}

/**
 * Cached full-file peaks for a catalog/custom audio path.
 * Concurrent callers share the same in-flight promise.
 */
export function getWaveformPeaks(file: string): Promise<WaveformPeaks> {
  const key = resolveSrc(file);
  const hit = peakCache.get(key);
  if (hit) return hit instanceof Promise ? hit : Promise.resolve(hit);

  const pending = decodePeaks(file)
    .then((data) => {
      peakCache.set(key, data);
      return data;
    })
    .catch((err) => {
      peakCache.delete(key);
      throw err;
    });
  peakCache.set(key, pending);
  return pending;
}

/** Kick off decode for many files without awaiting (library prewarm). */
export function prewarmWaveforms(files: string[]): void {
  for (const f of files) {
    void getWaveformPeaks(f).catch(() => {
      /* ignore probe failures */
    });
  }
}

export type DrawWaveformOpts = {
  /** Fill color for the bars / path. */
  color?: string;
  /** Optional secondary tint for a soft fill under the peaks. */
  fillColor?: string;
};

/**
 * Paint a mirrored bar waveform into `canvas`, sizing the backing store
 * to the element's CSS box × devicePixelRatio.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  opts: DrawWaveformOpts = {},
): void {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW < 1 || cssH < 1 || peaks.length === 0) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.floor(cssW * dpr));
  const bh = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const mid = cssH / 2;
  const ampScale = cssH * 0.42;
  const n = peaks.length;
  const barW = cssW / n;
  const color = opts.color ?? 'rgba(255, 255, 255, 0.55)';
  const fill = opts.fillColor ?? 'rgba(255, 255, 255, 0.12)';

  // Soft filled silhouette first (reads as a continuous wave)
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * barW;
    const y = mid - peaks[i]! * ampScale;
    ctx.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    const x = (i + 0.5) * barW;
    const y = mid + peaks[i]! * ampScale;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  // Crisp vertical bars on top
  ctx.fillStyle = color;
  const gap = Math.max(0.35, Math.min(1.2, barW * 0.2));
  for (let i = 0; i < n; i++) {
    const amp = Math.max(0.5, peaks[i]! * ampScale);
    const x = i * barW + gap * 0.5;
    const w = Math.max(1, barW - gap);
    ctx.fillRect(x, mid - amp, w, amp * 2);
  }
}

/**
 * Decode (cached) + paint the crop window of `file` into `canvas`.
 * Returns false if decode failed or the canvas left the DOM mid-flight.
 */
export async function paintClipWaveform(
  canvas: HTMLCanvasElement,
  file: string,
  cropIn: number,
  cropOut: number,
  sourceDuration: number,
  opts?: DrawWaveformOpts,
): Promise<boolean> {
  const gen = String((Number(canvas.dataset.waveGen) || 0) + 1);
  canvas.dataset.waveGen = gen;

  try {
    const data = await getWaveformPeaks(file);
    if (!canvas.isConnected || canvas.dataset.waveGen !== gen) return false;

    const dur =
      data.duration > 0
        ? data.duration
        : sourceDuration > 0
          ? sourceDuration
          : 1;
    // One peak column per CSS pixel (capped so huge zoom stays cheap)
    const bins = Math.max(8, Math.min(600, Math.floor(canvas.clientWidth) || 32));
    const region = peaksForRegion(data.peaks, dur, cropIn, cropOut, bins);
    drawWaveform(canvas, region, opts);
    return canvas.dataset.waveGen === gen;
  } catch {
    return false;
  }
}

export type GainEnvelope = {
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** Clip length in seconds (crop duration). */
  duration: number;
};

/**
 * Logic-style region gain line: fade-in ramp → sustain at volume → fade-out.
 * Drawn on a dedicated overlay canvas above the waveform.
 */
export function drawGainEnvelope(
  canvas: HTMLCanvasElement,
  env: GainEnvelope,
): void {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW < 2 || cssH < 2 || env.duration <= 0) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.floor(cssW * dpr));
  const bh = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const vol = Math.min(1, Math.max(0, env.volume));
  let fadeIn = Math.max(0, env.fadeIn);
  let fadeOut = Math.max(0, env.fadeOut);
  if (fadeIn + fadeOut > env.duration) {
    const s = env.duration / (fadeIn + fadeOut);
    fadeIn *= s;
    fadeOut *= s;
  }

  // y: 0 = top, bottom = silence. Peak sits near the top third of the clip.
  const yAt = (g: number) => cssH * (1 - 0.12 - g * 0.72);
  const xAt = (t: number) => (t / env.duration) * cssW;

  const pts: Array<{ x: number; y: number }> = [];
  pts.push({ x: 0, y: yAt(fadeIn > 1e-6 ? 0 : vol) });
  if (fadeIn > 1e-6) {
    pts.push({ x: xAt(fadeIn), y: yAt(vol) });
  }
  if (fadeOut > 1e-6) {
    pts.push({ x: xAt(env.duration - fadeOut), y: yAt(vol) });
    pts.push({ x: cssW, y: yAt(0) });
  } else {
    pts.push({ x: cssW, y: yAt(vol) });
  }

  // Soft fill under the envelope (reads as region gain in Logic)
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, cssH);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(cssW, cssH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(126, 232, 255, 0.1)';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i]!.x, pts[i]!.y);
  }
  ctx.strokeStyle = 'rgba(126, 232, 255, 0.85)';
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Corner dots at fade knees (handles-ish affordance)
  ctx.fillStyle = 'rgba(126, 232, 255, 0.95)';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}
