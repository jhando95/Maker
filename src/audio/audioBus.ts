/**
 * All game audio, synthesized at runtime.
 *
 * There are no audio files, by the same rule that governs the art: everything is
 * generated in code. Every sound here is oscillators, filtered noise and
 * envelopes, which keeps the download at zero bytes and — more usefully — lets
 * sounds be parameterized by gameplay. A footstep can shift pitch with surface
 * and speed because it is being built, not played back.
 *
 * An AudioContext cannot start without a user gesture. Browsers create it in a
 * "suspended" state and only `resume()` inside a real input event works, so
 * `unlock()` is wired to the same click that grabs pointer lock.
 */

export type SoundName =
  | 'stepGrass'
  | 'stepWood'
  | 'place'
  | 'snap'
  | 'invalid'
  | 'remove'
  | 'collapse'
  | 'spray'
  | 'jump'
  | 'land'
  | 'throw'
  | 'splash'
  | 'hit'
  | 'roundStart'
  | 'roundWin'
  | 'roundLose'
  | 'uiClick'
  | 'ping'
  | 'emote'
  | 'chat';

export interface PlayOptions {
  /** 0..1, multiplied into the category gain. */
  volume?: number;
  /** Multiplies every frequency in the recipe. 1 is as designed. */
  pitch?: number;
  /** Stereo position, -1 left to +1 right. */
  pan?: number;
  /** Attenuation from distance, 0..1. Callers compute this from world space. */
  distance?: number;
}

/**
 * Cap on simultaneous voices.
 *
 * A burst of balloon splashes will otherwise stack dozens of gain nodes into
 * the destination and clip hard. Oldest voices are stopped first, which is
 * nearly always the right choice for short percussive sounds.
 */
const MAX_VOICES = 24;

interface Voice {
  nodes: AudioNode[];
  startedAt: number;
  stop(): void;
}

/** A sound that keeps going, and moves. */
export interface AmbientLoop {
  /** Gain 0..1 and pan -1..1. Safe to call every frame; both are ramped. */
  set(volume: number, pan: number): void;
  stop(): void;
}

export class AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  /**
   * Where other people's voices arrive.
   *
   * Under `master` and beside `sfx` rather than under it, which is the whole of
   * the decision: a player turning the game's effects down to hear their
   * friends must not turn their friends down too, and the mute button has to
   * silence everything including them.
   */
  private voiceGain: GainNode | null = null;

  /** Reused white-noise buffer — regenerating it per sound is pure waste. */
  private noiseBuffer: AudioBuffer | null = null;

  private voices: Voice[] = [];
  private ambientNodes: AudioNode[] = [];

  masterVolume = 0.7;
  sfxVolume = 1.0;
  voiceVolume = 1.0;
  muted = false;

  /**
   * The context, for anything that has to build its own graph.
   *
   * Voice is the one such thing and probably the only one there will ever be: a
   * `MediaStreamAudioSourceNode` cannot be created by anything in this file
   * because the stream arrives from a peer connection. Handing out the context
   * rather than growing a `playRemoteStream` method keeps the WebRTC types out
   * of the audio layer entirely.
   *
   * Null until somebody has clicked, like everything else here.
   */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** What voice should connect to. Null until the context exists. */
  get voiceDestination(): AudioNode | null {
    return this.voiceGain;
  }

  /** True once a user gesture has actually started the context. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Start or resume audio. Must be called from inside a user gesture handler —
   * calling it on load leaves the context suspended and every sound silent.
   */
  async unlock(): Promise<void> {
    if (this.ctx === null) this.init();
    if (this.ctx !== null && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // Some browsers reject if the gesture has already been consumed; the
        // next click will try again.
      }
    }
  }

  private init(): void {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterVolume;
    this.master.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVolume;
    this.sfx.connect(this.master);

    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0.0;
    this.ambientGain.connect(this.master);

    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = this.voiceVolume;
    this.voiceGain.connect(this.master);

    // Two seconds of white noise, looped and re-windowed per use. Long enough
    // that consecutive footsteps do not audibly repeat the same grains.
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deliberately Math.random: this is presentation only and never touches
    // world state, so it does not need to be reproducible.
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.master !== null) this.master.gain.value = this.muted ? 0 : this.masterVolume;
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfx !== null) this.sfx.gain.value = this.sfxVolume;
  }

  setVoiceVolume(v: number): void {
    this.voiceVolume = Math.max(0, Math.min(1, v));
    if (this.voiceGain !== null) this.voiceGain.gain.value = this.voiceVolume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master !== null) this.master.gain.value = muted ? 0 : this.masterVolume;
  }

  /** Retire the oldest voice when the cap is reached. */
  private reserveVoice(): void {
    while (this.voices.length >= MAX_VOICES) {
      const oldest = this.voices.shift();
      oldest?.stop();
    }
  }

  private cleanup(voice: Voice): void {
    const i = this.voices.indexOf(voice);
    if (i !== -1) this.voices.splice(i, 1);
  }

  /**
   * Build the per-sound output chain: gain for level, panner for direction.
   *
   * StereoPannerNode rather than PannerNode. Full 3D panning needs a listener
   * orientation kept in sync with the camera every frame, and for a game played
   * at this scale it buys almost nothing over a stereo position the caller
   * already knows how to compute.
   */
  private chain(options: PlayOptions): { input: AudioNode; gain: GainNode } | null {
    if (this.ctx === null || this.sfx === null) return null;
    const gain = this.ctx.createGain();
    const distance = options.distance ?? 1;
    gain.gain.value = (options.volume ?? 1) * distance;

    const pan = options.pan ?? 0;
    if (pan !== 0 && typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      panner.connect(this.sfx);
    } else {
      gain.connect(this.sfx);
    }
    return { input: gain, gain };
  }

  private noiseSource(duration: number): AudioBufferSourceNode | null {
    if (this.ctx === null || this.noiseBuffer === null) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    // Start at a random offset so repeated hits do not replay identical grains.
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.noiseBuffer.duration;
    void duration;
    return src;
  }

  play(name: SoundName, options: PlayOptions = {}): void {
    if (!this.running || this.muted) return;
    this.reserveVoice();
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const p = options.pitch ?? 1;

    switch (name) {
      // A soft broadband crunch: noise through a bandpass that sweeps down.
      // Grass has no tonal component at all, which is what distinguishes it
      // from wood.
      case 'stepGrass':
        this.noiseBurst(t, {
          duration: 0.11,
          filter: 'bandpass',
          freqStart: 1600 * p,
          freqEnd: 700 * p,
          q: 1.1,
          peak: 0.32,
          attack: 0.005,
        }, options);
        break;

      // Wood adds a short pitched knock under the noise — a hollow board.
      case 'stepWood':
        this.noiseBurst(t, {
          duration: 0.09,
          filter: 'bandpass',
          freqStart: 2600 * p,
          freqEnd: 1200 * p,
          q: 1.8,
          peak: 0.26,
          attack: 0.003,
        }, options);
        this.tone(t, {
          type: 'triangle',
          freqStart: 210 * p,
          freqEnd: 150 * p,
          duration: 0.1,
          peak: 0.14,
          attack: 0.002,
        }, options);
        break;

      // Placing a part: a woody thunk with a little body. The pitch drop is
      // what makes it read as "settled into place" rather than "tapped".
      case 'place':
        this.tone(t, {
          type: 'triangle',
          freqStart: 260 * p,
          freqEnd: 120 * p,
          duration: 0.16,
          peak: 0.3,
          attack: 0.002,
        }, options);
        this.noiseBurst(t, {
          duration: 0.07,
          filter: 'lowpass',
          freqStart: 2400 * p,
          freqEnd: 600 * p,
          q: 0.7,
          peak: 0.18,
          attack: 0.001,
        }, options);
        break;

      // The snap tick has to be audible dozens of times a minute without
      // becoming irritating, so it is very short, very quiet, and high.
      case 'snap':
        this.tone(t, {
          type: 'sine',
          freqStart: 2100 * p,
          freqEnd: 2400 * p,
          duration: 0.035,
          peak: 0.075,
          attack: 0.001,
        }, options);
        break;

      case 'invalid':
        this.tone(t, {
          type: 'square',
          freqStart: 150 * p,
          freqEnd: 110 * p,
          duration: 0.12,
          peak: 0.1,
          attack: 0.004,
        }, options);
        break;

      // Removal is placement reversed: pitch rises as the part comes away.
      case 'remove':
        this.tone(t, {
          type: 'triangle',
          freqStart: 140 * p,
          freqEnd: 300 * p,
          duration: 0.12,
          peak: 0.22,
          attack: 0.002,
        }, options);
        break;

      case 'jump':
        this.tone(t, {
          type: 'sine',
          freqStart: 320 * p,
          freqEnd: 560 * p,
          duration: 0.13,
          peak: 0.18,
          attack: 0.004,
        }, options);
        break;

      case 'land':
        this.tone(t, {
          type: 'sine',
          freqStart: 220 * p,
          freqEnd: 90 * p,
          duration: 0.16,
          peak: 0.26,
          attack: 0.002,
        }, options);
        this.noiseBurst(t, {
          duration: 0.1,
          filter: 'lowpass',
          freqStart: 1200 * p,
          freqEnd: 400 * p,
          q: 0.7,
          peak: 0.2,
          attack: 0.001,
        }, options);
        break;

      // A throw is pure air: noise swept upward through a narrow bandpass.
      case 'throw':
        this.noiseBurst(t, {
          duration: 0.18,
          filter: 'bandpass',
          freqStart: 500 * p,
          freqEnd: 1900 * p,
          q: 3.5,
          peak: 0.2,
          attack: 0.02,
        }, options);
        break;

      // A splash is a bright noise burst decaying fast, with a low thump under
      // it for the impact itself.
      case 'splash':
        this.noiseBurst(t, {
          duration: 0.3,
          filter: 'highpass',
          freqStart: 900 * p,
          freqEnd: 3200 * p,
          q: 0.6,
          peak: 0.34,
          attack: 0.001,
        }, options);
        this.tone(t, {
          type: 'sine',
          freqStart: 180 * p,
          freqEnd: 60 * p,
          duration: 0.14,
          peak: 0.22,
          attack: 0.001,
        }, options);
        break;

      // ── The three comms sounds ────────────────────────────────────────────
      //
      // Deliberately unlike anything the world makes. A ping shares a corner of
      // the screen with a hit marker and a balloon splash, and a cue that could
      // be mistaken for either is worse than no cue: two clean tones a fifth
      // apart is a sound nothing in a garden makes, which is exactly why it
      // reads as somebody talking to you.
      case 'ping':
        this.tone(t, {
          type: 'triangle', freqStart: 1180 * p, freqEnd: 1180 * p,
          duration: 0.09, peak: 0.3, attack: 0.004,
        }, options);
        this.tone(t + 0.075, {
          type: 'triangle', freqStart: 1760 * p, freqEnd: 1760 * p,
          duration: 0.16, peak: 0.26, attack: 0.004,
        }, options);
        break;

      case 'emote':
        // One note, up. Lighter than a ping and shorter than a chat blip,
        // because an emote is the least urgent thing anybody can send.
        this.tone(t, {
          type: 'sine', freqStart: 700 * p, freqEnd: 1050 * p,
          duration: 0.13, peak: 0.2, attack: 0.006,
        }, options);
        break;

      case 'chat':
        // Quiet and low. It fires once per line and a chatty lobby would
        // otherwise be a metronome over the top of the game.
        this.tone(t, {
          type: 'sine', freqStart: 520 * p, freqEnd: 620 * p,
          duration: 0.07, peak: 0.13, attack: 0.004,
        }, options);
        break;

      case 'hit':
        this.tone(t, {
          type: 'square',
          freqStart: 420 * p,
          freqEnd: 180 * p,
          duration: 0.12,
          peak: 0.18,
          attack: 0.001,
        }, options);
        break;

      // Stingers are little arpeggios rather than chords — cheaper, and they
      // read as cartoon rather than orchestral.
      case 'roundStart':
        this.arpeggio(t, [523.25, 659.25, 783.99], 0.09, 0.22, options);
        break;
      case 'roundWin':
        this.arpeggio(t, [523.25, 659.25, 783.99, 1046.5], 0.11, 0.26, options);
        break;
      case 'roundLose':
        this.arpeggio(t, [440, 392, 349.23, 261.63], 0.14, 0.24, options);
        break;

      // A structure coming down: four or five wooden knocks falling over about
      // a third of a second, each lower and softer than the last, over one dull
      // thump for the mass of it.
      //
      // Composed here rather than by playing `remove` several times from the
      // caller, and the reason is the voice cap: a thirty-part collapse firing
      // thirty removals would spend every voice the bus has on one event and
      // silence the footsteps, the water and everybody's chat along with it.
      // One sound, however much came down.
      case 'collapse': {
        // Deterministic offsets rather than random ones. The recipe is played
        // from the simulation's own removal path, and a sound is the one place
        // in this codebase where `Math.random` is fine — but a fixed rhythm
        // reads as *one thing falling apart* and a scattered one reads as
        // several unrelated noises.
        const knocks = [0, 0.075, 0.155, 0.25, 0.33];
        for (let i = 0; i < knocks.length; i++) {
          this.noiseBurst(t + knocks[i]!, {
            duration: 0.09,
            filter: 'bandpass',
            freqStart: (620 - i * 70) * p,
            freqEnd: (260 - i * 30) * p,
            q: 2.4,
            peak: 0.2 * (1 - i * 0.14),
            attack: 0.002,
          }, options);
        }
        this.tone(t, {
          type: 'triangle',
          freqStart: 110 * p,
          freqEnd: 48 * p,
          duration: 0.42,
          peak: 0.16,
          attack: 0.004,
        }, options);
        break;
      }

      // A can of paint: a short hiss of high noise, with the barest tick of a
      // valve at the front. Two things rather than one, because pure noise
      // reads as static and the tick is what makes it an object.
      case 'spray':
        this.noiseBurst(t, {
          duration: 0.13,
          filter: 'highpass',
          freqStart: 2600 * p,
          freqEnd: 5200 * p,
          q: 0.6,
          peak: 0.1,
          attack: 0.008,
        }, options);
        this.tone(t, {
          type: 'square',
          freqStart: 1500 * p,
          freqEnd: 900 * p,
          duration: 0.02,
          peak: 0.03,
          attack: 0.001,
        }, options);
        break;

      case 'uiClick':
        this.tone(t, {
          type: 'sine',
          freqStart: 900 * p,
          freqEnd: 1150 * p,
          duration: 0.045,
          peak: 0.12,
          attack: 0.001,
        }, options);
        break;
    }
  }

  /** A pitched envelope, the building block of every tonal sound here. */
  private tone(
    t: number,
    spec: {
      type: OscillatorType;
      freqStart: number;
      freqEnd: number;
      duration: number;
      peak: number;
      attack: number;
    },
    options: PlayOptions,
  ): void {
    const ctx = this.ctx!;
    const out = this.chain(options);
    if (out === null) return;

    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freqStart, t);
    // Exponential rather than linear: pitch is perceived logarithmically, so a
    // linear ramp sounds like it slows down as it falls.
    osc.frequency.exponentialRampToValueAtTime(Math.max(spec.freqEnd, 1), t + spec.duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(spec.peak, t + spec.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + spec.duration);

    osc.connect(env);
    env.connect(out.input);
    osc.start(t);
    osc.stop(t + spec.duration + 0.02);

    const voice: Voice = {
      nodes: [osc, env],
      startedAt: t,
      stop: () => {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
      },
    };
    this.voices.push(voice);
    osc.onended = () => {
      env.disconnect();
      this.cleanup(voice);
    };
  }

  /** Filtered noise, the building block of every percussive sound here. */
  private noiseBurst(
    t: number,
    spec: {
      duration: number;
      filter: BiquadFilterType;
      freqStart: number;
      freqEnd: number;
      q: number;
      peak: number;
      attack: number;
    },
    options: PlayOptions,
  ): void {
    const ctx = this.ctx!;
    const out = this.chain(options);
    if (out === null) return;

    const src = this.noiseSource(spec.duration);
    if (src === null) return;

    const filter = ctx.createBiquadFilter();
    filter.type = spec.filter;
    filter.Q.value = spec.q;
    filter.frequency.setValueAtTime(spec.freqStart, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(spec.freqEnd, 1), t + spec.duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(spec.peak, t + spec.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + spec.duration);

    src.connect(filter);
    filter.connect(env);
    env.connect(out.input);
    // Random offset into the loop so repeated hits do not replay identical
    // grains, which is what makes machine-gun footsteps sound synthetic.
    src.start(t, Math.random() * 1.5);
    src.stop(t + spec.duration + 0.02);

    const voice: Voice = {
      nodes: [src, filter, env],
      startedAt: t,
      stop: () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      },
    };
    this.voices.push(voice);
    src.onended = () => {
      filter.disconnect();
      env.disconnect();
      this.cleanup(voice);
    };
  }

  private arpeggio(
    t: number,
    freqs: number[],
    step: number,
    peak: number,
    options: PlayOptions,
  ): void {
    freqs.forEach((f, i) => {
      this.tone(t + i * step, {
        type: 'triangle',
        freqStart: f,
        freqEnd: f,
        duration: step * 2.2,
        peak,
        attack: 0.01,
      }, options);
    });
  }

  /**
   * A quiet outdoor bed: filtered noise for breeze, plus occasional bird
   * chirps. Started once and left running; the gain is faded rather than
   * stopping and restarting nodes.
   */
  startAmbient(): void {
    if (!this.running || this.ambientNodes.length > 0) return;
    const ctx = this.ctx!;
    const gain = this.ambientGain!;

    const src = this.noiseSource(0);
    if (src === null) return;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.5;

    // A slow LFO on the filter makes the breeze breathe instead of hissing.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    src.connect(filter);
    filter.connect(gain);
    src.start();
    lfo.start();

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 2.0);

    this.ambientNodes = [src, filter, lfo, lfoGain];
  }

  stopAmbient(): void {
    if (this.ctx === null || this.ambientGain === null) return;
    this.ambientGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.6);
    for (const n of this.ambientNodes) {
      if ('stop' in n && typeof (n as OscillatorNode).stop === 'function') {
        try {
          (n as OscillatorNode).stop(this.ctx.currentTime + 0.8);
        } catch {
          /* already stopped */
        }
      }
    }
    this.ambientNodes = [];
  }

  /**
   * A positioned loop that keeps running: a tap, a stream, a fire.
   *
   * Different from `startAmbient`, which is one bed for the whole world at a
   * fixed level. This is a sound that has somewhere to be, so the caller moves
   * it every frame — which means the gain has to be *ramped* rather than set.
   * Assigning `gain.value` sixty times a second produces a click on every
   * change, and sixty clicks a second is a buzz at the frame rate. That is the
   * single most common way procedural audio goes wrong and it sounds like a
   * broken speaker rather than like a bug.
   */
  /**
   * A sound that keeps going, in one of the two shapes this game needs.
   *
   * `water` is a tap or a pool: broadband with the low end taken out. `evening`
   * is the garden after the lamps come on — crickets and a hum of traffic three
   * streets away — and it exists because the dusk this project built was
   * completely silent. A sky that goes orange while the soundscape stays at
   * midday is half an evening, and it is the half you notice with your eyes
   * shut.
   */
  openLoop(kind: 'water' | 'evening' = 'water'): AmbientLoop | null {
    if (!this.running) return null;
    const ctx = this.ctx!;
    const src = this.noiseSource(0);
    if (src === null) return null;

    if (kind === 'evening') return this.eveningLoop(ctx, src);

    // Water is broadband with the low end taken out: a bandpass around 1.6kHz
    // reads as running rather than as wind, which is the same noise through a
    // lowpass.
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1600;
    filter.Q.value = 0.7;

    // A second, slower band under it, so it burbles instead of hissing. One
    // band alone is a hiss however it is tuned — running water is two things
    // at once, a rush and a chatter.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 700;
    body.Q.value = 1.4;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.7;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const panner = ctx.createStereoPanner();

    src.connect(filter);
    filter.connect(gain);
    src.connect(body);
    body.connect(gain);
    gain.connect(panner);
    panner.connect(this.ambientGain!);
    src.start();
    lfo.start();

    let stopped = false;
    return {
      set: (volume: number, pan: number): void => {
        if (stopped || this.ctx === null) return;
        const now = this.ctx.currentTime;
        // Ramped over a frame and a half, so a value that changes every frame
        // is a continuous curve rather than a staircase of discontinuities.
        gain.gain.setTargetAtTime(Math.max(0.0001, volume), now, 0.05);
        panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.05);
      },
      stop: (): void => {
        if (stopped) return;
        stopped = true;
        try {
          src.stop();
          lfo.stop();
        } catch {
          /* already stopped */
        }
      },
    };
  }

  /**
   * Crickets, and something driving a long way off.
   *
   * A cricket is a **trill inside a chirp**: a fast tremolo somewhere near
   * twenty a second, whose depth itself waxes and wanes about once every two
   * seconds. One LFO alone gives a buzz — an insect rather than a garden full
   * of them — so the slow one modulates the fast one's depth, which is the
   * cheapest thing that sounds like several of them not quite in time.
   *
   * Under it, noise through a very low lowpass: no engine, no tyres, nothing
   * you could point at. What distant traffic actually contributes to a back
   * garden is a floor under the silence, and the silence is what makes a
   * synthesised night sound like a broken speaker.
   */
  private eveningLoop(ctx: AudioContext, src: AudioBufferSourceNode): AmbientLoop {
    const chirps = ctx.createBiquadFilter();
    chirps.type = 'bandpass';
    chirps.frequency.value = 4800;
    chirps.Q.value = 11;

    // Swings between silent and full: the base gain and the tremolo depth are
    // the same number, so the trough is zero rather than merely quieter.
    const tremolo = ctx.createGain();
    tremolo.gain.value = 0.5;

    const fast = ctx.createOscillator();
    fast.type = 'sine';
    fast.frequency.value = 23;
    const fastDepth = ctx.createGain();
    fastDepth.gain.value = 0.5;
    fast.connect(fastDepth);
    fastDepth.connect(tremolo.gain);

    const slow = ctx.createOscillator();
    slow.type = 'sine';
    slow.frequency.value = 0.42;
    const slowDepth = ctx.createGain();
    slowDepth.gain.value = 0.36;
    slow.connect(slowDepth);
    slowDepth.connect(fastDepth.gain);

    const traffic = ctx.createBiquadFilter();
    traffic.type = 'lowpass';
    traffic.frequency.value = 110;
    traffic.Q.value = 0.5;
    const trafficGain = ctx.createGain();
    trafficGain.gain.value = 0.55;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const panner = ctx.createStereoPanner();

    src.connect(chirps);
    chirps.connect(tremolo);
    tremolo.connect(gain);
    src.connect(traffic);
    traffic.connect(trafficGain);
    trafficGain.connect(gain);
    gain.connect(panner);
    panner.connect(this.ambientGain!);
    src.start();
    fast.start();
    slow.start();

    let stopped = false;
    return {
      set: (volume: number, pan: number): void => {
        if (stopped || this.ctx === null) return;
        const now = this.ctx.currentTime;
        // Slower than the water loop's ramp. Evening comes on over minutes and
        // a soundscape that tracked it at a twentieth of a second would swell
        // audibly every time the day clock ticked a hundredth.
        gain.gain.setTargetAtTime(Math.max(0.0001, volume), now, 0.4);
        panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.4);
      },
      stop: (): void => {
        if (stopped) return;
        stopped = true;
        try {
          src.stop();
          fast.stop();
          slow.stop();
        } catch {
          /* already stopped */
        }
      },
    };
  }

  /**
   * Stereo pan and distance attenuation for a world-space sound.
   *
   * `listenerRight` is the camera's right vector; the dot product against it
   * gives left/right directly without needing a full 3D listener.
   */
  static spatial(
    sx: number, sy: number, sz: number,
    lx: number, ly: number, lz: number,
    rightX: number, rightZ: number,
    maxDistance = 30,
  ): PlayOptions {
    const dx = sx - lx;
    const dy = sy - ly;
    const dz = sz - lz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return { pan: 0, distance: 1 };

    const pan = Math.max(-1, Math.min(1, ((dx * rightX + dz * rightZ) / dist) * 0.8));
    // Inverse falloff rather than linear: linear stays too loud far away and
    // then cuts abruptly at the limit.
    const distance = Math.max(0, 1 - dist / maxDistance) ** 1.6;
    return { pan, distance };
  }

  get voiceCount(): number {
    return this.voices.length;
  }
}
