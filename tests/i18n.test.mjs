// i18n.test.mjs — every string key used in js/*.js exists in all nine
// locales with the same {placeholders} as US English, and every content
// entry (stages, chapters, lessons and steps, challenges, daily rulesets,
// themes, achievements) is translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LESSONS, JOURNEY_STAGES, CHAPTERS, CHALLENGES, THEMES } from '../js/content.js';
import { ACHIEVEMENTS } from '../js/storage.js';

const STRINGS = JSON.parse(readFileSync(new URL('../assets/strings.json', import.meta.url), 'utf8'));
const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const read = (dir, ext) => readdirSync(new URL(dir, import.meta.url)).filter((f) => f.endsWith(ext) && f !== 'strings.js')
  .map((f) => readFileSync(new URL(dir + f, import.meta.url), 'utf8')).join('\n');
// the engine client (native/*.ts) draws the strings through T("key")
const code = read('../js/', '.js') + '\n' + read('../native/', '.ts').replace(/"/g, "'");
const used = new Set();
for (const m of code.matchAll(/\b(?:t|T)\('([A-Za-z0-9]+)'(?!\s*\+)/g)) used.add(m[1]);
// Keys passed through tables / helpers.
for (const m of code.matchAll(/'((?:bind|mode|dur|players|cam|ai|sync|sc|rec|rs|rule)[A-Z][A-Za-z0-9]*)'/g)) used.add(m[1]);
for (const m of code.matchAll(/(?:_screenHeader|_ruleCard|openPauseModal)\('([A-Za-z0-9]+)'(?:, '([A-Za-z0-9]+)')?/g)) { used.add(m[1]); if (m[2]) used.add(m[2]); }
for (const k of ['ruleGoalText', 'ruleTurnsText', 'ruleDrawText', 'ruleVariantsText', 'yes', 'no', 'friendsHosted', 'friendsOffline',
  'matchRestored', 'pausedHidden', 'victory', 'honestDraw', 'defeat', 'lesson', 'match']) used.add(k);
for (const m of code.matchAll(/HEADERS[^;]*/g)) for (const k of m[0].matchAll(/'([A-Za-z]+)'/g)) used.add(k[1]);
for (const m of code.matchAll(/MODE_META[^;]*/g)) for (const k of m[0].matchAll(/'([A-Za-z]+[A-Z][A-Za-z]*)'/g)) used.add(k[1]);
for (const k of ['optionsH', 'optionsNote', 'openOptions', 'bindCameraReset', 'leftHanded', 'confirmMoves', 'timingAssist', 'ruleGoal', 'ruleTurns', 'ruleDraw', 'ruleVariants', 'diffCasualOpt', 'diffSkilledOpt', 'diffExpertOpt', 'board3', 'board4', 'board5', 'seriesSingle', 'seriesBo3', 'seriesBo5', 'sideX', 'sideO', 'difficulty', 'board', 'series', 'side']) used.add(k);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('ships the nine locales', () => assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort()));
test('found the keys in code', () => assert.ok(used.size > 200, String(used.size)));
for (const loc of LOCALES) {
  test(`${loc}: every used key, matching placeholders`, () => {
    const L = STRINGS[loc];
    assert.deepEqual([...used].filter((k) => typeof L[k] !== 'string'), []);
    for (const k of used) assert.equal(vars(L[k]), vars(STRINGS['en-US'][k]), `${loc}.${k}`);
  });
  test(`${loc}: every content entry`, () => {
    const L = STRINGS[loc];
    for (const st of JOURNEY_STAGES) assert.ok(L[`stages.${st.index}.0`] && L[`stages.${st.index}.1`], `stage ${st.index}`);
    CHAPTERS.forEach((c, i) => assert.ok(L[`chapters.${i}`], `chapter ${i}`));
    for (const l of LESSONS) {
      assert.ok(L[`lessons.${l.id}.name`] && L[`lessons.${l.id}.intro`], `lesson ${l.id}`);
      l.steps.forEach((_, i) => assert.ok(L[`lessons.${l.id}.steps.${i}`], `lesson steps ${l.id}`));
    }
    for (const c of CHALLENGES) for (const i of [0, 1, 2]) assert.ok(L[`challengeList.${c.id}.${i}`], `challenge ${c.id}`);
    for (const th of THEMES) assert.ok(L[`themes.${th.id}`], `theme ${th.id}`);
    for (const r of ['Classic', 'Wide Lines', 'Blitz', 'Misère', 'Hollow']) assert.ok(L[`rulesets.${r}`], `ruleset ${r}`);
    for (const a of ACHIEVEMENTS) for (const i of [0, 1]) assert.ok(L[`achievementsList.${a.key}.${i}`], `achievement ${a.key}`);
  });
}
test('English content strings match the authored data', () => {
  const en = STRINGS['en-US'];
  for (const st of JOURNEY_STAGES) assert.deepEqual([en[`stages.${st.index}.0`], en[`stages.${st.index}.1`]], [st.name, st.blurb]);
  for (const l of LESSONS) l.steps.forEach((step, i) => assert.equal(en[`lessons.${l.id}.steps.${i}`], step.text));
  for (const c of CHALLENGES) assert.deepEqual([0, 1, 2].map((i) => en[`challengeList.${c.id}.${i}`]), [c.name, c.blurb, c.goalText]);
  for (const a of ACHIEVEMENTS) assert.deepEqual([0, 1].map((i) => en[`achievementsList.${a.key}.${i}`]), [a.name, a.desc]);
});
test('non-English locales are translated', () => {
  for (const loc of LOCALES.filter((l) => !l.startsWith('en'))) {
    const same = [...used].filter((k) => STRINGS[loc][k] === STRINGS['en-US'][k] && !/^(~|—|\d)/.test(STRINGS['en-US'][k]));
    assert.ok(same.length < 16, `${loc}: ${same.join(', ')}`); // cognates such as Pause, Audio, Standard, Par
  }
});
