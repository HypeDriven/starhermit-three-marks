// Localization: assets/strings.json (generated from the browser build's tables:
// flat keys plus group.id keys for stages, chapters, lessons, challenges, themes,
// rulesets and achievements, the nine StarHermit locales) on the engine's
// strings, which follow the interface language the runtime reports (the
// player's choice in Options › Language, else the account's preferred language
// or the device's) and own the locale fallback and the account strings
// (`starhermit.*`). Every string is drawn through T() each frame, so a change
// shows on the next frame while the match keeps running.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** A string of assets/strings.json in the player's language, `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars): string { return strings.t(key, vars); }
/** The engine's account strings (signIn, invite, inviteCopied, inviteFailed, signedOut, leaderboard…). */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
export function locale(): string { return strings.locale; }

/** A content entry by its group.id key. */
const tn = (key: string, fallback: string): string => (strings.has(key) && strings.t(key)) || fallback;
const SCORE_KEYS: Record<string, string> = {
  "Round completed": "scBase", "Objective complete": "scObjective", Stalemate: "scStalemate", "Objective missed": "scMissed",
  "Speed bonus": "scSpeed", "Efficiency bonus": "scEfficiency", "Clean play": "scClean",
};
// The content's names (js/i18n.js).
export const L = {
  stageName: (s: { index: number; name: string }): string => tn(`stages.${s.index}.0`, s.name),
  stageBlurb: (s: { index: number; blurb: string }): string => tn(`stages.${s.index}.1`, s.blurb),
  chapterName: (i: number, fallback: string): string => tn(`chapters.${i}`, fallback),
  lessonText: (l: { id: string }, field: string, fallback: string): string => tn(`lessons.${l.id}.${field}`, fallback),
  lessonStep: (id: string, index: number, fallback: string): string => tn(`lessons.${id}.steps.${index}`, fallback),
  challengeText: (c: { id: string }, i: number, fallback: string): string => tn(`challengeList.${c.id}.${i}`, fallback),
  themeName: (th: { id: string; name: string }): string => tn(`themes.${th.id}`, th.name),
  rulesetName: (name: string): string => tn(`rulesets.${name}`, name),
  achievementText: (a: { key: string; name: string; desc: string }, i: number): string => tn(`achievementsList.${a.key}.${i}`, i ? a.desc : a.name),
  aiName: (id: string): string => ({ casual: T("aiCasual"), skilled: T("aiSkilled"), expert: T("aiExpert") } as Record<string, string>)[id] ?? id,
  /** Built-in fallback names ('Player <id>') are localized at render time. */
  playerName(name: string): string {
    const m = /^Player (\S+)$/.exec(String(name || ""));
    return m ? T("playerN", { id: m[1]! }) : name;
  },
  /** Score-component label (rules.js / session.js emit English data labels). */
  scoreLabel(label: string): string {
    const key = SCORE_KEYS[label];
    if (key) return T(key);
    let m: RegExpExecArray | null;
    if ((m = /^Difficulty x(.+)$/.exec(label))) return T("scDifficulty", { x: m[1]! });
    if ((m = /^Series won \(best of (\d+)\)$/.exec(label))) return T("scSeries", { n: m[1]! });
    return label;
  },
};
