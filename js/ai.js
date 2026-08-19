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

  chooseCell(state, player) {
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
    for (const cell of ordered) {
      const res = applyCommand(state, { player, type: 'place', cell });
      let score;
      if (winnerOfTerminal(res.state) === player) score = 1e9;
      else {
        score = this.search(res.state, player === 1 ? 2 : 1, player, depthCap - 1, -Infinity, Infinity);
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
