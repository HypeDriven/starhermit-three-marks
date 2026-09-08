// Bootstrap: host handshake, capability detection, lifecycle wiring.
// Owns the canvas and starts the render/UI shells; degrades to a clear
// compatibility message (with the DOM board still usable) when WebGL fails.
import { Platform } from './platform.js';
import { Store } from './storage.js';
import { AudioEngine } from './audio.js';
import { GameSession, PHASE } from './session.js';
import { BoardRenderer } from './render.js';
import { UI } from './ui.js';
import { themeById, validateContent } from './content.js';

async function boot() {
  const root = document.getElementById('app-root');
  const bootStatus = document.getElementById('boot-status');

  const platform = new Platform();
  const store = new Store('player');
  const settings = store.loadSettings();
  platform.setTelemetryConsent(settings.telemetryConsent);

  // Content integrity check at boot (offline validator).
  const contentProblems = validateContent();
  if (contentProblems.length) {
    console.error('Content validation failed:', contentProblems);
    platform.track('error', { category: 'content' });
  }

  // Host handshake with clock sync (falls back to local time offline).
  const host = await platform.boot();
  if (bootStatus) bootStatus.textContent = host.hosted ? 'Connected to host.' : 'Offline mode — full local play.';

  const audio = new AudioEngine(settings);
  const session = new GameSession({ platform, store, audio });

  // Capability detection: WebGL.
  const canvas = document.createElement('canvas');
  canvas.id = 'gl-canvas';
  canvas.setAttribute('aria-hidden', 'true'); // DOM overlay is the accessible board
  let renderer = null;
  let webglOk = false;
  try {
    const probe = document.createElement('canvas');
    webglOk = !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    webglOk = false;
  }

  if (webglOk) {
    renderer = new BoardRenderer(canvas, { settings });
  } else {
    // 3D unavailable: clear compatibility message; account/session state is
    // preserved and the game remains playable through the DOM board.
    renderer = createFallbackRenderer(canvas);
    const note = document.createElement('div');
    note.className = 'compat-note';
    note.setAttribute('role', 'status');
    note.textContent = '3D rendering is unavailable in this browser, so the board is shown in simplified form. Your progress is safe.';
    root.append(note);
  }

  const ui = new UI({ root, session, renderer, audio, store, platform });
  ui.canvasWrap.prepend(canvas);

  // First gesture unlocks audio.
  const unlock = () => {
    if (audio.init()) {
      audio.resume();
      audio.startAmbience(themeById(settings.theme).ambience);
    }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // Lifecycle: resize, orientation, DPR, visibility.
  let resizeRaf = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => ui.onResize());
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  if (window.matchMedia) {
    const dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprMq.addEventListener?.('change', onResize);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Backgrounding pauses solo simulation; rendering drops to zero.
      renderer.stop();
      if (session.isPausable()) session.pause('hidden');
      audio.suspend();
      platform.flushTelemetry();
    } else {
      audio.resume();
      renderer.start();
      ui.onResize();
      if (session.phase === PHASE.PAUSED && session.phaseReason === 'hidden') {
        ui.openPauseModal('Paused while the tab was hidden.');
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    session.saveLocalSnapshot();
    platform.endActivity();
    platform.flushTelemetry();
  });

  platform.startPresence();

  // Idle attract scene on the title screen: the authored slate itself is
  // the hero; no fake gameplay is simulated behind the menus.
  renderer.setTheme(themeById(settings.theme));
  renderer.buildBoard({ boardSize: 3, winLength: 3, disabledCells: [], startMarks: [], moveLimit: 0, timeLimitMs: 0, firstPlayer: 1, misere: false }, 20240078);
  renderer.start();

  ui.showScreen('title');
  if (bootStatus) bootStatus.remove();

  // Debug/support handle (no privileged surface; same client trust level).
  window.__threeMarks = { session, ui, platform };
}

// DOM-only renderer fallback implementing the BoardRenderer interface used by
// the UI. The overlay grid buttons remain fully functional.
function createFallbackRenderer(canvas) {
  let selection = null;
  let boardN = 3;
  return {
    isFallback: true,
    onCellTap: null,
    onCellHover: null,
    setTheme() {},
    buildBoard(config) { if (config?.boardSize) boardN = config.boardSize; },
    syncState() {},
    setHover() {},
    setDisplayPlayer() {},
    setSelection(cell) { selection = cell; },
    setLessonHighlights() {},
    setQuality() {},
    setReducedMotion() {},
    setCameraAngle() {},
    skipAnimations() {},
    clearMarks() {},
    projectCell(i) {
      // Even grid over the canvas area.
      const wrap = canvas.parentElement;
      const rect = wrap ? wrap.getBoundingClientRect() : { left: 0, top: 0, width: 300, height: 300 };
      const n = boardN;
      const size = Math.min(rect.width, rect.height);
      const ox = rect.left + (rect.width - size) / 2;
      const oy = rect.top + (rect.height - size) / 2;
      const cell = size / n;
      return { x: ox + (i % n + 0.5) * cell, y: oy + (Math.floor(i / n) + 0.5) * cell, halfSize: cell / 2 };
    },
    resize() {},
    start() {},
    stop() {},
    dispose() {},
    _rebuildScenePreserving() {},
  };
}

boot().catch((err) => {
  console.error(err);
  const status = document.getElementById('boot-status');
  if (status) status.textContent = 'Something went wrong while starting. Please reload.';
});
