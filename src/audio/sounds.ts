/** SFX catalog for the director audio timeline. */

export type SoundDef = {
  id: string;
  label: string;
  file: string;
};

/** Clips available in the timeline library. */
export const SOUNDS: SoundDef[] = [
  { id: 'binary-code-interface', label: 'Binary Code Interface', file: 'binary-code-interface.mp3' },
  { id: 'clasp-long-conveyor', label: 'Clasp Long Conveyor', file: 'clasp-long-conveyor.mp3' },
  { id: 'connect-hiss', label: 'Connect Hiss', file: 'connect-hiss.mp3' },
  { id: 'conveyor-hiss', label: 'Conveyor Hiss', file: 'conveyor-hiss.mp3' },
  { id: 'drill-tighten', label: 'Drill Tighten', file: 'drill-tighten.mp3' },
  { id: 'electric-motor', label: 'Electric Motor', file: 'electric-motor.mp3' },
  { id: 'footstep', label: 'Footstep', file: 'footstep.mp3' },
  { id: 'impact', label: 'Impact', file: 'impact.mp3' },
  { id: 'jarvis-startup', label: 'JARVIS Startup', file: 'jarvis-startup.mp3' },
  { id: 'light-attach', label: 'Light Attach', file: 'light-attach.mp3' },
  { id: 'medium-close', label: 'Medium Close', file: 'medium-close.mp3' },
  { id: 'metal-clang', label: 'Metal Clang', file: 'metal-clang.mp3' },
  { id: 'metal-connect', label: 'Metal Connect', file: 'metal-connect.mp3' },
  { id: 'metal-conveyor', label: 'Metal Conveyor', file: 'metal-conveyor.mp3' },
  { id: 'metal-resonate', label: 'Metal Resonate', file: 'metal-resonate.mp3' },
  { id: 'metal-ring-connect', label: 'Metal Ring Connect', file: 'metal-ring-connect.mp3' },
  { id: 'metal-sliding', label: 'Metal Sliding', file: 'metal-sliding.mp3' },
  { id: 'metal-tighten', label: 'Metal Tighten', file: 'metal-tighten.mp3' },
  { id: 'metal-treadmill', label: 'Metal Treadmill', file: 'metal-treadmill.mp3' },
  { id: 'metal-two-hits', label: 'Metal Two Hits', file: 'metal-two-hits.mp3' },
  { id: 'ratchet', label: 'Ratchet', file: 'ratchet.mp3' },
  { id: 'repulsor', label: 'Repulsor', file: 'repulsor.mp3' },
  { id: 'robot-movement', label: 'Robot Movement', file: 'robot-movement.mp3' },
  { id: 'steam-hiss', label: 'Steam Hiss', file: 'steam-hiss.mp3' },
  { id: 'steam-release', label: 'Steam Release', file: 'steam-release.mp3' },
  // Derived from the library for the action layer (servos, flaps, thrusters)
  { id: 'servo-whir', label: 'Servo Whir', file: 'servo-whir.mp3' },
  { id: 'servo-whine', label: 'Servo Whine', file: 'servo-whine.mp3' },
  { id: 'flap-servo', label: 'Flap Servo', file: 'flap-servo.mp3' },
  { id: 'flap-latch', label: 'Flap Latch', file: 'flap-latch.mp3' },
  { id: 'weapon-deploy', label: 'Weapon Deploy', file: 'weapon-deploy.mp3' },
  { id: 'weapon-lock', label: 'Weapon Lock', file: 'weapon-lock.mp3' },
  { id: 'weapon-stow', label: 'Weapon Stow', file: 'weapon-stow.mp3' },
  { id: 'unclamp-dry', label: 'Unclamp (dry)', file: 'unclamp-dry.mp3' },
  { id: 'doff-hum', label: 'Doffing Hum', file: 'doff-hum.mp3' },
  { id: 'thruster-ignite', label: 'Thruster Ignite', file: 'thruster-ignite.mp3' },
  { id: 'thruster-burn', label: 'Thruster Burn', file: 'thruster-burn.mp3' },
  { id: 'touchdown', label: 'Touchdown', file: 'touchdown.mp3' },
  { id: 'spark-crackle', label: 'Spark Crackle', file: 'spark-crackle.mp3' },
  { id: 'unclamp', label: 'Unclamp', file: 'unclamp.mp3' },
  // Synthesised suit-up / doffing set (scripts/sfx/synth_suit_sfx.py)
  { id: 'mk3-boot-lift', label: 'Boot Lift + Ankle Clamps', file: 'mk3-boot-lift.mp3' },
  { id: 'mk3-clamshell', label: 'Clamshell Clamp', file: 'mk3-clamshell.mp3' },
  { id: 'mk3-waist-seal', label: 'Waist Seal', file: 'mk3-waist-seal.mp3' },
  { id: 'mk3-torso-servo', label: 'Torso Servo', file: 'mk3-torso-servo.mp3' },
  { id: 'mk3-plate-seat', label: 'Plate Seat', file: 'mk3-plate-seat.mp3' },
  { id: 'mk3-chest-slam', label: 'Chest Slam', file: 'mk3-chest-slam.mp3' },
  { id: 'mk3-reactor', label: 'Arc Reactor Ignite', file: 'mk3-reactor.mp3' },
  { id: 'mk3-pauldron', label: 'Pauldron Drop', file: 'mk3-pauldron.mp3' },
  { id: 'mk3-arm-servo-bed', label: 'Arm Servo Bed', file: 'mk3-arm-servo-bed.mp3' },
  { id: 'mk3-arm-clamp', label: 'Upper Arm Clamp', file: 'mk3-arm-clamp.mp3' },
  { id: 'mk3-drill', label: 'Nut Runner', file: 'mk3-drill.mp3' },
  { id: 'mk3-helmet-seat', label: 'Helmet Seat', file: 'mk3-helmet-seat.mp3' },
  { id: 'mk3-gauntlet', label: 'Gauntlet Snap', file: 'mk3-gauntlet.mp3' },
  { id: 'mk3-faceplate', label: 'Arms Lock + Faceplate', file: 'mk3-faceplate.mp3' },
  { id: 'mk3-vent', label: 'Pressure Vent', file: 'mk3-vent.mp3' },
  { id: 'mk3-arm-move', label: 'Arm Move', file: 'mk3-arm-move.mp3' },
  { id: 'mk3-grip', label: 'Gripper Close', file: 'mk3-grip.mp3' },
  { id: 'mk3-release', label: 'Gripper Open', file: 'mk3-release.mp3' },
  { id: 'mk3-stand-sink', label: 'Stand Sink', file: 'mk3-stand-sink.mp3' },
  { id: 'mk3-port-lid', label: 'Port Lid', file: 'mk3-port-lid.mp3' },
  { id: 'mk3-arm-stow', label: 'Arm Stow', file: 'mk3-arm-stow.mp3' },
  { id: 'mk3-rivet', label: 'Rivet Strike', file: 'mk3-rivet.mp3' },
  { id: 'mk3-sparks', label: 'Arc Sparks', file: 'mk3-sparks.mp3' },
  { id: 'mk3-power-down', label: 'Power Down', file: 'mk3-power-down.mp3' },
  { id: 'mk3-latch', label: 'Faceplate Unlatch', file: 'mk3-latch.mp3' },
  { id: 'mk3-faceplate-open', label: 'Faceplate Open', file: 'mk3-faceplate-open.mp3' },
  { id: 'mk3-doff-vent', label: 'Seal Release Vent', file: 'mk3-doff-vent.mp3' },
  { id: 'mk3-lock-release', label: 'Lock Release', file: 'mk3-lock-release.mp3' },
  { id: 'mk3-arm-rise', label: 'Arm Rise', file: 'mk3-arm-rise.mp3' },
  { id: 'mk3-extract', label: 'Part Extract', file: 'mk3-extract.mp3' },
  { id: 'mk3-set-down', label: 'Part Set Down', file: 'mk3-set-down.mp3' },
  { id: 'mk3-boot-sink', label: 'Boot Sink', file: 'mk3-boot-sink.mp3' },
];

/**
 * Resolve a catalog file to a public URL.
 * Honors Vite `BASE_URL` so deploys under a subpath still find `/sounds/…`.
 */
export function soundUrl(file: string): string {
  const base =
    typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
      ? String(import.meta.env.BASE_URL)
      : '/';
  const root = base.endsWith('/') ? base : `${base}/`;
  // file may already be "foo.mp3" (catalog) — never double-prefix
  const name = file.replace(/^\/+/, '').replace(/^sounds\//, '');
  return `${root}sounds/${name}`;
}

export function findSound(id: string): SoundDef | undefined {
  return SOUNDS.find((s) => s.id === id);
}

/** Soft palette for overlapping clips on the timeline. */
export const CLIP_COLORS = [
  '#b01020',
  '#c9a227',
  '#2a6f9e',
  '#5a9e6f',
  '#8b5cf6',
  '#d97706',
  '#0891b2',
  '#be185d',
] as const;

export function colorForSoundId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CLIP_COLORS[h % CLIP_COLORS.length]!;
}
