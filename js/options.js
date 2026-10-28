// The game's own options (engine `settings` on the runtime): theme, camera
// angle, colour palette, left-handed rails, confirm moves, timing assist —
// and how the browser build's settings KV (platform.js PREF_KEYS: theme,
// camera {angle}, accessibility {palette, leftHanded, confirmMoves,
// timingAssist, …}) maps onto them. Pure, shared with the node tests.
export const DEFAULT_OPTIONS = { theme: 'slate', camera: 'standard', palette: 'default', leftHanded: false, confirmMoves: false, timingAssist: false };
const THEMES = ['slate', 'paper', 'neon', 'dune', 'abyss'];

/** Valid option values only. */
export function pickOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.theme === 'string' && THEMES.includes(raw.theme)) out.theme = raw.theme;
  if (['standard', 'top', 'low'].includes(raw.camera)) out.camera = raw.camera;
  if (['default', 'deuteranopia', 'tritanopia'].includes(raw.palette)) out.palette = raw.palette;
  for (const k of ['leftHanded', 'confirmMoves', 'timingAssist']) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

/** The browser build's settings KV values as options. */
export function legacyOptions(kv) {
  const obj = (v) => (v && typeof v === 'object' ? v : {});
  const acc = obj(kv && kv.accessibility), cam = obj(kv && kv.camera);
  return pickOptions({
    theme: kv && kv.theme, camera: cam.angle, palette: acc.palette,
    leftHanded: acc.leftHanded, confirmMoves: acc.confirmMoves, timingAssist: acc.timingAssist,
  });
}
