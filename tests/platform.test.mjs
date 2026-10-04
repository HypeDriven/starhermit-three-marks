// platform.test.mjs — js/platform.js over starhermit-sdk.js with a stubbed
// fetch and launch hash: token read, nickname, cloud-save path game:<slug>
// round-trip, settings patch, controls, and no network standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Platform } from '../js/platform.js';

// The SDK is a classic browser script; package.json "type": "module" makes
// Node treat .js as ESM, so evaluate it with a CommonJS shim.
const mod = { exports: {} };
new Function('module', 'exports', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(mod, mod.exports);
const SDK = mod.exports;
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `x.${b64url({ sub: 'u-12345678', game_scope: 'marks-test', exp: Math.floor(Date.now() / 1000) + 3600 })}.y`;
const DEFAULTS = { pause: ['KeyP'], undo: ['KeyU'] };

function setup(hash, hostname = 'marks-test.starhermit.com') {
  const calls = [], store = new Map();
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body, auth: init.headers?.Authorization });
    const path = url.split('?')[0];
    const json = (o) => new Response(JSON.stringify(o));
    if (path.endsWith('/profile')) return json({ nickname: 'Noughts' });
    if (path.includes('/cloud-saves/')) {
      if (init.method === 'PUT') { store.set(path, JSON.parse(init.body).dataBase64); return new Response(null, { status: 204 }); }
      return store.has(path) ? new Response(Buffer.from(store.get(path), 'base64')) : new Response(null, { status: 404 });
    }
    if (path.endsWith('/settings')) return init.method === 'PATCH' ? new Response(null, { status: 204 }) : json({ settings: { theme: 'chalk' } });
    if (path.endsWith('/controls')) {
      if (init.method === 'PUT' || init.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ actions: [{ action: 'pause', codes: ['KeyQ'] }] });
    }
    return new Response(null, { status: 404 });
  };
  const location = { hash, search: '', pathname: '/', hostname };
  const win = { location, history: { state: null, replaceState: (_s, _t, u) => { location.hash = u.includes('#') ? u.slice(u.indexOf('#')) : ''; } } };
  return { calls, sh: SDK.create({ window: win, fetch }), location };
}

test('launch token read + stripped; nickname from profile', async () => {
  const { sh, location } = setup('#game_token=' + JWT);
  const p = new Platform(sh);
  assert.deepEqual(await p.boot(), { hosted: true });
  assert.equal(p.gameSlug, 'marks-test');
  assert.equal(location.hash, '');
  assert.equal(await p.loadProfile(), 'Noughts');
  assert.equal(p.displayName(), 'Noughts');
  sh.signOut();
  assert.equal(p.hosted, false);
});

test('cloud save round-trips through game:<slug>', async () => {
  const { sh, calls } = setup('#game_token=' + JWT);
  const p = new Platform(sh);
  await p.boot();
  p.queueCloudSave({ version: 1, generation: 4 });
  await p.flushCloudSave();
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/api/v1/me/cloud-saves/' + encodeURIComponent('game:marks-test')));
  assert.equal(put.auth, 'Bearer ' + JWT);
  assert.equal((await p.loadCloudSave()).generation, 4);
  sh.signOut();
});

test('settings KV, controls overrides and rebinding persistence', async () => {
  const { sh, calls } = setup('#game_token=' + JWT);
  const p = new Platform(sh);
  await p.boot();
  assert.deepEqual(await p.loadPlatformSettings({ theme: 'slate' }), { theme: 'chalk' });
  p.pushSettings({ theme: 'chalk', camera: { angle: 'top' } });
  await new Promise((r) => setTimeout(r, 900));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith('/api/v1/games/marks-test/settings'));
  assert.deepEqual(JSON.parse(patch.body), { settings: { camera: { angle: 'top' } } });
  assert.deepEqual(await p.loadBindings(DEFAULTS), { pause: ['KeyQ'], undo: ['KeyU'] });
  p.saveBinding('undo', ['KeyZ']);
  p.resetBindings();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/controls')).body), { bindings: { undo: ['KeyZ'] } });
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/controls')));
  assert.match(p.inviteLink(), /game-invite\/u-12345678\/marks-test$/);
  sh.signOut();
});

test('standalone: no network calls', async () => {
  const { sh, calls } = setup('', 'example.com');
  const p = new Platform(sh);
  assert.equal((await p.boot()).hosted, false);
  assert.equal(p.canSignIn(), false);
  assert.equal(p.inviteLink(), null);
  assert.equal(await p.loadProfile(), null);
  assert.equal(await p.loadCloudSave(), null);
  p.queueCloudSave({});
  p.pushSettings({ theme: 'x' });
  assert.equal(await p.loadBindings(DEFAULTS), null);
  p.saveBinding('undo', ['KeyZ']);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(calls.length, 0);
});

test('sign-in offered on the platform host without a token', async () => {
  const { sh, calls } = setup('');
  const p = new Platform(sh);
  await p.boot();
  assert.equal(p.canSignIn(), true);
  assert.equal(calls.length, 0);
});
