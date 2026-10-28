import { describe, expect, it } from 'vitest';
import type { SimEvent, SimEventKind } from './events';
import { AWARD, LANDING_MIN_AIR, LEVEL_GATE, MAX_LEVEL, STOCK_SPEC, UPGRADES, Upgrades, type Store } from './upgrades';

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

  it('buys a level at a time, each dearer than the last, up to the top', () => {
    const up = UPGRADES.find((x) => x.id === 'repulsors')!;
    const u = rich(up.costs[0]);
    expect(u.affordable).toBe(true);
    expect(u.buy('repulsors')).toBeNull();
    expect(u.state.rd).toBe(0);
    expect(u.state.level.repulsors).toBe(1);
    expect(u.spec.repulsorDamage).toBeGreaterThan(1);
    expect(u.fitted).toBe(1);
    expect(u.buy('repulsors')).toBe('locked');
    expect(u.buy('armour')).toBe('cost');
    expect(u.affordable).toBe(false);
    for (let i = 1; i < up.costs.length; i++) expect(up.costs[i]).toBeGreaterThan(up.costs[i - 1]);
  });

  it('locks the higher levels until a deep enough wave is cleared', () => {
    const u = rich();
    u.buy('sensors');
    expect(u.lockedUntil('sensors')).toBe(LEVEL_GATE[1]);
    expect(u.buy('sensors')).toBe('locked');
    u.event(ev('waveClear', 0, { value: LEVEL_GATE[1] }));
    expect(u.state.best).toBe(LEVEL_GATE[1]);
    expect(u.buy('sensors')).toBeNull();
    // An earlier wave on a later run doesn't lower the record
    u.event(ev('waveClear', 0, { value: 1 }));
    expect(u.state.best).toBe(LEVEL_GATE[1]);
    u.event(ev('waveClear', 0, { value: LEVEL_GATE[MAX_LEVEL - 1] }));
    while (u.state.level.sensors < MAX_LEVEL) expect(u.buy('sensors')).toBeNull();
    expect(u.buy('sensors')).toBe('max');
    expect(u.cost('sensors')).toBeNull();
    expect(u.spec.assistRange).toBeCloseTo(1.6);
  });

  it('makes every level count, the top one past what a single buy used to give', () => {
    for (const up of UPGRADES) {
      expect(up.costs.length, up.id).toBe(MAX_LEVEL);
      for (let l = 1; l <= MAX_LEVEL; l++) {
        expect(up.stats.some(([, show]) => show(l) !== show(l - 1)), `${up.id} ${l}`).toBe(true);
        const s = STOCK_SPEC();
        up.apply(s, l);
        expect(s, up.id).not.toEqual(STOCK_SPEC());
      }
    }
    const top = STOCK_SPEC();
    for (const up of UPGRADES) up.apply(top, MAX_LEVEL);
    expect(top.damageTaken).toBeLessThan(0.75);
    expect(top.reserves).toBe(2);
    expect(top.boostSpeed).toBeGreaterThan(1.25);
  });

  it('takes many runs to max the suit', () => {
    const total = UPGRADES.reduce((n, up) => n + up.costs.reduce((a, b) => a + b, 0), 0);
    expect(total).toBeGreaterThan(30000);
  });

  it('keeps itself between sessions, and cleans up a bad or older save', () => {
    const store = memory();
    const a = new Upgrades(store);
    a.earn(500, 'x');
    a.buy('propulsion');
    const b = new Upgrades(store);
    expect(b.state.rd).toBe(100);
    expect(b.state.level.propulsion).toBe(1);
    expect(b.spec.boostSpeed).toBeCloseTo(1.07);
    // The buy-once ledger: each fitted upgrade comes back as its first level
    store.setItem('mk3-flight-rd', JSON.stringify({ rd: -4, owned: { armour: true, flares: false, launchers: 9, bogus: 3 } }));
    const c = new Upgrades(store);
    expect(c.state.rd).toBe(0);
    expect(c.state.level.armour).toBe(1);
    expect(c.state.level.flares).toBe(0);
    expect(c.state.level.launchers).toBe(MAX_LEVEL);
    expect('bogus' in c.state.level).toBe(false);
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
