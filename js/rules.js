// Three Marks rules engine — pure, deterministic, serializable.
// No DOM, no rendering, no wall-clock access. Elapsed time is fed in via
// commands (authoritative clock source lives outside the engine).
import { RngStream, hashState } from './rng.js';

export const RULES_VERSION = 1;
export const BOARD_MIN = 3;
export const BOARD_MAX = 5;

export const TERMINAL = {
  LINE: 'line-complete',
  FULL: 'board-full',
  MOVE_LIMIT: 'move-limit',
  TIMEOUT: 'timeout',
  RESIGN: 'resign',
};

export const INVALID = {
  GAME_OVER: 'game-over',
  OUT_OF_TURN: 'out-of-turn',
  OUT_OF_BOUNDS: 'out-of-bounds',
  CELL_OCCUPIED: 'cell-occupied',
  CELL_DISABLED: 'cell-disabled',
  BAD_COMMAND: 'bad-command',
  DUPLICATE: 'duplicate-command',
};

export function defaultConfig(overrides = {}) {
  return {
    boardSize: 3,
    winLength: 3,
    moveLimit: 0, // max marks per player; 0 = unlimited
    timeLimitMs: 0, // per-player clock; 0 = unlimited
    disabledCells: [],
    startMarks: [], // [{cell, player}]
    firstPlayer: 1,
    misere: false, // completing a line loses instead of wins
    ...overrides,
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!Number.isInteger(config.boardSize) || config.boardSize < BOARD_MIN || config.boardSize > BOARD_MAX) {
    errors.push('boardSize must be an integer 3..5');
  }
  if (!Number.isInteger(config.winLength) || config.winLength < 3 || config.winLength > config.boardSize) {
    errors.push('winLength must be 3..boardSize');
  }
  const cells = config.boardSize * config.boardSize;
  for (const c of config.disabledCells) {
    if (!Number.isInteger(c) || c < 0 || c >= cells) errors.push(`disabledCells entry ${c} out of bounds`);
  }
  for (const m of config.startMarks) {
    if (!Number.isInteger(m.cell) || m.cell < 0 || m.cell >= cells) errors.push(`startMarks cell ${m.cell} out of bounds`);
    if (m.player !== 1 && m.player !== 2) errors.push('startMarks player must be 1 or 2');
    if (config.disabledCells.includes(m.cell)) errors.push(`startMarks cell ${m.cell} is disabled`);
  }
  if (config.moveLimit < 0 || config.timeLimitMs < 0) errors.push('limits must be >= 0');
  if (config.firstPlayer !== 1 && config.firstPlayer !== 2) errors.push('firstPlayer must be 1 or 2');
  return errors;
}

export function createInitialState(config, seed = 1) {
  const cfg = defaultConfig(config);
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error('Invalid config: ' + errors.join('; '));
  const cells = cfg.boardSize * cfg.boardSize;
  const board = new Array(cells).fill(0);
  for (const m of cfg.startMarks) board[m.cell] = m.player;
  const rng = new RngStream(seed >>> 0);
  return {
    version: RULES_VERSION,
    config: cfg,
    seed: seed >>> 0,
    board,
    currentPlayer: cfg.firstPlayer,
    turnNumber: 1,
    status: 'active',
    terminalReason: null,
    winner: 0,
    winLine: null,
    invalidActions: { 1: 0, 2: 0 },
    playerTimeMs: { 1: 0, 2: 0 },
    marksPlaced: { 1: countMarks(board, 1), 2: countMarks(board, 2) },
    history: [],
    appliedCommandIds: [],
    rngState: rng.serialize(),
  };
}

function countMarks(board, player) {
  let n = 0;
  for (const v of board) if (v === player) n++;
  return n;
}

export function cellCount(state) {
  return state.config.boardSize * state.config.boardSize;
}

// All winning lines (as cell index arrays) for a board geometry.
export function computeLines(boardSize, winLength) {
  const lines = [];
  const at = (r, c) => r * boardSize + c;
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c <= boardSize - winLength; c++) {
      lines.push(Array.from({ length: winLength }, (_, i) => at(r, c + i)));
    }
  }
  for (let c = 0; c < boardSize; c++) {
    for (let r = 0; r <= boardSize - winLength; r++) {
      lines.push(Array.from({ length: winLength }, (_, i) => at(r + i, c)));
    }
  }
  for (let r = 0; r <= boardSize - winLength; r++) {
    for (let c = 0; c <= boardSize - winLength; c++) {
      lines.push(Array.from({ length: winLength }, (_, i) => at(r + i, c + i)));
      lines.push(Array.from({ length: winLength }, (_, i) => at(r + i, c + winLength - 1 - i)));
    }
  }
  return lines;
}

const lineCache = new Map();
export function linesFor(boardSize, winLength) {
  const key = boardSize + ':' + winLength;
  if (!lineCache.has(key)) lineCache.set(key, computeLines(boardSize, winLength));
  return lineCache.get(key);
}

export function findWinLine(board, boardSize, winLength) {
  for (const line of linesFor(boardSize, winLength)) {
    const v = board[line[0]];
    if (v !== 0 && line.every((c) => board[c] === v)) return { player: v, line };
  }
  return null;
}

// Legal actions for a player. Tutorials and hints call this same API.
export function legalActions(state, player) {
  if (state.status !== 'active') return [];
  if (player !== state.currentPlayer) return [];
  const actions = [];
  const disabled = state.config.disabledCells;
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === 0 && !disabled.includes(i)) actions.push({ type: 'place', cell: i, player });
  }
  actions.push({ type: 'resign', player });
  return actions;
}

export function legalCells(state, player) {
  return legalActions(state, player)
    .filter((a) => a.type === 'place')
    .map((a) => a.cell);
}

export function isLegal(state, player, cell) {
  return legalCells(state, player).includes(cell);
}

function clone(state) {
  return {
    ...state,
    config: { ...state.config, disabledCells: state.config.disabledCells.slice(), startMarks: state.config.startMarks.map((m) => ({ ...m })) },
    board: state.board.slice(),
    invalidActions: { ...state.invalidActions },
    playerTimeMs: { ...state.playerTimeMs },
    marksPlaced: { ...state.marksPlaced },
    history: state.history.map((h) => ({ ...h })),
    appliedCommandIds: state.appliedCommandIds.slice(),
    winLine: state.winLine ? state.winLine.slice() : null,
  };
}

function invalid(state, player, reason) {
  const next = clone(state);
  if (player === 1 || player === 2) next.invalidActions[player] += 1;
  return { ok: false, reason, state: next };
}

function terminate(next, reason, winner, winLine) {
  next.status = 'terminal';
  next.terminalReason = reason;
  next.winner = winner;
  next.winLine = winLine || null;
}

// Apply a validated command. Never mutates the input state.
// cmd: { id, player, type: 'place'|'resign'|'timeout', cell?, elapsedMs? }
// elapsedMs: authoritative time consumed by the acting player since their
// previous command (or since round start). Ignored unless clocks are used.
export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
    return { ok: false, reason: INVALID.BAD_COMMAND, state };
  }
  if (state.status !== 'active') return invalid(state, cmd.player, INVALID.GAME_OVER);
  if (cmd.id != null && state.appliedCommandIds.includes(cmd.id)) {
    return { ok: false, reason: INVALID.DUPLICATE, state }; // idempotent reject, no penalty
  }
  const player = cmd.player;
  if (player !== 1 && player !== 2) return { ok: false, reason: INVALID.BAD_COMMAND, state };
  if (player !== state.currentPlayer) return invalid(state, player, INVALID.OUT_OF_TURN);

  const next = clone(state);
  if (cmd.id != null) next.appliedCommandIds.push(cmd.id);
  if (Number.isFinite(cmd.elapsedMs) && cmd.elapsedMs > 0) {
    next.playerTimeMs[player] += Math.floor(cmd.elapsedMs);
  }

  if (cmd.type === 'resign') {
    terminate(next, TERMINAL.RESIGN, player === 1 ? 2 : 1, null);
    next.turnNumber += 1;
    return { ok: true, state: next };
  }

  if (cmd.type === 'timeout') {
    // A timeout is only meaningful with a per-player clock configured; without
    // one the engine rejects it (the hosted turn deadline applies the timeout
    // itself via a resignation-equivalent forfeit, not this command).
    if (state.config.timeLimitMs <= 0 || next.playerTimeMs[player] < state.config.timeLimitMs) {
      return invalid(state, player, INVALID.BAD_COMMAND);
    }
    terminate(next, TERMINAL.TIMEOUT, player === 1 ? 2 : 1, null);
    next.turnNumber += 1;
    return { ok: true, state: next };
  }

  if (cmd.type !== 'place') return { ok: false, reason: INVALID.BAD_COMMAND, state };

  const cell = cmd.cell;
  const cells = state.config.boardSize * state.config.boardSize;
  if (!Number.isInteger(cell) || cell < 0 || cell >= cells) return invalid(state, player, INVALID.OUT_OF_BOUNDS);
  if (state.config.disabledCells.includes(cell)) return invalid(state, player, INVALID.CELL_DISABLED);
  if (state.board[cell] !== 0) return invalid(state, player, INVALID.CELL_OCCUPIED);

  next.board[cell] = player;
  next.marksPlaced[player] += 1;
  next.history.push({ turn: state.turnNumber, player, cell, elapsedMs: Math.max(0, Math.floor(cmd.elapsedMs || 0)) });

  const win = findWinLine(next.board, next.config.boardSize, next.config.winLength);
  if (win) {
    // In misere play, completing a line loses.
    const winner = next.config.misere ? (win.player === 1 ? 2 : 1) : win.player;
    terminate(next, TERMINAL.LINE, winner, win.line);
  } else if (next.config.moveLimit > 0 && next.marksPlaced[player] >= next.config.moveLimit) {
    terminate(next, TERMINAL.MOVE_LIMIT, player === 1 ? 2 : 1, null);
  } else if (legalCellsRaw(next).length === 0) {
    terminate(next, TERMINAL.FULL, 0, null); // draw
  }

  if (next.status === 'active') next.currentPlayer = player === 1 ? 2 : 1;
  next.turnNumber += 1;
  return { ok: true, state: next };
}

function legalCellsRaw(state) {
  const out = [];
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === 0 && !state.config.disabledCells.includes(i)) out.push(i);
  }
  return out;
}

// ---- Clock helpers (clock ownership lives in session/platform layers) ----

export function clockExceeded(state, player) {
  return state.config.timeLimitMs > 0 && state.playerTimeMs[player] >= state.config.timeLimitMs;
}

// ---- Scoring: integer components, formatted only in presentation ----

export function scoreBreakdown(state, player, options = {}) {
  const parMs = options.parMs || 60000;
  const maxOwnMarks = options.parMarks || Math.ceil((state.config.boardSize * state.config.boardSize) / 2);
  const difficultyPct = options.difficultyPct != null ? options.difficultyPct : 100; // 100 = x1.00
  const won = state.winner === player;
  const draw = state.winner === 0;
  const components = [];
  const push = (key, label, value) => components.push({ key, label, value: Math.round(value) });

  push('base', 'Round completed', 100);
  push('objective', won ? 'Objective complete' : draw ? 'Stalemate' : 'Objective missed', won ? 1000 : draw ? 300 : 0);
  if (won) {
    const speed = Math.min(500, Math.max(0, Math.floor((parMs - state.playerTimeMs[player]) / 1000) * 10));
    push('speed', 'Speed bonus', speed);
    const eff = Math.max(0, (maxOwnMarks - state.marksPlaced[player]) * 50);
    push('efficiency', 'Efficiency bonus', eff);
  }
  push('discipline', 'Clean play', Math.max(0, 100 - state.invalidActions[player] * 25));
  const subtotal = components.reduce((s, c) => s + c.value, 0);
  const total = Math.round((subtotal * difficultyPct) / 100);
  if (difficultyPct !== 100) push('difficulty', `Difficulty x${(difficultyPct / 100).toFixed(2)}`, total - subtotal);
  return { components, total, won, draw };
}

// Tie-break order: objective completion, fewer invalid actions, lower
// authoritative elapsed time, then stable session identifier.
export function compareResults(a, b) {
  const obj = (r) => (r.won ? 2 : r.draw ? 1 : 0);
  if (obj(a) !== obj(b)) return obj(b) - obj(a);
  if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

// ---- Serialization & migration ----

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const state = typeof json === 'string' ? JSON.parse(json) : json;
  return migrate(state);
}

export function migrate(state) {
  if (!state || typeof state !== 'object') throw new Error('Not a state object');
  if (state.version === RULES_VERSION) return state;
  if (state.version == null || state.version < RULES_VERSION) {
    // v0 (pre-versioning) -> v1: fill fields introduced later.
    return {
      ...createInitialState(state.config || {}, state.seed || 1),
      ...state,
      version: RULES_VERSION,
      appliedCommandIds: state.appliedCommandIds || [],
      marksPlaced: state.marksPlaced || { 1: countMarks(state.board, 1), 2: countMarks(state.board, 2) },
    };
  }
  throw new Error(`Unsupported state version ${state.version}`);
}

export function stateHash(state) {
  return hashState(state);
}

// ---- Replay envelope ----

export function createReplayEnvelope({ seed, config, buildVersion, contentVersion }) {
  return {
    schemaVersion: 1,
    buildVersion,
    contentVersion,
    seed: seed >>> 0,
    config: defaultConfig(config),
    initialHash: stateHash(createInitialState(config, seed)),
    timestampOffsetMs: 0,
    commands: [],
    stateHashes: [],
    terminalResult: null,
  };
}

export function replayEnvelope(envelope) {
  let state = createInitialState(envelope.config, envelope.seed);
  if (stateHash(state) !== envelope.initialHash) {
    return { ok: false, reason: 'initial-hash-mismatch', state };
  }
  for (let i = 0; i < envelope.commands.length; i++) {
    const res = applyCommand(state, envelope.commands[i]);
    // Rejected commands may still mutate authoritative state (an invalid
    // action counts against the actor), so adopt whatever the engine
    // produced and rely on the hash chain to catch any divergence — this
    // keeps a log that included a rejected command reproducible.
    state = res.state;
    if (envelope.stateHashes[i] != null && stateHash(state) !== envelope.stateHashes[i]) {
      return { ok: false, reason: `hash-mismatch-at-${i}`, state };
    }
  }
  return { ok: true, state };
}
