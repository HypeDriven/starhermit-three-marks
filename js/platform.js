// StarHermit host adapter. Everything degrades gracefully to offline/local
// play when the game is opened outside the host shell (file://, static host).
// Launch tokens are read from the URL and never persisted.

export class Platform {
  constructor() {
    this.hosted = false;
    this.timeOffsetMs = 0; // serverNow = Date.now() + offset
    this.timeSyncedAt = 0;
    this.launchToken = null;
    this.accountToken = null;
    this.sessionId = randomId();
    this.presenceTimer = null;
    this.activityStarted = false;
    this.telemetryQueue = [];
    this.telemetryConsent = false;
  }

  // boot: read launch token, probe host API, sync clock.
  async boot() {
    if (typeof location !== 'undefined') {
      const params = new URLSearchParams(location.search);
      this.launchToken = params.get('launch_token') || null;
    }
    if (typeof fetch === 'undefined' || !location || !/^https?:$/.test(location.protocol)) {
      return { hosted: false, reason: 'offline-context' };
    }
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', { headers: this.authHeaders(), signal: timeoutSignal(3000) });
      const t1 = Date.now();
      if (!res.ok) {
        const body = await safeJson(res);
        return { hosted: false, reason: (body && body.error) || `http-${res.status}` };
      }
      const body = await res.json();
      const serverMs = body.now ?? body.serverTime ?? body.time;
      if (Number.isFinite(serverMs)) {
        // Round-trip-adjusted offset.
        this.timeOffsetMs = serverMs - Math.floor((t0 + t1) / 2);
        this.timeSyncedAt = t1;
      }
      this.hosted = true;
      return { hosted: true };
    } catch (err) {
      return { hosted: false, reason: 'unreachable' };
    }
  }

  authHeaders() {
    const h = {};
    if (this.accountToken) h.Authorization = `Bearer ${this.accountToken}`;
    if (this.launchToken) h['X-Launch-Token'] = this.launchToken;
    return h;
  }

  // Authoritative now: platform time when hosted, local clock otherwise.
  serverNow() {
    return Date.now() + this.timeOffsetMs;
  }

  // Refresh account tokens through the host shell; tokens live in memory only.
  async refreshAccountToken() {
    if (!this.hosted) return null;
    try {
      const res = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: this.authHeaders(), signal: timeoutSignal(4000) });
      if (!res.ok) return null;
      const body = await res.json();
      this.accountToken = body.token || null;
      return this.accountToken;
    } catch {
      return null;
    }
  }

  // ---- activity & presence ----

  startActivity() {
    if (this.activityStarted) return;
    this.activityStarted = true;
    this.post('/api/v1/activity/start', { sessionId: this.sessionId });
  }

  endActivity() {
    if (!this.activityStarted) return;
    this.activityStarted = false;
    this.post('/api/v1/activity/end', { sessionId: this.sessionId });
  }

  startPresence(intervalMs = 30000) {
    this.stopPresence();
    if (!this.hosted) return;
    this.presenceTimer = setInterval(() => {
      this.post('/api/v1/presence', { sessionId: this.sessionId, state: document.hidden ? 'background' : 'playing' });
    }, intervalMs);
  }

  stopPresence() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  async post(path, body) {
    if (!this.hosted) return { ok: false, reason: 'offline' };
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(body),
        signal: timeoutSignal(4000),
      });
      if (res.status === 429) return { ok: false, reason: 'rate-limited' };
      if (!res.ok) {
        const parsed = await safeJson(res);
        return { ok: false, reason: (parsed && parsed.error) || `http-${res.status}` };
      }
      return { ok: true, body: await safeJson(res) };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }

  // ---- telemetry: anonymous, consent-gated, aggregate only ----

  setTelemetryConsent(consent) {
    this.telemetryConsent = !!consent;
    if (!consent) this.telemetryQueue.length = 0;
  }

  // Allowed events: start, tutorial_step, round_end, retry, settings_change, error.
  track(event, data = {}) {
    if (!this.telemetryConsent) return;
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!allowed.includes(event)) return;
    // Strip anything that could carry raw text or personal data.
    const safe = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
      else if (typeof v === 'string' && k !== 'text' && k !== 'message' && v.length <= 40) safe[k] = v;
    }
    this.telemetryQueue.push({ event, data: safe, at: this.serverNow(), sessionId: this.sessionId });
    if (this.telemetryQueue.length >= 20) this.flushTelemetry();
  }

  flushTelemetry() {
    if (!this.telemetryQueue.length) return;
    const batch = this.telemetryQueue.splice(0, this.telemetryQueue.length);
    this.post('/api/v1/telemetry', { events: batch });
  }
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
