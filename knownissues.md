# Known Issues — Three Marks

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark185 (OBLITERATED Q8_0, 262k ctx),
alongside the game's own unit tests and a headless-Chrome boot check.

Method note: broad "find the defects in this module" prompts to the review model mostly came back
*NO DEFECTS FOUND*; the findings below were located by reading the source and then **re-executing
the real modules** to reproduce each one. Narrow, single-question prompts to the model were used
afterwards to double-check individual findings, and where that happened it is noted in the
evidence.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | no `package.json`; tests live in `tests/` (not `tests/`) — `node tests/*.test.mjs` → 3 + 4 + 19 + 8 = **34/34 pass** |
| `node --check` on all modules | clean (11 `js/*.js` + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present — substituted a CDP boot check (see *Not tested*): page loads, title "Three Marks", canvas present, **no console errors, no page exceptions** |

## Confirmed defects

Each defect below was reproduced by executing the real modules, not merely reported by the model.

### 1. The rules engine accepts `timeout` in a ruleset with no clock — and `server.js` documents the opposite

- **File:** `js/rules.js:218-225` (`applyCommand`, `timeout` branch), against the comment at
  `server.js:118-120`
- **Trigger:** in a hosted match (default config `timeLimitMs: 0`, `server.js:31`), send
  `{"type":"timeout"}` on your own turn.
- **Behaviour:** the guard is

  ```js
  if (state.config.timeLimitMs > 0 && next.playerTimeMs[player] < state.config.timeLimitMs) {
    return invalid(state, player, INVALID.BAD_COMMAND);
  }
  terminate(next, TERMINAL.TIMEOUT, player === 1 ? 2 : 1, null);
  ```

  With `timeLimitMs === 0` the left operand is false, the guard is skipped entirely, and the match
  terminates with `TERMINAL.TIMEOUT`, awarding the win to the opponent. `server.js` passes
  `command.type` through unfiltered (`server.js:107`) and only overrides `player` and `elapsedMs`,
  so the command reaches the engine intact. Meanwhile `server.js:118-120` states:
  "the engine **rejects** `timeout` when timeLimitMs is 0, so the hosted deadline is applied as a
  resignation-equivalent authoritative forfeit" — and `forceTimeout` exists solely because of that
  belief.
- **Expected:** either the engine rejects `timeout` when no clock is configured (as the comment
  claims and `forceTimeout` assumes), or the comment and `forceTimeout` are wrong. As shipped, a
  terminal reason that is supposed to be unreachable without a clock is reachable, and the
  `finalize()` result — including leaderboard-grade `scoreBreakdown` totals — is produced from it.
- **Evidence:**

  ```
  timeLimitMs=0, timeout -> {"ok":true,"status":"terminal","terminalReason":"timeout","winner":2}

  hosted cfg timeLimitMs: 0
  hosted client sends {type:"timeout"} ->
    {"ok":true,"result":{"winnerSeat":2,"winner":"b","reason":"timeout",
                         "scores":{"a":200,"b":1950},"stateHash":"92aa673f"}}
  ```

  The match is finalized on turn 1, before a single mark is placed. Independently confirmed by the
  review model shown only the guard and the comment: "When `state.config.timeLimitMs` is 0, the
  `&&` short-circuits and the `return invalid(...)` is never reached … the `timeout` command is
  **accepted**. The comment in EXCERPT B … is **inaccurate**."

### 2. The replay envelope cannot be validated once any invalid action occurs

- **File:** `js/session.js:177-186` (`commit`) against `js/rules.js:353` (`replayEnvelope`)
- **Trigger:** tap an occupied cell (or play out of turn) at any point during a round, then validate
  the recorded envelope.
- **Behaviour:** a rejected command still mutates state — `invalid()` (`js/rules.js:180`) returns a
  clone with `invalidActions[player] += 1`, and `commit` adopts it
  (`if (res.reason !== 'duplicate-command') this.state = res.state; // counts invalids`) — but the
  command is **not** appended to `this.replay.commands`, and no hash is pushed. Every subsequent
  `stateHashes` entry therefore embeds an invalid-action count that a replay of the accepted-only
  log can never reproduce, because `stateHash` hashes the whole state object.
- **Expected:** spec §5: "Replay envelope: schema version, build/content version, seed, initial
  hash, timestamp offset, ordered commands, periodic state hashes, terminal result" — the envelope
  must re-execute. `tests/rules.test.mjs:178-202` only exercises a log with no rejected commands, so
  the suite passes.
- **Evidence:** reproducing `commit`'s exact bookkeeping (one legal move, one occupied-cell tap, one
  more legal move):

  ```
  live state invalidActions: {"1":0,"2":1}   accepted commands: 2
  replayEnvelope verdict: {"ok":false,"reason":"hash-mismatch-at-1", ...}
  ```

### 3. The spec's tie-break comparator is implemented but never used — the game ships no leaderboard

- **File:** `js/rules.js:297` (`compareResults`); no caller in `js/`
- **Trigger:** look for any way to compare a score against another player's.
- **Behaviour:** `compareResults` implements the mandated chain (objective completion → fewer
  invalid actions → lower elapsed time → stable session id) and is referenced only by
  `tests/rules.test.mjs`. `grep -rn "compareResults" js/ index.html` returns nothing but its own
  definition. There is no Scores/Leaderboard screen: `js/ui.js` routes to `journey`, `lessons`,
  `challenges`, `practice`, `hosted`, `profile`, `achievements`, `settings` and `help` only, and the
  boot check found no scores entry point on the title screen. `js/storage.js` persists settings,
  progression and achievements — no boards.
- **Expected:** spec §2 lists **Score chase** as a mode ("asynchronous global and friends
  comparisons using validated seeds and rulesets"), and spec §6 *Achievements and leaderboards*
  requires "global and friends-filtered boards for the primary metric plus a fair daily/weekly
  board". Neither exists.
- **Evidence:** the grep result above; the mode cards rendered on boot are
  `Learn, Journey, Daily, Practice, Challenge, Hosted Play` plus `Profile`.

## Suspected — not confirmed

### 1. `session.resign()` is defined but unreachable, and would be rejected mid-AI-turn anyway

- **File:** `js/session.js:164-167`
- **Concern:** `resign()` has no caller in `js/ui.js`, `js/main.js` or `index.html`, even though
  `legalActions` advertises a `resign` action for every active player (`js/rules.js:149`). If it
  were wired to a button, `commit({ player: this.match?.humanPlayer, type: 'resign' })` would be
  rejected with `OUT_OF_TURN` — and would *increment the human's invalid-action count* — whenever
  it fired during the AI's scheduled thinking window (`scheduleAI`, 450–750 ms).
- **Why unconfirmed:** the second half is a hypothetical about code that is not currently reachable
  from the UI; only the "no caller" part is provable from the source.

### 2. Time spent on a rejected move is discarded

- **File:** `js/rules.js:206-210` versus `js/rules.js:178-181`
- **Concern:** `applyCommand` adds `cmd.elapsedMs` to `next.playerTimeMs[player]` before validating
  a `place`, but the rejection path returns `invalid(state, …)`, which clones the **original**
  `state`. The elapsed time therefore never lands, so a player can stall the clock by repeatedly
  tapping occupied cells.
- **Why unconfirmed:** `js/session.js:209-213` recomputes remaining time from
  `playerTimeMs + (serverNow() - turnStartedAt)` on a 250 ms interval and `turnStartedAt` is only
  reset on an accepted command, so the live clock display appears to compensate. Whether the
  authoritative `playerTimeMs` ever diverges enough to matter was not established.

### 3. Exceeding the clock does not by itself end the round

- **File:** `js/rules.js:196-227`
- **Concern:** `applyCommand` never checks `clockExceeded` on a `place`; only an explicit `timeout`
  command terminates. If the clock watcher is not running (paused tab, `startClockWatch` not
  started, or the hosted path where `js/session.js` is not in play), a player can move after their
  time has run out.
- **Why unconfirmed:** `startClockWatch` does fire the timeout in the local flow, and the hosted
  path applies its own 60 s `TURN_DEADLINE_MS`, so no concrete path past both was demonstrated.

## Checked, no defects found

- `js/rules.js` win detection: `computeLines` enumerates rows, columns and both diagonals for every
  `winLength` window on boards 3–5; `findWinLine` requires a non-empty, uniform line. Misère
  inversion is applied at the single point where the winner is decided.
- `js/rules.js` terminal ordering: line, then per-player move limit, then board-full draw — and
  `currentPlayer` is only swapped when the state is still active, so the terminal state records the
  player who actually moved last.
- `js/rules.js` `turnNumber` increments on every accepted command (place, resign, timeout) and never
  decreases — monotonic, unlike several sibling games.
- `js/rules.js` idempotency: `appliedCommandIds` rejects a repeated `cmd.id` with no invalid-action
  penalty, exactly as spec §5 asks ("Reject duplicates idempotently by command ID").
- `js/rules.js` scoring: every component is `Math.round`ed to an integer, the difficulty multiplier
  is pushed as its own component so the breakdown sums to the total, and `discipline` is clamped at
  zero.
- `js/rules.js` `migrate` fills fields introduced after v0 and throws on a newer version.
- `js/rules.js` legality: `legalActions` is the single source, and `legalCells`/`isLegal` are thin
  filters over it — hints and lessons use the same API.
- `server.js` (hosted Game Script) is otherwise careful: identity comes from the authenticated
  connection rather than the payload (`player: seat`), client clocks are explicitly zeroed
  (`elapsedMs: 0, // client clocks are untrusted`), commands are size-capped at 512 bytes and
  rate-limited to 120/min, the turn deadline is enforced with host-supplied `now`, and
  `publicView` whitelists what each player sees.
- `js/storage.js`: versioned documents with migrations, idempotent achievement unlocks, and an
  explicit `resolveConflict` for cloud/local divergence.
- `js/ai.js` and the lesson flow drive moves through the same `applyCommand` path as the player.

## Not tested

- **`tests/e2e.mjs`**: not shipped, and this game has no `package.json`. Substituted a CDP boot
  check served by `python3 -m http.server` on port 39607, because `server.js` here is a hosted
  **Game Script module** (`createGame`/`applyCommand`/`getResult`), not an HTTP server. The page
  boots cleanly; the only network error is `404 /api/v1/time`, which is an artifact of the static
  substitute host, not a game defect.
- **Hosted multiplayer**: `server.js` was exercised by calling its exported functions directly. The
  real StarHermit sandbox lifecycle (two connected clients, reconnect, serialize/deserialize across
  a restart) was not available.
- **Rendering and audio**: `js/render.js` (1059 lines) and `js/audio.js` were not reviewed beyond
  confirming a clean WebGL boot.
- **Broad model review of `js/rules.js` + `js/session.js`**: attempted twice on spark185 and both
  runs returned an empty answer — the model spent its whole completion budget on internal reasoning
  (`13870 prompt + 5829 completion tokens`, no content) before emitting anything. The companion
  prompt covering `server.js` + `js/storage.js` did answer, with *NO DEFECTS FOUND*, and the narrow,
  single-question prompt used for defect 1 returned a correct and usable answer — so the
  module-level review for this game rests on manual reading plus that targeted confirmation.
- **Defect 3's remedy**: whether a leaderboard is intentionally out of scope for this title could
  not be determined from the source; `spec.md` §6 requires one.
