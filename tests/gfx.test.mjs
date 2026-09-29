import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, describe, choosePreset, migrateGraphics, CATEGORIES, PRESETS } from '../js/gfx.js';
import { pickLocale, gfxStrings, GFX_LOCALES } from '../js/gfx-i18n.js';
import { migrateSettings } from '../js/storage.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // Mobile/touch devices are capped at Balanced.
  assert.equal(detectPreset('Apple M2', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
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
