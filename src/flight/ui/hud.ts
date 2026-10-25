import * as THREE from 'three';
import { MINI_ROCKETS } from '../../animation/flightCheck';
import { RESERVES, type Combat } from '../combat/combat';
import { LAUNCHER_PER_ARM } from '../combat/playerWeapons';
import type { SimEvent } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import { AUTOLAND_LOCK_R, CRUISE_MAX } from '../sim/flightModel';
import type { GroundProbe } from '../sim/flightModel';
import type { SuitWireframe } from './suitWireframe';
import { BULLSEYE_R, CENTRED_R } from '../world/landingPad';

/**
 * JARVIS's heads-up display, drawn on a 2D canvas over the frame each
 * frame: thin cyan linework, numbers in mono, labels in Michroma. Flight
 * symbology (aim reticle, flight-path marker, pitch ladder, speed and
 * altitude tapes, heading), suit status (armour, thrust, g), the arsenal,
 * target brackets with lock diamonds and lead pips, off-screen arrows,
 * a heading-up radar, incoming-missile warnings and JARVIS's voice as text.
 * Coming in to the pad: its marker and range, then a landing scope (the
 * suit's offset over the deck, its marks and drift), and auto-land (the
 * scope zooming in on its last trims onto the centre, then locking on).
 *
 * It answers what happens: it boots panel by panel when the suit comes
 * online, glitches and shakes when the armour takes a hit (the armour arc
 * leaving a draining ghost of what was lost), stamps SPLASH on a kill,
 * banners a wave in and out, snaps brackets onto new contacts and locks,
 * and the radar's blips flare as the sweep passes them.
 */

const CYAN = 'rgba(126, 232, 255, 0.92)';
const CYAN_DIM = 'rgba(126, 232, 255, 0.38)';
const CYAN_FAINT = 'rgba(126, 232, 255, 0.16)';
/** Panel labels: dimmer than a reading, brighter than the linework (they sit on glass). */
const CYAN_LABEL = 'rgba(150, 236, 255, 0.66)';
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
/** How far ahead the scope's drift vector reaches (s). */
const DRIFT_LEAD = 1.5;
/** The tightest the scope zooms to on auto-land's last trims (half-width, m). */
const SCOPE_FINE_M = 0.12;
/** A distance off the pad centre, down to the millimetre close in. */
const offText = (d: number) =>
  d >= 1 ? `${d.toFixed(d < 10 ? 1 : 0)} m` : d >= 0.1 ? `${(d * 100).toFixed(0)} cm` : d >= 0.01 ? `${(d * 100).toFixed(1)} cm` : `${(d * 1000).toFixed(0)} mm`;

/** The glass behind the panels. */
const GLASS = 'rgba(2, 14, 24, 0.34)';
/** The holographic bloom round the linework (a CSS filter on the canvas, composited on the GPU). */
const GLOW = 'drop-shadow(0 0 4px rgba(90, 215, 255, 0.42))';
/** Boot: when each panel comes up after the HUD does (s), and how long it takes. */
const BOOT = { visor: 0, reticle: 0.1, ladder: 0.25, heading: 0.35, tapes: 0.45, status: 0.6, weapons: 0.72, radar: 0.85, suit: 1.0 } as const;
const BOOT_RISE = 0.35;
/** Cheap deterministic flicker (0–1) from a time and a seed. */
const flick = (t: number, seed: number) => {
  const v = Math.sin(Math.floor(t * 40) * 12.9898 + seed * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

interface Line {
  text: string;
  t: number;
}

/** A SPLASH stamped where a hostile died (`streak`: its place in a run of quick kills). */
interface Splash {
  at: THREE.Vector3;
  kind: string;
  t: number;
  streak: number;
}

/** Where a hit on the armour came from (world direction off the suit), for the arc round the sight. */
interface Impact {
  dir: THREE.Vector3;
  t: number;
  heavy: boolean;
}

/** A wave's tally, kept as it's fought and shown once the sky is clear. */
interface Tally {
  wave: number;
  t0: number;
  kills: number;
  shots: number;
  hits: number;
  /** Armour lost (points of 100). */
  lost: number;
  /** R&D earned. */
  rd?: number;
  /** Set on the clear: when it was cleared and how long the wave took (s). */
  t?: number;
  dur?: number;
}

/** HUD moments the sound engine answers (`n`: the streak count). */
export type HudCue = 'zone' | 'streak' | 'tally' | 'tallyDone';

/** Speed streaks at the edge of the view: fixed seeds (angle, phase, pace). */
const STREAKS = Array.from({ length: 40 }, (_, i) => {
  const h = (k: number) => {
    const v = Math.sin(i * 91.7 + k * 47.3) * 43758.5453;
    return v - Math.floor(v);
  };
  return { a: h(1) * Math.PI * 2, p: h(2), v: 0.7 + h(3) * 0.8 };
});

/** A run of kills inside this many seconds of each other is a streak. */
const STREAK_GAP = 3.5;
const STREAK_NAME = ['SPLASH', 'SPLASH TWO', 'SPLASH THREE', 'SPLASH FOUR', 'SPLASH FIVE'];

/** A banner across the upper third (waves, Mach 1). */
interface Banner {
  title: string;
  sub: string;
  color: string;
  t: number;
  /** A short one (Mach 1, decoys): smaller and quicker. */
  minor: boolean;
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
  /** How to hand the suit to auto-land (the touch overlay's button says LAND). */
  landKey = 'L';
  /** Auto-land: on offer, flying, or neither (set by the app each frame). */
  autoLand: 'ready' | 'active' | null = null;
  /** TEMP: on the ground and free to lift off (set by the app each frame). */
  takeoff = false;
  /** The R&D refit on offer (standing on the pad, or with the suit lost): its prompt, or null. */
  refitHint: string | null = null;
  private refitAlpha = 0;
  /** The prompt as last shown (it fades out on it). */
  private refitText = '';
  private takeoffAlpha = 0;
  private promptAlpha = 0;
  private promptT = 0;
  private promptState: 'ready' | 'active' = 'ready';
  private killFlash = 0;
  /** The landing pad's centre on its deck, if there's one to bring the suit in to. */
  pad: THREE.Vector3 | null = null;
  private scopeAlpha = 0;
  /** The scope's half-width as it zooms (m), and how long auto-land has been locked on (s). */
  private scopeSpan = SCOPE_M;
  private lockT = 0;
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
  /** Since the HUD (or the reactor) last came up (s): the panels boot in order. */
  private bootT = 0;
  private wasShown = false;
  private wasDown = false;
  /** A hit: the shake (0–1), its glitch, and the armour the arc still shows as a draining ghost. */
  private shake = 0;
  private glitch = 0;
  private armorGhost = 1;
  private ghostHold = 0;
  private armorFlash = 0;
  /** The reticle's kick on a repulsor shot (0–1). */
  private recoil = 0;
  /** Thrust as the bar shows it (eased). */
  private thrustShown = 0;
  private readonly splashes: Splash[] = [];
  private banner: Banner | null = null;
  /** R&D awards as they come in (points, what for, when), each shown a moment under the sight. */
  private readonly awards: Array<{ pts: number; why: string; t: number }> = [];
  /** When each contact was first seen on screen and first locked (HUD time), for the snap-in. */
  private readonly seenAt = new Map<number, number>();
  private readonly lockedAt = new Map<number, number>();
  private killsShown = 0;
  private killPop = 0;
  /** Kill confirm on the sight (0–1), the current streak and when it last grew. */
  private killConfirm = 0;
  private streak = 0;
  private lastKillT = -99;
  private readonly impacts: Impact[] = [];
  /** The suit's position, live (set by the app): a hit's direction is read off it when it lands. */
  suitPos: THREE.Vector3 | null = null;
  /** The sun on screen (CSS px) and how much of it is getting through (0–1), set by the app: text near it gets a heavier halo, and the helmet's visor tints toward it. */
  readonly sun = new THREE.Vector3(0, 0, 0);
  /** Missile threat: the ring's radius as last drawn (CSS px), and a flash as a seeker is decoyed off. */
  private threatR = 0;
  private decoyFlash = 0;
  /** Lead pips: which contacts' pips are on the sight, and since when. */
  private readonly zoneAt = new Map<number, number>();
  private zoneCueT = -99;
  /** The wave being fought, and the last one cleared (shown as a summary). */
  private tally: Tally | null = null;
  private summary: Tally | null = null;
  private tallyTickT = 0;
  private tallyDone = false;
  /** Sound for HUD-only moments (wired by the app). */
  onCue: ((cue: HudCue, n?: number) => void) | null = null;
  /** Weapon rows: the state each last showed, and when it changed (for the flash). */
  private readonly rowState = new Map<string, { key: string; t: number }>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none', zIndex: '2' });
    this.glow = true;
    this.resize(window.innerWidth, window.innerHeight);
  }

  /** The holographic bloom (off on the low preset). */
  set glow(on: boolean) {
    this.canvas.style.filter = on ? GLOW : 'none';
  }

  /** The sim's events the HUD answers (wired by the app). */
  event(e: SimEvent): void {
    switch (e.kind) {
      case 'jarvis':
        if (e.text) this.say(e.text);
        break;
      case 'kill':
        this.kill(e.at, e.text);
        break;
      case 'repulsorHit':
        if (e.value) {
          this.hit();
          if (this.tally) this.tally.hits++;
        }
        break;
      case 'repulsorFire':
        this.recoil = 1;
        if (this.tally) this.tally.shots++;
        break;
      case 'hitArmor': {
        const k = THREE.MathUtils.clamp((e.value ?? 5) / 12, 0.15, 1);
        this.shake = Math.min(1, this.shake + k);
        this.glitch = Math.min(1, this.glitch + k);
        this.armorFlash = 1;
        this.ghostHold = 0.5;
        if (this.tally) this.tally.lost += e.value ?? 0;
        if (e.at && this.suitPos) {
          const dir = e.at.clone().sub(this.suitPos);
          if (dir.lengthSq() > 1e-4) {
            this.impacts.push({ dir: dir.normalize(), t: this.time, heavy: (e.value ?? 0) >= 12 });
            if (this.impacts.length > 8) this.impacts.shift();
          }
        }
        break;
      }
      case 'waveStart':
        this.showBanner(`WAVE ${e.value ?? ''}`, 'HOSTILES INBOUND', RED);
        this.tally = { wave: e.value ?? 0, t0: this.time, kills: 0, shots: 0, hits: 0, lost: 0 };
        this.summary = null;
        break;
      case 'waveClear':
        this.showBanner('SKY CLEAR', `WAVE ${e.value ?? ''} COMPLETE`, CYAN);
        if (this.tally) {
          this.summary = { ...this.tally, t: this.time, dur: this.time - this.tally.t0 };
          this.tallyDone = false;
          this.tallyTickT = 0;
        }
        this.tally = null;
        break;
      case 'sonicBoom':
        this.showBanner('MACH 1', 'THROUGH THE BARRIER', WHITE, true);
        break;
      case 'missileDecoyed':
        this.showBanner('DECOYED', 'MISSILE OFF THE SCENT', CYAN, true);
        this.decoyFlash = 1;
        break;
      case 'rdAward': {
        const pts = e.value ?? 0;
        this.awards.push({ pts, why: e.text ?? '', t: this.time });
        if (this.awards.length > 4) this.awards.shift();
        // (the clear's own payout lands just after the clear: it joins that tally)
        const sm = this.tally ?? (this.summary && this.time - (this.summary.t ?? 0) < 0.5 ? this.summary : null);
        if (sm) sm.rd = (sm.rd ?? 0) + pts;
        break;
      }
      case 'redeploy':
        this.bootT = 0;
        this.tally = null;
        this.summary = null;
        break;
    }
  }

  private showBanner(title: string, sub: string, color: string, minor = false): void {
    // (a minor one doesn't cut a wave's short)
    if (minor && this.banner && !this.banner.minor && this.time - this.banner.t < 2.2) return;
    this.banner = { title, sub, color, t: this.time, minor };
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

  kill(at?: THREE.Vector3, kind?: string): void {
    this.killFlash = 1;
    this.killConfirm = 1;
    this.streak = this.time - this.lastKillT < STREAK_GAP ? this.streak + 1 : 1;
    this.lastKillT = this.time;
    if (this.streak >= 2) this.onCue?.('streak', this.streak);
    if (this.streak >= 3) this.showBanner(this.streak >= STREAK_NAME.length ? `SPLASH ×${this.streak}` : STREAK_NAME[this.streak - 1], 'MULTI-KILL', AMBER, true);
    if (at) this.splashes.push({ at: at.clone(), kind: (kind ?? '').toUpperCase(), t: this.time, streak: this.streak });
    if (this.splashes.length > 6) this.splashes.shift();
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
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.glitch = Math.max(0, this.glitch - dt * 3);
    this.armorFlash = Math.max(0, this.armorFlash - dt * 3);
    this.killPop = Math.max(0, this.killPop - dt * 3);
    this.killConfirm = Math.max(0, this.killConfirm - dt * 2.2);
    this.decoyFlash = Math.max(0, this.decoyFlash - dt * 2);
    if (combat.kills !== this.killsShown) {
      if (combat.kills > this.killsShown) {
        this.killPop = 1;
        if (this.tally) this.tally.kills += combat.kills - this.killsShown;
      }
      this.killsShown = combat.kills;
    }
    // Boot: from nothing, or the reactor coming back from a reboot
    const shown = this.alpha > 0.05;
    if (shown && !this.wasShown) this.bootT = 0;
    this.wasShown = shown;
    const down = combat.down > 0;
    if (this.wasDown && !down && !combat.lost) this.bootT = 0;
    this.wasDown = down;
    this.bootT += dt;
    // What the armour lost hangs on the arc a beat, then drains
    if (combat.armor >= this.armorGhost) this.armorGhost = combat.armor;
    else if ((this.ghostHold -= dt) <= 0) this.armorGhost = Math.max(combat.armor, this.armorGhost - dt * 0.4);
    this.thrustShown += (m.throttle - this.thrustShown) * (1 - Math.exp(-dt / 0.08));
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (this.alpha <= 0.01) return;
    // Rebooting it flickers; lost, it fades back behind the card
    g.globalAlpha = this.alpha * (combat.lost ? Math.max(0.15, 0.5 - combat.lostT * 0.15) : combat.down > 0 ? 0.25 + 0.25 * Math.sin(this.time * 20) : 1);
    g.lineCap = 'round';
    // A dark halo keeps the linework legible against a bright sky
    g.shadowColor = 'rgba(0, 10, 20, 0.85)';
    g.shadowBlur = 5;

    const cx = this.w / 2;
    const cy = this.h / 2;
    const s = Math.max(this.minScale, Math.min(this.w, this.h) / 900);

    this.updateSway(dt, cam, m, helmet, s);
    // A hit knocks the whole projection about
    g.save();
    const shake = this.shake * this.shake * 10 * s;
    if (shake > 0.05) g.translate((flick(this.time, 1) - 0.5) * 2 * shake, (flick(this.time, 2) - 0.5) * 2 * shake);
    if (helmet) this.drawVisorTint(g);
    this.drawStreaks(g, cam, m, helmet, s);
    this.panel('ladder', 0, 0, () => this.drawLadder(g, cam, cx, cy, s));
    this.panel('reticle', 0, 0, () => this.drawReticle(g, cx, cy, s, combat));
    this.drawMarkers(g, cam, m, s);
    this.drawPadMarker(g, cam, m, s);
    this.drawTargets(g, cam, m, combat, s);
    this.drawSplashes(g, cam, s);
    this.drawWarnings(g, cam, m, combat, s);
    this.drawImpacts(g, cam, cx, cy, s);
    // Head-mounted panels (they ride the sway in the helmet)
    g.save();
    if (helmet) {
      g.translate(this.sway.x, this.sway.y);
      this.panel('visor', 0, 0, () => this.drawVisor(g, s));
      this.panel('suit', -30 * s, 0, () => this.drawSuitDiagram(g, m, combat, s));
    }
    this.panel('tapes', 0, 14 * s, () => this.drawTapes(g, m, ground, s));
    this.panel('heading', 0, -24 * s, () => this.drawHeading(g, cam, s));
    this.panel('status', -40 * s, 0, () => this.drawStatus(g, m, combat, s));
    this.panel('weapons', 40 * s, 0, () => this.drawWeapons(g, combat, s));
    this.panel('radar', 30 * s, -30 * s, () => this.drawRadar(g, cam, m, combat, s));
    this.drawScope(g, dt, cam, m, s);
    this.drawAutoLand(g, dt, m, s);
    this.drawTakeoff(g, dt, s);
    this.drawRefitHint(g, dt, s);
    this.drawLines(g, s);
    this.drawBanner(g, s);
    this.drawSummary(g, dt, s);
    this.drawAwards(g, s);
    g.restore();
    if (combat.lost) this.drawLost(g, combat, cx, cy, s);
    g.restore();
    g.globalAlpha = 1;
    this.drawGlitch(g, s);
  }

  /** Runs a panel's drawing as it boots: flickering on and settling in from (dx, dy). */
  private panel(key: keyof typeof BOOT, dx: number, dy: number, fn: () => void): void {
    const r = THREE.MathUtils.clamp((this.bootT - BOOT[key]) / BOOT_RISE, 0, 1);
    if (r <= 0) return;
    if (r >= 1) return fn();
    const g = this.ctx;
    g.save();
    g.globalAlpha *= r * (flick(this.time, BOOT[key] * 10) > 0.3 ? 1 : 0.2);
    const e = (1 - r) ** 3;
    g.translate(dx * e, dy * e);
    fn();
    g.restore();
  }

  /** A hit tears a few bands of the projection sideways. */
  private drawGlitch(g: CanvasRenderingContext2D, s: number): void {
    if (this.glitch < 0.03) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.shadowBlur = 0;
    g.globalAlpha = 0.7;
    for (let i = 0; i < 4; i++) {
      const r = flick(this.time, i * 3 + 1);
      if (r > this.glitch * 1.2) continue;
      const bh = Math.round((4 + flick(this.time, i * 3 + 2) * 26) * s * this.dpr);
      const y = Math.round(flick(this.time, i * 3 + 3) * (H - bh));
      const off = (flick(this.time, i * 3 + 4) - 0.5) * 50 * this.glitch * s * this.dpr;
      g.drawImage(this.canvas, 0, y, W, bh, off, y, W, bh);
    }
    g.restore();
  }

  /**
   * Where the hits came from: a red arc round the sight for each, turned
   * with the view (up is ahead, down is behind), fading out over a second.
   */
  private drawImpacts(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, cx: number, cy: number, s: number): void {
    const inv = this._q.copy(cam.quaternion).invert();
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i];
      const age = this.time - im.t;
      if (age > 1.3) {
        this.impacts.splice(i, 1);
        continue;
      }
      const d = this._v.copy(im.dir).applyQuaternion(inv);
      // Screen angle: 0 = up (ahead), clockwise
      const a = Math.atan2(d.x, -d.z) - Math.PI / 2;
      const r = (64 + (im.heavy ? 8 : 0)) * s + age * 10 * s;
      const half = im.heavy ? 0.45 : 0.34;
      g.save();
      g.globalAlpha *= (1 - age / 1.3) ** 1.5;
      g.strokeStyle = age < 0.06 ? WHITE : RED;
      g.lineWidth = (im.heavy ? 6 : 4) * s;
      g.beginPath();
      g.arc(cx, cy, r, a - half, a + half);
      g.stroke();
      // A chevron at its middle, pointing out to the source
      g.lineWidth = 1.6;
      const px = cx + Math.cos(a) * (r + 8 * s);
      const py = cy + Math.sin(a) * (r + 8 * s);
      g.translate(px, py);
      g.rotate(a);
      g.beginPath();
      g.moveTo(-3 * s, -5 * s);
      g.lineTo(3 * s, 0);
      g.lineTo(-3 * s, 5 * s);
      g.stroke();
      g.restore();
    }
  }

  /** SPLASH where each kill fell: a burst ring, the stamp rising off it. */
  private drawSplashes(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, s: number): void {
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const sp = this.splashes[i];
      const age = this.time - sp.t;
      if (age > 1.8) {
        this.splashes.splice(i, 1);
        continue;
      }
      const p = this.project(sp.at, cam);
      if (!p) continue;
      const x = THREE.MathUtils.clamp(p.x, 60 * s, this.w - 60 * s);
      const y = THREE.MathUtils.clamp(p.y, 60 * s, this.h - 60 * s);
      g.save();
      // The burst: a ring thrown out and four shards
      if (age < 0.5) {
        const u = age / 0.5;
        const r = (10 + 46 * Math.sqrt(u)) * s;
        g.save();
        g.globalAlpha *= 1 - u;
        g.strokeStyle = WHITE;
        g.lineWidth = 2 * (1 - u) + 0.6;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.stroke();
        for (let k = 0; k < 4; k++) {
          const a = Math.PI / 4 + (k * Math.PI) / 2;
          g.beginPath();
          g.moveTo(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55);
          g.lineTo(x + Math.cos(a) * r * 1.2, y + Math.sin(a) * r * 1.2);
          g.stroke();
        }
        g.restore();
      }
      const fade = age < 1.2 ? 1 : 1 - (age - 1.2) / 0.6;
      const pop = 1 + 0.5 * Math.exp(-age * 14);
      const rise = 18 * s + age * 14 * s;
      g.globalAlpha *= Math.max(0, fade);
      g.translate(x, y - rise);
      g.scale(pop, pop);
      const name = STREAK_NAME[Math.min(sp.streak, STREAK_NAME.length) - 1];
      this.text(g, name, 0, 0, (13 + Math.min(4, sp.streak - 1) * 1.5) * s, sp.streak > 1 ? AMBER : WHITE, 'center', JARVIS);
      if (sp.kind) this.text(g, sp.kind === 'SHIP' ? 'WARSHIP  DOWN' : `${sp.kind}  DOWN`, 0, 14 * s, 8 * s, CYAN, 'center', JARVIS);
      g.restore();
    }
  }

  /**
   * After a clear, the wave's tally under the banner: kills, repulsor
   * accuracy, armour lost and time, each row sliding in and counting up
   * (ticking as it goes), then holding a few seconds.
   */
  private drawSummary(g: CanvasRenderingContext2D, dt: number, s: number): void {
    const sm = this.summary;
    if (!sm || sm.t === undefined) return;
    const age = this.time - sm.t - 1;
    const LIFE = 7;
    if (age > LIFE) {
      this.summary = null;
      return;
    }
    if (age < 0) return;
    const COUNT = 1.2;
    const k = Math.min(1, age / COUNT);
    const ease = 1 - (1 - k) ** 3;
    if (k < 1) {
      this.tallyTickT -= dt;
      if (this.tallyTickT <= 0) {
        this.tallyTickT = 0.07;
        this.onCue?.('tally');
      }
    } else if (!this.tallyDone) {
      this.tallyDone = true;
      this.onCue?.('tallyDone');
    }
    const acc = sm.shots > 0 ? sm.hits / sm.shots : -1;
    const dur = sm.dur ?? 0;
    const shownDur = dur * ease;
    const rows: [string, string, string][] = [
      ['KILLS', `${Math.round(sm.kills * ease)}`, WHITE],
      ['ACCURACY', acc < 0 ? '—' : `${Math.round(acc * 100 * ease)}%`, acc >= 0.5 ? WHITE : CYAN],
      ['ARMOUR LOST', `${Math.round(sm.lost * ease)}`, sm.lost > 40 ? AMBER : CYAN],
      ['TIME', `${Math.floor(shownDur / 60)}:${`${Math.floor(shownDur % 60)}`.padStart(2, '0')}`, CYAN],
    ];
    if (sm.rd) rows.push(['R&D EARNED', `+${Math.round(sm.rd * ease)}`, AMBER]);
    const W = 280 * s;
    const H = (14 + 30 * Math.ceil(rows.length / 2)) * s;
    const x0 = this.w / 2 - W / 2;
    const y0 = this.h * 0.27 + 46 * s;
    const out = age > LIFE - 0.5 ? (age - (LIFE - 0.5)) / 0.5 : 0;
    g.save();
    g.globalAlpha *= (1 - out) * Math.min(1, age / 0.2);
    this.glass(g, x0, y0, W, H, s);
    for (let i = 0; i < rows.length; i++) {
      const [label, value, color] = rows[i];
      const r = THREE.MathUtils.clamp((age - i * 0.1) / 0.25, 0, 1);
      if (r <= 0) continue;
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = x0 + 16 * s + col * (W / 2);
      const y = y0 + 22 * s + row * 30 * s;
      g.save();
      g.globalAlpha *= r;
      g.translate((1 - r) ** 2 * -16 * s, 0);
      this.text(g, label, x, y - 7 * s, 7.5 * s, CYAN_LABEL, 'left', JARVIS);
      this.text(g, value, x, y + 8 * s, 14 * s, color, 'left');
      g.restore();
    }
    g.restore();
  }

  /** R&D awards, stacked under the sight: each rises in, holds, and fades. */
  private drawAwards(g: CanvasRenderingContext2D, s: number): void {
    const LIFE = 2.2;
    while (this.awards.length && this.time - this.awards[0].t > LIFE) this.awards.shift();
    const x = this.w / 2;
    let y = this.h * 0.64;
    for (let i = this.awards.length - 1; i >= 0; i--) {
      const a = this.awards[i];
      const age = this.time - a.t;
      const k = Math.min(1, age / 0.2);
      const out = age > LIFE - 0.5 ? (age - (LIFE - 0.5)) / 0.5 : 0;
      g.save();
      g.globalAlpha *= k * (1 - out);
      this.text(g, `+${a.pts} R&D`, x - 6 * s, y + (1 - k) * 8 * s, 11 * s, AMBER, 'right');
      this.text(g, a.why, x + 6 * s, y + (1 - k) * 8 * s, 7.5 * s, CYAN_LABEL, 'left', JARVIS);
      g.restore();
      y += 16 * s;
    }
  }

  /** A banner across the upper third: rules drawn out from the middle, the title tracking in. */
  private drawBanner(g: CanvasRenderingContext2D, s: number): void {
    const b = this.banner;
    if (!b) return;
    const life = b.minor ? 1.6 : 3;
    const age = this.time - b.t;
    if (age > life) {
      this.banner = null;
      return;
    }
    const cx = this.w / 2;
    const cy = this.h * (b.minor ? 0.24 : 0.27);
    const open = 1 - (1 - Math.min(1, age / 0.35)) ** 3;
    const out = age > life - 0.4 ? (age - (life - 0.4)) / 0.4 : 0;
    const size = (b.minor ? 14 : 24) * s;
    const half = (b.minor ? 110 : 190) * s;
    g.save();
    g.globalAlpha *= 1 - out;
    // Rules, out from the centre (they close back in on the way out)
    const reach = half * open * (1 - out * 0.6);
    g.strokeStyle = b.color;
    g.lineWidth = 1.2;
    for (const dy of [-size * 0.95, size * 1.25]) {
      g.beginPath();
      g.moveTo(cx - reach, cy + dy);
      g.lineTo(cx + reach, cy + dy);
      g.stroke();
    }
    // End caps
    g.fillStyle = b.color;
    for (const sx of [-1, 1]) {
      g.fillRect(cx + sx * reach - 1.5 * s, cy - size * 0.95 - 3 * s, 3 * s, 6 * s);
    }
    // The title tracks in, flickering on
    if (age > 0.12) {
      const t = Math.min(1, (age - 0.12) / 0.4);
      if (t > 0.6 || flick(this.time, 9) > 0.35) {
        g.fillStyle = 'rgba(2, 14, 24, 0.4)';
        g.fillRect(cx - reach, cy - size * 0.95, reach * 2, size * 2.2);
        // (the spacing trails the last letter too: shift by half of it to stay centred)
        const track = (0.35 + (1 - t) * 0.6) * size * 0.3;
        g.letterSpacing = `${track}px`;
        this.text(g, b.title, cx + track / 2, cy + size * 0.05, size, b.minor ? WHITE : b.color, 'center', JARVIS);
        g.letterSpacing = `${size * 0.12}px`;
        this.text(g, b.sub, cx + size * 0.06, cy + size * 0.85, size * 0.34, CYAN, 'center', JARVIS);
        g.letterSpacing = '0px';
      }
    }
    g.restore();
  }

  /** The suit is lost: the run's tally, then the redeploy prompt. */
  private drawLost(g: CanvasRenderingContext2D, c: Combat, cx: number, cy: number, s: number): void {
    g.save();
    g.globalAlpha = this.alpha * Math.min(1, c.lostT / 0.6);
    this.text(g, 'SUIT LOST', cx, cy - 70 * s, 26 * s, RED, 'center', JARVIS);
    this.text(g, `WAVE ${Math.max(1, c.wave + 1)}  ·  KILLS ${c.kills}`, cx, cy - 38 * s, 13 * s, WHITE, 'center');
    if (c.redeployReady) {
      g.globalAlpha *= 0.55 + 0.45 * Math.sin(this.time * 3);
      this.text(g, `${this.waveKey === 'N' ? 'R / N' : this.waveKey} — REDEPLOY`, cx, cy + 46 * s, 11 * s, AMBER, 'center', JARVIS);
    }
    g.restore();
  }

  private text(g: CanvasRenderingContext2D, str: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', font = MONO): void {
    g.font = `${font === JARVIS ? 400 : 500} ${size}px ${font}`;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    // Into the sun's glare: a heavier halo, doubled up when it's strong
    const gl = this.glareAt(x, y);
    if (gl < 0.05) {
      g.fillText(str, x, y);
      return;
    }
    const color0 = g.shadowColor;
    const blur0 = g.shadowBlur;
    g.shadowColor = 'rgba(0, 8, 16, 0.95)';
    g.shadowBlur = 5 + 7 * gl;
    g.fillText(str, x, y);
    if (gl > 0.35) g.fillText(str, x, y);
    g.shadowColor = color0;
    g.shadowBlur = blur0;
  }

  /** How hard the sun glares at a point on screen (0–1). */
  private glareAt(x: number, y: number): number {
    if (this.sun.z < 0.02) return 0;
    const t = this.ctx.getTransform();
    // (in screen space: the point may be drawn under a translate)
    const px = (t.a * x + t.c * y + t.e) / this.dpr;
    const py = (t.b * x + t.d * y + t.f) / this.dpr;
    const R = 0.42 * Math.max(this.w, this.h);
    const k = Math.max(0, 1 - Math.hypot(px - this.sun.x, py - this.sun.y) / R);
    return Math.min(1, this.sun.z) * k * k;
  }

  /** The helmet's visor polarising toward the sun: a soft dark bloom where it sits. */
  private drawVisorTint(g: CanvasRenderingContext2D): void {
    const vis = Math.min(1, this.sun.z);
    if (vis < 0.02) return;
    const R = 0.42 * Math.max(this.w, this.h);
    const grad = g.createRadialGradient(this.sun.x, this.sun.y, 0, this.sun.x, this.sun.y, R);
    grad.addColorStop(0, `rgba(4, 14, 24, ${0.34 * vis})`);
    grad.addColorStop(0.5, `rgba(4, 14, 24, ${0.14 * vis})`);
    grad.addColorStop(1, 'rgba(4, 14, 24, 0)');
    g.save();
    g.shadowBlur = 0;
    g.fillStyle = grad;
    g.fillRect(0, 0, this.w, this.h);
    g.restore();
  }

  /**
   * Speed: faint streaks running out from where the suit is headed, coming
   * in past Mach 0.75 and full by Mach 1.2.
   */
  private drawStreaks(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, m: FlightModel, helmet: boolean, s: number): void {
    if (m.grounded || m.speed < 4) return;
    const k = THREE.MathUtils.smoothstep(m.mach, 0.75, 1.2) * (helmet ? 1 : 0.75);
    if (k < 0.01) return;
    const fp = this.project(this._v.copy(m.pos).addScaledVector(m.vel, 200 / m.speed), cam);
    const ox = fp ? THREE.MathUtils.clamp(fp.x, this.w * 0.2, this.w * 0.8) : this.w / 2;
    const oy = fp ? THREE.MathUtils.clamp(fp.y, this.h * 0.2, this.h * 0.8) : this.h / 2;
    const diag = Math.hypot(this.w, this.h);
    const pace = 0.5 + 1.2 * k;
    g.save();
    g.shadowBlur = 0;
    g.lineWidth = 1;
    for (const st of STREAKS) {
      const u = (st.p + this.time * pace * st.v) % 1;
      const r = diag * (0.3 + 0.38 * u);
      const len = (24 + 110 * u) * s * k;
      const a = 0.3 * k * Math.sin(Math.PI * u);
      const c = Math.cos(st.a);
      const sn = Math.sin(st.a);
      g.strokeStyle = `rgba(225, 248, 255, ${a})`;
      g.beginPath();
      g.moveTo(ox + c * r, oy + sn * r);
      g.lineTo(ox + c * (r + len), oy + sn * (r + len));
      g.stroke();
    }
    g.restore();
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
    this.text(g, 'MK III  ·  HUD ONLINE', mx + 4 * s, my + k + 10 * s, 7.5 * s, CYAN_DIM, 'left', JARVIS);
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

  private drawReticle(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: Combat): void {
    g.strokeStyle = CYAN;
    g.lineWidth = 1.2;
    const r = 15 * s;
    // A shot kicks the ticks out
    const kick = this.recoil * this.recoil * 6 * s;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r + 3 * s + kick), cy + Math.sin(a) * (r + 3 * s + kick));
      g.lineTo(cx + Math.cos(a) * (r + 10 * s + kick), cy + Math.sin(a) * (r + 10 * s + kick));
      g.stroke();
    }
    // An outer ring of arcs turning slowly, faster while the repulsors cycle
    const turn = this.time * (c.weapons.repulsorBusy ? 2.4 : 0.35);
    const ro = r + 17 * s + kick * 0.6;
    g.strokeStyle = CYAN_DIM;
    for (let i = 0; i < 3; i++) {
      const a = turn + (i * Math.PI * 2) / 3;
      g.beginPath();
      g.arc(cx, cy, ro, a, a + 0.55);
      g.stroke();
    }
    g.fillStyle = WHITE;
    g.fillRect(cx - 1, cy - 1, 2, 2);
    // A kill: a bold X slams onto the sight and lingers
    if (this.killConfirm > 0) {
      const t = 1 - this.killConfirm;
      const k = (11 + 10 * (1 - Math.min(1, t / 0.12)) ** 2) * s;
      g.save();
      g.globalAlpha *= Math.min(1, this.killConfirm * 2);
      g.strokeStyle = t < 0.08 ? WHITE : RED;
      g.lineWidth = 3;
      for (const [dx, dy] of [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]) {
        g.beginPath();
        g.moveTo(cx + dx * k * 0.55, cy + dy * k * 0.55);
        g.lineTo(cx + dx * k * 1.5, cy + dy * k * 1.5);
        g.stroke();
      }
      g.restore();
    }
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
    // Auto-land over the mark: zoom in after the offset, down to centimetres
    // (eased in log, so each halving takes as long)
    const off = Math.hypot(dx, dz);
    const trimming = this.autoLand === 'active' && pad !== null && !m.grounded;
    const spanGoal = trimming ? THREE.MathUtils.clamp(off * 3, SCOPE_FINE_M, SCOPE_M) : SCOPE_M;
    this.scopeSpan = Math.exp(THREE.MathUtils.lerp(Math.log(this.scopeSpan), Math.log(spanGoal), 1 - Math.exp(-dt / 0.3)));
    const lock = trimming ? m.landLock : 0;
    this.lockT = lock >= 1 ? this.lockT + dt : 0;
    if (this.scopeAlpha < 0.01 || !pad) return;
    const cx = this.w / 2;
    const cy = this.h / 2 + 112 * s;
    const R = 38 * s;
    const px = R / this.scopeSpan;
    const fine = 1 - THREE.MathUtils.smoothstep(this.scopeSpan, 0.6, 2);
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
    // Clear the ladder out from behind the scope and its readouts, so the
    // rung that runs through it doesn't read as one of its lines
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.globalAlpha = 0.9 * this.scopeAlpha;
    g.shadowBlur = 0;
    g.beginPath();
    g.arc(cx, cy, R + 6 * s, 0, Math.PI * 2);
    g.roundRect(cx - R - 58 * s, cy - 8 * s, 2 * (R + 58 * s), 16 * s, 8 * s);
    g.fill();
    g.restore();
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
    // (zoomed in, the deck's marks run off past the rim)
    g.save();
    g.beginPath();
    g.arc(cx, cy, R + 3 * s, 0, Math.PI * 2);
    g.clip();
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
    // Zoomed in: a centimetre grid, the cross through the centre, and the
    // ring auto-land has to settle inside, filling as it holds there
    if (fine > 0.01) {
      g.globalAlpha = this.alpha * this.scopeAlpha * fine;
      g.strokeStyle = CYAN_FAINT;
      g.lineWidth = 1;
      const step = this.scopeSpan > 0.4 ? 0.1 : 0.02;
      for (let k = 1; k * step < this.scopeSpan * 1.1; k++) {
        g.beginPath();
        g.arc(cx, cy, k * step * px, 0, Math.PI * 2);
        g.stroke();
      }
      g.strokeStyle = CYAN_DIM;
      g.beginPath();
      g.moveTo(cx - R, cy);
      g.lineTo(cx + R, cy);
      g.moveTo(cx, cy - R);
      g.lineTo(cx, cy + R);
      g.stroke();
      const lr = Math.max(2.5 * s, AUTOLAND_LOCK_R * px);
      g.strokeStyle = lock >= 1 ? WHITE : CYAN;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(cx, cy, lr, 0, Math.PI * 2);
      g.stroke();
      if (lock > 0) {
        g.strokeStyle = WHITE;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cx, cy, lr + 3 * s, -Math.PI / 2, -Math.PI / 2 + lock * Math.PI * 2);
        g.stroke();
      }
      // Locked on: brackets snap in round the centre, and a ring rolls out
      if (lock >= 1) {
        const t = Math.min(1, this.lockT / 0.25);
        const b = lr + 4 * s + (1 - t) * (1 - t) * 14 * s;
        const k = 4 * s;
        g.strokeStyle = WHITE;
        g.lineWidth = 1.6;
        for (let i = 0; i < 4; i++) {
          const a = Math.PI / 4 + (i * Math.PI) / 2;
          const bx = cx + Math.cos(a) * b;
          const by = cy + Math.sin(a) * b;
          const sx = -Math.sign(Math.cos(a));
          const sy = -Math.sign(Math.sin(a));
          g.beginPath();
          g.moveTo(bx + sx * k, by);
          g.lineTo(bx, by);
          g.lineTo(bx, by + sy * k);
          g.stroke();
        }
        if (this.lockT < 0.6) {
          g.globalAlpha = this.alpha * this.scopeAlpha * (1 - this.lockT / 0.6);
          g.beginPath();
          g.arc(cx, cy, lr + (R - lr) * Math.sqrt(this.lockT / 0.6), 0, Math.PI * 2);
          g.stroke();
        }
      }
      g.globalAlpha = this.alpha * this.scopeAlpha;
    }
    g.restore();
    // The suit over the deck
    const col = off <= BULLSEYE_R ? WHITE : off <= CENTRED_R ? CYAN : AMBER;
    let [sx, sy] = toScope(dx, dz);
    const out = Math.hypot(sx - cx, sy - cy);
    if (out > R) {
      sx = cx + ((sx - cx) * R) / out;
      sy = cy + ((sy - cy) * R) / out;
    }
    // Centring line: dashes from the suit in to the bullseye, running
    // inwards while the hold has it
    const dot = 3.2 * s;
    const toC = Math.hypot(sx - cx, sy - cy);
    const inner = Math.min(BULLSEYE_R, Math.max(AUTOLAND_LOCK_R, this.scopeSpan * 0.1));
    if (off > inner && toC > dot + inner * px) {
      const ux = (cx - sx) / toC;
      const uy = (cy - sy) / toC;
      g.strokeStyle = held > 0.5 ? col : CYAN_DIM;
      g.lineWidth = 1.2;
      g.setLineDash([2.5 * s, 2.5 * s]);
      g.lineDashOffset = held > 0.5 ? -this.time * 18 * s : 0;
      g.beginPath();
      g.moveTo(sx + ux * (dot + 2 * s), sy + uy * (dot + 2 * s));
      g.lineTo(cx - ux * inner * px, cy - uy * inner * px);
      g.stroke();
      g.setLineDash([]);
      g.lineDashOffset = 0;
    }
    // Drift: where the suit will be in a beat and a half, kept inside the scope
    // (zoomed in, the trim arrow takes over: a drift of centimetres a second
    // would run off the rim)
    const [vx, vy] = toScope(dx + m.vel.x * DRIFT_LEAD, dz + m.vel.z * DRIFT_LEAD);
    let ex = vx - sx;
    let ey = vy - sy;
    const len = Math.hypot(ex, ey);
    if (len > dot + 2 * s && fine < 0.99) {
      // (cut where it leaves the disc: |s + t·e| = R)
      const ox = sx - cx;
      const oy = sy - cy;
      const a = ex * ex + ey * ey;
      const b = ox * ex + oy * ey;
      const c = ox * ox + oy * oy - R * R;
      const t = Math.min(1, (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a);
      ex *= t;
      ey *= t;
      const l = len * t;
      if (l > dot + 2 * s) {
        const ux = ex / l;
        const uy = ey / l;
        const tx = sx + ex;
        const ty = sy + ey;
        const k = Math.min(4 * s, l * 0.4);
        g.globalAlpha = this.alpha * this.scopeAlpha * (1 - fine);
        g.strokeStyle = col;
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(sx + ux * dot, sy + uy * dot);
        g.lineTo(tx, ty);
        g.moveTo(tx - ux * k - uy * k * 0.6, ty - uy * k + ux * k * 0.6);
        g.lineTo(tx, ty);
        g.lineTo(tx - ux * k + uy * k * 0.6, ty - uy * k - ux * k * 0.6);
        g.stroke();
        g.globalAlpha = this.alpha * this.scopeAlpha;
      }
    }
    // Trimming in: the push auto-land is nudging the suit with, off the dot
    if (fine > 0.01 && lock < 1) {
      const [qx, qy] = toScope(m.landPush.x, m.landPush.z);
      const tx = qx - cx;
      const ty = qy - cy;
      const tl = Math.hypot(tx, ty) / px;
      if (tl > 1e-3) {
        // (the push in m/s², drawn on a fixed scale and kept short)
        const l = Math.min(R * 0.45, 4 * s + tl * 6 * s);
        const ux = tx / (tl * px);
        const uy = ty / (tl * px);
        const ax = sx + ux * (dot + l);
        const ay = sy + uy * (dot + l);
        g.globalAlpha = this.alpha * this.scopeAlpha * fine;
        g.strokeStyle = WHITE;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sx + ux * (dot + 1.5 * s), sy + uy * (dot + 1.5 * s));
        g.lineTo(ax, ay);
        g.moveTo(ax - ux * 3 * s - uy * 2 * s, ay - uy * 3 * s + ux * 2 * s);
        g.lineTo(ax, ay);
        g.lineTo(ax - ux * 3 * s + uy * 2 * s, ay - uy * 3 * s - ux * 2 * s);
        g.stroke();
        g.globalAlpha = this.alpha * this.scopeAlpha;
      }
    }
    g.fillStyle = col;
    g.beginPath();
    g.arc(sx, sy, dot, 0, Math.PI * 2);
    g.fill();
    // Readouts: offset (to the millimetre close in), height over the deck, and the capture
    this.text(g, offText(off), cx - R - 10 * s, cy, 9 * s, col, 'right');
    this.text(g, `${Math.max(0, h).toFixed(h < 10 ? 1 : 0)} ▾`, cx + R + 10 * s, cy, 9 * s, CYAN, 'left');
    const label = lock >= 1 ? 'PAD · LOCKED' : trimming && fine > 0.5 ? 'PAD · HOLD · TRIM' : held > 0.5 ? 'PAD · HOLD' : 'PAD';
    this.text(g, label, cx, cy - R - 12 * s, 7 * s, held > 0.5 ? WHITE : CYAN_DIM, 'center', JARVIS);
    if (trimming && fine > 0.01) {
      // The trims still to make, across and along the view (the way to go, in mm)
      const fwd = -(dx * Math.sin(yaw) + dz * Math.cos(yaw));
      const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const mm = (v: number) => `${Math.min(999, Math.round(Math.abs(v) * 1000))}`.padStart(3, ' ');
      const trim = lock >= 1 ? 'ON CENTRE · SETTING DOWN' : `TRIM ${right < 0 ? '◂' : '▸'}${mm(right)}  ${fwd < 0 ? '▾' : '▴'}${mm(fwd)} mm`;
      g.globalAlpha = this.alpha * this.scopeAlpha * fine;
      this.text(g, trim, cx, cy + R + 13 * s, lock >= 1 ? 6.5 * s : 8 * s, lock >= 1 ? WHITE : CYAN, 'center', lock >= 1 ? JARVIS : MONO);
      g.globalAlpha = this.alpha * this.scopeAlpha;
    } else if (held < 0.5 && off < 16) this.text(g, 'HANDS OFF TO HOLD', cx, cy + R + 13 * s, 6 * s, CYAN_FAINT, 'center', JARVIS);
    g.globalAlpha = this.alpha;
  }

  /**
   * The auto-land prompt under the scope: a key cap and AUTO-LAND while
   * it's on offer (popping in when the pad comes in range), then, once
   * handed over, what it's doing and how to take the suit back.
   */
  private drawAutoLand(g: CanvasRenderingContext2D, dt: number, m: FlightModel, s: number): void {
    const state = this.autoLand;
    if (state) {
      if (state !== this.promptState || this.promptAlpha < 0.01) this.promptT = 0;
      this.promptState = state;
    }
    this.promptT += dt;
    this.promptAlpha += ((state ? 1 : 0) - this.promptAlpha) * (1 - Math.exp(-dt / (state ? 0.12 : 0.25)));
    if (this.promptAlpha < 0.01) return;
    const active = this.promptState === 'active';
    const pad = this.pad;
    const cx = this.w / 2;
    const cy = this.h / 2 + 192 * s;
    // Pops in with a little overshoot
    const pop = 1 + 0.18 * Math.exp(-this.promptT * 10) * Math.cos(this.promptT * 26);
    const padConnected = [...(navigator.getGamepads?.() ?? [])].some((p) => p && p.connected);
    const key = this.landKey === 'L' && padConnected ? 'L · D-PAD ▼' : this.landKey;
    const title = 'AUTO-LAND';
    const sub = active ? `${key}  TAKE CONTROL` : 'PAD IN RANGE';
    g.save();
    g.translate(cx, cy);
    g.scale(pop, pop);
    g.globalAlpha = this.alpha * this.promptAlpha;
    g.shadowBlur = 0;
    g.font = `500 ${10 * s}px ${MONO}`;
    const keyW = Math.max(18 * s, g.measureText(key).width + 12 * s);
    const W = active ? 196 * s : keyW + 132 * s;
    const H = 34 * s;
    const x0 = -W / 2;
    const y0 = -H / 2;
    const accent = active ? CYAN : AMBER;
    // Panel, with a breathing edge while it waits for the key
    const breathe = active ? 0.9 : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.promptT * 5));
    g.fillStyle = 'rgba(0, 16, 26, 0.55)';
    g.fillRect(x0, y0, W, H);
    g.strokeStyle = accent;
    g.globalAlpha = this.alpha * this.promptAlpha * breathe;
    g.lineWidth = 1.2;
    g.strokeRect(x0, y0, W, H);
    g.globalAlpha = this.alpha * this.promptAlpha;
    // Corner ticks
    const t = 5 * s;
    g.lineWidth = 2;
    for (const [x, y, dx, dy] of [
      [x0, y0, 1, 1],
      [x0 + W, y0, -1, 1],
      [x0, y0 + H, 1, -1],
      [x0 + W, y0 + H, -1, -1],
    ]) {
      g.beginPath();
      g.moveTo(x, y + dy * t);
      g.lineTo(x, y);
      g.lineTo(x + dx * t, y);
      g.stroke();
    }
    if (active) {
      // Working: a scanning bar along the foot, and the distance still to go
      const u = (this.promptT * 0.8) % 1;
      g.fillStyle = CYAN;
      g.fillRect(x0 + u * (W - 30 * s), y0 + H - 2 * s, 30 * s, 2 * s);
      const d = pad ? Math.hypot(m.pos.x - pad.x, m.pos.z - pad.z) : 0;
      const h = pad ? Math.max(0, m.pos.y - m.hipHeight() - pad.y) : 0;
      this.text(g, title, x0 + 10 * s, -5 * s, 9 * s, WHITE, 'left', JARVIS);
      this.text(g, `${offText(d)}  ▾${h.toFixed(h < 10 ? 1 : 0)}`, x0 + W - 10 * s, -5 * s, 9 * s, CYAN, 'right');
      this.text(g, sub, x0 + 10 * s, 8 * s, 6.5 * s, CYAN_DIM, 'left', JARVIS);
    } else {
      // The key cap, then the offer
      const kx = x0 + 9 * s;
      g.fillStyle = 'rgba(255, 184, 77, 0.16)';
      g.fillRect(kx, -10 * s, keyW, 20 * s);
      g.strokeStyle = AMBER;
      g.lineWidth = 1.2;
      g.strokeRect(kx, -10 * s, keyW, 20 * s);
      this.text(g, key, kx + keyW / 2, 0.5 * s, 10 * s, WHITE, 'center');
      this.text(g, title, kx + keyW + 10 * s, -5 * s, 10 * s, WHITE, 'left', JARVIS);
      this.text(g, sub, kx + keyW + 10 * s, 8 * s, 6.5 * s, AMBER, 'left', JARVIS);
    }
    g.restore();
    g.globalAlpha = this.alpha;
  }

  /** TEMP: a key cap and TAKE OFF under the scope while the suit stands on the ground. */
  private drawTakeoff(g: CanvasRenderingContext2D, dt: number, s: number): void {
    this.takeoffAlpha += ((this.takeoff ? 1 : 0) - this.takeoffAlpha) * (1 - Math.exp(-dt / (this.takeoff ? 0.12 : 0.25)));
    if (this.takeoffAlpha < 0.01) return;
    const padConnected = [...(navigator.getGamepads?.() ?? [])].some((p) => p && p.connected);
    const key = padConnected ? 'E · Ⓐ' : 'E';
    g.save();
    g.translate(this.w / 2, this.h / 2 + 192 * s);
    g.globalAlpha = this.alpha * this.takeoffAlpha;
    g.shadowBlur = 0;
    g.font = `500 ${10 * s}px ${MONO}`;
    const keyW = Math.max(18 * s, g.measureText(key).width + 12 * s);
    const W = keyW + 96 * s;
    const H = 34 * s;
    const x0 = -W / 2;
    g.fillStyle = 'rgba(0, 16, 26, 0.55)';
    g.fillRect(x0, -H / 2, W, H);
    g.strokeStyle = CYAN;
    g.globalAlpha = this.alpha * this.takeoffAlpha * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * 5)));
    g.lineWidth = 1.2;
    g.strokeRect(x0, -H / 2, W, H);
    g.globalAlpha = this.alpha * this.takeoffAlpha;
    const kx = x0 + 9 * s;
    g.fillStyle = 'rgba(126, 232, 255, 0.14)';
    g.fillRect(kx, -10 * s, keyW, 20 * s);
    g.strokeRect(kx, -10 * s, keyW, 20 * s);
    this.text(g, key, kx + keyW / 2, 0.5 * s, 10 * s, WHITE, 'center');
    this.text(g, 'TAKE OFF', kx + keyW + 10 * s, -5 * s, 10 * s, WHITE, 'left', JARVIS);
    this.text(g, 'HOLD TO CLIMB', kx + keyW + 10 * s, 8 * s, 6.5 * s, CYAN_DIM, 'left', JARVIS);
    g.restore();
    g.globalAlpha = this.alpha;
  }

  /** Under the take-off prompt: the key to the R&D refit and the points to spend. */
  private drawRefitHint(g: CanvasRenderingContext2D, dt: number, s: number): void {
    const on = !!this.refitHint;
    if (this.refitHint) this.refitText = this.refitHint;
    this.refitAlpha += ((on ? 1 : 0) - this.refitAlpha) * (1 - Math.exp(-dt / (on ? 0.2 : 0.25)));
    if (this.refitAlpha < 0.01) return;
    g.save();
    g.globalAlpha = this.alpha * this.refitAlpha;
    g.shadowBlur = 0;
    this.text(g, this.refitText, this.w / 2, this.h / 2 + 222 * s, 7.5 * s, AMBER, 'center', JARVIS);
    g.restore();
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
      // (fading out toward the ends of the tape)
      const fade = Math.max(0, 1 - (Math.abs(y - cy) / (H / 2)) ** 2);
      // (and kept clear of the readout box and its label)
      const clear = THREE.MathUtils.smoothstep(Math.abs(y - cy), 16 * s, 34 * s);
      g.strokeStyle = `rgba(126, 232, 255, ${0.5 * fade})`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + side * 10 * s, y);
      g.stroke();
      const half = y - (step / 2) * pxPer;
      g.beginPath();
      g.moveTo(x, half);
      g.lineTo(x + side * 5 * s, half);
      g.stroke();
      this.text(g, label(v), x + side * 16 * s, y, 10 * s, `rgba(126, 232, 255, ${0.6 * fade * clear})`, side > 0 ? 'left' : 'right');
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
    // Readout boxes, pointing in at their tape; their digits roll like a drum counter
    const box = (x: number, label: string, value: number, align: 1 | -1) => {
      const bw = 74 * s;
      const bh = 24 * s;
      const tip = 7 * s;
      const near = x + align * 3 * s;
      const far = near + align * bw;
      g.beginPath();
      g.moveTo(near, cy);
      g.lineTo(near + align * tip, cy - bh / 2);
      g.lineTo(far, cy - bh / 2);
      g.lineTo(far, cy + bh / 2);
      g.lineTo(near + align * tip, cy + bh / 2);
      g.closePath();
      g.fillStyle = 'rgba(2, 14, 24, 0.5)';
      g.fill();
      g.strokeStyle = CYAN;
      g.lineWidth = 1.2;
      g.stroke();
      const mid = (near + align * tip + far) / 2;
      this.drum(g, value, mid, cy, 15 * s, bh - 3 * s);
      this.text(g, label, mid, cy - 22 * s, 8 * s, CYAN_LABEL, 'center', JARVIS);
    };
    box(lx, 'AIRSPEED KT', spd, -1);
    box(rx, 'ALT MSL', m.pos.y, 1);
    const mach = m.mach;
    this.text(g, `M ${mach.toFixed(2)}`, lx - 42 * s, cy + 26 * s, 11 * s, mach > 0.98 ? AMBER : CYAN, 'center');
    this.text(g, `G ${m.gLoad.toFixed(1)}`, lx - 42 * s, cy + 42 * s, 11 * s, m.gLoad > 8 ? AMBER : CYAN_DIM, 'center');
    const ra = m.pos.y - m.hipHeight() - ground.surface(m.pos.x, m.pos.z);
    this.text(g, `R ${Math.max(0, Math.round(ra))}`, rx + 42 * s, cy + 26 * s, 11 * s, ra < 50 ? AMBER : CYAN, 'center');
    const vs = m.vel.y;
    this.text(g, `${vs >= 0 ? '▲' : '▼'} ${Math.abs(vs).toFixed(0)}`, rx + 42 * s, cy + 42 * s, 11 * s, CYAN_DIM, 'center');
  }

  /**
   * A number on a drum counter, centred on (x, y) and clipped to a window
   * `win` tall: the units tick over, and each higher digit turns over only
   * as everything below it rolls past 9.
   */
  private drum(g: CanvasRenderingContext2D, value: number, x: number, y: number, size: number, win: number): void {
    if (value < 0 || !Number.isFinite(value)) {
      this.text(g, `${Math.round(value)}`, x, y + size * 0.03, size, WHITE, 'center');
      return;
    }
    g.font = `500 ${size}px ${MONO}`;
    const dw = g.measureText('0').width;
    const n = Math.max(1, `${Math.floor(value)}`.length);
    const pitch = size * 1.15;
    g.save();
    g.beginPath();
    g.rect(x - (n * dw) / 2 - 2, y - win / 2, n * dw + 4, win);
    g.clip();
    for (let k = 0; k < n; k++) {
      const place = 10 ** k;
      const d = Math.floor(value / place) % 10;
      // How far this digit has turned toward the next: it holds still,
      // then flicks over in the last stretch (readable, but still a drum)
      const below = value % place;
      const turn = k === 0 ? value - Math.floor(value) : below > place - 1 ? below - (place - 1) : 0;
      const roll = THREE.MathUtils.smoothstep(turn, 0.85, 1);
      const dx = x + (n / 2 - k - 0.5) * dw;
      const dy = y + size * 0.03 + roll * pitch;
      this.text(g, `${d}`, dx, dy, size, WHITE, 'center');
      if (roll > 0.01) this.text(g, `${(d + 1) % 10}`, dx, dy - pitch, size, WHITE, 'center');
    }
    g.restore();
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
      // (fading out toward the ends)
      const fade = Math.max(0, 1 - (Math.abs(x - cx) / (W / 2)) ** 2);
      g.strokeStyle = `rgba(126, 232, 255, ${0.5 * fade})`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + (major ? 9 : 5) * s);
      g.stroke();
      if (d % 30 === 0) {
        const n = ((d % 360) + 360) % 360;
        const name = n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : `${n / 10}`.padStart(2, '0');
        this.text(g, name, x, y + 20 * s, 10 * s, `rgba(126, 232, 255, ${(n % 90 === 0 ? 0.95 : 0.55) * fade})`, 'center');
      }
    }
    g.restore();
    // The heading in a box, pointing down at the tape
    const bw = 40 * s;
    const bh = 17 * s;
    const by = y - 21 * s;
    g.beginPath();
    g.moveTo(cx - bw / 2, by - bh / 2);
    g.lineTo(cx + bw / 2, by - bh / 2);
    g.lineTo(cx + bw / 2, by + bh / 2);
    g.lineTo(cx + 5 * s, by + bh / 2);
    g.lineTo(cx, y - 1 * s);
    g.lineTo(cx - 5 * s, by + bh / 2);
    g.lineTo(cx - bw / 2, by + bh / 2);
    g.closePath();
    g.fillStyle = 'rgba(2, 14, 24, 0.5)';
    g.fill();
    g.strokeStyle = CYAN;
    g.lineWidth = 1.2;
    g.stroke();
    this.text(g, `${Math.round(hdg).toString().padStart(3, '0')}`, cx, by + 0.5 * s, 12 * s, WHITE, 'center');
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
    // Locks let go: they snap in again next time
    for (const id of this.lockedAt.keys()) if (!locked.has(id)) this.lockedAt.delete(id);
    for (const h of c.hostiles) {
      if (!h.alive) {
        this.seenAt.delete(h.id);
        this.zoneAt.delete(h.id);
        continue;
      }
      const dist = h.pos.distanceTo(cam.position);
      const p = this.project(h.pos, cam);
      const onScreen = p && p.x > 0 && p.x < this.w && p.y > 0 && p.y < this.h;
      const hostileColor = h.kind === 'drone' ? RED : AMBER;
      if (!onScreen) {
        this.seenAt.delete(h.id);
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
      // A new contact: the brackets close in on it from wide, flickering
      let seen = this.seenAt.get(h.id);
      if (seen === undefined) this.seenAt.set(h.id, (seen = this.time));
      const acq = Math.min(1, (this.time - seen) / 0.3);
      const bs = size * (1 + 1.6 * (1 - acq) ** 2);
      g.save();
      if (acq < 1) g.globalAlpha *= flick(this.time, h.id) > 0.3 ? 1 : 0.3;
      g.strokeStyle = hostileColor;
      g.lineWidth = 1.3;
      // Corner brackets
      const k = bs * 0.4;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        g.beginPath();
        g.moveTo(x + sx * bs, y + sy * (bs - k));
        g.lineTo(x + sx * bs, y + sy * bs);
        g.lineTo(x + sx * (bs - k), y + sy * bs);
        g.stroke();
      }
      g.restore();
      const label = `${h.label ?? (h.kind === 'sam' ? 'SAM' : 'DRN')} ${dist > 1000 ? (dist / 1000).toFixed(1) + 'k' : Math.round(dist)}`;
      if (acq >= 1) this.text(g, label, x + size + 6 * s, y - size + 6 * s, 9 * s, hostileColor);
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
        // Locking on slams the diamond in from wide, with a flash ring
        let since = this.lockedAt.get(h.id);
        if (since === undefined) this.lockedAt.set(h.id, (since = this.time));
        const lt = this.time - since;
        const slam = 1 + 1.8 * (1 - Math.min(1, lt / 0.2)) ** 2;
        if (lt < 0.45) {
          g.save();
          g.globalAlpha *= 1 - lt / 0.45;
          g.strokeStyle = WHITE;
          g.lineWidth = 1;
          g.beginPath();
          g.arc(x, y, size * (1.4 + lt * 4), 0, Math.PI * 2);
          g.stroke();
          g.restore();
        }
        g.save();
        g.translate(x, y);
        g.rotate(this.time * 2 + (slam - 1) * 2);
        g.strokeStyle = WHITE;
        g.lineWidth = 1.6;
        const d = size * 1.35 * slam;
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
      if (dist < W.assistRange) {
        const lead = this.project(W.leadPoint(h, this._v), cam);
        if (lead) {
          const on = W.assist === h;
          const r = (on ? 7 : 5) * s;
          // On the sight: the pip fills and a bracket snaps round it (a tick, once, on the assisted one)
          const inZone = Math.hypot(lead.x - cx, lead.y - cy) < 10 * s + r;
          let zt = this.zoneAt.get(h.id);
          if (inZone && zt === undefined) {
            this.zoneAt.set(h.id, (zt = this.time));
            if (on && this.time - this.zoneCueT > 0.25) {
              this.zoneCueT = this.time;
              this.onCue?.('zone');
            }
          } else if (!inZone && zt !== undefined) {
            this.zoneAt.delete(h.id);
            zt = undefined;
          }
          if (zt !== undefined) {
            const snap = 1 + 1.2 * (1 - Math.min(1, (this.time - zt) / 0.12)) ** 2;
            const b = (r + 5 * s) * snap;
            const k = 4 * s;
            g.save();
            g.strokeStyle = WHITE;
            g.lineWidth = 1.6;
            for (let q = 0; q < 4; q++) {
              const a = Math.PI / 4 + (q * Math.PI) / 2;
              const bx = lead.x + Math.cos(a) * b;
              const by = lead.y + Math.sin(a) * b;
              const sx = -Math.sign(Math.cos(a));
              const sy = -Math.sign(Math.sin(a));
              g.beginPath();
              g.moveTo(bx + sx * k, by);
              g.lineTo(bx, by);
              g.lineTo(bx, by + sy * k);
              g.stroke();
            }
            g.fillStyle = 'rgba(235, 250, 255, 0.35)';
            g.beginPath();
            g.arc(lead.x, lead.y, r, 0, Math.PI * 2);
            g.fill();
            g.restore();
          }
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

  /**
   * A panel's glass: a fill darkening toward the foot, a hairline edge with
   * one corner chamfered (the outer top one), and bright ticks on the rest.
   */
  private glass(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number, right = false): void {
    g.save();
    g.shadowBlur = 0;
    const grad = g.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, 'rgba(2, 14, 24, 0.14)');
    grad.addColorStop(1, GLASS);
    g.fillStyle = grad;
    const c = 12 * s;
    g.beginPath();
    if (right) {
      g.moveTo(x, y);
      g.lineTo(x + w - c, y);
      g.lineTo(x + w, y + c);
      g.lineTo(x + w, y + h);
      g.lineTo(x, y + h);
    } else {
      g.moveTo(x + c, y);
      g.lineTo(x + w, y);
      g.lineTo(x + w, y + h);
      g.lineTo(x, y + h);
      g.lineTo(x, y + c);
    }
    g.closePath();
    g.fill();
    // Into the glare, the glass darkens so what's on it still reads
    const gl = this.glareAt(x + w / 2, y + h / 2);
    if (gl > 0.02) {
      g.fillStyle = `rgba(2, 12, 20, ${0.45 * gl})`;
      g.fill();
    }
    g.strokeStyle = CYAN_FAINT;
    g.lineWidth = 1;
    g.stroke();
    g.strokeStyle = CYAN_DIM;
    g.lineWidth = 1.5;
    const k = 7 * s;
    const corners: [number, number, number, number][] = [
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
      right ? [x, y, 1, 1] : [x + w, y, -1, 1],
    ];
    for (const [px, py, dx, dy] of corners) {
      g.beginPath();
      g.moveTo(px, py + dy * k);
      g.lineTo(px, py);
      g.lineTo(px + dx * k, py);
      g.stroke();
    }
    // The chamfer, lit
    g.strokeStyle = CYAN;
    g.beginPath();
    if (right) {
      g.moveTo(x + w - c, y);
      g.lineTo(x + w, y + c);
    } else {
      g.moveTo(x, y + c);
      g.lineTo(x + c, y);
    }
    g.stroke();
    g.restore();
  }

  private drawStatus(g: CanvasRenderingContext2D, m: FlightModel, c: Combat, s: number): void {
    const x = 40 * s;
    const y = this.h - 120 * s - this.bottomInset;
    this.glass(g, x - 18 * s, y - 22 * s, 256 * s, 112 * s, s);
    // Armour arc: a tick per tenth, what's left, and what a hit took (a
    // white ghost that hangs a beat, then drains)
    const r = 34 * s;
    const ax = x + r;
    const ay = y + r;
    const A0 = Math.PI * 0.75;
    const SPAN = Math.PI * 1.5;
    g.lineWidth = 1;
    g.strokeStyle = CYAN_DIM;
    for (let i = 0; i <= 10; i++) {
      const a = A0 + (SPAN * i) / 10;
      const r0 = r + 5 * s;
      const r1 = r + (i % 5 === 0 ? 10 : 7.5) * s;
      g.beginPath();
      g.moveTo(ax + Math.cos(a) * r0, ay + Math.sin(a) * r0);
      g.lineTo(ax + Math.cos(a) * r1, ay + Math.sin(a) * r1);
      g.stroke();
    }
    g.lineWidth = 4 * s;
    g.strokeStyle = CYAN_FAINT;
    g.beginPath();
    g.arc(ax, ay, r, A0, A0 + SPAN);
    g.stroke();
    const armor = c.armor;
    if (this.armorGhost > armor + 0.002) {
      g.strokeStyle = `rgba(255, 255, 255, ${0.55 + 0.4 * this.armorFlash})`;
      g.beginPath();
      g.arc(ax, ay, r, A0 + SPAN * armor, A0 + SPAN * this.armorGhost);
      g.stroke();
    }
    const low = armor < 0.3;
    const armorColor = low ? RED : armor < 0.6 ? AMBER : CYAN;
    g.strokeStyle = this.armorFlash > 0.5 ? WHITE : armorColor;
    g.beginPath();
    g.arc(ax, ay, r, A0, A0 + SPAN * armor);
    g.stroke();
    // A bright cap on the arc's end
    const ea = A0 + SPAN * armor;
    g.fillStyle = WHITE;
    g.beginPath();
    g.arc(ax + Math.cos(ea) * r, ay + Math.sin(ea) * r, 2.6 * s, 0, Math.PI * 2);
    g.fill();
    const numColor = this.armorFlash > 0 ? RED : low && Math.sin(this.time * 8) > 0 ? RED : WHITE;
    this.text(g, `${Math.round(armor * 100)}`, ax, ay - 2 * s, 20 * s, numColor, 'center');
    this.text(g, 'ARMOR', ax, ay + 16 * s, 7.5 * s, CYAN_LABEL, 'center', JARVIS);
    // Reserves: a diamond per reboot left, in the arc's open foot
    for (let i = 0; i < RESERVES; i++) {
      const px = ax + (i - (RESERVES - 1) / 2) * 11 * s;
      const py = ay + 28 * s;
      const d = 3.5 * s;
      g.beginPath();
      g.moveTo(px, py - d);
      g.lineTo(px + d, py);
      g.lineTo(px, py + d);
      g.lineTo(px - d, py);
      g.closePath();
      if (i < c.reserves) {
        g.fillStyle = c.reserves === 1 ? AMBER : CYAN;
        g.fill();
      } else {
        g.strokeStyle = CYAN_FAINT;
        g.lineWidth = 1.2 * s;
        g.stroke();
      }
    }
    // Thrust: segments filling (eased) to the throttle, the leading one lit;
    // on boost they shimmer amber
    const bx = x + r * 2 + 24 * s;
    this.text(g, 'THRUST', bx, y - 6 * s, 8 * s, CYAN_LABEL, 'left', JARVIS);
    this.text(g, `${Math.round(this.thrustShown * 100)}%`, bx + 118 * s, y - 6 * s, 9 * s, CYAN, 'right');
    const N = 20;
    const lit = this.thrustShown * N;
    for (let i = 0; i < N; i++) {
      const on = i < lit;
      const lead = on && i + 1 >= lit;
      const hi = i > 13;
      let col = on ? (hi ? AMBER : CYAN) : CYAN_FAINT;
      if (on && m.boosting && Math.sin(this.time * 18 - i * 0.7) > 0.3) col = WHITE;
      if (lead) col = WHITE;
      g.fillStyle = col;
      const sh = (8 + (i / N) * 6) * s;
      g.fillRect(bx + i * 6 * s, y + 20 * s - sh, 4 * s, sh);
    }
    const cmd = m.boosting ? 'BOOST' : m.grounded ? 'GROUND' : m.flightness < 0.5 ? 'HOVER' : `CRUISE ${Math.round((m.speedCmd / CRUISE_MAX) * 100)}%`;
    this.text(g, cmd, bx, y + 36 * s, 12 * s, m.boosting ? AMBER : WHITE);
    this.text(g, `REACTOR ${c.lost ? 'OFFLINE' : c.down > 0 ? 'REBOOT' : 'NOMINAL'}`, bx, y + 54 * s, 9 * s, c.down > 0 ? RED : CYAN_LABEL);
    if (m.icing > 0.01) this.text(g, `ICING ${Math.round(m.icing * 100)}%`, bx, y + 70 * s, 9 * s, AMBER);
  }

  private drawWeapons(g: CanvasRenderingContext2D, c: Combat, s: number): void {
    const W = c.weapons;
    const x = this.w - 40 * s;
    let y = this.h - 132 * s - this.bottomInset;
    this.glass(g, x - 166 * s, y - 20 * s, 184 * s, 146 * s, s, true);
    // A row lights up as its state changes (`key`: what counts as a change; defaults to the value)
    const row = (label: string, value: string, color: string, extra?: (bx: number, by: number) => void, key = value) => {
      let st = this.rowState.get(label);
      if (!st) this.rowState.set(label, (st = { key, t: -99 }));
      else if (st.key !== key) {
        st.key = key;
        st.t = this.time;
      }
      const flash = Math.max(0, 1 - (this.time - st.t) / 0.6);
      if (flash > 0) {
        g.save();
        g.shadowBlur = 0;
        g.fillStyle = `rgba(126, 232, 255, ${0.2 * flash})`;
        g.fillRect(x - 158 * s, y - 9 * s, 166 * s, 21 * s);
        g.fillStyle = `rgba(235, 250, 255, ${flash})`;
        g.fillRect(x - 158 * s, y - 9 * s, 2 * s, 21 * s);
        g.restore();
      }
      this.text(g, label, x - 150 * s, y, 8 * s, CYAN_LABEL, 'left', JARVIS);
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
    const ubKey = over ? 'over' : W.unibeamOn ? 'on' : W.unibeamCharge > 0 ? 'charge' : heat > 0.02 ? 'cool' : 'ready';
    row('UNIBEAM', ubText, ubColor, (bx, by) => {
      g.fillStyle = CYAN_FAINT;
      g.fillRect(bx, by, 150 * s, 3 * s);
      g.fillStyle = over ? RED : heat > 0.8 ? RED : heat > 0.55 ? AMBER : W.unibeamOn ? WHITE : CYAN;
      g.fillRect(bx, by, 150 * s * heat, 3 * s);
      // Where the lockout releases
      g.fillStyle = CYAN_DIM;
      g.fillRect(bx + 150 * s * 0.35 - 0.5 * s, by - 2 * s, 1 * s, 7 * s);
    }, ubKey);
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
    // The scope's glass, its rings, and a bezel ticked every 10°
    g.save();
    g.shadowBlur = 0;
    const disc = g.createRadialGradient(x, y, 0, x, y, R + 6 * s);
    disc.addColorStop(0, 'rgba(2, 14, 24, 0.12)');
    disc.addColorStop(1, GLASS);
    g.fillStyle = disc;
    g.beginPath();
    g.arc(x, y, R + 6 * s, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.strokeStyle = CYAN_FAINT;
    g.lineWidth = 1;
    for (const k of [1, 0.66, 0.33]) {
      g.beginPath();
      g.arc(x, y, R * k, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(x - R, y);
    g.lineTo(x + R, y);
    g.moveTo(x, y - R);
    g.lineTo(x, y + R);
    g.stroke();
    g.strokeStyle = CYAN_DIM;
    for (let i = 0; i < 36; i++) {
      const a = (i * Math.PI) / 18;
      const r1 = R + (i % 9 === 0 ? 7 : 4) * s;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * (R + 2 * s), y + Math.sin(a) * (R + 2 * s));
      g.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
      g.stroke();
    }
    // Sweep: a fading wedge behind a bright leading edge
    const SWEEP = 1.4;
    const sw = (this.time * SWEEP) % (Math.PI * 2);
    const grad = g.createConicGradient?.(sw - 0.9, x, y);
    if (grad) {
      grad.addColorStop(0, 'rgba(126,232,255,0)');
      grad.addColorStop(0.142, 'rgba(126,232,255,0.22)');
      grad.addColorStop(0.144, 'rgba(126,232,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = CYAN;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(sw) * R, y + Math.sin(sw) * R);
    g.stroke();
    // How long since the sweep last passed a point (s): blips flare, then fade
    const swept = (px: number, py: number) => {
      const a = Math.atan2(py - y, px - x);
      return ((((sw - a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / SWEEP;
    };
    const f = cam.getWorldDirection(this._v);
    const hdg = Math.atan2(f.x, -f.z);
    const place = (p: THREE.Vector3) => {
      const dx = p.x - m.pos.x;
      const dz = p.z - m.pos.z;
      // Heading-up: rotate world into the camera's heading
      const rx = dx * Math.cos(hdg) + dz * Math.sin(hdg);
      const ry = dx * Math.sin(hdg) - dz * Math.cos(hdg);
      const d = Math.hypot(rx, ry);
      const k = Math.min(1, d / range);
      return { px: x + (rx / Math.max(d, 1)) * k * R, py: y - (ry / Math.max(d, 1)) * k * R };
    };
    const plot = (p: THREE.Vector3, color: string, size: number, tri = false) => {
      const { px, py } = place(p);
      const since = swept(px, py);
      g.save();
      g.globalAlpha *= 0.35 + 0.65 * Math.exp(-since * 1.4);
      if (since < 0.5) {
        // (a ping ring thrown off as the sweep crosses it)
        g.save();
        g.globalAlpha *= 1 - since / 0.5;
        g.strokeStyle = color;
        g.lineWidth = 1;
        g.beginPath();
        g.arc(px, py, size + since * 16 * s, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
      g.fillStyle = color;
      if (tri) {
        g.beginPath();
        g.moveTo(px, py - size);
        g.lineTo(px - size, py + size);
        g.lineTo(px + size, py + size);
        g.fill();
      } else g.fillRect(px - size / 2, py - size / 2, size, size);
      g.restore();
    };
    // The pad: the same open diamond as its marker in the world, pinned to the rim when out of range
    if (this.pad) {
      const { px, py } = place(this.pad);
      const k = 4.5 * s;
      g.strokeStyle = CYAN;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(px, py - k);
      g.lineTo(px + k, py);
      g.lineTo(px, py + k);
      g.lineTo(px - k, py);
      g.closePath();
      g.stroke();
    }
    for (const h of c.hostiles) if (h.alive) plot(h.pos, h.kind === 'drone' ? RED : AMBER, 4 * s, h.kind !== 'drone');
    for (const ms of c.missiles.threats()) plot(ms.pos, WHITE, 3 * s);
    for (const ms of c.missiles.strikes()) plot(ms.pos, AMBER, 2.5 * s);
    g.fillStyle = WHITE;
    g.beginPath();
    g.moveTo(x, y - 6 * s);
    g.lineTo(x - 4 * s, y + 4 * s);
    g.lineTo(x + 4 * s, y + 4 * s);
    g.fill();
    // The tally on a plate of glass, readable over cloud
    g.save();
    g.shadowBlur = 0;
    const plate = g.createLinearGradient(0, y + R + 6 * s, 0, y + R + 64 * s);
    plate.addColorStop(0, GLASS);
    plate.addColorStop(1, 'rgba(2, 14, 24, 0)');
    g.fillStyle = plate;
    g.fillRect(x - R, y + R + 6 * s, 2 * R, 58 * s);
    g.restore();
    this.text(g, c.wave >= 0 ? `WAVE ${c.wave + 1}` : 'FREE FLIGHT', x, y + R + 14 * s, 8 * s, CYAN_LABEL, 'center', JARVIS);
    // The tally pops on a kill
    g.save();
    const pop = 1 + 0.45 * this.killPop * this.killPop;
    g.translate(x, y + R + 28 * s);
    g.scale(pop, pop);
    this.text(g, `KILLS ${c.kills}`, 0, 0, 10 * s, this.killFlash > 0 ? WHITE : CYAN, 'center');
    g.restore();
    const alive = c.hostiles.filter((h) => h.alive).length;
    if (alive) this.text(g, `HOSTILES ${alive}`, x, y + R + 42 * s, 10 * s, RED, 'center');
    else if (c.waveReady) {
      // A wave is on offer: a slow pulse, and the countdown once a run is going
      g.save();
      g.globalAlpha *= 0.55 + 0.45 * Math.sin(this.time * 3);
      this.text(g, `${this.waveKey} — CALL WAVE ${c.wave + 2}`, x, y + R + 42 * s, 9 * s, AMBER, 'center', JARVIS);
      g.restore();
      const due = c.autoWaveIn;
      if (due !== null) this.text(g, `INBOUND IN ${Math.ceil(due)}`, x, y + R + 56 * s, 9 * s, AMBER, 'center', JARVIS);
    }
  }

  private drawWarnings(g: CanvasRenderingContext2D, cam: THREE.PerspectiveCamera, m: FlightModel, c: Combat, s: number): void {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const blink = Math.sin(this.time * 14) > 0;
    // Incoming seekers: a chevron toward each and a flashing callout
    const threats = c.missiles.threats();
    // The nearest seeker's time to impact: the ring round the sight closes with it
    let tti = Infinity;
    for (const t of threats) {
      const rel = this._v.copy(m.pos).sub(t.pos);
      const d = rel.length();
      const closing = (t.vel.dot(rel) - m.vel.dot(rel)) / Math.max(d, 1e-3);
      if (closing > 1) tti = Math.min(tti, d / closing);
    }
    if (threats.length) {
      const u = Number.isFinite(tti) ? THREE.MathUtils.clamp(tti / 6, 0, 1) : 1;
      const goal = (40 + 110 * u) * s;
      this.threatR = this.threatR > 0 ? this.threatR + (goal - this.threatR) * 0.25 : goal;
      const close = tti < 1.5;
      const pulse = close ? 0.5 + 0.5 * Math.sin(this.time * 30) : 0.7 + 0.3 * Math.sin(this.time * 8);
      g.save();
      g.strokeStyle = RED;
      g.globalAlpha *= pulse * (Number.isFinite(tti) ? 1 : 0.4);
      g.lineWidth = close ? 2.4 : 1.6;
      // Segments turning against each other, closing to a solid ring at the end
      const gap = 0.35 * u;
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 + this.time * (i % 2 ? 0.8 : -0.8) * u;
        g.beginPath();
        g.arc(cx, cy, this.threatR, a + gap / 2, a + Math.PI / 3 - gap / 2);
        g.stroke();
      }
      g.restore();
      const ttiText = Number.isFinite(tti) ? `  ${tti.toFixed(1)}s` : '';
      if (blink || close) this.text(g, `${threats.length > 1 ? `MISSILES ×${threats.length}` : 'MISSILE'}${ttiText}`, cx, cy + 88 * s, 16 * s, RED, 'center', JARVIS);
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
    // A seeker pulled off by the flares: the ring blows out white
    if (this.decoyFlash > 0 && this.threatR > 0) {
      const t = 1 - this.decoyFlash;
      g.save();
      g.globalAlpha *= this.decoyFlash;
      g.strokeStyle = WHITE;
      g.lineWidth = 2.5 * this.decoyFlash + 0.5;
      g.beginPath();
      g.arc(cx, cy, this.threatR + t * 90 * s, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
    if (!threats.length && this.decoyFlash <= 0) this.threatR = 0;
    // The house being shelled: a callout and an amber caret toward each launcher doing it
    if (c.houseUnderFire) {
      if (blink) this.text(g, 'HOUSE UNDER FIRE', cx, cy - 88 * s, 13 * s, AMBER, 'center', JARVIS);
      for (const p of c.shellers()) {
        const rel = this._v.copy(p).applyMatrix4(cam.matrixWorldInverse);
        const ang = Math.atan2(-rel.y, rel.x);
        const R = 82 * s;
        g.save();
        g.translate(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
        g.rotate(ang);
        g.strokeStyle = AMBER;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(-4 * s, -6 * s);
        g.lineTo(4 * s, 0);
        g.lineTo(-4 * s, 6 * s);
        g.stroke();
        g.restore();
      }
    }
    if (m.pos.y > m.icingAlt && blink) this.text(g, 'ICE ON THE AIRFOILS', cx, cy - 64 * s, 11 * s, AMBER, 'center', JARVIS);
    if (c.down > 0 && !c.lost) this.text(g, 'POWER FAILURE — REBOOTING', cx, cy - 40 * s, 14 * s, RED, 'center', JARVIS);
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
      const newest = i === this.lines.length - 1;
      g.globalAlpha = this.alpha * a * (newest ? 1 : 0.55);
      const full = `J.A.R.V.I.S.  ${l.text}`;
      const typed = `J.A.R.V.I.S.  ${l.text.slice(0, shown)}`;
      if (newest) {
        // A strip of glass under the line (sized to the whole of it, so it
        // doesn't grow as it types), and a block cursor while it does
        g.font = `500 ${12 * s}px ${MONO}`;
        const fw = g.measureText(full).width;
        g.save();
        g.shadowBlur = 0;
        const grad = g.createLinearGradient(x - fw / 2 - 30 * s, 0, x + fw / 2 + 30 * s, 0);
        grad.addColorStop(0, 'rgba(2, 14, 24, 0)');
        grad.addColorStop(0.15, GLASS);
        grad.addColorStop(0.85, GLASS);
        grad.addColorStop(1, 'rgba(2, 14, 24, 0)');
        g.fillStyle = grad;
        g.fillRect(x - fw / 2 - 30 * s, y - 11 * s, fw + 60 * s, 22 * s);
        g.fillStyle = CYAN;
        g.fillRect(x - fw / 2 - 12 * s, y - 6 * s, 2 * s, 12 * s);
        g.restore();
        // Typed from the left of where the whole line will sit, so it doesn't drift
        this.text(g, typed, x - fw / 2, y, 12 * s, WHITE, 'left');
        if (shown < l.text.length || (age < 2.5 && Math.sin(this.time * 9) > 0)) {
          const tw = g.measureText(typed).width;
          g.fillStyle = CYAN;
          g.fillRect(x - fw / 2 + tw + 2 * s, y - 6 * s, 6 * s, 12 * s);
        }
      } else this.text(g, full, x, y, 12 * s, CYAN_DIM, 'center');
      y += top ? 20 * s : -20 * s;
    }
    g.globalAlpha = this.alpha;
  }
}

