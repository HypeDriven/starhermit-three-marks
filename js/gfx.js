// Graphics quality model: presets, per-category overrides, GPU detection and a
// cost summary. Pure (no three.js) so the settings panel, the renderer and the
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

/** Best preset for this GPU (unmasked renderer string when the browser exposes it). */
export function detectPreset(gpu, { mobile = false } = {}) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
  // Touch/mobile devices are capped at Balanced (battery and heat).
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
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
export function resolve(saved, detected) {
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
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
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
