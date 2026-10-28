// The search on the compact board (js/ai.js chooseCell) makes exactly the
// choices of the reference search over rules states (chooseCellReference),
// and of the browser build's js/ai.js kept as tests/ai-reference.js: the
// same cells, node counts and AI stream across rulesets and difficulties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyCommand } from '../js/rules.js';
import { PracticeAI } from '../js/ai.js';
import { PracticeAI as OldAI } from './ai-reference.js';

const CFGS = [{}, { boardSize: 4, winLength: 4 }, { boardSize: 5, winLength: 4 }, { boardSize: 4, winLength: 3, misere: true },
  { disabledCells: [4], moveLimit: 4 }, { boardSize: 5, winLength: 4, moveLimit: 8, disabledCells: [0, 4, 20, 24] }, { misere: true },
  { startMarks: [{ cell: 0, player: 2 }, { cell: 8, player: 2 }] }];
test('fast search = the browser build\'s search', () => {
  let moves = 0;
  for (const cfg of CFGS) for (const d of ['casual', 'skilled', 'expert']) for (let seed = 1; seed <= 2; seed++) {
    const a = new PracticeAI(d, seed), b = new OldAI(d, seed);
    let s = createInitialState(cfg, seed);
    while (s.status === 'active') {
      const x = a.chooseCell(s, s.currentPlayer), y = b.chooseCell(s, s.currentPlayer);
      assert.equal(x, y, `${JSON.stringify(cfg)} ${d} ${seed} turn ${s.turnNumber}`);
      assert.equal(a.nodes, b.nodes);
      assert.equal(a.rng.state, b.rng.state);
      s = applyCommand(s, { player: s.currentPlayer, type: 'place', cell: x }).state;
      moves++;
    }
  }
  assert.ok(moves > 300);
});
