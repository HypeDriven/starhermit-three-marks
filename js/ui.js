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
import { PRESETS, CATEGORIES, presetTier, choosePreset } from './gfx.js';
import { gfxStrings, gfxWords } from './gfx-i18n.js';
import { shText } from './sh-i18n.js';
import {
  t, tx, txf, lv, locale, onLanguage, stageName, stageBlurb, chapterName, lessonText, challengeText,
  themeName, rulesetName, achievementText, aiName, playerName, scoreLabel, bindAttr,
} from './i18n.js';

const sh = (key, vars) => shText(key, vars || {}, locale());

// KeyboardEvent.code values — mirrors the control.* lines in starhermit.txt.
export const DEFAULT_BINDINGS = {
  confirm: ['Enter', 'Space'],
  cancel: ['Escape'],
  pause: ['KeyP'],
  undo: ['KeyU'],
  hint: ['KeyH'],
  cameraReset: ['KeyC'],
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
};

/** Older builds stored KeyboardEvent.key values ('u', ' '); map to codes. */
export function keyToCode(k) {
  k = String(k);
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (k === ' ') return 'Space';
  return k;
}
/** Short on-screen label for a KeyboardEvent.code. */
export function codeLabel(c) {
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  return c;
}

const BINDING_KEYS = {
  confirm: 'bindConfirm', cancel: 'bindCancel', pause: 'bindPause',
  undo: 'bindUndo', hint: 'bindHint', cameraReset: 'bindCameraReset',
  up: 'bindUp', down: 'bindDown', left: 'bindLeft', right: 'bindRight',
};
const bindingLabel = (action) => (BINDING_KEYS[action] ? t(BINDING_KEYS[action]) : action);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v && typeof v === 'object' && typeof v.live === 'function') bindAttr(node, k, v.live);
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
  learn: { name: 'modeLearn', desc: 'modeLearnDesc', duration: 'durLearn', players: 'playersSolo', ranked: false },
  journey: { name: 'modeJourney', desc: 'modeJourneyDesc', duration: 'durJourney', players: 'playersSoloAi', ranked: false },
  daily: { name: 'modeDaily', desc: 'modeDailyDesc', duration: 'durDaily', players: 'playersSoloAi', ranked: true },
  practice: { name: 'modePractice', desc: 'modePracticeDesc', duration: 'durPractice', players: 'playersSoloAi', ranked: false },
  challenge: { name: 'modeChallenge', desc: 'modeChallengeDesc', duration: 'durChallenge', players: 'playersSoloAi', ranked: false },
  hosted: { name: 'modeHosted', desc: 'modeHostedDesc', duration: 'durHosted', players: 'playersTwo', ranked: false },
};
const CAMERA_KEYS = { standard: 'camStandard', top: 'camTop', low: 'camLow' };

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
    this.platform.onProfileLoaded = () => this._refreshIdentity();
    this._refreshIdentity();
    onLanguage(() => this.relabel());
  }

  /**
   * Language changed: live text nodes are already rewritten (i18n.js); this
   * re-renders everything built from data in place — lists on the current
   * screen, HUD, cell labels, bindings, graphics labels and any open sheet —
   * without restarting the match.
   */
  relabel() {
    this._refreshTitleCards();
    this._refreshIdentity();
    this.updateSyncStatus(this._syncState || this.platform.cloudSyncState);
    this._renderBindingsEditor();
    this._refreshHelpBindings();
    this._relabelGraphics();
    if (this.screen === 'journey') this._refreshJourney();
    if (this.screen === 'challenges') this._refreshChallenges();
    if (this.screen === 'lessons') this._refreshLessons();
    if (this.screen === 'achievements') this._refreshAchievements();
    if (this.screen === 'profile') this._refreshProfile();
    // The HUD is hidden while Settings is open from the pause menu; relabel it anyway.
    if (this.session.match && this.session.state && this.cellButtons) {
      this._updateHudChrome();
      this._updateCellLabels();
    }
    if (this.modal && this._modalRender) this._modalRender();
  }

  // ================= DOM skeleton =================

  _build() {
    this.root.innerHTML = '';
    this.root.id = 'app';

    this.canvasWrap = el('div', { id: 'canvas-wrap', role: 'application', 'aria-label': lv('boardLabel') });
    this.cellOverlay = el('div', { id: 'cell-overlay', role: 'grid', 'aria-label': lv('boardCells') });
    this.canvasWrap.append(this.cellOverlay);

    // HUD
    this.hud = el('div', { id: 'hud', hidden: true });
    this.objectiveEl = el('div', { id: 'objective', role: 'status' });
    this.turnBanner = el('div', { id: 'turn-banner' });
    this.clockEl = el('div', { id: 'clock-display' });
    this.btnPause = el('button', { id: 'btn-pause', class: 'icon-btn', 'aria-label': lv('pause'), onclick: () => this.pauseGame() }, 'II');
    this.hudNameEl = el('div', { id: 'player-name', 'aria-label': lv('player') });
    this.syncEl = el('div', { id: 'sync-status', role: 'status' });
    const hudTop = el('div', { id: 'hud-top' }, this.objectiveEl, this.turnBanner, this.clockEl, this.btnPause, this.hudNameEl, this.syncEl);

    this.railLeft = el('aside', { id: 'rail-left', 'aria-label': lv('matchProgress') });
    this.railRight = el('aside', { id: 'rail-right', 'aria-label': lv('actions') });
    this.btnUndo = el('button', { class: 'action-btn', id: 'btn-undo', onclick: () => this.doUndo() }, tx('undo'));
    this.btnHint = el('button', { class: 'action-btn', id: 'btn-hint', onclick: () => this.doHint() }, tx('hint'));
    this.btnCamera = el('button', { class: 'action-btn', id: 'btn-camera', onclick: () => this.cycleCamera() }, tx('camera'));
    this.railRight.append(
      el('h3', { class: 'rail-title' }, tx('actions')),
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
    this.titleNameEl = el('p', { id: 'title-name', role: 'status' });
    this.screenTitle = el('section', { class: 'screen', id: 'screen-title', 'aria-labelledby': 'title-h' },
      el('div', { class: 'title-hero' },
        el('h1', { id: 'title-h' }, 'Three Marks'),
        el('p', { class: 'tagline' }, tx('tagline')),
        this.titleNameEl,
        el('button', {
          id: 'btn-play', class: 'primary-btn big', onclick: () => this.quickPlay(),
        }, tx('play')),
        this.session.hasLocalSnapshot()
          ? el('button', { class: 'ghost-btn resume-btn', onclick: () => this.resumeSnapshot() }, tx('resumeInterrupted'))
          : null,
        el('div', { class: 'title-account' },
          this.signInBtn = el('button', { id: 'btn-signin', class: 'ghost-btn', hidden: !this.platform.canSignIn(), onclick: () => this.platform.signIn() }, txf(() => sh('signIn'))),
          ' ',
          this.inviteBtn = el('button', { id: 'btn-invite', class: 'ghost-btn', hidden: !this.platform.inviteLink(), onclick: () => this.copyInvite() }, txf(() => sh('invite')))),
      ),
      el('div', { class: 'title-cards' },
        this.titleDailyCard,
        this.titleJourneyCard,
        el('button', { class: 'card', id: 'btn-all-modes', onclick: () => this.showScreen('modes') },
          el('strong', {}, tx('allModes')), el('span', {}, tx('allModesSub'))),
        el('button', { class: 'card', id: 'btn-profile', onclick: () => this.showScreen('profile') },
          el('strong', {}, tx('profile')), el('span', {}, tx('profileSub'))),
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
      el('strong', {}, t('dailyChallenge')),
      el('span', {}, done ? t('dailyDone', { name: rulesetName(daily.rulesetName), score: done.score }) : t('dailyNotPlayed', { name: rulesetName(daily.rulesetName) })),
    );
    const doneStages = Object.values(prog.journey).filter((j) => j.stars > 0).length;
    const stars = Object.values(prog.journey).reduce((s, j) => s + (j.stars || 0), 0);
    this.titleJourneyCard.innerHTML = '';
    this.titleJourneyCard.append(
      el('strong', {}, t('journey')),
      el('span', {}, t('journeyCard', { done: doneStages, stars })),
    );
    // Keep the resume affordance in sync with the stored snapshot.
    const existing = this.screenTitle.querySelector('.resume-btn');
    if (this.session.hasLocalSnapshot() && !existing) {
      const btn = el('button', { class: 'ghost-btn resume-btn', onclick: () => this.resumeSnapshot() }, tx('resumeInterrupted'));
      this.screenTitle.querySelector('.title-hero').append(btn);
    } else if (!this.session.hasLocalSnapshot() && existing) {
      existing.remove();
    }
  }

  _buildModeScreen() {
    const cards = Object.entries(MODE_META).map(([mode, meta]) =>
      el('button', {
        class: 'mode-card',
        'data-mode': mode,
        onclick: () => this.openMode(mode),
      },
        el('h3', {}, tx(meta.name)),
        el('p', {}, tx(meta.desc)),
        el('dl', { class: 'mode-facts' },
          el('div', {}, el('dt', {}, tx('duration')), el('dd', {}, tx(meta.duration))),
          el('div', {}, el('dt', {}, tx('players')), el('dd', {}, tx(meta.players))),
          el('div', {}, el('dt', {}, tx('ranked')), el('dd', {}, tx(meta.ranked ? 'yes' : 'no'))),
        ),
      ));
    this.screenModes = el('section', { class: 'screen', id: 'screen-modes', hidden: true, 'aria-labelledby': 'modes-h' },
      this._screenHeader('chooseMode', 'chooseModeSub'),
      el('div', { class: 'mode-grid' }, cards),
    );
    this.screens.append(this.screenModes);
  }

  _buildJourneyScreen() {
    this.journeyList = el('div', { class: 'stage-list' });
    this.screenJourney = el('section', { class: 'screen', id: 'screen-journey', hidden: true, 'aria-labelledby': 'journey-h' },
      this._screenHeader('journey', 'journeySub'),
      this.journeyList,
    );
    this.screens.append(this.screenJourney);
  }

  _refreshJourney() {
    const prog = this.store.loadProgression();
    this.journeyList.innerHTML = '';
    JOURNEY_STAGES.forEach((stage, i) => {
      if (i % 8 === 0) {
        this.journeyList.append(el('h3', { class: 'chapter-title' }, t('chapter', { n: stage.chapter + 1, name: chapterName(stage.chapter, CHAPTERS[stage.chapter].name) })));
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
        el('span', { class: 'stage-name' }, stageName(stage), el('small', {}, stageBlurb(stage))),
        el('span', { class: 'stars', 'aria-label': t('starsOf3', { n: stars }) }, '★'.repeat(stars) + '☆'.repeat(3 - stars)),
      ));
    });
  }

  _buildChallengeScreen() {
    const list = el('div', { class: 'card-list' });
    this.challengeList = list;
    this.screenChallenges = el('section', { class: 'screen', id: 'screen-challenges', hidden: true, 'aria-labelledby': 'chal-h' },
      this._screenHeader('challenges', 'challengesSub'),
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
        el('strong', {}, challengeText(c, 0, c.name)),
        el('span', {}, challengeText(c, 1, c.blurb)),
        el('em', {}, rec ? t('completedBest', { score: rec.bestScore }) : challengeText(c, 2, c.goalText)),
      ));
    }
  }

  _buildLessonsScreen() {
    this.lessonList = el('div', { class: 'card-list' });
    this.screenLessons = el('section', { class: 'screen', id: 'screen-lessons', hidden: true, 'aria-labelledby': 'learn-h' },
      this._screenHeader('learn', 'learnSub'),
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
        el('strong', {}, `${done ? '✓ ' : ''}${lessonText(l, 'name', l.name)}`),
        el('span', {}, lessonText(l, 'intro', l.intro)),
      ));
    }
  }

  _buildPracticeScreen() {
    this.practiceDifficulty = el('select', { id: 'pr-diff' },
      el('option', { value: 'casual' }, tx('diffCasualOpt')),
      el('option', { value: 'skilled', selected: true }, tx('diffSkilledOpt')),
      el('option', { value: 'expert' }, tx('diffExpertOpt')));
    this.practiceBoard = el('select', { id: 'pr-board' },
      el('option', { value: '3', selected: true }, tx('board3')),
      el('option', { value: '4' }, tx('board4')),
      el('option', { value: '5' }, tx('board5')));
    this.practiceSeries = el('select', { id: 'pr-series' },
      el('option', { value: '1', selected: true }, tx('seriesSingle')),
      el('option', { value: '3' }, tx('seriesBo3')),
      el('option', { value: '5' }, tx('seriesBo5')));
    this.practiceSide = el('select', { id: 'pr-side' },
      el('option', { value: '1', selected: true }, tx('sideX')),
      el('option', { value: '2' }, tx('sideO')));
    this.screenPractice = el('section', { class: 'screen', id: 'screen-practice', hidden: true, 'aria-labelledby': 'prac-h' },
      this._screenHeader('practiceSetup', 'practiceSetupSub'),
      el('form', { class: 'setup-form', onsubmit: (e) => { e.preventDefault(); this.startPractice(); } },
        el('label', {}, tx('difficulty'), this.practiceDifficulty),
        el('label', {}, tx('board'), this.practiceBoard),
        el('label', {}, tx('series'), this.practiceSeries),
        el('label', {}, tx('side'), this.practiceSide),
        el('div', { class: 'mode-facts inline' },
          el('span', {}, tx('factPlayers')), el('span', {}, tx('factRanked')),
          el('span', {}, tx('factAssists'))),
        el('button', { class: 'primary-btn', type: 'submit', id: 'btn-start-practice' }, tx('startPractice')),
      ),
    );
    this.screens.append(this.screenPractice);
  }

  _buildAchievementsScreen() {
    this.achList = el('ul', { class: 'ach-list' });
    this.screenAchievements = el('section', { class: 'screen', id: 'screen-achievements', hidden: true, 'aria-labelledby': 'ach-h' },
      this._screenHeader('achievements', 'achievementsSub'),
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
        el('strong', {}, achievementText(a, 0)),
        el('span', {}, achievementText(a, 1)),
        el('em', {}, got ? t('unlockedOn', { date: new Date(got.unlockedAt).toLocaleDateString(locale()) }) : t('locked')),
      ));
    }
  }

  _buildHelpScreen() {
    this.helpBindings = el('div', { class: 'rule-cards' });
    this.screenHelp = el('section', { class: 'screen', id: 'screen-help', hidden: true, 'aria-labelledby': 'help-h' },
      this._screenHeader('howToPlay', 'howToPlaySub'),
      el('div', { class: 'rule-cards' },
        this._ruleCard('ruleGoal', [['X', 'X', 'X'], ['O', '', 'O'], ['', '', '']]),
        this._ruleCard('ruleTurns', [['X', 'O', ''], ['', 'X', ''], ['O', '', '']]),
        this._ruleCard('ruleDraw', [['X', 'O', 'X'], ['X', 'O', 'O'], ['O', 'X', 'X']]),
        this._ruleCard('ruleVariants', [['X', '■', 'O'], ['', 'X', ''], ['O', '', '']]),
      ),
      el('h3', {}, tx('yourControls')),
      this.helpBindings,
      el('h3', {}, tx('gamepad')),
      el('p', { class: 'help-note' }, tx('gamepadText')),
    );
    this.screens.append(this.screenHelp);
  }

  _ruleCard(key, grid) {
    return el('div', { class: 'rule-card' },
      el('h4', {}, tx(key)),
      el('p', {}, tx(key + 'Text')),
      el('div', { class: 'mini-board', role: 'img', 'aria-label': { live: () => t('exampleBoard', { title: t(key) }) } },
        grid.flat().map((c) => el('span', { class: c === 'X' ? 'm-x' : c === 'O' ? 'm-o' : c === '■' ? 'm-block' : '' }, c || '·'))),
    );
  }

  _refreshHelpBindings() {
    const bindings = this.effectiveBindings();
    this.helpBindings.innerHTML = '';
    for (const [action, keys] of Object.entries(bindings)) {
      this.helpBindings.append(el('div', { class: 'binding-row' },
        el('span', {}, bindingLabel(action)),
        el('kbd', {}, keys.map(codeLabel).join(' / ')),
      ));
    }
  }

  _buildSettingsScreen() {
    const s = this.settings;
    const slider = (key, label) => el('label', { class: 'slider-row' }, tx(label),
      el('input', {
        type: 'range', min: 0, max: 1, step: 0.05, value: s.audio[key],
        oninput: (e) => this.updateSetting(`audio.${key}`, parseFloat(e.target.value)),
        'aria-label': lv(label),
      }));
    this.setMusic = slider('music', 'music');
    this.setEffects = slider('effects', 'effects');
    this.setAmbience = slider('ambience', 'ambience');
    this.setVoice = slider('voice', 'voice');
    this.setMuted = el('input', { type: 'checkbox', onchange: (e) => this.updateSetting('audio.muted', e.target.checked) });

    const gfxRows = this._buildGraphicsControls();

    const toggle = (key, label) => {
      const input = el('input', { type: 'checkbox', onchange: (e) => this.updateSetting(`accessibility.${key}`, e.target.checked) });
      return { input, row: el('label', { class: 'toggle-row', 'data-setting': key }, input, el('span', {}, tx(label))) };
    };
    this.togReduced = toggle('reducedMotion', 'reducedMotion');
    this.togContrast = toggle('highContrast', 'highContrast');
    this.togLargerText = toggle('largerText', 'largerText');
    this.togLefty = toggle('leftHanded', 'leftHanded');
    this.togConfirm = toggle('confirmMoves', 'confirmMoves');
    this.togTiming = toggle('timingAssist', 'timingAssist');
    this.togHaptics = toggle('haptics', 'haptics');

    this.setPalette = el('select', { onchange: (e) => this.updateSetting('accessibility.palette', e.target.value) },
      el('option', { value: 'default' }, tx('palDefault')),
      el('option', { value: 'deuteranopia' }, tx('palDeuteranopia')),
      el('option', { value: 'tritanopia' }, tx('palTritanopia')));
    this.setCamera = el('select', { onchange: (e) => this.updateSetting('camera.angle', e.target.value) },
      el('option', { value: 'standard' }, tx('camStandard')), el('option', { value: 'top' }, tx('camTop')), el('option', { value: 'low' }, tx('camLow')));
    this.setTheme = el('select', { onchange: (e) => this.updateSetting('theme', e.target.value) },
      THEMES.map((th) => el('option', { value: th.id }, txf(() => themeName(th)))));
    this.bindingsEditor = el('div', { class: 'bindings-editor' });

    this.screenSettings = el('section', { class: 'screen', id: 'screen-settings', hidden: true, 'aria-labelledby': 'set-h' },
      this._screenHeader('settings', 'settingsSub'),
      el('div', { class: 'settings-grid' },
        el('fieldset', {}, el('legend', {}, tx('audio')),
          this.setMusic, this.setEffects, this.setAmbience, this.setVoice,
          el('label', { class: 'toggle-row', 'data-setting': 'muted' }, this.setMuted, el('span', {}, tx('muteAll')))),
        el('fieldset', { id: 'gfx-section', class: 'gfx-section' }, el('legend', {}, tx('graphics')),
          gfxRows,
          el('label', { class: 'slider-row' }, tx('theme'), this.setTheme),
          el('label', { class: 'slider-row' }, tx('camera'), this.setCamera)),
        el('fieldset', {}, el('legend', {}, tx('accessibility')),
          this.togReduced.row, this.togContrast.row, this.togLargerText.row, this.togLefty.row,
          this.togConfirm.row, this.togTiming.row, this.togHaptics.row,
          el('label', { class: 'slider-row' }, tx('colorPalette'), this.setPalette)),
        el('fieldset', {}, el('legend', {}, tx('keyBindings')), this.bindingsEditor),
        el('fieldset', {}, el('legend', {}, tx('privacy')),
          el('p', { class: 'help-note' }, tx('privacyNote')),
          el('button', { class: 'ghost-btn', onclick: () => this.resetProgress() }, tx('resetProgress'))),
      ),
    );
    this.screens.append(this.screenSettings);
  }

  // Graphics section: quality preset, render scale, per-effect overrides,
  // adaptive resolution, frame-rate readout and a live cost summary.
  _buildGraphicsControls() {
    // Graphics strings follow the game language (gfx-i18n.js); labels are live text.
    const G = () => gfxStrings(locale());
    const g = (key) => txf(() => G()(key));
    this.gfxPreset = el('select', { id: 'gfx-preset', 'data-gfx': 'preset', onchange: (e) => this.setGraphicsPreset(e.target.value) },
      el('option', { value: 'auto' }, G()('auto', { tier: '…' })),
      PRESETS.map((p) => el('option', { value: p }, g(`presets.${p}`))));
    this.gfxScaleValue = el('output', { id: 'gfx-scale-value', class: 'gfx-value' }, '100%');
    this.gfxScale = el('input', {
      id: 'gfx-scale', 'data-gfx': 'render_scale', type: 'range', min: 50, max: 200, step: 5, value: 100,
      'aria-label': { live: () => G()('renderScale') },
      oninput: (e) => this.updateGraphics({ render_scale: parseInt(e.target.value, 10) / 100 }),
    });
    this.gfxCats = {};
    const catRows = Object.entries(CATEGORIES).map(([cat, tiers]) => {
      const sel = el('select', { id: `gfx-${cat}`, 'data-gfx-cat': cat, onchange: (e) => this.updateGraphics({ [cat]: e.target.value }) },
        el('option', { value: 'preset' }, G()('fromPreset', { tier: '…' })),
        tiers.map((tier) => el('option', { value: tier }, g(`tiers.${tier}`))));
      this.gfxCats[cat] = sel;
      return el('label', { class: 'slider-row' }, g(`cats.${cat}`), sel);
    });
    this.gfxAdaptive = el('input', { id: 'gfx-adaptive', type: 'checkbox', onchange: (e) => this.updateGraphics({ adaptive: e.target.checked }) });
    this.gfxFps = el('input', { id: 'gfx-fps', type: 'checkbox', onchange: (e) => this.updateGraphics({ show_fps: e.target.checked }) });
    this.gfxSummary = el('p', { id: 'gfx-summary', class: 'help-note gfx-summary', role: 'status' });
    this.gfxPostNote = el('p', { id: 'gfx-post-note', class: 'help-note gfx-note', hidden: true }, g('postFailed'));
    // Live summary (fps, adaptive pixels) while the settings screen is open.
    setInterval(() => { if (this.screenSettings && !this.screenSettings.hidden) this._refreshGraphicsInfo(); }, 1000);
    return [
      el('label', { class: 'slider-row' }, g('quality'), this.gfxPreset),
      el('label', { class: 'slider-row' }, el('span', { class: 'gfx-scale-label' }, g('renderScale'), this.gfxScaleValue), this.gfxScale),
      el('div', { class: 'gfx-cats' }, catRows),
      el('label', { class: 'toggle-row' }, this.gfxAdaptive, el('span', {}, g('adaptive'))),
      el('label', { class: 'toggle-row' }, this.gfxFps, el('span', {}, g('showFps'))),
      this.gfxSummary,
      this.gfxPostNote,
    ];
  }

  // Choosing a preset clears every per-category override.
  setGraphicsPreset(preset) {
    this.settings.graphics = choosePreset(this.settings.graphics, preset);
    this.store.saveSettings(this.settings);
    this.platform.pushSettings(this.settings);
    this.applySettings(this.settings);
  }

  updateGraphics(patch) {
    const next = { ...this.settings.graphics, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === 'preset') delete next[k];
    this.settings.graphics = next;
    this.store.saveSettings(this.settings);
    this.platform.pushSettings(this.settings);
    this.applySettings(this.settings);
  }

  _relabelGraphics() { this._refreshGraphicsInfo(); }

  _refreshGraphicsInfo() {
    const gt = gfxStrings(locale());
    const g = this.settings.graphics;
    const info = this.renderer?.graphicsInfo?.(gfxWords(locale()));
    const detected = info?.detected || 'balanced';
    const resolved = info?.resolved;
    this.gfxPreset.options[0].textContent = gt('auto', { tier: gt(`presets.${detected}`) });
    this.gfxPreset.value = PRESETS.includes(g.preset) ? g.preset : 'auto';
    const pct = Math.round((g.render_scale ?? 1) * 100);
    this.gfxScale.value = String(pct);
    this.gfxScaleValue.textContent = `${pct}%`;
    const preset = resolved?.preset || detected;
    for (const [cat, sel] of Object.entries(this.gfxCats)) {
      sel.options[0].textContent = gt('fromPreset', { tier: gt(`tiers.${presetTier(preset, cat)}`) });
      sel.value = CATEGORIES[cat].includes(g[cat]) ? g[cat] : 'preset';
    }
    this.gfxAdaptive.checked = g.adaptive !== false;
    this.gfxFps.checked = !!g.show_fps;
    this.gfxSummary.textContent = info ? `${info.gpu} · ${info.summary}` : '';
    this.gfxPostNote.hidden = !info?.postFailed;
  }

  _buildProfileScreen() {
    this.profileStats = el('div', { class: 'profile-stats' });
    this.identityNameEl = el('strong', { class: 'profile-name' }, playerName(this.platform.displayName()) || t('player'));
    this.screenProfile = el('section', { class: 'screen', id: 'screen-profile', hidden: true, 'aria-labelledby': 'prof-h' },
      this._screenHeader('profileTitle', 'profileTitleSub'),
      el('div', { class: 'profile-grid' },
        el('div', { class: 'card' },
          el('h3', {}, tx('identity')),
          this.platform.hosted
            ? el('div', {},
                this.identityNameEl,
                el('p', { class: 'help-note' }, tx('signedInNote')))
            : el('p', { class: 'help-note' }, tx('guestNote'))),
        el('div', { class: 'card' }, el('h3', {}, tx('statistics')), this.profileStats),
        el('div', { class: 'card' },
          el('h3', {}, tx('friends')),
          el('p', { class: 'help-note' }, tx(this.platform.hosted ? 'friendsHosted' : 'friendsOffline'))),
        el('div', { class: 'card' },
          el('h3', {}, tx('shortcuts')),
          el('button', { class: 'ghost-btn', id: 'btn-profile-achievements', onclick: () => this.showScreen('achievements') }, tx('achievements')),
          el('button', { class: 'ghost-btn', id: 'btn-profile-settings', onclick: () => this.showScreen('settings') }, tx('settings')),
          el('button', { class: 'ghost-btn', id: 'btn-profile-help', onclick: () => this.showScreen('help') }, tx('howToPlayShort'))),
      ),
    );
    this.screens.append(this.screenProfile);
  }

  _refreshProfile() {
    const prog = this.store.loadProgression();
    const st = prog.stats;
    const rows = [
      [t('statRounds'), st.roundsPlayed],
      [t('statWon'), st.roundsWon],
      [t('statDraws'), st.roundsDrawn],
      [t('statScore'), st.totalScore],
      [t('statAchievements'), `${Object.keys(prog.achievements).length}/${ACHIEVEMENTS.length}`],
      [t('statLessons'), `${Object.keys(prog.lessons).length}/${LESSONS.length}`],
    ];
    this.profileStats.innerHTML = '';
    for (const [k, v] of rows) {
      this.profileStats.append(el('div', { class: 'stat-row' }, el('span', {}, k), el('strong', {}, String(v))));
    }
  }

  async copyInvite() {
    const url = this.platform.inviteLink();
    if (!url) return;
    try { await navigator.clipboard.writeText(url); this.toast(sh('copied')); }
    catch { this.toast(sh('copyFail', { url })); }
  }

  // Account name (hosted) in the title and HUD slots; nothing to show offline.
  _refreshIdentity() {
    if (this.signInBtn) this.signInBtn.hidden = !this.platform.canSignIn();
    if (this.inviteBtn) this.inviteBtn.hidden = !this.platform.inviteLink();
    const name = playerName(this.platform.displayName());
    if (this.titleNameEl) this.titleNameEl.textContent = name ? t('playingAs', { name }) : '';
    if (this.hudNameEl) {
      this.hudNameEl.textContent = name || '';
      this.hudNameEl.hidden = !name;
    }
    if (this.identityNameEl) this.identityNameEl.textContent = name || t('player');
  }

  // Small cloud-sync indicator next to the clock: synced / saving / offline.
  updateSyncStatus(state) {
    this._syncState = state;
    if (!this.syncEl) return;
    const label = t(state === 'synced' ? 'syncSynced' : state === 'saving' ? 'syncSaving' : this.platform.hosted ? 'syncOffline' : 'syncLocal');
    this.syncEl.textContent = label;
    this.syncEl.dataset.state = state;
  }

  _buildHostedScreen() {
    this.screenHosted = el('section', { class: 'screen', id: 'screen-hosted', hidden: true, 'aria-labelledby': 'host-h' },
      this._screenHeader('hostedTitle', 'hostedSub'),
      el('div', { class: 'card' },
        el('p', {}, tx('hostedUnavailable')),
        el('p', { class: 'help-note' }, tx('hostedNote'))),
    );
    this.screens.append(this.screenHosted);
  }

  _screenHeader(title, sub) {
    return el('header', { class: 'screen-header' },
      el('button', { class: 'back-btn', onclick: () => this.goBack(), 'aria-label': lv('back') }, '←'),
      el('div', {}, el('h2', {}, tx(title)), el('p', { class: 'screen-sub' }, tx(sub))),
      el('button', { class: 'icon-btn', 'aria-label': lv('settings'), onclick: () => this.showScreen('settings') }, '⚙'),
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
      target.scrollTop = 0;
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
      const m = this.session.match;
      const config = { ...m.config };
      if (m.assists?.timingAssistApplied && config.timeLimitMs > 0) config.timeLimitMs = Math.round(config.timeLimitMs / 1.5);
      this.lastMatchOptions = m.initialOptions || {
        mode: m.mode, contentId: m.contentId, contentName: m.contentName, config,
        seed: m.seed, ai: m.aiDifficulty?.id, humanPlayer: m.humanPlayer,
        series: m.seriesLength, theme: m.theme, ranked: m.ranked,
        assists: m.assists, par: m.par, goals: m.goals,
      };
      this.enterPlayfield();
      this.openPauseModal('matchRestored');
    }
  }

  // ================= match setup sheets =================

  /** spec() → { title, rows, onStart }; re-run on a language change while open. */
  _setupSheet(spec) {
    const build = () => {
      const { title, rows, onStart } = spec();
      return el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('h3', {}, title),
        el('dl', { class: 'mode-facts' }, rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v)))),
        el('div', { class: 'sheet-actions' },
          el('button', { class: 'primary-btn', 'data-act': 'start', onclick: () => { this.closeModal(); onStart(); } }, t('start')),
          el('button', { class: 'ghost-btn', 'data-act': 'cancel', onclick: () => this.closeModal() }, t('cancel'))),
      );
    };
    this.openModal(build(), { render: build });
  }

  _rulesSummary(config) {
    const parts = [t('rsBoard', { n: config.boardSize }), t('rsLine', { n: config.winLength })];
    if (config.disabledCells.length) parts.push(t(config.disabledCells.length > 1 ? 'rsSealedMany' : 'rsSealedOne', { n: config.disabledCells.length }));
    if (config.moveLimit) parts.push(t('rsMoveLimit', { n: config.moveLimit }));
    if (config.timeLimitMs) parts.push(t('rsClock', { time: fmtTime(config.timeLimitMs) }));
    if (config.misere) parts.push(t('rsMisere'));
    if (config.startMarks.length) parts.push(t(config.startMarks.length > 1 ? 'rsOpeningMany' : 'rsOpeningOne', { n: config.startMarks.length }));
    return parts.join(' · ');
  }

  openStageSheet(stage) {
    const prog = this.store.loadProgression();
    const rec = prog.journey[stage.id];
    this._setupSheet(() => ({
      title: t('stageTitle', { n: stage.index, name: stageName(stage) }),
      rows: [
        [t('rules'), this._rulesSummary(stage.config)],
        [t('opponent'), t('opponentValue', { name: stage.opponent.name === 'Rival' ? t('rival') : stage.opponent.name, difficulty: aiName(stage.opponent.difficulty) })],
        [t('series'), stage.series > 1 ? t('bestOf', { n: stage.series }) : t('singleRound')],
        [t('duration'), stage.par.timeMs >= 240000 ? t('dur5') : t('dur2')],
        [t('ranked'), this.platform.hosted ? t('rankedLb') : t('noProgression')],
        [t('par'), t('parValue', { marks: stage.par.marks, time: fmtTime(stage.par.timeMs) })],
        [t('best'), rec ? t('bestValue', { stars: rec.stars, score: rec.bestScore }) : '—'],
      ],
      onStart: () => this.startStage(stage),
    }));
  }

  openChallengeSheet(c) {
    this._setupSheet(() => ({
      title: challengeText(c, 0, c.name),
      rows: [
        [t('goal'), challengeText(c, 2, c.goalText)],
        [t('rules'), this._rulesSummary(c.config)],
        [t('opponent'), aiName(c.ai)],
        [t('seed'), String(c.seed)],
        [t('ranked'), this.platform.hosted ? t('rankedLb') : t('no')],
      ],
      onStart: () => this.startChallenge(c),
    }));
  }

  /** Display name of the running match's content, in the current language. */
  contentLabel(m) {
    if (!m) return '';
    if (m.mode === 'journey') {
      const st = JOURNEY_STAGES.find((x) => x.id === m.contentId);
      if (st) return t('stageTitle', { n: st.index, name: stageName(st) });
    }
    if (m.mode === 'challenge') {
      const c = CHALLENGES.find((x) => x.id === m.contentId);
      if (c) return challengeText(c, 0, c.name);
    }
    if (m.mode === 'daily') {
      const r = /^Daily — (.+)$/.exec(m.contentName || '');
      if (r) return t('dailyTitle', { name: rulesetName(r[1]) });
    }
    if (m.mode === 'learn') {
      const l = LESSONS.find((x) => x.id === m.contentId);
      if (l) return lessonText(l, 'name', l.name);
    }
    if (m.mode === 'practice') return t('practice');
    if (m.contentName === 'Friendly Round') return t('friendlyRound');
    return m.contentName || '';
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
    // One ranked attempt per day; replays of a completed daily are unranked.
    const done = !!this.store.loadProgression().dailies[daily.id];
    this._setupSheet(() => ({
      title: t('dailyTitle', { name: rulesetName(daily.rulesetName) }),
      rows: [
        [t('dateUtc'), daily.date],
        [t('rules'), this._rulesSummary(daily.config)],
        [t('opponent'), aiName(daily.ai)],
        [t('seed'), String(daily.seed)],
        [t('ranked'), this.settings.accessibility.timingAssist ? t('noTiming') : done ? t('noAlready') : t('yesFair')],
      ],
      onStart: () => {
        this.lastMatchOptions = {
          mode: 'daily', contentId: daily.id, contentName: daily.name,
          config: daily.config, seed: daily.seed, ai: daily.ai, series: 1, theme: daily.theme,
          par: { marks: 5, timeMs: 90000 }, ranked: !done,
          assists: { timingAssist: this.settings.accessibility.timingAssist },
        };
        this._launch(this.lastMatchOptions);
      },
    }));
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
    this.session.startLesson(lesson);
    this.enterPlayfield();
    this.announce(t('lessonAnnounce', { name: lessonText(lesson, 'name', lesson.name), intro: lessonText(lesson, 'intro', lesson.intro) }));
  }

  _launch(options) {
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
    // The camera still moves after setup (intro swoop, angle changes), so the
    // DOM mirror must track the projection every frame while the HUD is up.
    this.renderer.onFrame = () => this._layoutCellOverlay();
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
    this.renderer.onFrame = null;
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
    const rect = this.renderer.canvas?.getBoundingClientRect?.() || null;
    for (let i = 0; i < this.cellButtons.length; i++) {
      const p = this.renderer.projectCell(i, rect);
      const btn = this.cellButtons[i];
      const q = p.quad;
      if (q && q.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y))) {
        // bounding box of the projected cell, clipped to its exact polygon so
        // neighbouring cells never steal each other's clicks
        const xs = q.map((c) => c.x), ys = q.map((c) => c.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
        btn.style.left = `${(x0 + x1) / 2}px`;
        btn.style.top = `${(y0 + y1) / 2}px`;
        btn.style.width = `${w}px`;
        btn.style.height = `${h}px`;
        btn.style.clipPath = 'polygon(' + q.map((c) => `${((c.x - x0) / w * 100).toFixed(2)}% ${((c.y - y0) / h * 100).toFixed(2)}%`).join(', ') + ')';
      } else {
        const size = Math.max(44, p.halfSize * 1.7);
        btn.style.left = `${p.x}px`;
        btn.style.top = `${p.y}px`;
        btn.style.width = `${size}px`;
        btn.style.height = `${size}px`;
        btn.style.clipPath = '';
      }
    }
  }

  _updateCellLabels() {
    const state = this.session.state;
    if (!state || !this.cellButtons) return;
    const n = state.config.boardSize;
    const humanTurn = state.status === 'active' && state.currentPlayer === this.session.match?.humanPlayer;
    const legal = new Set(humanTurn ? legalCells(state, state.currentPlayer) : []);
    const names = { 0: t('cellEmpty'), 1: t('cellX'), 2: t('cellO') };
    for (let i = 0; i < this.cellButtons.length; i++) {
      const btn = this.cellButtons[i];
      const r = Math.floor(i / n) + 1;
      const c = (i % n) + 1;
      const v = state.board[i];
      const disabledCell = state.config.disabledCells.includes(i);
      btn.setAttribute('aria-label', t('cellLabel', { r, c, what: disabledCell ? t('cellSealed') : names[v], avail: legal.has(i) ? t('cellAvailable') : '' }));
      // aria-disabled (not the disabled attribute): buttons stay focusable and
      // their taps route through tapCell, which explains why a move is illegal
      // instead of silently swallowing the input.
      btn.setAttribute('aria-disabled', legal.has(i) ? 'false' : 'true');
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
        this.toast(t('notThere'), 'warn');
        this.audio.invalid();
      }
      return;
    }
    if (s.phase !== PHASE.ACTIVE || !s.state || s.state.status !== 'active') return;
    if (s.state.currentPlayer !== s.match.humanPlayer) {
      this.toast(t('waitTurn'), 'warn');
      return;
    }
    if (this.settings.accessibility.confirmMoves && this.pendingConfirmCell !== cell) {
      const legal = legalCells(s.state, s.state.currentPlayer);
      if (!legal.includes(cell)) return this._explainIllegal(cell);
      this.pendingConfirmCell = cell;
      this.renderer.setSelection(cell);
      this.announce(t('selectedCell', { r: Math.floor(cell / s.state.config.boardSize) + 1, c: (cell % s.state.config.boardSize) + 1 }));
      return;
    }
    this.pendingConfirmCell = null;
    const res = s.placeCell(cell);
    if (!res.ok) this._explainIllegal(cell, res.reason);
  }

  _explainIllegal(cell, reason) {
    const s = this.session.state;
    const n = s.config.boardSize;
    const at = t('cellAt', { r: Math.floor(cell / n) + 1, c: (cell % n) + 1 });
    let msg;
    if (reason === 'cell-occupied' || s.board[cell] !== 0) msg = t('occupied', { at });
    else if (s.config.disabledCells.includes(cell)) msg = t('sealedCell', { at });
    else if (reason === 'game-over') msg = t('roundOverMsg');
    else msg = t('notLegal');
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
      this.toast(t('gamepadConnected'));
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
      const own = this.settings.bindings?.[action];
      merged[action] = own ? [...new Set(own.map(keyToCode))] : keys;
    }
    return merged;
  }

  _actionForKey(code) {
    for (const [action, keys] of Object.entries(this.effectiveBindings())) {
      if (keys.includes(code)) return action;
    }
    return null;
  }

  _onKey(e) {
    // Don't steal keys from form fields.
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
      if (e.key !== 'Escape') return;
    }
    const action = this._actionForKey(e.code);
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
        this.pauseGame();
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
        if (!this.modal) this.pauseGame();
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
      if (cmd.player !== s.match?.humanPlayer) this.announce(t('rivalPlaced', { r: Math.floor(cmd.cell / s.state.config.boardSize) + 1, c: (cmd.cell % s.state.config.boardSize) + 1 }));
      this._layoutCellOverlay();
    });
    s.on('round-start', () => {
      this.pendingConfirmCell = null;
      this._buildCellOverlay();
      this._updateHudChrome();
      this.announce(t('roundBegins', { n: s.match.roundIndex }));
    });
    s.on('round-end', (r) => {
      const msg = t(r.draw ? 'roundDrawn' : r.humanWon ? 'youTakeRound' : 'rivalTakesRound');
      this.announce(msg);
      if (this.audio) this.audio.setMusicIntensity(0.4);
    });
    s.on('match-end', (result) => {
      this.session.discardLocalSnapshot();
      setTimeout(() => this.openResults(result), this.settings.accessibility.reducedMotion ? 100 : 700);
    });
    s.on('clock', ({ player, remainingMs }) => {
      this._updateClock(player, remainingMs);
    });
    s.on('lesson-step', (info) => {
      this.renderer.setLessonHighlights(info.highlightCells);
      this._updateHudChrome();
      this.announce(this._lessonStepText(info));
      this._updateCellLabels();
    });
    s.on('lesson-failed-step', ({ text }) => {
      text = { 'That did not meet the goal. The step resets — try again.': t('lessonFailedGoal'), 'The rival got there first. The step resets — try again.': t('lessonFailedRival') }[text] || text;
      this.toast(text, 'warn');
      this.announceAssertive(text);
    });
    s.on('lesson-complete', ({ lesson, achievementsUnlocked }) => {
      this.openLessonResults(lesson, achievementsUnlocked);
    });
    s.on('undo', () => {
      this.announce(t('undoneTurn'));
      this.renderer.skipAnimations();
    });
    s.on('phase', ({ phase }) => {
      if (phase === PHASE.COUNTDOWN) this.renderer.skipAnimations();
    });
  }

  // ================= HUD =================

  _lessonStepText(info) {
    return lessonText({ id: this.session.lesson?.id }, 'steps', null)?.[info.stepIndex] || info.step.text;
  }

  _updateHudChrome() {
    const m = this.session.match;
    if (!m) return;
    this.railLeft.innerHTML = '';
    const lessonInfo = this.session.lesson ? this.session.lessonStepInfo() : null;
    this.railLeft.append(
      el('h3', { class: 'rail-title' }, t(m.mode === 'learn' ? 'lesson' : 'match')),
      el('div', { class: 'rail-block' }, el('strong', {}, this.contentLabel(m))),
      el('div', { class: 'rail-block' },
        el('span', {}, m.mode === 'learn'
          ? t('stepOf', { n: lessonInfo.stepIndex + 1, total: lessonInfo.totalSteps })
          : m.seriesLength > 1
            ? t('roundOfSeries', { n: m.roundIndex, total: m.seriesLength, you: m.seriesScore[m.humanPlayer], rival: m.seriesScore[m.humanPlayer === 1 ? 2 : 1] })
            : t('roundN', { n: m.roundIndex }))),
      el('div', { class: 'rail-block' }, el('small', {}, this._rulesSummary(this.session.state.config))),
      el('div', { class: 'rail-block' }, el('small', {}, t('seedN', { n: this.session.state.seed }))),
    );
    this.objectiveEl.textContent = m.mode === 'learn'
      ? this._lessonStepText(lessonInfo)
      : m.config.misere
        ? t('objMisere')
        : t('objLine', { n: m.config.winLength });
    this._updateHud();
  }

  _updateHud() {
    const s = this.session;
    const state = s.state;
    if (!state || !s.match) return;
    const human = state.currentPlayer === s.match.humanPlayer;
    if (s.phase === PHASE.TUTORIAL) {
      this.turnBanner.textContent = t(human ? 'yourMove' : 'watch');
    } else {
      this.turnBanner.textContent = t(state.status === 'terminal'
        ? 'roundOver'
        : human ? 'yourMove' : 'rivalThinking');
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
      parts.push(t(p === human ? 'clockYou' : 'clockRival', { time: fmtTime(remain) }));
    }
    this.clockEl.textContent = parts.join(' · ');
  }

  // ================= actions =================

  pauseGame() {
    // No modal unless the session actually paused (e.g. not mid-resolution).
    if (!this.session.pause('user')) return;
    this.openPauseModal();
  }

  doUndo() {
    const res = this.session.undo();
    if (!res.ok) this.toast(t('undoUnavailable'), 'warn');
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
    this.toast(t('hintToast', { r: Math.floor(cell / n) + 1, c: (cell % n) + 1 }));
    this.announce(t('hintAnnounce', { r: Math.floor(cell / n) + 1, c: (cell % n) + 1 }));
    this.audio.focus();
  }

  cycleCamera() {
    const order = ['standard', 'top', 'low'];
    const cur = this.settings.camera.angle;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.updateSetting('camera.angle', next);
    this.toast(t('cameraToast', { angle: t(CAMERA_KEYS[next]) }));
  }

  // ================= modals =================

  openModal(node, { locked = false, render = null } = {}) {
    this.previousFocus = document.activeElement;
    this.modalRoot.innerHTML = '';
    this.modal = node;
    // render() rebuilds this sheet in the current language (relabel()).
    this._modalRender = render ? () => {
      const next = render();
      next.dataset.locked = node.dataset.locked;
      this.modal.replaceWith(next);
      this.modal = next;
      node = next;
    } : null;
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
    this._modalRender = null;
    if (this.previousFocus && this.previousFocus.focus) this.previousFocus.focus({ preventScroll: true });
  }

  /** noteKey: a strings.js key (or plain text) shown under the heading. */
  openPauseModal(noteKey) {
    const s = this.session;
    const build = () => el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('paused') },
      el('h3', {}, t('paused')),
      noteKey ? el('p', {}, t(noteKey)) : null,
      el('div', { class: 'sheet-actions col' },
        el('button', { class: 'primary-btn', 'data-act': 'resume', onclick: () => { this.closeModal(); s.resume(); } }, t('resume')),
        el('button', { class: 'ghost-btn', 'data-act': 'settings', onclick: () => { this.closeModal(); this._returnToPause = true; this.hud.hidden = true; this.showScreen('settings'); } }, t('settings')),
        el('button', { class: 'ghost-btn', 'data-act': 'help', onclick: () => { this.closeModal(); this._returnToPause = true; this.hud.hidden = true; this.showScreen('help'); } }, t('howToPlayShort')),
        el('button', { class: 'danger-btn', 'data-act': 'leave', onclick: () => { this.closeModal(); this.leaveMatch(); } }, t('leaveMatch'))),
    );
    this.openModal(build(), { render: build });
    this.announce(t('gamePaused'));
  }

  openResults(result) {
    const s = this.session;
    const won = result.outcome === 'win';
    const headlineKey = won ? 'victory' : result.outcome === 'draw' ? 'honestDraw' : 'defeat';
    // Signed in: unassisted Journey, Daily and Challenge matches post their
    // total to the platform high-score board; the line shows the rank.
    const posts = this.platform.hosted && ['journey', 'daily', 'challenge'].includes(result.mode) && !result.assistsUsed;
    let lbState = posts ? { key: 'lbPosting' } : null;
    const human = s.match.humanPlayer;
    const build = () => {
      const rows = result.breakdown.components.map((c) =>
        el('tr', {}, el('td', {}, scoreLabel(c.label)), el('td', { class: 'num' }, `${c.value >= 0 ? '+' : ''}${c.value}`)));
      const actions = [];
      actions.push(el('button', {
        class: 'primary-btn',
        'data-act': 'retry',
        onclick: () => {
          this.closeModal();
          // A daily replay is always unranked — match the button's promise.
          const opts = result.mode === 'daily' && this.lastMatchOptions
            ? { ...this.lastMatchOptions, ranked: false }
            : this.lastMatchOptions;
          this._launch(opts);
        },
      }, t(result.mode === 'daily' ? 'playAgainUnranked' : 'retry')));
      if (result.mode === 'journey' && won) {
        const idx = JOURNEY_STAGES.findIndex((st) => st.id === result.contentId);
        const next = JOURNEY_STAGES[idx + 1];
        if (next) {
          actions.push(el('button', { class: 'ghost-btn', 'data-act': 'next', onclick: () => { this.closeModal(); this.openStageSheet(next); } }, t('nextName', { name: stageName(next) })));
        }
      }
      actions.push(el('button', { class: 'ghost-btn', 'data-act': 'modes', onclick: () => { this.closeModal(); this.leaveMatch(); } }, t('backToModes')));
      const achBadges = (result.achievementsUnlocked || []).map((key) => {
        const a = ACHIEVEMENTS.find((x) => x.key === key);
        return a ? el('div', { class: 'ach-badge' }, `🏅 ${achievementText(a, 0)}`) : null;
      });
      const name = this.contentLabel(result);
      return el('div', { class: 'sheet results', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('matchResults') },
        el('h3', { class: won ? 'won' : result.outcome === 'draw' ? 'drew' : 'lost' }, t(headlineKey)),
        el('p', { class: 'results-sub' },
          t(result.rounds.length > 1 ? 'resultsSubMany' : 'resultsSubOne', { name, n: result.rounds.length }) +
          (result.ranked ? t('rankedTag') : result.assistsUsed ? t('unrankedAssists') : '')),
        result.stars ? el('div', { class: 'stars big', 'aria-label': t('starsOf3', { n: result.stars }) }, '★'.repeat(result.stars) + '☆'.repeat(3 - result.stars)) : null,
        el('table', { class: 'breakdown' },
          el('tbody', {}, rows),
          el('tfoot', {}, el('tr', {}, el('td', {}, t('total')), el('td', { class: 'num' }, String(result.breakdown.total))))),
        result.rounds.length > 1
          ? el('p', { class: 'results-sub' }, t('seriesScore', { you: result.seriesScore[human], rival: result.seriesScore[human === 1 ? 2 : 1] }))
          : null,
        achBadges.length ? el('div', { class: 'ach-row' }, achBadges) : null,
        el('p', { class: 'results-sub' }, this._nextRecommendation(result)),
        lbState ? el('p', { class: 'results-sub', id: 'results-lb', role: 'status' }, sh(lbState.key, lbState.vars)) : null,
        el('div', { class: 'sheet-actions' }, actions),
      );
    };
    const sheet = build();
    this.openModal(sheet, { render: build });
    if (lbState) {
      this.platform.submitScore(result.breakdown.total).then((r) => {
        lbState = !r.posted ? { key: 'lbNotPosted' } : r.rank ? { key: 'lbRank', vars: { rank: r.rank } } : { key: 'lbPosted' };
        const line = this.modalRoot.querySelector('#results-lb');
        if (line) line.textContent = sh(lbState.key, lbState.vars);
      });
    }
    this.announce(t('resultsAnnounce', { headline: t(headlineKey), total: result.breakdown.total }));
    if (this.audio) this.audio.setMusicIntensity(0.1);
  }

  _nextRecommendation(result) {
    if (result.mode === 'journey') return t(result.outcome !== 'win' ? 'recJourneyLost' : 'recJourneyWon');
    if (result.mode === 'daily') return t('recDaily');
    if (result.mode === 'learn') return t('recLearn');
    if (result.mode === 'challenge') return t(result.outcome === 'win' ? 'recChallengeWon' : 'recChallengeLost');
    return t(result.outcome === 'win' ? 'recPracticeWon' : 'recPracticeLost');
  }

  openLessonResults(lesson, achievementsUnlocked) {
    const idx = LESSONS.findIndex((l) => l.id === lesson.id);
    const next = LESSONS[idx + 1];
    const build = () => {
      const actions = [
        next
          ? el('button', { class: 'primary-btn', 'data-act': 'next', onclick: () => { this.closeModal(); this.startLesson(next); } }, t('nextName', { name: lessonText(next, 'name', next.name) }))
          : el('button', { class: 'primary-btn', 'data-act': 'play', onclick: () => { this.closeModal(); this.leaveMatch(); this.showScreen('modes'); } }, t('startPlaying')),
        el('button', { class: 'ghost-btn', 'data-act': 'lessons', onclick: () => { this.closeModal(); this.leaveMatch(); this.showScreen('lessons'); } }, t('allLessons')),
      ];
      return el('div', { class: 'sheet results', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('lessonCompleteAria') },
        el('h3', { class: 'won' }, t('lessonComplete')),
        el('p', { class: 'results-sub' }, lessonText(lesson, 'name', lesson.name)),
        (achievementsUnlocked || []).length
          ? el('div', { class: 'ach-row' }, achievementsUnlocked.map((k) => {
            const a = ACHIEVEMENTS.find((x) => x.key === k);
            return el('div', { class: 'ach-badge' }, `🏅 ${a ? achievementText(a, 0) : k}`);
          }))
          : null,
        el('div', { class: 'sheet-actions' }, actions),
      );
    };
    this.openModal(build(), { render: build });
    this.announce(t('lessonCompleteAnnounce', { name: lessonText(lesson, 'name', lesson.name) }));
  }

  // ================= settings =================

  updateSetting(path, value) {
    const keys = path.split('.');
    let obj = this.settings;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
    obj[keys[keys.length - 1]] = value;
    this.store.saveSettings(this.settings);
    this.platform.pushSettings(this.settings);
    this.applySettings(this.settings);
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
      const gfxKey = JSON.stringify(s.graphics);
      if (gfxKey !== this._gfxKey) {
        this._gfxKey = gfxKey;
        this.renderer.setGraphics?.(s.graphics);
      }
      this.renderer.setCameraAngle(s.camera.angle);
      // Only theme/palette changes need the scene rebuilt (audio sliders etc. don't).
      const sceneKey = `${s.theme}|${a.palette}`;
      if (sceneKey !== this._sceneKey) {
        this._sceneKey = sceneKey;
        if (!this.hud.hidden && this.session.state) {
          // Refresh palette-dependent materials.
          this.renderer._rebuildScenePreserving?.();
          this.renderer.syncState(this.session.state, { instant: true });
        } else {
          this.renderer.setTheme(themeById(s.theme));
        }
      }
    }
    // Reflect values into controls.
    this.setMuted.checked = s.audio.muted;
    this._refreshGraphicsInfo();
    this.setTheme.value = s.theme;
    this.setCamera.value = s.camera.angle;
    this.setPalette.value = a.palette;
    this.togReduced.input.checked = a.reducedMotion;
    this.togContrast.input.checked = a.highContrast;
    this.togLargerText.input.checked = a.largerText;
    this.togLefty.input.checked = a.leftHanded;
    this.togConfirm.input.checked = a.confirmMoves;
    this.togTiming.input.checked = a.timingAssist;
    this.togHaptics.input.checked = a.haptics;
    this._renderBindingsEditor();
  }

  _renderBindingsEditor() {
    const bindings = this.effectiveBindings();
    this.bindingsEditor.innerHTML = '';
    for (const [action, keys] of Object.entries(bindings)) {
      const btn = el('button', {
        class: 'ghost-btn small',
        onclick: () => this._captureBinding(action),
      }, keys.map(codeLabel).join(' / '));
      this.bindingsEditor.append(el('div', { class: 'binding-row' }, el('span', {}, bindingLabel(action)), btn));
    }
    this.bindingsEditor.append(el('button', {
      class: 'ghost-btn small', id: 'btn-reset-keys', onclick: () => this.resetBindings(),
    }, sh('resetKeys')));
  }

  resetBindings() {
    this.updateSetting('bindings', null);
    this.platform.resetBindings();
    this._renderBindingsEditor();
    this._refreshHelpBindings();
  }

  _captureBinding(action) {
    this.toast(t('pressKey', { action: bindingLabel(action) }));
    const handler = (e) => {
      e.preventDefault();
      window.removeEventListener('keydown', handler, true);
      if (e.code === 'Escape' || !e.code) return;
      // One action per key: the code moves off any other action.
      const bindings = this.effectiveBindings();
      const changed = { [action]: [e.code] };
      for (const [other, codes] of Object.entries(bindings)) {
        if (other !== action && codes.includes(e.code)) changed[other] = codes.filter((c) => c !== e.code);
      }
      Object.assign(bindings, changed);
      this.updateSetting('bindings', bindings);
      for (const [a, codes] of Object.entries(changed)) this.platform.saveBinding(a, codes);
      this._renderBindingsEditor();
    };
    window.addEventListener('keydown', handler, true);
  }

  resetProgress() {
    if (!confirm(t('resetConfirm'))) return;
    const sealed = this.store.saveProgression({ ...this.store.loadProgression(), journey: {}, lessons: {}, challenges: {}, dailies: {}, achievements: {}, stats: { roundsPlayed: 0, roundsWon: 0, roundsDrawn: 0, byMode: {}, totalScore: 0 } });
    this.session.emit('progress-saved', sealed);
    this.toast(t('progressReset'));
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
