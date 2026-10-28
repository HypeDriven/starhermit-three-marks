// Three Marks on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), the practice AI
// (js/ai.js, its searches on a worker: native/ai.ts), the session
// (js/session.js) and the content (js/content.js) are the browser build's;
// this module is what js/main.js and js/ui.js did around them: navigation
// between the screens (title, modes, Journey, challenges, lessons, practice
// setup, achievements, help, settings, profile, hosted play), the setup,
// pause, results and lesson sheets, starting every mode, placing marks by
// pointer, finger, keys and pads (with the confirm-moves option), undo,
// hints, the camera angle, the session's events (HUD, sounds, toasts,
// announcements), the interrupted-match snapshot, the results with the
// leaderboard post, and the lifecycle (a hidden window pauses the match, as
// visibilitychange did). Screens are drawn by screens.ts (starhermit:ui),
// the slate by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the session's timers
// (countdown, the AI's thinking pause, clocks, round ends) run on a clock
// advanced 1000/60 ms per fixed step, so matches replay exactly; the
// session's "platform time" is the platform clock at start plus that clock.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindings, onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  A, C, GameSession, L, PHASE, R, type AI, type Challenge, type Lesson, type LessonInfo, type MatchOptions, type MatchResult, type Session,
  type Stage, type State, type Theme, type Timers,
} from "./game.ts";
import * as aiWorker from "./ai.ts";
import * as audio from "./audio.ts";
import { S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "modes" | "journey" | "challenges" | "lessons" | "practice" | "achievements" | "help" | "settings" | "profile" | "hosted" | "none";
export type Sheet =
  | { kind: "setup"; spec: () => { title: string; rows: [string, string][]; onStart: () => void } }
  | { kind: "pause"; note: string | null }
  | { kind: "results"; result: MatchResult }
  | { kind: "lesson"; lesson: Lesson; unlocked: string[] }
  | { kind: "reset" };
export type Lb = platform.Posted | "posting" | null;

export const app = {
  screen: "title" as Screen,
  sheet: null as Sheet | null,
  openedFrame: 0,
  focusNext: null as string | null,
  /** Settings / help opened from the pause sheet return to it. */
  returnToPause: false,
  settingsFrom: "title" as Screen,
  playing: false,
  selected: 4,
  showSelection: false,
  pendingConfirm: null as number | null,
  lastMatch: null as MatchOptions | null,
  lastClock: null as { player: number; remainingMs: number } | null,
  lb: null as Lb,
  toasts: [] as { text: string; warn: boolean; until: number }[],
  /** Practice setup (the four selects' indexes). */
  practice: { difficulty: 1, board: 0, series: 0, side: 0 },
};
let clockMs = 0;
let epoch = 0;
export const nowMs = (): number => clockMs;
/** The session's platform time: the platform clock at start plus the fixed-step clock. */
const platformNow = (): number => epoch + clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ the fixed-step timers
interface Timer { id: number; at: number; fn: () => void; every: number }
const timerList: Timer[] = [];
let timerId = 1;
const timers: Timers = {
  setTimeout: (fn, ms) => { const id = timerId++; timerList.push({ id, at: clockMs + Math.max(0, ms), fn, every: 0 }); return id; },
  clearTimeout: (id) => { const i = timerList.findIndex((t) => t.id === id); if (i >= 0) timerList.splice(i, 1); },
  setInterval: (fn, ms) => { const id = timerId++; timerList.push({ id, at: clockMs + ms, fn, every: Math.max(1, ms) }); return id; },
  clearInterval: (id) => { const i = timerList.findIndex((t) => t.id === id); if (i >= 0) timerList.splice(i, 1); },
};
function runTimers(): void {
  for (let guard = 0; guard < 64; guard++) {
    let next: Timer | null = null;
    for (const t of timerList) if (t.at <= clockMs && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
    if (!next) return;
    if (next.every) next.at += next.every;
    else timerList.splice(timerList.indexOf(next), 1);
    next.fn();
  }
}
/** A delayed call on the fixed-step clock (ui.js setTimeout). */
export function after(ms: number, fn: () => void): void { timers.setTimeout(fn, ms); }

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
export function announce(text: string): void { if (text) spoken.push(text); }
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).slice(-3).join(" ").slice(0, 400);
  try { ui.announce(text); } catch { /* busy */ }
}
/** ui.js toast (2.6 s; warnings red-edged, also announced). */
export function toast(text: string, warn = false): void {
  app.toasts.push({ text, warn, until: clockMs + 2600 });
  if (app.toasts.length > 3) app.toasts.shift();
  if (warn) announce(text);
}
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built. */
export function later(fn: () => void): void { pending.push(fn); }
export function click(fn: () => void): () => void { return () => { audio.play("uiTick"); fn(); }; }
export const reducedMotion = (): boolean => preferences().reducedMotion;
export function themeFor(id: string): Theme { return C.themeById(id); }

// ------------------------------------------------------------------ the session
const session: Session = new GameSession({
  platform: { serverNow: platformNow },
  store: platform.sessionStore,
  audio: {
    // session.js's audio hooks (and its reduced-motion test of settings)
    get settings() { return { accessibility: { reducedMotion: reducedMotion() } }; },
    placeImpact: (p: number) => audio.play("placeImpact", p), turnPass: () => audio.play("turnPass"), win: () => audio.play("win"),
    lose: () => audio.play("lose"), draw: () => audio.play("draw"), clockWarning: () => audio.play("clockWarning"),
    achievement: () => audio.play("achievement"), uiBack: () => audio.play("uiBack"),
  },
  timers,
  think: (ai: AI, state: State, player: number, done: (cell: number, rng?: number) => void) => aiWorker.request(ai, state, player, done),
});
export function theSession(): Session { return session; }
let hintAI: AI | null = null;

// ------------------------------------------------------------------ screens and sheets
const FIRST_FOCUS: Partial<Record<Screen, string>> = {
  title: "btn-play", modes: "mode-learn", journey: "btn-back", challenges: "btn-back", lessons: "btn-back", practice: "btn-back",
  achievements: "btn-back", help: "btn-back", settings: "btn-back", profile: "btn-back", hosted: "btn-back",
};
const coarse = (): boolean => frame().width / ui.preferences().scale < 600;
/** ui.js showScreen (focus on the first control unless touch-sized). */
export function show(name: Screen): void {
  if ((name === "settings" || name === "help") && app.screen !== name && !app.returnToPause) {
    app.settingsFrom = ["settings", "help", "none"].includes(app.screen) ? app.settingsFrom : app.screen;
  }
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = coarse() ? null : FIRST_FOCUS[name] ?? null;
  ui.setFocus(null);
  if (name === "title" || name === "modes") session.setPhase(name === "title" ? PHASE.TITLE! : PHASE.MODE_SELECT!, "ui", "navigate");
  audio.play("uiTick");
}
export function openSheet(s: Sheet): void {
  app.sheet = s;
  app.openedFrame = frame().frame;
  app.focusNext = coarse() ? null : "sheet-first";
  ui.setFocus(null);
}
export function closeSheet(): void { app.sheet = null; app.openedFrame = frame().frame; ui.setFocus(null); }

/** ui.js goBack (Escape and ← on every screen). */
export function goBack(): void {
  if (app.returnToPause && (app.screen === "settings" || app.screen === "help")) {
    app.returnToPause = false;
    app.screen = "none";
    app.openedFrame = frame().frame;
    openPause(null);
    return;
  }
  const flow: Partial<Record<Screen, Screen>> = {
    modes: "title", journey: "modes", challenges: "modes", lessons: "modes", practice: "modes", hosted: "modes", achievements: "profile",
    settings: app.settingsFrom || "title", help: app.settingsFrom || "title", profile: "title",
  };
  audio.play("uiBack");
  show(flow[app.screen] ?? "title");
}
export function openMode(mode: string): void {
  if (mode === "hosted") show("hosted");
  else if (mode === "learn") show("lessons");
  else if (mode === "journey") show("journey");
  else if (mode === "challenge") show("challenges");
  else if (mode === "practice") show("practice");
  else if (mode === "daily") startDaily();
}

// ------------------------------------------------------------------ match setup sheets (ui.js)
const fmtTime = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
export { fmtTime };
export function rulesSummary(config: State["config"]): string {
  const parts = [T("rsBoard", { n: config.boardSize }), T("rsLine", { n: config.winLength })];
  if (config.disabledCells.length) parts.push(T(config.disabledCells.length > 1 ? "rsSealedMany" : "rsSealedOne", { n: config.disabledCells.length }));
  if (config.moveLimit) parts.push(T("rsMoveLimit", { n: config.moveLimit }));
  if (config.timeLimitMs) parts.push(T("rsClock", { time: fmtTime(config.timeLimitMs) }));
  if (config.misere) parts.push(T("rsMisere"));
  if (config.startMarks.length) parts.push(T(config.startMarks.length > 1 ? "rsOpeningMany" : "rsOpeningOne", { n: config.startMarks.length }));
  return parts.join(" · ");
}
export function openStageSheet(stage: Stage): void {
  openSheet({ kind: "setup", spec: () => {
    const rec = platform.progress().journey[stage.id];
    return {
      title: T("stageTitle", { n: stage.index, name: L.stageName(stage) }),
      rows: [
        [T("rules"), rulesSummary(stage.config)],
        [T("opponent"), T("opponentValue", { name: stage.opponent.name === "Rival" ? T("rival") : stage.opponent.name, difficulty: L.aiName(stage.opponent.difficulty) })],
        [T("series"), stage.series > 1 ? T("bestOf", { n: stage.series }) : T("singleRound")],
        [T("duration"), stage.par.timeMs >= 240000 ? T("dur5") : T("dur2")],
        [T("ranked"), platform.signedIn() ? T("rankedLb") : T("noProgression")],
        [T("par"), T("parValue", { marks: stage.par.marks, time: fmtTime(stage.par.timeMs) })],
        [T("best"), rec ? T("bestValue", { stars: rec.stars, score: rec.bestScore }) : "—"],
      ],
      onStart: () => startStage(stage),
    };
  } });
}
export function openChallengeSheet(c: Challenge): void {
  openSheet({ kind: "setup", spec: () => ({
    title: L.challengeText(c, 0, c.name),
    rows: [
      [T("goal"), L.challengeText(c, 2, c.goalText)], [T("rules"), rulesSummary(c.config)], [T("opponent"), L.aiName(c.ai)],
      [T("seed"), String(c.seed)], [T("ranked"), platform.signedIn() ? T("rankedLb") : T("no")],
    ],
    onStart: () => startChallenge(c),
  }) });
}
export function startDaily(): void {
  const daily = C.dailyFor(new Date(platform.nowMs()));
  openSheet({ kind: "setup", spec: () => {
    const done = !!platform.progress().dailies[daily.id];
    return {
      title: T("dailyTitle", { name: L.rulesetName(daily.rulesetName) }),
      rows: [
        [T("dateUtc"), daily.date], [T("rules"), rulesSummary(daily.config)], [T("opponent"), L.aiName(daily.ai)], [T("seed"), String(daily.seed)],
        [T("ranked"), platform.options.timingAssist ? T("noTiming") : done ? T("noAlready") : T("yesFair")],
      ],
      onStart: () => {
        const doneNow = !!platform.progress().dailies[daily.id];
        launch({
          mode: "daily", contentId: daily.id, contentName: daily.name, config: daily.config, seed: daily.seed, ai: daily.ai, series: 1,
          theme: daily.theme, par: { marks: 5, timeMs: 90000 }, ranked: !doneNow, assists: { timingAssist: platform.options.timingAssist },
        });
      },
    };
  } });
}
/** The match's content name in the current language (ui.js contentLabel). */
export function contentLabel(m: { mode: string; contentId: string | null; contentName: string } | null): string {
  if (!m) return "";
  if (m.mode === "journey") { const st = C.JOURNEY_STAGES.find((x) => x.id === m.contentId); if (st) return T("stageTitle", { n: st.index, name: L.stageName(st) }); }
  if (m.mode === "challenge") { const c = C.CHALLENGES.find((x) => x.id === m.contentId); if (c) return L.challengeText(c, 0, c.name); }
  if (m.mode === "daily") { const r = /^Daily — (.+)$/.exec(m.contentName || ""); if (r) return T("dailyTitle", { name: L.rulesetName(r[1]!) }); }
  if (m.mode === "learn") { const l = C.LESSONS.find((x) => x.id === m.contentId); if (l) return L.lessonText(l, "name", l.name); }
  if (m.mode === "practice") return T("practice");
  if (m.contentName === "Friendly Round") return T("friendlyRound");
  return m.contentName || "";
}

// ------------------------------------------------------------------ match start (ui.js)
export function startStage(stage: Stage): void {
  launch({
    mode: "journey", contentId: stage.id, contentName: `Stage ${stage.index} — ${stage.name}`, config: stage.config, seed: stage.seed,
    ai: stage.opponent.difficulty, humanPlayer: stage.humanPlayer, series: stage.series, theme: stage.theme, par: stage.par, goals: stage.goals,
    ranked: false, assists: { timingAssist: platform.options.timingAssist },
  });
}
export function startChallenge(c: Challenge): void {
  launch({
    mode: "challenge", contentId: c.id, contentName: c.name, config: c.config, seed: c.seed, ai: c.ai, series: c.series, theme: c.theme,
    par: { marks: 5, timeMs: 120000 }, ranked: false, assists: { timingAssist: platform.options.timingAssist },
  });
}
export const PRACTICE = { difficulty: ["casual", "skilled", "expert"], board: [3, 4, 5], series: [1, 3, 5], side: [1, 2] };
export function startPractice(): void {
  const p = app.practice;
  const size = PRACTICE.board[p.board]!;
  launch({
    mode: "practice", contentId: null, contentName: "Practice", config: { boardSize: size, winLength: size === 3 ? 3 : 4 },
    seed: Math.floor(Math.random() * 1e9) >>> 0, ai: PRACTICE.difficulty[p.difficulty]!, humanPlayer: PRACTICE.side[p.side]!,
    series: PRACTICE.series[p.series]!, theme: platform.options.theme, par: { marks: size + 2, timeMs: 120000 }, ranked: false,
    assists: { timingAssist: platform.options.timingAssist },
  });
}
export function startLesson(lesson: Lesson): void {
  closeSheet();
  session.startLesson(lesson);
  enterPlayfield();
  announce(T("lessonAnnounce", { name: L.lessonText(lesson, "name", lesson.name), intro: L.lessonText(lesson, "intro", lesson.intro) }));
}
function launch(o: MatchOptions): void {
  app.lastMatch = o;
  closeSheet();
  session.startMatch(o);
  hintAI = new A.PracticeAI("expert", (o.seed ^ 0x17) >>> 0);
  enterPlayfield();
}
/** ui.js enterPlayfield: the HUD over the match's slate. */
function enterPlayfield(): void {
  app.screen = "none";
  app.openedFrame = frame().frame;
  app.focusNext = null;
  app.playing = true;
  app.pendingConfirm = null;
  app.showSelection = false;
  app.lastClock = null;
  app.selected = Math.floor((session.state!.config.boardSize ** 2) / 2);
  ui.setFocus(null);
  const m = session.match!;
  const th = themeFor(m.theme || platform.options.theme);
  render.setDisplayPlayer(m.humanPlayer || 1);
  render.buildBoard(session.state!.config, session.state!.seed, th, platform.options.palette);
  render.syncState(session.state!, true);
  render.setSelection(null);
  render.setLessonHighlights(session.lesson ? session.lessonStepInfo().highlightCells : []);
  audio.ambience(th.ambience);
  audio.music(true);
  audio.intensity(0.15);
}
const ATTRACT = { boardSize: 3, winLength: 3, disabledCells: [], startMarks: [], moveLimit: 0, timeLimitMs: 0, firstPlayer: 1, misere: false };
function attractBoard(): void {
  const th = themeFor(platform.options.theme);
  render.buildBoard(R.defaultConfig(ATTRACT), 20240078, th, platform.options.palette);
  render.setLessonHighlights([]);
  render.setSelection(null);
  render.setHover(null);
  audio.ambience(th.ambience);
}
/** ui.js leaveMatch: back to the modes over the calm title slate. */
export function leaveMatch(to: Screen = "modes"): void {
  session.abandonMatch();
  app.playing = false;
  app.pendingConfirm = null;
  closeSheet();
  attractBoard();
  audio.intensity(0);
  show(to);
}
export function retry(result: MatchResult): void {
  // a daily replay is always unranked — match the button's promise
  const o = result.mode === "daily" && app.lastMatch ? { ...app.lastMatch, ranked: false } : app.lastMatch;
  if (o) launch(o);
}
export function resumeSnapshot(): void {
  if (!session.loadLocalSnapshot()) return;
  const m = session.match!;
  app.lastMatch = m.initialOptions ?? null;
  hintAI = new A.PracticeAI("expert", (m.seed ^ 0x17) >>> 0);
  enterPlayfield();
  openPause("matchRestored");
}

// ------------------------------------------------------------------ cells (ui.js tapCell)
export function humanTurn(): boolean {
  const s = session.state;
  return !!s && s.status === "active" && s.currentPlayer === session.match?.humanPlayer;
}
export function legalNow(): number[] {
  const s = session.state;
  return s && humanTurn() ? R.legalCells(s, s.currentPlayer) : [];
}
export function tapCell(cell: number): void {
  const s = session;
  if (s.phase === PHASE.TUTORIAL) {
    const res = s.lessonPlace(cell);
    if (!res.ok && res.reason === "wrong-cell") { toast(T("notThere"), true); audio.play("invalid"); }
    return;
  }
  if (s.phase !== PHASE.ACTIVE || !s.state || s.state.status !== "active") return;
  if (s.state.currentPlayer !== s.match!.humanPlayer) { toast(T("waitTurn"), true); return; }
  if (platform.options.confirmMoves && app.pendingConfirm !== cell) {
    if (!R.legalCells(s.state, s.state.currentPlayer).includes(cell)) { explainIllegal(cell); return; }
    app.pendingConfirm = cell;
    app.selected = cell;
    render.setSelection(cell);
    const n = s.state.config.boardSize;
    announce(T("selectedCell", { r: Math.floor(cell / n) + 1, c: (cell % n) + 1 }));
    return;
  }
  app.pendingConfirm = null;
  const res = s.placeCell(cell);
  if (!res.ok) explainIllegal(cell, res.reason);
}
function explainIllegal(cell: number, reason?: string): void {
  const s = session.state!;
  const n = s.config.boardSize;
  const at = T("cellAt", { r: Math.floor(cell / n) + 1, c: (cell % n) + 1 });
  let msg: string;
  if (reason === "cell-occupied" || s.board[cell] !== 0) msg = T("occupied", { at });
  else if (s.config.disabledCells.includes(cell)) msg = T("sealedCell", { at });
  else if (reason === "game-over") msg = T("roundOverMsg");
  else msg = T("notLegal");
  toast(msg, true);
  audio.play("invalid");
  vibrate(40);
}
function moveSelection(dx: number, dy: number): void {
  const s = session.state;
  if (!s) return;
  const n = s.config.boardSize;
  let r = Math.floor(app.selected / n), c = app.selected % n;
  r = (r + dy + n) % n;
  c = (c + dx + n) % n;
  app.selected = r * n + c;
  app.showSelection = true;
  render.setSelection(app.selected);
  audio.play("focus");
}

// ------------------------------------------------------------------ actions
export function pauseGame(): void {
  if (!session.pause("user")) return;
  openPause(null);
}
export function openPause(note: string | null): void {
  openSheet({ kind: "pause", note });
  announce(T("gamePaused"));
}
export function resume(): void { closeSheet(); session.resume(); }
export function pauseTo(screen: "settings" | "help"): void {
  closeSheet();
  app.returnToPause = true;
  show(screen);
}
export function canHint(): boolean {
  const s = session;
  return s.phase === PHASE.ACTIVE && !!s.match && ["practice", "learn", "journey"].includes(s.match.mode) && humanTurn();
}
export function doUndo(): void {
  const res = session.undo();
  if (!res.ok) toast(T("undoUnavailable"), true);
}
let hintBusy = false;
let hintToken = 0;
export function doHint(): void {
  const s = session;
  if (!s.state || s.phase !== PHASE.ACTIVE || !hintAI || hintBusy) return;
  if (!["practice", "learn", "journey"].includes(s.match!.mode)) return;
  const ai = hintAI, state = s.state, token = ++hintToken;
  hintBusy = true;
  aiWorker.request(ai, state, s.match!.humanPlayer, (cell, rng) => {
    hintBusy = false;
    if (token !== hintToken || s.state !== state) return;
    ai.rng.state = rng >>> 0;
    if (cell < 0) return;
    s.match!.assists.hintUsed = true;
    render.setLessonHighlights([cell]);
    after(1800, () => render.setLessonHighlights(session.lesson ? session.lessonStepInfo().highlightCells : []));
    const n = state.config.boardSize;
    toast(T("hintToast", { r: Math.floor(cell / n) + 1, c: (cell % n) + 1 }));
    announce(T("hintAnnounce", { r: Math.floor(cell / n) + 1, c: (cell % n) + 1 }));
    audio.play("focus");
  });
}
export const CAMERA_KEYS: Record<string, string> = { standard: "camStandard", top: "camTop", low: "camLow" };
export function cycleCamera(): void {
  const order: platform.CameraAngle[] = ["standard", "top", "low"];
  const next = order[(order.indexOf(platform.options.camera) + 1) % order.length]!;
  platform.setOption("camera", next);
  toast(T("cameraToast", { angle: T(CAMERA_KEYS[next]!) }));
}
export function resetProgress(): void {
  const cur = platform.sessionStore.loadProgression();
  platform.sessionStore.saveProgression({
    ...cur, journey: {}, lessons: {}, challenges: {}, dailies: {}, achievements: {},
    stats: { roundsPlayed: 0, roundsWon: 0, roundsDrawn: 0, byMode: {}, totalScore: 0 },
  });
  toast(T("progressReset"));
}

// ------------------------------------------------------------------ session events (ui.js _wireSession)
session.on("state", (state: State) => {
  if (!app.playing) return;
  render.syncState(state);
  if (state.status === "active") {
    const filled = state.board.filter((v) => v !== 0).length / state.board.length;
    audio.intensity(0.15 + filled * 0.5);
  }
});
session.on("move", ({ cmd }: { cmd: { player: number; cell: number } }) => {
  const n = session.state!.config.boardSize;
  if (cmd.player !== session.match?.humanPlayer) announce(T("rivalPlaced", { r: Math.floor(cmd.cell / n) + 1, c: (cmd.cell % n) + 1 }));
  render.setHover(null);
});
session.on("round-start", () => {
  app.pendingConfirm = null;
  app.lastClock = null;
  if (app.playing && session.state) {
    render.buildBoard(session.state.config, session.state.seed, themeFor(session.match!.theme), platform.options.palette, false);
    render.syncState(session.state, true);
    if (app.showSelection) render.setSelection(app.selected);
  }
  announce(T("roundBegins", { n: session.match!.roundIndex }));
});
session.on("round-end", (r: { draw: boolean; humanWon: boolean }) => {
  announce(T(r.draw ? "roundDrawn" : r.humanWon ? "youTakeRound" : "rivalTakesRound"));
  audio.intensity(0.4);
});
session.on("match-end", (result: MatchResult) => {
  session.discardLocalSnapshot();
  after(reducedMotion() ? 100 : 700, () => openResults(result));
});
session.on("clock", (c: { player: number; remainingMs: number }) => { app.lastClock = c; });
session.on("lesson-step", (info: LessonInfo) => {
  render.setLessonHighlights(info.highlightCells);
  announce(lessonStepText(info));
});
session.on("lesson-failed-step", ({ text }: { text: string }) => {
  const map: Record<string, string> = {
    "That did not meet the goal. The step resets — try again.": T("lessonFailedGoal"),
    "The rival got there first. The step resets — try again.": T("lessonFailedRival"),
  };
  toast(map[text] ?? text, true);
});
session.on("lesson-complete", ({ lesson, achievementsUnlocked }: { lesson: Lesson; achievementsUnlocked: string[] }) => {
  openSheet({ kind: "lesson", lesson, unlocked: achievementsUnlocked });
  announce(T("lessonCompleteAnnounce", { name: L.lessonText(lesson, "name", lesson.name) }));
});
session.on("undo", () => { announce(T("undoneTurn")); render.skipAnimations(); });
session.on("phase", ({ phase }: { phase: string }) => { if (phase === PHASE.COUNTDOWN) render.skipAnimations(); });
export function lessonStepText(info: LessonInfo): string {
  const steps = L.lessonText({ id: session.lesson?.def.id }, "steps", null) as unknown as string[] | null;
  return steps?.[info.stepIndex] || info.step.text;
}
function openResults(result: MatchResult): void {
  const won = result.outcome === "win";
  const headline = won ? "victory" : result.outcome === "draw" ? "honestDraw" : "defeat";
  app.lb = null;
  // signed in: unassisted Journey, Daily and Challenge matches post their total to the high-score board
  if (platform.signedIn() && ["journey", "daily", "challenge"].includes(result.mode) && !result.assistsUsed) {
    app.lb = "posting";
    void platform.postScore(result.breakdown.total).then((r) => { app.lb = r; });
  }
  openSheet({ kind: "results", result });
  announce(T("resultsAnnounce", { headline: T(headline), total: result.breakdown.total }));
  audio.intensity(0.1);
}
export function lbLine(): string | null {
  const lb = app.lb;
  if (!lb) return null;
  if (lb === "posting") return S("lbPosting");
  return !lb.posted ? S("lbNotPosted") : lb.rank ? S("lbRank", { rank: lb.rank }) : S("lbPosted");
}

// ------------------------------------------------------------------ keys and pads (ui.js _onKey, _pollGamepad)
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→" };
/** The effective keyboard bindings of an action (the runtime's rebinding), for Help. */
export function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join(" / ") || "—";
}
const NAV: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export function inPlay(): boolean { return app.playing && app.screen === "none" && !app.sheet; }
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  if (app.sheet) {
    if (e.action === "cancel" && fresh() && (app.sheet.kind === "pause" || app.sheet.kind === "setup" || app.sheet.kind === "reset")) {
      later(() => { if (app.sheet?.kind === "pause") resume(); else closeSheet(); });
    }
    return;
  }
  if (!inPlay()) {
    if (e.action === "cancel" && app.screen !== "title" && fresh()) later(goBack);
    return;
  }
  const nav = NAV[e.action];
  if (nav) { ui.setFocus(null); later(() => moveSelection(nav[0], nav[1])); return; }
  switch (e.action) {
    case "confirm": if (ui.focused() == null) later(() => { app.showSelection = true; render.setSelection(app.selected); tapCell(app.selected); }); break;
    case "cancel": case "pause": later(pauseGame); break;
    case "undo": later(doUndo); break;
    case "hint": later(doHint); break;
    case "camera": later(cycleCamera); break;
  }
});

// ------------------------------------------------------------------ pointer and touch on the slate (render.js pointer events)
interface Press { x: number; y: number; id: number; moved: boolean }
let press: Press | null = null;
const taps: { x: number; y: number }[] = [];
let lastTouch = -1e9;
let hoverAt: { x: number; y: number } | null = null;
onTouch((e) => {
  lastTouch = clockMs;
  if (e.control || !e.primary) return;
  if (e.phase === "start") { press = ui.pointerCaptured() ? null : { x: e.x, y: e.y, id: e.id, moved: false }; hoverAt = null; return; }
  if (!press || press.id !== e.id) return;
  if (e.phase === "move") dragTo(e.x, e.y);
  else if (e.phase === "end") { if (!press.moved) taps.push({ x: e.x, y: e.y }); endPress(); }
  else endPress();
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  if (e.pressed) { press = ui.pointerCaptured() ? null : { x: e.x, y: e.y, id: -1, moved: false }; return; }
  if (press && press.id === -1) { if (!press.moved) taps.push({ x: e.x, y: e.y }); endPress(); }
});
onPointerMove((x, y) => {
  if (clockMs - lastTouch < 600) return;
  hoverAt = { x, y };
  if (press && press.id === -1) dragTo(x, y);
});
function dragTo(x: number, y: number): void {
  if (!press) return;
  const sc = ui.preferences().scale;
  const dx = (x - press.x) / sc, dy = (y - press.y) / sc;
  // tap vs camera gesture by distance; a drag tilts the camera a little (parallax)
  if (Math.hypot(dx, dy) > 10) press.moved = true;
  if (press.moved) render.setParallax(dx, dy);
}
function endPress(): void { press = null; render.setParallax(0, 0); }
function pointerInput(wasPlaying: boolean): void {
  const list = taps.splice(0);
  if (!wasPlaying || !inPlay()) { if (!inPlay()) render.setHover(null); return; }
  for (const t of list) {
    const cell = render.pickCell(t.x, t.y);
    if (cell != null) { ui.setFocus(null); tapCell(cell); }
  }
  // the ghost preview under a mouse pointer (render.js onCellHover)
  const s = session;
  const cell = hoverAt && !ui.pointerOver() ? render.pickCell(hoverAt.x, hoverAt.y) : null;
  if (cell == null || !s.state || s.phase !== PHASE.ACTIVE || !humanTurn()) render.setHover(null);
  else render.setHover(cell, R.legalCells(s.state, s.state.currentPlayer).includes(cell));
}

// ------------------------------------------------------------------ account
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("copied")); } catch { toast(S("copyFail", { url: link })); }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
  runTimers();
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
let optionKey = "";
function applyOptions(): void {
  const o = platform.options;
  const k = `${o.theme}|${o.palette}|${o.camera}`;
  if (k === optionKey) return;
  optionKey = k;
  render.setCameraAngle(o.camera);
  const th = app.playing && session.match ? themeFor(session.match.theme) : themeFor(o.theme);
  if (render.hasBoard()) render.setTheme(th, o.palette);
  if (!app.playing) audio.ambience(th.ambience);
}
onStart(() => {
  setFixedRate(60);
  epoch = platform.nowMs();
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  aiWorker.warm();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  render.setActive(true);
  render.setCameraAngle(platform.options.camera);
  attractBoard();
  applyOptions();
  const problems = C.validateContent();
  if (problems.length) console.error(`Content validation failed: ${problems.join("; ")}`);
  show("title");
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(applyOptions);
platform.onProgressMerged(() => toast(T("progressMerged")));
onSessionEnded(() => toast(S("signedOut")));
onSuspend(() => {
  hidden = true;
  // backgrounding pauses the match; the player resumes deliberately
  if (session.isPausable() && !app.sheet && session.pause("hidden")) openPause("pausedHidden");
  session.saveLocalSnapshot();
  platform.flush();
});
onResume(() => { hidden = false; });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  audio.update();
  app.toasts = app.toasts.filter((t) => t.until > clockMs);
});
onRender(() => {
  const wasPlaying = inPlay();
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  const f = frame();
  render.frame(frameDt, f.width, f.height);
  flushAnnouncements();
});
