// The browser build's DOM shell (js/ui.js + css/style.css) as starhermit:ui,
// built every frame over the slate: the HUD (the top row with the
// objective, turn banner, clocks, Pause, the player's name and the cloud
// line; the match rail left and the actions rail — Undo, Hint, Camera —
// right, swapped for left-handed play; below 1024 logical px the match rail
// hides and the actions sit in a bottom bar; portrait phones put the
// objective on its own row), the board mirror (a named target per cell for
// screen readers and play scripts), every screen (title with its cards,
// modes, Journey, challenges, lessons, practice setup, achievements, help,
// settings, profile, hosted play) in a scrolling column with the header's
// back and settings buttons, the sheets (match setup, pause, results,
// lesson complete, reset confirmation) as dialogs, and the toasts. The old
// media queries are layouts picked by the window's logical size.
import { frame, openMenu } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { C, L, PHASE, St, type Challenge, type Lesson, type MatchResult, type Stage } from "./game.ts";
import { S, T, locale } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  CAMERA_KEYS, PRACTICE, app, canHint, click, closeSheet, contentLabel, cycleCamera, doHint, doUndo, fmtTime, fresh, goBack, humanTurn, inPlay,
  invite, keysFor, later, lbLine, leaveMatch, legalNow, lessonStepText, openChallengeSheet, openMode, openSheet, openStageSheet, pauseGame,
  pauseTo, resetProgress, resume, resumeSnapshot, retry, rulesSummary, show, signIn, startDaily, startLesson, startPractice, theSession,
} from "./main.ts";

// ------------------------------------------------------------------ layout helpers
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; portrait: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, ox: sa.left, oy: sa.top, wide: lw >= 1024, portrait: lw <= 700 && lh >= lw, short: lh <= 480 && lw > lh };
}
function tw(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** One label when it fits, else a wrapped paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (tw(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
function ellipsize(text: string, cls: string, width: number): string {
  if (tw(text, cls) <= width) return text;
  let s = text;
  while (s.length > 1 && tw(s + "…", cls) > width) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; width?: number; height?: number;
  /** Card buttons: a bold first line and muted / accent lines under it. */
  lines?: { text: string; cls: string }[];
}
const padX: Record<string, number> = { "primary-btn": 64, "play-btn": 108.8, "ghost-btn": 38.4, "danger-btn": 38.4, "small-btn": 25.6, "action-btn": 24, "icon-btn": 0, "back-btn": 0 };
function btnWidth(b: Btn): number { return Math.max(44, tw(b.text, b.style ?? "ghost-btn", "button") + 2); }
function button(b: Btn): void {
  const style = b.style ?? "ghost-btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const inner = (b.width ?? btnWidth(b)) - (padX[style] ?? 40) - 4;
  const ink = style === "primary-btn" || style === "play-btn";
  if (b.lines) {
    const lines = b.lines;
    opts.content = () => { for (const l of lines) para(l.text, inner, l.cls); };
  } else if (b.width != null && btnWidth(b) > b.width) {
    opts.content = () => { ui.style(ink ? "wrap-ink" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.style(ink ? "wrap-ink" : "btn-label").label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  const name = b.name ?? (b.lines ? b.lines.map((l) => l.text).join(". ") : b.text);
  if (ui.style(style, s).id(b.id).button(name, opts) && fresh()) later(click(b.act));
}
/** Buttons at their own widths in rows wrapping at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 11.2, justify: "start" | "center" = "start"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? btnWidth(b));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button({ ...b, width: bw(b) }); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
/** CSS grid repeat(auto-fit, minmax(min, 1fr)): items in equal columns. */
function gridOf<T>(label: string, items: T[], width: number, min: number, gap: number, cell: (item: T, w: number, i: number) => void): void {
  const cols = Math.max(1, Math.min(items.length, Math.floor((width + gap) / (min + gap))));
  const cw = (width - gap * (cols - 1)) / cols;
  ui.column(label, () => {
    for (let r = 0; r * cols < items.length; r++) {
      ui.row(`${label}-r${r}`, () => {
        for (let c = 0; c < cols && r * cols + c < items.length; c++) {
          const i = r * cols + c;
          ui.column(`${label}-c${i}`, () => cell(items[i]!, cw, i), { width: cw, align: "stretch" });
        }
      }, { spacing: gap, width, align: "stretch" });
    }
  }, { spacing: gap, width });
}
/** A styled box (panel) of a fixed width with a column inside. */
function box(label: string, cls: string, width: number, build: (inner: number) => void, spacing = 8): void {
  ui.column(label, () => build(width - 40), { style: cls, width, spacing });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L0 = layoutNow();
  const f = frame();
  if (app.playing && (app.screen === "none")) hud(L0);
  if (inPlay()) boardMirror();
  if (app.screen !== "none") screen(L0);
  if (app.sheet) sheet(L0);
  toasts(L0);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the HUD (ui.js #hud)
function hud(L0: Layout): void {
  const s = theSession();
  const st = s.state, m = s.match;
  if (!st || !m) return;
  const human = st.currentPlayer === m.humanPlayer;
  const lesson = s.lesson ? s.lessonStepInfo() : null;
  const objective = m.mode === "learn" && lesson ? lessonStepText(lesson) : m.config.misere ? T("objMisere") : T("objLine", { n: m.config.winLength });
  const banner = s.phase === PHASE.TUTORIAL ? T(human ? "yourMove" : "watch") : T(st.status === "terminal" ? "roundOver" : human ? "yourMove" : "rivalThinking");
  const yours = human && st.status === "active";
  const clock = clockText();
  const name = platform.displayName() ? L.playerName(platform.displayName()) : "";
  const sync = platform.syncState();
  const syncWord = T(sync === "synced" ? "syncSynced" : sync === "saving" ? "syncSaving" : sync === "offline" ? "syncOffline" : "syncLocal");
  const syncCls = sync === "saving" ? "sync-saving" : sync === "synced" ? "sync-synced" : "sync-text";
  const gap = L0.portrait || L0.short ? 6.4 : 12;
  const side = L0.short ? 8 : 12;
  const inner = L0.lw - 2 * side;
  // widths: banner pill, clock pill, pause, name pill, sync text; the objective takes what is left
  const bannerW = tw(banner, yours ? "banner-text-yours" : "banner-text") + 35.2 + 2;
  const clockW = clock ? tw(clock, "clock-text") + 28.8 + 2 : 0;
  let nameW = name ? Math.min(160, tw(name, "name-text") + 28.8 + 2) : 0;
  const syncW = tw(syncWord, syncCls) + 1;
  const fixed = (): number => bannerW + 44 + (clockW ? clockW + gap : 0) + (nameW ? nameW + gap : 0) + syncW + gap * 2;
  const pill = (id: string, cls: string, textCls: string, text: string, w: number, justify: "center" | "start" = "center"): void => {
    ui.row(id, () => ui.style(textCls).label(ellipsize(text, textCls, w - 30)), { style: cls, width: w, justify, align: "center" });
  };
  const pauseBtn = (): void => {
    if (ui.style("icon-btn", { width: 44, height: 44 }).id("btn-pause").button(T("pause"), { content: () => ui.style("btn-label-c").label("II") }) && fresh()) later(click(pauseGame));
  };
  ui.place("hud-top", { anchor: "top-start", x: side, y: (L0.short ? 8 : 10) }, () => {
    if (L0.portrait) {
      if (fixed() > inner) nameW = 0;
      const bw = Math.max(80, inner - (fixed() - bannerW));
      ui.column("hud-top-col", () => {
        ui.row("hud-top-row", () => {
          pill("turn-banner", yours ? "pill-yours" : "pill-banner", yours ? "banner-text-yours" : "banner-text", banner, bw);
          pauseBtn();
          if (nameW) pill("player-name", "pill", "name-text", name, nameW);
          ui.style(syncCls).label(syncWord);
        }, { width: inner, spacing: gap, align: "center" });
        if (clock) ui.row("hud-clock", () => pill("clock-display", "pill", "clock-text", clock, Math.min(inner, clockW)), { width: inner });
        ui.column("objective", () => para(objective, inner - 30, "objective-text", "objective-text"), { style: "pill", width: inner });
      }, { spacing: gap, width: inner });
    } else {
      let objW = inner - fixed();
      if (objW < 120 && nameW) { nameW = 0; objW = inner - fixed(); }
      ui.row("hud-top-row", () => {
        if (objW > 60) pill("objective", "pill", "objective-text", objective, Math.min(objW, 700), "start");
        pill("turn-banner", yours ? "pill-yours" : "pill-banner", yours ? "banner-text-yours" : "banner-text", banner, bannerW);
        if (clockW) pill("clock-display", "pill", "clock-text", clock, clockW);
        pauseBtn();
        if (nameW) pill("player-name", "pill", "name-text", name, nameW);
        ui.style(syncCls).label(syncWord);
      }, { width: inner, spacing: gap, align: "center" });
    }
  });
  // rails
  const lefty = platform.options.leftHanded;
  const actions: Btn[] = [
    { id: "btn-undo", text: T("undo"), style: "action-btn", act: () => { ui.setFocus(null); doUndo(); }, disabled: !s.canUndo() },
    { id: "btn-hint", text: T("hint"), style: "action-btn", act: () => { ui.setFocus(null); doHint(); }, disabled: !canHint() },
    { id: "btn-camera", text: T("camera"), style: "action-btn", act: () => { ui.setFocus(null); cycleCamera(); } },
  ];
  if (L0.wide) {
    const rw = 220;
    const leftX = 16, rightX = L0.lw - rw - 16;
    ui.place("rail-match", { anchor: "start", x: lefty ? rightX : leftX, y: 0 }, () => {
      box("rail-match-box", "rail", rw, (iw) => {
        ui.style("rail-title").label(T(m.mode === "learn" ? "lesson" : "match").toUpperCase());
        para(contentLabel(m), iw + 8, "rail-strong");
        para(m.mode === "learn" && lesson ? T("stepOf", { n: lesson.stepIndex + 1, total: lesson.totalSteps })
          : m.seriesLength > 1 ? T("roundOfSeries", { n: m.roundIndex, total: m.seriesLength, you: m.seriesScore[m.humanPlayer] ?? 0, rival: m.seriesScore[m.humanPlayer === 1 ? 2 : 1] ?? 0 })
            : T("roundN", { n: m.roundIndex }), iw + 8, "rail-text");
        para(rulesSummary(st.config), iw + 8, "rail-small");
        para(T("seedN", { n: st.seed }), iw + 8, "rail-small");
      }, 9.6);
    });
    ui.place("rail-actions", { anchor: "start", x: lefty ? leftX : rightX, y: 0 }, () => {
      box("rail-actions-box", "rail", rw, (iw) => {
        ui.style("rail-title").label(T("actions").toUpperCase());
        for (const b of actions) button({ ...b, width: iw + 8 });
      }, 9.6);
    });
  } else {
    // the bottom bar (portrait phones: across the width)
    const side2 = L0.short ? 8 : 12;
    const full = L0.portrait;
    const bw = full ? (L0.lw - 2 * side2 - 16 - 16) / 3 : Math.max(72, ...actions.map((b) => btnWidth(b)));
    const barW = 3 * bw + 2 * 8 + 16 + 2;
    const x = full ? side2 : lefty ? side2 : L0.lw - barW - side2;
    ui.place("rail-actions", { anchor: "bottom-start", x, y: (L0.short ? 8 : 12) }, () => {
      ui.row("rail-actions-row", () => { for (const b of actions) button({ ...b, width: bw }); }, { style: "rail-bar", spacing: 8, width: full ? L0.lw - 2 * side2 : barW, justify: full ? "space-around" : "start" });
    });
  }
}
function clockText(): string {
  const s = theSession();
  const st = s.state, m = s.match;
  const limit = st?.config?.timeLimitMs;
  if (!st || !m || !limit) return "";
  const human = m.humanPlayer;
  const parts: string[] = [];
  for (const p of [human, human === 1 ? 2 : 1]) {
    let used = st.playerTimeMs[p] ?? 0;
    if (app.lastClock && app.lastClock.player === p && st.currentPlayer === p) used = limit - app.lastClock.remainingMs;
    parts.push(T(p === human ? "clockYou" : "clockRival", { time: fmtTime(Math.max(0, limit - used)) }));
  }
  return parts.join(" · ");
}
/** The DOM cell overlay's accessible mirror: one named target per cell. */
function boardMirror(): void {
  const st = theSession().state;
  if (!st) return;
  const n = st.config.boardSize;
  const legal = new Set(legalNow());
  const names: Record<number, string> = { 0: T("cellEmpty"), 1: T("cellX"), 2: T("cellO") };
  for (let i = 0; i < n * n; i++) {
    const rect = render.cellRect(i);
    if (!rect) continue;
    const sealed = st.config.disabledCells.includes(i);
    const text = T("cellLabel", { r: Math.floor(i / n) + 1, c: (i % n) + 1, what: sealed ? T("cellSealed") : names[st.board[i]!]!, avail: legal.has(i) ? T("cellAvailable") : "" });
    ui.id(`cell-${i}`).target(text, rect, { role: "button" });
  }
  void humanTurn;
}

// ------------------------------------------------------------------ screens (ui.js .screen)
function screen(L0: Layout): void {
  const pad = 18;
  const W = Math.min(960, L0.lw - 2 * pad);
  const area = ui.scrollArea("screen-scroll", { width: L0.lw, height: L0.lh }, () => {
    ui.column("screen-col", () => {
      const s = app.screen;
      if (s === "title") titleScreen(L0, W);
      else {
        header(s, W);
        if (s === "modes") modesScreen(W);
        else if (s === "journey") journeyScreen(Math.min(680, W));
        else if (s === "challenges") challengesScreen(Math.min(680, W));
        else if (s === "lessons") lessonsScreen(Math.min(680, W));
        else if (s === "practice") practiceScreen(Math.min(480, W));
        else if (s === "achievements") achievementsScreen(Math.min(680, W));
        else if (s === "help") helpScreen(W);
        else if (s === "settings") settingsScreen(W);
        else if (s === "profile") profileScreen(W);
        else if (s === "hosted") hostedScreen(W);
      }
    }, { width: L0.lw, padding: pad, spacing: 19.2, align: "center", ...(app.screen === "title" ? { height: Math.max(L0.lh, 0), justify: "center" as const } : {}) });
  }, fresh() ? {} : (frame().frame - app.openedFrame < 6 ? { scrollTo: { top: 0 } } : {}));
  void area;
}
const HEADERS: Partial<Record<string, [string, string]>> = {
  modes: ["chooseMode", "chooseModeSub"], journey: ["journey", "journeySub"], challenges: ["challenges", "challengesSub"], lessons: ["learn", "learnSub"],
  practice: ["practiceSetup", "practiceSetupSub"], achievements: ["achievements", "achievementsSub"], help: ["howToPlay", "howToPlaySub"],
  settings: ["settings", "settingsSub"], profile: ["profileTitle", "profileTitleSub"], hosted: ["hostedTitle", "hostedSub"],
};
function header(s: string, W: number): void {
  const [title, sub] = HEADERS[s] ?? ["", ""];
  const gap = 16;
  const textW = W - 2 * 44 - 2 * gap;
  ui.row("screen-header", () => {
    if (ui.style("back-btn", { width: 44, height: 44 }).id("btn-back").button(T("back"), { content: () => ui.style("btn-label-c").label("←") }) && fresh()) later(goBack);
    ui.column("screen-header-text", () => {
      para(T(title), textW, "h2");
      para(T(sub), textW, "dim");
    }, { width: textW, spacing: 2.4 });
    if (s !== "settings" && ui.style("icon-btn", { width: 44, height: 44 }).id("btn-settings").button(T("settings"), { content: () => ui.style("btn-label-c").label("⚙") }) && fresh()) later(click(() => show("settings")));
  }, { width: W, spacing: gap, align: "center" });
}

function titleScreen(L0: Layout, W: number): void {
  const prog = platform.progress();
  const daily = C.dailyFor(new Date(platform.nowMs()));
  const done = prog.dailies[daily.id];
  const doneStages = Object.values(prog.journey).filter((j) => j.stars > 0).length;
  const stars = Object.values(prog.journey).reduce((a, j) => a + (j.stars || 0), 0);
  const small = L0.short || L0.lw < 560;
  ui.column("title-hero", () => {
    ui.style(small ? "title-h1-small" : "title-h1").id("title-h").label("Three Marks");
    para(T("tagline"), Math.min(W, 46 * 8.5), "dim");
    const name = platform.displayName();
    if (name) para(T("playingAs", { name: L.playerName(name) }), W, "dim", "title-name");
    button({ id: "btn-play", text: T("play"), style: "play-btn", act: () => startPractice() });
    if (theSession().hasLocalSnapshot()) button({ id: "btn-resume-snapshot", text: T("resumeInterrupted"), act: resumeSnapshot });
    const acct: Btn[] = [];
    if (!platform.signedIn()) acct.push({ id: "btn-signin", text: S("signIn"), act: signIn });
    if (platform.inviteLink()) acct.push({ id: "btn-invite", text: S("invite"), act: invite });
    if (acct.length) flow("title-account", acct, W, 8, "center");
  }, { width: W, spacing: 9.6, align: "center" });
  const cards: Btn[] = [
    { id: "card-daily", text: T("dailyChallenge"), style: "card-btn", act: startDaily,
      lines: [{ text: T("dailyChallenge"), cls: "btn-label-b" }, { text: done ? T("dailyDone", { name: L.rulesetName(daily.rulesetName), score: done.score }) : T("dailyNotPlayed", { name: L.rulesetName(daily.rulesetName) }), cls: "btn-label-sub" }] },
    { id: "card-journey", text: T("journey"), style: "card-btn", act: () => show("journey"),
      lines: [{ text: T("journey"), cls: "btn-label-b" }, { text: T("journeyCard", { done: doneStages, stars }), cls: "btn-label-sub" }] },
    { id: "btn-all-modes", text: T("allModes"), style: "card-btn", act: () => show("modes"),
      lines: [{ text: T("allModes"), cls: "btn-label-b" }, { text: T("allModesSub"), cls: "btn-label-sub" }] },
    { id: "btn-profile", text: T("profile"), style: "card-btn", act: () => show("profile"),
      lines: [{ text: T("profile"), cls: "btn-label-b" }, { text: T("profileSub"), cls: "btn-label-sub" }] },
  ];
  const cw = Math.min(880, W);
  ui.column("title-gap", () => undefined, { height: small ? 0 : 12 });
  const cols = L0.portrait ? 2 : Math.max(1, Math.min(4, Math.floor((cw + 12.8) / (190 + 12.8))));
  const w = (cw - 12.8 * (cols - 1)) / cols;
  // equal-height rows: each card as tall as the tallest in its row
  for (let r = 0; r * cols < cards.length; r++) {
    const row = cards.slice(r * cols, r * cols + cols);
    const h = Math.max(...row.map((b) => cardHeight(b, w)));
    ui.row(`title-cards-r${r}`, () => { for (const b of row) button({ ...b, width: w, height: h }); }, { width: cw, spacing: 12.8 });
  }
}
function lineCount(text: string, cls: string, width: number): number {
  if (tw(text, cls) <= width) return 1;
  const words = text.split(/\s+/);
  let n = 1, cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (tw(next, cls) > width && cur) { n++; cur = w; } else cur = next;
  }
  return n;
}
function cardHeight(b: Btn, w: number): number {
  const inner = w - 40 - 4;
  let h = 32;
  for (const l of b.lines ?? []) h += lineCount(l.text, l.cls, inner) * (l.cls === "btn-label-b" ? 22 : 20) + 4;
  return Math.max(64, h);
}

const MODE_META: [string, string, string, string, string, boolean][] = [
  ["learn", "modeLearn", "modeLearnDesc", "durLearn", "playersSolo", false],
  ["journey", "modeJourney", "modeJourneyDesc", "durJourney", "playersSoloAi", false],
  ["daily", "modeDaily", "modeDailyDesc", "durDaily", "playersSoloAi", true],
  ["practice", "modePractice", "modePracticeDesc", "durPractice", "playersSoloAi", false],
  ["challenge", "modeChallenge", "modeChallengeDesc", "durChallenge", "playersSoloAi", false],
  ["hosted", "modeHosted", "modeHostedDesc", "durHosted", "playersTwo", false],
];
function modesScreen(W: number): void {
  gridOf("mode-grid", MODE_META, W, 260, 16, ([mode, name, desc, dur, players, ranked], w) => {
    const facts = `${T("duration")} ${T(dur)} · ${T("players")} ${T(players)} · ${T("ranked")} ${T(ranked ? "yes" : "no")}`;
    const b: Btn = { id: `mode-${mode}`, text: T(name), style: "card-btn", act: () => openMode(mode),
      lines: [{ text: T(name), cls: "btn-label-b" }, { text: T(desc), cls: "btn-label-sub" }, { text: facts, cls: "btn-label-em" }] };
    button({ ...b, width: w, height: cardHeight(b, w) + 8 });
  });
}
function journeyScreen(W: number): void {
  const prog = platform.progress();
  ui.column("stage-list", () => {
    C.JOURNEY_STAGES.forEach((stage, i) => {
      if (i % 8 === 0) {
        if (i) ui.column(`ch-gap-${i}`, () => undefined, { height: 8 });
        para(T("chapter", { n: stage.chapter + 1, name: L.chapterName(stage.chapter, C.CHAPTERS[stage.chapter]!.name) }), W, "chapter");
      }
      const rec = prog.journey[stage.id];
      const prevDone = i === 0 || (prog.journey[C.JOURNEY_STAGES[i - 1]!.id]?.stars || 0) > 0;
      const stars = rec?.stars || 0;
      const starText = "★".repeat(stars) + "☆".repeat(3 - stars);
      const inner = W - 32 - 4;
      const nameW = inner - 28 - 14 - tw(starText, "stars") - 14;
      const blurb = L.stageBlurb(stage);
      const opts: ui.ButtonOptions = {
        disabled: !prevDone,
        content: () => ui.row(`stage-face-${i}`, () => {
          ui.style("stage-num", { width: 28 }).label(String(stage.index));
          ui.column(`stage-name-${i}`, () => { para(L.stageName(stage), nameW, "text"); para(blurb, nameW, "small"); }, { width: nameW, spacing: 1 });
          ui.style("stars").label(starText);
        }, { width: inner, spacing: 14, align: "center" }),
      };
      const label = `${stage.index}. ${L.stageName(stage)}. ${blurb}. ${T("starsOf3", { n: stars })}`;
      if (ui.style(stage.mastery ? "stage-mastery" : "stage-btn", { width: W }).id(`stage-${stage.index}`).button(label, opts) && fresh() && prevDone) later(click(() => openStageSheet(stage)));
    });
  }, { width: W, spacing: 7.2 });
}
function cardList(label: string, W: number, items: { id: string; lines: { text: string; cls: string }[]; act: () => void }[]): void {
  ui.column(label, () => {
    for (const it of items) {
      const b: Btn = { id: it.id, text: it.lines[0]!.text, style: "card-btn", lines: it.lines, act: it.act };
      button({ ...b, width: W, height: cardHeight(b, W) });
    }
  }, { width: W, spacing: 11.2 });
}
function challengesScreen(W: number): void {
  const prog = platform.progress();
  cardList("challenge-list", W, C.CHALLENGES.map((c: Challenge) => {
    const rec = prog.challenges[c.id];
    return {
      id: `challenge-${c.id}`, act: () => openChallengeSheet(c),
      lines: [{ text: L.challengeText(c, 0, c.name), cls: "btn-label-b" }, { text: L.challengeText(c, 1, c.blurb), cls: "btn-label-sub" },
        { text: rec ? T("completedBest", { score: rec.bestScore }) : L.challengeText(c, 2, c.goalText), cls: "btn-label-em" }],
    };
  }));
}
function lessonsScreen(W: number): void {
  const prog = platform.progress();
  cardList("lesson-list", W, C.LESSONS.map((l: Lesson) => ({
    id: `lesson-${l.id}`, act: () => startLesson(l),
    lines: [{ text: `${prog.lessons[l.id] ? "✓ " : ""}${L.lessonText(l, "name", l.name)}`, cls: "btn-label-b" }, { text: L.lessonText(l, "intro", l.intro), cls: "btn-label-sub" }],
  })));
}
function practiceScreen(W: number): void {
  const p = app.practice;
  box("setup-form", "panel", W, (iw) => {
    const sel = (key: keyof typeof p, label: string, opts: string[]): void => {
      ui.style("dim").label(T(label));
            const next = ui.style({ width: iw }).id(`pr-${key}`).select(T(label), p[key], opts.map((o) => T(o)));
      if (next !== p[key]) p[key] = next;
    };
    sel("difficulty", "difficulty", ["diffCasualOpt", "diffSkilledOpt", "diffExpertOpt"]);
    sel("board", "board", ["board3", "board4", "board5"]);
    sel("series", "series", ["seriesSingle", "seriesBo3", "seriesBo5"]);
    sel("side", "side", ["sideX", "sideO"]);
    para(`${T("factPlayers")} · ${T("factRanked")} · ${T("factAssists")}`, iw, "small");
    button({ id: "btn-start-practice", text: T("startPractice"), style: "primary-btn", act: startPractice, width: iw });
  }, 12);
  void PRACTICE;
}
function achievementsScreen(W: number): void {
  const prog = platform.progress();
  ui.column("ach-list", () => {
    for (const a of St.ACHIEVEMENTS) {
      const got = prog.achievements[a.key];
      box(`ach-${a.key}`, got ? "ach-unlocked" : "ach-locked", W, (iw) => {
        para(L.achievementText(a, 0), iw + 4, "strong");
        para(L.achievementText(a, 1), iw + 4, "small");
        para(got ? T("unlockedOn", { date: new Date(got.unlockedAt).toLocaleDateString(locale()) }) : T("locked"), iw + 4, "em");
      }, 3.2);
    }
  }, { width: W, spacing: 9.6 });
}
const RULE_CARDS: [string, string[][]][] = [
  ["ruleGoal", [["X", "X", "X"], ["O", "", "O"], ["", "", ""]]],
  ["ruleTurns", [["X", "O", ""], ["", "X", ""], ["O", "", ""]]],
  ["ruleDraw", [["X", "O", "X"], ["X", "O", "O"], ["O", "X", "X"]]],
  ["ruleVariants", [["X", "■", "O"], ["", "X", ""], ["O", "", ""]]],
];
const BINDINGS: [string, string][] = [
  ["confirm", "bindConfirm"], ["cancel", "bindCancel"], ["pause", "bindPause"], ["undo", "bindUndo"], ["hint", "bindHint"], ["camera", "bindCameraReset"],
  ["up", "bindUp"], ["down", "bindDown"], ["left", "bindLeft"], ["right", "bindRight"],
];
function helpScreen(W: number): void {
  gridOf("rule-cards", RULE_CARDS, W, 220, 16, ([key, grid], w) => {
    box(`rule-${key}`, "panel", w, (iw) => {
      para(T(key), iw, "rule-h");
      para(T(key + "Text"), iw, "small");
      const r0 = ui.column(`mini-${key}`, () => {
        grid.forEach((row, r) => ui.row(`mini-${key}-${r}`, () => {
          row.forEach((c, ci) => {
            ui.row(`m-${key}-${r}-${ci}`, () => ui.style(c === "X" ? "mini-x" : c === "O" ? "mini-o" : c === "■" ? "mini-block" : "mini-empty").label(c || "·"), { style: "mini-cell", width: 30, height: 30, justify: "center", align: "center" });
          });
        }, { spacing: 3 }));
      }, { spacing: 3 });
      ui.target(T("exampleBoard", { title: T(key) }), r0, { role: "label" });
    }, 6.4);
  });
  ui.column("controls-h", () => para(T("yourControls"), W, "h3"), { width: W });
  gridOf("help-bindings", BINDINGS, W, 280, 4, ([action, key], w) => {
    ui.row(`bind-${action}`, () => {
      const kb = keysFor(action);
      const kw = tw(kb, "kbd-text") + 18;
      ui.style("dim", { width: Math.max(40, w - kw - 12) }).label(ellipsize(T(key), "dim", Math.max(40, w - kw - 12)));
      ui.row(`kbd-${action}`, () => ui.style("kbd-text").label(kb), { style: "kbd" });
    }, { width: w, spacing: 12, align: "center", justify: "space-between" });
  });
  ui.column("gamepad-h", () => { para(T("gamepad"), W, "h3"); para(T("gamepadText"), W, "small"); }, { width: W, spacing: 6 });
}
function settingsScreen(W: number): void {
  const o = platform.options;
  gridOf("settings-grid", ["play", "access", "more"], W, 280, 16, (part, w) => {
    box(`set-${part}`, "panel", w, (iw) => {
      if (part === "play") {
        para(T("graphics"), iw, "legend");
        const themes = C.THEMES;
        ui.style("dim").label(T("theme"));
                const ti = ui.style({ width: iw }).id("set-theme").select(T("theme"), Math.max(0, themes.findIndex((t) => t.id === o.theme)), themes.map((t) => L.themeName(t)));
        if (themes[ti] && themes[ti]!.id !== o.theme) later(() => platform.setOption("theme", themes[ti]!.id));
        ui.style("dim").label(T("camera"));
        const cams: platform.CameraAngle[] = ["standard", "top", "low"];
                const ci = ui.style({ width: iw }).id("set-camera").select(T("camera"), cams.indexOf(o.camera), cams.map((c) => T(CAMERA_KEYS[c]!)));
        if (cams[ci] !== o.camera) later(() => platform.setOption("camera", cams[ci]!));
      } else if (part === "access") {
        para(T("accessibility"), iw, "legend");
        const toggle = (key: "leftHanded" | "confirmMoves" | "timingAssist"): void => {
          // a wrapping check box (ui.checkbox labels don't wrap): a toggle button with a drawn box
          const on = o[key];
          const tw0 = iw - 34;
          if (ui.style("toggle-btn", { width: iw }).id(`set-${key}`).button(T(key), {
            selected: on,
            content: () => ui.row(`set-${key}-face`, () => {
              ui.style(on ? "check-on" : "check-off").label(on ? "✓" : " ");
              ui.column(`set-${key}-t`, () => para(T(key), tw0, "text"), { width: tw0 });
            }, { width: iw, spacing: 10, align: "center" }),
          }) && fresh()) later(() => platform.setOption(key, !on));
        };
        toggle("leftHanded");
        toggle("confirmMoves");
        toggle("timingAssist");
        ui.style("dim").label(T("colorPalette"));
        const pals: platform.Palette[] = ["default", "deuteranopia", "tritanopia"];
                const pi = ui.style({ width: iw }).id("set-palette").select(T("colorPalette"), pals.indexOf(o.palette), [T("palDefault"), T("palDeuteranopia"), T("palTritanopia")]);
        if (pals[pi] !== o.palette) later(() => platform.setOption("palette", pals[pi]!));
      } else {
        para(T("optionsH"), iw, "legend");
        para(T("optionsNote"), iw, "small");
        button({ id: "btn-options", text: T("openOptions"), act: () => openMenu(), width: Math.min(iw, btnWidth({ id: "", text: T("openOptions"), act: () => undefined })) });
        para(T("privacy"), iw, "legend");
        para(T("privacyNote"), iw, "small");
        button({ id: "btn-reset-progress", text: T("resetProgress"), style: "danger-btn", act: () => openSheet({ kind: "reset" }), width: Math.min(iw, btnWidth({ id: "", text: T("resetProgress"), style: "danger-btn", act: () => undefined })) });
      }
    }, 11.2);
  });
}
function profileScreen(W: number): void {
  const prog = platform.progress();
  const st = prog.stats;
  gridOf("profile-grid", ["identity", "stats", "friends", "shortcuts"], W, 280, 16, (part, w) => {
    box(`prof-${part}`, "panel", w, (iw) => {
      if (part === "identity") {
        para(T("identity"), iw, "h3");
        if (platform.signedIn()) { para(L.playerName(platform.displayName()) || T("player"), iw, "strong"); para(T("signedInNote"), iw, "small"); }
        else para(T("guestNote"), iw, "small");
      } else if (part === "stats") {
        para(T("statistics"), iw, "h3");
        const rows: [string, string][] = [
          [T("statRounds"), String(st.roundsPlayed)], [T("statWon"), String(st.roundsWon)], [T("statDraws"), String(st.roundsDrawn)],
          [T("statScore"), String(st.totalScore)], [T("statAchievements"), `${Object.keys(prog.achievements).length}/${St.ACHIEVEMENTS.length}`],
          [T("statLessons"), `${Object.keys(prog.lessons).length}/${C.LESSONS.length}`],
        ];
        rows.forEach(([k, v], i) => ui.row(`stat-${i}`, () => { ui.style("td").label(k); ui.spacer(); ui.style("td-total").label(v); }, { style: i < rows.length - 1 ? "row-line" : undefined, width: iw }));
      } else if (part === "friends") {
        para(T("friends"), iw, "h3");
        para(T(platform.signedIn() ? "friendsHosted" : "friendsOffline"), iw, "small");
      } else {
        para(T("shortcuts"), iw, "h3");
        flow("prof-shortcuts", [
          { id: "btn-profile-achievements", text: T("achievements"), act: () => show("achievements") },
          { id: "btn-profile-settings", text: T("settings"), act: () => show("settings") },
          { id: "btn-profile-help", text: T("howToPlayShort"), act: () => show("help") },
        ], iw, 8);
      }
    }, 9.6);
  });
}
function hostedScreen(W: number): void {
  box("hosted-card", "panel", Math.min(W, 680), (iw) => {
    para(T("hostedUnavailable"), iw, "text");
    para(T("hostedNote"), iw, "small");
  }, 9.6);
}

// ------------------------------------------------------------------ sheets (ui.js modals)
function sheet(L0: Layout): void {
  const sh = app.sheet!;
  const W = Math.min(520, L0.lw - 24);
  const iw = W - 51.2 - 4;
  const label = sh.kind === "pause" ? T("paused") : sh.kind === "results" ? T("matchResults") : sh.kind === "lesson" ? T("lessonCompleteAria") : sh.kind === "reset" ? T("resetProgress") : sh.spec().title;
  const open = ui.style({ width: W }).dialog(label || "sheet", null, true, () => {
    ui.column("sheet-col", () => {
      if (sh.kind === "setup") setupSheet(sh.spec(), iw);
      else if (sh.kind === "pause") pauseSheet(sh.note, iw);
      else if (sh.kind === "results") resultsSheet(sh.result, iw);
      else if (sh.kind === "lesson") lessonSheet(sh.lesson, sh.unlocked, iw);
      else resetSheet(iw);
    }, { width: iw, spacing: 14.4 });
  });
  void open;
}
function sheetHeading(text: string, cls: string, iw: number): void { para(text, iw, cls); }
function factRows(rows: [string, string][], iw: number): void {
  const kw = Math.min(iw * 0.4, Math.max(...rows.map(([k]) => tw(k, "small"))) + 8);
  ui.column("facts", () => {
    rows.forEach(([k, v], i) => ui.row(`fact-${i}`, () => {
      ui.style("small", { width: kw }).label(ellipsize(k, "small", kw));
      ui.column(`fact-v-${i}`, () => para(v, iw - kw - 10, "td"), { width: iw - kw - 10 });
    }, { width: iw, spacing: 10 }));
  }, { width: iw, spacing: 6.4 });
}
function setupSheet(spec: { title: string; rows: [string, string][]; onStart: () => void }, iw: number): void {
  sheetHeading(spec.title, "sheet-h", iw);
  factRows(spec.rows, iw);
  flow("sheet-actions", [
    { id: "sheet-first", text: T("start"), name: T("start"), style: "primary-btn", act: spec.onStart },
    { id: "btn-cancel", text: T("cancel"), act: closeSheet },
  ], iw, 11.2);
}
function pauseSheet(note: string | null, iw: number): void {
  sheetHeading(T("paused"), "sheet-h", iw);
  if (note) para(T(note), iw, "text");
  ui.column("pause-actions", () => {
    button({ id: "sheet-first", text: T("resume"), style: "primary-btn", act: resume, width: iw });
    button({ id: "btn-pause-settings", text: T("settings"), act: () => pauseTo("settings"), width: iw });
    button({ id: "btn-pause-help", text: T("howToPlayShort"), act: () => pauseTo("help"), width: iw });
    button({ id: "btn-leave", text: T("leaveMatch"), style: "danger-btn", act: () => leaveMatch(), width: iw });
  }, { width: iw, spacing: 11.2 });
}
function resultsSheet(result: MatchResult, iw: number): void {
  const won = result.outcome === "win";
  const headline = T(won ? "victory" : result.outcome === "draw" ? "honestDraw" : "defeat");
  sheetHeading(headline, won ? "sheet-h-won" : result.outcome === "draw" ? "sheet-h-drew" : "sheet-h-lost", iw);
  const name = contentLabel(result);
  para(T(result.rounds.length > 1 ? "resultsSubMany" : "resultsSubOne", { name, n: result.rounds.length }) + (result.ranked ? T("rankedTag") : result.assistsUsed ? T("unrankedAssists") : ""), iw, "small");
  if (result.stars) ui.style("stars-big").label("★".repeat(result.stars) + "☆".repeat(3 - result.stars));
  ui.column("breakdown", () => {
    result.breakdown.components.forEach((c, i) => ui.row(`bd-${i}`, () => {
      ui.style("td").label(L.scoreLabel(c.label));
      ui.spacer();
      ui.style("td-num").label(`${c.value >= 0 ? "+" : ""}${c.value}`);
    }, { style: "row-line", width: iw }));
    ui.row("bd-total", () => { ui.style("td-total").label(T("total")); ui.spacer(); ui.style("td-total").id("results-total").label(String(result.breakdown.total)); }, { width: iw, padding: { top: 6 } });
  }, { width: iw, spacing: 0 });
  const human = theSession().match?.humanPlayer ?? 1;
  if (result.rounds.length > 1) para(T("seriesScore", { you: result.seriesScore[human] ?? 0, rival: result.seriesScore[human === 1 ? 2 : 1] ?? 0 }), iw, "small");
  const badges = (result.achievementsUnlocked || []).map((key) => St.ACHIEVEMENTS.find((a) => a.key === key)).filter(Boolean);
  if (badges.length) flowBadges(badges.map((a) => `🏅 ${L.achievementText(a!, 0)}`), iw);
  para(recommendation(result), iw, "small");
  const lb = lbLine();
  if (lb) para(lb, iw, "small", "results-lb");
  const actions: Btn[] = [{ id: "sheet-first", text: T(result.mode === "daily" ? "playAgainUnranked" : "retry"), style: "primary-btn", act: () => retry(result) }];
  if (result.mode === "journey" && won) {
    const idx = C.JOURNEY_STAGES.findIndex((s) => s.id === result.contentId);
    const next: Stage | undefined = C.JOURNEY_STAGES[idx + 1];
    if (next) actions.push({ id: "btn-next", text: T("nextName", { name: L.stageName(next) }), act: () => { closeSheet(); openStageSheet(next); } });
  }
  actions.push({ id: "btn-modes", text: T("backToModes"), act: () => leaveMatch() });
  flow("results-actions", actions, iw, 11.2);
}
function flowBadges(texts: string[], iw: number): void {
  ui.column("ach-row", () => {
    for (const [i, t] of texts.entries()) ui.row(`badge-${i}`, () => para(t, iw - 30, "badge-text"), { style: "ach-badge" });
  }, { spacing: 8, width: iw });
}
function recommendation(r: MatchResult): string {
  if (r.mode === "journey") return T(r.outcome !== "win" ? "recJourneyLost" : "recJourneyWon");
  if (r.mode === "daily") return T("recDaily");
  if (r.mode === "learn") return T("recLearn");
  if (r.mode === "challenge") return T(r.outcome === "win" ? "recChallengeWon" : "recChallengeLost");
  return T(r.outcome === "win" ? "recPracticeWon" : "recPracticeLost");
}
function lessonSheet(lesson: Lesson, unlocked: string[], iw: number): void {
  sheetHeading(T("lessonComplete"), "sheet-h-won", iw);
  para(L.lessonText(lesson, "name", lesson.name), iw, "small");
  const badges = unlocked.map((k) => { const a = St.ACHIEVEMENTS.find((x) => x.key === k); return `🏅 ${a ? L.achievementText(a, 0) : k}`; });
  if (badges.length) flowBadges(badges, iw);
  const idx = C.LESSONS.findIndex((l) => l.id === lesson.id);
  const next = C.LESSONS[idx + 1];
  flow("lesson-actions", [
    next ? { id: "sheet-first", text: T("nextName", { name: L.lessonText(next, "name", next.name) }), style: "primary-btn", act: () => startLesson(next) }
      : { id: "sheet-first", text: T("startPlaying"), style: "primary-btn", act: () => leaveMatch("modes") },
    { id: "btn-all-lessons", text: T("allLessons"), act: () => leaveMatch("lessons") },
  ], iw, 11.2);
}
function resetSheet(iw: number): void {
  sheetHeading(T("resetProgress"), "sheet-h-lost", iw);
  para(T("resetConfirm"), iw, "text");
  flow("reset-actions", [
    { id: "sheet-first", text: T("cancel"), act: closeSheet },
    { id: "btn-reset-yes", text: T("resetProgress"), style: "danger-btn", act: () => { closeSheet(); resetProgress(); } },
  ], iw, 11.2);
}

// ------------------------------------------------------------------ toasts (#toasts)
function toasts(L0: Layout): void {
  if (!app.toasts.length) return;
  const maxW = Math.min(L0.lw * 0.88, 60 * 8);
  const bottom = app.playing && app.screen === "none" && !L0.wide ? 84 : 20;
  ui.place("toasts", { anchor: "bottom", x: 0, y: bottom }, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((t, i) => {
        const cls = t.warn ? "toast-warn-text" : "toast-text";
        const w = Math.min(maxW, tw(t.text, cls) + 38.4 + 2);
        ui.column(`toast-${i}`, () => para(t.text, w - 38.4 - 2, cls), { style: t.warn ? "toast-warn" : "toast", width: w, align: "center" });
      });
    }, { spacing: 8, align: "center" });
  });
}
