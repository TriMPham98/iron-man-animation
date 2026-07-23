/** SFX catalog for the director audio timeline. */

export type SoundDef = {
  id: string;
  label: string;
  file: string;
};

/** Clips available in the timeline library. */
export const SOUNDS: SoundDef[] = [
  { id: 'clasp-long-conveyor', label: 'Clasp Long Conveyor', file: 'clasp-long-conveyor.mp3' },
  { id: 'connect-hiss', label: 'Connect Hiss', file: 'connect-hiss.mp3' },
  { id: 'conveyor-hiss', label: 'Conveyor Hiss', file: 'conveyor-hiss.mp3' },
  { id: 'drill-tighten', label: 'Drill Tighten', file: 'drill-tighten.mp3' },
  { id: 'electric-motor', label: 'Electric Motor', file: 'electric-motor.mp3' },
  { id: 'footstep', label: 'Footstep', file: 'footstep.mp3' },
  { id: 'impact', label: 'Impact', file: 'impact.mp3' },
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
];

export function soundUrl(file: string): string {
  return `/sounds/${file}`;
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
