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

function mount(store = {}, pingReply = { ok: true, setup: true, sheetName: 'Job Hunt', rows: 3 }) {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://abc/options/options.html', runScripts: 'outside-only' });
  const w = dom.window;
  const env = { w, d: w.document, store: { webAppUrl: '', secret: '', buttonMode: 'auto', hiddenSites: [], ...store }, pings: [] };
  w.chrome = {
    storage: {
      sync: { get: async (defaults) => ({ ...defaults, ...env.store }), set: async (values) => { Object.assign(env.store, values); } },
      onChanged: { addListener() {} },
    },
    runtime: { sendMessage: async (message) => { env.pings.push(message); return pingReply; } },
    commands: { getAll: async () => [{ name: '_execute_action', shortcut: 'Alt+Shift+K' }] },
    tabs: { create: async () => {} },
  };
  w.eval(SCRIPT);
  env.$ = (id) => env.d.getElementById(id);
  env.status = () => env.$('connection-status').textContent;
  return env;
}

test('every input has a label', () => {
  const { d } = mount();
  for (const input of d.querySelectorAll('input')) {
    assert.ok(input.labels.length > 0, `${input.id || input.name} has a label`);
  }
});

test('loads saved settings, hidden sites and the current shortcut', async () => {
  const env = mount({ buttonMode: 'always', hiddenSites: ['b.com', 'a.com'] });
  await tick();
  assert.equal(env.d.querySelector('input[name=buttonMode]:checked').value, 'always');
  assert.deepEqual([...env.d.querySelectorAll('#hidden-sites code')].map((c) => c.textContent), ['a.com', 'b.com']);
  assert.equal(env.$('shortcut').textContent, 'Alt+Shift+K');
});

test('rejects anything but a deployed /exec Web App URL', async () => {
  const env = mount();
  await tick();
  for (const [value, message] of [
    ['https://script.google.com/macros/s/AKfy_123/dev', /\/dev test URL/],
    ['https://evil.example/macros/s/AKfy_123/exec', /looks like https:\/\/script\.google\.com/],
    ['https://script.google.com/macros/s/AKfy_123/exec?x=1', /looks like/],
  ]) {
    env.$('web-app-url').value = value;
    env.$('test-connection').click();
    await tick();
    assert.match(env.status(), message, value);
    assert.equal(env.$('web-app-url').getAttribute('aria-invalid'), 'true');
  }
  assert.equal(env.pings.length, 0, 'nothing was sent');
  assert.equal(env.store.webAppUrl, '');
});

test('a successful test connection saves the settings', async () => {
  const env = mount();
  await tick();
  env.$('web-app-url').value = ' https://script.google.com/macros/s/AKfy_123/exec ';
  env.$('secret').value = 'pw';
  env.$('test-connection').click();
  await tick();
  assert.equal(env.status(), '✓ Connected to “Job Hunt” · 3 jobs saved. Settings saved.');
  assert.equal(env.pings[0].webAppUrl, 'https://script.google.com/macros/s/AKfy_123/exec');
  assert.equal(env.store.webAppUrl, 'https://script.google.com/macros/s/AKfy_123/exec');
  assert.equal(env.store.secret, 'pw');
});

test('a sheet that is not set up gets a warning with the fix', async () => {
  const env = mount({}, { ok: true, setup: false, sheetName: 'Job Hunt', rows: 0 });
  await tick();
  env.$('web-app-url').value = 'https://script.google.com/macros/s/AKfy_123/exec';
  env.$('test-connection').click();
  await tick();
  assert.match(env.status(), /isn't set up yet.*Job Tracker → Run setup/);
  assert.equal(env.$('connection-status').className, 'status warn');
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
