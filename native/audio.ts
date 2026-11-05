// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, events from sfx/manifest.json; player events take the
// seat's own clip), the quiet per-theme ambience (two seconds of noise
// through a low-pass, looped: room 320 Hz, paper 900, night 200, wind 500,
// deep 140, at the theme's gain × the old ambience bus 0.4) and the adaptive
// music pad (A2 + E3 sines, E3's detune drifting ±4 cents at 0.05 Hz; its
// level 0.05 + intensity × 0.12 follows the board's tension, eased over
// ~1.5 s, on the old music bus × 0.5). The runtime has no ambience bus, so
// the ambience plays on the music bus. Loops are rendered once into clips
// (OfflineAudioContext); the synthesized blips audio.js played while a sample
// loaded are not ported: a clip still loading is silent. The runtime's Options
// own the volumes, the mute and the voice limit. Clips load and the loops render
// in onStart (the theme's bed on demand); only starting a loop waits for the
// mixer (in a browser, the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

export type Sfx = "uiTick" | "uiBack" | "focus" | "placeImpact" | "invalid" | "turnPass" | "win" | "lose" | "draw" | "clockWarning" | "achievement";
const SAMPLES: Record<Sfx, string[]> = {
  uiTick: ["ui-tick"], uiBack: ["ui-back"], focus: ["focus"], placeImpact: ["place-impact-p1", "place-impact-p2"], invalid: ["invalid"],
  turnPass: ["turn-pass"], win: ["win"], lose: ["lose"], draw: ["draw"], clockWarning: ["clock-warning"], achievement: ["achievement"],
};
const clips = new Map<string, AudioClip>();

/** Loads every clip at once and renders the pad and the first bed (onStart). */
export function loadSfx(): void {
  for (const list of Object.values(SAMPLES)) for (const name of list) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => { console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`); });
  }
  renderPad().then((c) => { padClip = c; }, warn);
  ambience(ambWant);
}
/** audio.js's event sounds: player events (placeImpact) take that seat's clip. */
export function play(ev: Sfx, player = 1): void {
  const names = SAMPLES[ev];
  const name = names[Math.min(Math.max(player, 1), names.length) - 1]!;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* the mixer is full this frame: skip it */ }
}

// ---- rendered loops ---------------------------------------------------------------------------
const RATE = 22050;
const warn = (e: unknown): void => { console.warn(`audio: ${String(e)}`); };
/** Two seconds of white noise through the theme's low-pass (Q 0 dB: linear 1, as the old biquad). Filtered periodic noise is periodic once settled: no crossfade. */
async function renderBed(freq: number): Promise<AudioClip> {
  const settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + RATE * 2, RATE);
  const noise = off.createNoise({ seed: 0x7a11, seconds: 2 });
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = freq; lp.Q.value = 0;
  noise.connect(lp).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
/** 20 s, one whole LFO period: A2 + E3 (164.8 Hz: a whole number of cycles), E3's detune ±4 cents at 0.05 Hz. Loops without a seam. */
async function renderPad(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, RATE * 20, RATE);
  const mix = off.createGain(); mix.gain.value = 0.5; mix.connect(off.destination);
  const a = off.createOscillator(); a.frequency.value = 110; a.connect(mix); a.start();
  const b = off.createOscillator(); b.frequency.value = 164.8; b.connect(mix); b.start();
  const lfo = off.createOscillator(); lfo.frequency.value = 0.05;
  const depth = off.createGain(); depth.gain.value = 4;
  lfo.connect(depth).connect(b.detune); lfo.start();
  const r = await off.startRendering();
  return createClip(r);
}

const AMBIENCE: Record<string, { freq: number; gain: number }> = {
  room: { freq: 320, gain: 0.5 }, paper: { freq: 900, gain: 0.22 }, night: { freq: 200, gain: 0.45 }, wind: { freq: 500, gain: 0.5 }, deep: { freq: 140, gain: 0.6 },
};
const beds = new Map<string, AudioClip | null>();
let ambWant = "room";
let ambKind = "";
let ambVoice: Sound | null = null;
/** audio.js startAmbience(kind): the theme's loop. */
export function ambience(kind: string): void {
  ambWant = AMBIENCE[kind] ? kind : "room";
  const want = ambWant;
  if (beds.has(want)) return;
  beds.set(want, null);
  renderBed(AMBIENCE[want]!.freq).then((c) => { beds.set(want, c); }, warn);
}

let padClip: AudioClip | null = null;
let musicOn = false;
let musicLevel = 0;
let musicVoice: Sound | null = null;
const musicGain = (): number => (0.05 + musicLevel * 0.12) * 0.5;
/** audio.js startMusic / stopMusic. */
export function music(on: boolean): void { musicOn = on; }
/** audio.js setMusicIntensity(0..1). */
export function intensity(level: number): void {
  const next = Math.max(0, Math.min(1, level));
  if (next === musicLevel) return;
  musicLevel = next;
  try { musicVoice?.fade(musicGain(), 1.5); } catch { /* gone */ }
}

/** Each frame, once the mixer runs: the loop voices. */
export function update(): void {
  if (context.state !== "running") return;
  const bed = beds.get(ambWant);
  if (bed && ambKind !== ambWant) {
    try { ambVoice?.stop(); } catch { /* gone */ }
    ambKind = ambWant;
    try { ambVoice = playClip(bed, { bus: "music", gain: AMBIENCE[ambWant]!.gain * 0.4, loop: true }); } catch { ambVoice = null; ambKind = ""; }
  }
  if (musicOn && padClip && !musicVoice) {
    try { musicVoice = playClip(padClip, { bus: "music", gain: musicGain(), loop: true }); } catch { musicVoice = null; }
  } else if (!musicOn && musicVoice) {
    try { musicVoice.stop(); } catch { /* gone */ }
    musicVoice = null;
  }
}
