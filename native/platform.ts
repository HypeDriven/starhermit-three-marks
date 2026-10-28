// The game's data and the StarHermit platform on the runtime's modules (what
// js/platform.js and js/storage.js's Store did over the JS SDK and
// localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is the sealed progression document of js/storage.js
//   (journey stars and bests, lessons, challenges, dailies, achievements,
//   stats, generation, checksum); two devices' saves merge on a conflict
//   (mergeProgression, as the browser build merged on its saveconflict); the
//   slot the browser build wrote through the JS SDK (game:<slug>, the same
//   document as JSON) shows as foreign: it is merged in and replaced once;
// - the interrupted-match snapshot ("Resume interrupted match") stays on the
//   device (starhermit:storage `storage`), as it stayed in localStorage;
// - the game's own options (theme, camera angle, colour palette, left-handed
//   rails, confirm moves, timing assist) are engine `settings` (synced with
//   the account); the browser build's values in the account's settings KV
//   (platform.js PREF_KEYS: theme, camera, accessibility, …) are adopted
//   (unless set here since), then all its KV keys are removed (volumes,
//   graphics, language, reduced motion, contrast, larger text, haptics and
//   key bindings are the runtime's Options);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   finished match's total through score-script.js (a practice session whose
//   socket carries { type: 'result', scores }, as the JS SDK's submitScores
//   did) with the rank.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { St, type Progression, type StoreLike } from "./game.ts";
import { seal } from "../js/storage.js";
import * as optionsJs from "../js/options.js";

const sealDoc = seal as (d: Progression) => Progression;

// --- the save --------------------------------------------------------------------------------
let data: Progression = St.defaultProgression();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(data as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
function read(raw: unknown): Progression | null {
  if (!raw || typeof raw !== "object") return null;
  return St.migrateProgression(raw);
}
/** Merges another document in; true when it added progress. */
function adopt(other: Progression | null): boolean {
  if (!other) return false;
  const next = St.mergeProgression(other, data);
  if (St.sameProgress(next, data)) return false;
  data = sealDoc({ ...next, generation: Math.max(next.generation || 0, data.generation || 0) + 1, updatedAt: Date.now() });
  return true;
}
saves.onConflict((mine, remote) => ({
  merged: sealDoc(St.mergeProgression(read(remote.data), read(mine?.data ?? null))) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(read(cur.data))) { write(); merged(); }
  }
});
/** The browser build's cloud progress: merged with this device's save, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let doc: Progression | null = null;
  try { doc = old.text != null ? read(JSON.parse(old.text)) : null; } catch { doc = null; }
  const grew = adopt(doc);
  write({ replaceForeign: true });
  if (grew) merged();
}
/** The session's store (js/storage.js Store's progression and snapshot API). */
export const sessionStore: StoreLike = {
  loadProgression: () => St.migrateProgression(clone(data)),
  saveProgression: (prog) => {
    data = sealDoc({ ...St.migrateProgression(clone(prog)), version: 1, updatedAt: Date.now(), generation: (prog.generation || 0) + 1 });
    write();
    return clone(data);
  },
  saveSnapshot: (name, snap) => { try { storage.setJson(`snapshot.${name}`, clone(snap) as JsonValue); } catch (e) { console.warn(`snapshot: ${String(e)}`); } return snap; },
  loadSnapshot: (name) => { try { return storage.getJson(`snapshot.${name}`); } catch { return null; } },
  clearSnapshot: (name) => { try { storage.remove(`snapshot.${name}`); } catch { /* none */ } },
};
/** The live progression (read only). */
export function progress(): Progression { return data; }
/** The cloud line (ui.js updateSyncStatus): saving / synced / offline / local. */
export function syncState(): "saving" | "synced" | "offline" | "local" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options -----------------------------------------------------------------------
export type Palette = "default" | "deuteranopia" | "tritanopia";
export type CameraAngle = "standard" | "top" | "low";
export interface Options {
  theme: string; camera: CameraAngle; palette: Palette; leftHanded: boolean; confirmMoves: boolean; timingAssist: boolean;
}
const OPT = optionsJs as unknown as {
  DEFAULT_OPTIONS: Options; pickOptions(raw: Record<string, unknown>): Partial<Options>; legacyOptions(kv: Record<string, unknown>): Partial<Options>;
};
export const DEFAULT_OPTIONS = OPT.DEFAULT_OPTIONS;
const pickOptions = OPT.pickOptions, legacyOptions = OPT.legacyOptions;
const KEYS = Object.keys(DEFAULT_OPTIONS) as (keyof Options)[];
export const options: Options = { ...DEFAULT_OPTIONS };
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: keyof Options): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const kv: Record<string, unknown> = {};
  for (const k of keys) kv[k] = store.legacy(k);
  let changed = false;
  for (const [k, v] of Object.entries(legacyOptions(kv))) {
    try {
      if (store.get(k) !== undefined) continue;
      store.set(k, v as JsonValue);
      (options as unknown as Record<string, unknown>)[k] = v;
      changed = true;
    } catch { /* keep the device's */ }
  }
  for (const k of keys) store.removeLegacy(k);
  if (changed) optionsChanged();
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  data = read(cur?.data ?? null) ?? St.defaultProgression();
  for (const k of KEYS) readOption(k);
  store.onChange((k) => {
    if (!(KEYS as string[]).includes(k)) return;
    readOption(k as keyof Options);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });
/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the high-score board ---------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a finished match's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
