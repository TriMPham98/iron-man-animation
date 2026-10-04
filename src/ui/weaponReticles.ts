import * as THREE from 'three';
import type { WeaponTarget } from '../suit/weaponsFx';

/**
 * JARVIS target boxes over each weapon during the arming check: a cyan
 * tracking bracket while it deploys, closing to gold with a lock tag once
 * it is locked / armed. Positioned by projecting each weapon to the screen.
 */
export function createWeaponReticles(camera: THREE.Camera) {
  const layer = document.createElement('div');
  layer.className = 'weapon-reticles';
  layer.setAttribute('aria-hidden', 'true');
  const host = document.getElementById('flight-panel')?.parentElement ?? document.body;
  host.appendChild(layer);
  const marks = new Map<string, { el: HTMLDivElement; box: HTMLSpanElement; tag: HTMLSpanElement; label: string }>();
  const ndc = new THREE.Vector3();
  let shown = false;

  const mark = (id: string) => {
    let m = marks.get(id);
    if (!m) {
      const el = document.createElement('div');
      el.className = 'weapon-reticle';
      const box = document.createElement('span');
      box.className = 'weapon-reticle-box';
      el.appendChild(box);
      const tag = document.createElement('span');
      tag.className = 'weapon-reticle-tag';
      el.appendChild(tag);
      layer.appendChild(el);
      m = { el, box, tag, label: '' };
      marks.set(id, m);
    }
    return m;
  };

  const hide = () => {
    if (!shown) return;
    shown = false;
    for (const m of marks.values()) m.el.classList.remove('is-visible');
  };

  return {
    update(targets: readonly WeaponTarget[]): void {
      if (!targets.length) {
        hide();
        return;
      }
      shown = true;
      const w = layer.clientWidth;
      const h = layer.clientHeight;
      const seen = new Set<string>();
      for (const t of targets) {
        seen.add(t.id);
        const m = mark(t.id);
        ndc.copy(t.at).project(camera);
        const onScreen = ndc.z < 1 && Math.abs(ndc.x) < 1.1 && Math.abs(ndc.y) < 1.1;
        m.el.classList.toggle('is-visible', onScreen);
        if (!onScreen) continue;
        const x = (ndc.x * 0.5 + 0.5) * w;
        const y = (-ndc.y * 0.5 + 0.5) * h;
        // Bracket closes in as the lock builds
        const scale = 1.5 - 0.5 * t.lock;
        m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        m.box.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        m.el.classList.toggle('is-locked', t.lock >= 0.999);
        if (m.label !== t.label) {
          m.label = t.label;
          m.tag.textContent = t.label;
        }
      }
      for (const [id, m] of marks) if (!seen.has(id)) m.el.classList.remove('is-visible');
    },
    hide,
  };
}
