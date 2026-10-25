import * as THREE from 'three';
import { SPEED_OF_SOUND } from '../world/config';

/**
 * The sim's sound engine (Web Audio). Every effect is a real recording
 * from the project library or the CC0 kit; nothing is synthesised. What
 * it adds is placement:
 *  - HRTF panning from where the sound happened, relative to the camera;
 *  - distance: inverse falloff plus air absorption (highs die first);
 *  - propagation delay at 343 m/s, so a blast two kilometres off is seen
 *    before it's heard, and a supersonic suit outruns its own noise;
 *  - Doppler on anything moving fast (rockets, drones, the suit's own
 *    pass in a flyby camera);
 *  - a shared outdoor slap-back off the hills for the big ones.
 * Loops (boots, wind, beam) are steered by the sim every frame.
 */

export interface PlayOptions {
  at?: THREE.Vector3;
  /** Source velocity (Doppler). */
  vel?: THREE.Vector3;
  gain?: number;
  /** Playback rate (pitch). */
  rate?: number;
  /** ± random detune as a share of rate. */
  vary?: number;
  /** Distance at which the gain halves (m). */
  ref?: number;
  /** Start offset into the file (s). */
  offset?: number;
  /** Delay before it starts (s). */
  delay?: number;
  /** Send to the hill echo (0–1). */
  echo?: number;
  /** Override the HUD bus (no 3D). */
  ui?: boolean;
  /** Low-pass cutoff (Hz). */
  lowpass?: number;
  /** Fade out over the last n s (or stop after `duration`). */
  duration?: number;
  /** Fade in over the first n s (a slice cut from the middle of a recording). */
  fadeIn?: number;
  /** Sound travels at 343 m/s (default). False: it's arriving now (a shock front reaching the ear). */
  propagate?: boolean;
}

/**
 * A moving source heard from where the camera stands: whatever is fed into
 * {@link input} reaches the ear through the air — a delay line held at (a share
 * of) the sound's flight time, so a fast source's pitch bends as the path
 * shortens and stretches — Doppler from the geometry, not a guessed rate, air
 * absorption over the distance, and an HRTF panner placed where the sound
 * was *emitted*, not where the source is now.
 */
export interface Emitter {
  readonly input: GainNode;
  /** Steer from the source's track and the ear; `mix` fades the whole path. */
  update(src: { at(t: number, out: THREE.Vector3): THREE.Vector3 }, now: number, ear: THREE.Vector3, mix: number, gate: number): void;
  /** Seconds of travel the path currently holds. */
  readonly lag: number;
}

export interface Loop {
  set(gain: number, rate?: number, lowpass?: number): void;
  place(at: THREE.Vector3): void;
  stop(): void;
}

/** Most simultaneous voices of one file. */
const MAX_VOICES = 8;
/** Longest flight time an emitter path holds (s, ~2 km). */
const MAX_LAG = 6;
/** Share of the true flight time an emitter path delays by (see {@link GameAudio.emitter}). */
const LAG_SHARE = 0.6;

export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private uiBus!: GainNode;
  private echo!: GainNode;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<ArrayBuffer>>();
  private readonly listenerPos = new THREE.Vector3();
  private readonly listenerVel = new THREE.Vector3();
  private readonly lastEar = new THREE.Vector3();
  private readonly _f = new THREE.Vector3();
  private readonly _u = new THREE.Vector3();
  /** Muffle for the helmet view / reboot (0–1). */
  private muffleNode!: BiquadFilterNode;
  private unlocking: Promise<void> | null = null;
  /** Voices of each file still sounding (see {@link MAX_VOICES}). */
  private readonly voices = new Map<string, number>();
  /** Crossfaded loop cuts, by file and span. */
  private readonly loopBuffers = new Map<string, AudioBuffer>();
  private decoded = false;
  private paused = false;
  volume = 0.9;

  constructor() {
    // Any gesture wakes a context the browser suspended (autoplay policy,
    // a context first made outside a gesture, an interrupted session)
    const wake = () => {
      if (this.ctx && !this.paused && this.ctx.state !== 'running') void this.ctx.resume();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, wake, true);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    this.setEffectsLevel(this.effects);
  }

  // ── Mix levels for the pause menu ──
  /** SFX slider (0–1). */
  private effects = 1;
  /** Effects buses' level: the SFX slider. */
  setEffectsLevel(k: number, ramp = 0.06): void {
    this.effects = k;
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(k, t, ramp);
    // The HUD bus skips the master gain (and its muffle): scale it here
    this.uiBus.gain.setTargetAtTime(0.7 * k * this.volume, t, ramp);
  }


  /** Fetch every file up front (decode waits for the context). */
  preload(urls: string[]): Promise<void> {
    return Promise.all(urls.map((u) => this.fetchFile(u))).then(() => undefined);
  }

  private fetchFile(url: string): Promise<ArrayBuffer> {
    let p = this.pending.get(url);
    if (!p) {
      p = fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r.arrayBuffer();
      });
      this.pending.set(url, p);
    }
    return p;
  }

  /** Create the context inside a user gesture, then decode everything. */
  unlock(): Promise<void> {
    if (this.ctx && !this.paused && this.ctx.state !== 'running') void this.ctx.resume();
    this.unlocking ??= this.create();
    return this.unlocking;
  }

  /** Pause stops every sound where it is; resuming picks them up again. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!this.ctx) return;
    if (paused) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  private async create(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.muffleNode = ctx.createBiquadFilter();
    this.muffleNode.type = 'lowpass';
    this.muffleNode.frequency.value = 20000;
    this.master.connect(this.muffleNode).connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.uiBus = ctx.createGain();
    this.uiBus.gain.value = 0.7 * this.effects * this.volume;
    this.sfx.gain.value = this.effects;
    this.uiBus.connect(comp);
    // Hill echo: a couple of long, dark slap-backs (outdoors there's no
    // room, only the terrain throwing the big sounds back)
    this.echo = ctx.createGain();
    this.echo.gain.value = 0.5;
    for (const [t, g, f] of [
      [0.42, 0.35, 1400],
      [0.95, 0.22, 900],
      [1.7, 0.12, 600],
    ] as const) {
      const d = ctx.createDelay(3);
      d.delayTime.value = t;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.value = g;
      this.echo.connect(d).connect(lp).connect(gn).connect(this.master);
    }
    await Promise.all(
      [...this.pending.keys()].map(async (url) => {
        try {
          const data = await this.fetchFile(url);
          this.buffers.set(url, await ctx.decodeAudioData(data.slice(0)));
        } catch (e) {
          console.warn('audio', url, e);
        }
      }),
    );
    this.decoded = true;
  }

  /** Every file decoded: loops started before this would come up silent. */
  get ready(): boolean {
    return !!this.ctx && this.decoded;
  }

  /** Camera = ears. */
  setListener(cam: THREE.Camera, vel: THREE.Vector3, dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const L = ctx.listener;
    this.listenerVel.copy(vel);
    this.listenerPos.copy(cam.position);
    const f = cam.getWorldDirection(this._f);
    const u = this._u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const t = ctx.currentTime;
    // A camera cut is a cut in the sound too: jump, don't sweep the ears
    // across the gap (every panner would swing through the head)
    const jump = this.lastEar.distanceToSquared(cam.position) > 25 * 25;
    this.lastEar.copy(cam.position);
    if (L.positionX && jump) {
      L.positionX.cancelScheduledValues(t);
      L.positionY.cancelScheduledValues(t);
      L.positionZ.cancelScheduledValues(t);
      L.positionX.setValueAtTime(cam.position.x, t);
      L.positionY.setValueAtTime(cam.position.y, t);
      L.positionZ.setValueAtTime(cam.position.z, t);
    }
    if (L.positionX) {
      L.positionX.setTargetAtTime(cam.position.x, t, dt);
      L.positionY.setTargetAtTime(cam.position.y, t, dt);
      L.positionZ.setTargetAtTime(cam.position.z, t, dt);
      L.forwardX.setTargetAtTime(f.x, t, dt);
      L.forwardY.setTargetAtTime(f.y, t, dt);
      L.forwardZ.setTargetAtTime(f.z, t, dt);
      L.upX.setTargetAtTime(u.x, t, dt);
      L.upY.setTargetAtTime(u.y, t, dt);
      L.upZ.setTargetAtTime(u.z, t, dt);
    } else {
      L.setPosition(cam.position.x, cam.position.y, cam.position.z);
      L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  /** 0 = open air, 1 = heavily muffled. */
  muffle(k: number): void {
    if (!this.ctx) return;
    this.muffleNode.frequency.setTargetAtTime(20000 * Math.pow(0.04, k), this.ctx.currentTime, 0.08);
  }

  play(url: string, o: PlayOptions = {}): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    const buf = this.buffers.get(url);
    if (!ctx || !buf) return null;
    // A runaway trigger (an event firing every physics step) would stack
    // hundreds of HRTF voices of one file: a grating comb, a clipped bus and
    // an audio thread that can't keep up (the whole mix drops out). Cap it.
    const live = this.voices.get(url) ?? 0;
    if (live >= MAX_VOICES) return null;
    this.voices.set(url, live + 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.onended = () => this.voices.set(url, Math.max(0, (this.voices.get(url) ?? 1) - 1));
    let rate = o.rate ?? 1;
    if (o.vary) rate *= 1 + (Math.random() * 2 - 1) * o.vary;
    let delay = o.delay ?? 0;
    let node: AudioNode = src;
    const gain = ctx.createGain();
    gain.gain.value = o.gain ?? 1;
    let cutoff = o.lowpass ?? 22000;
    if (o.at && !o.ui) {
      const d = o.at.distanceTo(this.listenerPos);
      // Sound travels: hear it when it arrives
      if (o.propagate !== false) delay += d / SPEED_OF_SOUND;
      // Air eats the highs over distance
      cutoff = Math.min(cutoff, 20000 * Math.exp(-d / 1400) + 500);
      if (o.vel) {
        const dir = this._f.copy(this.listenerPos).sub(o.at).normalize();
        const vs = o.vel.dot(dir);
        const vl = this.listenerVel.dot(dir);
        rate *= THREE.MathUtils.clamp((SPEED_OF_SOUND - vl * 0.5) / Math.max(60, SPEED_OF_SOUND - vs), 0.5, 2);
      }
    }
    src.playbackRate.value = rate;
    if (cutoff < 21000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      node.connect(lp);
      node = lp;
    }
    node.connect(gain);
    node = gain;
    if (o.at && !o.ui) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = o.ref ?? 12;
      p.rolloffFactor = 1;
      p.maxDistance = 100000;
      p.positionX.value = o.at.x;
      p.positionY.value = o.at.y;
      p.positionZ.value = o.at.z;
      node.connect(p);
      node = p;
    }
    node.connect(o.ui ? this.uiBus : this.sfx);
    if (o.echo) {
      const send = ctx.createGain();
      send.gain.value = o.echo;
      node.connect(send).connect(this.echo);
    }
    const t0 = ctx.currentTime + Math.min(delay, 12);
    if (o.fadeIn) {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(o.gain ?? 1, t0 + o.fadeIn);
    }
    if (o.duration !== undefined) {
      gain.gain.setValueAtTime(o.gain ?? 1, t0 + Math.max(0, o.duration - 0.08));
      gain.gain.linearRampToValueAtTime(0, t0 + o.duration);
      src.start(t0, o.offset ?? 0, o.duration * rate + 0.05);
    } else {
      src.start(t0, o.offset ?? 0);
    }
    return src;
  }

  /** A mixing bus into the effects (gain steered by the caller). */
  bus(): GainNode | null {
    if (!this.ctx) return null;
    const g = this.ctx.createGain();
    g.connect(this.sfx);
    return g;
  }

  /** A path through the air from a moving source to the camera (see {@link Emitter}). */
  emitter(ref = 20): Emitter | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const input = ctx.createGain();
    const delay = ctx.createDelay(MAX_LAG + 0.5);
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 20000;
    air.Q.value = 0.5;
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = ref;
    pan.rolloffFactor = 1;
    pan.maxDistance = 100000;
    const mix = ctx.createGain();
    mix.gain.value = 0;
    input.connect(delay).connect(air).connect(pan).connect(mix).connect(this.sfx);
    const c = ctx;
    const emitted = new THREE.Vector3();
    const lastEar = new THREE.Vector3();
    let lag = 0;
    let lastNow = -1;
    let silent = true;
    return {
      input,
      get lag() {
        return lag;
      },
      update(src, now, ear, m, gate) {
        const t = c.currentTime;
        const dt = lastNow < 0 ? 0 : Math.max(0, now - lastNow);
        lastNow = now;
        // Flight time, scaled the way film sound does it: the true retarded
        // time of a suit closing at Mach 0.6 is seconds (you'd hear it go by
        // a second after you saw it, at 2.8x pitch going in). A share of the
        // distance keeps the lag and the Doppler bend (here ±~40 %) without
        // the roar of the pass arriving after the picture of it
        src.at(now, emitted);
        const goal = Math.min(MAX_LAG, (LAG_SHARE * emitted.distanceTo(ear)) / SPEED_OF_SOUND);
        const audible = m * gate > 1e-3;
        // A cut (or the path coming back from silence) re-lays the line in
        // one go under a 40 ms duck; otherwise it may only slide at a rate
        // the ear hears as Doppler (|dlag/dt| < 1, or the line runs backwards)
        // (past ~Mach 0.45 closing the true pitch would run away to 1/(1-M):
        // the line falls behind instead and catches up once it's gone by)
        const moved = lastEar.distanceToSquared(ear) > 20 * 20;
        lastEar.copy(ear);
        // The sound heard now left the suit `lag` ago: pan from there
        src.at(now - lag, emitted);
        const cut = moved || silent || dt === 0 || Math.abs(goal - lag) > 1.5;
        if (cut) {
          lag = goal;
          mix.gain.cancelScheduledValues(t);
          mix.gain.setTargetAtTime(0, t, 0.008);
          delay.delayTime.setValueAtTime(lag, t + 0.04);
          pan.positionX.setValueAtTime(emitted.x, t + 0.04);
          pan.positionY.setValueAtTime(emitted.y, t + 0.04);
          pan.positionZ.setValueAtTime(emitted.z, t + 0.04);
          mix.gain.setTargetAtTime(m * gate, t + 0.045, 0.03);
        } else {
          lag += THREE.MathUtils.clamp(goal - lag, -0.85 * dt, 0.85 * dt);
          delay.delayTime.setTargetAtTime(lag, t, 0.035);
          pan.positionX.setTargetAtTime(emitted.x, t, 0.035);
          pan.positionY.setTargetAtTime(emitted.y, t, 0.035);
          pan.positionZ.setTargetAtTime(emitted.z, t, 0.035);
          mix.gain.setTargetAtTime(m * gate, t, gate < 0.5 ? 0.03 : 0.12);
        }
        silent = !audible;
        // Air eats the highs over distance (a kilometre takes the top octaves)
        const d = lag * SPEED_OF_SOUND;
        air.frequency.setTargetAtTime(17000 * Math.exp(-d / 650) + 650, t, 0.05);
      },
    };
  }

  /**
   * [start, end] of a recording cut out as its own buffer whose tail is
   * crossfaded (equal power) into its head, so it loops with no seam. A raw
   * loopStart/loopEnd jump lands mid-waveform (and an mp3's ends carry
   * encoder padding): a broadband click once per lap, loudest on the boots.
   */
  private seamless(url: string, buf: AudioBuffer, start: number, end: number): AudioBuffer {
    const key = `${url}|${start}|${end}`;
    const hit = this.loopBuffers.get(key);
    if (hit) return hit;
    const sr = buf.sampleRate;
    const i0 = Math.max(0, Math.floor(start * sr));
    const n = Math.min(buf.length, Math.floor(end * sr)) - i0;
    const x = Math.min(Math.floor(0.12 * sr), Math.floor(n / 4));
    const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: n - x, sampleRate: sr });
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const seg = buf.getChannelData(ch).subarray(i0, i0 + n);
      const o = out.getChannelData(ch);
      o.set(seg.subarray(0, n - x));
      // The lap's last x samples fade out over its first x fading in
      for (let i = 0; i < x; i++) {
        const k = (i + 0.5) / x;
        o[i] = seg[i] * Math.sin(k * Math.PI * 0.5) + seg[n - x + i] * Math.cos(k * Math.PI * 0.5);
      }
    }
    this.loopBuffers.set(key, out);
    return out;
  }

  /** A steered, seamless loop over [start, end] of a file. */
  loop(url: string, opts: { start?: number; end?: number; spatial?: boolean; ref?: number; ui?: boolean; out?: AudioNode[] } = {}): Loop | null {
    const ctx = this.ctx;
    const file = this.buffers.get(url);
    if (!ctx || !file) return null;
    const buf = this.seamless(url, file, opts.start ?? 0, opts.end ?? file.duration);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 20000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(lp).connect(gain);
    let panner: PannerNode | null = null;
    if (opts.spatial) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = opts.ref ?? 10;
      gain.connect(panner).connect(this.sfx);
    } else if (opts.out) {
      for (const o of opts.out) gain.connect(o);
    } else {
      gain.connect(opts.ui ? this.uiBus : this.sfx);
    }
    src.start(ctx.currentTime);
    const c = ctx;
    return {
      set(g: number, rate = 1, lowpass = 20000) {
        const t = c.currentTime;
        gain.gain.setTargetAtTime(g, t, 0.06);
        src.playbackRate.setTargetAtTime(rate, t, 0.08);
        lp.frequency.setTargetAtTime(lowpass, t, 0.08);
      },
      place(at: THREE.Vector3) {
        if (!panner) return;
        const t = c.currentTime;
        panner.positionX.setTargetAtTime(at.x, t, 0.03);
        panner.positionY.setTargetAtTime(at.y, t, 0.03);
        panner.positionZ.setTargetAtTime(at.z, t, 0.03);
      },
      stop() {
        gain.gain.setTargetAtTime(0, c.currentTime, 0.05);
        src.stop(c.currentTime + 0.4);
      },
    };
  }
}
