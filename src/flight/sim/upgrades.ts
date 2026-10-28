import type { SimEvent } from './events';

/**
 * R&D: the suit's upgrades. Points are earned in the air (kills, cleared
 * waves, clean pad landings, decoyed seekers) and spent on the pad: eight
 * systems, each fitted a level at a time up to five. Every level costs more
 * than the last, and the higher ones stay locked until the pilot has cleared
 * a deep enough wave.
 *
 * The systems read their numbers through a {@link SuitSpec}: multipliers on
 * their own tuning constants (1 = the stock Mark III), so a suit with
 * nothing fitted is exactly the suit as it flew before any of this.
 */

export interface SuitSpec {
  /** Share of each hit's damage the armour takes. */
  damageTaken: number;
  /** Reboots carried on top of the stock one. */
  reserves: number;
  /** Armour regeneration rate, and the quiet it waits for after a hit (×). */
  regenRate: number;
  regenDelay: number;
  /** Unibeam: seconds of beam from cold, and the time it takes to cool (×). */
  unibeamTime: number;
  unibeamCool: number;
  /** Repulsor bolt damage and the interval between shots (×). */
  repulsorDamage: number;
  repulsorInterval: number;
  /** Micro-missiles: paint time per target, reach, and a pod tube's reload (×). */
  missileLock: number;
  missileRange: number;
  rocketReload: number;
  /** Forearm launchers: a bay's reload (and the magazine's), paint time, reach (×). */
  launcherReload: number;
  launcherLock: number;
  launcherRange: number;
  /** Flares carried and the time to restock one (×). */
  flareMag: number;
  flareRestock: number;
  /** Boost: the boots' authority and the airspeed it flies to (×). */
  boostThrust: number;
  boostSpeed: number;
  /** Height the airfoils start to ice at, raised by this (m). */
  icingLift: number;
  /** Aim assist: how far out it takes a target, and the cone it snaps in (×). */
  assistRange: number;
  assistCone: number;
}

export const STOCK_SPEC = (): SuitSpec => ({
  damageTaken: 1,
  reserves: 0,
  regenRate: 1,
  regenDelay: 1,
  unibeamTime: 1,
  unibeamCool: 1,
  repulsorDamage: 1,
  repulsorInterval: 1,
  missileLock: 1,
  missileRange: 1,
  rocketReload: 1,
  launcherReload: 1,
  launcherLock: 1,
  launcherRange: 1,
  flareMag: 1,
  flareRestock: 1,
  boostThrust: 1,
  boostSpeed: 1,
  icingLift: 0,
  assistRange: 1,
  assistCone: 1,
});

export type UpgradeId = 'armour' | 'reactor' | 'repulsors' | 'missiles' | 'launchers' | 'flares' | 'propulsion' | 'sensors';

/** One line of what an upgrade does: its label, and the value at a level (0 = stock). */
type Stat = [label: string, show: (level: number) => string];

export interface Upgrade {
  id: UpgradeId;
  name: string;
  /** Where on the suit it lives. */
  part: string;
  /** R&D price of each level, first to last. */
  costs: readonly number[];
  stats: Stat[];
  /** Writes the upgrade's effect at a level (1 to {@link MAX_LEVEL}) into the spec. */
  apply: (spec: SuitSpec, level: number) => void;
}

/** Levels in every system. */
export const MAX_LEVEL = 5;
/**
 * The best wave the pilot must have cleared before each level can be fitted:
 * points alone don't buy a Mark V, it has to be earned the hard way.
 */
export const LEVEL_GATE: readonly number[] = [0, 2, 4, 6, 8];
/** Each level's price, as a multiple of the first. */
const LADDER = [1, 1.8, 3, 4.5, 6.5];
const ladder = (base: number) => LADDER.map((k) => Math.round((base * k) / 10) * 10);
/** Stock at level 0 to `max` at the top level, in even steps. */
const step = (stock: number, max: number) => (level: number) => stock + ((max - stock) * level) / MAX_LEVEL;

/** Where the airfoils ice with the stock boots (m; flightModel's ICING_ALT, kept here to spare it a cycle). */
const ICING_ALT = 9000;

const pct = (k: number) => (Math.abs(k) < 0.005 ? 'STOCK' : `${k > 0 ? '+' : '−'}${Math.round(Math.abs(k) * 100)}%`);
const km = (m: number) => `${m.toFixed(1)} km`;
const sec = (v: number, d = 1) => `${v.toFixed(d)} s`;

const armourTaken = step(1, 0.6);
const armourDelay = step(1, 0.6);
/** Reboots on top of the stock one, by level. */
const ARMOUR_RESERVES = [0, 0, 1, 1, 1, 2];
const beamTime = step(1, 1.8);
const beamCool = step(1, 0.6);
const regen = step(1, 1.8);
const boltDamage = step(1, 1.6);
const boltInterval = step(1, 0.65);
const missileLock = step(1, 0.6);
const missileRange = step(1, 1.45);
const podReload = step(1, 0.55);
const bayReload = step(1, 0.55);
const bayLock = step(1, 0.55);
const bayRange = step(1, 1.4);
/** Flares carried, by level (the stock drum holds 64). */
const FLARES = [64, 72, 80, 96, 112, 128];
const flareRestock = step(1, 0.5);
const thrust = step(1, 1.3);
const topSpeed = step(1, 1.35);
const icing = step(0, 3000);
const assist = step(1, 1.6);

/**
 * The eight systems, five levels each. A first wave buys a first level of
 * something cheap; maxing the suit takes many long runs and a record of
 * deep waves to show for them.
 */
export const UPGRADES: readonly Upgrade[] = [
  {
    id: 'armour',
    name: 'ARMOUR',
    part: 'PLATING',
    costs: ladder(300),
    stats: [
      ['DAMAGE TAKEN', (l) => pct(armourTaken(l) - 1)],
      ['RESERVES', (l) => `${1 + ARMOUR_RESERVES[l]}`],
      ['REGEN AFTER', (l) => sec(6 * armourDelay(l))],
    ],
    apply: (s, l) => {
      s.damageTaken = armourTaken(l);
      s.reserves = ARMOUR_RESERVES[l];
      s.regenDelay = armourDelay(l);
    },
  },
  {
    id: 'reactor',
    name: 'ARC REACTOR',
    part: 'CHEST',
    costs: ladder(300),
    stats: [
      ['UNIBEAM', (l) => sec(4 * beamTime(l))],
      ['BEAM COOL', (l) => sec(7 * beamCool(l))],
      ['ARMOUR REGEN', (l) => pct(regen(l) - 1)],
    ],
    apply: (s, l) => {
      s.unibeamTime = beamTime(l);
      s.unibeamCool = beamCool(l);
      s.regenRate = regen(l);
    },
  },
  {
    id: 'repulsors',
    name: 'REPULSORS',
    part: 'PALMS',
    costs: ladder(250),
    stats: [
      ['BOLT DAMAGE', (l) => pct(boltDamage(l) - 1)],
      ['RATE OF FIRE', (l) => pct(1 / boltInterval(l) - 1)],
    ],
    apply: (s, l) => {
      s.repulsorDamage = boltDamage(l);
      s.repulsorInterval = boltInterval(l);
    },
  },
  {
    id: 'missiles',
    name: 'MICRO-MISSILES',
    part: 'SHOULDERS',
    costs: ladder(250),
    stats: [
      ['PAINT TIME', (l) => pct(missileLock(l) - 1)],
      ['REACH', (l) => km(3.2 * missileRange(l))],
      ['POD RELOAD', (l) => pct(podReload(l) - 1)],
    ],
    apply: (s, l) => {
      s.missileLock = missileLock(l);
      s.missileRange = missileRange(l);
      s.rocketReload = podReload(l);
    },
  },
  {
    id: 'launchers',
    name: 'FOREARM LAUNCHERS',
    part: 'FOREARMS',
    costs: ladder(250),
    stats: [
      ['BAY RELOAD', (l) => pct(bayReload(l) - 1)],
      ['PAINT TIME', (l) => pct(bayLock(l) - 1)],
      ['REACH', (l) => km(4.5 * bayRange(l))],
    ],
    apply: (s, l) => {
      s.launcherReload = bayReload(l);
      s.launcherLock = bayLock(l);
      s.launcherRange = bayRange(l);
    },
  },
  {
    id: 'flares',
    name: 'COUNTERMEASURES',
    part: 'HIPS',
    costs: ladder(150),
    stats: [
      ['FLARES', (l) => `${FLARES[l]}`],
      ['RESTOCK', (l) => sec(flareRestock(l), 2)],
    ],
    apply: (s, l) => {
      s.flareMag = FLARES[l] / FLARES[0];
      s.flareRestock = flareRestock(l);
    },
  },
  {
    id: 'propulsion',
    name: 'PROPULSION',
    part: 'BOOTS',
    costs: ladder(400),
    stats: [
      ['BOOST THRUST', (l) => pct(thrust(l) - 1)],
      ['TOP SPEED', (l) => `M ${(1.5 * topSpeed(l)).toFixed(2)}`],
      ['ICES AT', (l) => km((ICING_ALT + icing(l)) / 1000)],
    ],
    apply: (s, l) => {
      s.boostThrust = thrust(l);
      s.boostSpeed = topSpeed(l);
      s.icingLift = icing(l);
    },
  },
  {
    id: 'sensors',
    name: 'SENSORS',
    part: 'HELMET',
    costs: ladder(150),
    stats: [
      ['ASSIST RANGE', (l) => km(1.8 * assist(l))],
      ['ASSIST CONE', (l) => `${(4.5 * assist(l)).toFixed(1)}°`],
    ],
    apply: (s, l) => {
      s.assistRange = assist(l);
      s.assistCone = assist(l);
    },
  },
];

/** R&D points for what the pilot does. */
export const AWARD = {
  drone: 10,
  sam: 25,
  /** Each part of a frigate shot off it, and the ship going under. */
  ship: 15,
  frigate: 100,
  /** A cleared wave: the base plus this × its number, and half as much again with no hit taken. */
  waveBase: 40,
  wave: 30,
  /** Pad landings by grade, once the suit has been up long enough to have flown somewhere. */
  bullseye: 20,
  centred: 10,
  onPad: 5,
  decoy: 5,
  /** The first time through the barrier on each flight. */
  sonicBoom: 10,
} as const;
/** A landing only pays after this long in the air (s): no hopping on the pad for points. */
export const LANDING_MIN_AIR = 30;

export interface UpgradeState {
  rd: number;
  /** Each system's level fitted (0 = stock). */
  level: Record<UpgradeId, number>;
  /** All the R&D ever earned (for the record). */
  earned: number;
  /** The deepest wave ever cleared: what unlocks the higher levels. */
  best: number;
}

const none = (): Record<UpgradeId, number> => Object.fromEntries(UPGRADES.map((u) => [u.id, 0])) as Record<UpgradeId, number>;
export const FRESH_STATE = (): UpgradeState => ({ rd: 0, level: none(), earned: 0, best: 0 });

/** The storage the ledger keeps itself in (localStorage in the page). */
export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORE = 'mk3-flight-rd';

/** Why a purchase was refused, or null when it went through. */
export type RefitRefusal = 'cost' | 'max' | 'locked' | null;

export class Upgrades {
  readonly state: UpgradeState;
  /** The live spec the suit's systems read (mutated in place on every change). */
  readonly spec = STOCK_SPEC();
  private readonly changed: Array<() => void> = [];
  /** Called with each award (points, what for), for the HUD. */
  onAward: (points: number, reason: string) => void = () => {};
  /** Sim time the suit last left the ground, a hit since the wave began, the flight's sonic boom paid, auto-land on this flight. */
  private tookOff = -Infinity;
  private hitThisWave = false;
  private boomPaid = false;
  private autoLanded = false;

  constructor(private readonly store: Store | null = safeStorage()) {
    this.state = load(store);
    this.resolve();
  }

  /** Called whenever the points, the upgrades or the spec change. */
  onChange(fn: () => void): void {
    this.changed.push(fn);
  }

  /** Levels fitted so far, across every system. */
  get fitted(): number {
    return UPGRADES.reduce((n, u) => n + this.state.level[u.id], 0);
  }

  /** Some system's next level is unlocked and within the points banked. */
  get affordable(): boolean {
    return UPGRADES.some((u) => this.why(u.id) === null);
  }

  /** The next level's price, or null with the system maxed. */
  cost(id: UpgradeId): number | null {
    const l = this.state.level[id];
    return l < MAX_LEVEL ? UPGRADES.find((u) => u.id === id)!.costs[l] : null;
  }

  /** The wave still to clear before the next level unlocks, or null when it's open (or maxed). */
  lockedUntil(id: UpgradeId): number | null {
    const l = this.state.level[id];
    return l < MAX_LEVEL && this.state.best < LEVEL_GATE[l] ? LEVEL_GATE[l] : null;
  }

  /** Buys and fits a system's next level. */
  buy(id: UpgradeId): RefitRefusal {
    const no = this.why(id);
    if (no) return no;
    this.state.rd -= this.cost(id)!;
    this.state.level[id]++;
    this.commit();
    return null;
  }

  /** Why the next level can't be bought now, or null when it can. */
  private why(id: UpgradeId): RefitRefusal {
    const cost = this.cost(id);
    if (cost === null) return 'max';
    if (this.lockedUntil(id) !== null) return 'locked';
    return this.state.rd < cost ? 'cost' : null;
  }

  earn(points: number, reason: string): void {
    if (points <= 0) return;
    this.state.rd += points;
    this.state.earned += points;
    this.commit();
    this.onAward(points, reason);
  }

  /** Pays out on the sim's events. */
  event(e: SimEvent): void {
    switch (e.kind) {
      case 'destroyed': {
        const kind = e.text as keyof typeof AWARD;
        const pts = AWARD[kind];
        if (typeof pts === 'number') this.earn(pts, kind === 'frigate' ? 'WARSHIP SUNK' : `${kind.toUpperCase()} DOWN`);
        break;
      }
      case 'waveStart':
        this.hitThisWave = false;
        break;
      case 'hitArmor':
        this.hitThisWave = true;
        break;
      case 'waveClear': {
        const n = e.value ?? 1;
        // (the record moves before the payout, so the bay sees it as the points land)
        this.state.best = Math.max(this.state.best, n);
        const pts = AWARD.waveBase + AWARD.wave * n;
        this.earn(this.hitThisWave ? pts : Math.round(pts * 1.5), this.hitThisWave ? `WAVE ${n} CLEAR` : `WAVE ${n} · UNTOUCHED`);
        break;
      }
      case 'takeoff':
        this.tookOff = e.t;
        this.boomPaid = false;
        this.autoLanded = false;
        break;
      case 'autoLand':
        if (e.value) this.autoLanded = true;
        break;
      case 'padLanding': {
        const grade = e.text as 'bullseye' | 'centred' | 'onPad';
        if (!this.autoLanded && e.t - this.tookOff >= LANDING_MIN_AIR && grade in AWARD) {
          this.earn(AWARD[grade], grade === 'onPad' ? 'ON THE PAD' : `${grade.toUpperCase()} LANDING`);
        }
        // (one payout a flight)
        this.tookOff = Infinity;
        break;
      }
      case 'missileDecoyed':
        this.earn(AWARD.decoy, 'DECOYED');
        break;
      case 'sonicBoom':
        if (!this.boomPaid) {
          this.boomPaid = true;
          this.earn(AWARD.sonicBoom, 'MACH 1');
        }
        break;
    }
  }

  /** Wipes the ledger (tests, or a fresh start). */
  reset(): void {
    Object.assign(this.state, FRESH_STATE());
    this.commit();
  }

  private resolve(): void {
    Object.assign(this.spec, STOCK_SPEC());
    for (const u of UPGRADES) if (this.state.level[u.id] > 0) u.apply(this.spec, this.state.level[u.id]);
  }

  private commit(): void {
    this.resolve();
    try {
      this.store?.setItem(STORE, JSON.stringify(this.state));
    } catch {
      /* private mode */
    }
    for (const fn of this.changed) fn();
  }
}

function safeStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved ledger, cleaned up: unknown upgrades dropped, levels clamped (a save from the buy-once ledger keeps each upgrade as its first level). */
function load(store: Store | null): UpgradeState {
  const s = FRESH_STATE();
  let saved: { rd?: unknown; earned?: unknown; best?: unknown; level?: Record<string, unknown>; owned?: Record<string, unknown> } | null = null;
  try {
    saved = JSON.parse(store?.getItem(STORE) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return s;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1e9, Math.max(0, Math.floor(v))) : 0);
  s.rd = num(saved.rd);
  s.earned = num(saved.earned);
  s.best = num(saved.best);
  for (const u of UPGRADES) {
    const v = saved.level ? saved.level[u.id] : saved.owned?.[u.id];
    s.level[u.id] = v === true ? 1 : Math.min(MAX_LEVEL, num(v));
  }
  return s;
}
