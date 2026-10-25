import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Particles } from '../fx/particles';
import type { EventBus } from '../sim/events';
import type { Explosions } from './explosions';
import { Missiles } from './missiles';
import type { Hostile, PlayerTarget } from './types';

// The rocket's glow draws itself on a canvas
const ctx = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A ship's worth of parts: the hull's capsule along Z, a launcher on its deck, a radar up the mast. */
function ship() {
  const whole = {};
  const taken = new Map<string, number>();
  const part = (label: string, pos: THREE.Vector3, radius: number, span?: [THREE.Vector3, THREE.Vector3]): Hostile => ({
    id: taken.size,
    kind: 'ship',
    label,
    whole,
    pos,
    vel: v(0, 0, 0),
    radius,
    span,
    hp: 1e6,
    maxHp: 1e6,
    alive: true,
    threatened: 0,
    damage: (amount) => (taken.set(label, (taken.get(label) ?? 0) + amount), false),
  });
  const vls = part('vls', v(0, 7.2, 30), 5);
  const radar = part('radar', v(0, 34.3, -6), 3.6);
  const hull = part('hull', v(0, 8, -2), 9, [v(0, 5, -56), v(0, 5, 56)]);
  taken.set('vls', 0).set('radar', 0).set('hull', 0);
  return { parts: [vls, radar, hull], vls, radar, hull, taken };
}

function missiles() {
  const stub = { emit() {}, burst() {}, blast() {} };
  return new Missiles(stub as unknown as Particles, stub as unknown as Explosions, { surface: () => 0, isWater: () => true }, stub as unknown as EventBus);
}

const player: PlayerTarget = { pos: v(0, 0, -5000), vel: v(0, 0, 0), alive: true, hit() {} };

function fly(ms: Missiles, hostiles: Hostile[]) {
  for (let i = 0; i < 600 && ms.live.length; i++) ms.update(1 / 60, hostiles, player);
}

describe('player missiles on a ship', () => {
  it('a seeker locked on the launcher, fired low off the beam, goes off on the launcher', () => {
    const s = ship();
    const ms = missiles();
    ms.launch({ team: 'player', from: v(400, 3, 30), vel: v(-60, 0, 0), target: s.vls });
    fly(ms, s.parts);
    expect(s.taken.get('vls')).toBeGreaterThan(120);
  });

  it('a burst just off the side splashes the hull', () => {
    const s = ship();
    const ms = missiles();
    ms.launch({ team: 'player', from: v(400, 3, 0), vel: v(-60, 0, 0), target: null, aimPoint: v(18, 1, 0) });
    fly(ms, s.parts);
    expect(s.taken.get('hull')).toBeGreaterThan(0);
  });

  it('splash reaches a small part measured from its skin, not its centre', () => {
    const s = ship();
    const ms = missiles();
    // Bursts 14 m below the radar's centre: past the blast's reach of its centre, inside it of its skin
    ms.launch({ team: 'player', from: v(0, 20.3, -400), vel: v(0, 0, 60), target: null, aimPoint: v(0, 20.3, -6) });
    fly(ms, [s.radar]);
    expect(s.taken.get('radar')).toBeGreaterThan(0);
  });
});
