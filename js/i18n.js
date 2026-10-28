// i18n.js — Three Marks localization runtime.
// Pure (no DOM): the engine client (native/i18n.ts) sets the language from the
// runtime's interface language (Options › Language, else the account's
// preferred language, else the device's), mapped to the nearest shipped
// locale; every string is drawn through t() each frame.

import { STRINGS } from './strings.js';
import { shLocale } from './sh-i18n.js';

export const SUPPORTED = Object.keys(STRINGS);
let lang = 'en-US';
let dict = STRINGS[lang];

export function locale() { return lang; }

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s);

/** Localized string for key with {placeholders} filled from vars. */
export function t(key, vars) {
  return fill((dict && dict[key]) ?? STRINGS['en-US'][key] ?? key, vars);
}

/** Localized content entry from a nested group (stages, lessons, challenges, …). */
export function tn(group, id, fallback) {
  const own = dict && dict[group] && dict[group][id];
  if (own != null) return own;
  const en = STRINGS['en-US'][group] && STRINGS['en-US'][group][id];
  return en != null ? en : fallback;
}

/** Sets the language from a BCP 47 tag (nearest shipped locale); returns the locale. */
export function setLocale(tag) {
  const next = shLocale(tag);
  lang = STRINGS[next] ? next : 'en-US';
  dict = STRINGS[lang];
  return lang;
}

// ---- content names ----
export function stageName(stage) { return (tn('stages', stage.index) || [stage.name])[0]; }
export function stageBlurb(stage) { return (tn('stages', stage.index) || [, stage.blurb])[1]; }
export function chapterName(i, fallback) { return (tn('chapters', i) ?? fallback); }
export function lessonText(lesson, field, fallback) { const l = tn('lessons', lesson.id); return (l && l[field]) || fallback; }
export function lessonStep(lessonId, index, fallback) { const l = tn('lessons', lessonId); return (l && l.steps[index]) || fallback; }
export function challengeText(c, i, fallback) { const e = tn('challengeList', c.id); return (e && e[i]) || fallback; }
export function themeName(theme) { return tn('themes', theme.id, theme.name); }
export function rulesetName(name) { return tn('rulesets', name, name); }
export function achievementText(a, i) { const e = tn('achievementsList', a.key); return (e && e[i]) || (i ? a.desc : a.name); }
export function aiName(id) { return { casual: t('aiCasual'), skilled: t('aiSkilled'), expert: t('aiExpert') }[id] || id; }
/** Built-in fallback names ('Player <id>') are localized at render time. */
export function playerName(name) {
  const m = /^Player (\S+)$/.exec(String(name || ''));
  return m ? t('playerN', { id: m[1] }) : name;
}
const SCORE_KEYS = {
  'Round completed': 'scBase', 'Objective complete': 'scObjective', Stalemate: 'scStalemate', 'Objective missed': 'scMissed',
  'Speed bonus': 'scSpeed', 'Efficiency bonus': 'scEfficiency', 'Clean play': 'scClean',
};
/** Score-component label (rules.js / session.js emit English data labels). */
export function scoreLabel(label) {
  if (SCORE_KEYS[label]) return t(SCORE_KEYS[label]);
  let m;
  if ((m = /^Difficulty x(.+)$/.exec(label))) return t('scDifficulty', { x: m[1] });
  if ((m = /^Series won \(best of (\d+)\)$/.exec(label))) return t('scSeries', { n: m[1] });
  return label;
}
