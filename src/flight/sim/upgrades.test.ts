import { describe, expect, it } from 'vitest';
import type { SimEvent, SimEventKind } from './events';
import { AWARD, LANDING_MIN_AIR, STOCK_SPEC, UPGRADES, Upgrades, type Store } from './upgrades';

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const ev = (kind: SimEventKind, t = 0, init: Partial<SimEvent> = {}): SimEvent => ({ kind, t, ...init });
const rich = (rd = 1e6) => {
  const u = new Upgrades(memory());
  u.earn(rd, 'test');
  return u;
};

describe('Upgrades', () => {
  it('starts as the stock suit: nothing fitted, the spec untouched', () => {
    const u = new Upgrades(memory());
    expect(u.spec).toEqual(STOCK_SPEC());
    expect(u.fitted).toBe(0);
  });

  it('buys an upgrade once, for its price, and fits it', () => {
    const cost = UPGRADES.find((x) => x.id === 'repulsors')!.cost;
    const u = rich(cost);
    expect(u.affordable).toBe(true);
    expect(u.buy('repulsors')).toBeNull();
    expect(u.state.rd).toBe(0);
    expect(u.state.owned.repulsors).toBe(true);
    expect(u.spec.repulsorDamage).toBeCloseTo(1.35);
    expect(u.fitted).toBe(1);
    expect(u.buy('repulsors')).toBe('owned');
    expect(u.buy('armour')).toBe('cost');
    expect(u.affordable).toBe(false);
  });

  it('makes every upgrade count, and only touches the spec once fitted', () => {
    for (const up of UPGRADES) {
      expect(up.stats.some(([, stock, fitted]) => stock !== fitted), up.id).toBe(true);
      const s = STOCK_SPEC();
      up.apply(s);
      expect(s, up.id).not.toEqual(STOCK_SPEC());
    }
  });

  it('keeps itself between sessions, and cleans up a bad or tiered save', () => {
    const store = memory();
    const a = new Upgrades(store);
    a.earn(500, 'x');
    a.buy('propulsion');
    const b = new Upgrades(store);
    expect(b.state.rd).toBe(100);
    expect(b.state.owned.propulsion).toBe(true);
    expect(b.spec.boostSpeed).toBeCloseTo(1.25);
    store.setItem('mk3-flight-rd', JSON.stringify({ rd: -4, owned: { armour: 3, flares: 0, bogus: 3 }, on: { armour: 2 } }));
    const c = new Upgrades(store);
    expect(c.state.rd).toBe(0);
    expect(c.state.owned.armour).toBe(true);
    expect(c.state.owned.flares).toBe(false);
    expect('bogus' in c.state.owned).toBe(false);
    store.setItem('mk3-flight-rd', '{nope');
    expect(new Upgrades(store).state.rd).toBe(0);
  });

  it('pays for kills, clears (half again untouched), and decoys', () => {
    const u = new Upgrades(memory());
    const got: string[] = [];
    u.onAward = (p, why) => got.push(`${p} ${why}`);
    u.event(ev('destroyed', 0, { text: 'drone' }));
    u.event(ev('destroyed', 0, { text: 'sam' }));
    u.event(ev('destroyed', 0, { text: 'frigate' }));
    u.event(ev('waveStart', 0, { value: 2 }));
    u.event(ev('waveClear', 0, { value: 2 }));
    u.event(ev('waveStart', 0, { value: 3 }));
    u.event(ev('hitArmor', 0, { value: 5 }));
    u.event(ev('waveClear', 0, { value: 3 }));
    u.event(ev('missileDecoyed'));
    expect(u.state.rd).toBe(AWARD.drone + AWARD.sam + AWARD.frigate + Math.round((AWARD.waveBase + AWARD.wave * 2) * 1.5) + AWARD.waveBase + AWARD.wave * 3 + AWARD.decoy);
    expect(got[0]).toBe(`${AWARD.drone} DRONE DOWN`);
  });

  it('pays a pad landing once a flight, and only after real flying', () => {
    const u = new Upgrades(memory());
    u.event(ev('takeoff', 0));
    u.event(ev('padLanding', 5, { text: 'bullseye' }));
    expect(u.state.rd).toBe(0);
    u.event(ev('takeoff', 10));
    u.event(ev('padLanding', 10 + LANDING_MIN_AIR, { text: 'bullseye' }));
    expect(u.state.rd).toBe(AWARD.bullseye);
    u.event(ev('padLanding', 100, { text: 'bullseye' }));
    expect(u.state.rd).toBe(AWARD.bullseye);
    // Auto-land flies it, so it doesn't pay
    u.event(ev('takeoff', 200));
    u.event(ev('autoLand', 220, { value: 1 }));
    u.event(ev('padLanding', 300, { text: 'bullseye' }));
    expect(u.state.rd).toBe(AWARD.bullseye);
  });

  it('pays the barrier once a flight', () => {
    const u = new Upgrades(memory());
    u.event(ev('takeoff'));
    u.event(ev('sonicBoom'));
    u.event(ev('sonicBoom'));
    expect(u.state.rd).toBe(AWARD.sonicBoom);
  });
});
