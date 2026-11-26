/**
 * STRAND // PROTOCOL — Audio (§7): 100 % procedural Web Audio DSP, no audio files.
 *
 * Master routing (§7.1 + 5A-2):
 *   [SE voices, rain, wind, winch] ─┬─> [Dynamic Lowpass (bullet-time)] ──┐
 *                                   └─> [Convolver reverb (1.8 s city IR)] ┤
 *   [BGM 5 layers] ──> [BGM Lowpass (bullet-time)] ───────────────────────┤
 *   [clear combat path: head-shot resonance, lock warnings, hits, heartbeat] ┤
 *                                                                          └─> [worldOut] ─> [Master Compressor] ─> [Destination]
 *   [UI bus: menu ticks, skill modal, zoom servo] ─────────────────────────────────────────> [Master Compressor]
 *
 *  - worldOut ramps to 0 in 60 ms while PAUSED / RESULT / TITLE (rain included — 100 % silent) and back in
 *    80 ms; the BGM / heartbeat / repair schedulers stop and re-sync to the current time on resume (no burst).
 *    A hidden tab suspends the AudioContext outright. The UI bus stays live so the volume slider can be heard.
 *  - BGM and combat SE voices are capped separately (24 / 28); player shots, lock warnings, hits and grazes
 *    are priority voices that are never culled.
 *
 *  - Bullet time sweeps both lowpass filters 22 kHz → 680 Hz (Q 2.4) exponentially in 120 ms, back in 180 ms.
 *  - Rain ambience: looping pink noise → bandpass 1200 Hz (Q 0.6) → high-shelf 6 kHz +4 dB at gain 0.09.
 *  - Every SE of §7.2 is layered from oscillators / filtered noise / WaveShaper drive / FM, never a single beep.
 *  - Enemy lock warnings are spatialised with an HRTF PannerNode at the enemy muzzle and climb 980 → 1960 Hz
 *    (snipers 1400 → 2800 Hz) linearly across the lock time with a 25 Hz tremolo.
 *  - Adaptive 5-layer BGM (BPM 136, D minor) synthesised by a look-ahead scheduler (25 ms timer, 100 ms
 *    horizon, 16th = 110.29 ms). Layers follow the FLOW rank; out of combat layers 2–5 fade out in 800 ms.
 * Shared noise buffers, drive curves and the reverb IR are generated once at start-up. One-shot Web Audio source
 * nodes are single-use by design, so each sound creates its small node graph; voices are capped.
 */
import * as THREE from 'three';
import { AUDIO, clamp } from '../config/constants';
import type { EnemyKind } from '../config/skills';
import type { GunId, ReloadCue, SlotId } from '../config/weapons';

type Curve = Float32Array<ArrayBuffer>;

/** Lead melody (8 bars × 16 steps): [start step, length in 16ths, MIDI note]. D minor over D / F / G / A#. */
const LEAD_PHRASE: readonly (readonly [number, number, number])[] = [
  [0, 4, 69], [4, 2, 74], [6, 2, 76], [8, 6, 77], [14, 2, 76],
  [16, 4, 72], [20, 2, 77], [22, 2, 79], [24, 6, 81], [30, 2, 79],
  [32, 3, 79], [35, 3, 77], [38, 2, 74], [40, 4, 79], [44, 4, 81],
  [48, 4, 77], [52, 4, 74], [56, 4, 70], [60, 4, 72],
  [64, 2, 74], [66, 2, 74], [68, 4, 81], [72, 2, 79], [74, 2, 77], [76, 4, 76],
  [80, 2, 77], [82, 2, 77], [84, 4, 84], [88, 4, 81], [92, 4, 79],
  [96, 4, 79], [100, 4, 82], [104, 4, 81], [108, 4, 79],
  [112, 6, 77], [118, 2, 76], [120, 8, 74],
];
/** Arp step pattern (indices into the pentatonic table) — offset by the bar's chord. */
const ARP_PATTERN: readonly number[] = [0, 2, 4, 5, 2, 4, 5, 7, 4, 5, 7, 9, 5, 4, 2, 1];
const ARP_CHORD_OFFSET: readonly number[] = [0, 1, 2, 1];
/** Layer output levels (Deep Pulse, Cyber Drums, Neon Arp, Breakbeat Perc, Overdrive Lead). */
const LAYER_LEVEL: readonly number[] = [0.5, 0.78, 0.2, 0.3, 0.24];
const BASS_PUMP: readonly number[] = [0.42, 0.72, 0.9, 1.0];

function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Classic soft-clip drive curve; larger k = harder. */
function driveCurve(k: number, n = 2048): Curve {
  const c = new Float32Array(n);
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    c[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return c;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private compressor!: DynamicsCompressorNode;
  private masterOut!: GainNode;
  private seBus!: GainNode;
  private seFilter!: BiquadFilterNode;
  private reverbSend!: GainNode;
  private bgmBus!: GainNode;
  private bgmFilter!: BiquadFilterNode;
  private bgmShelf!: BiquadFilterNode;
  private musicDuck!: GainNode;
  private uiBus!: GainNode;
  /** 5A-2: everything except the menu UI bus; muted while paused. */
  private worldOut!: GainNode;
  /** Clear (bullet-time bypassing) combat feedback path inside the world bus. */
  private clearBus!: GainNode;
  private white!: AudioBuffer;
  private pink!: AudioBuffer;
  private softCurve!: Curve;
  private driveK40!: Curve;
  private driveK45!: Curve;
  private hardCurve!: Curve;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private winchOsc: OscillatorNode | null = null;
  private winchGain: GainNode | null = null;
  private readonly layerGains: GainNode[] = [];
  private readonly layerOn = [false, false, false, false, false];
  private readonly layerUntil = [0, 0, 0, 0, 0];
  private bassFilter!: BiquadFilterNode;
  private arpIn!: GainNode;
  private leadIn!: GainNode;
  private leadShaper!: WaveShaperNode;
  private leadFilter!: BiquadFilterNode;

  /** Live voice counts per pool (5A-6). */
  private seVoices = 0;
  private bgmVoices = 0;
  private lockVoices = 0;
  /** True while the BGM scheduler is creating voices (they count against the BGM pool). */
  private bgmMode = false;
  private paused = true;
  private hidden = false;
  private volume: number = AUDIO.MASTER_GAIN;
  private timer = 0;
  private bgmStep = 0;
  private nextStepTime = 0;
  private gridOrigin = 0;
  private flowRank = 0;
  private layerCount = 1;
  private calm = true;
  /** 8A-5: every enemy UNAWARE / ALERT — BGM ducked to a filtered Layer 1 tension pulse. */
  private stealthy = false;
  private layer0Level = -1;
  private duckDepth = 0.28;
  private critical = false;
  private regenerating = false;
  private nextHeartTime = 0;
  private nextRepairTime = 0;
  private hsIndex = -1;
  private lastHsTime = -1e9;
  private grazeSemis = -1;
  private lastGrazeTime = -1e9;
  private btOn = false;

  /** True once the AudioContext exists (created inside a user gesture). */
  get ready(): boolean {
    return this.ctx !== null;
  }

  // =============================================================================================
  // Lifecycle
  // =============================================================================================
  /** Creates (or resumes) the audio graph. Must be called from a user gesture (deploy click / key). */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let c: AudioContext;
    try {
      c = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = c;
    this.buildGraph(c);
    this.startRain(c);
    this.startWind(c);
    this.startWinch(c);
    this.startBgm(c);
    if (c.state === 'suspended' && !this.hidden) c.resume().catch(() => undefined);
  }

  /**
   * 5A-2: PAUSED / RESULT / TITLE → world bus (rain, wind, BGM, combat SE, reverb) ramps to 0 in 60 ms and the
   * BGM / heartbeat / repair schedulers stop; PLAYING / SKILL / TRANSITION → back to 1 in 80 ms, schedulers
   * re-synced to the current time (no catch-up burst). The UI bus is unaffected.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const g = this.worldOut.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(paused ? 0 : 1, t + (paused ? AUDIO.WORLD_PAUSE_MS : AUDIO.WORLD_RESUME_MS) / 1000);
    if (!paused) this.resyncSchedulers(t);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 5A-2: a hidden tab suspends the whole context; on return it resumes (the world bus stays muted if paused). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    const c = this.ctx;
    if (!c) return;
    if (hidden) c.suspend().catch(() => undefined);
    else c.resume().catch(() => undefined);
  }

  private resyncSchedulers(now: number): void {
    if (this.nextStepTime < now + 0.03) {
      this.nextStepTime = now + 0.03;
      this.gridOrigin = this.nextStepTime - this.bgmStep * AUDIO.SIXTEENTH_S;
    }
    this.nextHeartTime = 0;
    this.nextRepairTime = 0;
  }

  /** Master volume 0..1 (settings). */
  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.ctx) this.masterOut.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
  }

  private buildGraph(c: AudioContext): void {
    this.compressor = c.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4.5;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;
    this.masterOut = c.createGain();
    this.masterOut.gain.value = this.volume;
    this.compressor.connect(this.masterOut).connect(c.destination);
    this.worldOut = c.createGain();
    this.worldOut.gain.value = this.paused ? 0 : 1;
    this.worldOut.connect(this.compressor);
    this.clearBus = c.createGain();
    this.clearBus.connect(this.worldOut);

    // SE voices → BT lowpass → compressor, and → convolver reverb → compressor.
    this.seBus = c.createGain();
    this.seFilter = c.createBiquadFilter();
    this.seFilter.type = 'lowpass';
    this.seFilter.frequency.value = AUDIO.BT_LOWPASS_OPEN_HZ;
    this.seFilter.Q.value = 0.707;
    this.seBus.connect(this.seFilter).connect(this.worldOut);
    const convolver = c.createConvolver();
    convolver.buffer = this.buildImpulse(c);
    this.reverbSend = c.createGain();
    this.reverbSend.gain.value = AUDIO.REVERB_SEND;
    this.seBus.connect(this.reverbSend).connect(convolver).connect(this.worldOut);

    // BGM layers → duck (sidechain feel) / drums → shelf (overdrive mix) → BT lowpass → compressor.
    this.bgmBus = c.createGain();
    this.bgmBus.gain.value = AUDIO.BGM_GAIN;
    this.bgmShelf = c.createBiquadFilter();
    this.bgmShelf.type = 'highshelf';
    this.bgmShelf.frequency.value = 3500;
    this.bgmShelf.gain.value = 0;
    this.bgmFilter = c.createBiquadFilter();
    this.bgmFilter.type = 'lowpass';
    this.bgmFilter.frequency.value = AUDIO.BT_LOWPASS_OPEN_HZ;
    this.bgmFilter.Q.value = 0.707;
    this.bgmBus.connect(this.bgmShelf).connect(this.bgmFilter).connect(this.worldOut);
    this.musicDuck = c.createGain();
    this.musicDuck.connect(this.bgmBus);

    this.uiBus = c.createGain();
    this.uiBus.connect(this.compressor);

    // Shared sources.
    this.white = c.createBuffer(1, Math.floor(c.sampleRate * 2), c.sampleRate);
    const w = this.white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
    this.pink = c.createBuffer(1, Math.floor(c.sampleRate * 4), c.sampleRate);
    const p = this.pink.getChannelData(0);
    // Paul Kellet's pink-noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < p.length; i++) {
      const x = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + x * 0.0555179;
      b1 = 0.99332 * b1 + x * 0.0750759;
      b2 = 0.969 * b2 + x * 0.153852;
      b3 = 0.8665 * b3 + x * 0.3104856;
      b4 = 0.55 * b4 + x * 0.5329522;
      b5 = -0.7616 * b5 - x * 0.016898;
      p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
      b6 = x * 0.115926;
    }
    this.softCurve = driveCurve(6);
    this.driveK40 = driveCurve(AUDIO.DRIVE_K);
    this.driveK45 = driveCurve(AUDIO.SNIPER_CRACK.shaperK);
    this.hardCurve = driveCurve(180);

    // BGM layer buses.
    for (let i = 0; i < 5; i++) {
      const g = c.createGain();
      g.gain.value = 0;
      // Drums are the sidechain source; the others pump against the kick.
      g.connect(i === 1 || i === 3 ? this.bgmBus : this.musicDuck);
      this.layerGains.push(g);
    }
    this.bassFilter = c.createBiquadFilter();
    this.bassFilter.type = 'lowpass';
    this.bassFilter.frequency.value = AUDIO.BASS_LOWPASS_HZ;
    this.bassFilter.Q.value = 3;
    this.bassFilter.connect(this.layerGains[0]);
    // Arp: square → gentle lowpass → dry + 3/16 feedback delay (0.35).
    this.arpIn = c.createGain();
    const arpLp = c.createBiquadFilter();
    arpLp.type = 'lowpass';
    arpLp.frequency.value = 3600;
    this.arpIn.connect(arpLp).connect(this.layerGains[2]);
    const delay = c.createDelay(1.0);
    delay.delayTime.value = AUDIO.SIXTEENTH_S * AUDIO.ARP_DELAY_SIXTEENTHS;
    const fb = c.createGain();
    fb.gain.value = AUDIO.ARP_DELAY_FEEDBACK;
    const wet = c.createGain();
    wet.gain.value = 0.55;
    arpLp.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(this.layerGains[2]);
    // Lead: saw + octaver → WaveShaper drive → lowpass (opened fully at SSS).
    this.leadIn = c.createGain();
    this.leadShaper = c.createWaveShaper();
    this.leadShaper.curve = this.driveK40;
    this.leadShaper.oversample = '2x';
    this.leadFilter = c.createBiquadFilter();
    this.leadFilter.type = 'lowpass';
    this.leadFilter.frequency.value = 3200;
    this.leadFilter.Q.value = 1.2;
    this.leadIn.connect(this.leadShaper).connect(this.leadFilter).connect(this.layerGains[4]);
  }

  /** Stereo exponentially decaying white noise (1.8 s, decay 3.2) with a 4.5 kHz one-pole roll-off. */
  private buildImpulse(c: AudioContext): AudioBuffer {
    const len = Math.floor(c.sampleRate * AUDIO.REVERB_LENGTH_S);
    const ir = c.createBuffer(2, len, c.sampleRate);
    const a = Math.exp((-2 * Math.PI * AUDIO.REVERB_ROLLOFF_HZ) / c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const x = (Math.random() * 2 - 1) * Math.pow(1 - i / len, AUDIO.REVERB_DECAY);
        lp = (1 - a) * x + a * lp;
        d[i] = lp;
      }
    }
    return ir;
  }

  private startRain(c: AudioContext): void {
    const src = c.createBufferSource();
    src.buffer = this.pink;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = AUDIO.RAIN_BANDPASS_HZ;
    bp.Q.value = AUDIO.RAIN_BANDPASS_Q;
    const shelf = c.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = AUDIO.RAIN_SHELF_HZ;
    shelf.gain.value = AUDIO.RAIN_SHELF_DB;
    const g = c.createGain();
    g.gain.value = AUDIO.RAIN_GAIN;
    // Ambience sits in the SE group (muffled by bullet time) without feeding the reverb.
    src.connect(bp).connect(shelf).connect(g).connect(this.seFilter);
    src.start();
  }

  private startWind(c: AudioContext): void {
    const src = c.createBufferSource();
    src.buffer = this.white;
    src.loop = true;
    this.windFilter = c.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = AUDIO.SWING_WIND.f0;
    this.windFilter.Q.value = 1.1;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.seFilter);
    src.start();
  }

  /** 5A-6 winch motor: persistent saw → bandpass 900 Hz, faded in only while reeling (GRAPPLE_PULL). */
  private startWinch(c: AudioContext): void {
    const W = AUDIO.WINCH;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = W.f0;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = W.bandpassHz;
    bp.Q.value = 1.6;
    const g = c.createGain();
    g.gain.value = 0;
    o.connect(bp).connect(g).connect(this.seFilter);
    o.start();
    this.winchOsc = o;
    this.winchGain = g;
  }

  // =============================================================================================
  // Voice helpers (5A-6: separate SE / BGM pools)
  // =============================================================================================
  private readonly onSeEnded = (): void => {
    this.seVoices = Math.max(0, this.seVoices - 1);
  };

  private readonly onBgmEnded = (): void => {
    this.bgmVoices = Math.max(0, this.bgmVoices - 1);
  };

  private readonly onLockEnded = (): void => {
    this.lockVoices = Math.max(0, this.lockVoices - 1);
    this.seVoices = Math.max(0, this.seVoices - 1);
  };

  /** Running context, or null; `priority` voices (shots, locks, hits, grazes) bypass the SE cap. */
  private can(priority = false): AudioContext | null {
    const c = this.ctx;
    if (!c || c.state !== 'running') return null;
    if (!priority && this.seVoices >= AUDIO.MAX_SE_VOICES) return null;
    return c;
  }

  /** BGM voices are dropped (never SE) once their own pool is full. */
  private bgmFull(): boolean {
    return this.bgmMode && this.bgmVoices >= AUDIO.MAX_BGM_VOICES;
  }

  private track(n: AudioScheduledSourceNode, lock = false): void {
    if (this.bgmMode) {
      this.bgmVoices++;
      n.onended = this.onBgmEnded;
      return;
    }
    this.seVoices++;
    n.onended = lock ? this.onLockEnded : this.onSeEnded;
  }

  /** Live voice counts (debug / tests). */
  get voiceCounts(): { se: number; bgm: number; lock: number } {
    return { se: this.seVoices, bgm: this.bgmVoices, lock: this.lockVoices };
  }

  /** Oscillator with an exponential pitch sweep and a fast-attack exponential decay. */
  private tone(
    c: AudioContext,
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    peak: number,
    dest: AudioNode,
    t: number,
    attack = 0.002,
    shaper: Curve | null = null,
  ): void {
    if (this.bgmFull()) return;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (shaper) {
      const ws = c.createWaveShaper();
      ws.curve = shaper;
      o.connect(ws).connect(g);
    } else o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.03);
    this.track(o);
  }

  /** Filtered white noise burst with a filter-frequency sweep. */
  private noise(
    c: AudioContext,
    type: BiquadFilterType,
    f0: number,
    f1: number,
    q: number,
    dur: number,
    peak: number,
    dest: AudioNode,
    t: number,
    attack = 0.002,
    shaper: Curve | null = null,
  ): void {
    if (this.bgmFull()) return;
    const s = c.createBufferSource();
    s.buffer = this.white;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    if (shaper) {
      const ws = c.createWaveShaper();
      ws.curve = shaper;
      f.connect(ws).connect(g);
    } else f.connect(g);
    g.connect(dest);
    s.start(t, Math.random() * Math.max(0, this.white.duration - dur - 0.1));
    s.stop(t + dur + 0.03);
    this.track(s);
  }

  /** Two-operator FM metallic tone. */
  private fm(c: AudioContext, carrier: number, mod: number, index: number, dur: number, peak: number, dest: AudioNode, t: number, type: OscillatorType = 'sine'): void {
    if (this.bgmFull()) return;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = carrier;
    const m = c.createOscillator();
    m.frequency.value = mod;
    const mg = c.createGain();
    mg.gain.setValueAtTime(index * mod, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(1, index * mod * 0.05), t + dur);
    m.connect(mg).connect(o.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    m.start(t);
    o.start(t);
    m.stop(t + dur + 0.03);
    o.stop(t + dur + 0.03);
    this.track(o);
  }

  /** World-positioned panner feeding the SE bus (or the clear warning path). */
  private panner(c: AudioContext, pos: THREE.Vector3, hrtf: boolean, dest: AudioNode): PannerNode {
    const p = c.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 8;
    p.maxDistance = 400;
    p.rolloffFactor = 0.75;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(dest);
    return p;
  }

  // =============================================================================================
  // Per-frame state
  // =============================================================================================
  /**
   * Listener pose (camera) + swing wind (gain linear in speed while hanging on the strand) + winch motor
   * (only while reeling; pitch 140 → 360 Hz with speed).
   */
  update(camPos: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3, swinging: boolean, speed: number, reeling = false): void {
    const c = this.ctx;
    if (!c) return;
    const l = c.listener;
    if (l.positionX) {
      l.positionX.value = camPos.x;
      l.positionY.value = camPos.y;
      l.positionZ.value = camPos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(camPos.x, camPos.y, camPos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
    if (this.windGain && this.windFilter) {
      const W = AUDIO.SWING_WIND;
      const k = swinging ? clamp(speed / W.maxSpeed, 0, 1) : 0;
      this.windGain.gain.setTargetAtTime(W.maxGain * k, c.currentTime, 0.06);
      this.windFilter.frequency.setTargetAtTime(W.f0 + (W.f1 - W.f0) * k, c.currentTime, 0.06);
    }
    if (this.winchGain && this.winchOsc) {
      const M = AUDIO.WINCH;
      const k = clamp(speed / M.maxSpeed, 0, 1);
      this.winchGain.gain.setTargetAtTime(reeling ? M.gain : 0, c.currentTime, reeling ? 0.05 : 0.08);
      this.winchOsc.frequency.setTargetAtTime(M.f0 + (M.f1 - M.f0) * k, c.currentTime, 0.05);
    }
  }

  /** Critical HP heartbeat (§1.3 / §7.2) and regen states (repair blips, BGM calm). */
  setPlayerState(critical: boolean, regenerating: boolean): void {
    this.critical = critical;
    this.regenerating = regenerating;
  }

  /** Bullet-time modulation of the SE and BGM lowpass filters + the enter / exit sounds. */
  setBulletTime(on: boolean): void {
    if (this.btOn === on) return;
    this.btOn = on;
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const target = on ? AUDIO.BT_LOWPASS_CLOSED_HZ : AUDIO.BT_LOWPASS_OPEN_HZ;
    const dur = (on ? AUDIO.BT_LOWPASS_IN_MS : AUDIO.BT_LOWPASS_OUT_MS) / 1000;
    for (const f of [this.seFilter, this.bgmFilter]) {
      f.frequency.cancelScheduledValues(t);
      f.frequency.setValueAtTime(Math.max(20, f.frequency.value), t);
      f.frequency.exponentialRampToValueAtTime(target, t + dur);
      f.Q.cancelScheduledValues(t);
      f.Q.setValueAtTime(f.Q.value, t);
      f.Q.linearRampToValueAtTime(on ? AUDIO.BT_LOWPASS_Q : 0.707, t + dur);
    }
    const cc = this.can(true);
    if (!cc) return;
    if (on) {
      const B = AUDIO.BT_ENTER;
      this.tone(cc, 'sine', B.f0, B.f1, B.ms / 1000, 0.5, this.clearBus, t, 0.004, this.softCurve);
      // Low reverse-wind swell: noise rising into the drop.
      const s = cc.createBufferSource();
      s.buffer = this.white;
      const f = cc.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(260, t);
      f.frequency.exponentialRampToValueAtTime(900, t + 0.22);
      const g = cc.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      s.connect(f).connect(g).connect(this.clearBus);
      s.start(t, Math.random());
      s.stop(t + 0.3);
      this.track(s);
    } else {
      const B = AUDIO.BT_EXIT;
      this.tone(cc, 'sine', B.f0, B.f1, B.ms / 1000, 0.38, this.clearBus, t, 0.01);
    }
  }

  /** FLOW rank (0 = D … 6 = SSS): BGM layers, Layer-5 drive, SSS full cutoff + overdrive mix. */
  setFlowRank(rankIndex: number, layers: number): void {
    this.flowRank = rankIndex;
    this.layerCount = layers;
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.leadShaper.curve = rankIndex >= 5 ? this.hardCurve : this.driveK40;
    this.leadFilter.frequency.setTargetAtTime(rankIndex >= 6 ? 18000 : rankIndex >= 5 ? 5400 : 3200, t, 0.2);
    this.bgmShelf.gain.setTargetAtTime(this.stealthy ? AUDIO.STEALTH_BGM_SHELF_DB : rankIndex >= 6 ? 5 : 0, t, 0.2);
    this.duckDepth = rankIndex >= 6 ? 0.55 : 0.28;
    this.applyLayers(AUDIO.LAYER_FADE_S);
  }

  /** Out of combat (sector cleared / regenerating): layers 2–5 fade out in 800 ms; Layer 1 stays. */
  setCalm(calm: boolean): void {
    if (this.calm === calm) return;
    this.calm = calm;
    this.applyLayers(calm ? AUDIO.CALM_FADE_MS / 1000 : AUDIO.LAYER_FADE_S);
  }

  private applyLayers(fade: number): void {
    const c = this.ctx;
    if (!c) return;
    const now = c.currentTime;
    for (let i = 0; i < 5; i++) {
      const on = i === 0 || (!this.calm && !this.stealthy && i < this.layerCount);
      const level = i === 0 && this.stealthy ? LAYER_LEVEL[0] * AUDIO.STEALTH_BGM_LAYER1_K : LAYER_LEVEL[i];
      if (on === this.layerOn[i] && (i !== 0 || this.layer0Level === level)) continue;
      this.layerOn[i] = on;
      if (i === 0) this.layer0Level = level;
      const g = this.layerGains[i].gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(on ? level : 0, now + fade);
      this.layerUntil[i] = on ? Infinity : now + fade + 0.25;
    }
  }

  /** 0..1 position inside the current beat of the BGM grid (beat-synced searchlights at SS). */
  beatPhase(fallbackTime: number): number {
    const c = this.ctx;
    const beat = AUDIO.SIXTEENTH_S * 4;
    if (!c || c.state !== 'running') return (fallbackTime / beat) % 1;
    const x = (c.currentTime - this.gridOrigin) / beat;
    return ((x % 1) + 1) % 1;
  }

  // =============================================================================================
  // Weapons & equipment (§7.2)
  // =============================================================================================
  /** Player gunfire — a priority voice (never culled, 5A-6). `ammoLeft` is the magazine after this shot. */
  gunshot(gun: GunId, ammoLeft: number, airborne: boolean): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    const d = this.seBus;
    const K = AUDIO.PISTOL_LOW_AMMO_CLICK;
    void airborne;
    if (gun === 'PISTOL') {
      // 8A-3 suppressed rail thump: damped triangle drop through a soft shaper, a pneumatic bandpass snap and a
      // tiny high-tech slide click — quiet enough for alley takedowns.
      const A = AUDIO.PISTOL_THUMP;
      const S = AUDIO.PISTOL_SNAP;
      const C = AUDIO.PISTOL_CLICK;
      this.tone(c, 'triangle', A.f0, A.f1, A.ms / 1000, 0.42, d, t, 0.001, this.softCurve);
      this.noise(c, 'bandpass', S.f0, S.f1, 2.2, S.ms / 1000, 0.2, d, t, 0.002);
      this.tone(c, 'square', C.hz, C.hz * 0.85, C.ms / 1000, 0.05, d, t + 0.03, 0.001);
      if (ammoLeft < K.rounds) this.lowAmmoClick(c, t + 0.03);
    } else {
      // 8A-3 K-90: driven sub-bass shock, distorted electromagnetic whip-crack and a long canyon boom.
      const S = AUDIO.SNIPER_SUB;
      const W = AUDIO.SNIPER_CRACK;
      const B = AUDIO.SNIPER_BOOM;
      this.tone(c, 'sine', S.f0, S.f1, S.ms / 1000, 0.75, d, t, 0.002, this.hardCurve);
      this.tone(c, 'sawtooth', W.f0, W.f1, W.ms / 1000, 0.36, d, t, 0.001, this.driveK45);
      this.noise(c, 'bandpass', B.f0, B.f1, 0.9, B.ms / 1000, 0.42, d, t + 0.004, 0.003);
      this.noise(c, 'bandpass', B.f0 * 0.7, B.f1, 0.7, (B.ms * 1.6) / 1000, 0.22, this.reverbSend, t + 0.02, 0.01);
    }
  }

  /** Metallic dry click layered on low-ammo shots (sine 2600 Hz 25 ms + a short high tick). */
  private lowAmmoClick(c: AudioContext, t: number): void {
    const K = AUDIO.PISTOL_LOW_AMMO_CLICK;
    this.tone(c, 'sine', K.hz, K.hz, K.ms / 1000, 0.22, this.clearBus, t, 0.001);
    this.noise(c, 'highpass', 6000, 6000, 0.8, 0.012, 0.05, this.clearBus, t);
  }

  /** 5A-1 optical servo: zoom in 1400 → 2100 Hz (45 ms, 0.05) / out 1800 → 1100 Hz (40 ms, 0.04), UI bus. */
  zoom(on: boolean): void {
    const c = this.can(true);
    if (!c) return;
    const Z = on ? AUDIO.ZOOM_IN : AUDIO.ZOOM_OUT;
    this.tone(c, 'sine', Z.f0, Z.f1, Z.ms / 1000, Z.gain, this.uiBus, c.currentTime, 0.003);
  }

  dryFire(): void {
    const c = this.can();
    if (!c) return;
    this.tone(c, 'square', 3000, 2200, 0.012, 0.12, this.seBus, c.currentTime, 0.001);
  }

  /**
   * 7A-5: reload start = a soft cloth / grip rustle only (the metal sounds come from `reloadCue` at the exact
   * animation beats); done = a quiet ready tick.
   */
  reload(start: boolean): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    if (start) this.noise(c, 'bandpass', 900, 600, 0.8, 0.09, 0.06, this.seBus, t, 0.01);
    else this.tone(c, 'triangle', 2600, 2600, 0.018, 0.07, this.seBus, t);
  }

  /**
   * Three-stage reload SE at the exact animation beats. Pistol: MAG_OUT metallic release click · MAG_IN heavy lock ·
   * SLIDE slide release. 8A-3 sniper breech: BOLT_OPEN lever lift + rearward rasp · LOAD_ROUND metallic clack of
   * the round into the chamber · BOLT_CLOSE crisp forward slam and lock.
   */
  reloadCue(cue: ReloadCue): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const B = this.seBus;
    switch (cue) {
      case 'MAG_OUT':
        this.tone(c, 'square', 3200, 2100, 0.014, 0.1, B, t, 0.001);
        this.noise(c, 'highpass', 4200, 2600, 0.9, 0.05, 0.12, B, t + 0.008);
        this.noise(c, 'lowpass', 900, 400, 0.7, 0.12, 0.08, B, t + 0.03, 0.01);
        break;
      case 'MAG_IN':
        this.noise(c, 'lowpass', 2200, 300, 1.2, 0.09, 0.32, B, t, 0.001);
        this.tone(c, 'triangle', 170, 70, 0.11, 0.34, B, t, 0.001);
        this.fm(c, 1450, 2050, 2.2, 0.06, 0.12, B, t + 0.004);
        break;
      case 'SLIDE':
        this.noise(c, 'bandpass', 2600, 5200, 2.5, 0.06, 0.16, B, t, 0.004);
        this.fm(c, 2300, 3300, 3.0, 0.1, 0.16, B, t + 0.055);
        this.tone(c, 'square', 2900, 1900, 0.012, 0.14, B, t + 0.055, 0.001);
        break;
      case 'BOLT_OPEN':
        this.tone(c, 'square', 2600, 1700, 0.012, 0.12, B, t, 0.001);
        this.noise(c, 'bandpass', 1500, 3600, 2.0, 0.08, 0.16, B, t + 0.02, 0.004);
        this.tone(c, 'triangle', 820, 520, 0.04, 0.1, B, t + 0.09, 0.002);
        break;
      case 'LOAD_ROUND':
        this.tone(c, 'triangle', 1900, 1150, 0.02, 0.18, B, t, 0.001);
        this.noise(c, 'lowpass', 2600, 420, 1.1, 0.07, 0.24, B, t + 0.004, 0.001);
        this.fm(c, 1250, 1900, 2.0, 0.05, 0.1, B, t + 0.01);
        break;
      case 'BOLT_CLOSE':
        this.noise(c, 'lowpass', 3000, 400, 1.1, 0.08, 0.34, B, t, 0.001);
        this.tone(c, 'triangle', 200, 78, 0.1, 0.32, B, t, 0.001);
        this.fm(c, 1700, 2450, 2.6, 0.08, 0.16, B, t + 0.012);
        this.tone(c, 'square', 3100, 2100, 0.01, 0.12, B, t + 0.05, 0.001);
        break;
      default:
        break;
    }
  }

  // =============================================================================================
  // 10D-1 / 10D-4 world immersion (every 3D source → seBus: city reverb + Bullet-Time lowpass apply)
  // =============================================================================================
  private lastWetStepT = -10;
  private lastSquelchT = -10;
  private lastCrackleT = -10;

  /** 10D-1: expressway car brushing past the player — air whoosh + short two-tone horn (spatial). */
  trafficWhoosh(pos: THREE.Vector3): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const p = this.panner(c, pos, true, this.seBus);
    this.noise(c, 'bandpass', 700, 160, 0.8, 0.62, 0.3, p, t, 0.03, this.softCurve);
    this.tone(c, 'square', 392, 392, 0.16, 0.05, p, t + 0.02, 0.004);
    this.tone(c, 'square', 494, 494, 0.16, 0.04, p, t + 0.02, 0.004);
  }

  /** 10D-4: approaching ALERT enemy wet footstep — heel thud 140 → 65 Hz + 1.9 kHz splash (≤ 4 / s globally). */
  enemyWetStep(pos: THREE.Vector3): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    if (t - this.lastWetStepT < 0.25) return;
    this.lastWetStepT = t;
    const p = this.panner(c, pos, true, this.seBus);
    p.refDistance = 3.5;
    p.rolloffFactor = 1.6;
    this.tone(c, 'sine', 140, 65, 0.09, 0.22, p, t, 0.003);
    this.noise(c, 'bandpass', 1900, 1900, 2.4, 0.055, 0.12, p, t + 0.004, 0.002);
  }

  /**
   * 10D-4: synthetic enemy radio vocoder squelch (DETECTED 135 ms / COMBAT 220 ms): 18 ms bandpassed static →
   * sawtooth cipher through 700 / 1350 / 2200 Hz formants → 20 ms roger click. ≥ 0.8 s global cooldown.
   */
  enemyRadioSquelch(pos: THREE.Vector3, urgent: boolean): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    if (t - this.lastSquelchT < 0.8) return;
    this.lastSquelchT = t;
    const p = this.panner(c, pos, true, this.seBus);
    p.refDistance = 4;
    p.rolloffFactor = 1.2;
    this.noise(c, 'bandpass', 2400, 2400, 3, 0.018, 0.09, p, t, 0.001);
    const body = urgent ? 0.18 : 0.095;
    const t0 = t + 0.018;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(urgent ? 240 : 160, t0);
    o.frequency.linearRampToValueAtTime(urgent ? 170 : 220, t0 + body * 0.5);
    o.frequency.linearRampToValueAtTime(urgent ? 230 : 180, t0 + body);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.008);
    g.gain.setValueAtTime(0.07, t0 + body - 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + body);
    for (const f of [700, 1350, 2200]) {
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = 7;
      o.connect(bp).connect(g);
    }
    g.connect(p);
    o.start(t0);
    o.stop(t0 + body + 0.03);
    this.track(o);
    this.noise(c, 'highpass', 3200, 3200, 0.9, 0.02, 0.06, p, t0 + body + 0.004, 0.001);
  }

  /**
   * 10D-4: speed-of-sound delayed rolling thunder. Reuses the pre-allocated 4 s pink buffer through a lowpass
   * sweeping 95 → 38 Hz (Q 1.4) over 3.2 s with a 1.8 Hz rumble LFO, stereo-panned (−0.85…0.85) into seBus.
   */
  thunderRumble(pan: number, intensity: number): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.pink;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.4;
    lp.frequency.setValueAtTime(95, t);
    lp.frequency.exponentialRampToValueAtTime(38, t + 3.2);
    const g = c.createGain();
    const peak = 0.12 + 0.5 * Math.min(1, Math.max(0, intensity));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
    const lfo = c.createOscillator();
    lfo.frequency.value = 1.8;
    const lfoG = c.createGain();
    // LFO depth follows the envelope (no ±35 % start / cut-off click).
    lfoG.gain.setValueAtTime(0.0001, t);
    lfoG.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.35);
    lfoG.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
    lfo.connect(lfoG).connect(g.gain);
    const sp = c.createStereoPanner();
    sp.pan.value = Math.max(-0.85, Math.min(0.85, pan));
    src.connect(lp).connect(g).connect(sp).connect(this.seBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 3.5);
    lfo.start(t);
    lfo.stop(t + 3.5);
    this.track(src);
  }

  /** 10D-4: faulty alley breaker — crackling high arcs + mains buzz (spatial, ≤ 1 per 0.3 s). */
  breakerCrackle(pos: THREE.Vector3): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    if (t - this.lastCrackleT < 0.3) return;
    this.lastCrackleT = t;
    const p = this.panner(c, pos, true, this.seBus);
    p.refDistance = 3;
    p.rolloffFactor = 1.4;
    for (let k = 0; k < 4; k++) this.noise(c, 'highpass', 4200, 2600, 0.7, 0.03, 0.09, p, t + k * 0.045 + Math.random() * 0.02, 0.001);
    this.fm(c, 100, 50, 6, 0.22, 0.05, p, t, 'square');
  }

  /** 10A-6: Faint subtle sonar ping SE every 3.5 s pulse-radar sweep while enemies remain alive. */
  radarPing(): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, 'sine', 1640, 1480, 0.065, 0.022, this.uiBus, t, 0.004);
  }

  // =============================================================================================
  // 8A-5 awareness cues & stealth BGM
  // =============================================================================================
  /**
   * `ALERT`: low electronic suspicion hum · `DETECTED`: sharp spotted sting · `GLOBAL_COMBAT`: tactical radio
   * alarm chime with crackle · `DEESCALATE`: soft descending all-clear blip.
   */
  awareness(kind: 'ALERT' | 'DETECTED' | 'GLOBAL_COMBAT' | 'DEESCALATE'): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const B = this.clearBus;
    switch (kind) {
      case 'ALERT':
        this.tone(c, 'sine', 220, 236, 0.42, 0.05, B, t, 0.06);
        this.tone(c, 'sine', 223, 240, 0.42, 0.045, B, t, 0.06);
        this.noise(c, 'bandpass', 900, 1200, 6, 0.3, 0.025, B, t + 0.05, 0.05);
        break;
      case 'DETECTED':
        this.tone(c, 'square', 1800, 2700, 0.07, 0.11, B, t, 0.001, this.driveK40);
        this.tone(c, 'sawtooth', 2700, 2400, 0.11, 0.07, B, t + 0.07, 0.002);
        this.noise(c, 'highpass', 5000, 3000, 0.8, 0.06, 0.08, B, t, 0.001);
        break;
      case 'GLOBAL_COMBAT':
        for (let k = 0; k < 3; k++) {
          const tk = t + k * 0.16;
          this.tone(c, 'square', k % 2 ? 1175 : 880, k % 2 ? 1175 : 880, 0.11, 0.07, B, tk, 0.004);
          this.noise(c, 'bandpass', 2400, 1800, 3, 0.1, 0.04, B, tk, 0.002);
        }
        this.noise(c, 'bandpass', 1600, 2600, 1.5, 0.5, 0.035, B, t, 0.02);
        break;
      case 'DEESCALATE':
        this.tone(c, 'sine', 1320, 660, 0.25, 0.05, B, t, 0.01);
        this.tone(c, 'sine', 990, 495, 0.3, 0.035, B, t + 0.12, 0.01);
        break;
      default:
        break;
    }
  }

  /** 8A-5: highest enemy state UNAWARE / ALERT → filtered Layer 1 only; DETECTED / COMBAT → erupt to FLOW layers. */
  setStealth(stealthy: boolean): void {
    if (this.stealthy === stealthy) return;
    this.stealthy = stealthy;
    const c = this.ctx;
    if (c) this.bgmShelf.gain.setTargetAtTime(stealthy ? AUDIO.STEALTH_BGM_SHELF_DB : this.flowRank >= 6 ? 5 : 0, c.currentTime, stealthy ? 0.4 : 0.08);
    this.applyLayers(stealthy ? AUDIO.CALM_FADE_MS / 1000 : AUDIO.STEALTH_ERUPT_S);
  }

  /** 7A-6 auto-mantle: glove grip slap on the ledge + a short body scrape. */
  mantle(): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    this.noise(c, 'lowpass', 1600, 300, 0.8, 0.08, 0.26, this.seBus, t, 0.002);
    this.tone(c, 'triangle', 150, 70, 0.09, 0.2, this.seBus, t, 0.001);
    this.noise(c, 'bandpass', 700, 1500, 0.9, 0.16, 0.08, this.seBus, t + 0.06, 0.02);
  }

  /** 7A-6 crouch down / up: cloth rustle. */
  crouch(down: boolean): void {
    const c = this.can();
    if (!c) return;
    this.noise(c, 'bandpass', down ? 1100 : 1400, down ? 600 : 900, 0.8, 0.12, 0.07, this.seBus, c.currentTime, 0.015);
  }

  /** Two-stage switch: holster (LP noise 800 Hz 45 ms) → 90 ms later load click 1600 → 2400 Hz; reel FM 3100 Hz into the strand. */
  switchGear(to: SlotId): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const H = AUDIO.SWITCH_HOLSTER;
    const K = AUDIO.SWITCH_CLICK;
    this.noise(c, 'lowpass', H.hz, H.hz, 0.7, H.ms / 1000, 0.22, this.seBus, t);
    this.tone(c, 'triangle', K.f0, K.f1, K.ms / 1000, 0.2, this.seBus, t + K.delayMs / 1000, 0.001);
    if (to === 'GRAPPLE') this.fm(c, AUDIO.SWITCH_REEL_FM_HZ, AUDIO.SWITCH_REEL_FM_HZ * 1.41, 2.5, 0.12, 0.09, this.seBus, t + 0.04);
  }

  strandFire(): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const A = AUDIO.STRAND_FIRE_AIR;
    const P = AUDIO.STRAND_FIRE_PAYOUT;
    this.noise(c, 'bandpass', A.f0, A.f1, 1.2, A.ms / 1000, 0.32, this.seBus, t, 0.002);
    this.tone(c, 'sawtooth', P.f0, P.f1, A.ms / 1000, 0.07, this.seBus, t, 0.005);
  }

  strandAnchor(): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const S = AUDIO.STRAND_ANCHOR;
    this.tone(c, 'square', S.squareHz, S.squareHz * 0.9, S.ms / 1000, 0.18, this.seBus, t, 0.001);
    this.fm(c, S.fmHz, S.fmHz * 1.37, 3.2, S.ms / 1000, 0.16, this.seBus, t);
  }

  strandMiss(): void {
    const c = this.can();
    if (!c) return;
    this.noise(c, 'bandpass', 1400, 2600, 1.4, 0.12, 0.08, this.seBus, c.currentTime, 0.01);
  }

  // =============================================================================================
  // Movement
  // =============================================================================================
  jump(): void {
    const c = this.can();
    if (!c) return;
    this.noise(c, 'bandpass', 700, 1600, 0.9, 0.12, 0.07, this.seBus, c.currentTime, 0.01);
  }

  land(fallSpeed: number, water: boolean): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const k = clamp(fallSpeed / 22, 0.15, 1);
    if (water) {
      this.noise(c, 'bandpass', 900, 400, 0.8, 0.35, 0.25 * k, this.seBus, t, 0.005);
      return;
    }
    this.tone(c, 'sine', 80, 32, 0.16, 0.45 * k, this.seBus, t, 0.002);
    this.noise(c, 'lowpass', 700, 200, 0.7, 0.14, 0.22 * k, this.seBus, t);
  }

  slide(): void {
    const c = this.can();
    if (!c) return;
    this.noise(c, 'lowpass', 900, 380, 0.8, 0.38, 0.12, this.seBus, c.currentTime, 0.02);
  }

  /** 5A-6 wall-run magnetic boot tap (every 0.22 s): bandpass 1800 Hz noise 25 ms + triangle 320 → 160 Hz 30 ms. */
  wallRunStep(): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const W = AUDIO.WALLRUN_STEP;
    const j = 1 + (Math.random() * 2 - 1) * 0.04;
    this.noise(c, 'bandpass', W.noiseHz * j, W.noiseHz * j, 2.2, W.noiseMs / 1000, 0.13, this.seBus, t, 0.001);
    this.tone(c, 'triangle', W.f0 * j, W.f1 * j, W.ms / 1000, 0.16, this.seBus, t, 0.001);
  }

  // =============================================================================================
  // Combat feedback
  // =============================================================================================
  /** Body hit tick (UI path, under the hit marker). */
  hitBody(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, 'sine', 1900, 1500, 0.022, 0.08, this.clearBus, t, 0.001);
    this.noise(c, 'highpass', 4200, 4200, 0.7, 0.025, 0.06, this.clearBus, t);
  }

  /**
   * 5A-6 Aegis shield / boss armour deflect — clearly not a body hit: high FM metallic ping (2400 Hz carrier ×
   * 3700 Hz modulator, 85 ms) + a short energy resonance ring.
   */
  hitShield(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    const H = AUDIO.HIT_SHIELD;
    this.fm(c, H.carrierHz, H.modHz, 1.6, H.ms / 1000, 0.1, this.clearBus, t);
    this.tone(c, 'sine', H.ringHz, H.ringHz * 0.94, H.ringMs / 1000, 0.07, this.clearBus, t + 0.004, 0.004);
    this.noise(c, 'bandpass', 5200, 3800, 6, 0.04, 0.05, this.clearBus, t);
  }

  /**
   * Head-shot hit / kill: visor glass (highpass noise 5.5 kHz 90 ms) + metallic chord (root, fifth, octave;
   * A 2 ms, D 240 ms). Consecutive head-shots inside 5 s climb C6 → D6 → E6 → G6 → A6 → C7 → D7 → E7.
   */
  headshot(kill: boolean, nowS: number): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    if (nowS - this.lastHsTime <= AUDIO.HEADSHOT_CHAIN_S) this.hsIndex = Math.min(this.hsIndex + 1, AUDIO.HEADSHOT_LADDER_HZ.length - 1);
    else this.hsIndex = 0;
    this.lastHsTime = nowS;
    const root = AUDIO.HEADSHOT_LADDER_HZ[this.hsIndex];
    const G = AUDIO.HEADSHOT_GLASS;
    const C = AUDIO.HEADSHOT_CHORD;
    const dec = (C.decayMs / 1000) * (kill ? 1.6 : 1);
    const amp = kill ? 0.2 : 0.13;
    this.noise(c, 'highpass', G.hz, G.hz, 0.7, G.ms / 1000, kill ? 0.3 : 0.22, this.clearBus, t);
    this.tone(c, 'sine', root, root, dec, amp, this.clearBus, t, C.attackMs / 1000);
    this.tone(c, 'sine', root * 1.5, root * 1.5, dec, amp * 0.7, this.clearBus, t, C.attackMs / 1000);
    this.tone(c, 'sine', root * 2, root * 2, dec, amp * 0.5, this.clearBus, t, C.attackMs / 1000);
    if (kill) this.fm(c, root * 0.5, root * 1.41, 1.8, dec * 1.4, 0.07, this.clearBus, t);
  }

  /** Body kill: enemy core rupture. */
  kill(pos: THREE.Vector3): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const p = this.panner(c, pos, false, this.seBus);
    this.noise(c, 'bandpass', 1500, 280, 1.1, 0.22, 0.4, p, t, 0.002, this.softCurve);
    this.tone(c, 'sine', 240, 55, 0.2, 0.4, p, t, 0.002);
  }

  /** Shield / boss part break: sub drop + glass shards. */
  partBreak(pos: THREE.Vector3): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, 'sine', 110, 24, 0.65, 0.65, this.seBus, t, 0.003, this.softCurve);
    const p = this.panner(c, pos, false, this.seBus);
    this.noise(c, 'highpass', 3200, 1800, 0.8, 0.3, 0.32, p, t);
    this.fm(c, 820, 1170, 4, 0.4, 0.1, p, t);
  }

  explosion(pos: THREE.Vector3): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    const p = this.panner(c, pos, false, this.seBus);
    this.tone(c, 'sine', 85, 28, 0.55, 0.7, p, t, 0.003, this.hardCurve);
    this.noise(c, 'lowpass', 1100, 180, 0.7, 0.65, 0.55, p, t, 0.003, this.softCurve);
  }

  bossKill(pos: THREE.Vector3): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, 'sine', 140, 20, 1.6, 0.8, this.clearBus, t, 0.003, this.hardCurve);
    this.noise(c, 'lowpass', 2400, 120, 0.7, 1.4, 0.5, this.seBus, t, 0.004, this.softCurve);
    const p = this.panner(c, pos, false, this.seBus);
    this.noise(c, 'highpass', 4000, 1400, 0.6, 0.8, 0.3, p, t + 0.05);
    for (let i = 0; i < 3; i++) this.tone(c, 'sine', midiHz(62 + i * 7), midiHz(62 + i * 7), 2.4, 0.08, this.clearBus, t + 0.25 + i * 0.06, 0.01);
  }

  /** Enemy gunfire from its muzzle (spatial). */
  enemyFire(kind: EnemyKind, pos: THREE.Vector3, sniper: boolean): void {
    const c = this.can();
    if (!c) return;
    const t = c.currentTime;
    const p = this.panner(c, pos, false, this.seBus);
    if (sniper) {
      this.tone(c, 'sawtooth', 900, 55, 0.28, 0.5, p, t, 0.001, this.driveK40);
      this.noise(c, 'bandpass', 1500, 400, 0.9, 0.45, 0.45, p, t, 0.001, this.softCurve);
      return;
    }
    switch (kind) {
      case 'AEGIS':
        this.noise(c, 'bandpass', 800, 450, 0.9, 0.2, 0.42, p, t, 0.001, this.softCurve);
        this.tone(c, 'sine', 120, 40, 0.18, 0.45, p, t);
        break;
      case 'DRONE':
        this.tone(c, 'square', 1200, 320, 0.05, 0.18, p, t, 0.001);
        this.noise(c, 'highpass', 3000, 3000, 0.8, 0.04, 0.12, p, t);
        break;
      case 'PHANTOM':
        this.tone(c, 'square', 760, 160, 0.035, 0.22, p, t, 0.001);
        this.noise(c, 'bandpass', 2600, 1400, 1, 0.06, 0.2, p, t);
        break;
      case 'VALKYRIE':
        this.tone(c, 'sawtooth', 640, 90, 0.07, 0.3, p, t, 0.001, this.driveK40);
        this.noise(c, 'bandpass', 1800, 700, 1, 0.1, 0.3, p, t);
        break;
      default:
        this.tone(c, 'square', 540, 95, 0.05, 0.26, p, t, 0.001);
        this.noise(c, 'bandpass', 2100, 900, 1, 0.08, 0.26, p, t);
        break;
    }
  }

  /**
   * Telegraph lock warning: sine + triangle climbing 980 → 1960 Hz (snipers 1400 → 2800 Hz) linearly over the
   * lock time with a 25 Hz tremolo, through an HRTF panner at the enemy. Routed past the bullet-time lowpass so
   * a lock is never masked.
   */
  lock(pos: THREE.Vector3, durationS: number, sniper: boolean): void {
    const c = this.can(true);
    if (!c || this.lockVoices >= AUDIO.MAX_LOCK_VOICES) return;
    const t = c.currentTime;
    const dur = clamp(durationS, 0.12, 1.6);
    const F = sniper ? AUDIO.LOCK_TONE_SNIPER : AUDIO.LOCK_TONE;
    const p = this.panner(c, pos, true, this.clearBus);
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(sniper ? 0.2 : 0.15, t + 0.006);
    env.gain.setValueAtTime(sniper ? 0.2 : 0.15, t + dur - 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const trem = c.createGain();
    trem.gain.value = 0.5;
    const lfo = c.createOscillator();
    lfo.frequency.value = AUDIO.LOCK_TONE.tremoloHz;
    const depth = c.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(trem.gain);
    trem.connect(env).connect(p);
    const a = c.createOscillator();
    a.type = 'sine';
    const b = c.createOscillator();
    b.type = 'triangle';
    for (const o of [a, b]) {
      o.frequency.setValueAtTime(F.f0, t);
      o.frequency.linearRampToValueAtTime(F.f1, t + dur);
      o.connect(trem);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.02);
    this.lockVoices++;
    this.track(a, true);
  }

  /** GRAZE: doppler wind cut (bandpass 2400 → 450 Hz, 160 ms) + clear bell (1760 Hz) rising a semitone per chained graze. */
  graze(nowS: number): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    if (nowS - this.lastGrazeTime <= AUDIO.GRAZE_CHAIN_S) this.grazeSemis = Math.min(this.grazeSemis + 1, AUDIO.GRAZE_CHAIN_MAX_SEMITONES);
    else this.grazeSemis = 0;
    this.lastGrazeTime = nowS;
    const W = AUDIO.GRAZE_WHOOSH;
    const B = AUDIO.GRAZE_BELL;
    const bell = B.hz * Math.pow(2, this.grazeSemis / 12);
    this.noise(c, 'bandpass', W.f0, W.f1, 2.2, W.ms / 1000, 0.34, this.seBus, t, 0.004);
    this.tone(c, 'sine', bell, bell, B.ms / 1000, 0.14, this.clearBus, t + 0.02, 0.002);
  }

  /** Player hit: low punch 90 → 25 Hz + 4.2 kHz tinnitus (gain 0.06, 1.2 s decay). */
  playerHit(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    const P = AUDIO.DAMAGE_PUNCH;
    const T = AUDIO.DAMAGE_TINNITUS;
    this.tone(c, 'sine', P.f0, P.f1, P.ms / 1000, 0.85, this.clearBus, t, 0.002, this.hardCurve);
    this.noise(c, 'lowpass', 500, 120, 0.7, 0.18, 0.3, this.clearBus, t);
    this.tone(c, 'sine', T.hz, T.hz, T.decayS, T.gain, this.clearBus, t, 0.01);
  }

  /** Regen start: clear F#4 + C#5 sine chord (350 ms). */
  regenStart(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    for (const hz of AUDIO.REGEN_CHORD_HZ) this.tone(c, 'sine', hz, hz, AUDIO.REGEN_CHORD_MS / 1000, 0.12, this.clearBus, t, 0.012);
  }

  death(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    for (let i = 0; i < 6; i++) this.tone(c, 'square', 200 + Math.random() * 1600, 60 + Math.random() * 200, 0.04, 0.12, this.clearBus, t + i * 0.035, 0.001);
    this.tone(c, 'sine', 300, 30, 0.45, 0.4, this.clearBus, t, 0.003, this.softCurve);
  }

  // =============================================================================================
  // UI / progression
  // =============================================================================================
  gateOpen(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    const notes = [62, 69, 74, 81];
    for (let i = 0; i < notes.length; i++) this.tone(c, 'sine', midiHz(notes[i]), midiHz(notes[i]), 1.4, 0.09, this.clearBus, t + i * 0.09, 0.006);
  }

  modalOpen(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    this.noise(c, 'bandpass', 600, 3200, 1, 0.3, 0.12, this.uiBus, t, 0.08);
    this.tone(c, 'triangle', midiHz(74), midiHz(74), 0.25, 0.08, this.uiBus, t + 0.05, 0.005);
  }

  /** The 450 ms skill-modal input lock has released. */
  modalUnlocked(): void {
    const c = this.can(true);
    if (!c) return;
    this.tone(c, 'sine', 2200, 2200, 0.06, 0.08, this.uiBus, c.currentTime, 0.002);
  }

  uiSelect(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, 'triangle', midiHz(81), midiHz(81), 0.18, 0.12, this.uiBus, t, 0.003);
    this.tone(c, 'triangle', midiHz(86), midiHz(86), 0.3, 0.1, this.uiBus, t + 0.07, 0.003);
    this.fm(c, midiHz(93), midiHz(93) * 2.01, 1.5, 0.5, 0.05, this.uiBus, t + 0.07);
  }

  /** Menu tick — UI bus, audible while paused (volume preview). */
  uiTick(): void {
    const c = this.can(true);
    if (!c) return;
    this.tone(c, 'square', 2600, 2600, 0.015, 0.04, this.uiBus, c.currentTime, 0.001);
  }

  /** District transition whoosh. */
  transition(): void {
    const c = this.can(true);
    if (!c) return;
    const t = c.currentTime;
    this.noise(c, 'lowpass', 300, 7000, 0.9, 0.7, 0.3, this.clearBus, t, 0.45);
    this.tone(c, 'sawtooth', 110, 880, 0.6, 0.06, this.clearBus, t, 0.4);
  }

  // =============================================================================================
  // BGM — look-ahead scheduler (§7.3)
  // =============================================================================================
  private startBgm(c: AudioContext): void {
    this.bgmStep = 0;
    this.nextStepTime = c.currentTime + 0.12;
    this.gridOrigin = this.nextStepTime;
    this.applyLayers(AUDIO.LAYER_FADE_S);
    this.timer = window.setInterval(this.scheduler, AUDIO.SCHEDULER_INTERVAL_MS);
  }

  /** Stops the scheduler (page teardown). */
  dispose(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private readonly scheduler = (): void => {
    const c = this.ctx;
    // Paused / result / title: the world bus is muted and nothing is scheduled (re-synced on resume).
    if (!c || c.state !== 'running' || this.paused) return;
    const now = c.currentTime;
    const horizon = now + AUDIO.SCHEDULER_LOOKAHEAD_S;
    // Re-sync after the tab was throttled / hidden (never burst-schedule the backlog).
    if (this.nextStepTime < now - 0.05) {
      this.nextStepTime = now + 0.03;
      this.gridOrigin = this.nextStepTime - this.bgmStep * AUDIO.SIXTEENTH_S;
    }
    this.bgmMode = true;
    while (this.nextStepTime < horizon) {
      this.playStep(c, this.bgmStep, this.nextStepTime);
      this.nextStepTime += AUDIO.SIXTEENTH_S;
      this.bgmStep++;
    }
    this.bgmMode = false;
    // Critical heartbeat: 60 Hz lowpassed double beat looping at 128 BPM.
    if (this.critical) {
      if (this.nextHeartTime < now) this.nextHeartTime = now + 0.02;
      while (this.nextHeartTime < horizon) {
        this.heartbeat(c, this.nextHeartTime, 1);
        this.heartbeat(c, this.nextHeartTime + AUDIO.HEARTBEAT.dubDelayS, 0.7);
        this.nextHeartTime += 60 / AUDIO.HEARTBEAT.bpm;
      }
    }
    // Regenerating: faint electronic repair blips.
    if (this.regenerating) {
      if (this.nextRepairTime < now) this.nextRepairTime = now + 0.02;
      while (this.nextRepairTime < horizon) {
        const hz = 2400 + Math.random() * 1400;
        if (this.seVoices < AUDIO.MAX_SE_VOICES) this.tone(c, 'sine', hz, hz * 1.12, 0.022, 0.018, this.clearBus, this.nextRepairTime, 0.002);
        this.nextRepairTime += 0.13;
      }
    }
  };

  private heartbeat(c: AudioContext, t: number, amp: number): void {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(64, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.13);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = AUDIO.HEARTBEAT.lowpassHz;
    lp.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * amp, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(lp).connect(g).connect(this.clearBus);
    o.start(t);
    o.stop(t + 0.18);
    this.track(o);
  }

  private audible(i: number, t: number): boolean {
    return t < this.layerUntil[i];
  }

  private playStep(c: AudioContext, step: number, t: number): void {
    const s = step & 15;
    const bar = step >> 4;
    const chord = bar & 3;
    const six = AUDIO.SIXTEENTH_S;
    const rank = this.flowRank;

    // Sidechain-style pump on every beat (stronger in the SSS OVERDRIVE MIX).
    if ((s & 3) === 0) {
      const g = this.musicDuck.gain;
      g.setValueAtTime(1 - this.duckDepth, t);
      g.linearRampToValueAtTime(1, t + six * 2.2);
    }

    // Layer 1 — Deep Pulse: 16th octave saw bass through a 380 Hz lowpass.
    if (this.audible(0, t)) {
      const root = AUDIO.BASS_ROOTS_HZ[chord];
      const f = (s & 1) === 0 ? root : root * 2;
      this.tone(c, 'sawtooth', f, f, six * 0.95, 0.5 * BASS_PUMP[s & 3], this.bassFilter, t, 0.004);
    }

    // Layer 2 — Cyber Drums: four-on-the-floor + second-half syncopation, industrial snare on 2 & 4.
    const fill = (rank >= 5 && (bar & 7) === 7) || (rank >= 3 && (bar & 15) === 15);
    if (this.audible(1, t)) {
      const L = this.layerGains[1];
      const K = AUDIO.KICK;
      const kick = (s & 3) === 0 || ((bar & 1) === 1 && s === 14) || ((bar & 3) === 3 && s === 11);
      if (kick) {
        this.tone(c, 'sine', K.f0, K.f1, 0.2, 0.95, L, t, 0.002, this.softCurve);
        this.noise(c, 'highpass', 3500, 3500, 0.7, 0.012, 0.18, L, t);
      }
      if (fill && s >= 12) {
        this.noise(c, 'bandpass', 1900, 1300, 0.9, 0.09, 0.22 + (s - 12) * 0.08, L, t, 0.001, this.softCurve);
        this.tone(c, 'triangle', 220 - (s - 12) * 25, 80, 0.12, 0.3, L, t, 0.002);
      } else if (s === 4 || s === 12) {
        this.noise(c, 'bandpass', 1900, 1300, 0.9, 0.16, 0.5, L, t, 0.001, this.softCurve);
        this.tone(c, 'triangle', AUDIO.SNARE_BODY_HZ, AUDIO.SNARE_BODY_HZ * 0.8, 0.1, 0.45, L, t, 0.001);
      }
    }

    // Layer 3 — Neon Arp: D minor pentatonic 16ths (square + 3/16 delay).
    if (this.audible(2, t)) {
      const scale = AUDIO.ARP_SCALE_HZ;
      const idx = Math.min(scale.length - 1, ARP_PATTERN[s] + ARP_CHORD_OFFSET[chord]);
      this.tone(c, 'square', scale[idx], scale[idx], six * 0.8, 0.16, this.arpIn, t, 0.003);
    }

    // Layer 4 — Breakbeat Perc: 16th highpassed hats + metal rimshots.
    if (this.audible(3, t)) {
      const L = this.layerGains[3];
      const open = (s & 3) === 2;
      this.noise(c, 'highpass', AUDIO.HAT_HIGHPASS_HZ, AUDIO.HAT_HIGHPASS_HZ, 0.7, open ? 0.09 : 0.03, (s & 1) === 1 ? 0.22 : 0.13, L, t, 0.001);
      if (s === 3 || s === 7 || s === 15 || ((bar & 1) === 1 && s === 10)) {
        this.tone(c, 'triangle', 1700, 1500, 0.035, 0.22, L, t, 0.001);
        this.noise(c, 'bandpass', 2600, 2600, 3, 0.04, 0.2, L, t);
        this.tone(c, 'square', 520, 480, 0.02, 0.08, L, t, 0.001);
      }
    }

    // Layer 5 — Overdrive Lead: driven saw + octaver melody; SSS adds a lead fill-in every 8 bars.
    if (this.audible(4, t)) {
      const phraseStep = step % 128;
      for (const [start, len, note] of LEAD_PHRASE) {
        if (start !== phraseStep) continue;
        this.leadNote(c, midiHz(note), len * six, t);
      }
      if (rank >= 6 && (bar & 7) === 7 && s >= 8) {
        const run = [74, 77, 79, 81, 84, 86, 89, 91];
        this.leadNote(c, midiHz(run[s - 8]), six * 0.9, t);
      }
    }
  }

  private leadNote(c: AudioContext, hz: number, dur: number, t: number): void {
    if (this.bgmFull()) return;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
    g.gain.setValueAtTime(0.2, t + Math.max(0.02, dur - 0.04));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    g.connect(this.leadIn);
    const a = c.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = hz;
    a.detune.value = 6;
    const b = c.createOscillator();
    b.type = 'sawtooth';
    b.frequency.value = hz * 0.5;
    const bg = c.createGain();
    bg.gain.value = 0.6;
    a.connect(g);
    b.connect(bg).connect(g);
    a.start(t);
    b.start(t);
    a.stop(t + dur + 0.08);
    b.stop(t + dur + 0.08);
    this.track(a);
  }
}
