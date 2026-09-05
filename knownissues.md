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
| `node --test tests/*.test.mjs` (unit tests) | 3 + 4 + 20 + 9 = **36/36 pass** |
| `node --check` on all modules | clean (11 `js/*.js` + `server.js`) |
| `npm run test:e2e` / `node tests/e2e.mjs` (headless Chrome) | **E2E PASS** — desktop + mobile, no page errors |

## Resolved

### 1. The rules engine accepts `timeout` in a ruleset with no clock — and `server.js` documents the opposite

- **Fix:** `js/rules.js:218-226`. The `timeout` guard previously read
  `timeLimitMs > 0 && playerTimeMs[player] < timeLimitMs`, so with `timeLimitMs === 0` the left
  operand short-circuited and the `timeout` command was accepted, terminating the match with
  `TERMINAL.TIMEOUT` before any move and finalizing leaderboard-grade scores. The guard is now
  `timeLimitMs <= 0 || playerTimeMs[player] < timeLimitMs`, so the engine **rejects** `timeout`
  when no per-player clock is configured (matching the `server.js:118-120` comment and the
  `forceTimeout` design, which applies the hosted deadline as a resignation-equivalent forfeit
  rather than a `timeout` command). With a clock configured, an exhausted clock still times out
  exactly as before.
- **Verification:** re-ran the original repro → `{ok:false, reason:"bad-command", status:"active"}`;
  clocked ruleset with `playerTimeMs >= timeLimitMs` still returns `terminalReason:"timeout"`.
  Added regression test `timeout is rejected when no clock is configured`
  (`tests/rules.test.mjs`).

### 2. The replay envelope cannot be validated once any invalid action occurs

- **Fix:** two coordinated changes:
  - `js/session.js:177-188` (`commit`): a rejected but state-mutating command is now also appended
    to `this.replay.commands` and its resulting `stateHash` pushed to `this.replay.stateHashes`,
    so the recorded log reproduces the invalid-action count. Duplicate-command idempotent rejects
    (no state change) are deliberately still not recorded.
  - `js/rules.js:353-367` (`replayEnvelope`): the re-execution loop no longer bails on a non-ok
    `applyCommand`. A rejected command can still mutate authoritative state (it counts an invalid
    action), so the loop adopts whatever the engine produced and relies on the per-step hash chain
    to catch any divergence. A genuine corruption still surfaces as
    `hash-mismatch-at-<i>` (the tampered-state test still fails as expected).
- **Verification:** the original repro (legal move → occupied tap → legal move) now yields
  `replay verdict: {"ok":true}` with the invalid-action count reproduced. Added regression test
  `replay envelope stays valid after an invalid action` (`tests/session.test.mjs`).

## Confirmed defects (not yet fixed)

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
- **Status — NOT fixed in this pass:** this is a missing product feature (a full Scores/Score-chase
  mode with global + friends + daily/weekly boards), not a small defect that admits a minimal,
  surgical code change. Implementing it would be a substantial feature build, requires a
  host/Scores backend for server-authoritative submissions, and whether leaderboards are in scope
  for this title is a product decision (see the original "Not tested" note). The `compareResults`
  tie-break primitive is present and tested; wiring it into a new leaderboard mode was left out of
  scope deliberately rather than half-implemented.

## Suspected — not confirmed

### 1. `session.resign()` is defined but unreachable, and would be rejected mid-AI-turn anyway

- **File:** `js/session.js:164-167`
- **Concern:** `resign()` has no caller in `js/ui.js`, `js/main.js` or `index.html`, even though
  `legalActions` advertises a `resign` action for every active player (`js/rules.js:149`). If it
  were wired to a button, `commit({ player: this.match?.humanPlayer, type: 'resign' })` would be
  rejected with `OUT_OF_TURN` — and would *increment the human's invalid-action count* — whenever
  it fired during the AI's scheduled thinking window (`scheduleAI`, 450–750 ms).
- **Why unconfirmed:** the second half is a hypothetical about code that is not currently reachable
  from the UI; only the "no caller" part is provable from the source. Deliberately left as-is
  (dead code, no shipment impact).

### 2. Time spent on a rejected move is discarded

- **File:** `js/rules.js:206-210` versus `js/rules.js:178-181`
- **Concern:** `applyCommand` adds `cmd.elapsedMs` to `next.playerTimeMs[player]` before validating
  a `place`, but the rejection path returns `invalid(state, …)`, which clones the **original**
  `state`. The elapsed time therefore never lands, so a player can stall the clock by repeatedly
  tapping occupied cells.
- **Why unconfirmed:** `js/session.js:209-213` recomputes remaining time from
  `playerTimeMs + (serverNow() - turnStartedAt)` on a 250 ms interval and `turnStartedAt` is only
  reset on an accepted command, so the live clock display appears to compensate. Whether the
  authoritative `playerTimeMs` ever diverges enough to matter was not established. Left as-is.

### 3. Exceeding the clock does not by itself end the round

- **File:** `js/rules.js:196-227`
- **Concern:** `applyCommand` never checks `clockExceeded` on a `place`; only an explicit `timeout`
  command terminates. If the clock watcher is not running (paused tab, `startClockWatch` not
  started, or the hosted path where `js/session.js` is not in play), a player can move after their
  time has run out.
- **Why unconfirmed:** `startClockWatch` does fire the timeout in the local flow, and the hosted
  path applies its own 60 s `TURN_DEADLINE_MS`, so no concrete path past both was demonstrated.
  Left as-is.

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
  not be determined from the source; `spec.md` §6 requires one, but it remains unbuilt. See the
  "Confirmed defects (not yet fixed)" section above.
