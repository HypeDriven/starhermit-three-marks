import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContent, JOURNEY_STAGES, LESSONS, CHALLENGES, dailyFor, THEMES } from '../js/content.js';

test('all content passes offline validation (legality, reachability, bounded duration)', () => {
  const problems = validateContent();
  assert.deepEqual(problems, []);
});

test('launch scope: 40 journey stages, 5 lessons, challenges, 5 themes', () => {
  assert.equal(JOURNEY_STAGES.length, 40);
  assert.ok(LESSONS.length >= 5);
  assert.ok(CHALLENGES.length >= 5);
  assert.equal(THEMES.length, 5);
  assert.equal(JOURNEY_STAGES.filter((s) => s.mastery).length, 5);
});

test('daily ruleset is stable per UTC day and rotates', () => {
  const a = dailyFor(new Date(Date.UTC(2026, 0, 15)));
  const b = dailyFor(new Date(Date.UTC(2026, 0, 15, 23, 59)));
  const c = dailyFor(new Date(Date.UTC(2026, 0, 16)));
  assert.equal(a.id, b.id);
  assert.equal(a.seed, b.seed);
  assert.notEqual(a.id, c.id);
  const names = new Set();
  for (let d = 0; d < 10; d++) names.add(dailyFor(new Date(Date.UTC(2026, 0, 1 + d))).rulesetName);
  assert.equal(names.size, 5);
});
