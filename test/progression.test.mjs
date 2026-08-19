import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, PHASE } from '../js/session.js';
import { Store } from '../js/storage.js';

function makeSession(ns) {
  const store = new Store(ns);
  store.persistent = false;
  const platform = { serverNow: () => Date.now(), track() {}, startActivity() {}, endActivity() {} };
  return { session: new GameSession({ platform, store, audio: null }), store };
}

function fastForward(session) {
  if (session.phase === PHASE.COUNTDOWN) {
    clearTimeout(session.resolveTimer);
    session.beginTurn();
  }
}

// Drive both sides manually: clears the AI timer and commits scripted moves.
function scriptedRound(session, moves) {
  for (const [player, cell] of moves) {
    if (session.state.status !== 'active') break;
    clearTimeout(session.aiTimer);
    assert.equal(session.state.currentPlayer, player, `expected player ${player} to move`);
    const res = session.commit({ player, type: 'place', cell });
    assert.ok(res.ok, res.reason);
  }
}

function settle(session) {
  clearTimeout(session.resolveTimer);
  session.afterRound(session.match.rounds[session.match.rounds.length - 1]);
}

test('journey win records stars, unlocks achievements and persists', () => {
  const { session, store } = makeSession('jt-' + Math.random());
  let result = null;
  session.on('match-end', (r) => { result = r; });
  session.startMatch({
    mode: 'journey', contentId: 'stage-01', contentName: 'Stage 1',
    config: {}, seed: 123, ai: 'casual', humanPlayer: 1, series: 1, theme: 'slate',
    par: { marks: 5, timeMs: 90000 }, ranked: false, assists: {},
  });
  fastForward(session);
  scriptedRound(session, [[1, 0], [2, 3], [1, 1], [2, 4], [1, 2]]);
  assert.equal(session.state.winner, 1);
  settle(session);
  assert.ok(result);
  assert.equal(result.outcome, 'win');
  assert.ok(result.stars >= 1);
  assert.ok(result.achievementsUnlocked.includes('first_line'));
  const prog = store.loadProgression();
  assert.ok(prog.journey['stage-01'].stars >= 1);
  assert.ok(prog.achievements.first_line);
  assert.ok(prog.stats.roundsPlayed >= 1);
  session.clearTimers();
});

test('daily result and streak bookkeeping', () => {
  const { session, store } = makeSession('dt-' + Math.random());
  session.startMatch({
    mode: 'daily', contentId: 'daily-2026-08-19', contentName: 'Daily',
    config: {}, seed: 5, ai: 'casual', humanPlayer: 1, series: 1, theme: 'slate',
    par: { marks: 5, timeMs: 90000 }, ranked: true, assists: {},
  });
  fastForward(session);
  scriptedRound(session, [[1, 0], [2, 3], [1, 1], [2, 4], [1, 2]]);
  settle(session);
  const prog = store.loadProgression();
  const entry = prog.dailies['daily-2026-08-19'];
  assert.ok(entry);
  assert.equal(entry.won, true);
  assert.ok(entry.score > 0);
  session.clearTimers();
});

test('assists mark a ranked match unranked', () => {
  const { session } = makeSession('at-' + Math.random());
  let result = null;
  session.on('match-end', (r) => { result = r; });
  session.startMatch({
    mode: 'daily', contentId: 'daily-x', contentName: 'Daily',
    config: {}, seed: 5, ai: 'casual', humanPlayer: 1, series: 1, theme: 'slate',
    par: { marks: 5, timeMs: 90000 }, ranked: true, assists: { timingAssist: true },
  });
  fastForward(session);
  scriptedRound(session, [[1, 0], [2, 3], [1, 1], [2, 4], [1, 2]]);
  settle(session);
  assert.equal(result.ranked, false);
  assert.ok(result.assistsUsed);
  session.clearTimers();
});

test('best-of-3 series outcome and series bonus component', () => {
  const { session } = makeSession('st-' + Math.random());
  let result = null;
  session.on('match-end', (r) => { result = r; });
  session.startMatch({
    mode: 'practice', contentId: null, contentName: 'Bo3',
    config: {}, seed: 9, ai: 'casual', humanPlayer: 1, series: 3, theme: 'slate',
    par: { marks: 5, timeMs: 240000 }, ranked: false, assists: {},
  });
  // Round 1: human wins. firstPlayer alternates each round.
  fastForward(session);
  scriptedRound(session, [[1, 0], [2, 3], [1, 1], [2, 4], [1, 2]]);
  settle(session);
  assert.equal(result, null, 'series not decided after round 1');
  // Round 2: player 2 opens (alternation); human still wins.
  fastForward(session);
  assert.equal(session.state.currentPlayer, 2);
  scriptedRound(session, [[2, 3], [1, 0], [2, 4], [1, 1], [2, 8], [1, 2]]);
  assert.equal(session.state.winner, 1);
  settle(session);
  assert.ok(result, 'series decided after round 2');
  assert.equal(result.outcome, 'win');
  assert.deepEqual(result.seriesScore, { 1: 2, 2: 0 });
  assert.ok(result.breakdown.components.some((c) => c.key === 'series' && c.value === 250));
  session.clearTimers();
});
