import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// js/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../js/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const { detectPreset, detectLevel, presetForLevel, budgetFor, resolve, presetTier, describe, choosePreset, migrateGraphics, CATEGORIES, PRESETS,
  LEVELS, BUDGETS, POOL_MAX, MOTE_MAX } = await import('../js/gfx.js');
const { pickLocale, gfxStrings, GFX_LOCALES } = await import('../js/gfx-i18n.js');
const { migrateSettings } = await import('../js/storage.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M1', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = Object.keys(BUDGETS.low);
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    const [a, b] = [BUDGETS[PRESETS[i - 1]], BUDGETS[PRESETS[i]]];
    for (const k of keys) if (typeof a[k] === 'number') assert.ok(b[k] >= a[k], `${PRESETS[i]}.${k}`);
    for (const k of Object.keys(a.particles)) assert.ok(b.particles[k] >= a.particles[k], `${PRESETS[i]}.particles.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).particles.motes > budgetFor('balanced', 4).particles.motes, 'counts scale up within the preset');
  assert.ok(budgetFor('balanced', 20).particles.pool <= 2 * BUDGETS.balanced.particles.pool, '≤ 2×');
  assert.ok(budgetFor('ultra', 20).particles.pool <= POOL_MAX && budgetFor('ultra', 20).particles.motes <= MOTE_MAX);
  const head = resolve({}, 'low', 0);
  assert.equal(head.preset, 'low', 'headless SwiftShader: Low');
  assert.equal(head.level, 0);
});

test('every locale has the Level label', () => {
  for (const loc of GFX_LOCALES) assert.match(gfxStrings(loc)('words.level', { n: 7 }), /7/, loc);
});

test('resolve: auto uses detected preset; explicit preset wins', () => {
  const a = resolve({ preset: 'auto' }, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.shadows, 'off');
  assert.equal(a.post, false);
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.ao, presetTier('high', 'ao'));
  assert.equal(h.post, true);
});

test('resolve: overrides apply, invalid overrides fall back to the preset', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'bogus' }, 'high');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, true);
});

test('resolve: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'low' }).dprCap, 1);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const next = choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'ultra');
  assert.deepEqual(next, { preset: 'ultra', render_scale: 1.5, adaptive: false, show_fps: true });
  for (const cat of Object.keys(CATEGORIES)) assert.equal(next[cat], undefined);
});

test('every preset defines every category with an allowed tier', () => {
  for (const p of PRESETS) for (const [cat, tiers] of Object.entries(CATEGORIES)) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
});

test('describe summarises cost and pixels', () => {
  const s = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /1280×800 px/);
});

test('legacy {tier, renderScale} settings migrate', () => {
  assert.deepEqual(migrateGraphics({ tier: 'medium', renderScale: 0.75 }), { preset: 'balanced', render_scale: 0.75, adaptive: true, show_fps: false });
  assert.equal(migrateSettings({ graphics: { tier: 'auto', renderScale: 1 } }).graphics.preset, 'auto');
});

test('graphics strings exist in every required locale', () => {
  for (const l of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) assert.ok(GFX_LOCALES.includes(l), l);
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('es-ES'), 'es-ES');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  assert.equal(gfxStrings('de-DE')('auto', { tier: 'Hoch' }), 'Automatisch (erkannt: Hoch)');
  const en = gfxStrings('en-US');
  for (const l of GFX_LOCALES) {
    const t = gfxStrings(l);
    for (const cat of Object.keys(CATEGORIES)) assert.notEqual(t(`cats.${cat}`), `cats.${cat}`);
    for (const k of ['quality', 'renderScale', 'adaptive', 'showFps', 'postFailed', 'fromPreset']) assert.ok(t(k) && t(k) !== k);
  }
  assert.equal(en('cats.grade'), 'Color grade');
  assert.equal(gfxStrings('en-GB')('cats.grade'), 'Colour grade');
});
