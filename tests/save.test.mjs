// The save on the runtime: the browser build's cloud document (a sealed
// progression, game:<slug>) reads and merges into this device's; the
// browser build's settings KV maps onto the game's options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProgression, migrateProgression, mergeProgression, sameProgress, seal, unseal } from '../js/storage.js';
import { legacyOptions, pickOptions, DEFAULT_OPTIONS } from '../js/options.js';

test('a sealed browser-build document merges in and keeps its checksum valid', () => {
  const old = seal({ ...defaultProgression(), journey: { 'stage-01': { stars: 2, bestScore: 1400, completedAt: 5 } }, achievements: { first_line: { unlockedAt: 5 } }, generation: 7 });
  const text = JSON.stringify(old);
  assert.ok(unseal(JSON.parse(text)));
  const mine = { ...defaultProgression(), journey: { 'stage-02': { stars: 1, bestScore: 900, completedAt: 9 } }, generation: 2 };
  const merged = mergeProgression(migrateProgression(JSON.parse(text)), mine);
  assert.equal(merged.journey['stage-01'].stars, 2);
  assert.equal(merged.journey['stage-02'].stars, 1);
  assert.ok(merged.achievements.first_line);
  assert.equal(merged.generation, 7);
  assert.ok(!sameProgress(merged, mine));
  assert.ok(unseal(seal(merged)));
});
test('legacy settings KV → options', () => {
  assert.deepEqual(legacyOptions({ theme: 'neon', camera: { angle: 'top' }, accessibility: { palette: 'tritanopia', leftHanded: true, confirmMoves: true, timingAssist: false, reducedMotion: true }, audio: { music: 1 } }),
    { theme: 'neon', camera: 'top', palette: 'tritanopia', leftHanded: true, confirmMoves: true, timingAssist: false });
  assert.deepEqual(legacyOptions({ theme: 'moon', camera: 'x' }), {});
  assert.deepEqual(pickOptions(DEFAULT_OPTIONS), DEFAULT_OPTIONS);
});
