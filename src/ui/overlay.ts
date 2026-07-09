export interface OverlayHandles {
  setLoadingProgress: (p: number) => void;
  hideLoading: () => void;
  showHud: () => void;
  setStatus: (text: string, online?: boolean) => void;
  setIntegrity: (text: string) => void;
  setHintVisible: (v: boolean) => void;
  setReplayEnabled: (v: boolean) => void;
  onReplay: (cb: () => void) => void;
  updateClock: (elapsedSec: number) => void;
  fadeTitle: (hide: boolean) => void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function createOverlay(): OverlayHandles {
  const loading = el<HTMLDivElement>('loading');
  const loadingFill = el<HTMLDivElement>('loading-fill');
  const hudTop = el<HTMLElement>('hud-top');
  const hudBottom = el<HTMLElement>('hud-bottom');
  const hudCenter = el<HTMLDivElement>('hud-center');
  const status = el<HTMLParagraphElement>('status');
  const integrity = el<HTMLSpanElement>('integrity');
  const hint = el<HTMLSpanElement>('hint');
  const replayBtn = el<HTMLButtonElement>('replay-btn');
  const clock = el<HTMLSpanElement>('hud-clock');
  const title = el<HTMLHeadingElement>('title');

  let replayHandler: (() => void) | null = null;

  replayBtn.addEventListener('click', () => {
    replayHandler?.();
  });

  return {
    setLoadingProgress: (p: number) => {
      loadingFill.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
    },
    hideLoading: () => {
      loading.classList.add('fade-out');
    },
    showHud: () => {
      hudTop.classList.remove('hidden');
      hudBottom.classList.remove('hidden');
      hudCenter.classList.remove('hidden');
    },
    setStatus: (text: string, online = false) => {
      status.textContent = text;
      status.classList.toggle('online', online);
    },
    setIntegrity: (text: string) => {
      integrity.textContent = text;
    },
    setHintVisible: (v: boolean) => {
      hint.classList.toggle('visible', v);
    },
    setReplayEnabled: (v: boolean) => {
      replayBtn.disabled = !v;
    },
    onReplay: (cb: () => void) => {
      replayHandler = cb;
    },
    updateClock: (elapsedSec: number) => {
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      const whole = Math.floor(s);
      const frac = Math.floor((s - whole) * 100);
      clock.textContent = `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
    },
    fadeTitle: (hide: boolean) => {
      title.style.opacity = hide ? '0' : '1';
      title.style.transition = 'opacity 0.8s ease';
    },
  };
}
