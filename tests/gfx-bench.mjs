// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only, never shipped): picks a preset in Profile →
// Settings → Graphics, presses Play (a quick practice round) and keeps playing by clicking the projected
// centre of a sound move's cell on the 3D board, like a player — chalk strokes draw in, dust bursts, motes
// drift and the win line glows. A finished round goes again with the results sheet's Retry button.
// Like tests/e2e.mjs it reads the round state (window.__threeMarks) only to choose the move.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__threeMarks?.session?.phase === 'title', null, { timeout: 20000 });
  await page.click('#btn-profile');
  await page.waitForSelector('#screen-profile', { state: 'visible' });
  await page.click('#btn-profile-settings');
  await page.waitForSelector('#screen-settings', { state: 'visible' });
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#screen-settings .back-btn');
  await page.click('#screen-profile .back-btn');
  await page.waitForSelector('#btn-play', { state: 'visible' });
}

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

// Read the board and pick a move (win, block, centre, corner, edge) — the projected cell centre to click.
const nextMove = (page) => page.evaluate((lines) => {
  const s = window.__threeMarks?.session;
  if (document.querySelector('#modal-root [data-act="retry"]')) return { retry: true };
  if (!s?.state || s.phase !== 'active' || s.state.status !== 'active') return null;
  const me = s.match?.humanPlayer ?? 1;
  if (s.state.currentPlayer !== me) return null;
  const b = s.state.board, n = s.state.config.boardSize, opp = me === 1 ? 2 : 1;
  const empty = b.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (!empty.length) return null;
  let pick = -1;
  if (n === 3) {
    const wins = (p) => empty.find((i) => lines.some((l) => l.includes(i) && l.every((c) => c === i || b[c] === p)));
    pick = wins(me) ?? wins(opp) ?? (empty.includes(4) ? 4 : [0, 2, 6, 8, 1, 3, 5, 7].find((c) => empty.includes(c)));
  }
  if (pick == null || pick < 0) pick = empty[Math.floor(empty.length / 2)];
  const p = window.__threeMarks.ui.renderer.projectCell(pick);
  return { x: p.x, y: p.y };
}, LINES);

export async function start(page, { mobile } = {}) {
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__threeMarks?.session?.phase === 'active', null, { timeout: 20000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        const m = await nextMove(page);
        if (m?.retry) await page.click('#modal-root [data-act="retry"]', { timeout: 3000 });
        else if (m) {
          if (mobile) await page.touchscreen.tap(m.x, m.y); else await page.mouse.click(m.x, m.y);
        }
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(700).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
