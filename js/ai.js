// Deterministic practice AI. Difficulty comes from search depth, evaluation
// noise and blunder rates — never from hidden state. All randomness flows
// through a seeded stream so matches are replayable.
import { legalCells, applyCommand, linesFor } from './rules.js';
import { RngStream } from './rng.js';

export const DIFFICULTIES = [
  { id: 'casual', name: 'Casual', depth: 1, noise: 40, blunderPct: 35, difficultyPct: 100 },
  { id: 'skilled', name: 'Skilled', depth: 4, noise: 12, blunderPct: 8, difficultyPct: 125 },
  { id: 'expert', name: 'Expert', depth: 9, noise: 0, blunderPct: 0, difficultyPct: 150 },
];

export function difficultyById(id) {
  return DIFFICULTIES.find((d) => d.id === id) || DIFFICULTIES[0];
}

const NODE_CAP = 250000;

function evaluate(board, boardSize, winLength, player) {
  const lines = linesFor(boardSize, winLength);
  const opp = player === 1 ? 2 : 1;
  let score = 0;
  for (const line of lines) {
    let mine = 0;
    let theirs = 0;
    for (const c of line) {
      if (board[c] === player) mine++;
      else if (board[c] === opp) theirs++;
    }
    if (mine > 0 && theirs > 0) continue;
    if (mine > 0) score += Math.pow(10, mine);
    else if (theirs > 0) score -= Math.pow(10, theirs) * 1.1; // slightly defensive
  }
  // Prefer central control.
  const mid = (boardSize - 1) / 2;
  for (let i = 0; i < board.length; i++) {
    const r = Math.floor(i / boardSize);
    const c = i % boardSize;
    const centrality = boardSize - (Math.abs(r - mid) + Math.abs(c - mid));
    if (board[i] === player) score += centrality * 0.3;
    else if (board[i] === opp) score -= centrality * 0.3;
  }
  return score;
}

function winnerOfTerminal(state) {
  return state.status === 'terminal' ? state.winner : null;
}

function orderedCells(state, cells) {
  // Center-out ordering improves alpha-beta pruning and matches human habit.
  const n = state.config.boardSize;
  const mid = (n - 1) / 2;
  return cells.slice().sort((a, b) => {
    const da = Math.abs(Math.floor(a / n) - mid) + Math.abs((a % n) - mid);
    const db = Math.abs(Math.floor(b / n) - mid) + Math.abs((b % n) - mid);
    return da - db;
  });
}

export class PracticeAI {
  constructor(difficultyId, seed) {
    this.diff = difficultyById(difficultyId);
    this.rng = new RngStream(seed >>> 0);
    this.nodes = 0;
  }

  serializeRng() {
    return this.rng.serialize();
  }

  // The move. The search runs on a compact board (fastSearch) that makes
  // exactly the choices of the reference search over rules states
  // (chooseCellReference / search, kept for the parity tests): the same
  // centre-out order, node count, cap, terminal rules and evaluation; it only
  // skips cloning whole rules states (history, command ids) at every node,
  // which made Expert's capped searches take seconds natively.
  chooseCell(state, player) {
    return this._choose(state, player, true);
  }

  chooseCellReference(state, player) {
    return this._choose(state, player, false);
  }

  _choose(state, player, fast) {
    const cells = legalCells(state, player);
    if (cells.length === 0) return -1;
    this.nodes = 0;

    // Seeded blunder: occasionally pick a random legal cell on lower tiers.
    if (this.diff.blunderPct > 0 && this.rng.next() * 100 < this.diff.blunderPct) {
      return this.rng.pick(cells);
    }

    const depthCap = this.diff.id === 'expert' && state.config.boardSize === 3 ? 9 : this.diff.depth;
    const ordered = orderedCells(state, cells);
    let bestScore = -Infinity;
    let bestCells = [];
    const fb = fast ? new FastBoard(state) : null;
    for (const cell of ordered) {
      let score;
      if (fb) {
        const end = fb.place(cell, player);
        if (end === player) score = 1e9;
        else score = fb.search(this, end, player === 1 ? 2 : 1, player, depthCap - 1, -Infinity, Infinity);
        fb.unplace(cell, player);
      } else {
        const res = applyCommand(state, { player, type: 'place', cell });
        if (winnerOfTerminal(res.state) === player) score = 1e9;
        else {
          score = this.search(res.state, player === 1 ? 2 : 1, player, depthCap - 1, -Infinity, Infinity);
        }
      }
      if (this.diff.noise > 0) score += (this.rng.next() - 0.5) * 2 * this.diff.noise;
      if (score > bestScore + 1e-9) {
        bestScore = score;
        bestCells = [cell];
      } else if (Math.abs(score - bestScore) <= 1e-9) {
        bestCells.push(cell);
      }
      if (this.nodes > NODE_CAP) break;
    }
    return this.rng.pick(bestCells);
  }

  // Minimax from the perspective of `root`; `toMove` alternates.
  search(state, toMove, root, depth, alpha, beta) {
    this.nodes++;
    if (state.status === 'terminal') {
      if (state.winner === root) return 1e6 + depth; // prefer faster wins
      if (state.winner === 0) return 0;
      return -1e6 - depth; // delay losses
    }
    if (depth <= 0 || this.nodes > NODE_CAP) {
      return evaluate(state.board, state.config.boardSize, state.config.winLength, root);
    }
    const cells = orderedCells(state, legalCells(state, toMove));
    const maximizing = toMove === root;
    let best = maximizing ? -Infinity : Infinity;
    for (const cell of cells) {
      const res = applyCommand(state, { player: toMove, type: 'place', cell });
      const score = this.search(res.state, toMove === 1 ? 2 : 1, root, depth - 1, alpha, beta);
      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
      if (this.nodes > NODE_CAP) break;
    }
    return best;
  }
}

// A mutable board for the search: place/unplace with the rules' terminal
// checks (rules.js applyCommand: a line through the new mark — misère gives
// it to the other side —, then the move limit, then a full board is a draw).
// place() returns the winner (0 draw) when the move ends the round, else -1.
class FastBoard {
  constructor(state) {
    const c = state.config;
    this.n = c.boardSize;
    this.winLength = c.winLength;
    this.misere = !!c.misere;
    this.moveLimit = c.moveLimit;
    this.board = state.board.slice();
    this.disabled = new Uint8Array(this.board.length);
    for (const d of c.disabledCells) this.disabled[d] = 1;
    this.marks = { 1: state.marksPlaced[1], 2: state.marksPlaced[2] };
    this.empty = 0;
    for (let i = 0; i < this.board.length; i++) if (this.board[i] === 0 && !this.disabled[i]) this.empty++;
    const lines = linesFor(this.n, this.winLength);
    this.lines = lines;
    this.through = this.board.map(() => []);
    for (const line of lines) for (const cell of line) this.through[cell].push(line);
    // centre-out order of all cells (orderedCells: a stable sort of ascending cells)
    const mid = (this.n - 1) / 2;
    const dist = (a) => Math.abs(Math.floor(a / this.n) - mid) + Math.abs((a % this.n) - mid);
    const all = this.board.map((_, i) => i);
    this.order = all.map((i) => [dist(i), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[1]);
  }

  place(cell, p) {
    this.board[cell] = p;
    this.marks[p]++;
    this.empty--;
    for (const line of this.through[cell]) {
      let all = true;
      for (const c of line) if (this.board[c] !== p) { all = false; break; }
      if (all) return this.misere ? (p === 1 ? 2 : 1) : p;
    }
    if (this.moveLimit > 0 && this.marks[p] >= this.moveLimit) return p === 1 ? 2 : 1;
    if (this.empty === 0) return 0;
    return -1;
  }

  // evaluate() over flat tables: the same terms added in the same order.
  evaluate(player) {
    if (!this.flat) {
      this.flat = Int32Array.from(this.lines.flat());
      this.pow = [1, 10, 100, 1000, 10000, 100000].map((v, i) => Math.pow(10, i));
      const mid = (this.n - 1) / 2;
      this.central = this.board.map((_, i) => this.n - (Math.abs(Math.floor(i / this.n) - mid) + Math.abs((i % this.n) - mid)));
    }
    const b = this.board, f = this.flat, L = this.winLength, pow = this.pow;
    const opp = player === 1 ? 2 : 1;
    let score = 0;
    for (let k = 0; k < f.length; k += L) {
      let mine = 0, theirs = 0;
      for (let j = 0; j < L; j++) {
        const v = b[f[k + j]];
        if (v === player) mine++;
        else if (v === opp) theirs++;
      }
      if (mine > 0 && theirs > 0) continue;
      if (mine > 0) score += pow[mine];
      else if (theirs > 0) score -= pow[theirs] * 1.1;
    }
    const c = this.central;
    for (let i = 0; i < b.length; i++) {
      if (b[i] === player) score += c[i] * 0.3;
      else if (b[i] === opp) score -= c[i] * 0.3;
    }
    return score;
  }

  unplace(cell, p) {
    this.board[cell] = 0;
    this.marks[p]--;
    this.empty++;
  }

  // PracticeAI.search on this board; `end` is the result of the move that led here.
  search(ai, end, toMove, root, depth, alpha, beta) {
    ai.nodes++;
    if (end >= 0) {
      if (end === root) return 1e6 + depth;
      if (end === 0) return 0;
      return -1e6 - depth;
    }
    if (depth <= 0 || ai.nodes > NODE_CAP) {
      return this.evaluate(root);
    }
    const maximizing = toMove === root;
    let best = maximizing ? -Infinity : Infinity;
    const next = toMove === 1 ? 2 : 1;
    for (const cell of this.order) {
      if (this.board[cell] !== 0 || this.disabled[cell]) continue;
      const e = this.place(cell, toMove);
      const score = this.search(ai, e, next, root, depth - 1, alpha, beta);
      this.unplace(cell, toMove);
      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
      if (ai.nodes > NODE_CAP) break;
    }
    return best;
  }
}
