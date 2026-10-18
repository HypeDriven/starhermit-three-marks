// Graphics quality model: presets, per-category overrides, StarHermit hardware-level detection,
// per-preset asset/effect budgets and a cost summary. Pure (no three.js) so the settings panel, the renderer and the
// unit tests agree on what every setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category -> allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'], // image-based lighting (studio environment map)
  particles: ['low', 'high'], // chalk-dust bursts + drifting motes in the lamp light
  detail: ['plain', 'detailed'], // wood/slate surface maps, desk props
};

// Each preset is a row of tiers plus a render scale and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low', detail: 'plain' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'low', detail: 'detailed' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', detail: 'detailed' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Auto picks the preset from the StarHermit hardware level (js/gpu-level.js → window.StarHermitGpu, a
// classic script loaded before main.js; 0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090, each level
// ≈ 1.23× the one below): Low from 0, Balanced from 4, High from 10, Ultra from 17. Phones, tablets and
// ≤ 4 GB machines are capped at level 9 (Balanced).
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it
 * (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). The board,
 * grid, marks' footprint, picking and rules are identical on every preset — only visuals change.
 *   material   lit-surface shader: Lambert (Low), Standard (Balanced), Physical clear-coated frame (High/Ultra)
 *   texture    procedural wood size in px (desk and frame; slate and chalk grain at ½ and ¼ of it)
 *   round      radial segments of the desk, plugs and chalk sticks
 *   curve / bevel  rounded-corner segments and bevel segments of the board and frame
 *   tube / tubeRadial  chalk-stroke tube segments along / around each X and O stroke
 *   particles  Particles "high" chalk-dust pool, dust per mark and lamp-light motes, scaled with the level
 *              (Particles "low" is fixed: 300 / 10 / no motes)
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', texture: 256, round: 12, curve: 6, bevel: 1, tube: 12, tubeRadial: 5, particles: { pool: 900, dustPerMark: 20, motes: 60 }, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', texture: 256, round: 16, curve: 8, bevel: 1, tube: 18, tubeRadial: 6, particles: { pool: 1400, dustPerMark: 28, motes: 90 }, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', texture: 512, round: 24, curve: 12, bevel: 2, tube: 24, tubeRadial: 7, particles: { pool: 2200, dustPerMark: 40, motes: 140 }, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', texture: 1024, round: 32, curve: 16, bevel: 3, tube: 32, tubeRadial: 9, particles: { pool: 3200, dustPerMark: 56, motes: 220 }, bloomRes: 1, aoRes: 1 },
};
export const POOL_MAX = 6400;
export const MOTE_MAX = 440;

/** A preset's concrete budget for a hardware level (counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const src = BUDGETS[preset] || BUDGETS.balanced;
  const b = { ...src, particles: { ...src.particles } };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  const p = b.particles;
  p.pool = Math.min(POOL_MAX, Math.round(p.pool * k));
  p.dustPerMark = Math.round(p.dustPerMark * k);
  p.motes = Math.min(MOTE_MAX, Math.round(p.motes * k));
  return b;
}

/** Fresh saved-settings object: Auto, 100% scale, adaptive on, no fps readout, no overrides. */
export function defaultGraphics() {
  return { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };
}

/** Choosing a preset clears every per-category override. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  return {
    preset: PRESETS.includes(preset) ? preset : 'auto',
    render_scale: s.render_scale ?? 1,
    adaptive: s.adaptive !== false,
    show_fps: !!s.show_fps,
  };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset, auto,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
    dprCap: row.dprCap,
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when something needs it; otherwise the canvas draws directly (MSAA).
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Short cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
const WORDS_EN = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing', px: '{w}×{h} px',
};
/** Cost summary; `w` holds localized words (gfx-i18n.gfxWords), English by default. */
export function describe(r, pixels, w = WORDS_EN) {
  const f = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v[k]);
  const parts = [
    r.shadows === 'off' ? w.noShadows : f(w.shadows, { n: SHADOW_MAP[r.shadows] }),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoFull : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? f(w.px, { w: pixels[0], h: pixels[1] }) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Migrate the pre-preset settings shape ({ tier, renderScale }) to the current one. */
export function migrateGraphics(g) {
  if (!g || typeof g !== 'object') return defaultGraphics();
  const out = { ...defaultGraphics(), ...g };
  if (g.tier !== undefined && g.preset === undefined) {
    out.preset = { low: 'low', medium: 'balanced', high: 'high' }[g.tier] || 'auto';
  }
  if (g.renderScale !== undefined && g.render_scale === undefined) out.render_scale = clamp(Number(g.renderScale) || 1, 0.5, 2);
  delete out.tier;
  delete out.renderScale;
  return out;
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
