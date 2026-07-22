/** Shared SFX catalog for soundboard + assembly audio timeline. */

export type SoundDef = {
  id: string;
  label: string;
  file: string;
  /** Keyboard shortcut on the standalone soundboard (1–9, 0, Q, …) */
  key: string;
};

/** Pads available in the authoring soundboard / timeline library. */
export const SOUNDS: SoundDef[] = [
  { id: 'drill-tighten', label: 'Drill Tighten', file: 'drill-tighten.mp3', key: '1' },
  { id: 'electric-motor', label: 'Electric Motor', file: 'electric-motor.mp3', key: '2' },
  { id: 'footstep', label: 'Footstep', file: 'footstep.mp3', key: '3' },
  { id: 'impact', label: 'Impact', file: 'impact.mp3', key: '4' },
  { id: 'light-attach', label: 'Light Attach', file: 'light-attach.mp3', key: '5' },
  { id: 'medium-close', label: 'Medium Close', file: 'medium-close.mp3', key: '6' },
  { id: 'metal-clang', label: 'Metal Clang', file: 'metal-clang.mp3', key: '7' },
  { id: 'repulsor', label: 'Repulsor', file: 'repulsor.mp3', key: '8' },
  { id: 'metal-sliding', label: 'Metal Sliding', file: 'metal-sliding.mp3', key: '9' },
  { id: 'ratchet', label: 'Ratchet', file: 'ratchet.mp3', key: '0' },
  { id: 'robot-movement', label: 'Robot Movement', file: 'robot-movement.mp3', key: 'q' },
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
