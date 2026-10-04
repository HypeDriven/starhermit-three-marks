// StarHermit host adapter over window.StarHermit (starhermit-sdk.js).
// Everything degrades gracefully to offline/local play when the game is
// opened without a launch token (file://, static host): no request is made.
// The SDK reads #game_token= / #access_token= once, strips it, keeps the
// token in memory only and renews it; the slug comes from game_scope.

/** Settings keys mirrored to the platform settings KV (bindings use the controls API). */
export const PREF_KEYS = ['audio', 'graphics', 'accessibility', 'camera', 'tutorial', 'theme'];

const SETTINGS_PUSH_MS = 800;

export class Platform {
  constructor(sdk) {
    this.sh = sdk || (typeof globalThis !== 'undefined' ? globalThis.StarHermit : null) || null;
    this.timeOffsetMs = 0; // no platform clock endpoint: local clock stays authoritative
    this.nickname = null; // account nickname, hosted only
    this.onProfileLoaded = null; // UI hook
    this.onCloudSyncState = null; // UI hook: synced | saving | offline
    this.onAuthChange = null; // UI hook: ({signedIn})
    this.cloudSyncState = 'offline';
    this.sessionId = randomId();
    this._pushedPrefs = {};
    this._prefTimer = null;
  }

  /** True while a StarHermit launch token is held. */
  get hosted() { return !!(this.sh && this.sh.signedIn); }
  get userId() { return this.hosted ? this.sh.userId : null; }
  get gameSlug() { return this.sh ? this.sh.slug : null; }

  // boot: read the launch token. Hosted mode iff a token was read.
  async boot() {
    if (!this.sh) return { hosted: false, reason: 'no-sdk' };
    this.sh.init();
    this.sh.on('saved', (ok) => this.setSyncState(ok ? 'synced' : 'offline'));
    this.sh.on('auth', (a) => {
      if (!a.signedIn) { this.nickname = null; this.setSyncState('offline'); }
      if (this.onAuthChange) this.onAuthChange(a);
    });
    if (!this.hosted) return { hosted: false, reason: 'no-launch-token' };
    this.loadProfile().catch(() => {});
    return { hosted: true };
  }

  canSignIn() { return !!(this.sh && this.sh.canSignIn()); }
  signIn() { return !!(this.sh && this.sh.signIn()); }
  /** Share link that friends the recipient and invites them back; null offline. */
  inviteLink() { return this.hosted ? this.sh.inviteLink() : null; }

  // Authoritative now: the local clock (the platform exposes no time endpoint).
  serverNow() {
    return Date.now() + this.timeOffsetMs;
  }

  // ---- profile ----
  // Nickname via the user-profile route (never /api/v1/me); fallback
  // "Player " + id prefix.
  displayName() {
    if (this.nickname) return this.nickname;
    if (this.userId) return 'Player ' + this.userId.slice(0, 6);
    return null;
  }

  async loadProfile() {
    if (!this.hosted) return null;
    const p = await this.sh.profile();
    if (p && p.nickname) {
      this.nickname = p.nickname;
      if (this.onProfileLoaded) this.onProfileLoaded(this.nickname);
    }
    return this.nickname;
  }

  // ---- cloud saves ----
  // One slot (game:<slug>). The local checksummed document stays the offline
  // cache; the cloud slot is a mirror that wins unless the local copy is a
  // strict descendant.
  setSyncState(state) {
    if (this.cloudSyncState === state) return;
    this.cloudSyncState = state;
    if (this.onCloudSyncState) this.onCloudSyncState(state);
  }

  async loadCloudSave() {
    if (!this.hosted) return null;
    const doc = await this.sh.loadJSON();
    this.setSyncState('synced');
    return doc && typeof doc === 'object' ? doc : null;
  }

  // Debounced (~2 s) mirror of a just-written local document; flushed on
  // pagehide as well. Never blocks play.
  queueCloudSave(doc) {
    if (!this.hosted) return;
    this.setSyncState('saving');
    this.sh.saveJSON(doc, 2000);
  }

  flushCloudSave() {
    return this.hosted ? this.sh.flushSave(true) : Promise.resolve(false);
  }

  // ---- settings KV ----
  /** Platform-stored preferences {key: value} that win over local ones. */
  async loadPlatformSettings(local) {
    if (!this.hosted) return null;
    const remote = await this.sh.getSettings();
    const patch = {};
    for (const k of PREF_KEYS) if (remote && remote[k] != null) patch[k] = remote[k];
    this._pushedPrefs = { ...pickPrefs(local), ...patch };
    return patch;
  }

  /** Debounced PATCH of changed preference keys (no-op offline). */
  pushSettings(s) {
    if (!this.hosted) return;
    clearTimeout(this._prefTimer);
    this._prefTimer = setTimeout(() => {
      const prefs = pickPrefs(s), diff = {};
      for (const k of PREF_KEYS) {
        if (JSON.stringify(prefs[k]) !== JSON.stringify(this._pushedPrefs[k])) diff[k] = prefs[k] ?? null;
      }
      if (!Object.keys(diff).length) return;
      Object.assign(this._pushedPrefs, diff);
      this.sh.patchSettings(diff);
    }, SETTINGS_PUSH_MS);
  }

  // ---- controls ----
  /** Effective bindings with platform overrides (null offline). */
  async loadBindings(defaults) {
    return this.hosted ? this.sh.loadBindings(defaults) : null;
  }
  saveBinding(action, codes) {
    if (this.hosted) this.sh.setControl(action, codes).catch(() => {});
  }
  resetBindings() {
    if (this.hosted) this.sh.resetControls();
  }
}

function pickPrefs(s) {
  const out = {};
  for (const k of PREF_KEYS) if (s && s[k] !== undefined) out[k] = s[k];
  return out;
}

export function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
