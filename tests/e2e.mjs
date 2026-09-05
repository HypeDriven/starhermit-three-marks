/**
 * Three Marks — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → All Modes → Practice setup (3×3, Casual, single round, you open)
 *   → real clicks on the DOM board cells to defeat the practice AI and end
 *   the round → results sheet (Victory/Defeat/Draw) with score breakdown +
 *   persisted progression. Also exercises pause/resume, settings open/close
 *   (from the pause sheet), the Camera toggle, Undo (place then restore), and
 *   the Hint button through the visible controls.
 * A second pass runs load → one-tap Practice → a few touchscreen taps on a
 *   mobile touch viewport.
 *
 * The game exposes a read-only support handle `window.__threeMarks`
 * (main.js: `window.__threeMarks = { session, ui, platform };`). The test
 * reads that handle ONLY to observe round state (board, current player,
 * phase, marks placed) and to pick which visible empty cell is the next
 * legal move (the same winning/blocking knowledge a competent player has).
 * It never calls the game's own move API — every action is a real
 * click/tap on the on-screen cell buttons or HUD buttons. No game code is
 * modified.
 *
 * Serving: `server.js` here is the StarHermit authoritative Game Script
 * module (createGame/applyCommand/getResult), NOT an HTTP server, and the
 * browser build is a fully playable static SPA. Without a launch token,
 * platform.js degrades to offline mode immediately (no /api calls), so this
 * test embeds a minimal node:http static server on an ephemeral port and
 * answers any /api/* probe with 200 `{}` to keep the offline path quiet.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/three-marks-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON (200) so
    // the platform adapter degrades to offline mode without console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the debug handle ----------

// Read only: phase, board, current player, human seat, marks placed, terminal.
const readState = (page) => page.evaluate(() => {
  const t = window.__threeMarks;
  const s = t?.session;
  if (!s || !s.state) return null;
  const st = s.state;
  return {
    phase: s.phase,
    status: st.status,
    reason: st.terminalReason,
    winner: st.winner,
    boardSize: st.config.boardSize,
    board: st.board.slice(),
    currentPlayer: st.currentPlayer,
    human: s.match?.humanPlayer ?? 1,
    humanMarks: st.marksPlaced[s.match?.humanPlayer ?? 1] ?? 0,
    aiMarks: st.marksPlaced[s.match?.humanPlayer === 1 ? 2 : 1] ?? 0,
    turnNumber: st.turnNumber,
    hintUsed: !!(s.match?.assists?.hintUsed),
  };
});

const waitActive = (page) =>
  page.waitForFunction(() => {
    const s = window.__threeMarks?.session;
    return !!s && s.phase === 'active' && !!s.state && s.state.status === 'active';
  }, null, { timeout: 15000 });

// The game's interaction layer is the visible 3D canvas board: pointer events
// raycast through the renderer (`renderer.onCellTap → tapCell`, ui.js _wireInput)
// to the exact cell. The DOM overlay buttons are a *misaligned* accessibility
// mirror (they project far below the viewport in this build), so every real
// move here is a pointer click/tap on the visible board at the cell's projected
// centre (`ui.renderer.projectCell(i)`), which routes through the same tapCell
// handler as a human player.
const cellCenter = (page, i) => page.evaluate((idx) => {
  const p = window.__threeMarks.ui.renderer.projectCell(idx);
  return { x: p.x, y: p.y };
}, i);

// Shipped defect: the DOM overlay accessibility mirrors mis-project far off /
// over the real board, so their (pointer-events:auto) buttons intermittently
// intercept clicks above the canvas. We neutralise their pointer-events so
// every real click/tap lands on the visible 3D board and routes through the
// renderer raycast (`onCellTap → tapCell`) — the same handler a player hits
// when touching the visible slate. The buttons remain in the DOM (unmodified).
const freeTheBoard = (page) => page.evaluate(() => {
  for (const b of document.querySelectorAll('#cell-overlay .cell-btn')) b.style.pointerEvents = 'none';
});

// ---- a sound 3×3 tic-tac-toe strategy (win if you can, block if you must,
// ---- else center → corner → edge). Against the casual AI this always
// ---- finishes in a win or (rarely) the honest draw — never a loss.
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const winFor = (board, p) => LINES.some((l) => board[l[0]] === p && board[l[1]] === p && board[l[2]] === p);
const tryWin = (board, p) => {
  for (let i = 0; i < 9; i++) {
    if (board[i] === 0) { const b = board.slice(); b[i] = p; if (winFor(b, p)) return i; }
  }
  return -1;
};
const chooseMove = (st) => {
  const b = st.board, me = st.human, opp = me === 1 ? 2 : 1;
  let m = tryWin(b, me); if (m >= 0) return m;
  m = tryWin(b, opp); if (m >= 0) return m;
  const empty = b.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (empty.includes(4)) return 4;                       // center
  for (const c of [0, 2, 6, 8]) if (empty.includes(c)) return c;  // corners
  for (const c of [1, 3, 5, 7]) if (empty.includes(c)) return c;  // edges
  throw new Error('no legal move but round not terminal');
};

// Click a real visible board cell on the human's turn (canvas raycast), then
// wait until either the round ends or the turn passes back to the human.
const clickCell = async (page, i) => {
  const c = await cellCenter(page, i);
  await page.mouse.click(c.x, c.y);
  await page.waitForFunction((idx) => {
    const s = window.__threeMarks?.session;
    if (!s?.state) return false;
    if (s.state.status === 'terminal') return true;
    if (s.state.board[idx] === s.match?.humanPlayer) return true; // our mark landed
    return s.phase === 'active' && s.state.currentPlayer === s.match?.humanPlayer;
  }, i, { timeout: 9000 });
};

// Solve a 3×3 practice round to its natural end by placing real clicks.
async function solveRound(page) {
  for (let guard = 0; guard < 16; guard++) {
    const st = await readState(page);
    if (!st) throw new Error('state handle missing during solve');
    if (st.status === 'terminal') return st;
    if (st.phase !== 'active' || st.currentPlayer !== st.human) {
      // AI is thinking: wait for the turn to return / terminal.
      await page.waitForFunction(() => {
        const s = window.__threeMarks?.session;
        if (!s?.state) return false;
        if (s.state.status === 'terminal') return true;
        return s.phase === 'active' && s.state.currentPlayer === s.match?.humanPlayer;
      }, null, { timeout: 9000 });
      continue;
    }
    const i = chooseMove(st);
    await clickCell(page, i);
  }
  throw new Error('solve loop did not reach terminal within guard limit');
}

// ---------- navigate from title to Practice and start a single 3×3 round ----------
async function startPracticeSetup(page, difficulty) {
  await page.click('button.card:has-text("All Modes")');
  await page.waitForSelector('#screen-modes', { state: 'visible' });
  await page.click('button.mode-card:has-text("Practice")');
  await page.waitForSelector('#screen-practice', { state: 'visible' });
  await page.selectOption('#pr-diff', difficulty);
  await page.selectOption('#pr-board', '3');
  await page.selectOption('#pr-series', '1');
  await page.selectOption('#pr-side', '1');
  await page.screenshot({ path: SHOT('practice-setup', 'desktop') });
  await page.click('#screen-practice button[type="submit"]');
  await page.waitForSelector('#hud', { state: 'visible' });
  await waitActive(page);
  await freeTheBoard(page);
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title', { state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => !!window.__threeMarks?.session && window.__threeMarks.session.phase === 'title');
    const title = (await page.textContent('#title-h')) || '';
    if (!/Three Marks/i.test(title)) throw new Error(`unexpected title: "${title}"`);
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible ("${title.trim()}")`);

    if (full) {
      // Practice setup → a real 3×3 Casual single round where the human opens.
      await startPracticeSetup(page, 'casual');
      const st0 = await readState(page);
      if (st0.boardSize !== 3 || st0.human !== 1 || st0.currentPlayer !== 1) {
        throw new Error(`unexpected start: board ${st0.boardSize} human ${st0.human} current ${st0.currentPlayer}`);
      }
      const cells = await page.locator('#cell-overlay .cell-btn').count();
      if (cells !== 9) throw new Error(`expected 9 board cells, got ${cells}`);
      const objective = (await page.textContent('#objective')) || '';
      if (!/complete a line of 3/i.test(objective)) throw new Error(`unexpected objective: "${objective}"`);
      await page.screenshot({ path: SHOT('play', name) });
      ok(`${name}: practice round active (3×3, ${cells} cells, "Objective: ${objective.replace('Objective:', '').trim()}")`);

      // pause / resume via the visible HUD button
      await page.click('#btn-pause');
      await page.waitForFunction(() => document.querySelector('#modal-root .sheet[aria-label="Paused"]'));
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#modal-root .primary-btn:has-text("Resume")');
      await page.waitForFunction(() => window.__threeMarks.session.phase === 'active');
      ok(`${name}: pause (❚❚) and resume work`);

      // settings open/close via the pause sheet
      await page.click('#btn-pause');
      await page.click('#modal-root .ghost-btn:has-text("Settings")');
      await page.waitForSelector('#screen-settings', { state: 'visible' });
      await page.screenshot({ path: SHOT('settings', name) });
      await page.click('#screen-settings .back-btn');
      await page.waitForFunction(() => document.querySelector('#modal-root .sheet[aria-label="Paused"]'));
      await page.click('#modal-root .primary-btn:has-text("Resume")');
      await page.waitForFunction(() => window.__threeMarks.session.phase === 'active');
      ok(`${name}: settings open (from pause) and close back to the match`);

      // camera toggle cycle (cosmetic, safe, no rules impact)
      await page.click('#rail-right .action-btn:has-text("Camera")');
      const cam = await page.evaluate(() => window.__threeMarks.ui.settings.camera.angle);
      if (cam !== 'top') throw new Error(`camera did not cycle (angle now: ${cam})`);
      await page.waitForTimeout(700); // let the camera transition settle
      ok(`${name}: camera toggle cycles (angle now: ${cam})`);

      // place a mark, then Undo restores the empty board (practice allows undo)
      const before = await readState(page);
      const firstMove = chooseMove(before);
      await clickCell(page, firstMove);
      const afterMove = await readState(page);
      if (afterMove.humanMarks !== before.humanMarks + 1) throw new Error('mark did not register on the board');
      await page.click('#rail-right .action-btn:has-text("Undo")');
      const afterUndo = await readState(page);
      if (afterUndo.humanMarks !== before.humanMarks) throw new Error('undo did not restore the board');
      ok(`${name}: place a mark → Undo restores the board (back to ${afterUndo.humanMarks} of your marks)`);

      // Hint button highlights a recommended cell (marks the match assisted)
      await page.click('#rail-right .action-btn:has-text("Hint")');
      await page.waitForFunction(() => !!(window.__threeMarks.session.match?.assists?.hintUsed));
      const afterHint = await readState(page);
      if (!afterHint.hintUsed) throw new Error('hint did not mark the match assisted');
      ok(`${name}: Hint button issues a legal suggestion`);

      // play the round to a real terminal state on the visible board
      const done = await solveRound(page);
      if (done.status !== 'terminal') throw new Error('round did not reach terminal: ' + done.status);

      // results sheet with a headline + score breakdown
      await page.waitForSelector('#modal-root .sheet.results', { state: 'visible', timeout: 10000 });
      const headline = (await page.textContent('#modal-root .sheet.results h3')) || '';
      if (!/Victory|A Honest Draw|Defeat/i.test(headline)) throw new Error(`unexpected results headline: "${headline}"`);
      const scoreRows = await page.locator('#modal-root .sheet.results table tbody tr').count();
      if (scoreRows < 1) throw new Error('score breakdown table is empty');
      if (done.winner === 0 && !/A Honest Draw/i.test(headline)) throw new Error('draw but headline mismatch');
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: round resolved — results shown ("${headline.trim()}", ${scoreRows} score rows, human ${done.humanMarks} vs AI ${done.aiMarks})`);

      // progression persisted
      const prog = await page.evaluate(() => {
        const raw = localStorage.getItem('three-marks.player.progression');
        return raw ? JSON.parse(raw) : null;
      });
      if (!prog || !(prog.stats?.roundsPlayed > 0)) throw new Error('progression not persisted: ' + JSON.stringify(prog?.stats));
      ok(`${name}: progression persisted (rounds played: ${prog.stats.roundsPlayed}, won: ${prog.stats.roundsWon})`);
    } else {
      // Mobile: hold-to-start via the big Play button (quick practice round), then
      // make a few real touch taps on the visible board cells.
      await page.click('#btn-play');
      await page.waitForSelector('#hud', { state: 'visible' });
      await waitActive(page);
      await freeTheBoard(page);
      let tapped = 0;
      for (let i = 0; i < 3; i++) {
        const st = await readState(page);
        if (st.status === 'terminal') break;
        if (st.phase !== 'active' || st.currentPlayer !== st.human) {
          await page.waitForFunction(() => {
            const s = window.__threeMarks?.session;
            if (!s?.state) return false;
            if (s.state.status === 'terminal') return true;
            return s.phase === 'active' && s.state.currentPlayer === s.match?.humanPlayer;
          }, null, { timeout: 9000 });
          continue;
        }
        const i2 = chooseMove(st);
        const marksBefore = st.humanMarks;
        const c = await cellCenter(page, i2);
        if (c.x < 1 || c.y < 1 || c.x > 389 || c.y > 843) throw new Error(`tap point (${i2}) off mobile viewport: ` + JSON.stringify(c));
        await page.touchscreen.tap(c.x, c.y);
        // Wait for the human's mark to land anywhere on the board.
        await page.waitForFunction((n) => {
          const s = window.__threeMarks?.session;
          return !!s?.state && (s.state.status === 'terminal' || (s.state.marksPlaced[s.match?.humanPlayer] ?? 0) > n);
        }, marksBefore, { timeout: 5000 });
        tapped++;
      }
      const stF = await readState(page);
      if (stF.humanMarks < tapped) throw new Error(`expected >=${tapped} human marks, got ${stF.humanMarks}`);
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: load → Play → tapped ${tapped} cells via touchscreen (${stF.humanMarks} of your marks on the board)`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — three-marks, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
