import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FlightModel } from '../sim/flightModel';
import { RENDER_ORDER } from '../render/transparency';
import { PAD, PAD_R, PAD_Y } from './house';

/**
 * The landing pad on the lawn beside the house: a graphite plinth with a
 * sloped lip, its deck laid in panels round an arc-reactor centre, and
 * lit in the reactor's blue — a light strip round the lip, approach lights
 * on the slope, a capture ring and tick ring on the deck, the centre's two
 * rings (the CENTRED and BULLSEYE marks) and the reactor's coil.
 *
 * The lights read the approach: they wake and chase round as the suit comes
 * in, the capture ring and the centre come up once the hover computer has
 * the suit held over the pad, and a touchdown reticle on the deck tracks the
 * point under the boots (amber off the mark, blue in the centre ring, white
 * on the bullseye). On the set-down a shock ring runs out across the deck;
 * a bullseye spins the coil up segment by segment.
 */

/** Offsets (m) from the pad centre graded on touchdown. */
export const BULLSEYE_R = 0.5;
export const CENTRED_R = 1.5;
export type PadGrade = 'bullseye' | 'centred' | 'onPad';

export function gradeLanding(offset: number): PadGrade {
  return offset <= BULLSEYE_R ? 'bullseye' : offset <= CENTRED_R ? 'centred' : 'onPad';
}

/** Deck (textured top) radius; the lip slopes down from there. */
const DECK_R = PAD_R - 0.4;
const CAPTURE_R0 = 5.6;
const CAPTURE_R1 = 5.8;
const TICKS = 24;
const TICK_R = 6.2;
const LIGHTS = 16;
const COIL = 10;
const BEACON_H = 90;

const BLUE = new THREE.Color(0.5, 1.6, 2.2);
const WHITE = new THREE.Color(2.6, 3.0, 3.2);
const AMBER = new THREE.Color(2.4, 1.25, 0.3);
const smooth = THREE.MathUtils.smoothstep;
/** smoothstep that also runs downhill (edge0 > edge1). */
const fade = (a: number, b: number, x: number) => (a < b ? smooth(x, a, b) : 1 - smooth(x, b, a));

/** The deck's paint and panel seams, drawn once (canvas x, y → pad x, z). */
function deckTexture(): THREE.CanvasTexture {
  const N = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const k = N / (2 * DECK_R);
  const o = N / 2;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ring = (r: number, w: number, style: string, dash: number[] = []) => {
    g.beginPath();
    g.arc(o, o, r * k, 0, Math.PI * 2);
    g.lineWidth = w * k;
    g.strokeStyle = style;
    g.setLineDash(dash.map((d) => d * k));
    g.stroke();
    g.setLineDash([]);
  };
  const spoke = (a: number, r0: number, r1: number, w: number, style: string) => {
    g.beginPath();
    g.moveTo(o + Math.cos(a) * r0 * k, o + Math.sin(a) * r0 * k);
    g.lineTo(o + Math.cos(a) * r1 * k, o + Math.sin(a) * r1 * k);
    g.lineWidth = w * k;
    g.strokeStyle = style;
    g.stroke();
  };
  const disc = (r: number, style: string) => {
    g.beginPath();
    g.arc(o, o, r * k, 0, Math.PI * 2);
    g.fillStyle = style;
    g.fill();
  };

  // Panels: bands of slightly different graphite, the outer band darker
  g.fillStyle = '#33363b';
  g.fillRect(0, 0, N, N);
  disc(5.95, '#3d4146');
  disc(4.1, '#393d42');
  disc(2.3, '#42464d');
  disc(1.05, '#30333a');
  // Grain: speckle and a few long scuffs from boots and drag
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.07)';
    g.fillRect(rnd() * N, rnd() * N, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 1 + rnd() * 4.5;
    g.beginPath();
    g.arc(o, o, r * k, a, a + 0.05 + rnd() * 0.25);
    g.lineWidth = 1 + rnd() * 2;
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.stroke();
  }
  // Seams: a dark joint with a lit edge beside it
  const seam = (r: number) => {
    ring(r, 0.035, 'rgba(8,9,10,0.9)');
    ring(r + 0.03, 0.014, 'rgba(255,255,255,0.1)');
  };
  for (const r of [1.05, 2.3, 4.1, 5.95]) seam(r);
  for (let i = 0; i < 12; i++) spoke(((i + 0.5) / 12) * Math.PI * 2, 2.3, 4.1, 0.03, 'rgba(8,9,10,0.85)');
  for (let i = 0; i < 18; i++) spoke(((i + 0.25) / 18) * Math.PI * 2, 4.1, 5.95, 0.03, 'rgba(8,9,10,0.85)');
  // Recessed fixings round each band
  for (const [r, n] of [[2.3, 24], [4.1, 36], [5.95, 48]] as const) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      g.beginPath();
      g.arc(o + Math.cos(a) * (r - 0.12) * k, o + Math.sin(a) * (r - 0.12) * k, 0.03 * k, 0, Math.PI * 2);
      g.fillStyle = 'rgba(10,11,12,0.8)';
      g.fill();
    }
  }
  // Paint: the approach circle, chevrons pointing in from the four quarters,
  // amber dashes round the edge band
  ring(3.2, 0.06, 'rgba(215,225,230,0.45)', [0.35, 0.25]);
  for (let q = 0; q < 4; q++) {
    const a = (q / 4) * Math.PI * 2 + Math.PI / 4;
    for (let j = 0; j < 3; j++) {
      const r = 5.25 - j * 0.38;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const tip = [o + ca * (r - 0.3) * k, o + sa * (r - 0.3) * k];
      g.beginPath();
      g.moveTo(o + (ca * r - sa * 0.42) * k, o + (sa * r + ca * 0.42) * k);
      g.lineTo(tip[0], tip[1]);
      g.lineTo(o + (ca * r + sa * 0.42) * k, o + (sa * r - ca * 0.42) * k);
      g.lineWidth = 0.09 * k;
      g.lineJoin = 'miter';
      g.strokeStyle = `rgba(215,225,230,${0.55 - j * 0.13})`;
      g.stroke();
    }
  }
  ring(6.42, 0.1, 'rgba(235,155,45,0.6)', [0.22, 0.32]);
  // Soot fanned out from the centre, where the boots fire on every set-down
  const soot = g.createRadialGradient(o, o, 0, o, o, 2.8 * k);
  soot.addColorStop(0, 'rgba(0,0,0,0.55)');
  soot.addColorStop(0.45, 'rgba(0,0,0,0.25)');
  soot.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = soot;
  g.fillRect(0, 0, N, N);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A flat ring on the deck (pad frame, y up). */
function flatRing(r0: number, r1: number, segs = 128, y = 0.006): THREE.BufferGeometry {
  return new THREE.RingGeometry(r0, r1, segs).rotateX(-Math.PI / 2).translate(0, y, 0);
}

function glow(color: THREE.Color, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: color.clone(),
    toneMapped: false,
    ...(additive ? { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } : {}),
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export class LandingPad {
  readonly group = new THREE.Group();
  private readonly rim = glow(BLUE);
  private readonly capture = glow(BLUE);
  private readonly centre = glow(BLUE);
  private readonly ticks: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly coil: THREE.InstancedMesh;
  private readonly reticle: THREE.Group;
  private readonly reticleMat = glow(BLUE, true);
  private readonly wave: THREE.Mesh;
  private readonly waveMat = glow(WHITE, true);
  private readonly beaconMat: THREE.MeshBasicMaterial;
  private readonly beacon: THREE.Mesh;
  private time = 0;
  /** 0–1, eased: the suit is in the air and coming in. */
  private approach = 0;
  /** 0–1, eased: the hover computer has it held over the pad. */
  private held = 0;
  /** Seconds since the last graded set-down, and its grade. */
  private since = Infinity;
  private grade: PadGrade = 'onPad';
  private readonly _c = new THREE.Color();
  private readonly _m = new THREE.Matrix4();

  constructor() {
    const g = this.group;
    g.position.set(PAD.x, PAD_Y, PAD.y);
    g.name = 'landingPad';

    // Plinth: the deck, a sloped lip, and a skirt down into the lawn
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.45 });
    const lip = new THREE.LatheGeometry(
      [
        new THREE.Vector2(PAD_R + 0.75, -1.2),
        new THREE.Vector2(PAD_R + 0.75, -0.6),
        new THREE.Vector2(PAD_R + 0.45, -0.38),
        new THREE.Vector2(PAD_R + 0.08, -0.1),
        new THREE.Vector2(PAD_R - 0.1, -0.02),
        new THREE.Vector2(DECK_R, 0),
      ],
      128,
    );
    const plinth = new THREE.Mesh(lip, metal);
    // (a touch of glow from the deck's own panels: its markings read at dusk)
    const paint = deckTexture();
    const deck = new THREE.Mesh(
      new THREE.CircleGeometry(DECK_R, 128).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: paint, emissiveMap: paint, emissive: new THREE.Color(0.9, 1.05, 1.2), roughness: 0.62, metalness: 0.15 }),
    );
    plinth.receiveShadow = deck.receiveShadow = true;
    plinth.castShadow = true;
    g.add(plinth, deck);

    // Light strip set into the lip
    const strip = new THREE.Mesh(new THREE.TorusGeometry(PAD_R - 0.02, 0.035, 6, 192).rotateX(Math.PI / 2).translate(0, -0.05, 0), this.rim);
    // Capture ring, and the centre: CENTRED ring, BULLSEYE ring and its dot
    const capture = new THREE.Mesh(flatRing(CAPTURE_R0, CAPTURE_R1), this.capture);
    const centre = new THREE.Mesh(
      mergeGeometries([flatRing(CENTRED_R - 0.08, CENTRED_R, 96), flatRing(BULLSEYE_R - 0.06, BULLSEYE_R, 64), new THREE.CircleGeometry(0.1, 24).rotateX(-Math.PI / 2).translate(0, 0.006, 0)]),
      this.centre,
    );
    g.add(strip, capture, centre);

    // Tick ring: one long tick every quarter
    this.ticks = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.12, 1).rotateX(-Math.PI / 2), glow(BLUE), TICKS);
    const s = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    for (let i = 0; i < TICKS; i++) {
      const a = (i / TICKS) * Math.PI * 2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
      s.set(1, 1, i % 6 === 0 ? 0.85 : 0.4);
      p.set(Math.sin(a) * TICK_R, 0.007, Math.cos(a) * TICK_R);
      this.ticks.setMatrixAt(i, this._m.compose(p, q, s));
      this.ticks.setColorAt(i, BLUE);
    }
    // Approach lights: domes on the slope of the lip
    this.lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), glow(BLUE), LIGHTS);
    s.set(1, 0.6, 1);
    q.identity();
    for (let i = 0; i < LIGHTS; i++) {
      const a = ((i + 0.5) / LIGHTS) * Math.PI * 2;
      p.set(Math.sin(a) * (PAD_R + 0.26), -0.24, Math.cos(a) * (PAD_R + 0.26));
      this.lights.setMatrixAt(i, this._m.compose(p, q, s));
      this.lights.setColorAt(i, BLUE);
    }
    // The reactor's coil round the bullseye
    const seg = new THREE.RingGeometry(0.62, 0.95, 4, 1, 0, ((Math.PI * 2) / COIL) * 0.72).rotateX(-Math.PI / 2).translate(0, 0.006, 0);
    this.coil = new THREE.InstancedMesh(seg, glow(BLUE), COIL);
    for (let i = 0; i < COIL; i++) {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i / COIL) * Math.PI * 2);
      this.coil.setMatrixAt(i, this._m.compose(p.set(0, 0, 0), q, s.set(1, 1, 1)));
      this.coil.setColorAt(i, BLUE);
    }
    g.add(this.ticks, this.lights, this.coil);

    // Touchdown reticle: where the boots will come down
    const ret = mergeGeometries([
      new THREE.RingGeometry(0.34, 0.4, 48),
      ...[0, 1, 2, 3].map((i) => new THREE.PlaneGeometry(0.05, 0.22).translate(0, 0.55, 0).rotateZ((i * Math.PI) / 2)),
    ]).rotateX(-Math.PI / 2);
    this.reticle = new THREE.Group();
    const retMesh = new THREE.Mesh(ret, this.reticleMat);
    retMesh.position.y = 0.012;
    retMesh.renderOrder = RENDER_ORDER.wash;
    this.reticle.add(retMesh);
    this.reticle.visible = false;
    // Shock ring run out across the deck on the set-down
    this.wave = new THREE.Mesh(flatRing(0.9, 1, 128, 0.014), this.waveMat);
    this.wave.renderOrder = RENDER_ORDER.wash;
    this.wave.visible = false;
    g.add(this.reticle, this.wave);

    // Beacon: a faint column over the centre to find the pad from the air
    const col = new THREE.CylinderGeometry(0.08, 0.3, BEACON_H, 12, 8, true).translate(0, BEACON_H / 2, 0);
    const pos = col.getAttribute('position');
    const tone = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const v = Math.pow(1 - pos.getY(i) / BEACON_H, 2.2);
      tone.set([v, v, v], i * 3);
    }
    col.setAttribute('color', new THREE.BufferAttribute(tone, 3));
    this.beaconMat = new THREE.MeshBasicMaterial({ color: BLUE.clone(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.beacon = new THREE.Mesh(col, this.beaconMat);
    this.beacon.renderOrder = RENDER_ORDER.wash;
    g.add(this.beacon);
  }

  /** A graded set-down on the deck: the shock ring, the flash, the coil. */
  landed(grade: PadGrade): void {
    this.grade = grade;
    this.since = 0;
  }

  update(dt: number, m: FlightModel): void {
    this.time += dt;
    this.since += dt;
    const t = this.time;
    const dx = m.pos.x - PAD.x;
    const dz = m.pos.z - PAD.y;
    const d = Math.hypot(dx, dz);
    const h = m.pos.y - m.hipHeight() - PAD_Y;
    const air = !m.grounded;
    const ease = (x: number, goal: number, tau: number) => x + (goal - x) * (1 - Math.exp(-dt / tau));
    this.approach = ease(this.approach, air ? fade(160, 60, d) * fade(120, 60, h) : 0, 0.4);
    this.held = ease(this.held, air ? m.padPull : 0, 0.15);
    const appr = this.approach;
    const held = this.held;

    // The flash after a set-down: brighter the better the landing
    const strength = this.grade === 'bullseye' ? 1 : this.grade === 'centred' ? 0.6 : 0.3;
    const flash = this.since < 3 ? strength * Math.exp(-this.since * 1.6) : 0;
    const flashCol = this.grade === 'bullseye' ? WHITE : BLUE;
    const lit = (mat: THREE.MeshBasicMaterial, base: number) => mat.color.copy(BLUE).multiplyScalar(base).lerp(flashCol, Math.min(1, flash));

    lit(this.rim, 0.5 + 0.25 * appr + 0.15 * Math.sin(t * 1.3) * (1 - appr));
    lit(this.capture, 0.35 + 0.35 * appr + 0.9 * held * (0.85 + 0.15 * Math.sin(t * 6)));
    lit(this.centre, 0.45 + 0.4 * appr + 0.7 * held);

    // Ticks: a slow chase round the ring on the approach, all lit when held
    const head = (t * 0.7) % 1;
    for (let i = 0; i < TICKS; i++) {
      const u = (head - i / TICKS + 1) % 1;
      const chase = Math.exp(-u * 9) * appr;
      const v = 0.3 + 0.9 * chase + 0.8 * held;
      this.ticks.setColorAt(i, this._c.copy(BLUE).multiplyScalar(v).lerp(flashCol, Math.min(1, flash)));
    }
    this.ticks.instanceColor!.needsUpdate = true;

    // Approach lights: sequenced flashes running round from the suit's side
    const from = Math.atan2(dx, dz);
    for (let i = 0; i < LIGHTS; i++) {
      const a = ((i + 0.5) / LIGHTS) * Math.PI * 2;
      const off = Math.abs(Math.atan2(Math.sin(a - from), Math.cos(a - from))) / Math.PI;
      const pulse = Math.pow(Math.max(0, Math.sin((t * 1.4 - off * 0.6) * Math.PI * 2)), 12);
      const idle = 0.25 + 0.2 * Math.sin(t * 1.3 + i * 0.4);
      const v = THREE.MathUtils.lerp(idle, 0.2 + 2.2 * pulse, appr) + held * 0.6;
      this.lights.setColorAt(i, this._c.copy(appr > 0.5 && held < 0.5 ? AMBER : BLUE).multiplyScalar(v).lerp(flashCol, Math.min(1, flash)));
    }
    this.lights.instanceColor!.needsUpdate = true;

    // Coil: turns over idle, spins up held; a bullseye lights it segment by segment
    this.coil.rotation.y -= dt * (0.15 + 1.6 * held + 6 * flash);
    const spinUp = this.grade === 'bullseye' && this.since < 3;
    for (let i = 0; i < COIL; i++) {
      if (spinUp) {
        const on = smooth(this.since, i * 0.045, i * 0.045 + 0.06);
        this._c.copy(WHITE).multiplyScalar(THREE.MathUtils.lerp(0.05, 0.4 + 1.2 * Math.exp(-Math.max(0, this.since - 0.6) * 1.2), on));
      } else this._c.copy(BLUE).multiplyScalar(0.35 + 0.35 * appr + 0.8 * held);
      this.coil.setColorAt(i, this._c);
    }
    this.coil.instanceColor!.needsUpdate = true;

    // Touchdown reticle under the boots, coloured by where they'd land
    const show = air ? fade(9, 6.5, d) * fade(45, 30, h) : 0;
    this.reticle.visible = show > 0.01;
    if (this.reticle.visible) {
      // (a beat of the drift ahead: where it's going, not where it is)
      const lead = Math.min(0.4, h / 20);
      let rx = dx + m.vel.x * lead;
      let rz = dz + m.vel.z * lead;
      const rr = Math.hypot(rx, rz);
      if (rr > DECK_R - 0.5) {
        rx *= (DECK_R - 0.5) / rr;
        rz *= (DECK_R - 0.5) / rr;
      }
      this.reticle.position.set(rx, 0, rz);
      this.reticle.rotation.y = t * 0.8;
      this.reticle.scale.setScalar(1 + Math.min(h, 30) * 0.05);
      const off = Math.hypot(rx, rz);
      const col = off <= BULLSEYE_R ? WHITE : off <= CENTRED_R ? BLUE : AMBER;
      this.reticleMat.color.copy(col).multiplyScalar(show * 0.6);
    }

    // Shock ring
    const w = this.since / 0.9;
    this.wave.visible = w < 1;
    if (this.wave.visible) {
      const r = 0.6 + (PAD_R + 1.5) * (1 - Math.pow(1 - w, 2.4));
      this.wave.scale.set(r, 1, r);
      this.waveMat.color.copy(flashCol).multiplyScalar(strength * 0.9 * (1 - w));
    }

    // Beacon: seen from out over the hills, gone once close in or down
    const bv = smooth(d, 30, 120) * (air ? 1 : 0.4);
    this.beaconMat.color.copy(BLUE).multiplyScalar(0.35 * bv * (0.85 + 0.15 * Math.sin(t * 2.4)));
    this.beacon.visible = bv > 0.01;
  }
}
