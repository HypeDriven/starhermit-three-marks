// StarHermit host adapter. Everything degrades gracefully to offline/local
// play when the game is opened outside the host shell (file://, static host).
// Launch tokens arrive in the URL fragment, are read once and stripped, and
// are kept in memory only — never persisted.

export class Platform {
  constructor() {
    this.hosted = false;
    this.timeOffsetMs = 0; // no platform clock endpoint: local clock stays authoritative
    this.launchToken = null;
    this.userId = null; // JWT sub
    this.gameSlug = null; // JWT game_scope (never hard-coded)
    this.nickname = null; // account nickname, hosted only
    this.onProfileLoaded = null; // UI hook
    this.onCloudSyncState = null; // UI hook: synced | saving | offline
    this.cloudSyncState = 'offline';
    this.sessionId = randomId();
    this.refreshTimer = null;
    this.cloudTimer = null; // debounce handle for cloud saves
    this.cloudDirty = false;
    this._pendingDoc = null;
  }

  // boot: read the launch token and decode it. Hosted mode activates iff a
  // token was read; the platform documents no clock endpoint, so the local
  // clock stays authoritative (timeOffsetMs remains 0).
  async boot() {
    if (typeof location !== 'undefined') this.readLaunchToken();
    if (typeof fetch === 'undefined' || !location || !/^https?:$/.test(location.protocol)) {
      return { hosted: false, reason: 'offline-context' };
    }
    // The host shell always launches with a token; without one this is a
    // static host with no API.
    if (!this.launchToken) {
      return { hosted: false, reason: 'no-launch-token' };
    }
    this.hosted = true;
    this.scheduleTokenRefresh();
    this.loadProfile().catch(() => {});
    return { hosted: true };
  }

  // Read `#game_token=<jwt>[&session_id=<guid>]` once and strip it from the
  // URL. Query-param fallbacks exist only for local dev against a stub host.
  readLaunchToken() {
    let raw = null;
    if (location.hash.length > 1) {
      const frag = new URLSearchParams(location.hash.slice(1));
      raw = frag.get('game_token');
      if (raw) {
        try {
          history.replaceState(null, '', location.pathname + location.search);
        } catch {
          // file:// or a sandboxed frame: leave the hash in place.
        }
      }
    }
    if (!raw) {
      const params = new URLSearchParams(location.search);
      raw = params.get('launch_token') || params.get('token') || params.get('launch');
    }
    if (!raw) return;
    this.launchToken = raw;
    const payload = decodeJwtPayload(raw);
    if (payload) {
      if (typeof payload.sub === 'string') this.userId = payload.sub;
      if (typeof payload.game_scope === 'string') this.gameSlug = payload.game_scope;
    }
  }

  authHeaders() {
    const h = {};
    if (this.launchToken) h.Authorization = `Bearer ${this.launchToken}`;
    return h;
  }

  // Authoritative now: the local clock (the platform exposes no time
  // endpoint; the offset seam stays for a future host clock).
  serverNow() {
    return Date.now() + this.timeOffsetMs;
  }

  // ---- profile ----

  // Nickname via the user-profile route only (launch tokens cannot call
  // /api/v1/me). The UI falls back to "Player " + id prefix.
  displayName() {
    if (this.nickname) return this.nickname;
    if (this.userId) return 'Player ' + this.userId.slice(0, 8);
    return null;
  }

  async loadProfile() {
    if (!this.hosted || !this.userId) return null;
    try {
      const res = await fetch(`/api/v1/users/${encodeURIComponent(this.userId)}/profile`, {
        headers: this.authHeaders(), signal: timeoutSignal(4000),
      });
      if (!res.ok) return null;
      const body = await res.json();
      if (body && typeof body === 'object' && typeof body.nickname === 'string' && body.nickname) {
        this.nickname = body.nickname;
        if (this.onProfileLoaded) this.onProfileLoaded(this.nickname);
      }
      return this.nickname;
    } catch {
      return null;
    }
  }

  // ---- launch-token refresh ----
  // Scoped launch tokens live ~60 min; re-mint through the game's
  // launch-token route with the current token and swap the new one in.
  // Scheduled every 45 min; failures retry after ~60 s.
  scheduleTokenRefresh(delayMs = 45 * 60 * 1000) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      if (!this.hosted || !this.gameSlug || !this.launchToken) return;
      try {
        const res = await fetch(`/api/v1/games/${encodeURIComponent(this.gameSlug)}/launch-token`, {
          method: 'POST',
          headers: this.authHeaders(),
          signal: timeoutSignal(4000),
        });
        if (res.ok) {
          const body = await res.json();
          if (body && typeof body.token === 'string' && body.token) {
            this.launchToken = body.token;
            const payload = decodeJwtPayload(this.launchToken);
            if (payload && typeof payload.sub === 'string') this.userId = payload.sub;
          }
          this.scheduleTokenRefresh();
          return;
        }
      } catch {
        // fall through to the retry schedule
      }
      this.scheduleTokenRefresh(60 * 1000);
    }, delayMs);
  }

  // ---- cloud saves ----
  // One slot per game (the slug from game_scope), zip+base64. The local
  // checksummed document stays the offline cache; the cloud slot is a
  // mirror that wins unless the local copy is a strict descendant.

  setSyncState(state) {
    if (this.cloudSyncState === state) return;
    this.cloudSyncState = state;
    if (this.onCloudSyncState) this.onCloudSyncState(state);
  }

  async loadCloudSave() {
    if (!this.hosted || !this.gameSlug) return null;
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.gameSlug)}`, {
        headers: this.authHeaders(), signal: timeoutSignal(5000),
      });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
      return doc && typeof doc === 'object' ? doc : null;
    } catch {
      return null;
    }
  }

  async saveCloudSave(doc) {
    if (!this.hosted || !this.gameSlug) return false;
    try {
      const bytes = zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)));
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.gameSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ dataBase64: bytesToBase64(bytes) }),
        signal: timeoutSignal(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Debounced (~2 s) mirror of a just-written local document; flushed on
  // pagehide as well. Never blocks play.
  queueCloudSave(doc) {
    this._pendingDoc = doc;
    this.cloudDirty = true;
    if (this.cloudTimer) clearTimeout(this.cloudTimer);
    this.cloudTimer = setTimeout(() => this.flushCloudSave(), 2000);
  }

  async flushCloudSave() {
    if (this.cloudTimer) { clearTimeout(this.cloudTimer); this.cloudTimer = null; }
    if (!this.cloudDirty) return;
    const doc = this._pendingDoc;
    this.cloudDirty = false;
    if (!this.hosted) { this.setSyncState('offline'); return; }
    this.setSyncState('saving');
    const ok = await this.saveCloudSave(doc);
    this.setSyncState(ok ? 'synced' : 'offline');
    if (!ok) {
      // Mirror failed: keep the document dirty for the next flush.
      this._pendingDoc = doc;
      this.cloudDirty = true;
    }
  }
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

export function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
