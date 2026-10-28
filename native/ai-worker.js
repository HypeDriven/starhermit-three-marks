// The rival's and the hint's search off the game's thread (a starhermit:script
// module worker): the browser build's js/ai.js unchanged. Expert's capped
// searches on the wide boards take seconds in the native interpreter, past
// what a frame may run; on the worker the slate keeps drawing meanwhile.
// In: { id, difficulty, state, player, rng } (rng: the AI stream's mulberry32
// state). Out: { id, cell, rng } (the stream's state after the search, so the
// session's stream goes on exactly as it would on the main thread).
import { PracticeAI } from "../js/ai.js";

globalThis.onmessage = (e) => {
  const d = e.data;
  const ai = new PracticeAI(d.difficulty, 1);
  ai.rng.state = d.rng >>> 0;
  let cell = -1;
  try { cell = ai.chooseCell(d.state, d.player); } catch { cell = -1; }
  postMessage({ id: d.id, cell, rng: ai.rng.state >>> 0 });
};
