// UI layer: responsive DOM shell, screens, overlays, focus management,
// localization-ready strings, settings, and the accessibility mirror of the
// 3D board. UI state and simulation state are strictly separate: no drawer or
// modal can affect a match except through validated session commands.
import { legalCells } from './rules.js';
import { PracticeAI } from './ai.js';
import {
  LESSONS, JOURNEY_STAGES, CHAPTERS, CHALLENGES, THEMES, themeById, dailyFor,
} from './content.js';
import { ACHIEVEMENTS } from './storage.js';
import { PHASE } from './session.js';

export const DEFAULT_BINDINGS = {
  confirm: ['Enter', ' '],
  cancel: ['Escape'],
  pause: ['p', 'P'],
  undo: ['u', 'U'],
  hint: ['h', 'H'],
  cameraReset: ['c', 'C'],
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
};

const BINDING_LABELS = {
  confirm: 'Place mark / confirm', cancel: 'Cancel / back', pause: 'Pause',
  undo: 'Undo (where allowed)', hint: 'Hint (practice)', cameraReset: 'Reset camera',
  up: 'Move selection up', down: 'Move selection down', left: 'Move selection left', right: 'Move selection right',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const MODE_META = {
  learn: { name: 'Learn', desc: 'Interactive lessons. One rule at a time — you perform every action.', duration: '~3 min', players: 'Solo', ranked: false },
  journey: { name: 'Journey', desc: 'Forty authored stages across five chapters, with mastery tests.', duration: '2–10 min', players: 'Solo vs AI', ranked: false },
  daily: { name: 'Daily', desc: 'One shared seed and ruleset per UTC day. Same slate for everyone.', duration: '~2 min', players: 'Solo vs AI', ranked: true },
  practice: { name: 'Practice', desc: 'Free play against the AI. Undo and hints allowed; never rated.', duration: 'You choose', players: 'Solo vs AI', ranked: false },
  challenge: { name: 'Challenge', desc: 'Constrained goals: clocks, move limits, sealed cells, misère.', duration: '1–5 min', players: 'Solo vs AI', ranked: false },
  hosted: { name: 'Hosted Play', desc: 'Private invitations and public matching with reconnect and authoritative results.', duration: 'Varies', players: '2 players', ranked: true },
};

export class UI {
  constructor({ root, session, renderer, audio, store, platform }) {
    this.root = root;
    this.session = session;
    this.renderer = renderer;
    this.audio = audio;
    this.store = store;
    this.platform = platform;
    this.settings = store.loadSettings();
    this.screen = 'title';
    this.lastMatchOptions = null;
    this.pendingConfirmCell = null;
    this.selectedCell = 4;
    this.modal = null;
    this.previousFocus = null;
    this.hintAI = null;
    this._gamepad = { index: null, prev: {}, raf: null };
    this._build();
    this._wireSession();
    this._wireInput();
    this.applySettings(this.settings);
  }

  // ================= DOM skeleton =================

  _build() {
    this.root.innerHTML = '';
    this.root.id = 'app';

    this.canvasWrap = el('div', { id: 'canvas-wrap', role: 'application', 'aria-label': 'Three Marks board' });
    this.cellOverlay = el('div', { id: 'cell-overlay', role: 'grid', 'aria-label': 'Board cells' });
    this.canvasWrap.append(this.cellOverlay);

    // HUD
    this.hud = el('div', { id: 'hud', hidden: true });
    this.objectiveEl = el('div', { id: 'objective', role: 'status' });
    this.turnBanner = el('div', { id: 'turn-banner' });
    this.clockEl = el('div', { id: 'clock-display' });
    this.btnPause = el('button', { id: 'btn-pause', class: 'icon-btn', 'aria-label': 'Pause', onclick: () => this.pauseGame() }, 'II');
    const hudTop = el('div', { id: 'hud-top' }, this.objectiveEl, this.turnBanner, this.clockEl, this.btnPause);

    this.railLeft = el('aside', { id: 'rail-left', 'aria-label': 'Match progress' });
    this.railRight = el('aside', { id: 'rail-right', 'aria-label': 'Actions' });
    this.btnUndo = el('button', { class: 'action-btn', onclick: () => this.doUndo() }, 'Undo');
    this.btnHint = el('button', { class: 'action-btn', onclick: () => this.doHint() }, 'Hint');
    this.btnCamera = el('button', { class: 'action-btn', onclick: () => this.cycleCamera() }, 'Camera');
    this.railRight.append(
      el('h3', { class: 'rail-title' }, 'Actions'),
      this.btnUndo, this.btnHint, this.btnCamera
    );
    this.hud.append(hudTop, this.railLeft, this.railRight);

    // Screens
    this.screens = el('main', { id: 'screens' });
    this._buildTitleScreen();
    this._buildModeScreen();
    this._buildJourneyScreen();
    this._buildChallengeScreen();
    this._buildLessonsScreen();
    this._buildPracticeScreen();
    this._buildAchievementsScreen();
    this._buildHelpScreen();
    this._buildSettingsScreen();
    this._buildProfileScreen();
    this._buildHostedScreen();

    this.modalRoot = el('div', { id: 'modal-root', hidden: true });
    this.toastRoot = el('div', { id: 'toasts', 'aria-hidden': 'true' });
    this.livePolite = el('div', { id: 'live-polite', class: 'sr-only', 'aria-live': 'polite', role: 'status' });
    this.liveAssertive = el('div', { id: 'live-assertive', class: 'sr-only', 'aria-live': 'assertive', role: 'alert' });

    this.root.append(this.canvasWrap, this.hud, this.screens, this.modalRoot, this.toastRoot, this.livePolite, this.liveAssertive);
  }

  _buildTitleScreen() {
    const prog = this.store.loadProgression();
    this.titleDailyCard = el('button', { class: 'card', onclick: () => this.startDaily() });
    this.titleJourneyCard = el('button', { class: 'card', onclick: () => this.showScreen('journey') });
    this.screenTitle = el('section', { class: 'screen', id: 'screen-title', 'aria-labelledby': 'title-h' },
      el('div', { class: 'title-hero' },
        el('h1', { id: 'title-h' }, 'Three Marks'),
        el('p', { class: 'tagline' }, 'Alternate marks on the slate. Complete a row, column, or diagonal.'),
        el('button', {
          id: 'btn-play', class: 'primary-btn big', onclick: () => this.quickPlay(),
        }, 'Play'),
        this.session.hasLocalSnapshot()
          ? el('button', { class: 'ghost-btn resume-btn', onclick: () => this.resumeSnapshot() }, 'Resume interrupted match')
          : null,
      ),
      el('div', { class: 'title-cards' },
        this.titleDailyCard,
        this.titleJourneyCard,
        el('button', { class: 'card', onclick: () => this.showScreen('modes') },
          el('strong', {}, 'All Modes'), el('span', {}, 'Learn · Practice · Challenge · Hosted')),
        el('button', { class: 'card', onclick: () => this.showScreen('profile') },
          el('strong', {}, 'Profile'), el('span', {}, 'Progress, achievements, settings')),
      ),
    );
    this.screens.append(this.screenTitle);
    this._refreshTitleCards();
  }

  _refreshTitleCards() {
    const prog = this.store.loadProgression();
    const daily = dailyFor(new Date(this.platform.serverNow()));
    const done = prog.dailies[daily.id];
    this.titleDailyCard.innerHTML = '';
    this.titleDailyCard.append(
      el('strong', {}, 'Daily Challenge'),
      el('span', {}, `${daily.rulesetName} — ${done ? `done, best ${done.score}` : 'not played yet'}`),
    );
    const doneStages = Object.values(prog.journey).filter((j) => j.stars > 0).length;
    const stars = Object.values(prog.journey).reduce((s, j) => s + (j.stars || 0), 0);
    this.titleJourneyCard.innerHTML = '';
    this.titleJourneyCard.append(
      el('strong', {}, 'Journey'),
      el('span', {}, `${doneStages}/40 stages · ${stars} stars`),
    );
    // Keep the resume affordance in sync with the stored snapshot.
    const existing = this.screenTitle.querySelector('.resume-btn');
    if (this.session.hasLocalSnapshot() && !existing) {
      const btn = el('button', { class: 'ghost-btn resume-btn', onclick: () => this.resumeSnapshot() }, 'Resume interrupted match');
      this.screenTitle.querySelector('.title-hero').append(btn);
    } else if (!this.session.hasLocalSnapshot() && existing) {
      existing.remove();
    }
  }

  _buildModeScreen() {
    const cards = Object.entries(MODE_META).map(([mode, meta]) => {
      const locked = mode === 'hosted' && !this.platform.hosted;
      return el('button', {
        class: 'mode-card' + (locked ? ' locked' : ''),
        'aria-disabled': locked ? 'true' : null,
        onclick: () => this.openMode(mode),
      },
        el('h3', {}, meta.name),
        el('p', {}, meta.desc),
        el('dl', { class: 'mode-facts' },
          el('div', {}, el('dt', {}, 'Duration'), el('dd', {}, meta.duration)),
          el('div', {}, el('dt', {}, 'Players'), el('dd', {}, meta.players)),
          el('div', {}, el('dt', {}, 'Ranked'), el('dd', {}, meta.ranked ? 'Yes' : 'No')),
        ),
        locked ? el('p', { class: 'locked-note' }, 'Requires the StarHermit host connection.') : null,
      );
    });
    this.screenModes = el('section', { class: 'screen', id: 'screen-modes', hidden: true, 'aria-labelledby': 'modes-h' },
      this._screenHeader('Choose a Mode', 'Every mode shows its rules before you commit.'),
      el('div', { class: 'mode-grid' }, cards),
    );
    this.screens.append(this.screenModes);
  }

  _buildJourneyScreen() {
    this.journeyList = el('div', { class: 'stage-list' });
    this.screenJourney = el('section', { class: 'screen', id: 'screen-journey', hidden: true, 'aria-labelledby': 'journey-h' },
      this._screenHeader('Journey', 'One new idea at a time — then a mastery test.'),
      this.journeyList,
    );
    this.screens.append(this.screenJourney);
  }

  _refreshJourney() {
    const prog = this.store.loadProgression();
    this.journeyList.innerHTML = '';
    JOURNEY_STAGES.forEach((stage, i) => {
      if (i % 8 === 0) {
        this.journeyList.append(el('h3', { class: 'chapter-title' }, `Chapter ${stage.chapter + 1} — ${CHAPTERS[stage.chapter].name}`));
      }
      const rec = prog.journey[stage.id];
      const prevDone = i === 0 || (prog.journey[JOURNEY_STAGES[i - 1].id]?.stars || 0) > 0;
      const locked = !prevDone;
      const stars = rec?.stars || 0;
      this.journeyList.append(el('button', {
        class: `stage-row${locked ? ' locked' : ''}${stage.mastery ? ' mastery' : ''}`,
        'aria-disabled': locked ? 'true' : null,
        onclick: () => { if (!locked) this.openStageSheet(stage); },
      },
        el('span', { class: 'stage-num' }, String(stage.index)),
        el('span', { class: 'stage-name' }, stage.name, el('small', {}, stage.blurb)),
        el('span', { class: 'stars', 'aria-label': `${stars} of 3 stars` }, '★'.repeat(stars) + '☆'.repeat(3 - stars)),
      ));
    });
  }

  _buildChallengeScreen() {
    const list = el('div', { class: 'card-list' });
    this.challengeList = list;
    this.screenChallenges = el('section', { class: 'screen', id: 'screen-challenges', hidden: true, 'aria-labelledby': 'chal-h' },
      this._screenHeader('Challenges', 'Constrained goals for a sharp session.'),
      list,
    );
    this.screens.append(this.screenChallenges);
  }

  _refreshChallenges() {
    const prog = this.store.loadProgression();
    this.challengeList.innerHTML = '';
    for (const c of CHALLENGES) {
      const rec = prog.challenges[c.id];
      this.challengeList.append(el('button', { class: 'card row', onclick: () => this.openChallengeSheet(c) },
        el('strong', {}, c.name),
        el('span', {}, c.blurb),
        el('em', {}, rec ? `Completed · best ${rec.bestScore}` : c.goalText),
      ));
    }
  }

  _buildLessonsScreen() {
    this.lessonList = el('div', { class: 'card-list' });
    this.screenLessons = el('section', { class: 'screen', id: 'screen-lessons', hidden: true, 'aria-labelledby': 'learn-h' },
      this._screenHeader('Learn', 'Short interactive lessons. Replay any time.'),
      this.lessonList,
    );
    this.screens.append(this.screenLessons);
  }

  _refreshLessons() {
    const prog = this.store.loadProgression();
    this.lessonList.innerHTML = '';
    for (const l of LESSONS) {
      const done = !!prog.lessons[l.id];
      this.lessonList.append(el('button', { class: 'card row', onclick: () => this.startLesson(l) },
        el('strong', {}, `${done ? '✓ ' : ''}${l.name}`),
        el('span', {}, l.intro),
      ));
    }
  }

  _buildPracticeScreen() {
    this.practiceDifficulty = el('select', { id: 'pr-diff' },
      el('option', { value: 'casual' }, 'Casual — learning the ropes'),
      el('option', { value: 'skilled', selected: true }, 'Skilled — a real game'),
      el('option', { value: 'expert' }, 'Expert — solved, perfect play'));
    this.practiceBoard = el('select', { id: 'pr-board' },
      el('option', { value: '3', selected: true }, '3×3 — classic'),
      el('option', { value: '4' }, '4×4 — line of 4'),
      el('option', { value: '5' }, '5×5 — line of 4'));
    this.practiceSeries = el('select', { id: 'pr-series' },
      el('option', { value: '1', selected: true }, 'Single round'),
      el('option', { value: '3' }, 'Best of 3'),
      el('option', { value: '5' }, 'Best of 5'));
    this.practiceSide = el('select', { id: 'pr-side' },
      el('option', { value: '1', selected: true }, 'You open (X)'),
      el('option', { value: '2' }, 'AI opens (you are O)'));
    this.screenPractice = el('section', { class: 'screen', id: 'screen-practice', hidden: true, 'aria-labelledby': 'prac-h' },
      this._screenHeader('Practice Setup', 'Free play. Undo and hints are allowed; results are never rated.'),
      el('form', { class: 'setup-form', onsubmit: (e) => { e.preventDefault(); this.startPractice(); } },
        el('label', {}, 'Difficulty', this.practiceDifficulty),
        el('label', {}, 'Board', this.practiceBoard),
        el('label', {}, 'Series', this.practiceSeries),
        el('label', {}, 'Side', this.practiceSide),
        el('div', { class: 'mode-facts inline' },
          el('span', {}, 'Players: Solo vs AI'), el('span', {}, 'Ranked: No'),
          el('span', {}, 'Assists: undo, hints')),
        el('button', { class: 'primary-btn', type: 'submit' }, 'Start Practice'),
      ),
    );
    this.screens.append(this.screenPractice);
  }

  _buildAchievementsScreen() {
    this.achList = el('ul', { class: 'ach-list' });
    this.screenAchievements = el('section', { class: 'screen', id: 'screen-achievements', hidden: true, 'aria-labelledby': 'ach-h' },
      this._screenHeader('Achievements', 'Long-term goals, visible without pressure.'),
      this.achList,
    );
    this.screens.append(this.screenAchievements);
  }

  _refreshAchievements() {
    const prog = this.store.loadProgression();
    this.achList.innerHTML = '';
    for (const a of ACHIEVEMENTS) {
      const got = prog.achievements[a.key];
      this.achList.append(el('li', { class: got ? 'unlocked' : 'locked' },
        el('strong', {}, a.name),
        el('span', {}, a.desc),
        el('em', {}, got ? `Unlocked ${new Date(got.unlockedAt).toLocaleDateString()}` : 'Locked'),
      ));
    }
  }

  _buildHelpScreen() {
    this.helpBindings = el('div', { class: 'rule-cards' });
    this.screenHelp = el('section', { class: 'screen', id: 'screen-help', hidden: true, 'aria-labelledby': 'help-h' },
      this._screenHeader('How to Play', 'Rules and controls, generated from your current setup.'),
      el('div', { class: 'rule-cards' },
        this._ruleCard('The Goal', 'Complete a row, column, or diagonal of your marks before your rival completes theirs.', [['X', 'X', 'X'], ['O', '', 'O'], ['', '', '']]),
        this._ruleCard('Taking Turns', 'Players alternate one mark at a time on empty cells. The turn banner shows whose move it is.', [['X', 'O', ''], ['', 'X', ''], ['O', '', '']]),
        this._ruleCard('The Draw', 'If the board fills with no line complete, the round is an honest draw.', [['X', 'O', 'X'], ['X', 'O', 'O'], ['O', 'X', 'X']]),
        this._ruleCard('Variants', 'Journey and Challenge modes add sealed cells, move limits, clocks, larger boards, and misère rounds where completing a line loses.', [['X', '■', 'O'], ['', 'X', ''], ['O', '', '']]),
      ),
      el('h3', {}, 'Your Controls'),
      this.helpBindings,
      el('h3', {}, 'Gamepad'),
      el('p', { class: 'help-note' }, 'D-pad or left stick moves the selection, the south button places a mark, the east button cancels, and the menu button pauses.'),
    );
    this.screens.append(this.screenHelp);
  }

  _ruleCard(title, text, grid) {
    return el('div', { class: 'rule-card' },
      el('h4', {}, title),
      el('p', {}, text),
      el('div', { class: 'mini-board', role: 'img', 'aria-label': `Example board for: ${title}` },
        grid.flat().map((c) => el('span', { class: c === 'X' ? 'm-x' : c === 'O' ? 'm-o' : c === '■' ? 'm-block' : '' }, c || '·'))),
    );
  }

  _refreshHelpBindings() {
    const bindings = this.effectiveBindings();
    this.helpBindings.innerHTML = '';
    for (const [action, keys] of Object.entries(bindings)) {
      this.helpBindings.append(el('div', { class: 'binding-row' },
        el('span', {}, BINDING_LABELS[action] || action),
        el('kbd', {}, keys.map((k) => (k === ' ' ? 'Space' : k)).join(' / ')),
      ));
    }
  }

  _buildSettingsScreen() {
    const s = this.settings;
    const slider = (key, label) => el('label', { class: 'slider-row' }, label,
      el('input', {
        type: 'range', min: 0, max: 1, step: 0.05, value: s.audio[key],
        oninput: (e) => this.updateSetting(`audio.${key}`, parseFloat(e.target.value)),
        'aria-label': label,
      }));
    this.setMusic = slider('music', 'Music');
    this.setEffects = slider('effects', 'Effects');
    this.setAmbience = slider('ambience', 'Ambience');
    this.setVoice = slider('voice', 'Voice');
    this.setMuted = el('input', { type: 'checkbox', onchange: (e) => this.updateSetting('audio.muted', e.target.checked) });

    this.setTier = el('select', { onchange: (e) => this.updateSetting('graphics.tier', e.target.value) },
      el('option', { value: 'auto' }, 'Auto'), el('option', { value: 'low' }, 'Low'),
      el('option', { value: 'medium' }, 'Medium'), el('option', { value: 'high' }, 'High'));
    this.setScale = el('input', {
      type: 'range', min: 0.5, max: 1, step: 0.05, value: s.graphics.renderScale,
      oninput: (e) => this.updateSetting('graphics.renderScale', parseFloat(e.target.value)), 'aria-label': 'Render scale',
    });

    const toggle = (key, label) => {
      const input = el('input', { type: 'checkbox', onchange: (e) => this.updateSetting(`accessibility.${key}`, e.target.checked) });
      return { input, row: el('label', { class: 'toggle-row' }, input, el('span', {}, label)) };
    };
    this.togReduced = toggle('reducedMotion', 'Reduced motion');
    this.togContrast = toggle('highContrast', 'High contrast');
    this.togLargerText = toggle('largerText', 'Larger text');
    this.togLefty = toggle('leftHanded', 'Left-handed controls');
    this.togConfirm = toggle('confirmMoves', 'Confirm before placing (tap twice)');
    this.togTiming = toggle('timingAssist', 'Timing assistance (+50% clocks, unranked)');
    this.togHaptics = toggle('haptics', 'Haptics');

    this.setPalette = el('select', { onchange: (e) => this.updateSetting('accessibility.palette', e.target.value) },
      el('option', { value: 'default' }, 'Default colors'),
      el('option', { value: 'deuteranopia' }, 'Deuteranopia-safe'),
      el('option', { value: 'tritanopia' }, 'Tritanopia-safe'));
    this.setCamera = el('select', { onchange: (e) => this.updateSetting('camera.angle', e.target.value) },
      el('option', { value: 'standard' }, 'Standard'), el('option', { value: 'top' }, 'Top-down'), el('option', { value: 'low' }, 'Low angle'));
    this.setTheme = el('select', { onchange: (e) => this.updateSetting('theme', e.target.value) },
      THEMES.map((t) => el('option', { value: t.id }, t.name)));
    this.setTelemetry = el('input', { type: 'checkbox', onchange: (e) => this.updateSetting('telemetryConsent', e.target.checked) });
    this.bindingsEditor = el('div', { class: 'bindings-editor' });

    this.screenSettings = el('section', { class: 'screen', id: 'screen-settings', hidden: true, 'aria-labelledby': 'set-h' },
      this._screenHeader('Settings', 'Everything takes effect immediately.'),
      el('div', { class: 'settings-grid' },
        el('fieldset', {}, el('legend', {}, 'Audio'),
          this.setMusic, this.setEffects, this.setAmbience, this.setVoice,
          el('label', { class: 'toggle-row' }, this.setMuted, el('span', {}, 'Mute all'))),
        el('fieldset', {}, el('legend', {}, 'Graphics'),
          el('label', { class: 'slider-row' }, 'Quality tier', this.setTier),
          el('label', { class: 'slider-row' }, 'Render scale', this.setScale),
          el('label', { class: 'slider-row' }, 'Theme', this.setTheme),
          el('label', { class: 'slider-row' }, 'Camera', this.setCamera)),
        el('fieldset', {}, el('legend', {}, 'Accessibility'),
          this.togReduced.row, this.togContrast.row, this.togLargerText.row, this.togLefty.row,
          this.togConfirm.row, this.togTiming.row, this.togHaptics.row,
          el('label', { class: 'slider-row' }, 'Color palette', this.setPalette)),
        el('fieldset', {}, el('legend', {}, 'Keyboard bindings'), this.bindingsEditor),
        el('fieldset', {}, el('legend', {}, 'Privacy'),
          el('label', { class: 'toggle-row' }, this.setTelemetry, el('span', {}, 'Share anonymous usage statistics (aggregate only)')),
          el('button', { class: 'ghost-btn', onclick: () => this.resetProgress() }, 'Reset all local progress')),
      ),
    );
    this.screens.append(this.screenSettings);
  }

  _buildProfileScreen() {
    this.profileStats = el('div', { class: 'profile-stats' });
    this.nameInput = el('input', {
      type: 'text', maxlength: 24, value: this.settings.name, 'aria-label': 'Display name',
      onchange: (e) => { this.updateSetting('name', e.target.value.slice(0, 24) || 'Guest'); },
    });
    this.screenProfile = el('section', { class: 'screen', id: 'screen-profile', hidden: true, 'aria-labelledby': 'prof-h' },
      this._screenHeader('Profile', 'Local progress. Sign in arrives with the host connection.'),
      el('div', { class: 'profile-grid' },
        el('div', { class: 'card' },
          el('h3', {}, 'Identity'),
          el('label', { class: 'slider-row' }, 'Display name', this.nameInput),
          el('p', { class: 'help-note' }, this.platform.hosted
            ? 'Connected to StarHermit — progress syncs to your account.'
            : 'Playing as a guest. Progress is stored on this device only.')),
        el('div', { class: 'card' }, el('h3', {}, 'Statistics'), this.profileStats),
        el('div', { class: 'card' },
          el('h3', {}, 'Friends & Social'),
          el('p', { class: 'help-note' }, this.platform.hosted
            ? 'Friends panel, invitations and chat are available.'
            : 'Friends, invitations and chat require the StarHermit host. Offline, your social layer stays private.')),
        el('div', { class: 'card' },
          el('h3', {}, 'Shortcuts'),
          el('button', { class: 'ghost-btn', onclick: () => this.showScreen('achievements') }, 'Achievements'),
          el('button', { class: 'ghost-btn', onclick: () => this.showScreen('settings') }, 'Settings'),
          el('button', { class: 'ghost-btn', onclick: () => this.showScreen('help') }, 'How to play')),
      ),
    );
    this.screens.append(this.screenProfile);
  }

  _refreshProfile() {
    const prog = this.store.loadProgression();
    const st = prog.stats;
    const rows = [
      ['Rounds played', st.roundsPlayed],
      ['Rounds won', st.roundsWon],
      ['Draws', st.roundsDrawn],
      ['Total score', st.totalScore],
      ['Achievements', `${Object.keys(prog.achievements).length}/${ACHIEVEMENTS.length}`],
      ['Lessons done', `${Object.keys(prog.lessons).length}/${LESSONS.length}`],
    ];
    this.profileStats.innerHTML = '';
    for (const [k, v] of rows) {
      this.profileStats.append(el('div', { class: 'stat-row' }, el('span', {}, k), el('strong', {}, String(v))));
    }
  }

  _buildHostedScreen() {
    this.screenHosted = el('section', { class: 'screen', id: 'screen-hosted', hidden: true, 'aria-labelledby': 'host-h' },
      this._screenHeader('Hosted Play', 'Private invitations and public matching.'),
      el('div', { class: 'card' },
        this.platform.hosted
          ? el('div', {},
              el('p', {}, 'Connected. Create a private invitation or join public matching.'),
              el('button', { class: 'primary-btn', onclick: () => this.toast('Invitations are managed in the host shell.') }, 'Create invitation'),
              el('button', { class: 'ghost-btn', onclick: () => this.toast('Matchmaking is managed in the host shell.') }, 'Find match'))
          : el('div', {},
              el('p', {}, 'Hosted play needs the StarHermit host connection for invitations, matchmaking, reconnect and authoritative results.'),
              el('p', { class: 'help-note' }, 'Everything else — Learn, Journey, Daily, Practice, Challenge — works fully offline.'))),
    );
    this.screens.append(this.screenHosted);
  }

  _screenHeader(title, sub) {
    return el('header', { class: 'screen-header' },
      el('button', { class: 'back-btn', onclick: () => this.goBack(), 'aria-label': 'Back' }, '←'),
      el('div', {}, el('h2', {}, title), el('p', { class: 'screen-sub' }, sub)),
      el('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => this.showScreen('settings') }, '⚙'),
    );
  }

  // ================= navigation =================

  showScreen(name) {
    if ((name === 'settings' || name === 'help') && this.screen !== name && !this._returnToPause) {
      this._settingsFrom = ['settings', 'help', 'none'].includes(this.screen) ? this._settingsFrom : this.screen;
    }
    this.screen = name;
    for (const sec of this.screens.querySelectorAll('.screen')) sec.hidden = true;
    const map = {
      title: this.screenTitle, modes: this.screenModes, journey: this.screenJourney,
      challenges: this.screenChallenges, lessons: this.screenLessons, practice: this.screenPractice,
      achievements: this.screenAchievements, help: this.screenHelp, settings: this.screenSettings,
      profile: this.screenProfile, hosted: this.screenHosted,
    };
    if (name === 'journey') this._refreshJourney();
    if (name === 'challenges') this._refreshChallenges();
    if (name === 'lessons') this._refreshLessons();
    if (name === 'achievements') this._refreshAchievements();
    if (name === 'profile') this._refreshProfile();
    if (name === 'help') this._refreshHelpBindings();
    if (name === 'title') this._refreshTitleCards();
    const target = map[name];
    if (target) {
      target.hidden = false;
      const focusable = target.querySelector('button, select, input');
      if (focusable) focusable.focus({ preventScroll: true });
    }
    if (name === 'title' || name === 'modes') {
      this.session.setPhase(name === 'title' ? PHASE.TITLE : PHASE.MODE_SELECT, 'ui', 'navigate');
    }
    if (this.audio) this.audio.uiTick();
  }

  goBack() {
    if (this._returnToPause && (this.screen === 'settings' || this.screen === 'help')) {
      // Settings/help were opened from the pause menu: return to the match.
      this._returnToPause = false;
      this.hud.hidden = false;
      this.showScreen('none');
      this.openPauseModal();
      return;
    }
    const flow = {
      modes: 'title', journey: 'modes', challenges: 'modes', lessons: 'modes',
      practice: 'modes', hosted: 'modes', achievements: 'profile', settings: this._settingsFrom || 'title',
      help: this._settingsFrom || 'title', profile: 'title',
    };
    if (this.audio) this.audio.uiBack();
    this.showScreen(flow[this.screen] || 'title');
  }

  openMode(mode) {
    if (mode === 'hosted') return this.showScreen('hosted');
    if (mode === 'learn') return this.showScreen('lessons');
    if (mode === 'journey') return this.showScreen('journey');
    if (mode === 'challenge') return this.showScreen('challenges');
    if (mode === 'practice') return this.showScreen('practice');
    if (mode === 'daily') return this.startDaily();
  }

  quickPlay() {
    // Short path to play: one press starts a practice round with saved prefs.
    this.startPractice();
  }

  resumeSnapshot() {
    if (this.session.loadLocalSnapshot()) {
      this.enterPlayfield();
      this.openPauseModal('Match restored where you left it.');
    }
  }

  // ================= match setup sheets =================

  _setupSheet({ title, rows, onStart, startLabel = 'Start' }) {
    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('h3', {}, title),
      el('dl', { class: 'mode-facts' }, rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v)))),
      el('div', { class: 'sheet-actions' },
        el('button', { class: 'primary-btn', onclick: () => { this.closeModal(); onStart(); } }, startLabel),
        el('button', { class: 'ghost-btn', onclick: () => this.closeModal() }, 'Cancel')),
    );
    this.openModal(sheet);
  }

  _rulesSummary(config) {
    const parts = [`${config.boardSize}×${config.boardSize} board`, `line of ${config.winLength} wins`];
    if (config.disabledCells.length) parts.push(`${config.disabledCells.length} sealed cell${config.disabledCells.length > 1 ? 's' : ''}`);
    if (config.moveLimit) parts.push(`${config.moveLimit} marks each`);
    if (config.timeLimitMs) parts.push(`${fmtTime(config.timeLimitMs)} clock each`);
    if (config.misere) parts.push('misère: lines lose');
    if (config.startMarks.length) parts.push(`${config.startMarks.length} opening mark${config.startMarks.length > 1 ? 's' : ''}`);
    return parts.join(' · ');
  }

  openStageSheet(stage) {
    const prog = this.store.loadProgression();
    const rec = prog.journey[stage.id];
    this._setupSheet({
      title: `Stage ${stage.index} — ${stage.name}`,
      rows: [
        ['Rules', this._rulesSummary(stage.config)],
        ['Opponent', `${stage.opponent.name} (${stage.opponent.difficulty})`],
        ['Series', stage.series > 1 ? `Best of ${stage.series}` : 'Single round'],
        ['Duration', stage.par.timeMs >= 240000 ? '~5 min' : '~2 min'],
        ['Ranked', 'No (progression)'],
        ['Par', `${stage.par.marks} marks · ${fmtTime(stage.par.timeMs)}`],
        ['Best', rec ? `${rec.stars}★ · ${rec.bestScore} pts` : '—'],
      ],
      onStart: () => this.startStage(stage),
    });
  }

  openChallengeSheet(c) {
    this._setupSheet({
      title: c.name,
      rows: [
        ['Goal', c.goalText],
        ['Rules', this._rulesSummary(c.config)],
        ['Opponent', c.ai],
        ['Seed', String(c.seed)],
        ['Ranked', 'No'],
      ],
      onStart: () => this.startChallenge(c),
    });
  }

  // ================= match start =================

  startStage(stage) {
    this.lastMatchOptions = {
      mode: 'journey', contentId: stage.id, contentName: `Stage ${stage.index} — ${stage.name}`,
      config: stage.config, seed: stage.seed, ai: stage.opponent.difficulty,
      humanPlayer: stage.humanPlayer, series: stage.series, theme: stage.theme,
      par: stage.par, goals: stage.goals, ranked: false,
      assists: { timingAssist: this.settings.accessibility.timingAssist },
    };
    this._launch(this.lastMatchOptions);
  }

  startChallenge(c) {
    this.lastMatchOptions = {
      mode: 'challenge', contentId: c.id, contentName: c.name,
      config: c.config, seed: c.seed, ai: c.ai, series: c.series, theme: c.theme,
      par: { marks: 5, timeMs: 120000 }, ranked: false,
      assists: { timingAssist: this.settings.accessibility.timingAssist },
    };
    this._launch(this.lastMatchOptions);
  }

  startDaily() {
    const daily = dailyFor(new Date(this.platform.serverNow()));
    this._setupSheet({
      title: daily.name,
      rows: [
        ['Date (UTC)', daily.date],
        ['Rules', this._rulesSummary(daily.config)],
        ['Opponent', daily.ai],
        ['Seed', String(daily.seed)],
        ['Ranked', this.settings.accessibility.timingAssist ? 'No (timing assist on)' : 'Yes — fair daily board'],
      ],
      onStart: () => {
        this.lastMatchOptions = {
          mode: 'daily', contentId: daily.id, contentName: daily.name,
          config: daily.config, seed: daily.seed, ai: daily.ai, series: 1, theme: daily.theme,
          par: { marks: 5, timeMs: 90000 }, ranked: true,
          assists: { timingAssist: this.settings.accessibility.timingAssist },
        };
        this._launch(this.lastMatchOptions);
      },
    });
  }

  startPractice() {
    const size = parseInt(this.practiceBoard.value, 10);
    this.lastMatchOptions = {
      mode: 'practice', contentId: null, contentName: 'Practice',
      config: { boardSize: size, winLength: size === 3 ? 3 : 4 },
      seed: (Math.floor(Math.random() * 1e9) >>> 0),
      ai: this.practiceDifficulty.value,
      humanPlayer: parseInt(this.practiceSide.value, 10),
      series: parseInt(this.practiceSeries.value, 10),
      theme: this.settings.theme,
      par: { marks: size + 2, timeMs: 120000 }, ranked: false,
      assists: { timingAssist: this.settings.accessibility.timingAssist },
    };
    this._launch(this.lastMatchOptions);
  }

  startLesson(lesson) {
    this.platform.track('tutorial_step', { lesson: lesson.index, step: 0 });
    this.session.startLesson(lesson);
    this.enterPlayfield();
    this.announce(`Lesson: ${lesson.name}. ${lesson.intro}`);
  }

  _launch(options) {
    this.platform.track('start', { mode: options.mode });
    this.platform.startActivity();
    this.session.startMatch(options);
    this.hintAI = new PracticeAI('expert', (options.seed ^ 0x17) >>> 0);
    this.enterPlayfield();
  }

  enterPlayfield() {
    this.showScreen('none');
    this.hud.hidden = false;
    this.pendingConfirmCell = null;
    const m = this.session.match;
    const theme = themeById(m?.theme || this.settings.theme);
    this.renderer.setTheme(theme);
    this.renderer.buildBoard(this.session.state.config, this.session.state.seed);
    this.renderer.setDisplayPlayer(m?.humanPlayer || 1);
    this.renderer.syncState(this.session.state, { instant: true });
    this._buildCellOverlay();
    this._updateHudChrome();
    if (this.audio) {
      this.audio.setSeed(this.session.state.seed);
      this.audio.startAmbience(theme.ambience);
      this.audio.startMusic();
      this.audio.setMusicIntensity(0.15);
    }
    this.renderer.start();
  }

  leaveMatch() {
    this.session.abandonMatch();
    this.hud.hidden = true;
    this.pendingConfirmCell = null;
    // Restore the calm title attract board behind the menus.
    this.renderer.setTheme(themeById(this.settings.theme));
    this.renderer.buildBoard(
      { boardSize: 3, winLength: 3, disabledCells: [], startMarks: [], moveLimit: 0, timeLimitMs: 0, firstPlayer: 1, misere: false },
      20240078
    );
    if (this.audio) {
      this.audio.setMusicIntensity(0);
      this.audio.startAmbience(themeById(this.settings.theme).ambience);
    }
    this.showScreen('modes');
  }

  // ================= cell overlay (DOM mirror of the 3D board) =================

  _buildCellOverlay() {
    this.cellOverlay.innerHTML = '';
    const state = this.session.state;
    const n = state.config.boardSize;
    this.cellOverlay.setAttribute('aria-rowcount', String(n));
    this.cellOverlay.setAttribute('aria-colcount', String(n));
    this.cellButtons = [];
    for (let i = 0; i < n * n; i++) {
      const r = Math.floor(i / n) + 1;
      const c = (i % n) + 1;
      const btn = el('button', {
        class: 'cell-btn', role: 'gridcell',
        'aria-rowindex': String(r), 'aria-colindex': String(c),
        dataset: { cell: String(i) },
        onclick: () => this.tapCell(i),
        onfocus: () => { this.selectedCell = i; this.renderer.setSelection(i); },
      });
      this.cellOverlay.append(btn);
      this.cellButtons.push(btn);
    }
    this._layoutCellOverlay();
    this._updateCellLabels();
  }

  _layoutCellOverlay() {
    if (!this.cellButtons || !this.session.state) return;
    for (let i = 0; i < this.cellButtons.length; i++) {
      const p = this.renderer.projectCell(i);
      const btn = this.cellButtons[i];
      const size = Math.max(44, p.halfSize * 1.7);
      btn.style.left = `${p.x}px`;
      btn.style.top = `${p.y}px`;
      btn.style.width = `${size}px`;
      btn.style.height = `${size}px`;
    }
  }

  _updateCellLabels() {
    const state = this.session.state;
    if (!state || !this.cellButtons) return;
    const n = state.config.boardSize;
    const humanTurn = state.status === 'active' && state.currentPlayer === this.session.match?.humanPlayer;
    const legal = new Set(humanTurn ? legalCells(state, state.currentPlayer) : []);
    const names = { 0: 'empty', 1: 'X mark', 2: 'O mark' };
    for (let i = 0; i < this.cellButtons.length; i++) {
      const btn = this.cellButtons[i];
      const r = Math.floor(i / n) + 1;
      const c = (i % n) + 1;
      const v = state.board[i];
      const disabledCell = state.config.disabledCells.includes(i);
      btn.setAttribute('aria-label', `Row ${r}, column ${c}: ${disabledCell ? 'sealed' : names[v]}${legal.has(i) ? ', available' : ''}`);
      btn.disabled = !legal.has(i);
      btn.classList.toggle('occupied', v !== 0 || disabledCell);
    }
  }

  onResize() {
    this.renderer.resize();
    this._layoutCellOverlay();
  }

  // ================= input =================

  tapCell(cell) {
    this.audio.init();
    this.audio.resume();
    const s = this.session;
    if (s.phase === PHASE.TUTORIAL) {
      const res = s.lessonPlace(cell);
      if (!res.ok && res.reason === 'wrong-cell') {
        this.toast('Not there — follow the lesson goal.', 'warn');
        this.audio.invalid();
      }
      return;
    }
    if (s.phase !== PHASE.ACTIVE || !s.state || s.state.status !== 'active') return;
    if (s.state.currentPlayer !== s.match.humanPlayer) {
      this.toast('Wait for your turn.', 'warn');
      return;
    }
    if (this.settings.accessibility.confirmMoves && this.pendingConfirmCell !== cell) {
      const legal = legalCells(s.state, s.state.currentPlayer);
      if (!legal.includes(cell)) return this._explainIllegal(cell);
      this.pendingConfirmCell = cell;
      this.renderer.setSelection(cell);
      this.announce(`Selected row ${Math.floor(cell / s.state.config.boardSize) + 1}, column ${(cell % s.state.config.boardSize) + 1}. Press again to place.`);
      return;
    }
    this.pendingConfirmCell = null;
    const res = s.placeCell(cell);
    if (!res.ok) this._explainIllegal(cell, res.reason);
  }

  _explainIllegal(cell, reason) {
    const s = this.session.state;
    const n = s.config.boardSize;
    const at = `row ${Math.floor(cell / n) + 1}, column ${(cell % n) + 1}`;
    let msg;
    if (reason === 'cell-occupied' || s.board[cell] !== 0) msg = `That cell at ${at} already holds a mark.`;
    else if (s.config.disabledCells.includes(cell)) msg = `The cell at ${at} is sealed in this ruleset.`;
    else if (reason === 'game-over') msg = 'The round is over.';
    else msg = reason || 'That move is not legal.';
    this.toast(msg, 'warn');
    this.announceAssertive(msg);
    this.audio.invalid();
    this.audio.haptic(40);
  }

  _wireInput() {
    this.renderer.onCellTap = (cell) => this.tapCell(cell);
    this.renderer.onCellHover = (cell) => {
      const s = this.session;
      if (cell == null || !s.state || s.phase !== PHASE.ACTIVE || s.state.currentPlayer !== s.match?.humanPlayer) {
        this.renderer.setHover(null);
        return;
      }
      const legal = legalCells(s.state, s.state.currentPlayer);
      this.renderer.setHover(cell, legal.includes(cell));
    };

    window.addEventListener('keydown', (e) => this._onKey(e));

    // Gamepad: standard mapping, polled while a match is active.
    window.addEventListener('gamepadconnected', (e) => {
      this._gamepad.index = e.gamepad.index;
      this.toast('Gamepad connected.');
      this._pollGamepad();
    });
    window.addEventListener('gamepaddisconnected', () => {
      this._gamepad.index = null;
      if (this._gamepad.raf) cancelAnimationFrame(this._gamepad.raf);
    });
  }

  effectiveBindings() {
    const merged = {};
    for (const [action, keys] of Object.entries(DEFAULT_BINDINGS)) {
      merged[action] = this.settings.bindings?.[action] || keys;
    }
    return merged;
  }

  _actionForKey(key) {
    for (const [action, keys] of Object.entries(this.effectiveBindings())) {
      if (keys.includes(key)) return action;
    }
    return null;
  }

  _onKey(e) {
    // Don't steal keys from form fields.
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
      if (e.key !== 'Escape') return;
    }
    const action = this._actionForKey(e.key);
    if (!action) return;

    if (this.modal) {
      if (action === 'cancel') {
        e.preventDefault();
        if (this.modal.dataset.locked === 'true') return;
        this.closeModal();
        if (this.session.phase === PHASE.PAUSED) this.session.resume();
      }
      return;
    }

    const playing = !this.hud.hidden;
    if (!playing) {
      if (action === 'cancel' && this.screen !== 'title') {
        e.preventDefault();
        this.goBack();
      }
      return;
    }

    const nav = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    if (nav[action]) {
      e.preventDefault();
      this._moveSelection(nav[action][0], nav[action][1]);
      return;
    }
    switch (action) {
      case 'confirm':
        e.preventDefault();
        this.tapCell(this.selectedCell);
        break;
      case 'cancel':
      case 'pause':
        e.preventDefault();
        if (this.session.phase === PHASE.ACTIVE) this.pauseGame();
        break;
      case 'undo':
        e.preventDefault();
        this.doUndo();
        break;
      case 'hint':
        e.preventDefault();
        this.doHint();
        break;
      case 'cameraReset':
        e.preventDefault();
        this.cycleCamera();
        break;
    }
  }

  _moveSelection(dx, dy) {
    const s = this.session.state;
    if (!s) return;
    const n = s.config.boardSize;
    let r = Math.floor(this.selectedCell / n);
    let c = this.selectedCell % n;
    r = (r + dy + n) % n;
    c = (c + dx + n) % n;
    this.selectedCell = r * n + c;
    this.renderer.setSelection(this.selectedCell);
    const btn = this.cellButtons?.[this.selectedCell];
    if (btn) btn.focus({ preventScroll: true });
    if (this.audio) this.audio.focus();
  }

  _pollGamepad() {
    const step = () => {
      if (this._gamepad.index == null) return;
      this._gamepad.raf = requestAnimationFrame(step);
      const gp = navigator.getGamepads?.()[this._gamepad.index];
      if (!gp) return;
      const pressed = (i) => gp.buttons[i]?.pressed;
      const prev = this._gamepad.prev;
      const justPressed = (i) => pressed(i) && !prev[i];
      // Axes -> directional nav with edge detection.
      const ax = gp.axes[0] || 0;
      const ay = gp.axes[1] || 0;
      const dir = { left: ax < -0.5 || pressed(14), right: ax > 0.5 || pressed(15), up: ay < -0.5 || pressed(12), down: ay > 0.5 || pressed(13) };
      for (const [k, v] of Object.entries(dir)) {
        if (v && !prev[k]) {
          const d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[k];
          if (!this.hud.hidden && !this.modal) this._moveSelection(d[0], d[1]);
        }
        prev[k] = v;
      }
      if (justPressed(0) && !this.hud.hidden && !this.modal) this.tapCell(this.selectedCell); // south: place
      if (justPressed(1)) { // east: cancel/back
        if (this.modal && this.modal.dataset.locked !== 'true') this.closeModal();
      }
      if (justPressed(9)) { // menu: pause
        if (this.session.phase === PHASE.ACTIVE && !this.modal) this.pauseGame();
      }
      for (let i = 0; i < gp.buttons.length; i++) prev[i] = pressed(i);
    };
    step();
  }

  // ================= session event wiring =================

  _wireSession() {
    const s = this.session;
    s.on('state', (state) => {
      if (this.hud.hidden) return;
      this.renderer.syncState(state);
      this._updateCellLabels();
      this._updateHud();
    });
    s.on('invalid', ({ reason }) => {
      if (reason === 'duplicate-command') return;
      // Human-originated invalids are already explained at the tap site.
    });
    s.on('move', ({ cmd }) => {
      if (cmd.player !== s.match?.humanPlayer) this.announce(`Rival placed at row ${Math.floor(cmd.cell / s.state.config.boardSize) + 1}, column ${(cmd.cell % s.state.config.boardSize) + 1}.`);
      this._layoutCellOverlay();
    });
    s.on('round-start', () => {
      this.pendingConfirmCell = null;
      this._buildCellOverlay();
      this._updateHudChrome();
      this.announce(`Round ${s.match.roundIndex} begins.`);
    });
    s.on('round-end', (r) => {
      const msg = r.draw ? 'Round drawn.' : r.humanWon ? 'You take the round!' : 'Rival takes the round.';
      this.announce(msg);
      if (this.audio) this.audio.setMusicIntensity(0.4);
    });
    s.on('match-end', (result) => {
      this.platform.track('round_end', { mode: result.mode === 'journey' ? 1 : 0, outcome: result.outcome === 'win' ? 1 : 0 });
      this.platform.endActivity();
      this.session.discardLocalSnapshot();
      setTimeout(() => this.openResults(result), this.settings.accessibility.reducedMotion ? 100 : 700);
    });
    s.on('clock', ({ player, remainingMs }) => {
      this._updateClock(player, remainingMs);
    });
    s.on('lesson-step', (info) => {
      this.renderer.setLessonHighlights(info.highlightCells);
      this._updateHudChrome();
      this.announce(info.step.text);
      this._updateCellLabels();
    });
    s.on('lesson-advanced', () => this.platform.track('tutorial_step', { step: 1 }));
    s.on('lesson-failed-step', ({ text }) => {
      this.toast(text, 'warn');
      this.announceAssertive(text);
    });
    s.on('lesson-complete', ({ lesson, achievementsUnlocked }) => {
      this.openLessonResults(lesson, achievementsUnlocked);
    });
    s.on('undo', () => {
      this.announce('Undone. Your turn again.');
      this.renderer.skipAnimations();
    });
    s.on('phase', ({ phase }) => {
      if (phase === PHASE.COUNTDOWN) this.renderer.skipAnimations();
    });
  }

  // ================= HUD =================

  _updateHudChrome() {
    const m = this.session.match;
    if (!m) return;
    this.railLeft.innerHTML = '';
    const lessonInfo = this.session.lesson ? this.session.lessonStepInfo() : null;
    this.railLeft.append(
      el('h3', { class: 'rail-title' }, m.mode === 'learn' ? 'Lesson' : 'Match'),
      el('div', { class: 'rail-block' }, el('strong', {}, m.contentName)),
      el('div', { class: 'rail-block' },
        el('span', {}, m.mode === 'learn'
          ? `Step ${lessonInfo.stepIndex + 1} of ${lessonInfo.totalSteps}`
          : m.seriesLength > 1
            ? `Round ${m.roundIndex} of ${m.seriesLength} · You ${m.seriesScore[m.humanPlayer]} – ${m.seriesScore[m.humanPlayer === 1 ? 2 : 1]} Rival`
            : `Round ${m.roundIndex}`)),
      el('div', { class: 'rail-block' }, el('small', {}, this._rulesSummary(this.session.state.config))),
      el('div', { class: 'rail-block' }, el('small', {}, `Seed ${this.session.state.seed}`)),
    );
    this.objectiveEl.textContent = m.mode === 'learn'
      ? lessonInfo.step.text
      : m.config.misere
        ? 'Objective: force the rival to complete a line.'
        : `Objective: complete a line of ${m.config.winLength}.`;
    this._updateHud();
  }

  _updateHud() {
    const s = this.session;
    const state = s.state;
    if (!state || !s.match) return;
    const human = state.currentPlayer === s.match.humanPlayer;
    if (s.phase === PHASE.TUTORIAL) {
      this.turnBanner.textContent = human ? 'Your move' : 'Watch…';
    } else {
      this.turnBanner.textContent = state.status === 'terminal'
        ? 'Round over'
        : human ? 'Your move' : 'Rival thinking…';
    }
    this.turnBanner.classList.toggle('yours', human && state.status === 'active');
    this.btnUndo.disabled = !s.canUndo();
    this.btnHint.disabled = !(s.phase === PHASE.ACTIVE && ['practice', 'learn', 'journey'].includes(s.match.mode) && human);
    // Adaptive music tension rises near terminal boards.
    if (this.audio && state.status === 'active') {
      const filled = state.board.filter((v) => v !== 0).length / state.board.length;
      this.audio.setMusicIntensity(0.15 + filled * 0.5);
    }
    this._updateClockText();
  }

  _updateClock(player, remainingMs) {
    this._lastClock = { player, remainingMs };
    this._updateClockText();
  }

  _updateClockText() {
    const s = this.session;
    const limit = s.state?.config?.timeLimitMs;
    if (!limit) {
      this.clockEl.textContent = '';
      return;
    }
    const human = s.match.humanPlayer;
    const parts = [];
    for (const p of [human, human === 1 ? 2 : 1]) {
      let used = s.state.playerTimeMs[p];
      if (this._lastClock && this._lastClock.player === p && s.state.currentPlayer === p) {
        used = limit - this._lastClock.remainingMs;
      }
      const remain = Math.max(0, limit - used);
      parts.push(`${p === human ? 'You' : 'Rival'} ${fmtTime(remain)}`);
    }
    this.clockEl.textContent = parts.join(' · ');
  }

  // ================= actions =================

  pauseGame() {
    this.session.pause('user');
    this.openPauseModal();
  }

  doUndo() {
    const res = this.session.undo();
    if (!res.ok) this.toast('Undo is not available here.', 'warn');
  }

  doHint() {
    const s = this.session;
    if (!s.state || s.phase !== PHASE.ACTIVE) return;
    if (!['practice', 'learn', 'journey'].includes(s.match.mode)) return;
    const cell = this.hintAI.chooseCell(s.state, s.match.humanPlayer);
    if (cell < 0) return;
    s.match.assists.hintUsed = true;
    this.renderer.setLessonHighlights([cell]);
    setTimeout(() => this.renderer.setLessonHighlights(this.session.lesson ? this.session.lessonStepInfo().highlightCells : []), 1800);
    const n = s.state.config.boardSize;
    this.toast(`Hint: consider row ${Math.floor(cell / n) + 1}, column ${(cell % n) + 1}.`);
    this.announce(`Hint suggests row ${Math.floor(cell / n) + 1}, column ${(cell % n) + 1}.`);
    this.audio.focus();
  }

  cycleCamera() {
    const order = ['standard', 'top', 'low'];
    const cur = this.settings.camera.angle;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.updateSetting('camera.angle', next);
    this.toast(`Camera: ${next}`);
  }

  // ================= modals =================

  openModal(node, { locked = false } = {}) {
    this.previousFocus = document.activeElement;
    this.modalRoot.innerHTML = '';
    this.modal = node;
    node.dataset.locked = locked ? 'true' : 'false';
    this.modalRoot.append(node);
    this.modalRoot.hidden = false;
    const focusable = node.querySelector('button, [href], input, select, [tabindex]');
    if (focusable) focusable.focus({ preventScroll: true });
    // Simple focus trap.
    this.modalRoot.onkeydown = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
  }

  closeModal() {
    this.modalRoot.hidden = true;
    this.modalRoot.innerHTML = '';
    this.modal = null;
    if (this.previousFocus && this.previousFocus.focus) this.previousFocus.focus({ preventScroll: true });
  }

  openPauseModal(note) {
    const s = this.session;
    const body = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Paused' },
      el('h3', {}, 'Paused'),
      note ? el('p', {}, note) : null,
      el('div', { class: 'sheet-actions col' },
        el('button', { class: 'primary-btn', onclick: () => { this.closeModal(); s.resume(); } }, 'Resume'),
        el('button', { class: 'ghost-btn', onclick: () => { this.closeModal(); this._returnToPause = true; this.hud.hidden = true; this.showScreen('settings'); } }, 'Settings'),
        el('button', { class: 'ghost-btn', onclick: () => { this.closeModal(); this._returnToPause = true; this.hud.hidden = true; this.showScreen('help'); } }, 'How to play'),
        el('button', { class: 'danger-btn', onclick: () => { this.closeModal(); this.leaveMatch(); } }, 'Leave match')),
    );
    this.openModal(body);
    this.announce('Game paused.');
  }

  openResults(result) {
    const s = this.session;
    const won = result.outcome === 'win';
    const headline = won ? 'Victory' : result.outcome === 'draw' ? 'A Honest Draw' : 'Defeat';
    const rows = result.breakdown.components.map((c) =>
      el('tr', {}, el('td', {}, c.label), el('td', { class: 'num' }, `${c.value >= 0 ? '+' : ''}${c.value}`)));

    const actions = [];
    actions.push(el('button', {
      class: 'primary-btn',
      onclick: () => { this.closeModal(); this.platform.track('retry', {}); this._launch(this.lastMatchOptions); },
    }, result.mode === 'daily' ? 'Play again (unranked)' : 'Retry'));
    if (result.mode === 'journey' && won) {
      const idx = JOURNEY_STAGES.findIndex((st) => st.id === result.contentId);
      const next = JOURNEY_STAGES[idx + 1];
      if (next) {
        actions.push(el('button', { class: 'ghost-btn', onclick: () => { this.closeModal(); this.openStageSheet(next); } }, `Next: ${next.name}`));
      }
    }
    actions.push(el('button', { class: 'ghost-btn', onclick: () => { this.closeModal(); this.leaveMatch(); } }, 'Back to modes'));

    const achBadges = (result.achievementsUnlocked || []).map((key) => {
      const a = ACHIEVEMENTS.find((x) => x.key === key);
      return a ? el('div', { class: 'ach-badge' }, `🏅 ${a.name}`) : null;
    });

    const sheet = el('div', { class: 'sheet results', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Match results' },
      el('h3', { class: won ? 'won' : result.outcome === 'draw' ? 'drew' : 'lost' }, headline),
      el('p', { class: 'results-sub' },
        `${result.contentName} · ${result.rounds.length} round${result.rounds.length > 1 ? 's' : ''}` +
        (result.ranked ? ' · Ranked' : result.assistsUsed ? ' · Unranked (assists used)' : '')),
      result.stars ? el('div', { class: 'stars big', 'aria-label': `${result.stars} of 3 stars` }, '★'.repeat(result.stars) + '☆'.repeat(3 - result.stars)) : null,
      el('table', { class: 'breakdown' },
        el('tbody', {}, rows),
        el('tfoot', {}, el('tr', {}, el('td', {}, 'Total'), el('td', { class: 'num' }, String(result.breakdown.total))))),
      result.rounds.length > 1
        ? el('p', { class: 'results-sub' }, `Series: You ${result.seriesScore[s.match.humanPlayer]} – ${result.seriesScore[s.match.humanPlayer === 1 ? 2 : 1]} Rival`)
        : null,
      achBadges.length ? el('div', { class: 'ach-row' }, achBadges) : null,
      el('p', { class: 'results-sub' }, this._nextRecommendation(result)),
      el('div', { class: 'sheet-actions' }, actions),
    );
    this.openModal(sheet);
    this.announce(`${headline}. Total score ${result.breakdown.total}.`);
    if (this.audio) this.audio.setMusicIntensity(0.1);
  }

  _nextRecommendation(result) {
    if (result.mode === 'journey') {
      if (result.outcome !== 'win') return 'Tip: blocking matters more than building. Try the lesson “The Block”, then retry.';
      return 'Progress saved. The next stage is unlocked.';
    }
    if (result.mode === 'daily') return 'Come back tomorrow for a fresh seed and ruleset.';
    if (result.mode === 'learn') return 'Lessons can be replayed any time from Learn.';
    if (result.mode === 'challenge') return result.outcome === 'win' ? 'Challenge cleared. Another one waits.' : 'Watch the rival’s threats one move earlier.';
    return result.outcome === 'win' ? 'Try a harder difficulty or a wider board.' : 'Practice is unrated — use undo and hints freely.';
  }

  openLessonResults(lesson, achievementsUnlocked) {
    const idx = LESSONS.findIndex((l) => l.id === lesson.id);
    const next = LESSONS[idx + 1];
    const actions = [
      next
        ? el('button', { class: 'primary-btn', onclick: () => { this.closeModal(); this.startLesson(next); } }, `Next: ${next.name}`)
        : el('button', { class: 'primary-btn', onclick: () => { this.closeModal(); this.leaveMatch(); this.showScreen('modes'); } }, 'Start playing'),
      el('button', { class: 'ghost-btn', onclick: () => { this.closeModal(); this.leaveMatch(); this.showScreen('lessons'); } }, 'All lessons'),
    ];
    const sheet = el('div', { class: 'sheet results', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lesson complete' },
      el('h3', { class: 'won' }, 'Lesson Complete'),
      el('p', { class: 'results-sub' }, lesson.name),
      (achievementsUnlocked || []).length
        ? el('div', { class: 'ach-row' }, achievementsUnlocked.map((k) => el('div', { class: 'ach-badge' }, `🏅 ${ACHIEVEMENTS.find((a) => a.key === k)?.name || k}`)))
        : null,
      el('div', { class: 'sheet-actions' }, actions),
    );
    this.openModal(sheet);
    this.announce(`Lesson complete: ${lesson.name}.`);
  }

  // ================= settings =================

  updateSetting(path, value) {
    const keys = path.split('.');
    let obj = this.settings;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
    obj[keys[keys.length - 1]] = value;
    this.store.saveSettings(this.settings);
    this.applySettings(this.settings);
    this.platform.track('settings_change', { key: keys[keys.length - 1] });
    this.platform.setTelemetryConsent(this.settings.telemetryConsent);
  }

  applySettings(s) {
    const a = s.accessibility;
    this.root.classList.toggle('reduced-motion', a.reducedMotion);
    this.root.classList.toggle('high-contrast', a.highContrast);
    this.root.classList.toggle('larger-text', a.largerText);
    this.root.classList.toggle('left-handed', a.leftHanded);
    if (this.audio) this.audio.applySettings(s);
    if (this.renderer) {
      this.renderer.setReducedMotion(a.reducedMotion);
      this.renderer.settings = s;
      const tier = s.graphics.tier === 'auto' ? this._autoTier() : s.graphics.tier;
      this.renderer.setQuality(tier, s.graphics.renderScale);
      this.renderer.setCameraAngle(s.camera.angle);
      if (!this.hud.hidden && this.session.state) {
        // Refresh palette-dependent materials.
        this.renderer._rebuildScenePreserving?.();
        this.renderer.syncState(this.session.state, { instant: true });
      } else {
        this.renderer.setTheme(themeById(s.theme));
      }
    }
    // Reflect values into controls.
    this.setMuted.checked = s.audio.muted;
    this.setTier.value = s.graphics.tier;
    this.setTheme.value = s.theme;
    this.setCamera.value = s.camera.angle;
    this.setPalette.value = a.palette;
    this.setTelemetry.checked = s.telemetryConsent;
    this.togReduced.input.checked = a.reducedMotion;
    this.togContrast.input.checked = a.highContrast;
    this.togLargerText.input.checked = a.largerText;
    this.togLefty.input.checked = a.leftHanded;
    this.togConfirm.input.checked = a.confirmMoves;
    this.togTiming.input.checked = a.timingAssist;
    this.togHaptics.input.checked = a.haptics;
    this._renderBindingsEditor();
  }

  _autoTier() {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const mobile = /Mobi|Android/i.test(navigator.userAgent);
    if (mobile && (cores <= 4 || mem <= 3)) return 'low';
    if (cores >= 8 && mem >= 8) return 'high';
    return 'medium';
  }

  _renderBindingsEditor() {
    const bindings = this.effectiveBindings();
    this.bindingsEditor.innerHTML = '';
    for (const [action, keys] of Object.entries(bindings)) {
      const btn = el('button', {
        class: 'ghost-btn small',
        onclick: () => this._captureBinding(action),
      }, keys.map((k) => (k === ' ' ? 'Space' : k)).join(' / '));
      this.bindingsEditor.append(el('div', { class: 'binding-row' }, el('span', {}, BINDING_LABELS[action] || action), btn));
    }
  }

  _captureBinding(action) {
    this.toast(`Press a key for “${BINDING_LABELS[action]}”… (Esc cancels)`);
    const handler = (e) => {
      e.preventDefault();
      window.removeEventListener('keydown', handler, true);
      if (e.key === 'Escape') return;
      const bindings = { ...(this.settings.bindings || {}) };
      bindings[action] = [e.key];
      this.updateSetting('bindings', bindings);
      this._renderBindingsEditor();
    };
    window.addEventListener('keydown', handler, true);
  }

  resetProgress() {
    if (!confirm('Reset all local progress, settings stay. This cannot be undone.')) return;
    this.store.saveProgression({ ...this.store.loadProgression(), journey: {}, lessons: {}, challenges: {}, dailies: {}, achievements: {}, stats: { roundsPlayed: 0, roundsWon: 0, roundsDrawn: 0, byMode: {}, totalScore: 0 } });
    this.toast('Progress reset.');
    this._refreshTitleCards();
  }

  // ================= feedback =================

  toast(text, kind = 'info') {
    const t = el('div', { class: `toast ${kind}` }, text);
    this.toastRoot.append(t);
    setTimeout(() => t.classList.add('show'), 16);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 2600);
  }

  announce(text) {
    this.livePolite.textContent = '';
    requestAnimationFrame(() => { this.livePolite.textContent = text; });
  }

  announceAssertive(text) {
    this.liveAssertive.textContent = '';
    requestAnimationFrame(() => { this.liveAssertive.textContent = text; });
  }
}
