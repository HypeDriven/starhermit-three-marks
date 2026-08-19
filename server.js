// Three Marks — authoritative Game Script for the StarHermit sandbox.
//
// The host runs this file server-side for hosted sessions. It wraps the same
// deterministic rules engine the client uses (js/rules.js), so a hosted match
// and its client replay can never disagree. All client-supplied values —
// identity, clocks, scores, winners — are treated as untrusted: the result is
// computed here, from validated commands only.
//
// Host contract (sandbox lifecycle):
//   export function createGame({ sessionId, players, seed, config, now })
//     -> { state, publicView(playerId) }
//   export function applyCommand(game, playerId, command, now)
//     -> { ok, reason?, state?, events? }   (idempotent by command.id)
//   export function getResult(game)
//     -> null | { winner, reason, scores, finishedAt }
//   export function serialize(game) / deserialize(json)
//
// `players` is [{id, seat}] with seat 1|2 assigned by the host. The script
// never accepts a player-supplied winner, score, hidden state or elapsed
// time; deadlines use the host-supplied `now` (platform time).

import {
  createInitialState, applyCommand as rulesApply, legalActions, scoreBreakdown,
  stateHash, defaultConfig, validateConfig, TERMINAL,
} from './js/rules.js';

const MAX_COMMANDS_PER_MINUTE = 120;
const TURN_DEADLINE_MS = 60000; // hosted turn deadline, enforced with platform time

export function createGame({ sessionId, players, seed, config, now }) {
  const cfg = defaultConfig({ timeLimitMs: 0, ...(config || {}) });
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error('invalid-config: ' + errors.join(';'));
  if (!Array.isArray(players) || players.length !== 2) throw new Error('exactly-two-players');
  const seats = {};
  for (const p of players) {
    if (p.seat !== 1 && p.seat !== 2) throw new Error('bad-seat');
    seats[p.id] = p.seat;
  }
  const state = createInitialState(cfg, seed >>> 0);
  return {
    sessionId,
    seats,
    state,
    createdAt: now,
    turnStartedAt: now,
    rate: {}, // playerId -> [timestamps]
    finished: null,
    publicView(playerId) {
      return publicView(this, playerId);
    },
  };
}

function publicView(game, playerId) {
  const s = game.state;
  // Whitelisted public messages only; no hidden state exists in this game,
  // but the view is still constructed explicitly.
  return {
    sessionId: game.sessionId,
    seat: game.seats[playerId] ?? 0,
    board: s.board.slice(),
    config: { ...s.config },
    currentPlayer: s.currentPlayer,
    turnNumber: s.turnNumber,
    status: s.status,
    terminalReason: s.terminalReason,
    winner: s.winner,
    winLine: s.winLine ? s.winLine.slice() : null,
    playerTimeMs: { ...s.playerTimeMs },
    marksPlaced: { ...s.marksPlaced },
    turnDeadlineAt: s.status === 'active' ? game.turnStartedAt + TURN_DEADLINE_MS : null,
    legalActions: game.seats[playerId] ? legalActions(s, game.seats[playerId]) : [],
    stateHash: stateHash(s),
    result: game.finished,
  };
}

function rateLimited(game, playerId, now) {
  const windowStart = now - 60000;
  const list = (game.rate[playerId] = (game.rate[playerId] || []).filter((t) => t > windowStart));
  if (list.length >= MAX_COMMANDS_PER_MINUTE) return true;
  list.push(now);
  return false;
}

export function applyCommand(game, playerId, command, now) {
  if (game.finished) return { ok: false, reason: 'game-over' };
  const seat = game.seats[playerId];
  if (!seat) return { ok: false, reason: 'not-a-member' };
  if (rateLimited(game, playerId, now)) return { ok: false, reason: 'rate-limited' };
  if (!command || typeof command !== 'object') return { ok: false, reason: 'malformed' };
  if (JSON.stringify(command).length > 512) return { ok: false, reason: 'payload-too-large' };

  // Turn deadline: the player to move loses on expiry; checked on any input.
  const s = game.state;
  if (s.status === 'active' && now - game.turnStartedAt > TURN_DEADLINE_MS) {
    const loser = s.currentPlayer;
    game.state = forceTimeout(s, loser);
    return finalize(game, now, { ok: false, reason: 'turn-expired', expiredSeat: loser });
  }

  const clean = {
    id: typeof command.id === 'string' ? command.id.slice(0, 64) : undefined,
    player: seat, // identity comes from the authenticated connection, never the payload
    type: command.type,
    cell: Number.isInteger(command.cell) ? command.cell : undefined,
    elapsedMs: 0, // client clocks are untrusted; server measures turn time itself
  };
  const res = rulesApply(game.state, clean);
  if (!res.ok) return { ok: false, reason: res.reason };
  game.state = res.state;
  game.turnStartedAt = now;
  if (game.state.status === 'terminal') return finalize(game, now, { ok: true });
  return { ok: true, events: [{ type: 'move', seat, cell: clean.cell }] };
}

// A timeout in a ruleset without clocks needs a forced terminal; the engine
// rejects `timeout` when timeLimitMs is 0, so the hosted deadline is applied
// as a resignation-equivalent authoritative forfeit.
function forceTimeout(state, loserSeat) {
  const res = rulesApply(state, { player: loserSeat, type: 'resign' });
  const s = res.state;
  s.terminalReason = TERMINAL.TIMEOUT;
  return s;
}

function finalize(game, now, extra = {}) {
  const s = game.state;
  if (s.status !== 'terminal') return extra;
  const scores = {};
  for (const [playerId, seat] of Object.entries(game.seats)) {
    scores[playerId] = scoreBreakdown(s, seat, { difficultyPct: 100 }).total;
  }
  game.finished = {
    winnerSeat: s.winner,
    winner: s.winner ? Object.keys(game.seats).find((id) => game.seats[id] === s.winner) : null,
    reason: s.terminalReason,
    scores,
    stateHash: stateHash(s),
    finishedAt: now,
  };
  return { ...extra, result: game.finished };
}

export function getResult(game) {
  return game.finished;
}

export function serialize(game) {
  return JSON.stringify({
    sessionId: game.sessionId,
    seats: game.seats,
    state: game.state,
    createdAt: game.createdAt,
    turnStartedAt: game.turnStartedAt,
    rate: game.rate,
    finished: game.finished,
  });
}

export function deserialize(json) {
  const g = JSON.parse(typeof json === 'string' ? json : JSON.stringify(json));
  g.publicView = function (playerId) {
    return publicView(this, playerId);
  };
  return g;
}
