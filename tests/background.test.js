'use strict';

// Runs extension/background.js (with config.js and lib/sheets.js pulled in through importScripts) in
// node:vm with mocked chrome.* and fetch: message routing, error messages, connect flow and the toolbar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const CODE = read('extension/background.js');
const plain = (value) => JSON.parse(JSON.stringify(value)); // objects from the vm realm

function area(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => {
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) return { ...keys, ...data };
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (values) => { Object.assign(data, values); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

/** routes: [[method, urlPattern, handler]] answering Google API calls; a handler may return { status, body }. */
function makeEnv({ local = { spreadsheetId: 'sheet-1' }, sync = {}, routes = [], tabsWork = false } = {}) {
  const calls = { fetch: [], tabMessages: [], injected: [], badge: [], options: 0, auth: [], alarms: [] };
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const chrome = {
    runtime: {
      onInstalled: on('installed'),
      onStartup: on('startup'),
      onMessage: on('message'),
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' },
      openOptionsPage: async () => { calls.options++; },
    },
    action: {
      onClicked: on('clicked'),
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async (details) => { calls.badge.push(details); },
      setTitle: async () => {},
    },
    alarms: {
      onAlarm: on('alarm'),
      create: (name, info) => { calls.alarms.push([name, info]); },
    },
    identity: {
      getAuthToken: async (details) => { calls.auth.push(details); return { token: 'tok' }; },
      removeCachedAuthToken: async () => {},
      clearAllCachedAuthTokens: async () => {},
    },
    storage: { local: area(local), session: area(), sync: area(sync) },
    tabs: {
      sendMessage: async (tabId, message) => {
        calls.tabMessages.push(message);
        if (!tabsWork) throw new Error('No receiver');
      },
    },
    scripting: { executeScript: async (details) => { calls.injected.push(details); throw new Error('Cannot access a chrome:// URL'); } },
  };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.fetch.push({ url: String(url), method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const route = routes.find(([m, pattern]) => m === method && pattern.test(String(url)));
    if (!route) throw new Error(`Unexpected ${method} ${url}`);
    const out = await route[2](String(url));
    const status = out && out.status ? out.status : 200;
    const payload = out && out.status ? out.body : out;
    return { ok: status < 300, status, json: async () => payload };
  };
  const ctx = {
    chrome, fetch, URL, URLSearchParams, AbortSignal, console, Date,
    navigator: { userAgentData: { brands: [{ brand: 'Google Chrome' }] } },
  };
  ctx.importScripts = (...files) => {
    for (const file of files) vm.runInContext(read(`extension/${file}`), ctx, { filename: file });
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'background.js' });

  /** Sends a runtime message the way a content script or the options page would. */
  const send = (message) => new Promise((resolve) => {
    const keptOpen = listeners.message(message, {}, resolve);
    assert.equal(keptOpen, true, 'async handlers keep the channel open');
  }).then(plain);
  return { calls, listeners, send, chrome };
}

const SHEET_PROPS = ['GET', /\?fields=sheets\.properties/, () => ({ sheets: [{ properties: { sheetId: 0, title: 'Applications', gridProperties: { rowCount: 1001 } } }] })];

test('saving and duplicate lookups need a connected sheet', async () => {
  const env = makeEnv({ local: {} });
  const res = await env.send({ type: 'check-duplicate', url: 'https://acme.com/jobs/1' });
  assert.deepEqual(res, { ok: false, error: 'NOT_CONNECTED', message: 'Connect Google Sheets in Settings first.', detail: '' });
  assert.equal(env.calls.fetch.length, 0);
});

test('add-job and check-duplicate reply with the sheet results', async () => {
  const env = makeEnv({
    routes: [
      SHEET_PROPS,
      ['POST', /:append\?/, () => ({ updates: { updatedRange: 'Applications!A5:L5' } })],
      ['GET', /values\/Applications!J2%3AJ$/, () => ({ values: [] })],
    ],
  });
  assert.deepEqual(
    await env.send({ type: 'add-job', job: { company: 'Acme', url: 'https://acme.com/jobs/1' } }),
    { ok: true, row: 5, sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0&range=A5' },
  );
  assert.deepEqual(await env.send({ type: 'check-duplicate', url: 'https://acme.com/jobs/2' }), { ok: true, found: false });
  assert.equal(env.calls.auth.every((a) => a.interactive === false), true, 'no consent screen from the panel');
});

test('errors map to friendly messages', async () => {
  const gone = makeEnv({ routes: [['GET', /\?fields=sheets/, () => ({ status: 404, body: { error: { message: 'Requested entity was not found.' } } })]] });
  const res = await gone.send({ type: 'add-job', job: { company: 'Acme', url: 'https://acme.com/jobs/1' } });
  assert.equal(res.error, 'SHEET_GONE');
  assert.match(res.message, /Reconnect/);
  assert.equal(res.detail, 'Requested entity was not found.');

  const invalid = await makeEnv().send({ type: 'add-job', job: { company: 'Acme', url: 'nope' } });
  assert.equal(invalid.error, 'BAD_REQUEST');
  assert.equal(invalid.message, 'The job data was rejected. Job link must be a valid http(s) URL.');

  const broken = makeEnv();
  broken.chrome.storage.local.get = async () => { throw new Error('boom'); };
  assert.equal((await broken.send({ type: 'status' })).error, 'INTERNAL');
});

test('connect offers an existing tracker after interactive sign-in', async () => {
  const env = makeEnv({ local: {}, routes: [['GET', /\/drive\/v3\/files\?/, () => ({ files: [{ id: 'old-1', name: 'Job Applications Tracker' }] })]] });
  const res = await env.send({ type: 'connect' });
  assert.deepEqual(res, { ok: true, existing: { id: 'old-1', name: 'Job Applications Tracker', url: 'https://docs.google.com/spreadsheets/d/old-1/edit' } });
  assert.equal(env.calls.auth[0].interactive, true);
  assert.equal(env.chrome.storage.local.data.spreadsheetId, undefined, 'nothing stored until the user picks');

  const use = makeEnv({ local: {}, routes: [['GET', /\/drive\/v3\/files\/old-1\?/, () => ({ name: 'Job Applications Tracker', trashed: false })]] });
  assert.equal((await use.send({ type: 'use-sheet', id: 'old-1' })).sheet.id, 'old-1');
  assert.equal(use.chrome.storage.local.data.spreadsheetId, 'old-1');
  assert.equal((await use.send({ type: 'use-sheet', id: '../evil' })).error, 'BAD_REQUEST');
});

test('connect creates a tracker when none exists and clears the old Apps Script settings', async () => {
  const env = makeEnv({
    local: {},
    sync: { webAppUrl: 'https://script.google.com/macros/s/x/exec', secret: 'pw', buttonMode: 'never' },
    routes: [
      ['GET', /\/drive\/v3\/files\?/, () => ({ files: [] })],
      ['POST', /\/v4\/spreadsheets$/, () => ({ spreadsheetId: 'new-1' })],
      ['POST', /new-1:batchUpdate$/, () => ({})],
      ['PATCH', /\/drive\/v3\/files\/new-1/, () => ({})],
    ],
  });
  const res = await env.send({ type: 'connect' });
  assert.deepEqual(res, { ok: true, sheet: { id: 'new-1', name: 'Job Applications Tracker', url: 'https://docs.google.com/spreadsheets/d/new-1/edit' } });
  assert.equal(env.chrome.storage.local.data.spreadsheetId, 'new-1');
  assert.deepEqual(env.chrome.storage.sync.data, { buttonMode: 'never' });
});

test('status and disconnect', async () => {
  assert.deepEqual(await makeEnv({ local: {} }).send({ type: 'status' }), { ok: true, connected: false });

  const env = makeEnv({
    local: { spreadsheetId: 'sheet-1', statusSnapshot: { a: 'Applied' } },
    routes: [
      ['GET', /\/drive\/v3\/files\/sheet-1\?/, () => ({ name: 'My tracker', trashed: false })],
      ['POST', /revoke$/, () => ({})],
    ],
  });
  assert.deepEqual(await env.send({ type: 'status' }), { ok: true, connected: true, sheet: { id: 'sheet-1', name: 'My tracker', url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit' } });
  assert.deepEqual(await env.send({ type: 'disconnect' }), { ok: true });
  assert.deepEqual(env.chrome.storage.local.data, {});
  assert.ok(env.calls.fetch.some((c) => /oauth2\.googleapis\.com\/revoke$/.test(c.url)), 'token revoked');
});

test('unknown messages are not answered', () => {
  const env = makeEnv();
  assert.equal(env.listeners.message({ type: 'nope' }, {}, () => {}), false);
  assert.equal(env.listeners.message(undefined, {}, () => {}), false);
});

test('toolbar click: options page when not connected, badge on pages that cannot be scripted', async () => {
  const unconnected = makeEnv({ local: {} });
  await unconnected.listeners.clicked({ id: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unconnected.calls.options, 1);

  const env = makeEnv();
  env.listeners.clicked({ id: 7, url: 'chrome://settings' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(env.calls.injected.length, 1, 'tried to inject the content scripts');
  assert.deepEqual([...env.calls.injected[0].files], ['content/extract.js', 'content/ui.js']);
  assert.deepEqual(plain(env.calls.badge), [{ tabId: 7, text: '!' }]);
});

test('the daily upkeep alarm is scheduled on install and startup and runs the upkeep', async () => {
  const env = makeEnv({
    local: { spreadsheetId: 'sheet-1', statusSnapshot: {} },
    sync: { autoGhost: false, ghostAfterDays: 'x' },
    routes: [['GET', /values\/Applications!A2%3AL\?/, () => ({ values: [] })]],
  });
  env.listeners.installed({ reason: 'update' });
  env.listeners.startup();
  assert.deepEqual(plain(env.calls.alarms), [
    ['daily-upkeep', { delayInMinutes: 1, periodInMinutes: 1440 }],
    ['daily-upkeep', { delayInMinutes: 1, periodInMinutes: 1440 }],
  ]);
  assert.equal(env.calls.options, 0, 'options page only opens on first install');

  await env.listeners.alarm({ name: 'something-else' });
  assert.equal(env.calls.fetch.length, 0);
  await env.listeners.alarm({ name: 'daily-upkeep' });
  assert.equal(env.calls.fetch.length, 1, 'read the sheet');

  const offline = makeEnv({ routes: [] });
  await offline.listeners.alarm({ name: 'daily-upkeep' }); // errors are swallowed
});

test('every code sheets.js can raise has a message', () => {
  const sheets = read('extension/lib/sheets.js');
  const codes = new Set([...sheets.matchAll(/SheetsError\('([A-Z_]+)'/g), ...sheets.matchAll(/return '([A-Z_]+)';/g)].map((m) => m[1]));
  assert.deepEqual([...codes].sort(), ['BAD_REQUEST', 'BUSY', 'GOOGLE_ERROR', 'NETWORK', 'NOT_CONNECTED', 'SETUP_REQUIRED', 'SHEET_GONE', 'SIGNED_OUT']);
  for (const code of codes) assert.match(CODE, new RegExp(`\\b${code}: ['"]`), `${code} message in background.js`);
});
