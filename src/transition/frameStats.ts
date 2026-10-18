/**
 * Frame-time recorder for the workshop → flight handoff: every rAF interval
 * across the transition (whichever renderer is drawing), tagged with the
 * beat it fell in, plus the browser's long-task entries. Read it back from
 * `window.__handoffStats` (tests, captures, the console).
 */
export interface FrameSample {
  /** ms since the recording started. */
  t: number;
  /** Interval since the previous frame (ms). */
  dt: number;
  beat: string;
}

export interface FrameSummary {
  frames: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Frames over 1.5× / 2.5× the median interval (dropped one / two+). */
  over1_5x: number;
  over2_5x: number;
  longTasks: number;
  longTaskMaxMs: number;
}

export function createFrameStats() {
  const samples: FrameSample[] = [];
  const longTasks: Array<{ t: number; ms: number; beat: string }> = [];
  const marks: Array<{ t: number; beat: string }> = [];
  let beat = 'idle';
  let t0 = 0;
  let last = 0;
  let raf = 0;
  let running = false;
  let observer: PerformanceObserver | null = null;

  const tick = (now: number) => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (last) samples.push({ t: now - t0, dt: now - last, beat });
    last = now;
  };

  const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

  const summarize = (filter?: (s: FrameSample) => boolean): FrameSummary => {
    const list = filter ? samples.filter(filter) : samples;
    const dts = list.map((s) => s.dt).sort((a, b) => a - b);
    const med = pct(dts, 0.5) || 16.7;
    const lt = filter ? longTasks.filter((l) => list.some((s) => Math.abs(s.t - l.t) < 50)) : longTasks;
    return {
      frames: dts.length,
      meanMs: +(dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length)).toFixed(2),
      p50Ms: +med.toFixed(2),
      p95Ms: +pct(dts, 0.95).toFixed(2),
      p99Ms: +pct(dts, 0.99).toFixed(2),
      maxMs: +(dts[dts.length - 1] ?? 0).toFixed(2),
      over1_5x: dts.filter((d) => d > med * 1.5).length,
      over2_5x: dts.filter((d) => d > med * 2.5).length,
      longTasks: lt.length,
      longTaskMaxMs: Math.round(lt.reduce((a, l) => Math.max(a, l.ms), 0)),
    };
  };

  return {
    start() {
      if (running) return;
      running = true;
      t0 = performance.now();
      last = 0;
      raf = requestAnimationFrame(tick);
      try {
        observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push({ t: e.startTime - t0, ms: e.duration, beat });
        });
        observer.observe({ type: 'longtask', buffered: false });
      } catch {
        observer = null;
      }
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      observer?.disconnect();
    },
    mark(name: string) {
      beat = name;
      marks.push({ t: running ? performance.now() - t0 : 0, beat: name });
    },
    samples,
    longTasks,
    marks,
    summary: summarize,
    /** Per-beat summaries, in the order the beats ran. */
    byBeat(): Record<string, FrameSummary> {
      const out: Record<string, FrameSummary> = {};
      for (const m of marks) out[m.beat] ??= summarize((s) => s.beat === m.beat);
      return out;
    },
  };
}

export type FrameStats = ReturnType<typeof createFrameStats>;
