import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState, applyCommand, legalCells, legalActions, findWinLine,
  scoreBreakdown, compareResults, serialize, deserialize, stateHash,
  createReplayEnvelope, replayEnvelope, INVALID, TERMINAL, migrate,
} from '../js/rules.js';
import { RngStream, hashString } from '../js/rng.js';
import { PracticeAI } from '../js/ai.js';

function place(state, player, cell, extra = {}) {
  const res = applyCommand(state, { id: `c${state.turnNumber}-${player}-${cell}`, player, type: 'place', cell, ...extra });
  assert.equal(res.ok, true, `place p${player}@${cell} failed: ${res.reason}`);
  return res.state;
}

test('initial state is well-formed and serializable', () => {
  const s = createInitialState({}, 42);
  assert.equal(s.board.length, 9);
  assert.equal(s.currentPlayer, 1);
  assert.equal(s.turnNumber, 1);
  assert.equal(s.status, 'active');
  assert.equal(legalCells(s, 1).length, 9);
  assert.equal(legalCells(s, 2).length, 0); // out of turn -> no actions
  const round = deserialize(serialize(s));
  assert.equal(stateHash(round), stateHash(s));
});

test('win detection across rows, columns, diagonals', () => {
  // row
  let s = createInitialState({}, 1);
  s = place(s, 1, 0); s = place(s, 2, 3); s = place(s, 1, 1); s = place(s, 2, 4); s = place(s, 1, 2);
  assert.equal(s.status, 'terminal');
  assert.equal(s.terminalReason, TERMINAL.LINE);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.winLine, [0, 1, 2]);
  // diagonal
  s = createInitialState({}, 1);
  s = place(s, 1, 0); s = place(s, 2, 1); s = place(s, 1, 4); s = place(s, 2, 2); s = place(s, 1, 8);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.winLine, [0, 4, 8]);
  // column on 4x4 win-4
  s = createInitialState({ boardSize: 4, winLength: 4 }, 1);
  s = place(s, 1, 0); s = place(s, 2, 1); s = place(s, 1, 4); s = place(s, 2, 2);
  s = place(s, 1, 8); s = place(s, 2, 3); s = place(s, 1, 12);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.winLine, [0, 4, 8, 12]);
});

test('draw when board fills with no line', () => {
  let s = createInitialState({}, 7);
  // X O X / X O O / O X X
  const seq = [[1, 0], [2, 1], [1, 2], [2, 4], [1, 3], [2, 5], [1, 7], [2, 6], [1, 8]];
  for (const [p, c] of seq) s = place(s, p, c);
  assert.equal(s.status, 'terminal');
  assert.equal(s.terminalReason, TERMINAL.FULL);
  assert.equal(s.winner, 0);
});

test('invalid actions carry reasons and count against the actor', () => {
  let s = createInitialState({}, 1);
  s = place(s, 1, 4);
  let r = applyCommand(s, { player: 2, type: 'place', cell: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INVALID.CELL_OCCUPIED);
  assert.equal(r.state.invalidActions[2], 1);
  r = applyCommand(s, { player: 1, type: 'place', cell: 0 });
  assert.equal(r.reason, INVALID.OUT_OF_TURN);
  r = applyCommand(s, { player: 2, type: 'place', cell: 99 });
  assert.equal(r.reason, INVALID.OUT_OF_BOUNDS);
  r = applyCommand(s, { player: 2, type: 'place', cell: -1 });
  assert.equal(r.reason, INVALID.OUT_OF_BOUNDS);
  // disabled cell
  s = createInitialState({ disabledCells: [4] }, 1);
  r = applyCommand(s, { player: 1, type: 'place', cell: 4 });
  assert.equal(r.reason, INVALID.CELL_DISABLED);
  assert.equal(legalCells(s, 1).length, 8);
});

test('duplicate command ids rejected idempotently without penalty', () => {
  let s = createInitialState({}, 1);
  const before = s.invalidActions[1];
  const r1 = applyCommand(s, { id: 'x1', player: 1, type: 'place', cell: 0 });
  assert.equal(r1.ok, true);
  const r2 = applyCommand(r1.state, { id: 'x1', player: 2, type: 'place', cell: 1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, INVALID.DUPLICATE);
  assert.equal(r2.state.invalidActions[2], 0);
  assert.equal(before, 0);
});

test('commands after terminal are rejected', () => {
  let s = createInitialState({}, 1);
  s = place(s, 1, 0); s = place(s, 2, 3); s = place(s, 1, 1); s = place(s, 2, 4); s = place(s, 1, 2);
  const r = applyCommand(s, { player: 2, type: 'place', cell: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INVALID.GAME_OVER);
  assert.equal(legalActions(s, 1).length, 0);
});

test('move limit ends the round for the limited player', () => {
  let s = createInitialState({ moveLimit: 2 }, 1);
  s = place(s, 1, 0); s = place(s, 2, 3); s = place(s, 1, 4);
  assert.equal(s.status, 'terminal');
  assert.equal(s.terminalReason, TERMINAL.MOVE_LIMIT);
  assert.equal(s.winner, 2);
});

test('misere: completing a line loses', () => {
  let s = createInitialState({ misere: true }, 1);
  s = place(s, 1, 0); s = place(s, 2, 3); s = place(s, 1, 1); s = place(s, 2, 4); s = place(s, 1, 2);
  assert.equal(s.terminalReason, TERMINAL.LINE);
  assert.equal(s.winner, 2);
});

test('resign and timeout terminal reasons', () => {
  let s = createInitialState({}, 1);
  let r = applyCommand(s, { player: 1, type: 'resign' });
  assert.equal(r.ok, true);
  assert.equal(r.state.terminalReason, TERMINAL.RESIGN);
  assert.equal(r.state.winner, 2);
  // timeout requires the clock to actually be exhausted
  s = createInitialState({ timeLimitMs: 1000 }, 1);
  r = applyCommand(s, { player: 1, type: 'timeout', elapsedMs: 500 });
  assert.equal(r.ok, false);
  s = place(s, 1, 0, { elapsedMs: 1200 });
  r = applyCommand(s, { player: 2, type: 'place', cell: 1, elapsedMs: 1500 });
  assert.equal(r.ok, true);
  r = applyCommand(r.state, { player: 1, type: 'timeout' });
  assert.equal(r.ok, true);
  assert.equal(r.state.terminalReason, TERMINAL.TIMEOUT);
  assert.equal(r.state.winner, 2);
});

test('turn number increases monotonically', () => {
  let s = createInitialState({}, 1);
  let prev = s.turnNumber;
  for (const [p, c] of [[1, 0], [2, 1], [1, 2]]) {
    s = place(s, p, c);
    assert.ok(s.turnNumber > prev);
    prev = s.turnNumber;
  }
});

test('scoring exposes integer component breakdown', () => {
  let s = createInitialState({}, 1);
  s = place(s, 1, 0); s = place(s, 2, 3); s = place(s, 1, 1); s = place(s, 2, 4); s = place(s, 1, 2);
  const b = scoreBreakdown(s, 1, { parMs: 60000, difficultyPct: 150 });
  assert.ok(b.won);
  assert.ok(Number.isInteger(b.total));
  const sum = b.components.reduce((t, c) => t + c.value, 0);
  assert.equal(sum, b.total);
  assert.ok(b.components.some((c) => c.key === 'objective' && c.value === 1000));
  assert.ok(b.components.some((c) => c.key === 'difficulty'));
  const loser = scoreBreakdown(s, 2);
  assert.equal(loser.components.find((c) => c.key === 'objective').value, 0);
});

test('tie-break order: objective, invalids, elapsed, session id', () => {
  const base = { won: true, draw: false, invalidActions: 0, elapsedMs: 1000, sessionId: 'a' };
  assert.ok(compareResults(base, { ...base, won: false }) < 0);
  assert.ok(compareResults(base, { ...base, invalidActions: 1 }) < 0);
  assert.ok(compareResults(base, { ...base, elapsedMs: 2000 }) < 0);
  assert.ok(compareResults(base, { ...base, sessionId: 'b' }) < 0);
  assert.equal(compareResults(base, { ...base }), 0);
});

test('migration from unversioned state', () => {
  const legacy = { config: { boardSize: 3 }, seed: 5, board: [1, 0, 0, 0, 2, 0, 0, 0, 0], currentPlayer: 1, turnNumber: 3, status: 'active' };
  const m = migrate(legacy);
  assert.equal(m.version, 1);
  assert.deepEqual(m.marksPlaced, { 1: 1, 2: 1 });
  assert.deepEqual(m.appliedCommandIds, []);
});

test('replay determinism: same seed + commands => identical hashes', () => {
  const play = () => {
    const env = createReplayEnvelope({ seed: 99, config: {}, buildVersion: 't', contentVersion: 1 });
    let s = createInitialState(env.config, env.seed);
    const rng = new RngStream(7);
    while (s.status === 'active') {
      const cells = legalCells(s, s.currentPlayer);
      const cell = cells[Math.floor(rng.next() * cells.length)];
      const cmd = { id: `m${s.turnNumber}`, player: s.currentPlayer, type: 'place', cell };
      const res = applyCommand(s, cmd);
      assert.ok(res.ok);
      s = res.state;
      env.commands.push(cmd);
      env.stateHashes.push(stateHash(s));
    }
    env.terminalResult = { winner: s.winner, reason: s.terminalReason };
    return env;
  };
  const a = play();
  const b = play();
  assert.deepEqual(a, b);
  const rep = replayEnvelope(a);
  assert.ok(rep.ok, rep.reason);
  assert.equal(stateHash(rep.state), a.stateHashes[a.stateHashes.length - 1]);
  const tampered = { ...a, stateHashes: a.stateHashes.slice() };
  tampered.stateHashes[0] = 'deadbeef';
  assert.equal(replayEnvelope(tampered).ok, false);
});

test('expert AI never loses on 3x3 (property sweep over seeds)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    let s = createInitialState({}, seed);
    const ai = new PracticeAI('expert', seed * 31);
    const human = new RngStream(seed * 97);
    while (s.status === 'active') {
      const cells = legalCells(s, s.currentPlayer);
      const cell = s.currentPlayer === 2 ? ai.chooseCell(s, 2) : human.pick(cells);
      s = applyCommand(s, { player: s.currentPlayer, type: 'place', cell }).state;
    }
    assert.notEqual(s.winner, 1, `expert lost on seed ${seed}`);
  }
});

test('AI is deterministic for the same seed', () => {
  const s = createInitialState({}, 3);
  const a = new PracticeAI('skilled', 123);
  const b = new PracticeAI('skilled', 123);
  assert.equal(a.chooseCell(s, 1), b.chooseCell(s, 1));
});

test('AI plays sensibly on larger boards without runaway search', () => {
  const s = createInitialState({ boardSize: 5, winLength: 4 }, 11);
  const ai = new PracticeAI('expert', 5);
  const t0 = Date.now();
  const cell = ai.chooseCell(s, 1);
  assert.ok(legalCells(s, 1).includes(cell));
  assert.ok(Date.now() - t0 < 5000, 'search took too long');
});

test('fuzz: malformed commands never hang or corrupt state', () => {
  const rng = new RngStream(2024);
  for (let i = 0; i < 500; i++) {
    let s = createInitialState({ boardSize: rng.int(3, 5), winLength: 3 }, rng.int(1, 1e9));
    for (let step = 0; step < 30 && s.status === 'active'; step++) {
      const kind = rng.int(0, 5);
      let cmd;
      if (kind === 0) cmd = null;
      else if (kind === 1) cmd = { player: rng.int(-2, 4), type: 'place', cell: rng.int(-5, 40) };
      else if (kind === 2) cmd = { player: s.currentPlayer, type: 'nonsense' };
      else if (kind === 3) cmd = { player: s.currentPlayer, type: 'place', cell: 'x' };
      else if (kind === 4) cmd = { player: s.currentPlayer, type: 'place', cell: NaN };
      else {
        const cells = legalCells(s, s.currentPlayer);
        if (!cells.length) break;
        cmd = { player: s.currentPlayer, type: 'place', cell: rng.pick(cells), elapsedMs: rng.int(0, 500) };
      }
      const r = applyCommand(s, cmd);
      if (r.ok) s = r.state;
      else assert.ok(Object.values(INVALID).includes(r.reason), `unknown reason ${r.reason}`);
      assert.ok(Number.isFinite(s.turnNumber));
      assert.ok(s.board.every((v) => v === 0 || v === 1 || v === 2));
    }
  }
});

test('hashString is stable', () => {
  assert.equal(hashString('three-marks'), hashString('three-marks'));
  assert.notEqual(hashString('a'), hashString('b'));
});
