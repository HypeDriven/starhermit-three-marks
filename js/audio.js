// Procedural audio: original short transients tied to logical events, layered
// material impacts, quiet ambience and an adaptive music pad. Buses are
// independent (music / effects / ambience / voice). All randomness in
// variants is seeded so replays sound identical.
import { RngStream } from './rng.js';

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.ambienceNodes = null;
    this.musicNodes = null;
    this.musicLevel = 0; // adaptive intensity 0..1
    this.rng = new RngStream(1);
    this.started = false;
    this.suspended = false;
  }

  // Must be called from a user gesture.
  init() {
    if (this.ctx) return true;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.buses = { master };
    for (const name of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.connect(master);
      this.buses[name] = g;
    }
    this.applySettings(this.settings);
    return true;
  }

  applySettings(settings) {
    this.settings = settings;
    if (!this.ctx) return;
    const a = settings.audio;
    this.buses.master.gain.value = a.muted ? 0 : 1;
    this.buses.music.gain.value = a.music * 0.5;
    this.buses.effects.gain.value = a.effects;
    this.buses.ambience.gain.value = a.ambience * 0.4;
    this.buses.voice.gain.value = a.voice;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this.suspended = false;
  }

  suspend() {
    // Background tabs keep the lifecycle but stop output.
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    this.suspended = true;
  }

  setSeed(seed) {
    this.rng = new RngStream((seed ^ 0x9e3779b9) >>> 0);
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ---- primitives ----

  envelope(gainNode, t0, peak, attack, decay) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  noiseBuffer(seconds = 1) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  burst({ type = 'noise', freq = 800, q = 1, peak = 0.3, attack = 0.005, decay = 0.12, pitchEnd = null, bus = 'effects' }) {
    if (!this.ctx || this.suspended) return;
    const t0 = this.now();
    const gain = this.ctx.createGain();
    gain.connect(this.buses[bus]);
    if (type === 'noise') {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(0.5);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(freq, t0);
      if (pitchEnd) filter.frequency.exponentialRampToValueAtTime(pitchEnd, t0 + attack + decay);
      filter.Q.value = q;
      src.connect(filter).connect(gain);
      src.start(t0);
      src.stop(t0 + attack + decay + 0.05);
    } else {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (pitchEnd) osc.frequency.exponentialRampToValueAtTime(pitchEnd, t0 + attack + decay);
      osc.connect(gain);
      osc.start(t0);
      osc.stop(t0 + attack + decay + 0.05);
    }
    this.envelope(gain, t0, peak, attack, decay);
  }

  // ---- logical event sounds ----

  uiTick() {
    this.burst({ type: 'triangle', freq: 2200, peak: 0.08, attack: 0.002, decay: 0.04 });
  }

  uiBack() {
    this.burst({ type: 'triangle', freq: 1400, pitchEnd: 900, peak: 0.08, attack: 0.002, decay: 0.06 });
  }

  focus() {
    this.burst({ type: 'sine', freq: 1800, peak: 0.03, attack: 0.002, decay: 0.03 });
  }

  // Chalk scratch: band-passed noise with seeded pitch variant.
  chalkStroke(player = 1) {
    const variant = 1 + (this.rng.next() - 0.5) * 0.25;
    const base = player === 1 ? 2600 : 2100;
    this.burst({ type: 'noise', freq: base * variant, pitchEnd: base * 0.6 * variant, q: 2.5, peak: 0.22, attack: 0.01, decay: 0.22 });
    this.burst({ type: 'noise', freq: 500, q: 0.8, peak: 0.12, attack: 0.004, decay: 0.1 });
  }

  // Contact grounding thump under the chalk.
  placeImpact(player = 1) {
    this.chalkStroke(player);
    this.burst({ type: 'sine', freq: player === 1 ? 160 : 130, pitchEnd: 60, peak: 0.25, attack: 0.004, decay: 0.16 });
  }

  invalid() {
    this.burst({ type: 'square', freq: 220, pitchEnd: 180, peak: 0.06, attack: 0.004, decay: 0.12 });
  }

  turnPass() {
    this.burst({ type: 'sine', freq: 700, peak: 0.05, attack: 0.004, decay: 0.07 });
  }

  win() {
    if (!this.ctx || this.suspended) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      setTimeout(() => this.burst({ type: 'triangle', freq: f, peak: 0.14, attack: 0.01, decay: 0.5 }), i * 110);
    });
    this.burst({ type: 'noise', freq: 3000, q: 0.7, peak: 0.08, attack: 0.02, decay: 0.6 });
  }

  lose() {
    if (!this.ctx || this.suspended) return;
    [392, 330, 262].forEach((f, i) => {
      setTimeout(() => this.burst({ type: 'triangle', freq: f, peak: 0.12, attack: 0.01, decay: 0.45 }), i * 160);
    });
  }

  draw() {
    this.burst({ type: 'triangle', freq: 440, peak: 0.1, attack: 0.02, decay: 0.4 });
    setTimeout(() => this.burst({ type: 'triangle', freq: 440, peak: 0.08, attack: 0.02, decay: 0.5 }), 220);
  }

  clockWarning() {
    this.burst({ type: 'sine', freq: 1100, peak: 0.07, attack: 0.003, decay: 0.08 });
  }

  achievement() {
    if (!this.ctx || this.suspended) return;
    [880, 1174.7].forEach((f, i) => {
      setTimeout(() => this.burst({ type: 'sine', freq: f, peak: 0.1, attack: 0.01, decay: 0.35 }), i * 130);
    });
  }

  // ---- ambience: quiet looped filtered noise per theme ----

  startAmbience(kind = 'room') {
    if (!this.ctx) return;
    this.stopAmbience();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(2);
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const params = {
      room: { freq: 320, gain: 0.5 },
      paper: { freq: 900, gain: 0.22 },
      night: { freq: 200, gain: 0.45 },
      wind: { freq: 500, gain: 0.5 },
      deep: { freq: 140, gain: 0.6 },
    }[kind] || { freq: 320, gain: 0.5 };
    filter.frequency.value = params.freq;
    const gain = this.ctx.createGain();
    gain.gain.value = params.gain;
    src.connect(filter).connect(gain).connect(this.buses.ambience);
    src.start();
    this.ambienceNodes = { src, gain };
  }

  stopAmbience() {
    if (this.ambienceNodes) {
      try { this.ambienceNodes.src.stop(); } catch { /* already stopped */ }
      this.ambienceNodes = null;
    }
  }

  // ---- adaptive music: slow two-oscillator pad, intensity follows tension ----

  startMusic() {
    if (!this.ctx || this.musicNodes) return;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0;
    gain.connect(this.buses.music);
    const oscA = this.ctx.createOscillator();
    const oscB = this.ctx.createOscillator();
    oscA.type = 'sine';
    oscB.type = 'sine';
    oscA.frequency.value = 110; // A2
    oscB.frequency.value = 164.81; // E3
    oscA.connect(gain);
    oscB.connect(gain);
    oscA.start();
    oscB.start();
    // Slow chord drift via an LFO on detune; deterministic shape.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 4;
    lfo.connect(lfoGain).connect(oscB.detune);
    lfo.start();
    this.musicNodes = { gain, oscA, oscB, lfo };
    this.applyMusicLevel();
  }

  setMusicIntensity(level) {
    this.musicLevel = Math.max(0, Math.min(1, level));
    this.applyMusicLevel();
  }

  applyMusicLevel() {
    if (!this.ctx || !this.musicNodes) return;
    const target = 0.05 + this.musicLevel * 0.12;
    this.musicNodes.gain.gain.setTargetAtTime(target, this.now(), 1.5);
  }

  stopMusic() {
    if (this.musicNodes) {
      for (const k of ['oscA', 'oscB', 'lfo']) {
        try { this.musicNodes[k].stop(); } catch { /* already stopped */ }
      }
      this.musicNodes = null;
    }
  }

  haptic(pattern = 20) {
    if (this.settings.accessibility.haptics && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  }
}
