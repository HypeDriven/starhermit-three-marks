import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, PHASE } from '../js/session.js';
import { Store } from '../js/storage.js';
import { createGame, applyCommand as serverApply, getResult, serialize as serverSerialize, deserialize as serverDeserialize } from '../server.js';
import { replayEnvelope } from '../js/rules.js';
import { LESSONS } from '../js/content.js';

import { PracticeAI } from '../js/ai.js';

// localStorage-free store (uses in-memory fallback).
function makeSession() {
  const store = new Store('test-' + Math.random().toString(36).slice(2));
  store.persistent = false;
  const platform = {
    serverNow: () => Date.now(),
    track() {}, startActivity() {}, endActivity() {},
  };
  const session = new GameSession({ platform, store, audio: null });
  return { session, store };
}

function fastForward(session) {
  // Skip countdown.
  if (session.phase === PHASE.COUNTDOWN) {
    clearTimeout(session.resolveTimer);
    session.beginTurn();
  }
}

function playHumanRound(session, cells) {
  // Play a scripted human sequence; AI replies automatically (flush timers).
  for (const cell of cells) {
    if (session.state.status !== 'active') break;
    if (session.state.currentPlayer !== session.match.humanPlayer) {
      // flush AI timer synchronously
      clearTimeout(session.aiTimer);
      const aiPlayer = session.state.currentPlayer;
      const aiCell = session.ai.chooseCell(session.state, aiPlayer);
      session.commit({ player: aiPlayer, type: 'place', cell: aiCell });
    }
    if (session.state.status !== 'active') break;
    session.placeCell(cell);
  }
}

test('match lifecycle: countdown -> active -> resolving -> results', async () => {
  const { session } = makeSession();
  const phases = [];
  session.on('phase', ({ phase }) => phases.push(phase));
  let matchEnd = null;
  session.on('match-end', (r) => { matchEnd = r; });
  session.startMatch({
    mode: 'practice', config: {}, seed: 42, ai: 'casual', humanPlayer: 1,
    series: 1, theme: 'slate', par: { marks: 5, timeMs: 90000 }, ranked: false, assists: {},
    contentName: 'Test',
  });
  assert.equal(session.phase, PHASE.COUNTDOWN);
  fastForward(session);
  assert.equal(session.phase, PHASE.ACTIVE);
  playHumanRound(session, [0, 1, 2, 3, 4]);
  assert.equal(session.state.status, 'terminal');
  assert.equal(session.phase, PHASE.RESOLVING);
  clearTimeout(session.resolveTimer);
  session.afterRound(session.match.rounds[session.match.rounds.length - 1]);
  assert.ok(matchEnd, 'match-end emitted');
  assert.ok(['win', 'loss', 'draw'].includes(matchEnd.outcome));
  assert.ok(Number.isInteger(matchEnd.breakdown.total));
  assert.ok(matchEnd.breakdown.components.length >= 2, 'component breakdown present');
  session.clearTimers();
});

test('undo restores the human turn in practice and marks the match assisted', () => {
  const { session } = makeSession();
  session.startMatch({
    mode: 'practice', config: {}, seed: 7, ai: 'casual', humanPlayer: 1,
    series: 1, theme: 'slate', par: { marks: 5, timeMs: 90000 }, ranked: false, assists: {}, contentName: 'T',
  });
  fastForward(session);
  playHumanRound(session, [4]); // human + AI reply
  assert.ok(session.stateStack.length >= 2);
  const before = session.state.turnNumber;
  const res = session.undo();
  assert.ok(res.ok);
  assert.equal(session.state.currentPlayer, session.match.humanPlayer);
  assert.ok(session.state.turnNumber < before);
  assert.ok(session.assistsUsed());
  session.clearTimers();
});

test('undo rejected where rules do not permit (daily)', () => {
  const { session } = makeSession();
  session.startMatch({
    mode: 'daily', config: {}, seed: 7, ai: 'casual', humanPlayer: 1,
    series: 1, theme: 'slate', par: { marks: 5, timeMs: 90000 }, ranked: true, assists: {}, contentName: 'T',
  });
  fastForward(session);
  playHumanRound(session, [4]);
  assert.equal(session.canUndo(), false);
  assert.equal(session.undo().ok, false);
  session.clearTimers();
});

test('every lesson can be completed through the lesson API', () => {
  for (const lesson of LESSONS) {
    const { session } = makeSession();
    let completed = false;
    session.on('lesson-complete', () => { completed = true; });
    session.startLesson(lesson);
    let guard = 0;
    while (!completed && guard++ < 60) {
      const info = session.lessonStepInfo();
      const req = info.step.require;
      const legal = session.state.board.map((v, i) => (v === 0 && !session.state.config.disabledCells.includes(i) ? i : -1)).filter((i) => i >= 0);
      if (session.state.currentPlayer !== session.match.humanPlayer) {
        // flush AI
        clearTimeout(session.aiTimer);
        session.lessonAiMove();
        continue;
      }
      let cell;
      if (req.kind === 'place-cell') cell = req.cell;
      else if (req.kind === 'win' && info.highlightCells.length) cell = info.highlightCells[0];
      else {
        // Play well: an expert picks the human's cells in free-play lessons.
        const advisor = new PracticeAI('expert', 1);
        cell = advisor.chooseCell(session.state, session.match.humanPlayer);
        if (cell < 0 || !legal.includes(cell)) cell = legal[0];
      }
      session.lessonPlace(cell);
    }
    assert.ok(completed, `lesson ${lesson.id} completed`);
    session.clearTimers();
  }
});


test('snapshot round-trip restores an interrupted match', () => {
  const { session } = makeSession();
  session.startMatch({
    mode: 'practice', config: {}, seed: 11, ai: 'skilled', humanPlayer: 1,
    series: 3, theme: 'slate', par: { marks: 5, timeMs: 90000 }, ranked: false, assists: {}, contentName: 'T',
  });
  fastForward(session);
  playHumanRound(session, [4]);
  session.pause('test');
  session.saveLocalSnapshot();
  const turn = session.state.turnNumber;
  const { session: restored } = makeSession();
  // share the store by monkey-patching loadSnapshot
  restored.store.loadSnapshot = () => session.store.loadSnapshot('active-match');
  assert.ok(restored.loadLocalSnapshot());
  assert.equal(restored.state.turnNumber, turn);
  assert.equal(restored.phase, PHASE.PAUSED);
  session.clearTimers();
  restored.clearTimers();
});

test('replay envelope stays valid after an invalid action', () => {
  // A rejected command still counts an invalid action in authoritative state,
  // so the replay must record and reproduce it (the accepted-only log could
  // never match a hash that embedded the invalid count).
  const { session } = makeSession();
  session.startMatch({
    mode: 'practice', config: {}, seed: 5, ai: 'casual', humanPlayer: 1,
    series: 1, theme: 'slate', par: { marks: 5, timeMs: 90000 }, ranked: false, assists: {}, contentName: 'T',
  });
  fastForward(session);
  session.commit({ player: 1, type: 'place', cell: 0 });
  const bad = session.commit({ player: 2, type: 'place', cell: 0 }); // occupied
  assert.equal(bad.ok, false);
  session.commit({ player: 2, type: 'place', cell: 1 });
  assert.equal(session.state.invalidActions[2], 1);
  const rep = replayEnvelope(session.replay);
  assert.ok(rep.ok, rep.reason);
  assert.equal(rep.state.invalidActions[2], 1);
  session.clearTimers();
});

test('series of 3 requires two round wins', () => {
  const { session } = makeSession();
  let matchEnd = null;
  session.on('match-end', (r) => { matchEnd = r; });
  session.startMatch({
    mode: 'practice', config: {}, seed: 3, ai: 'casual', humanPlayer: 1,
    series: 3, theme: 'slate', par: { marks: 5, timeMs: 90000 }, ranked: false, assists: {}, contentName: 'T',
  });
  let guard = 0;
  while (!matchEnd && guard++ < 10) {
    fastForward(session);
    playHumanRound(session, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(session.state.status, 'terminal');
    clearTimeout(session.resolveTimer);
    session.afterRound(session.match.rounds[session.match.rounds.length - 1]);
  }
  assert.ok(matchEnd);
  const total = matchEnd.seriesScore[1] + matchEnd.seriesScore[2];
  assert.ok(matchEnd.seriesScore[1] >= 2 || matchEnd.seriesScore[2] >= 2 || matchEnd.rounds.length === 3);
  session.clearTimers();
});

// ---- server script contract ----

test('authoritative server script: membership, turns, idempotency, result', () => {
  const now = Date.now();
  const game = createGame({
    sessionId: 's1',
    players: [{ id: 'alice', seat: 1 }, { id: 'bob', seat: 2 }],
    seed: 99, config: {}, now,
  });
  // non-member rejected
  assert.equal(serverApply(game, 'mallory', { type: 'place', cell: 0 }, now).ok, false);
  // out-of-turn rejected
  assert.equal(serverApply(game, 'bob', { type: 'place', cell: 0 }, now).reason, 'out-of-turn');
  // identity spoofing impossible: payload player is ignored, seat comes from auth
  const r1 = serverApply(game, 'alice', { id: 'c1', player: 2, type: 'place', cell: 0 }, now);
  assert.ok(r1.ok);
  assert.equal(game.state.board[0], 1);
  // duplicate id idempotent
  const dup = serverApply(game, 'bob', { id: 'c1', type: 'place', cell: 1 }, now);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate-command');
  // play to a result
  serverApply(game, 'bob', { id: 'c2', type: 'place', cell: 3 }, now);
  serverApply(game, 'alice', { id: 'c3', type: 'place', cell: 1 }, now);
  serverApply(game, 'bob', { id: 'c4', type: 'place', cell: 4 }, now);
  const r5 = serverApply(game, 'alice', { id: 'c5', type: 'place', cell: 2 }, now);
  assert.ok(r5.ok);
  const result = getResult(game);
  assert.equal(result.winner, 'alice');
  assert.equal(result.reason, 'line-complete');
  assert.ok(Number.isInteger(result.scores.alice));
  // commands after finish rejected
  assert.equal(serverApply(game, 'bob', { type: 'place', cell: 5 }, now).ok, false);
  // serialization round-trip preserves the result
  const restored = serverDeserialize(serverSerialize(game));
  assert.equal(restored.finished.winner, 'alice');
});

test('authoritative server script: turn deadline forfeits the stalled player', () => {
  const now = Date.now();
  const game = createGame({
    sessionId: 's2',
    players: [{ id: 'alice', seat: 1 }, { id: 'bob', seat: 2 }],
    seed: 1, config: {}, now,
  });
  const late = serverApply(game, 'alice', { type: 'place', cell: 0 }, now + 61000);
  assert.equal(late.reason, 'turn-expired');
  const result = getResult(game);
  assert.equal(result.winner, 'bob');
  assert.equal(result.reason, 'timeout');
});

test('pause and resume work from countdown and tutorial phases', () => {
  // Countdown: the pending round-opening timer must be frozen, and resume
  // must run the round opening (not skip it).
  const { session } = makeSession();
  session.startMatch({
    mode: 'practice', config: {}, seed: 13, ai: 'casual', humanPlayer: 1,
    series: 1, theme: 'slate', par: { marks: 5, timeMs: 90000 }, ranked: false, assists: {}, contentName: 'T',
  });
  assert.equal(session.phase, PHASE.COUNTDOWN);
  assert.ok(session.isPausable());
  assert.ok(session.pause('user'));
  assert.equal(session.phase, PHASE.PAUSED);
  assert.equal(session.resolveTimer, null, 'countdown timer cleared');
  session.resume();
  assert.equal(session.phase, PHASE.ACTIVE, 'resume ran the round opening');
  assert.equal(session.state.status, 'active');
  session.clearTimers();

  // Tutorial: pause freezes the lesson (and its AI timer); resume returns to
  // the tutorial phase instead of dropping into a plain active match.
  const { session: s2 } = makeSession();
  s2.startLesson(LESSONS[1]); // lesson with an AI rival
  assert.equal(s2.phase, PHASE.TUTORIAL);
  s2.lessonPlace(4); // triggers the scripted rival reply timer
  assert.ok(s2.aiTimer, 'lesson AI reply scheduled');
  assert.ok(s2.pause('user'));
  assert.equal(s2.aiTimer, null, 'lesson AI timer frozen');
  s2.resume();
  assert.equal(s2.phase, PHASE.TUTORIAL, 'resume restores tutorial phase');
  s2.clearTimers();
});

test('lesson matches are not snapshotted for resume', () => {
  const { session } = makeSession();
  session.startLesson(LESSONS[0]);
  session.saveLocalSnapshot();
  assert.equal(session.store.loadSnapshot('active-match'), null);
  session.clearTimers();
});

test('daily: an unranked replay never overwrites the ranked record', () => {
  const { session } = makeSession();
  session.match = { config: {}, aiDifficulty: null }; // recordProgress context
  const base = {
    mode: 'daily', contentId: 'daily-2099-01-01', outcome: 'win',
    rounds: [], breakdown: { components: [], total: 500 },
    assistsUsed: false, ranked: true,
  };
  session.recordProgress(base);
  let rec = session.store.loadProgression().dailies['daily-2099-01-01'];
  assert.equal(rec.score, 500);
  assert.equal(rec.excludedFromRanking, false);
  // A higher-scoring unranked replay must not touch the ranked entry.
  session.recordProgress({ ...base, ranked: false, breakdown: { components: [], total: 900 } });
  rec = session.store.loadProgression().dailies['daily-2099-01-01'];
  assert.equal(rec.score, 500, 'unranked replay did not overwrite');
  // A first attempt with no prior record is still recorded, flagged excluded.
  session.recordProgress({
    ...base, contentId: 'daily-2099-01-02', ranked: false, assistsUsed: true,
    breakdown: { components: [], total: 300 },
  });
  rec = session.store.loadProgression().dailies['daily-2099-01-02'];
  assert.equal(rec.score, 300);
  assert.equal(rec.excludedFromRanking, true);
});


test('snapshot restores remaining turn time, replay and original retry options', () => {
  const { session, store } = makeSession();
  let now = 10000;
  session.platform.serverNow = () => now;
  const options = { mode: 'practice', seed: 37, config: { timeLimitMs: 60000 }, assists: { timingAssist: true } };
  session.startMatch(options);
  fastForward(session);
  now += 2400;
  session.pause();
  const restored = new GameSession({ platform: session.platform, store, audio: null });
  now += 120000;
  assert.equal(restored.loadLocalSnapshot(), true);
  assert.deepEqual(restored.match.initialOptions, options);
  assert.deepEqual(restored.replay, session.replay);
  restored.resume();
  assert.equal(now - restored.turnStartedAt, 2400);
  assert.equal(restored.phase, PHASE.ACTIVE);
  session.clearTimers(); restored.clearTimers();
});
