'use strict';

// Runs extension/content/ui.js inside jsdom with a small chrome.* mock. The closed shadow root is
// captured by wrapping attachShadow, so the tests can drive the panel like a user would.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const EXTRACT = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'extract.js'), 'utf8');
const UI = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'ui.js'), 'utf8');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function mount({ html = fixture('greenhouse.html'), url = 'https://job-boards.greenhouse.io/acmerobotics/jobs/4567890', settings = {}, fastTimers = false } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const storage = { webAppUrl: 'https://script.google.com/macros/s/x/exec', buttonMode: 'auto', hiddenSites: [], ...settings };
  const sent = [];
  const env = { w, storage, sent, shadows: [], onMessage: [], replies: {} };
  env.replies['check-duplicate'] = { ok: true, found: false };
  env.replies['add-job'] = { ok: true, row: 7, sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit#gid=0&range=A7' };

  w.chrome = {
    runtime: {
      id: 'ext-id',
      sendMessage: async (message) => {
        sent.push(message);
        return env.replies[message.type];
      },
      onMessage: { addListener: (fn) => env.onMessage.push(fn) },
    },
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...storage }),
        set: async (values) => { Object.assign(storage, values); },
      },
      onChanged: { addListener() {} },
    },
  };
  if (fastTimers) {
    w.setTimeout = (fn) => setTimeout(fn, 0);
    w.clearTimeout = (id) => clearTimeout(id);
  }
  const attachShadow = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) {
    const root = attachShadow.call(this, options);
    env.shadows.push(root);
    return root;
  };
  w.eval(EXTRACT);
  env.detections = 0;
  const isLikelyJobPage = w.JobExtract.isLikelyJobPage;
  w.JobExtract.isLikelyJobPage = (...args) => {
    env.detections++;
    return isLikelyJobPage(...args);
  };
  env.inject = () => w.eval(UI);
  env.inject();
  env.$ = (selector) => env.shadows[env.shadows.length - 1].querySelector(selector);
  env.field = (name) => env.$('form').elements.namedItem(name);
  env.openPanel = () => env.onMessage[env.onMessage.length - 1]({ type: 'open-panel' }, {}, () => {});
  env.hosts = () => w.document.querySelectorAll('#job-tracker-ext-root').length;
  return env;
}

test('panel opens pre-filled, warns about duplicates and saves', async () => {
  const env = mount();
  env.replies['check-duplicate'] = { ok: true, found: true, appliedDate: '01 Oct 2026', status: 'Interview' };
  await tick();
  assert.equal(env.$('.tab').hidden, false, 'tab shown on a job page');

  env.openPanel();
  await tick();
  assert.equal(env.$('.panel').hidden, false);
  assert.equal(env.$('.tab').hidden, true, 'tab hidden while the panel is open');
  assert.equal(env.field('role').value, 'Robotics Software Engineer');
  assert.equal(env.field('url').value, 'https://job-boards.greenhouse.io/acmerobotics/jobs/4567890');
  assert.match(env.$('.duplicate').textContent, /Already saved on 01 Oct 2026, status Interview/);

  env.field('company').value = '';
  env.field('role').value = '';
  env.$('form').requestSubmit();
  assert.equal(env.$('.hint[data-for="name"]').hidden, false, 'validation message shown');
  assert.equal(env.sent.some((m) => m.type === 'add-job'), false, 'nothing sent when invalid');

  env.field('company').value = 'Acme';
  env.field('url').value = 'javascript:alert(1)';
  env.$('form').requestSubmit();
  assert.equal(env.$('.hint[data-for="url"]').hidden, false, 'non-http links are rejected');

  env.field('url').value = 'https://acme.com/jobs/1';
  env.$('form').requestSubmit();
  await tick();
  assert.equal(env.sent.find((m) => m.type === 'add-job').job.company, 'Acme');
  assert.equal(env.$('.success').hidden, false);
  assert.equal(env.$('.row-number').textContent, '7');
  assert.equal(env.$('.open-sheet').href, 'https://docs.google.com/spreadsheets/d/x/edit#gid=0&range=A7');
});

test('errors from the service worker are shown and only Google Sheets links are offered', async () => {
  const env = mount();
  env.replies['check-duplicate'] = { ok: false, error: 'BAD_TOKEN', message: "The secret doesn't match." };
  env.replies['add-job'] = { ok: true, row: 3, sheetUrl: 'https://evil.example/' };
  await tick();
  env.openPanel();
  await tick();
  assert.equal(env.$('.banner.error').hidden, false);
  assert.equal(env.$('.error-text').textContent, "The secret doesn't match.");
  env.$('form').requestSubmit();
  await tick();
  assert.equal(env.$('.open-sheet').hidden, true);
});

test('Esc closes the panel, keys stay inside it and focus returns to the opener', async () => {
  const env = mount();
  await tick();
  const leaked = [];
  for (const type of ['keydown', 'keyup', 'focusin']) env.w.document.addEventListener(type, () => leaked.push(type));

  env.$('.tab-open').focus();
  env.$('.tab-open').click();
  await tick();
  assert.equal(env.shadows[0].activeElement, env.field('company'), 'focus moves into the panel');
  assert.deepEqual(leaked, [], 'focus moving into the panel is not reported to the page');

  env.field('company').dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'j', bubbles: true, composed: true }));
  env.field('company').dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
  assert.deepEqual(leaked, [], 'page listeners never see the keys');
  assert.equal(env.$('.panel').hidden, true, 'Esc closed the panel');
  assert.equal(env.shadows[0].activeElement, env.$('.tab-open'), 'focus is back on the tab');
});

test('a late save reply is ignored after the panel was closed', async () => {
  const env = mount();
  let resolveSave;
  env.w.chrome.runtime.sendMessage = (message) => (message.type === 'add-job'
    ? new Promise((resolve) => { resolveSave = resolve; })
    : Promise.resolve({ ok: true, found: false }));
  await tick();
  env.openPanel();
  env.$('form').requestSubmit();
  env.$('.cancel').click();
  env.openPanel();
  resolveSave({ ok: true, row: 9, sheetUrl: '' });
  await tick();
  assert.equal(env.$('.success').hidden, true, 'the reopened panel still shows the form');
  assert.equal(env.$('.save').disabled, false);
});

test('the × hides the tab on this site and remembers it', async () => {
  const env = mount();
  await tick();
  env.$('.tab-hide').click();
  await tick();
  assert.deepEqual([...env.storage.hiddenSites], ['job-boards.greenhouse.io']);
  assert.equal(env.$('.tab').hidden, true);
});

test('a second injection does not create a second UI, and an orphaned copy is replaced', async () => {
  const env = mount();
  await tick();
  env.inject();
  await tick();
  assert.equal(env.hosts(), 1);
  assert.equal(env.shadows.length, 1, 'the live copy kept running and the newcomer stopped');

  Object.defineProperty(env.w.chrome.runtime, 'id', { value: undefined, configurable: true }); // extension reloaded
  env.inject(); // the orphan tears down; this copy would normally get a fresh chrome.runtime
  Object.defineProperty(env.w.chrome.runtime, 'id', { value: 'ext-id', configurable: true });
  env.inject();
  await tick();
  assert.equal(env.hosts(), 1);
  assert.equal(env.shadows.length, 2, 'a fresh copy took over');
});

test('detection is skipped outside auto mode and capped per URL', async () => {
  const never = mount({ settings: { buttonMode: 'never' }, fastTimers: true });
  await tick();
  for (let i = 0; i < 5; i++) {
    never.w.document.body.append(never.w.document.createElement('p'));
    await tick(5);
  }
  assert.equal(never.detections, 0, 'never mode does no detection work');
  assert.equal(never.$('.tab').hidden, true);

  const html = fixture('not-a-job.html');
  const page = mount({ html, url: 'https://acme.dev/careers-blog/how-we-hire', fastTimers: true });
  await tick();
  for (let i = 0; i < 30; i++) {
    page.w.document.body.append(page.w.document.createElement('p'));
    await tick(5);
  }
  assert.ok(page.detections <= 10, `checked ${page.detections} times for one URL`);
  const before = page.detections;
  page.w.history.pushState({}, '', '/careers-blog/other-post');
  page.w.document.body.append(page.w.document.createElement('p'));
  await tick(5);
  assert.equal(page.detections, before + 1, 'a new URL is checked again');
});

test('always mode shows the tab without running detection', async () => {
  const env = mount({ html: fixture('not-a-job.html'), url: 'https://acme.dev/blog/x', settings: { buttonMode: 'always' } });
  await tick();
  assert.equal(env.$('.tab').hidden, false);
  assert.equal(env.detections, 0);
});
