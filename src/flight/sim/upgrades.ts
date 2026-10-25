import type { SimEvent } from './events';

/**
 * R&D: the suit's upgrade progression. Points are earned in the air (kills,
 * cleared waves, clean pad landings, decoyed seekers) and spent on tiers in
 * eight systems, refitted on the pad. Every tier is bought for good, but
 * each one switched on draws a unit from the reactor's power budget, so a
 * build is a choice, not a grind to the top of every track.
 *
 * The systems read their numbers through a {@link SuitSpec}: multipliers on
 * their own tuning constants (1 = the stock Mark III), so tier 0 is exactly
 * the suit as it flew before any of this.
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

export type TrackId = 'armour' | 'reactor' | 'repulsors' | 'missiles' | 'launchers' | 'flares' | 'propulsion' | 'sensors';

/** One line of what a track does: its label, and the change at tier t shown as text. */
interface Stat {
  label: string;
  show: (t: number) => string;
}

export interface Track {
  id: TrackId;
  name: string;
  /** Where on the suit it lives. */
  part: string;
  stats: Stat[];
  /** Writes tier t's effect into the spec. */
  apply: (spec: SuitSpec, t: number) => void;
}

export const MAX_TIER = 5;
/** R&D cost of each tier (index 0 buys tier I). */
export const TIER_COST = [50, 100, 175, 275, 400] as const;
/** Power units the reactor gives with nothing upgraded, and each reactor tier switched on adds. */
export const BASE_POWER = 10;
export const REACTOR_POWER = 2;
/** Tiers owned that bring each Mark (from III), each worth a unit of power. */
export const MARK_AT = [0, 5, 10, 16, 23, 31, 40] as const;
const MARK_NAMES = ['III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

const pct = (k: number) => (Math.abs(k) < 1e-6 ? 'STOCK' : `${k > 0 ? '+' : '−'}${Math.round(Math.abs(k) * 100)}%`);

export const TRACKS: readonly Track[] = [
  {
    id: 'armour',
    name: 'ARMOUR',
    part: 'PLATING',
    stats: [
      { label: 'DAMAGE TAKEN', show: (t) => pct(-0.07 * t) },
      { label: 'RESERVES', show: (t) => `${1 + (t >= 3 ? 1 : 0)}` },
      { label: 'REGEN AFTER', show: (t) => `${(6 * (1 - 0.08 * t)).toFixed(1)} s` },
    ],
    apply: (s, t) => {
      s.damageTaken = 1 - 0.07 * t;
      s.reserves = t >= 3 ? 1 : 0;
      s.regenDelay = 1 - 0.08 * t;
    },
  },
  {
    id: 'reactor',
    name: 'ARC REACTOR',
    part: 'CHEST',
    stats: [
      { label: 'POWER', show: (t) => `+${t * REACTOR_POWER}` },
      { label: 'UNIBEAM', show: (t) => `${(4 * (1 + 0.125 * t)).toFixed(1)} s` },
      { label: 'BEAM COOL', show: (t) => `${(7 * (1 - 0.08 * t)).toFixed(1)} s` },
      { label: 'ARMOUR REGEN', show: (t) => pct(0.15 * t) },
    ],
    apply: (s, t) => {
      s.unibeamTime = 1 + 0.125 * t;
      s.unibeamCool = 1 - 0.08 * t;
      s.regenRate = 1 + 0.15 * t;
    },
  },
  {
    id: 'repulsors',
    name: 'REPULSORS',
    part: 'PALMS',
    stats: [
      { label: 'BOLT DAMAGE', show: (t) => pct(0.1 * t) },
      { label: 'RATE OF FIRE', show: (t) => pct(1 / (1 - 0.06 * t) - 1) },
    ],
    apply: (s, t) => {
      s.repulsorDamage = 1 + 0.1 * t;
      s.repulsorInterval = 1 - 0.06 * t;
    },
  },
  {
    id: 'missiles',
    name: 'MICRO-MISSILES',
    part: 'SHOULDERS',
    stats: [
      { label: 'PAINT TIME', show: (t) => pct(-0.08 * t) },
      { label: 'REACH', show: (t) => `${(3.2 * (1 + 0.08 * t)).toFixed(1)} km` },
      { label: 'POD RELOAD', show: (t) => pct(-0.1 * t) },
    ],
    apply: (s, t) => {
      s.missileLock = 1 - 0.08 * t;
      s.missileRange = 1 + 0.08 * t;
      s.rocketReload = 1 - 0.1 * t;
    },
  },
  {
    id: 'launchers',
    name: 'FOREARM LAUNCHERS',
    part: 'FOREARMS',
    stats: [
      { label: 'BAY RELOAD', show: (t) => pct(-0.09 * t) },
      { label: 'PAINT TIME', show: (t) => pct(-0.1 * t) },
      { label: 'REACH', show: (t) => `${(4.5 * (1 + 0.06 * t)).toFixed(1)} km` },
    ],
    apply: (s, t) => {
      s.launcherReload = 1 - 0.09 * t;
      s.launcherLock = 1 - 0.1 * t;
      s.launcherRange = 1 + 0.06 * t;
    },
  },
  {
    id: 'flares',
    name: 'COUNTERMEASURES',
    part: 'HIPS',
    stats: [
      { label: 'FLARES', show: (t) => `${Math.round(64 * (1 + 0.1 * t))}` },
      { label: 'RESTOCK', show: (t) => `${(1 - 0.1 * t).toFixed(1)} s` },
    ],
    apply: (s, t) => {
      s.flareMag = 1 + 0.1 * t;
      s.flareRestock = 1 - 0.1 * t;
    },
  },
  {
    id: 'propulsion',
    name: 'PROPULSION',
    part: 'BOOTS',
    stats: [
      { label: 'BOOST THRUST', show: (t) => pct(0.05 * t) },
      { label: 'TOP SPEED', show: (t) => `M ${(1.5 * (1 + 0.08 * t)).toFixed(2)}` },
      { label: 'DE-ICING', show: (t) => (t >= 5 ? '11 km' : t >= 4 ? '10 km' : 'NONE') },
    ],
    apply: (s, t) => {
      s.boostThrust = 1 + 0.05 * t;
      s.boostSpeed = 1 + 0.08 * t;
      s.icingLift = t >= 5 ? 2000 : t >= 4 ? 1000 : 0;
    },
  },
  {
    id: 'sensors',
    name: 'SENSORS',
    part: 'HELMET',
    stats: [
      { label: 'ASSIST RANGE', show: (t) => `${(1.8 * (1 + 0.09 * t)).toFixed(1)} km` },
      { label: 'ASSIST CONE', show: (t) => `${(4.5 * (1 + 0.07 * t)).toFixed(1)}°` },
    ],
    apply: (s, t) => {
      s.assistRange = 1 + 0.09 * t;
      s.assistCone = 1 + 0.07 * t;
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
  /** A cleared wave: this × its number, and as much again with no hit taken. */
  wave: 50,
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
  /** Tiers bought, per track. */
  owned: Record<TrackId, number>;
  /** Tiers switched on (≤ owned), per track. */
  on: Record<TrackId, number>;
  /** All the R&D ever earned (for the record). */
  earned: number;
}

const zero = (): Record<TrackId, number> => Object.fromEntries(TRACKS.map((t) => [t.id, 0])) as Record<TrackId, number>;
export const FRESH_STATE = (): UpgradeState => ({ rd: 0, owned: zero(), on: zero(), earned: 0 });

/** The storage the ledger keeps itself in (localStorage in the page). */
export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORE = 'mk3-flight-rd';

/** Why a refit was refused, or null when it went through. */
export type RefitRefusal = 'cost' | 'max' | 'power' | 'owned' | 'reactor' | null;

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
    // (a ledger saved over budget sheds tiers from the end of the list up)
    for (const t of [...TRACKS].reverse()) while (this.powerUsed > this.power && this.state.on[t.id] > 0) this.state.on[t.id]--;
    this.resolve();
  }

  /** Called whenever the points, the tiers or the spec change. */
  onChange(fn: () => void): void {
    this.changed.push(fn);
  }

  get power(): number {
    return BASE_POWER + this.state.on.reactor * REACTOR_POWER + this.markIndex;
  }

  get powerUsed(): number {
    return TRACKS.reduce((n, t) => n + this.state.on[t.id], 0);
  }

  get tiersOwned(): number {
    return TRACKS.reduce((n, t) => n + this.state.owned[t.id], 0);
  }

  /** 0 = Mark III, and one more for each step on {@link MARK_AT}. */
  get markIndex(): number {
    const n = this.tiersOwned;
    let i = 0;
    while (i + 1 < MARK_AT.length && n >= MARK_AT[i + 1]) i++;
    return i;
  }

  get mark(): string {
    return MARK_NAMES[this.markIndex];
  }

  /** Some tier's next step is within the points banked. */
  get affordable(): boolean {
    return TRACKS.some((t) => {
      const c = this.cost(t.id);
      return c !== null && c <= this.state.rd;
    });
  }

  /** Tiers still to buy before the next Mark, or null at the last. */
  get toNextMark(): number | null {
    const next = MARK_AT[this.markIndex + 1];
    return next === undefined ? null : next - this.tiersOwned;
  }

  /** The next tier's price on a track, or null when it's maxed. */
  cost(id: TrackId): number | null {
    const t = this.state.owned[id];
    return t >= MAX_TIER ? null : TIER_COST[t];
  }

  /** Buys the next tier on a track, switching it on if the budget allows. */
  buy(id: TrackId): RefitRefusal {
    const cost = this.cost(id);
    if (cost === null) return 'max';
    if (this.state.rd < cost) return 'cost';
    this.state.rd -= cost;
    const wasFull = this.state.on[id] === this.state.owned[id];
    this.state.owned[id]++;
    // (a reactor tier pays for itself; anything else needs a spare unit)
    if (wasFull && (id === 'reactor' || this.powerUsed < this.power)) this.state.on[id]++;
    this.commit();
    return null;
  }

  /** Switches a track to tier n (0 … owned), within the power budget. */
  setOn(id: TrackId, n: number): RefitRefusal {
    const cur = this.state.on[id];
    if (n === cur) return null;
    if (n < 0 || n > this.state.owned[id]) return 'owned';
    const used = this.powerUsed - cur + n;
    const power = this.power + (id === 'reactor' ? (n - cur) * REACTOR_POWER : 0);
    if (used > power) return n > cur ? 'power' : 'reactor';
    this.state.on[id] = n;
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
        this.earn(AWARD.wave * n * (this.hitThisWave ? 1 : 2), this.hitThisWave ? `WAVE ${n} CLEAR` : `WAVE ${n} · UNTOUCHED`);
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
    for (const t of TRACKS) t.apply(this.spec, this.state.on[t.id]);
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

/** The saved ledger, cleaned up: unknown tracks dropped, tiers clamped, the budget respected. */
function load(store: Store | null): UpgradeState {
  const s = FRESH_STATE();
  let saved: Partial<UpgradeState> | null = null;
  try {
    saved = JSON.parse(store?.getItem(STORE) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return s;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo);
  s.rd = num(saved.rd, 0, 1e9);
  s.earned = num(saved.earned, 0, 1e9);
  for (const t of TRACKS) {
    s.owned[t.id] = num(saved.owned?.[t.id], 0, MAX_TIER);
    s.on[t.id] = num(saved.on?.[t.id], 0, s.owned[t.id]);
  }
  return s;
}
