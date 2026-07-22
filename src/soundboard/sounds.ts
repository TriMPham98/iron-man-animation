export type SoundDef = {
  id: string;
  label: string;
  file: string;
  /** Keyboard shortcut (1–9, 0, Q, W, …) */
  key: string;
};

/** Pads available in the authoring soundboard. */
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

export type SequenceEvent = {
  /** Wall-clock seconds from REC start (how you actually tapped). */
  wallT: number;
  /** Intended 1× timeline seconds = wallT * playbackRate at record time. */
  t1x: number;
  id: string;
  label: string;
  /** Playback rate used when this event was recorded. */
  rate: number;
};
