import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import type { Controls } from '../sim/input';
import type { Suit } from '../../suit/Suit';
import { HOME, type Heightfield } from '../world/heightfield';
import { Drone, Guns } from './drones';
import { Explosions, type SurfaceQuery } from './explosions';
import { Missiles } from './missiles';
import { PlayerWeapons } from './playerWeapons';
import { SamSite, samSites } from './sams';
import type { Hostile, PlayerTarget } from './types';
import { hazeAll } from '../render/haze';

/**
 * The fight: the suit's armour and the hostiles that wear it down, in
 * escalating waves. Free flight until the pilot calls the first wave (or
 * flies for a while), then drones from over the ridges, then the SAM
 * sites wake up. Armour regenerates out of combat; at zero the suit drops
 * dead for a few seconds and reboots in the air.
 */

const WAVES: ReadonlyArray<{ drones: number; sams: number; line: string }> = [
  { drones: 3, sams: 0, line: 'Sir, three bogeys coming over the ridge. Drone signatures.' },
  { drones: 5, sams: 0, line: 'Five more inbound. They are learning.' },
  { drones: 4, sams: 2, line: 'Surface-to-air sites are lighting up on the ridgeline. I suggest the flares.' },
  { drones: 7, sams: 3, line: 'A larger formation, sir. Shall I alert the authorities? No? Very well.' },
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
  private waveT = 0;
  private freeFlight = 0;
  private readonly samSpots: THREE.Vector3[];
  private readonly player: PlayerTarget;

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
          events.emit('jarvis', { text: 'Armour critical. Rerouting power. Hold on, sir.' });
        }
      },
    };
  }

  get playerTarget(): PlayerTarget {
    return this.player;
  }

  /** Waves start by themselves after a minute of flight (off for scripted runs). */
  autoWaves = true;

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

  /** Start the next wave now. */
  callWave(): void {
    this.wave++;
    const w = WAVES[Math.min(this.wave, WAVES.length - 1)];
    const extra = Math.max(0, this.wave - (WAVES.length - 1));
    const n = w.drones + extra * 2;
    // From inland, over the ridges, 5–7 km out
    const base = Math.atan2(-1, 0.2) + (Math.random() - 0.5) * 1.2;
    for (let i = 0; i < n; i++) {
      const a = base + (i - n / 2) * 0.12;
      const r = 5200 + Math.random() * 1500;
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
      const s = new SamSite(spot);
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
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    if (this.down > 0) {
      this.down -= dt;
      if (this.down <= 0) {
        this.armor = 0.5;
        this.events.emit('reboot', { at: this.model.pos });
        this.events.emit('jarvis', { text: 'Systems restored. Fifty percent armour.' });
      }
    } else if (this.sinceHit > 6) {
      this.armor = Math.min(1, this.armor + dt * 0.035);
    }

    // Waves: the first comes after a minute of free flight (or on N)
    const active = this.hostiles.some((h) => h.alive);
    if (!this.autoWaves) {
      // Scripted: no waves
    } else if (this.wave < 0) {
      if (!this.model.grounded) this.freeFlight += dt;
      if (this.freeFlight > 75) this.callWave();
    } else if (!active) {
      this.waveT += dt;
      if (this.waveT > 1.5 && this.waveT - dt <= 1.5) {
        this.events.emit('waveClear', { value: this.wave + 1 });
        this.events.emit('jarvis', { text: 'Area clear, sir. Next formation in twenty seconds.' });
      }
      if (this.waveT > 22) {
        this.waveT = 0;
        this.callWave();
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
    for (const s of this.sams) s.update(dt, t, this.player, this.field, this.missiles, this.events, this.explosions);
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
    this.explosions.update(dt);
    this.streaks.end();
  }

  private readonly counted = new Set<number>();

  /** Enemy seekers on the suit right now. */
  get incoming(): number {
    return this.missiles.threats().length;
  }
}
