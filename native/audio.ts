// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, events from sfx/manifest.json; player events take the
// seat's own clip), the quiet per-theme ambience (two seconds of noise
// through a low-pass, looped: room 320 Hz, paper 900, night 200, wind 500,
// deep 140, at the theme's gain × the old ambience bus 0.4) and the adaptive
// music pad (A2 + E3 sines, E3's detune drifting ±4 cents at 0.05 Hz; its
// level 0.05 + intensity × 0.12 follows the board's tension, eased over
// ~1.5 s, on the old music bus × 0.5). The runtime has no ambience bus, so
// the ambience plays on the music bus. Loops are rendered once into clips in
// slices across frames (per-sample work is slow natively); the synthesized
// blips audio.js played while a sample loaded are not ported (a live
// synthesis graph makes clip loads fail on the web runtime): a clip still
// loading is silent. The runtime's Options own the volumes, the mute and the
// voice limit; clips load once the mixer runs, one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

export type Sfx = "uiTick" | "uiBack" | "focus" | "placeImpact" | "invalid" | "turnPass" | "win" | "lose" | "draw" | "clockWarning" | "achievement";
const SAMPLES: Record<Sfx, string[]> = {
  uiTick: ["ui-tick"], uiBack: ["ui-back"], focus: ["focus"], placeImpact: ["place-impact-p1", "place-impact-p2"], invalid: ["invalid"],
  turnPass: ["turn-pass"], win: ["win"], lose: ["lose"], draw: ["draw"], clockWarning: ["clock-warning"], achievement: ["achievement"],
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;

export function loadSfx(): void { wantClips = true; }
/** audio.js's event sounds: player events (placeImpact) take that seat's clip. */
export function play(ev: Sfx, player = 1): void {
  const names = SAMPLES[ev];
  const name = names[Math.min(Math.max(player, 1), names.length) - 1]!;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); }
}

// ---- rendered loops ---------------------------------------------------------------------------
const RATE = 22050;
interface Job { data: Float32Array; pos: number; fill: (from: number, to: number) => void; clip: AudioClip | null; fade: number }
let seed = 0x7a11;
const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
function lowpassJob(freq: number): Job {
  // RBJ low-pass biquad, Q 1 (Web Audio's default)
  const w0 = (2 * Math.PI * freq) / RATE, al = Math.sin(w0) / 2, cw = Math.cos(w0);
  const b0 = (1 - cw) / 2 / (1 + al), b1 = (1 - cw) / (1 + al), a1 = (-2 * cw) / (1 + al), a2 = (1 - al) / (1 + al);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const step = (): number => { const x = rand(); const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
  for (let i = 0; i < 2000; i++) step(); // settle
  const data = new Float32Array(RATE * 2);
  return { data, pos: 0, clip: null, fade: Math.round(RATE * 0.05), fill: (a, b) => { for (let i = a; i < b; i++) data[i] = step(); } };
}
const SINE = new Float32Array(4096);
for (let i = 0; i < SINE.length; i++) SINE[i] = Math.sin((i / SINE.length) * Math.PI * 2);
function padJob(): Job {
  // 20 s: one whole LFO period; E3's phase follows its drifting detune
  const data = new Float32Array(RATE * 20);
  let pa = 0, pb = 0;
  return {
    data, pos: 0, clip: null, fade: Math.round(RATE * 0.25),
    fill: (a, b) => {
      for (let i = a; i < b; i++) {
        const t = i / RATE;
        const det = 4 * SINE[Math.floor(((t * 0.05) % 1) * 4096)]!;
        pa = (pa + 110 / RATE) % 1;
        pb = (pb + (164.81 * Math.pow(2, det / 1200)) / RATE) % 1;
        data[i] = 0.5 * (SINE[Math.floor(pa * 4096)]! + SINE[Math.floor(pb * 4096)]!);
      }
    },
  };
}
function run(job: Job, budget: number): void {
  if (job.clip) return;
  const end = Math.min(job.data.length, job.pos + budget);
  job.fill(job.pos, end);
  job.pos = end;
  if (job.pos < job.data.length) return;
  // cross-fade the loop's seam so it loops without a click
  const d = job.data, f = job.fade;
  for (let i = 0; i < f; i++) { const k = i / f; d[d.length - f + i] = d[d.length - f + i]! * (1 - k) + d[i]! * k; }
  try { job.clip = createClip([d.subarray(f)], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); job.pos = 0; }
}

const AMBIENCE: Record<string, { freq: number; gain: number }> = {
  room: { freq: 320, gain: 0.5 }, paper: { freq: 900, gain: 0.22 }, night: { freq: 200, gain: 0.45 }, wind: { freq: 500, gain: 0.5 }, deep: { freq: 140, gain: 0.6 },
};
const ambJobs = new Map<string, Job>();
let ambWant = "room";
let ambKind = "";
let ambVoice: Sound | null = null;
/** audio.js startAmbience(kind): the theme's loop. */
export function ambience(kind: string): void { ambWant = AMBIENCE[kind] ? kind : "room"; }

const pad = padJob();
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

/** Each frame: clips one at a time once the mixer runs, loop slices, the loop voices. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const list of Object.values(SAMPLES)) for (const n of list) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
  }
  let job = ambJobs.get(ambWant);
  if (!job) { job = lowpassJob(AMBIENCE[ambWant]!.freq); ambJobs.set(ambWant, job); }
  run(job, 3000);
  if (job.clip && ambKind !== ambWant) {
    try { ambVoice?.stop(); } catch { /* gone */ }
    ambKind = ambWant;
    try { ambVoice = playClip(job.clip, { bus: "music", gain: AMBIENCE[ambWant]!.gain * 0.4, loop: true }); } catch { ambVoice = null; ambKind = ""; }
  }
  if (job.clip) run(pad, 4000);
  if (musicOn && pad.clip && !musicVoice) {
    try { musicVoice = playClip(pad.clip, { bus: "music", gain: musicGain(), loop: true }); } catch { musicVoice = null; }
  } else if (!musicOn && musicVoice) {
    try { musicVoice.stop(); } catch { /* gone */ }
    musicVoice = null;
  }
}
