// i18n.js — Three Marks localization runtime.
// The language comes from sh-language.js (window.StarHermitLanguage): explicit
// game choice (ui.language) → StarHermit account preferredLanguage → device
// languages → en-US. Build-once markup uses live text nodes / attributes
// (tx, txf, lv) that relabel() rewrites in place on a language change; code
// that rebuilds its content calls t() and re-runs from onLanguage listeners.

import { STRINGS } from './strings.js';

export const SUPPORTED = Object.keys(STRINGS);
let lang = 'en-US';
let dict = STRINGS[lang];
const listeners = new Set();

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

// ---- live text: nodes/attributes that follow the language ----
const live = new Set();
/** A text node that re-renders on a language change. */
export function txf(fn) {
  const node = document.createTextNode(fn());
  live.add({ node, fn });
  return node;
}
export function tx(key, vars) { return txf(() => t(key, vars)); }
/** Attribute value marker for el(): { live: fn } re-renders on a language change. */
export function lv(key, vars) { return { live: () => t(key, vars) }; }
export function bindAttr(node, name, fn) {
  node.setAttribute(name, fn());
  live.add({ node, attr: name, fn });
}
function relabelLive() {
  for (const e of live) {
    // Nodes that were on the page and are now gone (lists rebuilt) are dropped.
    if (!e.node.isConnected && e.seen) { live.delete(e); continue; }
    if (e.node.isConnected) e.seen = true;
    if (e.attr) e.node.setAttribute(e.attr, e.fn()); else e.node.textContent = e.fn();
  }
}

/** fn(locale) runs after every language change (after live text is relabelled). */
export function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function setLocale(next) {
  lang = STRINGS[next] ? next : 'en-US';
  dict = STRINGS[lang];
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    relabelLive();
  }
  for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
}

const SL = typeof window !== 'undefined' ? window.StarHermitLanguage : null;
export const language = SL ? SL.create({ game: 'three-marks', supported: SUPPORTED, apply: setLocale }) : null;

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
