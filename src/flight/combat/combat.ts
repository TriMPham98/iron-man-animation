import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import type { Suit } from '../../suit/Suit';
import { HOME, type Heightfield } from '../world/heightfield';
import { strikeMarks, structureTop } from '../world/house';
import { Drone, Guns } from './drones';
import { Explosions, type SurfaceQuery } from './explosions';
import { Frigate, type ShipPart } from './frigate';
import { Missiles } from './missiles';
import { PlayerWeapons } from './playerWeapons';
import { SamSite, samSites } from './sams';
import type { Hostile, HouseTarget, PlayerTarget } from './types';
import { hazeAll } from '../render/haze';

/**
 * The fight: the suit's armour and the hostiles that wear it down, in
 * escalating waves. Free flight until the pilot calls a wave (N, or the
 * touch WAVE button, offered whenever the sky is clear): drones from over
 * the ridges, then the mobile SAM launchers wake up, then a frigate comes
 * in off the sea (and again every third wave after). Armour regenerates out of combat; at zero the suit drops
 * dead for a few seconds and reboots in the air, on its one reserve (a cleared
 * wave earns it back). With that spent the suit is lost:
 * it stays down until the pilot redeploys, back to wave one on the pad.
 * With the suit out of their sight the SAMs shell the house: only for show
 * (a blast, scorch on the roof, smoke), it takes no damage.
 */

/** The one reboot the suit holds at the start of a run. */
export const RESERVES = 1;
/** Seconds after the suit is lost before a redeploy is offered (it's seen to fall). */
const REDEPLOY_AFTER = 2.5;
/** Scorch marks the roofs keep before the oldest goes. */
const MAX_SCORCH = 24;

let scorchMat: THREE.MeshStandardMaterial | null = null;
const SCORCH_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
/** A ragged soot splash: alpha falls off from the middle, broken up round the rim. */
function scorchMaterial(): THREE.MeshStandardMaterial {
  if (scorchMat) return scorchMat;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  const lobes = Array.from({ length: 7 }, () => [Math.random() * Math.PI * 2, 0.08 + Math.random() * 0.12] as const);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n - 0.5;
      const y = (j + 0.5) / n - 0.5;
      const a = Math.atan2(y, x);
      const rim = 0.34 + lobes.reduce((r, [p, k]) => r + k * Math.max(0, Math.cos(a * 3 + p)) ** 4, 0) * 0.5;
      const r = Math.hypot(x, y) / rim;
      const alpha = Math.max(0, Math.min(1, 1.15 - r * r)) * (0.75 + 0.25 * Math.random());
      data.set([14, 12, 10, Math.round(alpha * 235)], (j * n + i) * 4);
    }
  }
  const map = new THREE.DataTexture(data, n, n);
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  scorchMat = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 });
  return scorchMat;
}

const WAVES: ReadonlyArray<{ drones: number; sams: number; frigate?: boolean; line: string }> = [
  { drones: 3, sams: 0, line: 'Sir, three bogeys coming over the ridge. Drone signatures.' },
  { drones: 5, sams: 0, line: 'Five more inbound. They are learning.' },
  { drones: 4, sams: 2, line: 'Surface-to-air sites are lighting up on the ridgeline. I suggest the flares.' },
  { drones: 7, sams: 3, line: 'A larger formation, sir. Shall I alert the authorities? No? Very well.' },
  { drones: 2, sams: 1, frigate: true, line: 'A warship off the coast, sir. Guns fore and aft, a missile launcher on the foredeck. Take the radar first.' },
];

export class Combat {
  readonly group = new THREE.Group();
  readonly streaks = new Streaks();
  readonly explosions: Explosions;
  readonly missiles: Missiles;
  readonly guns = new Guns();
  readonly weapons: PlayerWeapons;
  readonly drones: Drone[] = [];
  readonly sams: SamSite[] = [];
  readonly ships: Frigate[] = [];
  readonly hostiles: Hostile[] = [];
  /** Armour 0–1. */
  armor = 1;
  /** Seconds since the last hit. */
  sinceHit = 99;
  /** Seconds left with the suit powered down. */
  down = 0;
  damageFlash = 0;
  wave = -1;
  kills = 0;
  /** Reboots left this run. */
  reserves = RESERVES;
  /** Knocked out with no reserve left: down for good until {@link resetRun}. */
  lost = false;
  /** Seconds since the suit was lost. */
  lostT = 0;
  private waveT = 0;
  private readonly samSpots: THREE.Vector3[];
  private readonly player: PlayerTarget;
  readonly house: HouseTarget;
  private readonly scorch: THREE.Mesh[] = [];
  /** Seconds since JARVIS last called out the shelling. */
  private shellCallT = 99;

  constructor(
    private readonly field: Heightfield,
    private readonly ground: SurfaceQuery,
    private readonly model: FlightModel,
    suit: Suit,
    private readonly particles: Particles,
    private readonly events: EventBus,
    onHit: (amount: number, at: THREE.Vector3) => void,
    private readonly hazeUniforms: Record<string, THREE.IUniform>,
  ) {
    this.explosions = new Explosions(particles, ground, events);
    this.missiles = new Missiles(particles, this.explosions, ground, events);
    this.weapons = new PlayerWeapons(suit, model, field, particles, this.streaks, this.missiles, this.explosions, events);
    this.group.add(this.streaks.mesh, this.explosions.group, this.missiles.group, this.weapons.group);
    this.group.name = 'combat';
    this.samSpots = samSites(field, HOME, 6, 3);
    this.house = { marks: strikeMarks(field), struck: (at) => this.houseStruck(at) };
    const self = this;
    this.player = {
      pos: model.pos,
      vel: model.vel,
      get alive() {
        return self.down <= 0;
      },
      hit(amount: number, at: THREE.Vector3, kind: 'bullet' | 'missile') {
        if (self.down > 0) return;
        self.armor = Math.max(0, self.armor - amount / 100);
        self.sinceHit = 0;
        self.damageFlash = Math.min(1, self.damageFlash + (kind === 'missile' ? 0.9 : 0.25));
        onHit(amount, at);
        events.emit('hitArmor', { at, value: amount });
        if (self.armor <= 0) {
          self.down = 3.2;
          events.emit('suitCritical', { at: model.pos });
          // Scripted runs (waves off) always reboot
          if (!self.wavesEnabled || self.reserves > 0) {
            if (self.wavesEnabled) self.reserves--;
            const left = !self.wavesEnabled ? '' : self.reserves === 0 ? ' That was the last reserve, sir.' : ' One reserve left.';
            events.emit('jarvis', { text: `Armour critical. Rerouting power. Hold on, sir.${left}` });
          } else {
            self.lost = true;
            self.lostT = 0;
            self.down = Infinity;
            events.emit('suitLost', { at: model.pos, value: self.wave + 1 });
            events.emit('jarvis', { text: 'Reserves exhausted. I’m losing the suit, sir.' });
          }
        }
      },
    };
  }

  get playerTarget(): PlayerTarget {
    return this.player;
  }

  /** The pilot can call waves (off for scripted runs). */
  wavesEnabled = true;

  /** A wave can be called now: the sky is clear and the suit is up. */
  get waveReady(): boolean {
    return this.wavesEnabled && this.down <= 0 && !this.hostiles.some((h) => h.alive);
  }

  /** The suit is lost and has been seen to fall: a redeploy is on offer. */
  get redeployReady(): boolean {
    return this.lost && this.lostT > REDEPLOY_AFTER;
  }

  /** A fresh run: the sky cleared, wave one next, full armour and reserves. */
  resetRun(): void {
    for (const d of this.drones) this.group.remove(d.mesh);
    for (const s of this.sams) this.group.remove(s.mesh);
    for (const f of this.ships) this.group.remove(f.mesh);
    this.drones.length = this.sams.length = this.ships.length = this.hostiles.length = 0;
    this.missiles.clear();
    this.guns.rounds.length = 0;
    this.counted.clear();
    this.wave = -1;
    this.kills = 0;
    this.armor = 1;
    this.sinceHit = 99;
    this.down = 0;
    this.damageFlash = 0;
    this.reserves = RESERVES;
    this.lost = false;
    this.lostT = 0;
    this.waveT = 0;
    for (const m of this.scorch) this.group.remove(m);
    this.scorch.length = 0;
    this.events.emit('redeploy', { at: this.model.pos });
  }

  /** One drone at a point, flying a heading (scripted encounters). */
  spawnDrone(at: THREE.Vector3, heading: THREE.Vector3): Drone {
    const d = new Drone(at, heading);
    d.mode = 'attack';
    this.drones.push(d);
    this.hostiles.push(d);
    hazeAll(d.mesh, this.hazeUniforms);
    this.group.add(d.mesh);
    return d;
  }

  /** A frigate on patrol offshore of the suit. */
  spawnFrigate(): Frigate {
    const f = new Frigate(this.field, this.model.pos);
    this.ships.push(f);
    this.hostiles.push(...f.parts);
    hazeAll(f.mesh, this.hazeUniforms);
    this.group.add(f.mesh);
    return f;
  }

  /** Start the next wave, if one is on offer. */
  callWave(): void {
    if (!this.waveReady) return;
    this.waveT = 0;
    this.wave++;
    const w = WAVES[Math.min(this.wave, WAVES.length - 1)];
    const extra = Math.max(0, this.wave - (WAVES.length - 1));
    const n = w.drones + extra * 2;
    if (w.frigate || (extra > 0 && extra % 3 === 0)) this.spawnFrigate();
    // From inland, over the ridges, 2.6–3.5 km out (a few seconds' dash, not half a minute's wait)
    const base = Math.atan2(-1, 0.2) + (Math.random() - 0.5) * 1.2;
    for (let i = 0; i < n; i++) {
      const a = base + (i - n / 2) * 0.12;
      const r = 2600 + Math.random() * 900;
      const at = new THREE.Vector3(this.model.pos.x + Math.cos(a) * r, 0, this.model.pos.z + Math.sin(a) * r);
      at.y = Math.max(this.field.surfaceAt(at.x, at.z), 0) + 450 + Math.random() * 400;
      const d = new Drone(at, this.model.pos.clone().sub(at).setY(0));
      this.drones.push(d);
      this.hostiles.push(d);
      hazeAll(d.mesh, this.hazeUniforms);
      this.group.add(d.mesh);
    }
    for (let i = 0; i < w.sams + extra; i++) {
      const spot = this.samSpots.find((p) => !this.sams.some((s) => s.alive && s.pos.distanceTo(p) < 20));
      if (!spot) break;
      const s = new SamSite(spot, HOME);
      this.sams.push(s);
      this.hostiles.push(s);
      hazeAll(s.mesh, this.hazeUniforms);
      this.group.add(s.mesh);
    }
    this.events.emit('waveStart', { value: this.wave + 1 });
    this.events.emit('jarvis', { text: w.line });
  }

  update(dt: number, t: number, c: Controls, aim: THREE.Vector3, eye: THREE.Vector3): void {
    this.sinceHit += dt;
    this.shellCallT += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    if (this.lost) this.lostT += dt;
    else if (this.down > 0) {
      this.down -= dt;
      if (this.down <= 0) {
        this.armor = 0.5;
        this.events.emit('reboot', { at: this.model.pos });
        this.events.emit('jarvis', { text: 'Systems restored. Fifty percent armour.' });
      }
    } else if (this.sinceHit > 6) {
      this.armor = Math.min(1, this.armor + dt * 0.035);
    }

    // Waves only come when called (N): a clear sky just gets announced
    // (and a cleared wave earns back a reserve)
    if (this.wavesEnabled && !this.lost && this.wave >= 0 && !this.hostiles.some((h) => h.alive)) {
      this.waveT += dt;
      if (this.waveT > 1.5 && this.waveT - dt <= 1.5) {
        const earned = this.reserves < RESERVES;
        if (earned) this.reserves++;
        this.events.emit('waveClear', { value: this.wave + 1 });
        this.events.emit('jarvis', { text: `Area clear, sir.${earned ? ' A reserve is back online.' : ''} Next formation on your word.` });
      }
    }

    this.streaks.begin();
    this.weapons.update(dt, c, aim, eye, this.hostiles, this.down <= 0);
    for (const d of this.drones) {
      d.update(dt, t, this.player, this.ground, this.guns.rounds, this.missiles, this.particles, this.explosions, this.events);
      if (!d.flybyDone && d.alive && d.pos.distanceTo(this.model.pos) < 120) {
        d.flybyDone = true;
        this.events.emit('droneFlyby', { at: d.pos, value: d.vel.length() });
      }
      if (d.flybyDone && d.pos.distanceTo(this.model.pos) > 400) d.flybyDone = false;
    }
    for (const s of this.sams) s.update(dt, t, this.player, this.house, this.field, this.missiles, this.events, this.explosions, this.particles);
    for (const f of this.ships) {
      f.update(dt, t, this.player, this.field, this.guns.rounds, this.missiles, this.particles, this.explosions, this.events);
      f.collide(this.model.pos, this.model.vel);
    }
    this.guns.update(dt, this.player, this.ground, this.particles, this.streaks, this.events);
    this.missiles.update(dt, this.hostiles, this.player);
    // Kills: count, blow the SAMs (drones crash on their own)
    for (let i = this.hostiles.length - 1; i >= 0; i--) {
      const h = this.hostiles[i];
      if (!h.alive && !this.counted.has(h.id)) {
        this.counted.add(h.id);
        this.kills++;
        if (h.kind === 'sam') {
          this.explosions.blast(h.pos, 10, { debris: 14, burn: true });
          const sam = h as SamSite;
          sam.mesh.visible = false;
        } else if (h.kind === 'ship') {
          const part = h as ShipPart;
          part.ship.partDestroyed(part, this.explosions, this.events);
        } else {
          this.explosions.blast(h.pos, 4, { debris: 5, vel: h.vel.clone().multiplyScalar(0.3) });
        }
      }
    }
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.crashed || d.pos.y < -50) {
        this.group.remove(d.mesh);
        this.drones.splice(i, 1);
        this.hostiles.splice(this.hostiles.indexOf(d), 1);
      }
    }
    for (let i = this.sams.length - 1; i >= 0; i--) {
      const s = this.sams[i];
      if (!s.alive) {
        this.group.remove(s.mesh);
        this.sams.splice(i, 1);
        this.hostiles.splice(this.hostiles.indexOf(s), 1);
      }
    }
    // Ship parts leave the target list as they go; the ship stays until it's under
    for (let i = this.hostiles.length - 1; i >= 0; i--) if (this.hostiles[i].kind === 'ship' && !this.hostiles[i].alive) this.hostiles.splice(i, 1);
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const f = this.ships[i];
      if (f.sunk) {
        this.group.remove(f.mesh);
        this.ships.splice(i, 1);
      }
    }
    this.explosions.update(dt);
    this.streaks.end();
  }

  /**
   * Once the suit is posed for the frame: the player's shots leave their
   * hardware (muzzles where the suit is now, not a frame behind) and the
   * streaks are closed for drawing.
   */
  afterPose(): void {
    this.weapons.afterPose();
    this.streaks.end();
  }

  private readonly counted = new Set<number>();

  /** Enemy seekers on the suit right now. */
  get incoming(): number {
    return this.missiles.threats().length;
  }

  /** Where the launchers shelling the house are. */
  *shellers(): Generator<THREE.Vector3> {
    for (const s of this.sams) if (s.shelling) yield s.pos;
  }

  /** The house is being shelled: a launcher is laid on it or a round is on its way. */
  get houseUnderFire(): boolean {
    return this.sams.some((s) => s.shelling) || this.missiles.strikes().length > 0;
  }

  /** A round came down on (or short of) the house: fire and smoke, and soot where it hit the roof. */
  private houseStruck(at: THREE.Vector3): void {
    this.explosions.burn(at, 30, 4);
    const top = structureTop(this.field, at.x, at.z);
    if (top > -Infinity && at.y < top + 3) {
      const m = new THREE.Mesh(SCORCH_GEO, scorchMaterial());
      m.position.set(at.x, top + 0.04, at.z);
      m.rotation.y = Math.random() * Math.PI * 2;
      m.scale.setScalar(5 + Math.random() * 3);
      hazeAll(m, this.hazeUniforms);
      this.group.add(m);
      this.scorch.push(m);
      if (this.scorch.length > MAX_SCORCH) this.group.remove(this.scorch.shift()!);
    }
    if (this.shellCallT > 30) {
      this.shellCallT = 0;
      this.events.emit('jarvis', { text: 'They’re shelling the house, sir. Show them the suit and they’ll turn back on you.' });
    }
  }

  /** Where the radars holding the suit right now are (SAM trucks, the frigate's gun directors). */
  *trackers(): Generator<THREE.Vector3> {
    for (const s of this.sams) if (s.alive && s.track > 0.5) yield s.pos;
    for (const f of this.ships) if (!f.sinking) yield* f.trackers();
  }
}
