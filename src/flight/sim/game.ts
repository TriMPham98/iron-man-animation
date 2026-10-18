import * as THREE from 'three';
import { Suit } from '../../suit/Suit';
import { Jets } from '../fx/jets';
import { Particles } from '../fx/particles';
import { patchLogDepth } from '../render/depth';
import { PAD } from '../world/house';
import { hazeAll } from '../render/haze';
import type { World } from '../world/world';
import { CameraRig } from './cameraRig';
import { EMPTY_INPUT, FlightModel, type FlightInput } from './flightModel';
import { groundProbe } from './ground';
import type { Controls } from './input';
import { SuitDriver } from './suitDriver';
import { Combat } from '../combat/combat';
import { EventBus } from './events';
import { SPEED_OF_SOUND } from '../world/config';

/** Physics runs at a fixed rate whatever the display does. */
export const PHYSICS_HZ = 120;

/**
 * One flight: the suit, its flight model and body language, the camera,
 * and everything it leaves in the air. Stepped by the frame loop.
 */
export class Game {
  readonly model: FlightModel;
  readonly driver = new SuitDriver();
  readonly rig: CameraRig;
  readonly particles: Particles;
  readonly jets = new Jets();
  readonly ground: ReturnType<typeof groundProbe>;
  readonly input: FlightInput = EMPTY_INPUT();
  readonly events = new EventBus();
  readonly combat: Combat;
  time = 0;
  private acc = 0;
  readonly head = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();
  private controls: Controls | null = null;
  private wasGrounded = true;
  private wasSupersonic = false;
  private wasBoosting = false;

  constructor(
    readonly world: World,
    readonly suit: Suit,
    readonly scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    this.ground = groundProbe(world.field);
    this.model = new FlightModel(this.ground);
    this.rig = new CameraRig(camera);
    this.particles = new Particles(world.atmosphere.uniforms);
    this.combat = new Combat(world.field, this.ground, this.model, suit, this.particles, this.events, (amount, at) => {
      this.rig.shake += amount > 15 ? 1.4 : 0.25;
      this.particles.burst('spark', at, 6, 10, undefined, 1);
    }, world.atmosphere.uniforms);
    scene.add(suit.group, this.particles.group, this.jets.group, this.combat.group);
    patchLogDepth(suit.group);
    hazeAll(suit.group, world.atmosphere.uniforms);
    suit.forEachMesh((m) => {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const lit = mats.every((x) => (x as THREE.MeshStandardMaterial).isMeshStandardMaterial && !x.transparent);
      m.castShadow = lit;
      m.receiveShadow = lit;
    });
    suit.showFinal();
    suit.setSystemsPower({ reactor: 1, eyes: 1, repulsors: 1 });
    this.reset();
  }

  /** Back on the terrace by the house, facing the sea. */
  reset(): void {
    // Heading toward the sun-side horizon over the water (south-west)
    const heading = Math.atan2(-0.55, 1);
    this.model.placeOnGround(PAD.x, PAD.y, heading);
    this.rig.lookHeading(heading, -0.05);
  }

  applyControls(c: Controls): void {
    this.controls = c;
    this.rig.turn(c.aimYaw, c.aimPitch);
    this.rig.zoom = THREE.MathUtils.clamp(this.rig.zoom + c.zoom * 0.08, 0.6, 2.2);
    const i = this.input;
    i.aim.copy(this.rig.aim(this._aim));
    i.lateral = c.lateral;
    i.vertical = c.vertical;
    i.throttle = c.throttle;
    i.boost = c.boost;
    i.brake = c.brake;
    i.stance = this.combat.weapons.stance;
    // Rebooting: the stick is dead
    if (this.combat.down > 0) {
      i.vertical = i.lateral = i.throttle = 0;
      i.boost = i.brake = false;
    }
    // Backing up in a hover: S with the throttle already closed
    i.forward = c.forward + (c.throttle < 0 && this.model.speedCmd < 1 ? -1 : 0);
  }

  update(dt: number): void {
    this.time += dt;
    this.events.time = this.time;
    this.acc += dt;
    this.model.power += ((this.combat.down > 0 ? 0 : 1) - this.model.power) * (1 - Math.exp(-dt / 0.25));
    const h = 1 / PHYSICS_HZ;
    let steps = 0;
    while (this.acc >= h && steps < 12) {
      this.model.step(h, this.input);
      this.onContact();
      this.acc -= h;
      steps++;
    }
    if (steps >= 12) this.acc = 0;

    this.watchFlight();
    const aim = this.rig.aim(this._aim);
    // Weapons sight from the pilot's eye; a planted camera isn't where he is
    const eye = this.rig.mode === 'flyby' || this.rig.mode === 'attract' ? this.head : this.rig.camera.position;
    if (this.controls) this.combat.update(dt, this.time, this.controls, aim, eye);
    this.driver.update(dt, this.suit, this.model, aim, this.combat.weapons.arms);
    this.suit.update(dt);
    this.suit.boneWorldPoint('head', [0, 1.72, 0.04], this.head);
    this.rig.update(dt, this.model, this.head, this.ground);
    // The suit's own shadow box rides with it
    const sun = this.world.atmosphere.sun;
    sun.target.position.copy(this.model.pos);
    sun.position.copy(this.model.pos).addScaledVector(this.world.atmosphere.uniforms.uSunDir.value as THREE.Vector3, 120);
    this.suit.group.visible = this.rig.mode !== 'helmet';
    const o = this.driver.outputs;
    this.jets.update(dt, this.suit, { bootL: o.bootL, bootR: o.bootR, palmL: o.palmL, palmR: o.palmR }, this.ground, this.particles, this.model.vel);
    this.particles.update(dt, this.rig.camera);
  }

  /** Take-off, boost and the sound barrier. */
  private watchFlight(): void {
    const m = this.model;
    if (this.wasGrounded && !m.grounded) this.events.emit('takeoff', { at: m.pos });
    this.wasGrounded = m.grounded;
    if (m.boosting !== this.wasBoosting) this.events.emit(m.boosting ? 'boostStart' : 'boostEnd', { at: m.pos });
    this.wasBoosting = m.boosting;
    const sup = m.speed > SPEED_OF_SOUND * 1.0;
    if (sup && !this.wasSupersonic) {
      this.events.emit('sonicBoom', { at: m.pos, value: m.speed });
      this.rig.shake += 1.6;
      // Shock collar: a ring of vapour snapping off the suit
      const f = m.vel.clone().normalize();
      const a = new THREE.Vector3(0, 1, 0).cross(f).normalize();
      const b = new THREE.Vector3().crossVectors(f, a);
      for (let i = 0; i < 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        const r = a.clone().multiplyScalar(Math.cos(t)).addScaledVector(b, Math.sin(t));
        this.particles.emit('vapor', m.pos.clone().addScaledVector(r, 1.4), r.multiplyScalar(18).addScaledVector(m.vel, 0.85), { scale: 3, life: 2.4 });
      }
    }
    this.wasSupersonic = sup ? true : m.speed > SPEED_OF_SOUND * 0.97 && this.wasSupersonic;
    // Transonic: a vapour cone clings to the suit
    const trans = Math.exp(-Math.pow((m.mach - 1) / 0.05, 2));
    if (trans > 0.15 && Math.random() < trans) {
      const f = m.vel.clone().normalize();
      const a = new THREE.Vector3(0, 1, 0).cross(f).normalize();
      const b = new THREE.Vector3().crossVectors(f, a);
      for (let i = 0; i < 6; i++) {
        const t = Math.random() * Math.PI * 2;
        const r = a.clone().multiplyScalar(Math.cos(t)).addScaledVector(b, Math.sin(t));
        this.particles.emit('vapor', m.pos.clone().addScaledVector(r, 0.9 + Math.random() * 0.6).addScaledVector(f, -0.3), m.vel.clone().multiplyScalar(0.92), { scale: 1.6 * trans });
      }
    }
    // High g: wingtip-like vortices off the hands and feet
    if (m.gLoad > 4.5 && m.speed > 120) {
      for (const p of this.suit.palms) {
        const at = this.suit.boneWorldPoint(p.bone, p.at, new THREE.Vector3());
        this.particles.emit('vapor', at, m.vel.clone().multiplyScalar(0.9), { scale: 0.5, life: 1.2 });
      }
    }
  }

  private onContact(): void {
    const m = this.model;
    if (m.contact === 'none') return;
    this.events.emit(m.contact, { at: m.pos, value: m.impactSpeed });
    // Hard hits cost armour (the suit shrugs off a lot)
    if (m.contact === 'impact' && m.impactSpeed > 25) {
      this.combat.armor = Math.max(0.05, this.combat.armor - (m.impactSpeed - 25) / 220);
      this.combat.damageFlash = Math.min(1, this.combat.damageFlash + 0.5);
    }
    const below = m.pos.clone();
    below.y = this.ground.surface(m.pos.x, m.pos.z) + 0.1;
    if (m.contact === 'heroLanding') {
      this.rig.shake += 1.2;
      // A ring of dust blown flat off the impact, low and quick to settle
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        this.particles.emit('dust', below, new THREE.Vector3(Math.cos(a) * 16, 0.4, Math.sin(a) * 16), { scale: 0.55, life: 0.6 });
      }
      this.particles.burst('spark', below, 18, 7, new THREE.Vector3(0, 0.8, 0), 1);
    } else if (m.contact === 'impact') {
      this.rig.shake += Math.min(2, m.impactSpeed / 30);
      this.particles.burst('dust', below, 14, 8, new THREE.Vector3(0, 0.5, 0), 1, { scale: 1.3 });
      this.particles.burst('spark', below, 24, 12, new THREE.Vector3(0, 0.6, 0), 1);
    } else if (m.contact === 'splash') {
      this.rig.shake += Math.min(1.5, m.impactSpeed / 25);
      const n = Math.round(10 + m.impactSpeed);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 2 + Math.random() * m.impactSpeed * 0.4;
        this.particles.emit('spray', below, new THREE.Vector3(Math.cos(a) * s, 4 + Math.random() * m.impactSpeed * 0.5, Math.sin(a) * s), { scale: 1.4 });
      }
      this.particles.burst('mist', below, 8, 3, new THREE.Vector3(0, 0.6, 0), 1, { scale: 2 });
    } else if (m.contact === 'touchdown') {
      this.particles.burst('dust', below, 10, 5, new THREE.Vector3(0, 0.2, 0), 1);
    }
  }
}
