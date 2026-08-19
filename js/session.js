// Session layer: owns the game-state machine, issues validated commands to
// the rules engine, drives the practice AI, accumulates authoritative
// (platform-time) clocks, records replay envelopes and manages series,
// undo and lesson flows. Rendering and UI consume immutable snapshots.
import {
  createInitialState, applyCommand, legalCells, scoreBreakdown, stateHash,
  createReplayEnvelope, serialize, deserialize, defaultConfig,
} from './rules.js';
import { PracticeAI, difficultyById } from './ai.js';
import { unlockAchievement, dailyStreak } from './storage.js';
import { LESSONS, JOURNEY_STAGES, CONTENT_VERSION } from './content.js';
import { randomId } from './platform.js';

export const PHASE = {
  BOOT: 'boot',
  TITLE: 'title',
  PROFILE: 'profile-ready',
  MODE_SELECT: 'mode-select',
  PREPARING: 'preparing',
  TUTORIAL: 'tutorial',
  COUNTDOWN: 'countdown',
  ACTIVE: 'active',
  PAUSED: 'paused',
  RECONNECTING: 'reconnecting',
  RESOLVING: 'resolving',
  RESULTS: 'results',
  PROGRESSION: 'progression',
};

const BUILD_VERSION = '1.0.0';

class Emitter {
  constructor() {
    this.listeners = {};
  }
  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this.listeners[event] = (this.listeners[event] || []).filter((f) => f !== fn);
  }
  emit(event, payload) {
    for (const fn of (this.listeners[event] || []).slice()) fn(payload);
  }
}

export class GameSession extends Emitter {
  constructor({ platform, store, audio }) {
    super();
    this.platform = platform;
    this.store = store;
    this.audio = audio;
    this.phase = PHASE.BOOT;
    this.phaseOwner = 'bootstrap';
    this.phaseReason = 'init';
    this.match = null; // current match context
    this.state = null; // current rules snapshot (immutable)
    this.stateStack = []; // for undo
    this.turnStartedAt = 0;
    this.pausedAccumMs = 0;
    this.aiTimer = null;
    this.clockTimer = null;
    this.resolveTimer = null;
    this.lesson = null; // active lesson context
    this.masteryStageIds = JOURNEY_STAGES.filter((s) => s.mastery).map((s) => s.id);
  }

  setPhase(phase, owner, reason) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseOwner = owner;
    this.phaseReason = reason;
    this.emit('phase', { phase, owner, reason });
  }

  // ---- match lifecycle ----

  // options: { mode, config, seed, ai, humanPlayer, series, contentId, theme,
  //           ranked, assists, par, goals, contentName }
  startMatch(options) {
    this.clearTimers();
    const aiDifficulty = options.ai ? difficultyById(options.ai) : null;
    const assists = { ...(options.assists || {}) };
    const config = defaultConfig({ ...(options.config || {}) });
    if (assists.timingAssist) {
      // Opting into timing assistance marks the match unranked even on
      // rulesets without a clock, so the UI promise stays consistent.
      if (config.timeLimitMs > 0) config.timeLimitMs = Math.floor(config.timeLimitMs * 1.5);
      assists.timingAssistApplied = true;
    }
    this.match = {
      id: randomId(),
      mode: options.mode || 'practice',
      contentId: options.contentId || null,
      contentName: options.contentName || 'Friendly Round',
      config,
      seed: options.seed >>> 0,
      aiDifficulty,
      humanPlayer: options.humanPlayer || 1,
      seriesLength: options.series || 1,
      seriesNeeded: Math.floor((options.series || 1) / 2) + 1,
      roundIndex: 0,
      rounds: [], // {winner, reason, score (human), breakdown}
      seriesScore: { 1: 0, 2: 0 },
      theme: options.theme || 'slate',
      ranked: !!options.ranked,
      assists,
      par: options.par || { marks: 5, timeMs: 90000 },
      goals: options.goals || ['win-series'],
      startedAt: this.platform.serverNow(),
    };
    this.ai = aiDifficulty ? new PracticeAI(aiDifficulty.id, this.match.seed ^ 0x51ab) : null;
    this.lesson = null;
    this.setPhase(PHASE.PREPARING, 'session', 'match-created');
    this.startRound();
  }

  startRound() {
    this.clearTimers();
    const m = this.match;
    m.roundIndex += 1;
    // Alternate who opens between rounds for fairness.
    const config = { ...m.config, firstPlayer: m.roundIndex % 2 === 1 ? m.config.firstPlayer : (m.config.firstPlayer === 1 ? 2 : 1) };
    this.state = createInitialState(config, (m.seed + m.roundIndex * 7919) >>> 0);
    this.stateStack = [this.state];
    this.replay = createReplayEnvelope({
      seed: this.state.seed, config, buildVersion: BUILD_VERSION, contentVersion: CONTENT_VERSION,
    });
    this.setPhase(PHASE.COUNTDOWN, 'session', `round-${m.roundIndex}`);
    this.emit('round-start', this.snapshotInfo());
    this.emit('state', this.state);
    const delay = this.audio?.settings?.accessibility?.reducedMotion ? 150 : 900;
    this.resolveTimer = setTimeout(() => this.beginTurn(), delay);
  }

  beginTurn() {
    if (!this.state || this.state.status !== 'active') return;
    this.setPhase(PHASE.ACTIVE, 'session', 'turn-begin');
    this.turnStartedAt = this.platform.serverNow();
    this.startClockWatch();
    if (this.ai && this.state.currentPlayer !== this.match.humanPlayer) {
      this.scheduleAI();
    }
    this.emit('state', this.state);
  }

  scheduleAI() {
    const thinking = 450 + (this.state.turnNumber % 3) * 150; // readable pace, not instant
    this.aiTimer = setTimeout(() => {
      if (this.phase !== PHASE.ACTIVE || !this.state || this.state.status !== 'active') return;
      const player = this.state.currentPlayer;
      const cell = this.ai.chooseCell(this.state, player);
      if (cell >= 0) this.commit({ player, type: 'place', cell });
    }, thinking);
  }

  // Human (or AI) entry point: build a validated command and apply it.
  placeCell(cell, player = this.match?.humanPlayer) {
    if (this.phase !== PHASE.ACTIVE) return { ok: false, reason: 'not-active' };
    return this.commit({ player, type: 'place', cell });
  }

  resign() {
    if (!this.state || this.state.status !== 'active') return { ok: false, reason: 'not-active' };
    return this.commit({ player: this.match?.humanPlayer || this.state.currentPlayer, type: 'resign' });
  }

  commit({ player, type, cell }) {
    if (!this.state) return { ok: false, reason: 'no-state' };
    const elapsedMs = Math.max(0, this.platform.serverNow() - this.turnStartedAt);
    const cmd = {
      id: `${this.match.id}-r${this.match.roundIndex}-t${this.state.turnNumber}`,
      player, type, cell, elapsedMs,
    };
    const res = applyCommand(this.state, cmd);
    if (!res.ok) {
      if (res.reason !== 'duplicate-command') this.state = res.state; // counts invalids
      this.emit('invalid', { reason: res.reason, cell, player });
      this.emit('state', this.state);
      return res;
    }
    this.state = res.state;
    this.stateStack.push(this.state);
    this.replay.commands.push(cmd);
    this.replay.stateHashes.push(stateHash(this.state));
    this.emit('move', { cmd, state: this.state });
    this.emit('state', this.state);
    if (this.audio) {
      if (type === 'place') this.audio.placeImpact(player);
    }
    if (this.state.status === 'terminal') {
      this.finishRound();
    } else {
      this.turnStartedAt = this.platform.serverNow();
      if (this.audio) this.audio.turnPass();
      if (this.ai && this.state.currentPlayer !== this.match.humanPlayer) this.scheduleAI();
    }
    return res;
  }

  startClockWatch() {
    this.stopClockWatch();
    const limit = this.state?.config?.timeLimitMs;
    if (!limit) return;
    this.clockTimer = setInterval(() => {
      if (this.phase !== PHASE.ACTIVE || !this.state || this.state.status !== 'active') return;
      const player = this.state.currentPlayer;
      const used = this.state.playerTimeMs[player] + (this.platform.serverNow() - this.turnStartedAt);
      const remaining = limit - used;
      this.emit('clock', { player, remainingMs: Math.max(0, remaining), limitMs: limit });
      if (remaining <= 0) {
        this.commit({ player, type: 'timeout' });
      } else if (remaining < 5000 && Math.floor(remaining / 1000) !== Math.floor((remaining + 250) / 1000)) {
        if (this.audio) this.audio.clockWarning();
      }
    }, 250);
  }

  stopClockWatch() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  finishRound() {
    this.stopClockWatch();
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.setPhase(PHASE.RESOLVING, 'session', this.state.terminalReason);
    const m = this.match;
    const s = this.state;
    m.seriesScore[s.winner] = (m.seriesScore[s.winner] || 0) + (s.winner ? 1 : 0);
    const diffPct = m.aiDifficulty ? m.aiDifficulty.difficultyPct : 100;
    const breakdown = scoreBreakdown(s, m.humanPlayer, {
      parMs: m.par.timeMs, parMarks: m.par.marks, difficultyPct: diffPct,
    });
    this.replay.terminalResult = { winner: s.winner, reason: s.terminalReason };
    const roundResult = {
      round: m.roundIndex, winner: s.winner, reason: s.terminalReason,
      humanWon: s.winner === m.humanPlayer, draw: s.winner === 0,
      breakdown, replay: this.replay,
      humanMarks: s.marksPlaced[m.humanPlayer],
      humanTimeMs: s.playerTimeMs[m.humanPlayer],
    };
    m.rounds.push(roundResult);
    this.emit('round-end', roundResult);
    if (this.audio) {
      if (roundResult.humanWon) this.audio.win();
      else if (roundResult.draw) this.audio.draw();
      else this.audio.lose();
    }
    const delay = this.audio?.settings?.accessibility?.reducedMotion ? 400 : 1600;
    this.resolveTimer = setTimeout(() => this.afterRound(roundResult), delay);
  }

  afterRound(roundResult) {
    const m = this.match;
    const decided =
      m.seriesScore[1] >= m.seriesNeeded ||
      m.seriesScore[2] >= m.seriesNeeded ||
      (m.seriesLength === 1);
    if (!decided) {
      this.startRound();
      return;
    }
    // Series decision: draws in a 1-round match stand; otherwise most round
    // wins takes the series, tie broken by total score components order.
    let outcome;
    if (m.seriesLength === 1) {
      outcome = roundResult.humanWon ? 'win' : roundResult.draw ? 'draw' : 'loss';
    } else {
      const aiPlayer = m.humanPlayer === 1 ? 2 : 1;
      if (m.seriesScore[m.humanPlayer] > m.seriesScore[aiPlayer]) outcome = 'win';
      else if (m.seriesScore[m.humanPlayer] < m.seriesScore[aiPlayer]) outcome = 'loss';
      else outcome = 'draw';
    }
    this.finishMatch(outcome);
  }

  finishMatch(outcome) {
    const m = this.match;
    const aggregate = this.aggregateScore(outcome);
    const result = {
      matchId: m.id, mode: m.mode, contentId: m.contentId, contentName: m.contentName,
      outcome, rounds: m.rounds, seriesScore: { ...m.seriesScore },
      breakdown: aggregate, theme: m.theme, ranked: m.ranked && !this.assistsUsed(),
      assistsUsed: this.assistsUsed(),
      durationMs: this.platform.serverNow() - m.startedAt,
      stars: 0,
      achievementsUnlocked: [],
    };
    if (m.mode === 'journey' && outcome === 'win') {
      result.stars = this.computeStars();
    }
    result.achievementsUnlocked = this.recordProgress(result);
    this.setPhase(PHASE.RESULTS, 'session', 'match-complete');
    this.emit('match-end', result);
    this.setPhase(PHASE.PROGRESSION, 'session', 'results-recorded');
  }

  aggregateScore(outcome) {
    const m = this.match;
    const byKey = new Map();
    for (const r of m.rounds) {
      for (const c of r.breakdown.components) {
        byKey.set(c.key, { key: c.key, label: c.label, value: (byKey.get(c.key)?.value || 0) + c.value });
      }
    }
    const components = [...byKey.values()];
    if (m.seriesLength > 1 && outcome === 'win') {
      components.push({ key: 'series', label: `Series won (best of ${m.seriesLength})`, value: 250 });
    }
    return { components, total: components.reduce((s, c) => s + c.value, 0) };
  }

  computeStars() {
    const m = this.match;
    let stars = 1;
    const wonRounds = m.rounds.filter((r) => r.humanWon);
    if (wonRounds.some((r) => r.humanMarks <= m.par.marks)) stars = 2;
    const totalTime = m.rounds.reduce((s, r) => s + r.humanTimeMs, 0);
    if (stars === 2 && totalTime <= m.par.timeMs) stars = 3;
    return stars;
  }

  assistsUsed() {
    const a = this.match?.assists || {};
    return !!(a.timingAssistApplied || a.undoUsed || a.hintUsed);
  }

  // Persist progression and compute achievement unlocks.
  recordProgress(result) {
    const prog = this.store.loadProgression();
    const unlocked = [];
    const tryUnlock = (key) => {
      const r = unlockAchievement(prog, key, this.platform.serverNow());
      prog.achievements = r.progression.achievements;
      if (r.unlocked) unlocked.push(r.unlocked);
    };
    const wonRounds = result.rounds.filter((r) => r.humanWon).length;
    prog.stats.roundsPlayed += result.rounds.length;
    prog.stats.roundsWon += wonRounds;
    prog.stats.roundsDrawn += result.rounds.filter((r) => r.draw).length;
    prog.stats.totalScore += result.breakdown.total;
    const modeStats = (prog.stats.byMode[result.mode] ||= { played: 0, won: 0 });
    modeStats.played += 1;
    if (result.outcome === 'win') modeStats.won += 1;

    if (wonRounds > 0) tryUnlock('first_line');
    if (prog.stats.roundsPlayed >= 100) tryUnlock('century');
    if (
      result.outcome === 'win' && this.match.config.boardSize === 5 &&
      this.match.config.winLength === 4 && this.match.aiDifficulty?.id === 'expert'
    ) {
      tryUnlock('grand_slate');
    }

    if (result.mode === 'journey' && result.contentId) {
      const prev = prog.journey[result.contentId] || { stars: 0, bestScore: 0 };
      prog.journey[result.contentId] = {
        stars: Math.max(prev.stars, result.stars),
        bestScore: Math.max(prev.bestScore, result.breakdown.total),
        completedAt: this.platform.serverNow(),
      };
    }
    if (result.mode === 'challenge' && result.contentId && result.outcome === 'win') {
      const prev = prog.challenges[result.contentId] || { bestScore: 0 };
      prog.challenges[result.contentId] = {
        bestScore: Math.max(prev.bestScore, result.breakdown.total),
        completedAt: this.platform.serverNow(),
      };
    }
    if (result.mode === 'daily' && result.contentId) {
      const prev = prog.dailies[result.contentId];
      if (!prev || result.breakdown.total > prev.score) {
        prog.dailies[result.contentId] = {
          score: result.breakdown.total,
          won: result.outcome === 'win',
          completedAt: this.platform.serverNow(),
          excludedFromRanking: result.assistsUsed,
        };
      }
      const todayIso = new Date(this.platform.serverNow()).toISOString().slice(0, 10);
      if (dailyStreak(prog.dailies, todayIso) >= 5) tryUnlock('daily_streak_5');
    }
    // Mastery achievement: all journey mastery stages completed.
    if (this.masteryStageIds?.length && this.masteryStageIds.every((id) => (prog.journey[id]?.stars || 0) > 0)) {
      tryUnlock('journey_mastery');
    }
    if (LESSONS.every((l) => prog.lessons[l.id])) tryUnlock('quick_study');

    this.store.saveProgression(prog);
    if (unlocked.length && this.audio) this.audio.achievement();
    return unlocked;
  }

  // ---- undo (practice & lessons only; marks the match as assisted) ----

  canUndo() {
    if (!this.match) return false;
    if (!['practice', 'learn', 'journey'].includes(this.match.mode)) return false;
    if (this.match.ranked) return false;
    if (!this.state || this.state.status !== 'active') return false;
    return this.stateStack.length > 1;
  }

  undo() {
    if (!this.canUndo()) return { ok: false, reason: 'undo-unavailable' };
    if (this.aiTimer) clearTimeout(this.aiTimer);
    // Roll back to the most recent state where the human is to move.
    const human = this.match.humanPlayer;
    let target = null;
    for (let i = this.stateStack.length - 2; i >= 0; i--) {
      const s = this.stateStack[i];
      if (s.status === 'active' && s.currentPlayer === human) {
        target = i;
        break;
      }
    }
    if (target == null) return { ok: false, reason: 'nothing-to-undo' };
    this.stateStack = this.stateStack.slice(0, target + 1);
    this.state = this.stateStack[this.stateStack.length - 1];
    this.match.assists.undoUsed = true;
    this.turnStartedAt = this.platform.serverNow();
    this.emit('undo', { state: this.state });
    this.emit('state', this.state);
    if (this.audio) this.audio.uiBack();
    return { ok: true, state: this.state };
  }

  // ---- pause / resume (solo simulation freezes; UI never blocks rules) ----

  pause(reason = 'user') {
    if (this.phase !== PHASE.ACTIVE) return;
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.stopClockWatch();
    this.pausedAt = this.platform.serverNow();
    this.setPhase(PHASE.PAUSED, 'session', reason);
    this.saveLocalSnapshot();
  }

  resume() {
    if (this.phase !== PHASE.PAUSED) return;
    // Shift the turn clock forward by the paused span.
    this.turnStartedAt += this.platform.serverNow() - this.pausedAt;
    this.setPhase(PHASE.ACTIVE, 'session', 'resume');
    this.startClockWatch();
    if (this.ai && this.state.status === 'active' && this.state.currentPlayer !== this.match.humanPlayer) {
      this.scheduleAI();
    }
    this.emit('state', this.state);
  }

  saveLocalSnapshot() {
    if (!this.match || !this.state) return;
    this.store.saveSnapshot('active-match', {
      savedAt: this.platform.serverNow(),
      match: { ...this.match, rounds: this.match.rounds.map((r) => ({ ...r, replay: undefined })) },
      stateJson: serialize(this.state),
      stackJson: this.stateStack.map(serialize),
    });
  }

  loadLocalSnapshot() {
    const snap = this.store.loadSnapshot('active-match');
    if (!snap || !snap.stateJson) return false;
    try {
      this.match = snap.match;
      this.state = deserialize(snap.stateJson);
      this.stateStack = (snap.stackJson || [snap.stateJson]).map(deserialize);
      this.ai = this.match.aiDifficulty ? new PracticeAI(this.match.aiDifficulty.id, this.match.seed ^ 0x51ab) : null;
      this.replay = createReplayEnvelope({ seed: this.state.seed, config: this.state.config, buildVersion: BUILD_VERSION, contentVersion: CONTENT_VERSION });
      this.setPhase(PHASE.PAUSED, 'session', 'snapshot-restored');
      this.emit('state', this.state);
      return true;
    } catch {
      this.store.clearSnapshot('active-match');
      return false;
    }
  }

  hasLocalSnapshot() {
    return !!this.store.loadSnapshot('active-match');
  }

  discardLocalSnapshot() {
    this.store.clearSnapshot('active-match');
  }

  abandonMatch() {
    this.clearTimers();
    this.discardLocalSnapshot();
    this.match = null;
    this.state = null;
    this.stateStack = [];
    this.setPhase(PHASE.MODE_SELECT, 'session', 'match-abandoned');
  }

  // ---- Learn mode ----

  startLesson(lesson) {
    this.clearTimers();
    this.lesson = { def: lesson, stepIndex: 0, repliesLeft: 0 };
    const step = lesson.steps[0];
    this.match = {
      id: randomId(), mode: 'learn', contentId: lesson.id, contentName: lesson.name,
      config: { ...step.config }, seed: 1000 + lesson.index, aiDifficulty: step.ai ? difficultyById(step.ai) : null,
      humanPlayer: 1, seriesLength: 1, seriesNeeded: 1, roundIndex: 1, rounds: [],
      seriesScore: { 1: 0, 2: 0 }, theme: 'slate', ranked: false, assists: {},
      par: { marks: 5, timeMs: 600000 }, goals: ['lesson'], startedAt: this.platform.serverNow(),
    };
    this.ai = step.ai ? new PracticeAI(step.ai, 4242) : null;
    this.state = createInitialState(this.match.config, this.match.seed);
    this.stateStack = [this.state];
    this.setPhase(PHASE.TUTORIAL, 'session', `lesson-${lesson.id}-step-0`);
    this.emit('lesson-step', this.lessonStepInfo());
    this.emit('state', this.state);
    this.turnStartedAt = this.platform.serverNow();
  }

  lessonStepInfo() {
    const { def, stepIndex } = this.lesson;
    const step = def.steps[stepIndex];
    return {
      lesson: def, step, stepIndex, totalSteps: def.steps.length,
      highlightCells: step.highlightCells || [],
      isLast: stepIndex === def.steps.length - 1,
    };
  }

  lessonPlace(cell) {
    if (this.phase !== PHASE.TUTORIAL || !this.lesson) return { ok: false, reason: 'not-in-lesson' };
    const { def, stepIndex } = this.lesson;
    const step = def.steps[stepIndex];
    const req = step.require;
    if (this.state.status !== 'active') return { ok: false, reason: 'not-active' };
    if (this.state.currentPlayer !== this.match.humanPlayer) return { ok: false, reason: 'out-of-turn' };

    // Requirement check happens BEFORE committing, using the same legality API.
    const legal = legalCells(this.state, this.match.humanPlayer);
    if (!legal.includes(cell)) {
      this.emit('invalid', { reason: this.state.board[cell] ? 'cell-occupied' : 'out-of-bounds', cell, player: 1 });
      return { ok: false, reason: 'illegal' };
    }
    if (req.kind === 'place-cell' && req.cell !== cell) {
      this.emit('invalid', { reason: 'lesson-wrong-cell', cell, player: 1 });
      return { ok: false, reason: 'wrong-cell' };
    }
    const res = this.commitLessonMove(cell);
    if (!res.ok) return res;
    this.afterLessonMove(step);
    return res;
  }

  commitLessonMove(cell) {
    const cmd = {
      id: `${this.match.id}-t${this.state.turnNumber}`,
      player: this.state.currentPlayer, type: 'place', cell,
      elapsedMs: Math.max(0, this.platform.serverNow() - this.turnStartedAt),
    };
    const res = applyCommand(this.state, cmd);
    if (!res.ok) {
      this.emit('invalid', { reason: res.reason, cell, player: cmd.player });
      return res;
    }
    this.state = res.state;
    this.stateStack.push(this.state);
    this.emit('move', { cmd, state: this.state });
    this.emit('state', this.state);
    if (this.audio) this.audio.placeImpact(cmd.player);
    return res;
  }

  afterLessonMove(step) {
    const req = step.require;
    const s = this.state;
    const human = this.match.humanPlayer;
    const terminal = s.status === 'terminal';
    const humanWon = terminal && s.winner === human;
    const humanLost = terminal && s.winner !== 0 && s.winner !== human;

    if (humanLost || (req.kind === 'win' && terminal && !humanWon)) {
      this.emit('lesson-failed-step', { text: 'That did not meet the goal. The step resets — try again.' });
      this.resetLessonStep();
      return;
    }
    if (req.kind === 'win' && humanWon) return this.advanceLessonStep();
    if (req.kind === 'finish-round' && terminal) return this.advanceLessonStep();
    if (req.kind === 'place-cell') return this.advanceLessonStep();

    if (req.kind === 'place-any') {
      if (!step.ai) return this.advanceLessonStep();
      this.lesson.placed = (this.lesson.placed || 0) + 1;
      const exchangesNeeded = step.aiReplies || 1;
      if (terminal) return this.advanceLessonStep();
      if (this.lesson.placed >= exchangesNeeded) this.lesson.advanceAfterAi = true;
      this.scheduleLessonAi();
      return;
    }
    // win / finish-round still open: the scripted rival replies.
    if (step.ai && !terminal) this.scheduleLessonAi();
  }

  scheduleLessonAi() {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.aiTimer = setTimeout(() => this.lessonAiMove(), 650);
  }

  lessonAiMove() {
    if (!this.lesson || this.state.status !== 'active') return;
    const step = this.lesson.def.steps[this.lesson.stepIndex];
    const human = this.match.humanPlayer;
    const cell = this.ai.chooseCell(this.state, this.state.currentPlayer);
    if (cell < 0) return;
    this.commitLessonMove(cell);
    if (this.state.status === 'terminal') {
      const lost = this.state.winner !== 0 && this.state.winner !== human;
      if (step.require.kind === 'finish-round' && !lost) return this.advanceLessonStep();
      if (step.require.kind === 'place-any') return this.advanceLessonStep();
      this.emit('lesson-failed-step', { text: 'The rival got there first. The step resets — try again.' });
      this.resetLessonStep();
      return;
    }
    if (this.lesson.advanceAfterAi) {
      this.lesson.advanceAfterAi = false;
      return this.advanceLessonStep();
    }
    this.turnStartedAt = this.platform.serverNow();
  }

  advanceLessonStep() {
    const { def } = this.lesson;
    if (this.aiTimer) clearTimeout(this.aiTimer);
    if (this.lesson.stepIndex + 1 >= def.steps.length) {
      // Lesson complete.
      const prog = this.store.loadProgression();
      prog.lessons[def.id] = { completedAt: this.platform.serverNow() };
      const unlocked = [];
      if (LESSONS.every((l) => prog.lessons[l.id])) {
        const r = unlockAchievement(prog, 'quick_study', this.platform.serverNow());
        prog.achievements = r.progression.achievements;
        if (r.unlocked) unlocked.push(r.unlocked);
      }
      this.store.saveProgression(prog);
      this.setPhase(PHASE.RESULTS, 'session', 'lesson-complete');
      this.emit('lesson-complete', { lesson: def, achievementsUnlocked: unlocked });
      return;
    }
    this.lesson.stepIndex += 1;
    this.resetLessonStep(true);
  }

  resetLessonStep(advanced = false) {
    const step = this.lesson.def.steps[this.lesson.stepIndex];
    this.lesson.placed = 0;
    this.lesson.advanceAfterAi = false;
    this.state = createInitialState({ ...step.config }, this.match.seed + this.lesson.stepIndex);
    this.stateStack = [this.state];
    this.ai = step.ai ? new PracticeAI(step.ai, 4242 + this.lesson.stepIndex) : null;
    this.turnStartedAt = this.platform.serverNow();
    this.setPhase(PHASE.TUTORIAL, 'session', `lesson-step-${this.lesson.stepIndex}`);
    this.emit('lesson-step', this.lessonStepInfo());
    this.emit('state', this.state);
    this.emit(advanced ? 'lesson-advanced' : 'lesson-reset', {});
  }

  snapshotInfo() {
    const m = this.match;
    return {
      round: m.roundIndex, seriesLength: m.seriesLength, seriesScore: { ...m.seriesScore },
      humanPlayer: m.humanPlayer, config: this.state.config, seed: this.state.seed,
    };
  }

  clearTimers() {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.aiTimer = null;
    this.resolveTimer = null;
    this.stopClockWatch();
  }
}
