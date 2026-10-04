'use strict';

// Runs the options page in jsdom with a chrome.* mock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..', 'extension', 'options');
const HTML = fs.readFileSync(path.join(DIR, 'options.html'), 'utf8').replace('<script src="options.js"></script>', '');
const SCRIPT = fs.readFileSync(path.join(DIR, 'options.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const SHEET = { id: 'abc', name: 'Job Applications Tracker', url: 'https://docs.google.com/spreadsheets/d/abc/edit' };

/** replies: message type → reply object (or a function of the message). */
function mount(store = {}, replies = {}) {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://abc/options/options.html', runScripts: 'outside-only' });
  const w = dom.window;
  const env = {
    w,
    d: w.document,
    store: { buttonMode: 'auto', hiddenSites: [], ...store },
    sent: [],
    replies: { status: { ok: true, connected: false }, ...replies },
  };
  w.chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...env.store }),
        set: async (values) => { Object.assign(env.store, values); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete env.store[k]; },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: async (message) => {
        env.sent.push(message);
        const reply = env.replies[message.type];
        return typeof reply === 'function' ? reply(message) : reply;
      },
    },
    commands: { getAll: async () => [{ name: '_execute_action', shortcut: 'Alt+Shift+K' }] },
    tabs: { create: async () => {} },
  };
  w.eval(SCRIPT);
  env.$ = (id) => env.d.getElementById(id);
  env.status = () => env.$('connection-status').textContent;
  env.visible = () => ['state-disconnected', 'state-choose', 'state-connected'].filter((id) => !env.$(id).hidden);
  return env;
}

test('every input has a label', () => {
  const { d } = mount();
  for (const input of d.querySelectorAll('input')) {
    assert.ok(input.labels.length > 0, `${input.id || input.name} has a label`);
  }
});

test('loads saved settings, hidden sites and the current shortcut', async () => {
  const env = mount({ buttonMode: 'always', hiddenSites: ['b.com', 'a.com'], autoGhost: false, ghostAfterDays: 45 });
  await tick();
  assert.equal(env.d.querySelector('input[name=buttonMode]:checked').value, 'always');
  assert.deepEqual([...env.d.querySelectorAll('#hidden-sites code')].map((c) => c.textContent), ['a.com', 'b.com']);
  assert.equal(env.$('shortcut').textContent, 'Alt+Shift+K');
  assert.equal(env.$('auto-ghost').checked, false);
  assert.equal(env.$('ghost-days').value, '45');
});

test('not connected: one Connect Google Sheets button', async () => {
  const env = mount();
  await tick();
  assert.deepEqual(env.visible(), ['state-disconnected']);
  assert.equal(env.$('connect').textContent, 'Connect Google Sheets');
  assert.equal(env.$('legacy-notice').hidden, true);
});

test('connect creates a sheet when none exists and shows it', async () => {
  const env = mount({}, { connect: { ok: true, sheet: SHEET } });
  await tick();
  env.$('connect').click();
  await tick();
  assert.deepEqual(env.visible(), ['state-connected']);
  assert.equal(env.$('sheet-name').textContent, 'Job Applications Tracker');
  assert.equal(env.$('open-sheet').href, SHEET.url);
  assert.match(env.status(), /Created “Job Applications Tracker” in your Google Drive/);
});

test('connect offers an existing tracker: use it or create a new one', async () => {
  const existing = { id: 'old-1', name: 'My old tracker', url: 'https://docs.google.com/spreadsheets/d/old-1/edit' };
  const env = mount({}, {
    'connect': { ok: true, existing },
    'use-sheet': (m) => ({ ok: true, sheet: { ...existing, id: m.id } }),
    'create-sheet': { ok: true, sheet: SHEET },
  });
  await tick();
  env.$('connect').click();
  await tick();
  assert.deepEqual(env.visible(), ['state-choose']);
  assert.equal(env.$('existing-name').textContent, 'My old tracker');

  env.$('use-existing').click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(env.sent.at(-1))), { type: 'use-sheet', id: 'old-1' });
  assert.deepEqual(env.visible(), ['state-connected']);
  assert.equal(env.$('sheet-name').textContent, 'My old tracker');

  const fresh = mount({}, { 'connect': { ok: true, existing }, 'create-sheet': { ok: true, sheet: SHEET } });
  await tick();
  fresh.$('connect').click();
  await tick();
  fresh.$('create-new').click();
  await tick();
  assert.equal(fresh.sent.at(-1).type, 'create-sheet');
  assert.equal(fresh.$('sheet-name').textContent, 'Job Applications Tracker');
});

test('connected: open sheet link and disconnect', async () => {
  const env = mount({}, { status: { ok: true, connected: true, sheet: SHEET }, disconnect: { ok: true } });
  await tick();
  assert.deepEqual(env.visible(), ['state-connected']);
  assert.match(env.$('state-connected').textContent, /✓ Connected to Job Applications Tracker/);
  env.$('disconnect').click();
  await tick();
  assert.equal(env.sent.at(-1).type, 'disconnect');
  assert.deepEqual(env.visible(), ['state-disconnected']);
  assert.match(env.status(), /Disconnected/);
});

test('a deleted sheet asks the user to reconnect', async () => {
  const env = mount({}, { status: { ok: false, error: 'SHEET_GONE', message: "Can't open your tracker sheet. Open Settings and click Reconnect.", detail: 'Requested entity was not found.' } });
  await tick();
  assert.deepEqual(env.visible(), ['state-disconnected']);
  assert.equal(env.$('connect').textContent, 'Reconnect');
  assert.match(env.status(), /Can't open your tracker sheet.*Google said: Requested entity was not found\./);
  assert.equal(env.$('connection-status').className, 'status error');
});

test('a cancelled sign-in shows the error and keeps the button', async () => {
  const env = mount({}, { connect: { ok: false, error: 'SIGNED_OUT', message: 'Google sign-in is needed.', detail: 'The user did not approve access.' } });
  await tick();
  env.$('connect').click();
  await tick();
  assert.match(env.status(), /sign-in is needed.*did not approve/);
  assert.equal(env.$('connect').disabled, false);
});

test('old Apps Script settings show a one-time notice and are removed', async () => {
  const env = mount({ webAppUrl: 'https://script.google.com/macros/s/x/exec', secret: 'pw' });
  await tick();
  assert.equal(env.$('legacy-notice').hidden, false);
  assert.match(env.$('legacy-notice').textContent, /Connect Google Sheets/);
  assert.equal('webAppUrl' in env.store, false);
  assert.equal('secret' in env.store, false);

  const again = mount(env.store);
  await tick();
  assert.equal(again.$('legacy-notice').hidden, true, 'shown only once');
});

test('auto-ghost settings save on change and reject bad day counts', async () => {
  const env = mount();
  await tick();
  assert.equal(env.$('auto-ghost').checked, true, 'on by default');
  assert.equal(env.$('ghost-days').value, '30');

  env.$('ghost-days').value = '14';
  env.$('ghost-days').dispatchEvent(new env.w.Event('change'));
  await tick();
  assert.equal(env.store.ghostAfterDays, 14);

  env.$('auto-ghost').checked = false;
  env.$('auto-ghost').dispatchEvent(new env.w.Event('change'));
  await tick();
  assert.equal(env.store.autoGhost, false);

  env.$('ghost-days').value = '0';
  env.$('ghost-days').dispatchEvent(new env.w.Event('change'));
  await tick();
  assert.equal(env.store.ghostAfterDays, 14, 'invalid value not saved');
  assert.equal(env.$('ghost-days').getAttribute('aria-invalid'), 'true');
});

test('button mode and hidden sites save immediately', async () => {
  const env = mount({ hiddenSites: ['a.com', 'b.com'] });
  await tick();
  env.d.querySelector('#hidden-sites button').click();
  await tick();
  assert.deepEqual([...env.store.hiddenSites], ['b.com']);
  const never = env.d.querySelector('input[value=never]');
  never.checked = true;
  never.dispatchEvent(new env.w.Event('change', { bubbles: true }));
  await tick();
  assert.equal(env.store.buttonMode, 'never');
});
