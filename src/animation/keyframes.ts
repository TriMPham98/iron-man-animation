/**
 * Minimal deterministic keyframe tracks. The suit-up is evaluated as a pure
 * function of time (no tween state), so scrub / skip / reverse always land on
 * the exact same frame as live playback.
 */

export type EaseName =
  | 'linear'
  | 'step'
  | 'in2'
  | 'out2'
  | 'inOut2'
  | 'in3'
  | 'out3'
  | 'inOut3'
  | 'in4'
  | 'out4'
  | 'outBack';

export interface Key {
  t: number;
  v: number;
  /** Ease of the segment that *ends* on this key. */
  ease?: EaseName;
}

export type Track = readonly Key[];

export function ease(name: EaseName | undefined, u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  switch (name) {
    case 'step':
      return x >= 1 ? 1 : 0;
    case 'in2':
      return x * x;
    case 'out2':
      return 1 - (1 - x) * (1 - x);
    case 'inOut2':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'in3':
      return x * x * x;
    case 'out3':
      return 1 - Math.pow(1 - x, 3);
    case 'inOut3':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'in4':
      return x * x * x * x;
    case 'out4':
      return 1 - Math.pow(1 - x, 4);
    case 'outBack': {
      const c1 = 1.4;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    case 'linear':
    default:
      return x;
  }
}

/** Sample a track (keys must be sorted by t). Holds the ends. */
export function sampleTrack(track: Track, t: number): number {
  const n = track.length;
  if (n === 0) return 0;
  if (t <= track[0].t) return track[0].v;
  if (t >= track[n - 1].t) return track[n - 1].v;
  // Tracks are short (≤ ~16 keys) — linear scan is fastest
  for (let i = 1; i < n; i++) {
    const b = track[i];
    if (t < b.t) {
      const a = track[i - 1];
      const span = b.t - a.t;
      const u = span <= 1e-9 ? 1 : (t - a.t) / span;
      return a.v + (b.v - a.v) * ease(b.ease, u);
    }
  }
  return track[n - 1].v;
}

/** True when keys are in non-decreasing time order. */
export function isSortedTrack(track: Track): boolean {
  for (let i = 1; i < track.length; i++) {
    if (track[i].t < track[i - 1].t) return false;
  }
  return true;
}

/**
 * Monotone cubic (Fritsch–Carlson) through (ts, vs). Smooth through every
 * key without overshoot — used for camera channels so the move never stops
 * dead on a key nor swings past it.
 */
export function monotoneCubic(
  ts: readonly number[],
  vs: readonly number[],
  t: number,
): number {
  const n = ts.length;
  if (n === 0) return 0;
  if (n === 1 || t <= ts[0]) return vs[0];
  if (t >= ts[n - 1]) return vs[n - 1];

  let i = 0;
  while (i < n - 2 && t >= ts[i + 1]) i++;

  const slope = (k: number) => (vs[k + 1] - vs[k]) / Math.max(1e-9, ts[k + 1] - ts[k]);
  const tangent = (k: number): number => {
    if (k === 0 || k === n - 1) return 0; // ease in/out of the path ends
    const d0 = slope(k - 1);
    const d1 = slope(k);
    if (d0 * d1 <= 0) return 0;
    const h0 = ts[k] - ts[k - 1];
    const h1 = ts[k + 1] - ts[k];
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / d0 + w2 / d1);
  };

  const h = ts[i + 1] - ts[i];
  const u = (t - ts[i]) / h;
  const m0 = tangent(i) * h;
  const m1 = tangent(i + 1) * h;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * vs[i] +
    (u3 - 2 * u2 + u) * m0 +
    (-2 * u3 + 3 * u2) * vs[i + 1] +
    (u3 - u2) * m1
  );
}
