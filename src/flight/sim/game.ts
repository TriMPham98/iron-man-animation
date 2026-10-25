import * as THREE from 'three';
import { Suit } from '../../suit/Suit';
import { Jets } from '../fx/jets';
import { Particles } from '../fx/particles';
import { SonicBoomFx } from '../fx/sonicBoom';
import { GVaporFx } from '../fx/gVapor';
import { WaterFx } from '../fx/water';
import { patchLogDepth } from '../render/depth';
import { PAD, PAD_R, PAD_Y } from '../world/house';
import { gradeLanding } from '../world/landingPad';
import { hazeAll } from '../render/haze';
import { createEyeClip, eyeClipAll } from '../render/eyeClip';
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
/** The pilot's eyes behind the faceplate (bind space). */
const EYE_AT = [0, 1.77, 0.07] as const;
/** Bind-space centre of the helmet shell and the radius that takes it all (m). */
const HELMET_CLIP_AT = [0, 1.73, 0.02] as const;
const HELMET_CLIP_R = 0.16;
/**
 * The pilot's neck and shoulders inside the collar (bind space, chest to
 * neck, and radius): with the helmet cut away, a look down went in at the
 * neck ring and on into the empty torso.
 */
const NECK_FROM = [0, 1.36, -0.02] as const;
const NECK_TO = [0, 1.52, -0.02] as const;
const NECK_R = 0.115;
const UP = new THREE.Vector3(0, 1, 0);
/** Auto-land is on offer within this far of the pad (m) and this high over it (m). */
export const AUTOLAND_RANGE = 300;
export const AUTOLAND_CEILING = 150;

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
  /** The helmet view's cut-away round the head (see eyeClip.ts). */
  private readonly eyeClip = createEyeClip();
  private readonly _aim = new THREE.Vector3();
  private controls: Controls | null = null;
  private wasGrounded = true;
  /** Vapour cone and shock ring at Mach 1 (and when, with hysteresis). */
  readonly sonic: SonicBoomFx;
  readonly gVapor: GVaporFx;
  /** Splashes, wakes and water running off the armour. */
  readonly water: WaterFx;
  private wasBoosting = false;
  /** The pad capture is holding (with hysteresis, for the cue). */
  private padHeld = false;
  /** The suit is flying itself down onto the pad (L: {@link toggleAutoLand}). */
  autoLand = false;
  /** The pilot has let go since auto-land took over (from then on a hand on the controls takes it back). */
  private autoLandLetGo = false;
  private frameDt = 0;
  /** 0–1: how cleanly the air runs head-to-toe down the body (the vapour only forms then). */
  private cleanFlow = 1;
  private readonly _owed = new THREE.Vector3();
  private readonly _axis = new THREE.Vector3();
  private readonly _clip = new THREE.Vector3();
  private readonly _neckTo = new THREE.Vector3();
  /** Seals the collar in the helmet view (dark, like the suit's lining). */
  private readonly neck = new THREE.Mesh(
    new THREE.CapsuleGeometry(NECK_R, NECK_TO[1] - NECK_FROM[1], 6, 16),
    new THREE.MeshStandardMaterial({ color: 0x14100f, metalness: 0.6, roughness: 0.55 }),
  );

  constructor(
    readonly world: World,
    readonly suit: Suit,
    readonly scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    // (the sea's swell at the clock the ocean is drawn at, and its foam map)
    this.ground = groundProbe(world.field, () => world.time, (ax, az, bx, bz, r, amount, inner) => world.ocean.foam(ax, az, bx, bz, r, amount, inner));
    this.model = new FlightModel(this.ground);
    this.model.landingAid = { x: PAD.x, z: PAD.y, y: PAD_Y };
    this.rig = new CameraRig(camera);
    this.particles = new Particles(world.atmosphere.uniforms);
    this.sonic = new SonicBoomFx(world.atmosphere.uniforms);
    scene.add(this.sonic.group);
    this.gVapor = new GVaporFx(suit, world.atmosphere.uniforms);
    scene.add(this.gVapor.group);
    this.water = new WaterFx(suit);
    this.combat = new Combat(world.field, this.ground, this.model, suit, this.particles, this.events, (amount, at) => {
      this.rig.shake += amount > 15 ? 1.4 : 0.25;
      this.particles.burst('spark', at, 6, 10, undefined, 1);
    }, world.atmosphere.uniforms);
    this.neck.visible = false;
    this.neck.receiveShadow = true;
    scene.add(suit.group, this.neck, this.particles.group, this.jets.group, this.combat.group);
    patchLogDepth(suit.group);
    patchLogDepth(this.neck);
    hazeAll(suit.group, world.atmosphere.uniforms);
    hazeAll(this.neck, world.atmosphere.uniforms);
    eyeClipAll(suit.group, this.eyeClip);
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
    this.stopAutoLand(false);
    this.model.placeOnGround(PAD.x, PAD.y, heading);
    this.rig.lookHeading(heading, -0.05);
  }

  /** The suit was lost: a fresh run from the pad, wave one next. */
  redeploy(): void {
    this.combat.resetRun();
    this.reset();
    this.events.emit('jarvis', { text: 'Mark III redeployed. Full armour, one reserve, sir.' });
  }

  applyControls(c: Controls): void {
    this.controls = c;
    this.rig.turn(c.aimYaw, c.aimPitch);
    // Boosting home under auto-land, the look swings round after the travel,
    // so the chase stays behind the suit through the turn and the way in
    // (and the hover at the end faces the pad, not back along the pass)
    // On the run-in the suit turns to face the pad, and the look follows it round
    const m = this.model;
    const homing = m.homing && Math.hypot(m.vel.x, m.vel.z) > 5;
    if (this.autoLand && (homing || !m.homing)) {
      const f = this.rig.aim(this._aim);
      const off = (homing ? Math.atan2(m.vel.x, m.vel.z) : m.heading) - Math.atan2(f.x, f.z);
      this.rig.turn(Math.atan2(Math.sin(off), Math.cos(off)) * (1 - Math.exp(-this.frameDt / (homing ? 0.5 : 0.8))), 0);
    }
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
    if (c.pressed.has('KeyL')) this.toggleAutoLand();
    // A hand on the stick, the throttle or the boost takes it back (once
    // they've been let go: whatever was held as L went in doesn't count)
    if (this.autoLand) {
      const hands = Math.abs(c.lateral) > 0.3 || Math.abs(c.vertical) > 0.5 || Math.abs(c.forward) > 0.3 || Math.abs(c.throttle) > 0.3 || c.boost;
      if (!hands) this.autoLandLetGo = true;
      else if (this.autoLandLetGo) this.stopAutoLand(true);
    }
    if (this.autoLand) {
      // (the brakes and palms take the speed off a fast arrival; slower,
      // they'd only drag against the run in)
      i.lateral = i.vertical = i.throttle = i.forward = 0;
      i.boost = false;
      i.brake = this.model.speed > 45;
    }
    this.model.autoLand = this.autoLand;
  }

  /** Auto-land can be handed the suit now: in the air, near the pad, systems up. */
  get autoLandReady(): boolean {
    const m = this.model;
    if (this.autoLand || m.grounded || m.power < 0.5 || this.combat.down > 0) return false;
    const h = m.pos.y - m.hipHeight() - PAD_Y;
    return Math.hypot(m.pos.x - PAD.x, m.pos.z - PAD.y) < AUTOLAND_RANGE && h > -1 && h < AUTOLAND_CEILING;
  }

  /** Hand the suit to auto-land (or take it back). */
  toggleAutoLand(): void {
    if (this.autoLand) this.stopAutoLand(true);
    else if (this.autoLandReady) {
      this.autoLand = true;
      this.autoLandLetGo = false;
      this.events.emit('autoLand', { at: this.model.pos, value: 1 });
      this.events.emit('jarvis', { text: 'Auto-land engaged. Bringing you in, sir.' });
    }
  }

  private stopAutoLand(byPilot: boolean): void {
    if (!this.autoLand) return;
    this.autoLand = false;
    this.model.autoLand = false;
    this.events.emit('autoLand', { at: this.model.pos, value: 0 });
    if (byPilot) this.events.emit('jarvis', { text: 'Auto-land off. You have control.' });
  }

  update(dt: number): void {
    this.time += dt;
    this.frameDt = dt;
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
    // Down (or knocked out of the sky): it's done
    if (this.autoLand && (this.model.grounded || this.combat.down > 0)) this.stopAutoLand(!this.model.grounded);
    const aim = this.rig.aim(this._aim);
    // Weapons sight from the pilot's eye; a planted camera isn't where he is
    const eye = this.rig.mode === 'flyby' || this.rig.mode === 'attract' ? this.head : this.rig.camera.position;
    if (this.controls) this.combat.update(dt, this.time, this.controls, aim, eye);
    // The physics runs on a fixed 120 Hz clock, so a rendered frame lands 0,
    // 1, 2 or 3 steps on from the last: drawn raw, the suit (and anything
    // watching it, like the cinematic cameras) judders by whole steps — a
    // couple of metres at speed. Draw the frame at the render clock instead:
    // carry the body on by the time the physics still owes it (< 1 step),
    // then hand the true state back to the physics
    // (the shift is kept, not re-derived from the velocity on the way back:
    // a shot's recoil lands in between, and undoing it at the new velocity
    // left the suit a few mm off every time — a creep under sustained fire)
    const owed = this._owed.copy(this.model.vel).multiplyScalar(this.acc);
    this.model.pos.add(owed);
    this.driver.update(dt, this.suit, this.model, aim, this.combat.weapons.arms);
    // Hero landing: the fist hits the ground a beat after the boots
    const strike = this.driver.strike;
    if (strike) {
      this.driver.strike = null;
      this.rig.shake += 0.7;
      this.particles.burst('dust', strike.at, 12, 6, new THREE.Vector3(0, 0.6, 0), 1, { scale: 0.9 });
      this.particles.burst('spark', strike.at, 14, 6, new THREE.Vector3(0, 1, 0), 1);
    }
    this.suit.update(dt);
    this.world.pad.update(dt, this.model);
    // Shots leave the suit's hardware where it is drawn this frame
    if (this.controls) this.combat.afterPose();
    this.suit.boneWorldPoint('head', EYE_AT, this.head);
    this.rig.update(dt, this.model, this.head, this.ground);
    // The suit's own shadow box rides with it
    const sun = this.world.atmosphere.sun;
    sun.target.position.copy(this.model.pos);
    sun.position.copy(this.model.pos).addScaledVector(this.world.atmosphere.uniforms.uSunDir.value as THREE.Vector3, 120);
    // In the helmet the pilot sees his own suit (arms, chest, boots) from
    // outside only, with the helmet itself cut away round the eye
    const helmet = this.rig.mode === 'helmet';
    this.suit.boneWorldPoint('head', HELMET_CLIP_AT, this._clip);
    this.eyeClip.uEyeClip.value.set(this._clip.x, this._clip.y, this._clip.z, helmet ? HELMET_CLIP_R : 0);
    this.neck.visible = helmet;
    if (helmet) {
      const a = this.suit.boneWorldPoint('chest', NECK_FROM, this.neck.position);
      const b = this.suit.boneWorldPoint('neck', NECK_TO, this._neckTo);
      b.sub(a);
      a.addScaledVector(b, 0.5);
      this.neck.quaternion.setFromUnitVectors(UP, b.normalize());
    }
    const o = this.driver.outputs;
    this.jets.eye = helmet ? this.rig.camera.position : null;
    this.jets.update(dt, this.suit, { bootL: o.bootL, bootR: o.bootR, palmL: o.palmL, palmR: o.palmR, palmBoost: o.palmBoost }, this.ground, this.particles, this.model.vel);
    this.water.update(dt, this.model, this.particles);
    this.particles.update(dt, this.rig.camera);
    this.sonic.update(dt, this.model.pos, this.model.vel, this.model.speed / SPEED_OF_SOUND, this.cleanFlow);
    this.gVapor.group.visible = !helmet;
    this.gVapor.update(dt, this.suit, this.rig.camera, this.model.gLoad, this.model.speed, this.model.flightness, this.model.pos.y);
    this.model.pos.sub(owed);
  }

  /** Take-off, boost and the sound barrier. */
  private watchFlight(): void {
    const m = this.model;
    if (this.wasGrounded && !m.grounded) this.events.emit('takeoff', { at: m.pos });
    this.wasGrounded = m.grounded;
    if (m.boosting !== this.wasBoosting) this.events.emit(m.boosting ? 'boostStart' : 'boostEnd', { at: m.pos });
    this.wasBoosting = m.boosting;
    const held = m.padPull > (this.padHeld ? 0.3 : 0.7);
    if (held !== this.padHeld) this.events.emit('padCapture', { at: m.pos, value: held ? 1 : 0 });
    this.padHeld = held;
    if (this.sonic.crossed(m.speed / SPEED_OF_SOUND, this.frameDt)) {
      // The pilot still doesn't hear his own boom; the shock does jolt the
      // picture, the same kick as the first flight sim
      this.events.emit('sonicBoom', { at: m.pos, value: m.speed });
      this.rig.shake += 1.6;
    }
    // Transonic: the vapour cone (SonicBoomFx) clings to the suit; a few
    // wisps tear off its rim. Only with the body flying head first into the
    // air: a reversal swings it broadside and tail first while the speed it
    // spends on the turn bleeds back through the barrier, and a cone and
    // wisps laid along the travel then stood off the suit like a parachute
    const align = m.speed > 1 ? m.thrustAxis(this._axis).dot(m.vel) / m.speed : 1;
    this.cleanFlow = THREE.MathUtils.smoothstep(align, 0.8, 0.95);
    const trans = Math.exp(-Math.pow((m.mach - 0.975) / 0.035, 2)) * Math.exp(-Math.max(0, m.pos.y) / 3500) * this.cleanFlow;
    if (trans > 0.15 && Math.random() < trans * 0.3) {
      const f = m.vel.clone().normalize();
      const a = new THREE.Vector3(0, 1, 0).cross(f).normalize();
      const b = new THREE.Vector3().crossVectors(f, a);
      for (let i = 0; i < 6; i++) {
        const t = Math.random() * Math.PI * 2;
        const r = a.clone().multiplyScalar(Math.cos(t)).addScaledVector(b, Math.sin(t));
        this.particles.emit('vapor', m.pos.clone().addScaledVector(r, 0.9 + Math.random() * 0.6).addScaledVector(f, -0.3), m.vel.clone().multiplyScalar(0.92), { scale: 1.6 * trans });
      }
    }
    // (high-g vapour off the back and the tips: GVaporFx)
  }

  private onContact(): void {
    const m = this.model;
    if (m.contact === 'none') return;
    // (the ground never hurts the suit: every hard arrival is a hero landing)
    this.events.emit(m.contact, { at: m.pos, value: m.impactSpeed });
    const below = m.pos.clone();
    below.y = this.ground.surface(m.pos.x, m.pos.z) + 0.1;
    if (m.contact === 'heroLanding') {
      // Harder the arrival, the bigger the ring
      const k = THREE.MathUtils.clamp((m.impactSpeed - 7) / 30, 0, 1);
      this.rig.shake += 1.2;
      // A ring of dust blown flat off the impact, low and quick to settle
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        this.particles.emit('dust', below, new THREE.Vector3(Math.cos(a) * 16, 0.4, Math.sin(a) * 16), { scale: 0.55 + 0.4 * k, life: 0.6 + 0.4 * k });
      }
      this.particles.burst('spark', below, 18, 7, new THREE.Vector3(0, 0.8, 0), 1);
    } else if (m.contact === 'splash') {
      this.rig.shake += Math.min(1.5, m.impactSpeed / 25);
      this.water.plunge(below, m.impactSpeed, m.impactVel, this.ground, this.particles);
    } else if (m.contact === 'skip') {
      this.rig.shake += Math.min(0.8, m.impactSpeed / 30);
      this.water.skip(below, m.impactSpeed, m.impactVel, this.ground, this.particles);
    } else if (m.contact === 'touchdown') {
      this.particles.burst('dust', below, 10, 5, new THREE.Vector3(0, 0.2, 0), 1);
    }
    if (m.contact === 'landed' || m.contact === 'touchdown' || m.contact === 'heroLanding') this.gradePad(below);
  }

  /** Set down on the pad: graded on how near its centre the boots came down. */
  private gradePad(below: THREE.Vector3): void {
    const m = this.model;
    const offset = Math.hypot(m.pos.x - PAD.x, m.pos.z - PAD.y);
    if (offset >= PAD_R || Math.abs(below.y - 0.1 - PAD_Y) > 0.05) return;
    const grade = gradeLanding(offset);
    this.world.pad.landed(grade);
    this.events.emit('padLanding', { at: m.pos, value: offset, text: grade });
    if (grade === 'onPad') return;
    // The boots' wash blown flat across the deck, out from the mark
    const n = grade === 'bullseye' ? 14 : 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.particles.emit('dust', below, new THREE.Vector3(Math.cos(a) * 12, 0.2, Math.sin(a) * 12), { scale: 0.3, life: 0.4 });
    }
    if (grade === 'bullseye') {
      this.rig.shake += 0.35;
      this.particles.burst('spark', below, 10, 4, new THREE.Vector3(0, 1, 0), 1);
    }
  }
}
