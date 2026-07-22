/** Re-export shared catalog; sequence types stay soundboard-local. */
export type { SoundDef } from '../audio/sounds';
export { SOUNDS } from '../audio/sounds';

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
