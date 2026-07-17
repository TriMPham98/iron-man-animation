export type QualityTier = 'high' | 'medium' | 'low';

/**
 * Resolve a quality tier from URL override or hardware heuristics.
 *
 * - `?quality=high|medium|low` forces the tier
 * - Software GL / SwiftShader → low
 * - Mobile / low cores / low deviceMemory → medium or low
 * - Otherwise high
 */
export function resolveQualityTier(): QualityTier {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('quality')?.toLowerCase();
    if (q === 'high' || q === 'medium' || q === 'low') return q;
  } catch {
    // ignore URL parse failures
  }

  // Software / Mesa software rasterizers are too slow for full fidelity
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const rendererStr = gl.getParameter(
          debugInfo.UNMASKED_RENDERER_WEBGL,
        ) as string;
        if (/SwiftShader|llvmpipe|Software|Microsoft Basic Render/i.test(rendererStr)) {
          return 'low';
        }
      }
    }
  } catch {
    // keep going
  }

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };

  const cores = navigator.hardwareConcurrency || 4;
  const memory = nav.deviceMemory; // GB, Chrome-only
  const isMobile =
    /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    ) ||
    (typeof navigator.maxTouchPoints === 'number' &&
      navigator.maxTouchPoints > 1 &&
      Math.min(window.screen.width, window.screen.height) < 900);

  const saveData = nav.connection?.saveData === true;
  const slowNet =
    nav.connection?.effectiveType === '2g' ||
    nav.connection?.effectiveType === 'slow-2g';

  if (saveData || slowNet) return 'low';

  // Very constrained devices
  if (isMobile && (cores <= 4 || (typeof memory === 'number' && memory <= 2))) {
    return 'low';
  }
  if (typeof memory === 'number' && memory <= 2 && cores <= 4) {
    return 'low';
  }

  // Mobile or modest desktop → medium
  if (isMobile) return 'medium';
  if (cores <= 4) return 'medium';
  if (typeof memory === 'number' && memory <= 4) return 'medium';

  return 'high';
}

/** Spatial shard grid used when splitting the suit mesh for fly-in. */
export function shardGridForTier(tier: QualityTier): {
  x: number;
  y: number;
  z: number;
} {
  switch (tier) {
    case 'high':
      return { x: 3, y: 7, z: 3 };
    case 'medium':
      return { x: 2, y: 5, z: 2 };
    case 'low':
      return { x: 2, y: 4, z: 2 };
  }
}

/** Cap device pixel ratio so high-DPI phones don't overdraw. */
export function maxPixelRatioForTier(tier: QualityTier): number {
  switch (tier) {
    case 'high':
      return 1.75;
    case 'medium':
      return 1.5;
    case 'low':
      return 1.25;
  }
}

/** Whether UnrealBloom should be enabled (low skips bloom entirely). */
export function preferBloomForTier(tier: QualityTier): boolean {
  return tier !== 'low';
}

/**
 * Run bloom at half framebuffer resolution (cheaper mips).
 * Medium only — high stays full-res; low has bloom off.
 */
export function halfResBloomForTier(tier: QualityTier): boolean {
  return tier === 'medium';
}
