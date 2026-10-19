import * as THREE from 'three';
import { MINI_ROCKETS } from '../../animation/flightCheck';
import type { Combat } from '../combat/combat';
import { ASSIST_RANGE, LAUNCHER_PER_ARM } from '../combat/playerWeapons';
import type { FlightModel } from '../sim/flightModel';
import { BOOST_SPEED, CRUISE_MAX, ICING_ALT } from '../sim/flightModel';
import type { GroundProbe } from '../sim/flightModel';

/**
 * JARVIS's heads-up display, drawn on a 2D canvas over the frame each
 * frame: thin cyan linework, numbers in mono, labels in Michroma. Flight
 * symbology (aim reticle, flight-path marker, pitch ladder, speed and
 * altitude tapes, heading), suit status (armour, thrust, g), the arsenal,
 * target brackets with lock diamonds and lead pips, off-screen arrows,
 * a heading-up radar, incoming-missile warnings and JARVIS's voice as text.
 */

const CYAN = 'rgba(126, 232, 255, 0.92)';
const CYAN_DIM = 'rgba(126, 232, 255, 0.38)';
const CYAN_FAINT = 'rgba(126, 232, 255, 0.16)';
const WHITE = 'rgba(235, 250, 255, 0.95)';
const AMBER = 'rgba(255, 184, 77, 0.95)';
const RED = 'rgba(255, 70, 60, 0.95)';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const JARVIS = 'Michroma, "Eurostile", sans-serif';
/** m/s → knots. */
const KNOTS = 1.943844;

interface Line {
  text: string;
  t: number;
}

export class Hud {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private time = 0;
  private readonly lines: Line[] = [];
  private readonly _v = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _e = new THREE.Euler();
  /** HUD visibility 0–1 (eases in after take-off / boot). */
  alpha = 1;
  private killFlash = 0;
  private hitMarker = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2' });
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  say(text: string): void {
    this.lines.push({ text, t: this.time });
    if (this.lines.length > 3) this.lines.shift();
  }

  kill(): void {
    this.killFlash = 1;
  }

  hit(): void {
    this.hitMarker = 1;
  }

  /** World point → screen px (null behind the camera). */
  private project(p: THREE.Vector3, cam: THREE.Camera): THREE.Vector3 | null {
    const v = this._p.copy(p).project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return v.set((v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h, v.z);
  }

  draw(dt: number, cam: THREE.PerspectiveCamera, m: FlightModel, combat: Combat, ground: GroundProbe, helmet: boolean): void {
    this.time += dt;
    this.killFlash = Math.max(0, this.killFlash - dt * 2);
    this.hitMarker = Math.max(0, this.hitMarker - dt * 4);
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (this.alpha <= 0.01) return;
    g.globalAlpha = this.alpha * (combat.down > 0 ? 0.25 + 0.25 * Math.sin(this.time * 20) : 1);
    g.lineCap = 'round';
    // A dark halo keeps the linework legible against a bright sky
    g.shadowColor = 'rgba(0, 12, 22, 0.75)';
    g.shadowBlur = 4;

    const cx = this.w / 2;
    const cy = this.h / 2;
    const s = Math.min(this.w, this.h) / 900;

    if (helmet) this.drawVisor(g, s);
    this.drawLadder(g, cam, cx, cy, s);
    this.drawReticle(g, cx, cy, s);
    this.drawMarkers(g, cam, m, s);
    this.drawTapes(g, m, ground, s);
    this.drawHeading(g, cam, s);
    this.drawTargets(g, cam, m, combat, s);
    this.drawStatus(g, m, combat, s);
    this.drawWeapons(g, combat, s);
    this.drawRadar(g, cam, m, combat, s);
    this.drawWarnings(g, cam, m, combat, s);
    this.drawLines(g, s);
    g.globalAlpha = 1;
  }

  private text(g: CanvasRenderingContext2D, str: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', font = MONO): void {
    g.font = `${font === JARVIS ? 400 : 500} ${size}px ${font}`;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(str, x, y);
  }

  private drawVisor(g: CanvasRenderingContext2D, s: number): void {
    // Helmet frame: the curved edges of the visor and a scan line
    g.strokeStyle = CYAN_FAINT;
    g.lineWidth = 1;
    const r = Math.max(this.w, this.h) * 0.62;
    g.beginPath();
    g.arc(this.w / 2, this.h / 2, r, Math.PI * 0.82, Math.PI * 1.18);
    g.stroke();
    g.beginPath();
    g.arc(this.w / 2, this.h / 2, r, -Math.PI * 0.18, Math.PI * 0.18);
    g.stroke();
    const y = ((this.time * 0.12) % 1) * this.h;
    g.fillStyle = 'rgba(126,232,255,0.03)';
    g.fillRect(0, y, this.w, 2 * s);
  }

  private drawReticle(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
    g.strokeStyle = CYAN;
    g.lineWidth = 1.2;
    const r = 15 * s;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r + 3 * s), cy + Math.sin(a) * (r + 3 * s));
      g.lineTo(cx + Math.cos(a) * (r + 10 * s), cy + Math.sin(a) * (r + 10 * s));
      g.stroke();
    }
    g.fillStyle = WHITE;
    g.fillRect(cx - 1, cy - 1, 2, 2);
    if (this.hitMarker > 0) {
      g.strokeStyle = `rgba(255,255,255,${this.hitMarker})`;
      g.lineWidth = 2;
      const k = 9 * s;
      for (const [dx, dy] of [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]) {
        g.beginPath();
        g.moveTo(cx + dx * k, cy + dy * k);
        g.lineTo(cx + dx * k * 1.8, cy + dy * k * 1.8);
        g.stroke();
      }
    }
  }

  private drawMarkers(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, m: FlightModel, s: number): void {
    // Flight-path marker: where the suit is actually going
    if (m.speed > 4) {
      const p = this.project(this._v.copy(m.pos).addScaledVector(m.vel, 200 / m.speed), cam);
      if (p) {
        g.strokeStyle = WHITE;
        g.lineWidth = 1.4;
        const r = 6 * s;
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.moveTo(p.x - r, p.y);
        g.lineTo(p.x - r * 2.6, p.y);
        g.moveTo(p.x + r, p.y);
        g.lineTo(p.x + r * 2.6, p.y);
        g.moveTo(p.x, p.y - r);
        g.lineTo(p.x, p.y - r * 2);
        g.stroke();
      }
    }
    // Nose: where the suit points (it chases the reticle)
    const nose = this.project(this._v.copy(m.pos).addScaledVector(m.thrustAxis(new THREE.Vector3()).lerp(m.forward(), 1 - m.flightness), 200), cam);
    if (nose && m.flightness > 0.3) {
      g.strokeStyle = CYAN_DIM;
      g.lineWidth = 1.2;
      const k = 7 * s;
      g.beginPath();
      g.moveTo(nose.x - k, nose.y - k * 0.4);
      g.lineTo(nose.x - k * 0.4, nose.y + k * 0.5);
      g.lineTo(nose.x, nose.y);
      g.lineTo(nose.x + k * 0.4, nose.y + k * 0.5);
      g.lineTo(nose.x + k, nose.y - k * 0.4);
      g.stroke();
    }
  }

  private drawLadder(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, cx: number, cy: number, s: number): void {
    const e = this._e.setFromQuaternion(cam.quaternion, 'YXZ');
    const pitch = e.x;
    const roll = e.z;
    const pxPerRad = this.h / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    g.save();
    g.translate(cx, cy);
    g.rotate(-roll);
    g.lineWidth = 1;
    for (let deg = -60; deg <= 60; deg += 10) {
      const a = THREE.MathUtils.degToRad(deg) - pitch;
      if (Math.abs(a) > 0.5) continue;
      const y = -Math.tan(a) * pxPerRad;
      const fade = 1 - Math.abs(a) / 0.5;
      const w = (deg === 0 ? 210 : 70) * s;
      const gap = 46 * s;
      g.strokeStyle = deg === 0 ? `rgba(126,232,255,${0.5 * fade})` : `rgba(126,232,255,${0.3 * fade})`;
      g.setLineDash(deg < 0 ? [5 * s, 4 * s] : []);
      g.beginPath();
      g.moveTo(-gap - w, y);
      g.lineTo(-gap, y);
      g.moveTo(gap, y);
      g.lineTo(gap + w, y);
      if (deg !== 0) {
        const tick = deg > 0 ? 6 * s : -6 * s;
        g.moveTo(-gap - w, y);
        g.lineTo(-gap - w, y + tick);
        g.moveTo(gap + w, y);
        g.lineTo(gap + w, y + tick);
      }
      g.stroke();
      g.setLineDash([]);
      if (deg !== 0) this.text(g, `${Math.abs(deg)}`, gap + w + 8 * s, y, 10 * s, `rgba(126,232,255,${0.45 * fade})`);
    }
    g.restore();
  }

  private tape(g: CanvasRenderingContext2D, x: number, cy: number, value: number, step: number, label: (v: number) => string, side: 1 | -1, s: number, bug?: number): void {
    const H = 220 * s;
    const pxPer = H / (step * 6);
    g.save();
    g.beginPath();
    g.rect(x - 70 * s, cy - H / 2, 140 * s, H);
    g.clip();
    g.strokeStyle = CYAN_DIM;
    g.lineWidth = 1;
    const base = Math.floor(value / step) * step;
    for (let k = -5; k <= 5; k++) {
      const v = base + k * step;
      const y = cy - (v - value) * pxPer;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + side * 10 * s, y);
      g.stroke();
      const half = y - (step / 2) * pxPer;
      g.beginPath();
      g.moveTo(x, half);
      g.lineTo(x + side * 5 * s, half);
      g.stroke();
      this.text(g, label(v), x + side * 16 * s, y, 10 * s, CYAN_DIM, side > 0 ? 'left' : 'right');
    }
    if (bug !== undefined) {
      const y = THREE.MathUtils.clamp(cy - (bug - value) * pxPer, cy - H / 2, cy + H / 2);
      g.fillStyle = AMBER;
      g.beginPath();
      g.moveTo(x - side * 2 * s, y);
      g.lineTo(x - side * 10 * s, y - 5 * s);
      g.lineTo(x - side * 10 * s, y + 5 * s);
      g.fill();
    }
    g.restore();
    g.strokeStyle = CYAN_FAINT;
    g.beginPath();
    g.moveTo(x, cy - H / 2);
    g.lineTo(x, cy + H / 2);
    g.stroke();
  }

  private drawTapes(g: CanvasRenderingContext2D, m: FlightModel, ground: GroundProbe, s: number): void {
    const cy = this.h / 2;
    const lx = this.w / 2 - 300 * s;
    const rx = this.w / 2 + 300 * s;
    // Airspeed in knots, as a flight HUD reads it (Mach 1 ≈ 667 kt)
    const spd = m.speed * KNOTS;
    this.tape(g, lx, cy, spd, 50, (v) => (v >= 0 ? `${v}` : ''), -1, s, (m.boosting ? BOOST_SPEED : m.speedCmd) * KNOTS);
    this.tape(g, rx, cy, m.pos.y, 100, (v) => `${v}`, 1, s);
    // Readout boxes
    const box = (x: number, label: string, value: string, align: 1 | -1) => {
      g.strokeStyle = CYAN;
      g.lineWidth = 1.2;
      const bw = 74 * s;
      const bh = 22 * s;
      const bx = align < 0 ? x - bw - 4 * s : x + 4 * s;
      g.strokeRect(bx, cy - bh / 2, bw, bh);
      g.fillStyle = 'rgba(4, 14, 22, 0.35)';
      g.fillRect(bx, cy - bh / 2, bw, bh);
      this.text(g, value, bx + bw / 2, cy, 14 * s, WHITE, 'center');
      this.text(g, label, bx + bw / 2, cy - 22 * s, 8 * s, CYAN_DIM, 'center', JARVIS);
    };
    box(lx, 'AIRSPEED KT', `${Math.round(spd)}`, -1);
    box(rx, 'ALT MSL', `${Math.round(m.pos.y)}`, 1);
    const mach = m.mach;
    this.text(g, `M ${mach.toFixed(2)}`, lx - 42 * s, cy + 26 * s, 11 * s, mach > 0.98 ? AMBER : CYAN, 'center');
    this.text(g, `G ${m.gLoad.toFixed(1)}`, lx - 42 * s, cy + 42 * s, 11 * s, m.gLoad > 8 ? AMBER : CYAN_DIM, 'center');
    const ra = m.pos.y - m.hipHeight() - ground.surface(m.pos.x, m.pos.z);
    this.text(g, `R ${Math.max(0, Math.round(ra))}`, rx + 42 * s, cy + 26 * s, 11 * s, ra < 50 ? AMBER : CYAN, 'center');
    const vs = m.vel.y;
    this.text(g, `${vs >= 0 ? '▲' : '▼'} ${Math.abs(vs).toFixed(0)}`, rx + 42 * s, cy + 42 * s, 11 * s, CYAN_DIM, 'center');
  }

  private drawHeading(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, s: number): void {
    const f = cam.getWorldDirection(this._v);
    // Compass: 0° = north (−Z), clockwise
    let hdg = THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z));
    if (hdg < 0) hdg += 360;
    const cx = this.w / 2;
    const y = 44 * s;
    const W = 340 * s;
    const pxPerDeg = W / 70;
    g.save();
    g.beginPath();
    g.rect(cx - W / 2, y - 20 * s, W, 44 * s);
    g.clip();
    g.strokeStyle = CYAN_DIM;
    g.lineWidth = 1;
    const start = Math.floor((hdg - 40) / 5) * 5;
    for (let d = start; d <= hdg + 40; d += 5) {
      const x = cx + (d - hdg) * pxPerDeg;
      const major = d % 10 === 0;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + (major ? 9 : 5) * s);
      g.stroke();
      if (d % 30 === 0) {
        const n = ((d % 360) + 360) % 360;
        const name = n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : `${n / 10}`.padStart(2, '0');
        this.text(g, name, x, y + 20 * s, 10 * s, n % 90 === 0 ? CYAN : CYAN_DIM, 'center');
      }
    }
    g.restore();
    g.fillStyle = WHITE;
    g.beginPath();
    g.moveTo(cx, y - 2 * s);
    g.lineTo(cx - 5 * s, y - 10 * s);
    g.lineTo(cx + 5 * s, y - 10 * s);
    g.fill();
    this.text(g, `${Math.round(hdg).toString().padStart(3, '0')}`, cx, y - 20 * s, 12 * s, WHITE, 'center');
  }

  private drawTargets(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, _m: FlightModel, c: Combat, s: number): void {
    const W = c.weapons;
    const locked = new Map<number, number>();
    W.locks.forEach((h, i) => locked.set(h.id, i + 1));
    // Forearm launcher: painted (or queued) targets in firing order, and
    // which arm takes each
    const atLocks = W.launcherLocks.length ? W.launcherLocks : W.launcherQueue;
    const atOrder = new Map<number, number>();
    atLocks.forEach((h, i) => {
      if (h) atOrder.set(h.id, i);
    });
    const cx = this.w / 2;
    const cy = this.h / 2;
    for (const h of c.hostiles) {
      if (!h.alive) continue;
      const dist = h.pos.distanceTo(cam.position);
      const p = this.project(h.pos, cam);
      const onScreen = p && p.x > 0 && p.x < this.w && p.y > 0 && p.y < this.h;
      const hostileColor = h.kind === 'sam' ? AMBER : RED;
      if (!onScreen) {
        if (dist > 7000) continue;
        // Edge arrow pointing toward it
        const rel = this._v.copy(h.pos).applyMatrix4(cam.matrixWorldInverse);
        const ang = Math.atan2(-rel.y, rel.x);
        const R = Math.min(this.w, this.h) * 0.42;
        const ax = cx + Math.cos(ang) * R;
        const ay = cy + Math.sin(ang) * R;
        g.save();
        g.translate(ax, ay);
        g.rotate(ang);
        g.fillStyle = hostileColor;
        g.beginPath();
        g.moveTo(9 * s, 0);
        g.lineTo(-5 * s, -6 * s);
        g.lineTo(-5 * s, 6 * s);
        g.fill();
        g.restore();
        continue;
      }
      const size = THREE.MathUtils.clamp(2600 / dist, 9, 60) * s;
      const x = p.x;
      const y = p.y;
      g.strokeStyle = hostileColor;
      g.lineWidth = 1.3;
      // Corner brackets
      const k = size * 0.4;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        g.beginPath();
        g.moveTo(x + sx * size, y + sy * (size - k));
        g.lineTo(x + sx * size, y + sy * size);
        g.lineTo(x + sx * (size - k), y + sy * size);
        g.stroke();
      }
      const label = `${h.kind === 'sam' ? 'SAM' : 'DRN'} ${dist > 1000 ? (dist / 1000).toFixed(1) + 'k' : Math.round(dist)}`;
      this.text(g, label, x + size + 6 * s, y - size + 6 * s, 9 * s, hostileColor);
      // Health bar
      const hp = h.hp / h.maxHp;
      if (hp < 0.999) {
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(x - size, y + size + 4 * s, size * 2, 2.5 * s);
        g.fillStyle = hostileColor;
        g.fillRect(x - size, y + size + 4 * s, size * 2 * Math.max(0, hp), 2.5 * s);
      }
      // Missile lock: a spinning diamond, numbered in salvo order (one per enemy)
      const n = locked.get(h.id);
      if (n) {
        g.save();
        g.translate(x, y);
        g.rotate(this.time * 2);
        g.strokeStyle = WHITE;
        g.lineWidth = 1.6;
        const d = size * 1.35;
        g.beginPath();
        g.moveTo(0, -d);
        g.lineTo(d, 0);
        g.lineTo(0, d);
        g.lineTo(-d, 0);
        g.closePath();
        g.stroke();
        g.restore();
        this.text(g, `${n}`, x - size - 6 * s, y - size + 6 * s, 9 * s, WHITE, 'right');
      }
      // Lead pip (repulsors, or the unibeam's short sweep lag) on every
      // target in gun range, tied to it by a line: put the sight on the pip.
      // The assisted one is bold, with a dot at its centre
      if (dist < ASSIST_RANGE) {
        const lead = this.project(W.leadPoint(h, this._v), cam);
        if (lead) {
          const on = W.assist === h;
          const r = (on ? 7 : 5) * s;
          const dx = lead.x - x;
          const dy = lead.y - y;
          const dl = Math.hypot(dx, dy);
          g.strokeStyle = on ? WHITE : CYAN;
          g.lineWidth = on ? 1.8 : 1.1;
          if (dl > r + 2 * s) {
            g.setLineDash([3 * s, 3 * s]);
            g.beginPath();
            g.moveTo(x + (dx / dl) * Math.min(dl, size * 0.5), y + (dy / dl) * Math.min(dl, size * 0.5));
            g.lineTo(lead.x - (dx / dl) * r, lead.y - (dy / dl) * r);
            g.stroke();
            g.setLineDash([]);
          }
          g.beginPath();
          g.arc(lead.x, lead.y, r, 0, Math.PI * 2);
          g.stroke();
          if (on) {
            g.fillStyle = WHITE;
            g.beginPath();
            g.arc(lead.x, lead.y, 1.6 * s, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
      const at = atOrder.get(h.id);
      if (at !== undefined) {
        // Amber ring that closes on lock; the next round's target pulses
        const next = at === 0;
        g.strokeStyle = AMBER;
        g.lineWidth = next ? 2 : 1.2;
        const r = size * (next ? 1.55 + 0.12 * Math.sin(this.time * 12) : 1.6);
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.stroke();
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2 + Math.PI / 4;
          g.beginPath();
          g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
          g.lineTo(x + Math.cos(a) * (r + 5 * s), y + Math.sin(a) * (r + 5 * s));
          g.stroke();
        }
        this.text(g, `AT${at + 1}`, x + r + 3 * s, y + r, 8 * s, AMBER);
      }
    }
    // Launcher paint: a tight amber cone
    if (W.launcherLockProgress > 0) {
      const r = Math.tan(THREE.MathUtils.degToRad(10)) * (this.h / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
      g.strokeStyle = 'rgba(255, 184, 77, 0.35)';
      g.lineWidth = 1;
      g.setLineDash([2 * s, 5 * s]);
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.strokeStyle = AMBER;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * W.launcherLockProgress);
      g.stroke();
      this.text(g, `AT LOCK ${W.launcherLocks.length}/${W.launcherAmmo}`, cx, cy + r + 14 * s, 9 * s, AMBER, 'center');
    }
    // Unibeam: the reactor's charge ring round the sight, then the heat
    if (W.unibeamCharge > 0 || W.unibeamOn) {
      const r = 26 * s;
      g.strokeStyle = CYAN_FAINT;
      g.lineWidth = 3 * s;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = W.unibeamOn ? WHITE : CYAN;
      g.beginPath();
      g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (W.unibeamOn ? 1 : W.unibeamCharge));
      g.stroke();
      if (W.unibeamOn) {
        const heat = W.unibeamHeat;
        g.strokeStyle = heat > 0.8 ? RED : heat > 0.55 ? AMBER : CYAN;
        g.lineWidth = 2 * s;
        g.beginPath();
        g.arc(cx, cy, r + 6 * s, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * heat);
        g.stroke();
      }
    }
    // Missile lock cone while painting
    if (W.lockProgress > 0) {
      const r = Math.tan(THREE.MathUtils.degToRad(19)) * (this.h / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
      g.strokeStyle = CYAN_DIM;
      g.lineWidth = 1;
      g.setLineDash([3 * s, 6 * s]);
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.strokeStyle = CYAN;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * W.lockProgress);
      g.stroke();
    }
  }

  private drawStatus(g: CanvasRenderingContext2D, m: FlightModel, c: Combat, s: number): void {
    const x = 40 * s;
    const y = this.h - 120 * s;
    // Armour arc
    const r = 34 * s;
    const ax = x + r;
    const ay = y + r;
    g.lineWidth = 4 * s;
    g.strokeStyle = CYAN_FAINT;
    g.beginPath();
    g.arc(ax, ay, r, Math.PI * 0.75, Math.PI * 2.25);
    g.stroke();
    const armor = c.armor;
    g.strokeStyle = armor < 0.3 ? RED : armor < 0.6 ? AMBER : CYAN;
    g.beginPath();
    g.arc(ax, ay, r, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * armor);
    g.stroke();
    this.text(g, `${Math.round(armor * 100)}`, ax, ay - 2 * s, 18 * s, WHITE, 'center');
    this.text(g, 'ARMOR', ax, ay + 16 * s, 7 * s, CYAN_DIM, 'center', JARVIS);
    // Thrust + boost bar
    const bx = x + r * 2 + 22 * s;
    const bh = 64 * s;
    this.text(g, 'THRUST', bx, y - 4 * s, 7 * s, CYAN_DIM, 'left', JARVIS);
    for (let i = 0; i < 20; i++) {
      const on = i / 20 < m.throttle;
      g.fillStyle = on ? (i > 13 ? AMBER : CYAN) : CYAN_FAINT;
      g.fillRect(bx + i * 6 * s, y + 8 * s, 4 * s, 12 * s);
    }
    const cmd = m.boosting ? 'BOOST' : m.grounded ? 'GROUND' : m.flightness < 0.5 ? 'HOVER' : `CRUISE ${Math.round((m.speedCmd / CRUISE_MAX) * 100)}%`;
    this.text(g, cmd, bx, y + 34 * s, 11 * s, m.boosting ? AMBER : WHITE);
    this.text(g, `REACTOR ${c.down > 0 ? 'REBOOT' : 'NOMINAL'}`, bx, y + 52 * s, 9 * s, c.down > 0 ? RED : CYAN_DIM);
    if (m.icing > 0.01) this.text(g, `ICING ${Math.round(m.icing * 100)}%`, bx, y + 68 * s, 9 * s, AMBER);
    void bh;
  }

  private drawWeapons(g: CanvasRenderingContext2D, c: Combat, s: number): void {
    const W = c.weapons;
    const x = this.w - 40 * s;
    let y = this.h - 132 * s;
    const row = (label: string, value: string, color: string, extra?: (bx: number, by: number) => void) => {
      this.text(g, label, x - 150 * s, y, 8 * s, CYAN_DIM, 'left', JARVIS);
      this.text(g, value, x, y, 11 * s, color, 'right');
      extra?.(x - 150 * s, y + 9 * s);
      y += 26 * s;
    };
    row('REPULSORS', W.repulsorBusy ? 'FIRING' : 'READY', W.repulsorBusy ? WHITE : CYAN);
    // Pods L | R: one pip per tube
    row('MICRO-MISSILES', `${W.rockets}/${W.rocketCapacity}`, W.rockets ? CYAN : AMBER, (bx, by) => {
      for (let p = 0; p < 2; p++) {
        for (let i = 0; i < MINI_ROCKETS / 2; i++) {
          g.fillStyle = i < W.pods[p] ? CYAN : CYAN_FAINT;
          g.fillRect(bx + p * 78 * s + i * 16 * s, by, 12 * s, 3 * s);
        }
      }
    });
    // Unibeam heat: cools back from red; overheated it locks out and vents
    const heat = W.unibeamHeat;
    const over = W.unibeamOverheat;
    const blink = Math.sin(this.time * 10) > 0;
    const ubText = over ? 'OVERHEAT' : W.unibeamOn ? 'DISCHARGE' : W.unibeamCharge > 0 ? `CHARGING ${Math.round(W.unibeamCharge * 100)}%` : heat > 0.02 ? `COOLING ${Math.round(heat * 100)}°` : 'READY';
    const ubColor = over ? (blink ? RED : AMBER) : W.unibeamOn ? WHITE : CYAN;
    row('UNIBEAM', ubText, ubColor, (bx, by) => {
      g.fillStyle = CYAN_FAINT;
      g.fillRect(bx, by, 150 * s, 3 * s);
      g.fillStyle = over ? RED : heat > 0.8 ? RED : heat > 0.55 ? AMBER : W.unibeamOn ? WHITE : CYAN;
      g.fillRect(bx, by, 150 * s * heat, 3 * s);
      // Where the lockout releases
      g.fillStyle = CYAN_DIM;
      g.fillRect(bx + 150 * s * 0.35 - 0.5 * s, by - 2 * s, 1 * s, 7 * s);
    });
    row('FLARES', `${W.flares}`, W.flareCooldown > 0 ? CYAN_DIM : CYAN);
    const atBusy = W.launcherQueue.length > 0;
    row('AT LAUNCHERS', atBusy ? `FIRING ${W.launcherQueue.length}` : W.launcherAmmo ? `${W.launcherAmmo} RDS` : 'RELOAD', atBusy ? WHITE : W.launcherAmmo ? CYAN : AMBER, (bx, by) => {
      for (let p = 0; p < 2; p++) {
        for (let i = 0; i < LAUNCHER_PER_ARM; i++) {
          g.fillStyle = i < W.launcherRounds[p] ? AMBER : CYAN_FAINT;
          g.fillRect(bx + p * 78 * s + i * 14 * s, by, 11 * s, 3 * s);
        }
      }
    });
  }

  private drawRadar(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, m: FlightModel, c: Combat, s: number): void {
    const R = 62 * s;
    const x = this.w - 40 * s - R;
    const y = 40 * s + R;
    const range = 7000;
    g.strokeStyle = CYAN_FAINT;
    g.lineWidth = 1;
    for (const k of [1, 0.66, 0.33]) {
      g.beginPath();
      g.arc(x, y, R * k, 0, Math.PI * 2);
      g.stroke();
    }
    // Sweep
    const sw = (this.time * 1.4) % (Math.PI * 2);
    const grad = g.createConicGradient?.(sw - 0.6, x, y);
    if (grad) {
      grad.addColorStop(0, 'rgba(126,232,255,0)');
      grad.addColorStop(0.09, 'rgba(126,232,255,0.14)');
      grad.addColorStop(0.1, 'rgba(126,232,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      g.fill();
    }
    const f = cam.getWorldDirection(this._v);
    const hdg = Math.atan2(f.x, -f.z);
    const plot = (p: THREE.Vector3, color: string, size: number, tri = false) => {
      const dx = p.x - m.pos.x;
      const dz = p.z - m.pos.z;
      // Heading-up: rotate world into the camera's heading
      const rx = dx * Math.cos(hdg) + dz * Math.sin(hdg);
      const ry = dx * Math.sin(hdg) - dz * Math.cos(hdg);
      const d = Math.hypot(rx, ry);
      const k = Math.min(1, d / range);
      const px = x + (rx / Math.max(d, 1)) * k * R;
      const py = y - (ry / Math.max(d, 1)) * k * R;
      g.fillStyle = color;
      if (tri) {
        g.beginPath();
        g.moveTo(px, py - size);
        g.lineTo(px - size, py + size);
        g.lineTo(px + size, py + size);
        g.fill();
      } else g.fillRect(px - size / 2, py - size / 2, size, size);
    };
    for (const h of c.hostiles) if (h.alive) plot(h.pos, h.kind === 'sam' ? AMBER : RED, 4 * s, h.kind === 'sam');
    for (const ms of c.missiles.threats()) plot(ms.pos, WHITE, 3 * s);
    g.fillStyle = WHITE;
    g.beginPath();
    g.moveTo(x, y - 6 * s);
    g.lineTo(x - 4 * s, y + 4 * s);
    g.lineTo(x + 4 * s, y + 4 * s);
    g.fill();
    this.text(g, c.wave >= 0 ? `WAVE ${c.wave + 1}` : 'FREE FLIGHT', x, y + R + 14 * s, 8 * s, CYAN_DIM, 'center', JARVIS);
    this.text(g, `KILLS ${c.kills}`, x, y + R + 28 * s, 10 * s, this.killFlash > 0 ? WHITE : CYAN, 'center');
    const alive = c.hostiles.filter((h) => h.alive).length;
    if (alive) this.text(g, `HOSTILES ${alive}`, x, y + R + 42 * s, 10 * s, RED, 'center');
  }

  private drawWarnings(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, m: FlightModel, c: Combat, s: number): void {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const blink = Math.sin(this.time * 14) > 0;
    // Incoming seekers: a chevron toward each and a flashing callout
    const threats = c.missiles.threats();
    if (threats.length) {
      if (blink) this.text(g, threats.length > 1 ? `MISSILES ×${threats.length}` : 'MISSILE', cx, cy + 88 * s, 16 * s, RED, 'center', JARVIS);
      this.text(g, 'F — FLARES', cx, cy + 108 * s, 9 * s, AMBER, 'center', JARVIS);
      for (const t of threats) {
        const rel = this._v.copy(t.pos).applyMatrix4(cam.matrixWorldInverse);
        const ang = Math.atan2(-rel.y, rel.x);
        const R = 70 * s;
        g.save();
        g.translate(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
        g.rotate(ang);
        g.strokeStyle = RED;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(-5 * s, -7 * s);
        g.lineTo(4 * s, 0);
        g.lineTo(-5 * s, 7 * s);
        g.stroke();
        g.restore();
      }
    }
    if (m.pos.y > ICING_ALT && blink) this.text(g, 'ICE ON THE AIRFOILS', cx, cy - 64 * s, 11 * s, AMBER, 'center', JARVIS);
    if (c.down > 0) this.text(g, 'POWER FAILURE — REBOOTING', cx, cy - 40 * s, 14 * s, RED, 'center', JARVIS);
  }

  private drawLines(g: CanvasRenderingContext2D, s: number): void {
    const x = this.w / 2;
    let y = this.h - 70 * s;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      const age = this.time - l.t;
      if (age > 7) continue;
      const shown = Math.min(l.text.length, Math.floor(age * 55));
      const a = age > 6 ? 1 - (age - 6) : 1;
      g.globalAlpha = this.alpha * a * (i === this.lines.length - 1 ? 1 : 0.55);
      this.text(g, `J.A.R.V.I.S.  ${l.text.slice(0, shown)}`, x, y, 12 * s, i === this.lines.length - 1 ? WHITE : CYAN_DIM, 'center');
      y -= 20 * s;
    }
    g.globalAlpha = this.alpha;
  }
}

