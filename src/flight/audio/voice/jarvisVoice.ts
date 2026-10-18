import type { GameAudio } from '../gameAudio';

/**
 * JARVIS, spoken. Every line the sim shows is pre-rendered (Piper TTS, an
 * openly licensed British voice — not a clone of anyone — processed for the
 * suit; see scripts/render-jarvis-voice.py and public/sounds/flight/CREDITS.md)
 * and looked up here by its text. A line with no file (a new or dynamic one)
 * falls back to the browser's own speech in a British male voice if it has
 * one, else stays text-only.
 *
 * Speech has its own bus past the helmet muffle, and while he talks the
 * effects duck under him.
 */

export interface VoiceManifest {
  lines: Array<{ id: string; text: string; file: string; duration: number }>;
}

const BASE = '/sounds/flight/jarvis/';
/** Effects level while he speaks (share of the SFX slider). */
const DUCK = 0.42;
/** A line still waiting this long for the audio to wake is dropped (s). */
const STALE = 2.5;

/** Text → lookup key: case, punctuation and spacing don't matter. */
export function voiceKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The best en-GB male the browser has (names known to be male first), or any en-GB, or null. */
export function pickFallbackVoice(voices: ReadonlyArray<SpeechSynthesisVoice>): SpeechSynthesisVoice | null {
  const gb = voices.filter((v) => /^en[-_]GB/i.test(v.lang));
  const male = /daniel|arthur|george|oliver|ryan|thomas|harry|male|guy|brian|alfie|noah/i;
  const female = /female|serena|kate|stephanie|martha|libby|sonia|maisie|hazel|susan|fiona|moira|karen|tessa|samantha/i;
  return gb.find((v) => male.test(v.name) && !female.test(v.name)) ?? gb.find((v) => !female.test(v.name)) ?? gb[0] ?? null;
}

export class JarvisVoice {
  /** Voice slider (0–1). */
  voiceLevel = 1;
  /** SFX slider (0–1); ducking is a share of it. */
  sfxLevel = 1;
  /** Master slider (0–1), for the speech fallback (the bus follows the master via GameAudio.volume). */
  masterLevel = 0.9;
  /** Last lines handed to the voice (debug / tests). */
  readonly log: Array<{ text: string; via: 'file' | 'speech' | 'none'; t: number }> = [];

  private readonly byKey = new Map<string, string>();
  private readonly data = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private bus: GainNode | null = null;
  private current: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private speaking = false;
  private seq = 0;
  readonly ready: Promise<void>;

  constructor(private readonly audio: GameAudio) {
    this.ready = fetch(`${BASE}manifest.json`)
      .then((r) => (r.ok ? (r.json() as Promise<VoiceManifest>) : { lines: [] }))
      .then((m) => {
        for (const l of m.lines) {
          const url = BASE + l.file;
          this.byKey.set(voiceKey(l.text), url);
          // ~30 KB a line: fetch them all now, decode once there's a context
          this.data.set(
            url,
            fetch(url)
              .then((r) => (r.ok ? r.arrayBuffer() : null))
              .catch(() => null),
          );
        }
      })
      .catch((e) => console.warn('[jarvis] no voice manifest', e));
    // Chrome fills the voice list late
    try {
      speechSynthesis?.getVoices();
    } catch {
      /* no speech synthesis */
    }
  }

  /** Has a pre-rendered file for this text. */
  has(text: string): boolean {
    return this.byKey.has(voiceKey(text));
  }

  /** Speak a line that has just been shown. Replaces whatever he was saying. */
  say(text: string): void {
    const id = ++this.seq;
    const asked = performance.now();
    void this.ready.then(async () => {
      const url = this.byKey.get(voiceKey(text));
      if (!url) {
        if (id === this.seq) this.speakFallback(text);
        return;
      }
      const buf = await this.buffer(url);
      if (id !== this.seq) return; // a newer line took over
      if (!buf || performance.now() - asked > STALE * 1000) {
        this.log.push({ text, via: 'none', t: performance.now() });
        return;
      }
      this.playBuffer(buf, text);
    });
  }

  /** Re-applies the voice level (slider moved). */
  setLevels(master: number, sfx: number, voice: number): void {
    this.masterLevel = master;
    this.sfxLevel = sfx;
    this.voiceLevel = voice;
    const ctx = this.audio.ctx;
    if (this.bus && ctx) this.bus.gain.setTargetAtTime(this.busGain(), ctx.currentTime, 0.05);
    this.audio.setEffectsLevel(this.speaking ? sfx * DUCK : sfx);
  }

  private busGain(): number {
    // Same master as everything else (GameAudio.volume carries the handoff fade too)
    return this.voiceLevel * this.audio.volume;
  }

  /** Decoded buffer, waiting (briefly) for the context the pilot's click creates. */
  private async buffer(url: string): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(url);
    if (hit) return hit;
    const deadline = performance.now() + STALE * 1000;
    while (!this.audio.ctx && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const ctx = this.audio.ctx;
    const data = await this.data.get(url);
    if (!ctx || !data) return null;
    try {
      const buf = await ctx.decodeAudioData(data.slice(0));
      this.buffers.set(url, buf);
      return buf;
    } catch (e) {
      console.warn('[jarvis] decode', url, e);
      return null;
    }
  }

  private ensureBus(ctx: AudioContext): GainNode | null {
    if (this.bus?.context === ctx) return this.bus;
    const out = this.audio.voiceOut;
    if (!out) return null;
    this.bus = ctx.createGain();
    this.bus.gain.value = this.busGain();
    this.bus.connect(out);
    return this.bus;
  }

  private playBuffer(buf: AudioBuffer, text: string): void {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const bus = this.ensureBus(ctx);
    if (!bus) return;
    const t = ctx.currentTime;
    bus.gain.setTargetAtTime(this.busGain(), t, 0.02);
    this.stopCurrent(0.08);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    src.connect(gain).connect(bus);
    src.start(t + 0.02);
    const cur = { src, gain };
    this.current = cur;
    this.duck(true);
    src.onended = () => {
      if (this.current === cur) {
        this.current = null;
        this.duck(false);
      }
    };
    this.log.push({ text, via: 'file', t: performance.now() });
    window.dispatchEvent(new CustomEvent('jarvis-voice', { detail: { text, via: 'file', duration: buf.duration } }));
  }

  private stopCurrent(fade: number): void {
    const cur = this.current;
    const ctx = this.audio.ctx;
    if (!cur || !ctx) return;
    this.current = null;
    cur.gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
    cur.src.stop(ctx.currentTime + fade + 0.05);
  }

  private duck(on: boolean): void {
    this.speaking = on;
    // Fast under, slow back up
    this.audio.setEffectsLevel(on ? this.sfxLevel * DUCK : this.sfxLevel, on ? 0.06 : 0.35);
  }

  private speakFallback(text: string): void {
    let synth: SpeechSynthesis | undefined;
    try {
      synth = window.speechSynthesis;
    } catch {
      synth = undefined;
    }
    const voice = synth ? pickFallbackVoice(synth.getVoices()) : null;
    const level = this.voiceLevel * this.masterLevel;
    if (!synth || !voice || level <= 0.01 || this.audio.ctx?.state !== 'running') {
      this.log.push({ text, via: 'none', t: performance.now() });
      return;
    }
    this.stopCurrent(0.08);
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 0.98;
    u.pitch = 0.95;
    u.volume = Math.min(1, level);
    u.onstart = () => this.duck(true);
    u.onend = u.onerror = () => this.duck(false);
    synth.speak(u);
    this.log.push({ text, via: 'speech', t: performance.now() });
    window.dispatchEvent(new CustomEvent('jarvis-voice', { detail: { text, via: 'speech' } }));
  }
}
