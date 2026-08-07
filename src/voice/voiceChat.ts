/**
 * The part of proximity voice that can only exist in a browser.
 *
 * Everything this file *decides* lives in `voiceRules.ts`, tested. What is left
 * here is the platform: a microphone, a peer connection per person, and a Web
 * Audio graph per incoming stream. Deliberately as thin as it can be, because
 * none of it can be unit tested and all of it fails silently — the whole point
 * of the split is that when somebody says "you sounded muffled" the question is
 * about ten lines rather than four hundred.
 *
 * ## Why a mesh and not a mixer
 *
 * Every player connects to every other player, so eight people is twenty-eight
 * connections and each browser encodes its microphone seven times. A selective
 * forwarding unit would encode once — and would be a server, which this project
 * does not have and has already decided twice not to need. At a party-game
 * roster the mesh costs a few hundred kbit and no deploy target, which is the
 * same trade host-authoritative netcode already made.
 *
 * ## What travels where
 *
 * Voice is peer to peer and never touches the relay. Only the handshake goes
 * through the host, which is the one party both ends can already reach. Once
 * the call is up the host is not in the path and cannot hear it — worth saying
 * plainly, because "the host relays the signalling" reads at a glance like the
 * host relays the audio.
 */

import type { AudioBus } from '../audio/audioBus.ts';
import type { RtcSignal } from '../net/protocol.ts';
import {
  OPEN_CUTOFF, SpeakingGate, VoiceMesh, shouldOffer, voiceMix, type Placed,
} from './voiceRules.ts';

/**
 * Where to ask for a route to the outside world.
 *
 * A public STUN server, which is enough for two players behind ordinary home
 * routers to find each other. It is **not** enough for every network: symmetric
 * NAT and a lot of corporate firewalls need a TURN relay, and TURN is a server
 * somebody has to run and pay for. That is a deploy decision this project has
 * not made — the same one it has already declined twice, in `protocol.ts` and
 * in the relay — so the honest statement is that voice works on most home
 * connections and on a LAN, and that the gap is named rather than hidden.
 *
 * Overridable, and the tests and scenarios pass an empty list: on one machine
 * every candidate is a host candidate, and asking a server on the internet
 * about it only adds seconds of gathering to a check that cannot use the answer.
 */
export const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** How often the speaking meters are read, in seconds. */
const METER_INTERVAL = 1 / 20;

/** Samples per analysis window. 1024 at 48kHz is about 21ms — one syllable's worth. */
const FFT_SIZE = 1024;

interface Call {
  readonly peer: RTCPeerConnection;
  /**
   * The chain one voice runs through: source → lowpass → gain → pan → voice bus.
   *
   * Held rather than looked up, because it is touched every frame for every
   * speaker and walking the graph to find a node sixty times a second is the
   * kind of cost that never shows up in a profile as itself.
   */
  filter: BiquadFilterNode | null;
  gain: GainNode | null;
  panner: StereoPannerNode | null;
  analyser: AnalyserNode | null;
  /**
   * A muted `<audio>` element the remote stream is also attached to.
   *
   * Not for playback — the Web Audio graph does that. It is here because
   * Chromium has historically not pumped a remote `MediaStream` into
   * `createMediaStreamSource` unless the stream is *also* attached to a media
   * element, and the symptom is a connection that reports itself perfectly
   * healthy while producing pure silence. Cheap, harmless where it is not
   * needed, and the alternative is a bug that looks like a network fault.
   */
  sink: HTMLAudioElement | null;
  /**
   * The incoming stream, kept until there is an audio context to attach it to.
   *
   * Not defensive tidiness — the common case. `voiceEnabled` is persisted, so
   * from a player's second session onward `start()` runs during the first
   * settings pass, before anybody has clicked and therefore before the
   * `AudioContext` exists. A track arriving in that window found `bus.context`
   * null, and the first version simply returned: the call connected, packets
   * arrived, and that person was silent for the rest of the round.
   */
  pending: MediaStream | null;
  readonly gate: SpeakingGate;
  speaking: boolean;
  /** Buffer reused by the meter, so reading a level allocates nothing. */
  samples: Float32Array | null;
}

export interface VoiceListener extends Placed {
  /** The camera's right vector in the ground plane. */
  readonly rightX: number;
  readonly rightZ: number;
}

export class VoiceChat {
  private readonly mesh = new VoiceMesh();
  private readonly calls = new Map<number, Call>();
  private stream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micSamples: Float32Array | null = null;
  private readonly micGate = new SpeakingGate();
  /** Audio-clock time of the last meter read. See the note inside `update`. */
  private lastMeterAt = 0;
  private starting: Promise<boolean> | null = null;

  /** Set when getUserMedia refused, so the UI can say why nothing is happening. */
  private failure: string | null = null;

  constructor(
    private readonly bus: AudioBus,
    /** Hand one step of a handshake to the session. */
    private readonly send: (to: number, signal: RtcSignal) => void,
    private readonly iceServers: RTCIceServer[] = DEFAULT_ICE,
  ) {}

  get error(): string | null {
    return this.failure;
  }

  get live(): boolean {
    return this.stream !== null;
  }

  /** How many calls are up, for the debug overlay and the scenario. */
  get callCount(): number {
    return this.calls.size;
  }

  /** True while this machine's own microphone is producing speech. */
  get micSpeaking(): boolean {
    return this.micGate.speaking;
  }

  speaking(id: number): boolean {
    return this.calls.get(id)?.speaking ?? false;
  }

  /** Everybody currently audible on this screen, for the HUD. */
  speakers(): number[] {
    const out: number[] = [];
    for (const [id, call] of this.calls) if (call.speaking) out.push(id);
    return out;
  }

  /**
   * Ask for the microphone.
   *
   * Idempotent and re-entrant: the promise is held so that a player who toggles
   * the setting twice while the permission prompt is up does not end up with
   * two streams, one of which nothing will ever close.
   */
  async start(): Promise<boolean> {
    if (this.stream !== null) return true;
    if (this.starting !== null) return this.starting;
    this.starting = this.openMic();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  private async openMic(): Promise<boolean> {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (media?.getUserMedia === undefined) {
      this.failure = 'this browser has no microphone support';
      return false;
    }
    try {
      // Echo cancellation and noise suppression on, which is not a default
      // worth second-guessing: without them a player on speakers sends everyone
      // else's voices back to them, and the resulting loop is unusable long
      // before anybody works out whose fault it is.
      this.stream = await media.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      this.failure = err instanceof Error && err.name === 'NotAllowedError'
        ? 'microphone permission was refused'
        : 'no microphone was available';
      return false;
    }
    this.failure = null;
    this.attachMicMeter();
    // Anybody dialled before the microphone existed has a connection with no
    // audio on it. Renegotiating each of them is the alternative and it is
    // worse: this only happens at the moment voice is switched on, and hanging
    // up is one line against a code path that would otherwise exist for this
    // case alone.
    for (const id of [...this.calls.keys()]) {
      this.hangUp(id);
      this.mesh.forget(id);
    }
    return true;
  }

  /**
   * Watch this machine's own level, so the player can see they are transmitting.
   *
   * Taken from the raw microphone rather than from what is being sent, because
   * the useful question while holding push-to-talk is "is this thing picking me
   * up" — and a meter fed from a muted track answers "no" to that whatever you
   * do in front of it.
   */
  private attachMicMeter(): void {
    const ctx = this.bus.context;
    if (ctx === null || this.stream === null) return;
    this.micSource = ctx.createMediaStreamSource(this.stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = FFT_SIZE;
    this.micSamples = new Float32Array(this.micAnalyser.fftSize);
    this.micSource.connect(this.micAnalyser);
    // Deliberately not connected onward. An analyser is a pass-through node and
    // wiring it to the destination would play the player's own microphone back
    // into their ears at zero latency, which is the single most disorienting
    // thing a voice feature can do.
  }

  stop(): void {
    for (const id of [...this.calls.keys()]) this.hangUp(id);
    this.mesh.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.micSource?.disconnect();
    this.micSource = null;
    this.micAnalyser = null;
    this.micGate.reset();
  }

  /** Send audio, or send silence. Instant, and needs no renegotiation. */
  setTransmitting(on: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = on;
    if (!on) this.micGate.reset();
  }

  /**
   * Keep the mesh in step with who is in the world.
   *
   * Called every frame with the roster; `VoiceMesh` decides what changed.
   */
  sync(present: Iterable<number>): void {
    if (this.stream === null) return;
    const { dial, hangUp } = this.mesh.sync(present);
    for (const id of hangUp) this.hangUp(id);
    for (const id of dial) void this.dial(id);
  }

  private makeConnection(id: number): RTCPeerConnection {
    const peer = new RTCPeerConnection({ iceServers: this.iceServers });

    for (const track of this.stream?.getAudioTracks() ?? []) {
      peer.addTrack(track, this.stream!);
    }

    peer.onicecandidate = (e): void => {
      // `null` is the end-of-candidates marker and is forwarded rather than
      // filtered: it is how a browser says "that is everywhere I can be
      // reached", and without it the far end waits out its own timeout.
      this.send(id, {
        k: 'ice',
        c: e.candidate === null ? null : JSON.stringify(e.candidate.toJSON()),
        mid: e.candidate?.sdpMid ?? null,
      });
    };

    peer.ontrack = (e): void => {
      const stream = e.streams[0];
      if (stream !== undefined) this.attachRemote(id, stream);
    };

    peer.onconnectionstatechange = (): void => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        // Forgotten rather than merely hung up, so the next `sync` dials again.
        // Hanging up alone would mean one failed handshake silences that pair
        // for the rest of the round.
        this.hangUp(id);
        this.mesh.forget(id);
      }
    };

    this.calls.set(id, {
      peer,
      filter: null, gain: null, panner: null, analyser: null, sink: null,
      pending: null, gate: new SpeakingGate(), speaking: false, samples: null,
    });
    return peer;
  }

  private async dial(id: number): Promise<void> {
    if (!shouldOffer(this.selfId, id)) {
      // The other end is calling us. Build the connection anyway so an offer
      // arriving has somewhere to land, but do not offer.
      if (!this.calls.has(id)) this.makeConnection(id);
      return;
    }
    const peer = this.calls.get(id)?.peer ?? this.makeConnection(id);
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.send(id, { k: 'offer', sdp: offer.sdp ?? '' });
    } catch {
      this.hangUp(id);
      this.mesh.forget(id);
    }
  }

  /**
   * This machine's own actor id, needed to decide which end offers.
   *
   * Set by the shell rather than read from the session, because it changes: a
   * guest is id -1 until the host welcomes it. Dialling with the wrong id makes
   * both ends offer, and the call never connects.
   */
  selfId = -1;

  /** One step of a handshake arrived. */
  async receive(from: number, signal: RtcSignal): Promise<void> {
    if (this.stream === null) return;
    const peer = this.calls.get(from)?.peer ?? this.makeConnection(from);
    try {
      if (signal.k === 'offer') {
        await peer.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.send(from, { k: 'answer', sdp: answer.sdp ?? '' });
        return;
      }
      if (signal.k === 'answer') {
        await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        return;
      }
      if (signal.k !== 'ice') return;
      if (signal.c === null) {
        await peer.addIceCandidate();
        return;
      }
      await peer.addIceCandidate(JSON.parse(signal.c) as RTCIceCandidateInit);
    } catch {
      // A candidate for a description that has not arrived yet throws, and it
      // is routine rather than fatal: the far end's offer and its candidates
      // race through the host and either can win. Swallowed on purpose — ICE
      // retries by design and a thrown error here would be noise in the console
      // on every successful call.
    }
  }

  private attachRemote(id: number, stream: MediaStream): void {
    const call = this.calls.get(id);
    if (call === undefined) return;
    if (call.gain !== null) return;
    const ctx = this.bus.context;
    const destination = this.bus.voiceDestination;
    if (ctx === null || destination === null) {
      // No context yet. Hold the stream and build the graph on the first frame
      // after somebody clicks; see the note on `Call.pending`.
      call.pending = stream;
      return;
    }
    call.pending = null;

    // See the comment on `Call.sink`. Muted, so nothing is played twice.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    void sink.play().catch(() => { /* autoplay policy; the graph still works */ });
    call.sink = sink;

    const source = ctx.createMediaStreamSource(stream);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = OPEN_CUTOFF;
    const gain = ctx.createGain();
    // Starting at zero and ramping up, so a call connecting mid-sentence fades
    // in over a frame rather than arriving as a click.
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(destination);
    // Tapped before the distance gain, so the indicator says "this person is
    // talking" rather than "this person is talking and standing near you" —
    // which the position on screen already tells you.
    filter.connect(analyser);

    call.filter = filter;
    call.gain = gain;
    call.panner = panner;
    call.analyser = analyser;
    call.samples = new Float32Array(analyser.fftSize);
  }

  /**
   * Move every voice to where its owner is standing.
   *
   * `positionOf` returns null for somebody who has left the roster but whose
   * connection has not been torn down yet — a gap of a frame or two that would
   * otherwise leave a voice stuck at its last position.
   */
  update(
    dt: number,
    listener: VoiceListener,
    positionOf: (id: number) => Placed | null,
    isMuted: (id: number) => boolean,
    occluded: (id: number) => boolean,
  ): void {
    const ctx = this.bus.context;
    if (ctx === null) return;
    const now = ctx.currentTime;

    // Anything that arrived before the audio context existed. Cheap: the loop
    // only does work on the one frame after a click, and skipping it entirely
    // is a permanently silent player.
    for (const [id, call] of this.calls) {
      if (call.pending !== null) this.attachRemote(id, call.pending);
    }
    if (this.stream !== null && this.micAnalyser === null) this.attachMicMeter();

    for (const [id, call] of this.calls) {
      if (call.gain === null || call.panner === null || call.filter === null) continue;
      const where = positionOf(id);
      const mix = where === null || isMuted(id)
        ? { gain: 0, pan: 0, cutoff: OPEN_CUTOFF }
        : voiceMix(where, listener, listener.rightX, listener.rightZ, occluded(id));

      // Ramped, never assigned. Writing `gain.value` every frame clicks on
      // every change, and sixty clicks a second is a buzz at the frame rate —
      // the same mistake the running-water loop exists to document.
      call.gain.gain.setTargetAtTime(mix.gain, now, 0.04);
      call.panner.pan.setTargetAtTime(mix.pan, now, 0.04);
      call.filter.frequency.setTargetAtTime(mix.cutoff, now, 0.06);
    }

    // ── The meters run on the audio clock, not the simulation's ──────────────
    //
    // `dt` is a fixed timestep. An `AnalyserNode` is filled by the audio thread
    // in real time. Those are the same thing only while the machine is keeping
    // up, and this is called from inside the fixed loop — which takes *twelve*
    // steps in one frame on a machine rendering five a second.
    //
    // Metering on `dt` there samples the same 21ms of audio twelve times and
    // then nothing for a fifth of a second, and burns twelve frames' worth of
    // the speaking hold while the wall clock advanced once. The visible result
    // is a speaking indicator that works on a fast machine and is dead on a
    // slow one, which is exactly backwards from who needs it.
    //
    // Measured, not deduced: `voice.levels()` against Chromium's fake device —
    // 40–80ms pulses every half second — never lit the gate at all under
    // software GL until this used `currentTime`.
    void dt;
    if (this.lastMeterAt === 0) this.lastMeterAt = now;
    const elapsed = now - this.lastMeterAt;
    if (elapsed < METER_INTERVAL) return;
    this.lastMeterAt = now;
    for (const call of this.calls.values()) {
      call.speaking = call.analyser === null || call.samples === null
        ? false
        : call.gate.update(rms(call.analyser, call.samples), elapsed);
    }
    if (this.micAnalyser !== null && this.micSamples !== null) {
      this.micGate.update(rms(this.micAnalyser, this.micSamples), elapsed);
    }
  }

  /**
   * The raw level of each incoming voice, and of this machine's microphone.
   *
   * Kept because "I cannot hear anybody" has two completely different causes
   * that look identical — no audio arriving, or audio arriving below the
   * speaking threshold — and no other readout separates them.
   */
  levels(): { mic: number; peers: Array<{ id: number; level: number }> } {
    const peers: Array<{ id: number; level: number }> = [];
    for (const [id, call] of this.calls) {
      peers.push({
        id,
        level: call.analyser === null || call.samples === null
          ? 0
          : rms(call.analyser, call.samples),
      });
    }
    return {
      mic: this.micAnalyser === null || this.micSamples === null
        ? 0
        : rms(this.micAnalyser, this.micSamples),
      peers,
    };
  }

  /**
   * What is actually being applied to one voice, read off the graph.
   *
   * For the scenario, and read from the `AudioParam` rather than from a copy
   * kept alongside it. A remembered value agrees with itself whatever the graph
   * is doing, which makes it exactly useless as a check that the graph is doing
   * anything — and the failure this guards against is a mix computed correctly
   * and connected to nothing.
   */
  mixFor(id: number): { gain: number; pan: number; cutoff: number } | null {
    const call = this.calls.get(id);
    if (call === undefined || call.gain === null) return null;
    return {
      gain: call.gain.gain.value,
      pan: call.panner?.pan.value ?? 0,
      cutoff: call.filter?.frequency.value ?? OPEN_CUTOFF,
    };
  }

  /**
   * Whether audio is genuinely arriving, per peer.
   *
   * The only claim worth making about a call. `connectionState === 'connected'`
   * is true of a connection carrying silence, and every convenient summary
   * short of counting packets can be green while nobody can hear anybody.
   */
  async stats(): Promise<Array<{ id: number; state: string; packets: number }>> {
    const out: Array<{ id: number; state: string; packets: number }> = [];
    for (const [id, call] of this.calls) {
      let packets = 0;
      try {
        const report = await call.peer.getStats();
        report.forEach((entry) => {
          const s = entry as { type?: string; kind?: string; packetsReceived?: number };
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            packets += s.packetsReceived ?? 0;
          }
        });
      } catch {
        /* the connection went away mid-query, which is not a failure to report */
      }
      out.push({ id, state: call.peer.connectionState, packets });
    }
    return out;
  }

  private hangUp(id: number): void {
    const call = this.calls.get(id);
    if (call === undefined) return;
    call.peer.onicecandidate = null;
    call.peer.ontrack = null;
    call.peer.onconnectionstatechange = null;
    call.peer.close();
    call.gain?.disconnect();
    call.panner?.disconnect();
    call.filter?.disconnect();
    call.analyser?.disconnect();
    call.pending = null;
    if (call.sink !== null) {
      call.sink.pause();
      call.sink.srcObject = null;
    }
    this.calls.delete(id);
  }
}

/**
 * How loud a window of samples is.
 *
 * Root mean square rather than peak, because peak is whatever the loudest
 * single sample in a twentieth of a second happened to be — a chair creak
 * registers as speech and a held vowel does not.
 */
function rms(analyser: AnalyserNode, into: Float32Array): number {
  analyser.getFloatTimeDomainData(into as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < into.length; i++) sum += into[i]! * into[i]!;
  return Math.sqrt(sum / into.length);
}
