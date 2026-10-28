// The practice AI's moves and the hint (js/ai.js) on a worker
// (native/ai-worker.js), so a deep search never stalls a frame. A request
// carries the AI stream's state and the answer brings the new state back, so
// moves are the browser build's for the same position and seed. Without a
// worker (it failed to start) the search runs on the game's thread.
import { worker, type Worker } from "starhermit:script";
import { A, type AI, type State } from "./game.ts";

type Reply = { id: number; cell: number; rng: number };
let w: Worker | null = null;
let failed = false;
let nextId = 1;
const waiting = new Map<number, (cell: number, rng: number) => void>();

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/ai-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as Reply;
      const job = waiting.get(r.id);
      if (!job) return;
      waiting.delete(r.id);
      job(r.cell, r.rng >>> 0);
    });
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`ai worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      for (const [id, job] of waiting) { waiting.delete(id); job(-2, 0); }
    });
  } catch (e) { console.warn(`ai worker: ${String(e)}`); failed = true; w = null; }
  return w;
}
/** Starts the worker ahead of the first request. */
export function warm(): void { ensure(); }
/** `ai`'s move for `player`; done(cell, rngState) — the caller adopts the state when it uses the move. */
export function request(ai: AI, state: State, player: number, done: (cell: number, rngState: number) => void): void {
  const sync = (): void => {
    const local = new A.PracticeAI(ai.diff.id, 1);
    local.rng.state = ai.rng.state >>> 0;
    let cell = -1;
    try { cell = local.chooseCell(state, player); } catch { cell = -1; }
    done(cell, local.rng.state >>> 0);
  };
  const wk = ensure();
  if (!wk) { sync(); return; }
  const id = nextId++;
  waiting.set(id, (cell, rng) => { if (cell === -2) sync(); else done(cell, rng); });
  try { wk.post({ id, difficulty: ai.diff.id, state: JSON.parse(JSON.stringify(state)), player, rng: ai.rng.state >>> 0 }); }
  catch (e) { waiting.delete(id); console.warn(`ai worker: ${String(e)}`); sync(); }
}
/** True while a search is out. */
export function busy(): boolean { return waiting.size > 0; }
