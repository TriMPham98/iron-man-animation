import * as THREE from 'three';
import { MINI_ROCKETS } from '../../animation/flightCheck';
import type { Combat } from '../combat/combat';
import { ASSIST_RANGE, LAUNCHER_PER_ARM } from '../combat/playerWeapons';
import type { FlightModel } from '../sim/flightModel';
import { CRUISE_MAX, ICING_ALT } from '../sim/flightModel';
import type { GroundProbe } from '../sim/flightModel';
import type { SuitWireframe } from './suitWireframe';
import { BULLSEYE_R, CENTRED_R, type PadGrade } from '../world/landingPad';

/**
 * JARVIS's heads-up display, drawn on a 2D canvas over the frame each
 * frame: thin cyan linework, numbers in mono, labels in Michroma. Flight
 * symbology (aim reticle, flight-path marker, pitch ladder, speed and
 * altitude tapes, heading), suit status (armour, thrust, g), the arsenal,
 * target brackets with lock diamonds and lead pips, off-screen arrows,
 * a heading-up radar, incoming-missile warnings and JARVIS's voice as text.
 * Coming in to the pad: its marker and range, then a landing scope (the
 * suit's offset over the deck, its marks and drift), and the set-down's grade.
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
/** Landing scope: the half-width it shows (m), the deck's radius (m). */
const SCOPE_M = 8;
const PAD_EDGE = 7;
const GRADE_TEXT: Record<PadGrade, string> = { bullseye: 'BULLSEYE', centred: 'CENTRED', onPad: 'ON PAD' };

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
  /** A band along the bottom to keep clear (CSS px): the touch controls. */
  bottomInset = 0;
  /** Floor on the HUD's scale (a phone's short side would make it unreadable). */
  minScale = 0;
  /** How to call a wave, for the prompt under the radar (the touch overlay has a button). */
  waveKey = 'N';
  private killFlash = 0;
  /** The landing pad's centre on its deck, if there's one to bring the suit in to. */
  pad: THREE.Vector3 | null = null;
  /** The last set-down on the pad, its age (s), best offset and bullseye run. */
  private landing: { grade: PadGrade; offset: number; best: boolean; t: number } | null = null;
  private bestOffset = Infinity;
  private bullseyes = 0;
  private scopeAlpha = 0;
  private hitMarker = 0;
  /** The suit's thrusters (0–1 each), for the helmet's suit diagram. */
  jets: { bootL: number; bootR: number; palmL: number; palmR: number } | null = null;
  /** The suit's own wireframe for the helmet's suit diagram (set once the suit is built). */
  wireframe: SuitWireframe | null = null;
  /**
   * Helmet view: the head-mounted panels float on a soft spring against
   * the turn and the g (CSS px), so the head reads as moving inside the
   * shell; the world-fixed symbology stays where it belongs.
   */
  private readonly sway = new THREE.Vector2();
  private readonly swayVel = new THREE.Vector2();
  private readonly lastQ = new THREE.Quaternion();
  private readonly _q = new THREE.Quaternion();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none', zIndex: '2' });
    this.resize(window.innerWidth, window.innerHeight);
  }

  /** The view's size (CSS px), from the app (FlightApp.syncViewport); the canvas box is sized with it. */
  resize(w: number, h: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
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

  /** Set down on the pad, `offset` m from its centre. */
  padLanding(grade: PadGrade, offset: number): void {
    const best = offset < this.bestOffset;
    this.bestOffset = Math.min(this.bestOffset, offset);
    this.bullseyes = grade === 'bullseye' ? this.bullseyes + 1 : 0;
    this.landing = { grade, offset, best: best && grade !== 'onPad', t: 0 };
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
    const s = Math.max(this.minScale, Math.min(this.w, this.h) / 900);

    this.updateSway(dt, cam, m, helmet, s);
    this.drawLadder(g, cam, cx, cy, s);
    this.drawReticle(g, cx, cy, s);
    this.drawMarkers(g, cam, m, s);
    this.drawPadMarker(g, cam, m, s);
    this.drawTargets(g, cam, m, combat, s);
    this.drawWarnings(g, cam, m, combat, s);
    // Head-mounted panels (they ride the sway in the helmet)
    g.save();
    if (helmet) {
      g.translate(this.sway.x, this.sway.y);
      this.drawVisor(g, s);
      this.drawSuitDiagram(g, m, combat, s);
    }
    this.drawTapes(g, m, ground, s);
    this.drawHeading(g, cam, s);
    this.drawStatus(g, m, combat, s);
    this.drawWeapons(g, combat, s);
    this.drawRadar(g, cam, m, combat, s);
    this.drawScope(g, dt, cam, m, s);
    this.drawLanding(g, dt, s);
    this.drawLines(g, s);
    g.restore();
    g.globalAlpha = 1;
  }

  private text(g: CanvasRenderingContext2D, str: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', font = MONO): void {
    g.font = `${font === JARVIS ? 400 : 500} ${size}px ${font}`;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(str, x, y);
  }

  private updateSway(dt: number, cam: THREE.Camera, m: FlightModel, helmet: boolean, s: number): void {
    // The view's turn rate this frame (rad/s, camera axes)
    const q = this._q.copy(this.lastQ).invert().multiply(cam.quaternion);
    this.lastQ.copy(cam.quaternion);
    let goalX = 0;
    let goalY = 0;
    if (helmet && dt > 1e-4) {
      const k = 2 / dt;
      const yawRate = THREE.MathUtils.clamp(q.y * k, -3, 3);
      const pitchRate = THREE.MathUtils.clamp(q.x * k, -3, 3);
      // Panels lag the turn, and sink as the g piles on
      goalX = yawRate * 9 * s;
      goalY = pitchRate * 9 * s + THREE.MathUtils.clamp(m.gLoad - 1, 0, 9) * 2.2 * s;
    }
    const w = 9;
    const h = Math.min(dt, 0.05);
    this.swayVel.x += (w * w * (goalX - this.sway.x) - 2 * 0.6 * w * this.swayVel.x) * h;
    this.swayVel.y += (w * w * (goalY - this.sway.y) - 2 * 0.6 * w * this.swayVel.y) * h;
    this.sway.addScaledVector(this.swayVel, h);
    this.sway.clampLength(0, 26 * s);
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
    // Brackets at the projection's corners, the edge of what JARVIS can draw on
    const mx = this.w * 0.06;
    const my = this.h * 0.08;
    const k = 18 * s;
    g.strokeStyle = CYAN_DIM;
    for (const [x, y, dx, dy] of [
      [mx, my, 1, 1],
      [this.w - mx, my, -1, 1],
      [mx, this.h - my, 1, -1],
      [this.w - mx, this.h - my, -1, -1],
    ]) {
      g.beginPath();
      g.moveTo(x, y + dy * k);
      g.lineTo(x, y);
      g.lineTo(x + dx * k, y);
      g.stroke();
    }
    this.text(g, 'MK III  ·  HUD ONLINE', mx + 4 * s, my + k + 10 * s, 7 * s, CYAN_FAINT, 'left', JARVIS);
    const y = ((this.time * 0.12) % 1) * this.h;
    g.fillStyle = 'rgba(126,232,255,0.03)';
    g.fillRect(0, y, this.w, 2 * s);
  }

  /**
   * The suit as JARVIS draws it in the corner of the visor: its own panel
   * wireframe (the assembly's diagnostic scan), lit by the armour state,
   * a scan band sweeping it head to toe, each thruster glowing with its
   * output.
   */
  private drawSuitDiagram(g: CanvasRenderingContext2D, m: FlightModel, c: Combat, s: number): void {
    const wf = this.wireframe;
    if (!wf) return;
    const H = 150 * s;
    const k = H / wf.height;
    const W = wf.width * k;
    const cx = 74 * s;
    const top = this.h - 345 * s - this.bottomInset;
    const left = cx - W / 2;
    const armor = c.armor;
    const rgb = armor < 0.3 ? '255, 70, 60' : armor < 0.6 ? '255, 184, 77' : '126, 232, 255';
    g.save();
    g.shadowBlur = 0;
    g.drawImage(wf.canvas(rgb, 0.22), left, top, W, H);
    // The scan band: a slice of the bright copy, sweeping down and pausing
    const sweep = (this.time * 0.4) % 1.5;
    if (sweep < 1) {
      const band = wf.height * 0.07;
      const sy = sweep * (wf.height + band) - band;
      const y0 = Math.max(0, sy);
      const y1 = Math.min(wf.height, sy + band);
      if (y1 > y0) g.drawImage(wf.canvas(rgb, 0.6), 0, y0, wf.width, y1 - y0, left, top + y0 * k, W, (y1 - y0) * k);
    }
    // Thrusters: palms and boots, brightening with their output
    const j = this.jets;
    const pip = (p: { x: number; y: number }, out: number) => {
      const t = THREE.MathUtils.clamp(out, 0, 1);
      g.fillStyle = t > 0.75 ? WHITE : t > 0.05 ? CYAN : CYAN_FAINT;
      g.beginPath();
      g.arc(left + p.x * k, top + p.y * k, (1.6 + 2.6 * t) * s, 0, Math.PI * 2);
      g.fill();
    };
    pip(wf.pips.palmL, j?.palmL ?? 0);
    pip(wf.pips.palmR, j?.palmR ?? 0);
    pip(wf.pips.bootL, j?.bootL ?? 0);
    pip(wf.pips.bootR, j?.bootR ?? 0);
    g.restore();
    this.text(g, m.grounded ? 'SUIT · STANDING' : 'SUIT · THRUSTERS', cx, top + H + 12 * s, 7 * s, CYAN_DIM, 'center', JARVIS);
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

  /** The pad out in the world: a marker on it with its range, while the suit's in the air. */
  private drawPadMarker(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, m: FlightModel, s: number): void {
    const pad = this.pad;
    if (!pad || m.grounded) return;
    const d = Math.hypot(m.pos.x - pad.x, m.pos.z - pad.z);
    // (close in, the scope takes over)
    if (d < 12 || d > 4000) return;
    const p = this.project(pad, cam);
    if (!p) return;
    const a = THREE.MathUtils.smoothstep(d, 12, 30);
    const k = 6 * s;
    g.globalAlpha = this.alpha * a;
    g.strokeStyle = CYAN;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(p.x, p.y - k);
    g.lineTo(p.x + k, p.y);
    g.lineTo(p.x, p.y + k);
    g.lineTo(p.x - k, p.y);
    g.closePath();
    g.stroke();
    this.text(g, 'PAD', p.x, p.y - k - 8 * s, 7 * s, CYAN, 'center', JARVIS);
    this.text(g, d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`, p.x, p.y + k + 9 * s, 9 * s, CYAN_DIM, 'center');
    g.globalAlpha = this.alpha;
  }

  /**
   * Landing scope under the reticle, close in over the pad: the deck seen
   * from above, turned with the view (up is where the camera looks), its
   * edge and centre marks, the suit's place over it and its drift.
   */
  private drawScope(g: CanvasRenderingContext2D, dt: number, cam: THREE.PerspectiveCamera, m: FlightModel, s: number): void {
    const pad = this.pad;
    let goal = 0;
    let dx = 0;
    let dz = 0;
    let h = 0;
    if (pad && !m.grounded) {
      dx = m.pos.x - pad.x;
      dz = m.pos.z - pad.z;
      h = m.pos.y - m.hipHeight() - pad.y;
      const d = Math.hypot(dx, dz);
      goal = (1 - THREE.MathUtils.smoothstep(d, 18, 30)) * (1 - THREE.MathUtils.smoothstep(h, 45, 60)) * (h > -0.5 ? 1 : 0);
    }
    this.scopeAlpha += (goal - this.scopeAlpha) * (1 - Math.exp(-dt / 0.2));
    if (this.scopeAlpha < 0.01 || !pad) return;
    const cx = this.w / 2;
    const cy = this.h / 2 + 112 * s;
    const R = 38 * s;
    const px = R / SCOPE_M;
    // The view's heading: screen up is the camera's look, flattened
    const f = cam.getWorldDirection(this._v);
    const yaw = Math.atan2(f.x, f.z);
    const toScope = (x: number, z: number): [number, number] => {
      // right = f × up, so a point's across is its dot with (−fz, fx)
      const fwd = x * Math.sin(yaw) + z * Math.cos(yaw);
      const right = -x * Math.cos(yaw) + z * Math.sin(yaw);
      return [cx + right * px, cy - fwd * px];
    };
    const held = m.padPull;
    g.globalAlpha = this.alpha * this.scopeAlpha;
    g.lineWidth = 1;
    // Frame and the deck's marks
    g.fillStyle = 'rgba(0, 18, 28, 0.35)';
    g.beginPath();
    g.arc(cx, cy, R + 4 * s, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = CYAN_FAINT;
    g.beginPath();
    g.arc(cx, cy, R + 4 * s, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = CYAN_DIM;
    g.beginPath();
    g.arc(cx, cy, PAD_EDGE * px, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = held > 0.5 ? CYAN : CYAN_DIM;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(cx, cy, CENTRED_R * px, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = WHITE;
    g.beginPath();
    g.arc(cx, cy, BULLSEYE_R * px, 0, Math.PI * 2);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      g.strokeStyle = CYAN_FAINT;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (CENTRED_R + 0.6) * px, cy + Math.sin(a) * (CENTRED_R + 0.6) * px);
      g.lineTo(cx + Math.cos(a) * (PAD_EDGE - 0.5) * px, cy + Math.sin(a) * (PAD_EDGE - 0.5) * px);
      g.stroke();
    }
    // The suit over the deck, and where its drift takes it in a second
    const off = Math.hypot(dx, dz);
    const col = off <= BULLSEYE_R ? WHITE : off <= CENTRED_R ? CYAN : AMBER;
    let [sx, sy] = toScope(dx, dz);
    const [vx, vy] = toScope(dx + m.vel.x, dz + m.vel.z);
    const out = Math.hypot(sx - cx, sy - cy);
    if (out > R) {
      sx = cx + ((sx - cx) * R) / out;
      sy = cy + ((sy - cy) * R) / out;
    }
    g.strokeStyle = col;
    g.lineWidth = 1.4;
    if (Math.hypot(vx - sx, vy - sy) > 2 && out <= R) {
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(cx + THREE.MathUtils.clamp(vx - cx, -R, R), cy + THREE.MathUtils.clamp(vy - cy, -R, R));
      g.stroke();
    }
    g.fillStyle = col;
    g.beginPath();
    g.arc(sx, sy, 3.2 * s, 0, Math.PI * 2);
    g.fill();
    // Readouts: offset, height over the deck, and the capture
    this.text(g, `${off.toFixed(1)} m`, cx - R - 10 * s, cy, 9 * s, col, 'right');
    this.text(g, `${Math.max(0, h).toFixed(h < 10 ? 1 : 0)} ▾`, cx + R + 10 * s, cy, 9 * s, CYAN, 'left');
    const label = held > 0.5 ? 'PAD · HOLD' : 'PAD';
    this.text(g, label, cx, cy - R - 12 * s, 7 * s, held > 0.5 ? WHITE : CYAN_DIM, 'center', JARVIS);
    if (held < 0.5 && off < 16) this.text(g, 'HANDS OFF TO HOLD', cx, cy + R + 13 * s, 6 * s, CYAN_FAINT, 'center', JARVIS);
    g.globalAlpha = this.alpha;
  }

  /** The set-down's grade, a beat over the reticle. */
  private drawLanding(g: CanvasRenderingContext2D, dt: number, s: number): void {
    const l = this.landing;
    if (!l) return;
    l.t += dt;
    if (l.t > 3.4) {
      this.landing = null;
      return;
    }
    const a = Math.min(1, l.t / 0.12) * (l.t > 2.6 ? 1 - (l.t - 2.6) / 0.8 : 1);
    const cx = this.w / 2;
    const cy = this.h / 2;
    const col = l.grade === 'bullseye' ? WHITE : l.grade === 'centred' ? CYAN : CYAN_DIM;
    g.globalAlpha = this.alpha * a;
    // A ring thrown off the reticle, wider the better the landing
    if (l.grade !== 'onPad' && l.t < 0.8) {
      const u = l.t / 0.8;
      g.strokeStyle = col;
      g.lineWidth = 1.6;
      g.globalAlpha = this.alpha * (1 - u);
      g.beginPath();
      g.arc(cx, cy, (15 + (l.grade === 'bullseye' ? 90 : 50) * (1 - Math.pow(1 - u, 3))) * s, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = this.alpha * a;
    }
    // The word lands with a little overshoot, spaced wide
    const pop = 1 + 0.25 * Math.exp(-l.t * 9) * Math.cos(l.t * 30);
    const y = cy - 78 * s;
    g.save();
    g.translate(cx, y);
    g.scale(pop, pop);
    (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${4 * s}px`;
    this.text(g, GRADE_TEXT[l.grade], 0, 0, (l.grade === 'onPad' ? 13 : 18) * s, col, 'center', JARVIS);
    g.restore();
    const run = l.grade === 'bullseye' && this.bullseyes > 1 ? `  ·  ×${this.bullseyes}` : '';
    this.text(g, `${l.offset.toFixed(2)} m OFF CENTRE${run}`, cx, y + 20 * s, 9 * s, CYAN_DIM, 'center');
    if (l.best && this.bestOffset < Infinity) this.text(g, 'BEST LANDING', cx, y + 34 * s, 7 * s, AMBER, 'center', JARVIS);
    g.globalAlpha = this.alpha;
  }

  private drawLadder(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, cx: number, cy: number, s: number): void {
    const e = this._e.setFromQuaternion(cam.quaternion, 'YXZ');
    const pitch = e.x;
    const roll = e.z;
    const pxPerRad = this.h / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    g.save();
    g.translate(cx, cy);
    // (+ roll turns the camera anticlockwise: the world, and the ladder on
    // it, turns clockwise on the screen)
    g.rotate(roll);
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
    this.tape(g, lx, cy, spd, 50, (v) => (v >= 0 ? `${v}` : ''), -1, s, m.speedTarget * KNOTS);
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
    const y = this.h - 120 * s - this.bottomInset;
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
    let y = this.h - 132 * s - this.bottomInset;
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
    else if (c.waveReady) {
      // A wave is on offer: a slow pulse, never a timer
      g.save();
      g.globalAlpha *= 0.55 + 0.45 * Math.sin(this.time * 3);
      this.text(g, `${this.waveKey} — CALL WAVE ${c.wave + 2}`, x, y + R + 42 * s, 9 * s, AMBER, 'center', JARVIS);
      g.restore();
    }
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
    // The bottom band taken (touch controls): JARVIS speaks under the heading tape instead
    const top = this.bottomInset > 0;
    let y = top ? 80 * s + 24 : this.h - 70 * s;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      const age = this.time - l.t;
      if (age > 7) continue;
      const shown = Math.min(l.text.length, Math.floor(age * 55));
      const a = age > 6 ? 1 - (age - 6) : 1;
      g.globalAlpha = this.alpha * a * (i === this.lines.length - 1 ? 1 : 0.55);
      this.text(g, `J.A.R.V.I.S.  ${l.text.slice(0, shown)}`, x, y, 12 * s, i === this.lines.length - 1 ? WHITE : CYAN_DIM, 'center');
      y += top ? 20 * s : -20 * s;
    }
    g.globalAlpha = this.alpha;
  }
}

