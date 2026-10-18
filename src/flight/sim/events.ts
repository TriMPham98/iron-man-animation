import type * as THREE from 'three';

/**
 * Everything that happens in the sky, as it happens: the sound engine, the
 * HUD and the capture recorder all listen here instead of reaching into
 * the systems that caused it.
 */
export type SimEventKind =
  // Suit
  | 'takeoff'
  | 'landed'
  | 'touchdown'
  | 'heroLanding'
  | 'footstep'
  | 'impact'
  | 'splash'
  | 'sonicBoom'
  | 'boostStart'
  | 'boostEnd'
  | 'flapServo'
  // Weapons
  | 'repulsorCharge'
  | 'repulsorFire'
  | 'repulsorHit'
  | 'siloOpen'
  | 'siloClose'
  | 'lockTick'
  | 'lockFull'
  | 'missileLaunch'
  | 'launcherFire'
  | 'unibeamCharge'
  | 'unibeamFire'
  | 'unibeamEnd'
  | 'flareSalvo'
  | 'flarePop'
  | 'weaponDeploy'
  | 'weaponStow'
  // World
  | 'explosion'
  | 'bigExplosion'
  | 'hitArmor'
  | 'ricochet'
  | 'enemyFire'
  | 'enemyMissile'
  | 'missileWarning'
  | 'missileDecoyed'
  | 'droneFlyby'
  | 'kill'
  | 'waveStart'
  | 'waveClear'
  | 'suitCritical'
  | 'reboot'
  | 'jarvis'
  // Picture (directed reels)
  | 'cameraCut';

export interface SimEvent {
  kind: SimEventKind;
  /** World position (for spatial sound / HUD markers). */
  at?: THREE.Vector3;
  /** Magnitude (impact speed, explosion size, damage …). */
  value?: number;
  side?: 'L' | 'R';
  text?: string;
  /** Sim time (s). */
  t: number;
}

type Listener = (e: SimEvent) => void;

export class EventBus {
  private readonly listeners: Listener[] = [];
  time = 0;

  on(fn: Listener): void {
    this.listeners.push(fn);
  }

  emit(kind: SimEventKind, init: Omit<SimEvent, 'kind' | 't'> = {}): void {
    const e: SimEvent = { kind, t: this.time, ...init };
    if (e.at) e.at = e.at.clone();
    for (const fn of this.listeners) fn(e);
  }
}
