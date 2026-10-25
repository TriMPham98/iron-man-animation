import { describe, expect, it } from 'vitest';
import type { SimEvent, SimEventKind } from './events';
import { AWARD, BASE_POWER, LANDING_MIN_AIR, MAX_TIER, REACTOR_POWER, STOCK_SPEC, TIER_COST, TRACKS, Upgrades, type Store } from './upgrades';

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
  it('starts as the stock suit: every track at tier 0, the spec untouched', () => {
    const u = new Upgrades(memory());
    expect(u.spec).toEqual(STOCK_SPEC());
    expect(u.power).toBe(BASE_POWER);
    expect(u.mark).toBe('III');
    for (const t of TRACKS) {
      const s = STOCK_SPEC();
      t.apply(s, 0);
      expect(s).toEqual(STOCK_SPEC());
    }
  });

  it('buys a tier for its price and switches it on', () => {
    const u = rich(TIER_COST[0]);
    expect(u.buy('repulsors')).toBeNull();
    expect(u.state.rd).toBe(0);
    expect(u.state.owned.repulsors).toBe(1);
    expect(u.state.on.repulsors).toBe(1);
    expect(u.spec.repulsorDamage).toBeCloseTo(1.1);
    expect(u.buy('repulsors')).toBe('cost');
  });

  it('stops at the top tier', () => {
    const u = rich();
    for (let i = 0; i < MAX_TIER; i++) expect(u.buy('sensors')).toBeNull();
    expect(u.buy('sensors')).toBe('max');
    expect(u.cost('sensors')).toBeNull();
  });

  it('holds the build to the power budget; reactor tiers raise it', () => {
    const u = rich();
    // Fill the budget (Marks add a unit each as tiers are bought)
    const order = ['armour', 'repulsors', 'missiles', 'launchers', 'flares', 'propulsion', 'sensors'] as const;
    for (const id of order) for (let i = 0; i < MAX_TIER; i++) u.buy(id);
    expect(u.powerUsed).toBe(u.power);
    expect(u.tiersOwned).toBeGreaterThan(u.powerUsed);
    // Something owned but off can't come on with no spare unit…
    const off = order.find((id) => u.state.on[id] < u.state.owned[id])!;
    expect(u.setOn(off, u.state.on[off] + 1)).toBe('power');
    // …until the reactor makes room (a reactor tier pays for itself)
    const before = u.power;
    u.buy('reactor');
    expect(u.state.on.reactor).toBe(1);
    expect(u.power).toBeGreaterThanOrEqual(before + REACTOR_POWER);
    expect(u.setOn(off, u.state.on[off] + 1)).toBeNull();
    // and the reactor can't then be switched off from under it
    expect(u.setOn('reactor', 0)).toBe('reactor');
  });

  it('only switches on tiers it owns', () => {
    const u = rich();
    u.buy('flares');
    expect(u.setOn('flares', 2)).toBe('owned');
    expect(u.setOn('flares', 0)).toBeNull();
    expect(u.spec.flareMag).toBe(1);
  });

  it('climbs the Marks as tiers are bought', () => {
    const u = rich();
    for (let i = 0; i < 5; i++) u.buy('armour');
    expect(u.mark).toBe('IV');
    expect(u.power).toBe(BASE_POWER + 1);
  });

  it('keeps itself between sessions, and cleans up a bad save', () => {
    const store = memory();
    const a = new Upgrades(store);
    a.earn(500, 'x');
    a.buy('propulsion');
    const b = new Upgrades(store);
    expect(b.state.rd).toBe(500 - TIER_COST[0]);
    expect(b.state.on.propulsion).toBe(1);
    expect(b.spec.boostSpeed).toBeCloseTo(1.08);
    store.setItem('mk3-flight-rd', JSON.stringify({ rd: -4, owned: { armour: 99, bogus: 3 }, on: { armour: 99 } }));
    const c = new Upgrades(store);
    expect(c.state.rd).toBe(0);
    expect(c.state.owned.armour).toBe(MAX_TIER);
    expect(c.state.on.armour).toBe(MAX_TIER);
    store.setItem('mk3-flight-rd', '{nope');
    expect(new Upgrades(store).state.rd).toBe(0);
  });

  it('pays for kills, clears (double untouched), and decoys', () => {
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
    expect(u.state.rd).toBe(AWARD.drone + AWARD.sam + AWARD.frigate + AWARD.wave * 2 * 2 + AWARD.wave * 3 + AWARD.decoy);
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
