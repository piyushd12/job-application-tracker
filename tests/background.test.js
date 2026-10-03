'use strict';

// Runs extension/background.js in node:vm with mocked chrome.* and fetch, to check the Web App
// client: where the token goes, how replies map to error codes, and the toolbar fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const CODE = read('extension/background.js');
const WEB_APP = 'https://script.google.com/macros/s/AKfycbx_abc-123/exec';
const plain = (value) => JSON.parse(JSON.stringify(value)); // objects from the vm realm

function makeEnv({ settings = { webAppUrl: WEB_APP, secret: 's3cret' }, fetch } = {}) {
  const calls = { fetch: [], tabMessages: [], injected: [], badge: [], options: 0 };
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const chrome = {
    runtime: {
      onInstalled: on('installed'),
      onMessage: on('message'),
      OnInstalledReason: { INSTALL: 'install' },
      openOptionsPage: async () => { calls.options++; },
    },
    action: {
      onClicked: on('clicked'),
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async (details) => { calls.badge.push(details); },
      setTitle: async () => {},
    },
    storage: { sync: { get: async (defaults) => ({ ...defaults, ...settings }) } },
    tabs: { sendMessage: async (tabId, message) => { calls.tabMessages.push(message); throw new Error('No receiver'); } },
    scripting: { executeScript: async (details) => { calls.injected.push(details); throw new Error('Cannot access a chrome:// URL'); } },
  };
  const ctx = {
    chrome,
    URL,
    AbortSignal,
    console,
    fetch: async (url, init) => {
      calls.fetch.push({ url: String(url), init });
      return fetch(String(url), init);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'background.js' });

  /** Sends a runtime message the way a content script or the options page would. */
  const send = (message) => new Promise((resolve) => {
    const keptOpen = listeners.message(message, {}, resolve);
    assert.equal(keptOpen, true, 'async handlers keep the channel open');
  });
  return { calls, listeners, send };
}

const json = (body, url = 'https://script.googleusercontent.com/macros/echo?user_content_key=x') => ({
  type: 'basic', url, text: async () => JSON.stringify(body),
});

test('GET requests carry the action, url and token to the configured Web App only', async () => {
  const env = makeEnv({ fetch: async () => json({ ok: true, found: false }) });
  assert.deepEqual(plain(await env.send({ type: 'check-duplicate', url: 'https://acme.com/jobs/1' })), { ok: true, found: false });
  const { url, init } = env.calls.fetch[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, WEB_APP);
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { action: 'check', url: 'https://acme.com/jobs/1', token: 's3cret' });
  assert.equal(init.credentials, 'omit');
});

test('POST sends the job as text/plain with the token in the body', async () => {
  const env = makeEnv({ fetch: async () => json({ ok: true, row: 5, sheetUrl: 'https://docs.google.com/x' }) });
  const res = await env.send({ type: 'add-job', job: { company: 'Acme' } });
  assert.equal(res.row, 5);
  const { url, init } = env.calls.fetch[0];
  assert.equal(url, WEB_APP, 'no token in the URL');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(init.body), { action: 'add', job: { company: 'Acme' }, token: 's3cret' });
});

test('URLs that are not a Web App /exec link are never called', async () => {
  for (const webAppUrl of [
    '',
    'https://evil.example/macros/s/abc/exec',
    'https://script.google.com/macros/s/abc/dev',
    'https://script.google.com/home',
    'http://script.google.com/macros/s/abc/exec',
    'https://script.google.com.evil.example/macros/s/abc/exec',
  ]) {
    const env = makeEnv({ settings: { webAppUrl, secret: 's3cret' }, fetch: async () => json({ ok: true }) });
    const res = await env.send({ type: 'check-duplicate', url: 'https://acme.com/jobs/1' });
    assert.equal(res.error, 'NOT_CONFIGURED', webAppUrl);
    assert.equal(env.calls.fetch.length, 0, webAppUrl);
  }
  const workspace = makeEnv({
    settings: { webAppUrl: 'https://script.google.com/a/macros/acme.com/s/abc/exec' },
    fetch: async () => json({ ok: true, version: 1, setup: true, sheetName: 'Jobs', rows: 0 }),
  });
  assert.equal((await workspace.send({ type: 'ping', webAppUrl: 'https://script.google.com/a/macros/acme.com/s/abc/exec' })).ok, true);
});

test('replies map to the documented error codes and messages', async () => {
  const cases = [
    [async () => json({ ok: false, error: 'BAD_TOKEN' }), 'BAD_TOKEN', /secret/i],
    [async () => json({ ok: false, error: 'BAD_REQUEST', message: 'Missing url.' }), 'BAD_REQUEST', /rejected\. Missing url\.$/],
    [async () => json({ ok: false, error: 'SOMETHING_NEW' }), 'INTERNAL', /Executions/],
    [async () => json({ hello: 'world' }), 'BAD_RESPONSE', /\/exec/],
    [async () => ({ type: 'basic', url: WEB_APP, text: async () => 'not json' }), 'BAD_RESPONSE', /\/exec/],
    [async () => ({ type: 'basic', url: 'https://accounts.google.com/v3/signin', text: async () => '<html>' }), 'NOT_PUBLIC', /Anyone/],
    [async () => ({ type: 'basic', url: WEB_APP, text: async () => '<!doctype html><a href="https://accounts.google.com/ServiceLogin">' }), 'NOT_PUBLIC', /Anyone/],
  ];
  for (const [fetch, code, message] of cases) {
    const res = await makeEnv({ fetch }).send({ type: 'ping', webAppUrl: WEB_APP, secret: '' });
    assert.equal(res.ok, false);
    assert.equal(res.error, code);
    assert.match(res.message, message);
  }
});

test('a failed fetch is NOT_PUBLIC when the server redirects away, NETWORK otherwise', async () => {
  const redirecting = makeEnv({
    fetch: async (url, init) => {
      if (init.redirect === 'manual') return { type: 'opaqueredirect' };
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal((await redirecting.send({ type: 'ping', webAppUrl: WEB_APP })).error, 'NOT_PUBLIC');

  const offline = makeEnv({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal((await offline.send({ type: 'ping', webAppUrl: WEB_APP })).error, 'NETWORK');

  const slow = makeEnv({ fetch: async () => { throw new DOMException('timed out', 'TimeoutError'); } });
  assert.equal((await slow.send({ type: 'ping', webAppUrl: WEB_APP })).error, 'NETWORK');
  assert.equal(slow.calls.fetch.length, 1, 'no redirect probe after a timeout');
});

test('unknown messages are not answered', () => {
  const env = makeEnv();
  assert.equal(env.listeners.message({ type: 'nope' }, {}, () => {}), false);
  assert.equal(env.listeners.message(undefined, {}, () => {}), false);
});

test('toolbar click: options page when unconfigured, badge on pages that cannot be scripted', async () => {
  const unconfigured = makeEnv({ settings: { webAppUrl: '' } });
  await unconfigured.listeners.clicked({ id: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unconfigured.calls.options, 1);

  const env = makeEnv();
  env.listeners.clicked({ id: 7, url: 'chrome://settings' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(env.calls.injected.length, 1, 'tried to inject the content scripts');
  assert.deepEqual([...env.calls.injected[0].files], ['content/extract.js', 'content/ui.js']);
  assert.deepEqual(plain(env.calls.badge), [{ tabId: 7, text: '!' }]);
});

test('background.js and the options page validate the Web App URL the same way', () => {
  const regex = (source) => source.match(/const WEB_APP_URL_RE = (\/.+\/);/)[1];
  assert.equal(regex(CODE), regex(read('extension/options/options.js')));
});
