import type { SimEvent } from './events';

/**
 * R&D: the suit's upgrades. Points are earned in the air (kills, cleared
 * waves, clean pad landings, decoyed seekers) and spent on the pad: one
 * upgrade per system, eight in all, each bought once and fitted for good.
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

/** One line of what an upgrade does: its label, stock and fitted. */
type Stat = [label: string, stock: string, fitted: string];

export interface Upgrade {
  id: UpgradeId;
  name: string;
  /** Where on the suit it lives. */
  part: string;
  /** R&D price. */
  cost: number;
  stats: Stat[];
  /** Writes the upgrade's effect into the spec. */
  apply: (spec: SuitSpec) => void;
}

/** Where the airfoils ice with the stock boots (m; flightModel's ICING_ALT, kept here to spare it a cycle). */
const ICING_ALT = 9000;

const pct = (k: number) => `${k > 0 ? '+' : '−'}${Math.round(Math.abs(k) * 100)}%`;
const km = (m: number) => `${m.toFixed(1)} km`;
const sec = (v: number, d = 1) => `${v.toFixed(d)} s`;

/**
 * The eight upgrades. A first wave or two pays for the cheap ones; the
 * whole set takes a long run.
 */
export const UPGRADES: readonly Upgrade[] = [
  {
    id: 'armour',
    name: 'ARMOUR',
    part: 'PLATING',
    cost: 300,
    stats: [
      ['DAMAGE TAKEN', 'STOCK', pct(-0.25)],
      ['RESERVES', '1', '2'],
      ['REGEN AFTER', sec(6), sec(6 * 0.7)],
    ],
    apply: (s) => {
      s.damageTaken = 0.75;
      s.reserves = 1;
      s.regenDelay = 0.7;
    },
  },
  {
    id: 'reactor',
    name: 'ARC REACTOR',
    part: 'CHEST',
    cost: 300,
    stats: [
      ['UNIBEAM', sec(4), sec(4 * 1.5)],
      ['BEAM COOL', sec(7), sec(7 * 0.7)],
      ['ARMOUR REGEN', 'STOCK', pct(0.5)],
    ],
    apply: (s) => {
      s.unibeamTime = 1.5;
      s.unibeamCool = 0.7;
      s.regenRate = 1.5;
    },
  },
  {
    id: 'repulsors',
    name: 'REPULSORS',
    part: 'PALMS',
    cost: 250,
    stats: [
      ['BOLT DAMAGE', 'STOCK', pct(0.35)],
      ['RATE OF FIRE', 'STOCK', pct(1 / 0.75 - 1)],
    ],
    apply: (s) => {
      s.repulsorDamage = 1.35;
      s.repulsorInterval = 0.75;
    },
  },
  {
    id: 'missiles',
    name: 'MICRO-MISSILES',
    part: 'SHOULDERS',
    cost: 250,
    stats: [
      ['PAINT TIME', 'STOCK', pct(-0.3)],
      ['REACH', km(3.2), km(3.2 * 1.3)],
      ['POD RELOAD', 'STOCK', pct(-0.35)],
    ],
    apply: (s) => {
      s.missileLock = 0.7;
      s.missileRange = 1.3;
      s.rocketReload = 0.65;
    },
  },
  {
    id: 'launchers',
    name: 'FOREARM LAUNCHERS',
    part: 'FOREARMS',
    cost: 250,
    stats: [
      ['BAY RELOAD', 'STOCK', pct(-0.35)],
      ['PAINT TIME', 'STOCK', pct(-0.35)],
      ['REACH', km(4.5), km(4.5 * 1.25)],
    ],
    apply: (s) => {
      s.launcherReload = 0.65;
      s.launcherLock = 0.65;
      s.launcherRange = 1.25;
    },
  },
  {
    id: 'flares',
    name: 'COUNTERMEASURES',
    part: 'HIPS',
    cost: 150,
    stats: [
      ['FLARES', '64', '96'],
      ['RESTOCK', sec(1, 2), sec(0.65, 2)],
    ],
    apply: (s) => {
      s.flareMag = 1.5;
      s.flareRestock = 0.65;
    },
  },
  {
    id: 'propulsion',
    name: 'PROPULSION',
    part: 'BOOTS',
    cost: 400,
    stats: [
      ['BOOST THRUST', 'STOCK', pct(0.2)],
      ['TOP SPEED', 'M 1.50', `M ${(1.5 * 1.25).toFixed(2)}`],
      ['ICES AT', km(ICING_ALT / 1000), km((ICING_ALT + 1500) / 1000)],
    ],
    apply: (s) => {
      s.boostThrust = 1.2;
      s.boostSpeed = 1.25;
      s.icingLift = 1500;
    },
  },
  {
    id: 'sensors',
    name: 'SENSORS',
    part: 'HELMET',
    cost: 150,
    stats: [
      ['ASSIST RANGE', km(1.8), km(1.8 * 1.35)],
      ['ASSIST CONE', '4.5°', `${(4.5 * 1.35).toFixed(1)}°`],
    ],
    apply: (s) => {
      s.assistRange = 1.35;
      s.assistCone = 1.35;
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
  /** Upgrades fitted. */
  owned: Record<UpgradeId, boolean>;
  /** All the R&D ever earned (for the record). */
  earned: number;
}

const none = (): Record<UpgradeId, boolean> => Object.fromEntries(UPGRADES.map((u) => [u.id, false])) as Record<UpgradeId, boolean>;
export const FRESH_STATE = (): UpgradeState => ({ rd: 0, owned: none(), earned: 0 });

/** The storage the ledger keeps itself in (localStorage in the page). */
export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORE = 'mk3-flight-rd';

/** Why a purchase was refused, or null when it went through. */
export type RefitRefusal = 'cost' | 'owned' | null;

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

  /** Upgrades fitted so far. */
  get fitted(): number {
    return UPGRADES.filter((u) => this.state.owned[u.id]).length;
  }

  /** Some upgrade not yet fitted is within the points banked. */
  get affordable(): boolean {
    return UPGRADES.some((u) => !this.state.owned[u.id] && u.cost <= this.state.rd);
  }

  /** Buys and fits an upgrade. */
  buy(id: UpgradeId): RefitRefusal {
    const up = UPGRADES.find((u) => u.id === id)!;
    if (this.state.owned[id]) return 'owned';
    if (this.state.rd < up.cost) return 'cost';
    this.state.rd -= up.cost;
    this.state.owned[id] = true;
    this.commit();
    return null;
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
    for (const u of UPGRADES) if (this.state.owned[u.id]) u.apply(this.spec);
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

/** The saved ledger, cleaned up: unknown upgrades dropped (a save from the tiered ledger keeps whatever had a tier bought). */
function load(store: Store | null): UpgradeState {
  const s = FRESH_STATE();
  let saved: { rd?: unknown; earned?: unknown; owned?: Record<string, unknown> } | null = null;
  try {
    saved = JSON.parse(store?.getItem(STORE) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return s;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1e9, Math.max(0, Math.floor(v))) : 0);
  s.rd = num(saved.rd);
  s.earned = num(saved.earned);
  for (const u of UPGRADES) {
    const v = saved.owned?.[u.id];
    s.owned[u.id] = v === true || (typeof v === 'number' && v > 0);
  }
  return s;
}
