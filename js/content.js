// Versioned content: lessons, journey stages, challenges, daily rulesets and
// visual themes. All content carries identifier, seed, initial state, goals,
// allowed mechanics, par values, tutorial flags and presentation theme.
import { defaultConfig, validateConfig, createInitialState, legalCells, applyCommand } from './rules.js';
import { hashString, RngStream } from './rng.js';

export const CONTENT_VERSION = 1;

// ---- Themes (cosmetic only: materials, ambience, accents) ----

export const THEMES = [
  {
    id: 'slate', name: 'Slate & Chalk',
    bg: 0x14161c, fog: 0x14161c, board: 0x2b303b, boardEdge: 0x1b1e26,
    grid: 0x8f96a6, frame: 0x4a3b2c, ground: 0x1a1c22,
    markA: 0xf2ead8, markB: 0x7fd4c1, ghost: 0xf2ead8,
    accent: 0xe8b64c, danger: 0xe0604f, key: 0xfff1d6, fill: 0x8fa3c8,
    ambience: 'room', desc: 'The classic quick-play slate.',
  },
  {
    id: 'paper', name: 'Ink & Paper',
    bg: 0xe9e2d0, fog: 0xe9e2d0, board: 0xf5efdd, boardEdge: 0xcbbfa4,
    grid: 0x8a7f66, frame: 0x6d5a41, ground: 0xd8cfb8,
    markA: 0x2d2a26, markB: 0xb34a3a, ghost: 0x2d2a26,
    accent: 0x2f6f8f, danger: 0xb3402f, key: 0xfff6e0, fill: 0xb0a890,
    ambience: 'paper', desc: 'Pen strokes on warm stock.',
  },
  {
    id: 'neon', name: 'Night Grid',
    bg: 0x070a12, fog: 0x070a12, board: 0x10182a, boardEdge: 0x05070d,
    grid: 0x1fe0d0, frame: 0x182238, ground: 0x090c14,
    markA: 0x59f2e6, markB: 0xf267d8, ghost: 0x59f2e6,
    accent: 0xf2e35c, danger: 0xf25c7a, key: 0xd6f2ff, fill: 0x4a5a8a,
    ambience: 'night', desc: 'Phosphor lines in the dark.',
  },
  {
    id: 'dune', name: 'Sunbaked Dune',
    bg: 0xc9a06a, fog: 0xc9a06a, board: 0x9c6f42, boardEdge: 0x6e4b2a,
    grid: 0x5a3d22, frame: 0x7a5636, ground: 0xbb8f5c,
    markA: 0xfff3dc, markB: 0x37536b, ghost: 0xfff3dc,
    accent: 0x8f3b2c, danger: 0x8f2c2c, key: 0xffe9c4, fill: 0xd9b98c,
    ambience: 'wind', desc: 'Marks carved in warm clay.',
  },
  {
    id: 'abyss', name: 'Deep Current',
    bg: 0x06222b, fog: 0x06222b, board: 0x0d3442, boardEdge: 0x04161d,
    grid: 0x6fb7c9, frame: 0x0f2a33, ground: 0x052029,
    markA: 0xd8f2ec, markB: 0xf2a65c, ghost: 0xd8f2ec,
    accent: 0x66e0c2, danger: 0xe06a5a, key: 0xe0f7ff, fill: 0x2c5a70,
    ambience: 'deep', desc: 'Quiet light far below.',
  },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

// ---- Learn: interactive lessons, one rule at a time ----
// Each step requires the player to perform the action; validation goes
// through the same legal-action API used by play.

export const LESSONS = [
  {
    id: 'lesson-place', index: 0, name: 'Making a Mark',
    intro: 'The slate is yours. Learn to leave your mark.',
    steps: [
      {
        text: 'Tap any empty cell to place your mark. You play the pale strokes.',
        require: { kind: 'place-any' },
        config: {},
      },
      {
        text: 'Marks are permanent. Place one in the glowing center cell.',
        require: { kind: 'place-cell', cell: 4 },
        highlightCells: [4],
        config: {},
      },
    ],
  },
  {
    id: 'lesson-turns', index: 1, name: 'Taking Turns',
    intro: 'Players alternate. Your rival answers every mark you make.',
    steps: [
      {
        text: 'Place a mark. Watch how the turn passes to your rival, then back to you.',
        require: { kind: 'place-any' },
        config: {}, aiReplies: 2, ai: 'casual',
      },
      {
        text: 'One more exchange. The turn banner always tells you whose move it is.',
        require: { kind: 'place-any' },
        config: {}, aiReplies: 2, ai: 'casual',
      },
    ],
  },
  {
    id: 'lesson-line', index: 2, name: 'Complete a Line',
    intro: 'Three of your marks in a row — across, down, or diagonal — wins the round.',
    steps: [
      {
        text: 'You already have two marks in the top row. Complete the line to win.',
        require: { kind: 'win' },
        highlightCells: [2],
        config: { startMarks: [{ cell: 0, player: 1 }, { cell: 1, player: 1 }, { cell: 4, player: 2 }] },
        ai: 'casual',
      },
      {
        text: 'Diagonals count too. Finish the diagonal from the corner.',
        require: { kind: 'win' },
        highlightCells: [8],
        config: { startMarks: [{ cell: 0, player: 1 }, { cell: 4, player: 1 }, { cell: 2, player: 2 }] },
        ai: 'casual',
      },
    ],
  },
  {
    id: 'lesson-block', index: 3, name: 'The Block',
    intro: 'A rival about to complete a line must be stopped.',
    steps: [
      {
        text: 'Your rival has two in the middle row. Block them before it is too late.',
        require: { kind: 'place-cell', cell: 5 },
        highlightCells: [5],
        config: { startMarks: [{ cell: 3, player: 2 }, { cell: 4, player: 2 }, { cell: 0, player: 1 }] },
      },
      {
        text: 'Again: they threaten the diagonal. Where must your mark go?',
        require: { kind: 'place-cell', cell: 8 },
        highlightCells: [8],
        config: { startMarks: [{ cell: 0, player: 2 }, { cell: 4, player: 2 }, { cell: 1, player: 1 }] },
      },
    ],
  },
  {
    id: 'lesson-draw', index: 4, name: 'The Honest Draw',
    intro: 'When neither side completes a line, the round is a draw. Perfect play from both sides always ends level.',
    steps: [
      {
        text: 'Play out this endgame against a watchful rival and secure the draw.',
        require: { kind: 'finish-round' },
        config: { startMarks: [{ cell: 0, player: 1 }, { cell: 1, player: 2 }, { cell: 2, player: 1 }, { cell: 4, player: 2 }] },
        ai: 'expert', aiPlays: 2,
      },
    ],
  },
];

// ---- Journey: 40 authored stages in five chapters ----
// Mechanics are introduced in isolation, combined with known ones, then
// tested in a mastery stage before the next chapter adds another.

export const CHAPTERS = [
  { name: 'First Strokes', theme: 'slate' },
  { name: 'Second Thoughts', theme: 'paper' },
  { name: 'Wider Slates', theme: 'dune' },
  { name: 'Under Pressure', theme: 'neon' },
  { name: 'Grand Mastery', theme: 'abyss' },
];

function stage(index, name, blurb, cfg, opts = {}) {
  const config = defaultConfig(cfg);
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Stage ${index} config invalid: ${errors.join('; ')}`);
  return {
    id: `stage-${String(index).padStart(2, '0')}`,
    index,
    chapter: Math.floor((index - 1) / 8),
    name,
    blurb,
    seed: hashString(`three-marks-stage-${index}`),
    config,
    opponent: { difficulty: opts.ai || 'casual', name: opts.aiName || 'Rival' },
    series: opts.series || 1,
    humanPlayer: opts.humanPlayer || 1,
    par: { marks: opts.parMarks || 5, timeMs: opts.parMs || 90000 },
    goals: opts.goals || ['win-series'],
    theme: opts.theme || CHAPTERS[Math.floor((index - 1) / 8)].theme,
    mastery: !!opts.mastery,
    tutorialFlags: opts.tutorialFlags || [],
  };
}

export const JOURNEY_STAGES = [
  // Chapter 1 — First Strokes: classic 3x3, gentle AI.
  stage(1, 'Hello, Slate', 'Win a single round against a lenient rival.', {}, { parMarks: 5, tutorialFlags: ['welcome'] }),
  stage(2, 'Corners First', 'Your rival opens. Answer and take the round.', {}, { ai: 'casual', humanPlayer: 2, parMarks: 4 }),
  stage(3, 'Short Fuse', 'Win in four of your own marks or fewer.', {}, { ai: 'casual', goals: ['win-series', 'par-marks'], parMarks: 4 }),
  stage(4, 'No Center Court', 'The center is sealed. Win around it.', { disabledCells: [4] }, { ai: 'casual', parMarks: 4 }),
  stage(5, 'Two of Three', 'Your first series. Take a best-of-three.', {}, { ai: 'casual', series: 3, parMs: 240000 }),
  stage(6, 'Hold the Pen', 'Win two rounds in a row without a loss.', {}, { ai: 'casual', series: 3, goals: ['win-series'] }),
  stage(7, 'Watchful Eye', 'A steadier rival. Blocks will be punished.', {}, { ai: 'skilled', parMarks: 5 }),
  stage(8, 'Mastery: The Slate', 'Best-of-three against a skilled rival. Show command of the classic board.', {}, { ai: 'skilled', series: 3, mastery: true, parMs: 240000 }),

  // Chapter 2 — Second Thoughts: precision and limits.
  stage(9, 'Three Marks Exactly', 'Win using exactly three of your own marks.', {}, { ai: 'casual', goals: ['win-series', 'exact-marks'], parMarks: 3 }),
  stage(10, 'Economy of Line', 'Move limit: four marks each. Plan the endgame.', { moveLimit: 4 }, { ai: 'skilled', parMarks: 4 }),
  stage(11, 'Tight Corners', 'Two corners are sealed. Find the open lines.', { disabledCells: [0, 8] }, { ai: 'skilled', parMarks: 4 }),
  stage(12, 'Cross Purposes', 'The diagonals are broken. Win straight.', { disabledCells: [0, 2, 6, 8] }, { ai: 'skilled', parMarks: 3, goals: ['win-series'] }),
  stage(13, 'Comeback Trail', 'Your rival starts with a corner. Turn it around.', { startMarks: [{ cell: 0, player: 2 }] }, { ai: 'skilled', humanPlayer: 1, parMarks: 5 }),
  stage(14, 'Misère Lesson', 'Completing a line now LOSES the round. Force your rival into it.', { misere: true }, { ai: 'skilled', parMarks: 5 }),
  stage(15, 'Limits Combined', 'Sealed center, four-mark limit, misère off. Everything you know, together.', { disabledCells: [4], moveLimit: 4 }, { ai: 'skilled', parMarks: 4 }),
  stage(16, 'Mastery: The Ledger', 'Best-of-three on sealed-corner boards against a skilled rival.', { disabledCells: [0, 8] }, { ai: 'skilled', series: 3, mastery: true, parMs: 240000 }),

  // Chapter 3 — Wider Slates: larger boards.
  stage(17, 'A Wider Slate', 'Four-by-four. Three in a row still wins.', { boardSize: 4, winLength: 3 }, { ai: 'casual', parMarks: 6, parMs: 120000 }),
  stage(18, 'Deep Lines', 'Four-by-four, and now a line needs four.', { boardSize: 4, winLength: 4 }, { ai: 'casual', parMarks: 6, parMs: 150000 }),
  stage(19, 'Survey the Field', 'Win on the wide board in six marks or fewer.', { boardSize: 4, winLength: 4 }, { ai: 'skilled', goals: ['win-series', 'par-marks'], parMarks: 6 }),
  stage(20, 'Broken Center', 'The middle four are sealed on a wide board.', { boardSize: 4, winLength: 4, disabledCells: [5, 6, 9, 10] }, { ai: 'skilled', parMarks: 6 }),
  stage(21, 'Grand Debut', 'Five-by-five. A line of four wins.', { boardSize: 5, winLength: 4 }, { ai: 'casual', parMarks: 7, parMs: 180000 }),
  stage(22, 'Long Game', 'Five-by-five with an eight-mark limit.', { boardSize: 5, winLength: 4, moveLimit: 8 }, { ai: 'skilled', parMarks: 8, parMs: 180000 }),
  stage(23, 'Rival’s Opening', 'Two enemy marks already down on the grand board.', { boardSize: 5, winLength: 4, startMarks: [{ cell: 6, player: 2 }, { cell: 18, player: 2 }] }, { ai: 'skilled', parMarks: 7 }),
  stage(24, 'Mastery: The Expanse', 'Best-of-three, four-by-four, against an expert.', { boardSize: 4, winLength: 4 }, { ai: 'expert', series: 3, mastery: true, parMs: 360000 }),

  // Chapter 4 — Under Pressure: clocks.
  stage(25, 'First Clock', 'Sixty seconds on your clock. Win before it runs out.', { timeLimitMs: 60000 }, { ai: 'skilled', parMs: 45000 }),
  stage(26, 'Quick Study', 'Forty-five seconds, and your rival plays well.', { timeLimitMs: 45000 }, { ai: 'skilled', parMs: 40000 }),
  stage(27, 'Blitz Line', 'Thirty seconds. Trust your first instinct.', { timeLimitMs: 30000 }, { ai: 'skilled', parMs: 25000 }),
  stage(28, 'Wide Blitz', 'A wide board, a short clock.', { boardSize: 4, winLength: 4, timeLimitMs: 90000 }, { ai: 'skilled', parMs: 75000 }),
  stage(29, 'Sealed and Timed', 'Sealed center, four-mark limit, one minute.', { disabledCells: [4], moveLimit: 4, timeLimitMs: 60000 }, { ai: 'skilled', parMs: 50000 }),
  stage(30, 'Misère Sprint', 'Misère rules, thirty seconds. Do not blink.', { misere: true, timeLimitMs: 30000 }, { ai: 'skilled', parMs: 25000 }),
  stage(31, 'Expert Examination', 'No tricks — just an expert across the slate.', {}, { ai: 'expert', series: 3, parMs: 300000 }),
  stage(32, 'Mastery: The Stopwatch', 'Best-of-three under a shared minute each against an expert.', { timeLimitMs: 60000 }, { ai: 'expert', series: 3, mastery: true, parMs: 150000 }),

  // Chapter 5 — Grand Mastery.
  stage(33, 'The Grand Slate', 'Five-by-five against an expert. A line of four.', { boardSize: 5, winLength: 4 }, { ai: 'expert', parMarks: 8, parMs: 300000 }),
  stage(34, 'Grand Seals', 'Grand board, sealed ring, expert rival.', { boardSize: 5, winLength: 4, disabledCells: [0, 4, 20, 24] }, { ai: 'expert', parMarks: 8 }),
  stage(35, 'Grand Blitz', 'Two minutes on the grand board.', { boardSize: 5, winLength: 4, timeLimitMs: 120000 }, { ai: 'expert', parMs: 100000 }),
  stage(36, 'Everything At Once', 'Wide board, sealed cells, move limit, clock.', { boardSize: 4, winLength: 4, disabledCells: [0, 15], moveLimit: 7, timeLimitMs: 90000 }, { ai: 'expert', parMs: 80000 }),
  stage(37, 'Misère Grand', 'Misère on the wide board. An expert awaits.', { boardSize: 4, winLength: 3, misere: true }, { ai: 'expert', parMarks: 7 }),
  stage(38, 'The Gauntlet', 'Best-of-five. Expert. Classic slate.', {}, { ai: 'expert', series: 5, parMs: 600000 }),
  stage(39, 'Last Reservations', 'Best-of-three on broken boards against an expert.', { disabledCells: [1, 3, 5, 7] }, { ai: 'expert', series: 3, parMs: 300000 }),
  stage(40, 'Mastery: Three Marks', 'Best-of-five on the grand slate against the expert. The journey’s summit.', { boardSize: 5, winLength: 4 }, { ai: 'expert', series: 5, mastery: true, parMs: 900000 }),
];

export function stageById(id) {
  return JOURNEY_STAGES.find((s) => s.id === id);
}

// ---- Challenge mode: constrained standalone goals ----

export const CHALLENGES = [
  {
    id: 'ch-blitz', name: 'Ten-Second Slate', blurb: 'Ten seconds on your clock. Win or fall.',
    config: defaultConfig({ timeLimitMs: 10000 }), ai: 'skilled', series: 1,
    goalText: 'Win with a 10s clock', seed: hashString('challenge-blitz'), theme: 'neon',
  },
  {
    id: 'ch-surgical', name: 'Surgical', blurb: 'Four marks is all you get. Make each one count.',
    config: defaultConfig({ moveLimit: 4 }), ai: 'expert', series: 1,
    goalText: 'Win within 4 own marks', seed: hashString('challenge-surgical'), theme: 'paper',
  },
  {
    id: 'ch-nocenter', name: 'Hollow Slate', blurb: 'The center is gone. Lines must bend around the hole.',
    config: defaultConfig({ disabledCells: [4] }), ai: 'expert', series: 1,
    goalText: 'Win without a center cell', seed: hashString('challenge-nocenter'), theme: 'slate',
  },
  {
    id: 'ch-grand', name: 'Grand Board', blurb: 'Five by five, four to win, expert across the table.',
    config: defaultConfig({ boardSize: 5, winLength: 4 }), ai: 'expert', series: 1,
    goalText: 'Win on the 5x5 board', seed: hashString('challenge-grand'), theme: 'abyss',
  },
  {
    id: 'ch-comeback', name: 'Comeback', blurb: 'Two enemy marks are already down. Dig out.',
    config: defaultConfig({ startMarks: [{ cell: 0, player: 2 }, { cell: 8, player: 2 }] }), ai: 'skilled', series: 1,
    goalText: 'Win from two marks behind', seed: hashString('challenge-comeback'), theme: 'dune',
  },
  {
    id: 'ch-misere', name: 'Poison Line', blurb: 'Completing a line loses. Force your rival to finish one.',
    config: defaultConfig({ misere: true }), ai: 'skilled', series: 1,
    goalText: 'Win under misère rules', seed: hashString('challenge-misere'), theme: 'neon',
  },
];

export function challengeById(id) {
  return CHALLENGES.find((c) => c.id === id);
}

// ---- Daily: one shared seed and ruleset per UTC day ----

const DAILY_RULESETS = [
  { name: 'Classic', config: {}, ai: 'skilled', theme: 'slate' },
  { name: 'Wide Lines', config: { boardSize: 4, winLength: 4 }, ai: 'expert', theme: 'dune' },
  { name: 'Blitz', config: { timeLimitMs: 30000 }, ai: 'skilled', theme: 'neon' },
  { name: 'Misère', config: { misere: true }, ai: 'skilled', theme: 'paper' },
  { name: 'Hollow', config: { disabledCells: [4] }, ai: 'expert', theme: 'abyss' },
];

export function dailyFor(date = new Date()) {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dayIndex = Math.floor(day / 86400000);
  const iso = new Date(day).toISOString().slice(0, 10);
  const pick = DAILY_RULESETS[dayIndex % DAILY_RULESETS.length];
  return {
    id: `daily-${iso}`,
    date: iso,
    name: `Daily — ${pick.name}`,
    rulesetName: pick.name,
    seed: hashString(`three-marks-daily-${iso}`),
    config: defaultConfig(pick.config),
    ai: pick.ai,
    series: 1,
    theme: pick.theme,
    dayIndex,
  };
}

// ---- Content validation (offline validator used by tests and boot) ----

export function validateContent() {
  const problems = [];
  const seen = new Set();
  for (const s of JOURNEY_STAGES) {
    if (seen.has(s.id)) problems.push(`duplicate stage id ${s.id}`);
    seen.add(s.id);
    const errs = validateConfig(s.config);
    if (errs.length) problems.push(`${s.id}: ${errs.join('; ')}`);
    // Reachability: at least one legal opening move must exist.
    const st = createInitialState(s.config, s.seed);
    if (legalCells(st, st.currentPlayer).length === 0) problems.push(`${s.id}: no legal opening move (soft lock)`);
    // Bounded duration: a round always ends within boardSize^2 commands.
    if (st.config.moveLimit === 0) {
      const bound = s.config.boardSize * s.config.boardSize;
      if (!(bound <= 25)) problems.push(`${s.id}: unbounded round`);
    }
  }
  for (const c of CHALLENGES) {
    if (seen.has(c.id)) problems.push(`duplicate challenge id ${c.id}`);
    seen.add(c.id);
    const errs = validateConfig(c.config);
    if (errs.length) problems.push(`${c.id}: ${errs.join('; ')}`);
    const st = createInitialState(c.config, c.seed);
    if (legalCells(st, st.currentPlayer).length === 0) problems.push(`${c.id}: no legal opening move`);
  }
  for (const l of LESSONS) {
    for (const step of l.steps) {
      const errs = validateConfig(defaultConfig(step.config || {}));
      if (errs.length) problems.push(`${l.id}: ${errs.join('; ')}`);
    }
  }
  // Dailies: sweep a full rotation.
  for (let d = 0; d < DAILY_RULESETS.length; d++) {
    const daily = dailyFor(new Date(d * 86400000));
    const st = createInitialState(daily.config, daily.seed);
    if (legalCells(st, st.currentPlayer).length === 0) problems.push(`${daily.id}: no legal opening move`);
  }
  return problems;
}
