'use strict';

// Runs extension/config.js and extension/lib/sheets.js in node:vm with mocked chrome.*, navigator and fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const CONFIG_JS = read('extension/config.js');
const SHEETS_JS = read('extension/lib/sheets.js');
const plain = (value) => JSON.parse(JSON.stringify(value)); // objects from the vm realm
const ID = 'sheet-123';

function area(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => {
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (values) => { Object.assign(data, values); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

/**
 * routes: [[method, urlPattern, handler(url, body, init)]]; a handler returns a body (200),
 * or { status, body } to fail. Unmatched requests fail the test.
 */
function makeEnv({ routes = [], brand = 'Google Chrome', local = { spreadsheetId: ID }, session = {}, tokens = ['tok-1', 'tok-2'] } = {}) {
  const calls = { fetch: [], removed: [], authFlows: [] };
  let tokenIndex = 0;
  const chrome = {
    identity: {
      getAuthToken: async () => ({ token: tokens[Math.min(tokenIndex++, tokens.length - 1)] }),
      removeCachedAuthToken: async ({ token }) => { calls.removed.push(token); },
      clearAllCachedAuthTokens: async () => {},
      getRedirectURL: () => 'https://abcdefghijklmnop.chromiumapp.org/',
      launchWebAuthFlow: async (details) => {
        calls.authFlows.push(details);
        return 'https://abcdefghijklmnop.chromiumapp.org/#access_token=web-tok&token_type=Bearer&expires_in=3599';
      },
    },
    storage: { local: area(local), session: area(session) },
  };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.fetch.push({ url: String(url), method, body, init });
    const route = routes.find(([m, pattern]) => m === method && pattern.test(String(url)));
    if (!route) throw new Error(`Unexpected ${method} ${url}`);
    const out = await route[2](String(url), body, init);
    const status = out && out.status ? out.status : 200;
    const payload = out && out.status ? out.body : out;
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  const ctx = {
    chrome, fetch, URL, URLSearchParams, AbortSignal, console, Date,
    navigator: { userAgentData: { brands: [{ brand: 'Chromium' }, { brand }] } },
  };
  vm.createContext(ctx);
  vm.runInContext(CONFIG_JS + '\n' + SHEETS_JS, ctx, { filename: 'sheets.js' });
  const constant = (name) => vm.runInContext(name, ctx);
  return { ctx, calls, chrome, constant };
}

const SHEET_PROPS = [/\/v4\/spreadsheets\/sheet-123\?fields=sheets\.properties/, () => ({
  sheets: [{ properties: { sheetId: 0, title: 'Applications', gridProperties: { rowCount: 1001 } } }, { properties: { sheetId: 1, title: 'Summary', gridProperties: { rowCount: 1000 } } }],
})];

const JOB = {
  company: '=HYPERLINK("x")', role: 'Engineer', appliedDate: '2026-10-03', status: 'Interview', workMode: 'Remote',
  location: 'Pune', yoe: '2-5 yrs', salary: '', source: '', url: 'https://acme.com/jobs/1', notes: '@me',
};

// ----- Create ---------------------------------------------------------------

test('createTrackerSpreadsheet: create, ONE batchUpdate with the full layout, then tag the file', async () => {
  const env = makeEnv({
    routes: [
      ['POST', /\/v4\/spreadsheets$/, () => ({ spreadsheetId: 'new-1' })],
      ['POST', /\/v4\/spreadsheets\/new-1:batchUpdate$/, () => ({})],
      ['PATCH', /\/drive\/v3\/files\/new-1\?fields=id$/, () => ({ id: 'new-1' })],
    ],
  });
  const sheet = plain(await env.ctx.createTrackerSpreadsheet());
  assert.deepEqual(sheet, { id: 'new-1', name: 'Job Applications Tracker', url: 'https://docs.google.com/spreadsheets/d/new-1/edit' });
  assert.deepEqual(env.calls.fetch.map((c) => c.method), ['POST', 'POST', 'PATCH']);

  const [create, update, tag] = env.calls.fetch;
  assert.equal(create.body.properties.title, 'Job Applications Tracker');
  assert.deepEqual(create.body.sheets.map((s) => [s.properties.sheetId, s.properties.title]), [[0, 'Applications'], [1, 'Summary']]);
  assert.equal(create.body.sheets[0].properties.gridProperties.rowCount, 1001);
  assert.deepEqual(tag.body, { appProperties: { jobTracker: '1' } });
  assert.match(create.init.headers.Authorization, /^Bearer tok-1$/);

  const requests = update.body.requests;
  const kind = (name) => requests.filter((r) => r[name]).map((r) => r[name]);

  // Header row and frozen row
  const header = kind('updateCells').find((u) => u.start.sheetId === 0);
  assert.deepEqual(header.rows[0].values.map((v) => v.userEnteredValue.stringValue), plain(env.constant('HEADERS')));
  assert.ok(kind('updateSheetProperties').some((u) => u.properties.sheetId === 0 && u.properties.gridProperties.frozenRowCount === 1));
  assert.equal(kind('updateDimensionProperties').filter((u) => u.range.sheetId === 0 && u.range.dimension === 'COLUMNS').length, 12);

  // Dropdowns: Status and Work Mode, strict lists
  const validations = kind('setDataValidation');
  assert.deepEqual(validations.map((v) => v.range.startColumnIndex), [3, 4]);
  for (const v of validations) {
    assert.equal(v.rule.condition.type, 'ONE_OF_LIST');
    assert.equal(v.rule.strict, true);
    assert.equal(v.range.startRowIndex, 1, 'header row has no dropdown');
  }
  assert.deepEqual(validations[0].rule.condition.values.map((v) => v.userEnteredValue), plain(env.constant('STATUSES')));
  assert.deepEqual(validations[1].rule.condition.values.map((v) => v.userEnteredValue), ['On-site', 'Remote', 'Hybrid', 'N/A']);

  // Status colors
  const rules = kind('addConditionalFormatRule').map((r) => r.rule);
  assert.equal(rules.length, 8);
  const ghosted = rules.find((r) => r.booleanRule.condition.values[0].userEnteredValue === 'Ghosted');
  assert.equal(ghosted.booleanRule.condition.type, 'TEXT_EQ');
  assert.deepEqual(ghosted.ranges[0], { sheetId: 0, startRowIndex: 1, endRowIndex: 1001, startColumnIndex: 3, endColumnIndex: 4 });
  assert.deepEqual(plain(ghosted.booleanRule.format.backgroundColor), { red: 0x5f / 255, green: 0x63 / 255, blue: 0x68 / 255 });
  assert.deepEqual(plain(ghosted.booleanRule.format.textFormat.foregroundColor), { red: 1, green: 1, blue: 1 });

  // Formats: YOE as plain text, dates as dd mmm yyyy
  const formats = kind('repeatCell').filter((r) => r.range.sheetId === 0 && r.range.startRowIndex === 1);
  const formatOf = (col) => formats.find((r) => r.range.startColumnIndex === col).cell.userEnteredFormat.numberFormat;
  assert.deepEqual(plain(formatOf(6)), { type: 'TEXT' });
  assert.deepEqual(plain(formatOf(2)), { type: 'DATE', pattern: 'dd mmm yyyy' });
  assert.deepEqual(plain(formatOf(10)), { type: 'DATE', pattern: 'dd mmm yyyy' });

  // Filter over every pre-formatted row
  assert.deepEqual(kind('setBasicFilter')[0].filter.range, { sheetId: 0, startRowIndex: 0, endRowIndex: 1001, startColumnIndex: 0, endColumnIndex: 12 });

  // Summary formulas
  const summary = kind('updateCells').filter((u) => u.start.sheetId === 1);
  const cells = {};
  for (const block of summary) {
    block.rows.forEach((row, r) => row.values.forEach((v, c) => {
      cells[String.fromCharCode(65 + block.start.columnIndex + c) + (block.start.rowIndex + r + 1)] = v.userEnteredValue.formulaValue || v.userEnteredValue.stringValue;
    }));
  }
  assert.equal(cells.B2, `=COUNTA('Applications'!D2:D)-COUNTIF('Applications'!D2:D,"Saved")`);
  assert.equal(cells.B3, `=COUNTIFS('Applications'!C2:C,">="&(TODAY()-7),'Applications'!D2:D,"<>Saved")`);
  assert.match(cells.B5, /^=IFERROR\(\(COUNTIF\('Applications'!D2:D,"OA \/ Assessment"\)\+.*\)\/B2,0\)$/);
  assert.equal(cells.B7, `=COUNTIF('Applications'!D2:D,"Offer")`);
  assert.equal(cells.D9, 'Withdrawn');
  assert.equal(cells.F2, '=IFERROR(E2/SUM(E$2:E$9),0)');
  assert.match(cells.H2, /^=IFERROR\(QUERY\('Applications'!A2:L,"select I, count\(I\)/);
  assert.match(cells.H2, /,""\)$/, 'empty sheet shows nothing instead of #N/A');
});

test('findExistingTracker asks Drive for files tagged by this app only', async () => {
  const env = makeEnv({ routes: [['GET', /\/drive\/v3\/files\?/, () => ({ files: [{ id: 'old-1', name: 'Job Applications Tracker' }] })]] });
  assert.deepEqual(plain(await env.ctx.findExistingTracker()), { id: 'old-1', name: 'Job Applications Tracker', url: 'https://docs.google.com/spreadsheets/d/old-1/edit' });
  const q = new URL(env.calls.fetch[0].url).searchParams.get('q');
  assert.equal(q, "appProperties has { key='jobTracker' and value='1' } and trashed=false");

  const none = makeEnv({ routes: [['GET', /\/drive\/v3\/files\?/, () => ({ files: [] })]] });
  assert.equal(await none.ctx.findExistingTracker(), null);
});

// ----- Append ---------------------------------------------------------------

test('appendJob appends one USER_ENTERED row with the formula guard and returns its link', async () => {
  const env = makeEnv({
    routes: [['GET', ...SHEET_PROPS], ['POST', /:append\?/, () => ({ updates: { updatedRange: 'Applications!A42:L42' } })]],
  });
  assert.deepEqual(plain(await env.ctx.appendJob(JOB)), { row: 42, sheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0&range=A42` });
  const append = env.calls.fetch[1];
  const url = new URL(append.url);
  assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${ID}/values/Applications!A:L:append`);
  assert.equal(url.searchParams.get('valueInputOption'), 'USER_ENTERED');
  const [row] = append.body.values;
  assert.equal(row.length, 12);
  assert.equal(row[0], `'=HYPERLINK("x")`, 'formula neutralised');
  assert.equal(row[2], '2026-10-03');
  assert.equal(row[3], 'Interview');
  assert.equal(row[6], '2-5 yrs');
  assert.equal(row[8], 'Company Site');
  assert.match(row[10], /^\d{4}-\d{2}-\d{2}$/, 'Last Updated is today');
  assert.equal(row[11], "'@me");
  assert.equal(env.calls.fetch.length, 2, 'no top-up while plenty of rows are free');
});

test('appendJob validates the job and falls back to today and defaults', async () => {
  const env = makeEnv({ routes: [['GET', ...SHEET_PROPS], ['POST', /:append\?/, () => ({ updates: { updatedRange: "'Applications'!A2:L2" } })]] });
  await assert.rejects(env.ctx.appendJob({ company: '', role: '', url: 'https://a.com/x' }), { code: 'BAD_REQUEST', message: 'Company or role is required.' });
  await assert.rejects(env.ctx.appendJob({ company: 'A', url: 'ftp://a.com' }), { code: 'BAD_REQUEST' });
  assert.equal(env.calls.fetch.length, 0, 'nothing sent for invalid jobs');

  await env.ctx.appendJob({ company: 'A', url: 'https://a.com/x', appliedDate: '2026-13-40', status: 'Hired', workMode: 'Mars' });
  const row = env.calls.fetch[1].body.values[0];
  assert.match(row[2], /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(row[2], '2026-13-40');
  assert.deepEqual([row[3], row[4], row[6]], ['Applied', 'N/A', 'N/A']);
});

test('appendJob adds pre-formatted rows when the sheet is nearly full', async () => {
  const env = makeEnv({
    routes: [
      ['GET', ...SHEET_PROPS],
      ['POST', /:append\?/, () => ({ updates: { updatedRange: 'Applications!A960:L960' } })],
      ['POST', /:batchUpdate$/, () => ({})],
    ],
  });
  await env.ctx.appendJob(JOB);
  const [request] = env.calls.fetch[2].body.requests;
  assert.deepEqual(request, { insertDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: 960, endIndex: 1460 }, inheritFromBefore: true } });
});

test('appendJob without a connected sheet reports NOT_CONNECTED', async () => {
  const env = makeEnv({ local: {} });
  await assert.rejects(env.ctx.appendJob(JOB), { code: 'NOT_CONNECTED' });
});

// ----- Duplicate lookup -----------------------------------------------------

test('findByLink matches normalized links, newest first, and caches the link column', async () => {
  const env = makeEnv({
    routes: [
      ['GET', /values\/Applications!J2%3AJ$/, () => ({ values: [['https://acme.com/jobs/1'], [], ['https://www.acme.com/jobs/1/?utm_source=x'], ['https://other.com/a']] })],
      ['GET', /values\/Applications!A4%3AL4$/, () => ({ values: [['Acme', 'Eng', '03 Oct 2026', 'Interview']] })],
    ],
  });
  const found = plain(await env.ctx.findByLink('https://acme.com/jobs/1?ref=abc'));
  assert.deepEqual(found, { found: true, row: 4, appliedDate: '03 Oct 2026', status: 'Interview' });
  assert.deepEqual(plain(await env.ctx.findByLink('https://nope.com/1')), { found: false });
  assert.equal(env.calls.fetch.filter((c) => /J2%3AJ/.test(c.url)).length, 1, 'link column read once');
});

test('a saved row is added to the cached links', async () => {
  const env = makeEnv({
    routes: [
      ['GET', /values\/Applications!J2%3AJ$/, () => ({ values: [['https://a.com/1']] })],
      ['GET', ...SHEET_PROPS],
      ['POST', /:append\?/, () => ({ updates: { updatedRange: 'Applications!A3:L3' } })],
      ['GET', /values\/Applications!A[23]%3AL[23]$/, () => ({ values: [['Acme', 'Eng', '03 Oct 2026', 'Interview']] })],
    ],
  });
  await env.ctx.findByLink('https://a.com/1');
  await env.ctx.appendJob(JOB);
  assert.equal((await env.ctx.findByLink('https://acme.com/jobs/1')).row, 3);
  assert.equal(env.calls.fetch.filter((c) => /J2%3AJ/.test(c.url)).length, 1);
});

test('normalizeLink ignores the Workday locale segment', () => {
  const { ctx } = makeEnv();
  assert.equal(
    ctx.normalizeLink('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Pune/Engineer_R1'),
    ctx.normalizeLink('https://acme.wd5.myworkdayjobs.com/careers/job/Pune/Engineer_R1'),
  );
});

// ----- Auth and errors ------------------------------------------------------

test('a 401 drops the cached token and retries once with a fresh one', async () => {
  let first = true;
  const env = makeEnv({
    routes: [['GET', /\/drive\/v3\/files\/x\?/, () => {
      if (first) { first = false; return { status: 401, body: { error: { message: 'Invalid Credentials' } } }; }
      return { name: 'Tracker', trashed: false };
    }]],
  });
  assert.equal((await env.ctx.getTrackerInfo('x')).name, 'Tracker');
  assert.deepEqual(env.calls.removed, ['tok-1']);
  assert.deepEqual(env.calls.fetch.map((c) => c.init.headers.Authorization), ['Bearer tok-1', 'Bearer tok-2']);

  const always = makeEnv({ routes: [['GET', /files\/x\?/, () => ({ status: 401, body: {} })]] });
  await assert.rejects(always.ctx.getTrackerInfo('x'), { code: 'SIGNED_OUT' });
  assert.equal(always.calls.fetch.length, 2, 'only one retry');
});

test('a deleted, trashed or unshared sheet reports SHEET_GONE; other failures map to codes', async () => {
  for (const [status, code] of [[404, 'SHEET_GONE'], [403, 'SHEET_GONE'], [429, 'BUSY'], [500, 'GOOGLE_ERROR']]) {
    const env = makeEnv({ routes: [['GET', /files\/x\?/, () => ({ status, body: { error: { message: 'nope' } } })]] });
    await assert.rejects(env.ctx.getTrackerInfo('x'), { code, detail: 'nope' }, String(status));
  }
  const trashed = makeEnv({ routes: [['GET', /files\/x\?/, () => ({ name: 'T', trashed: true })]] });
  await assert.rejects(trashed.ctx.getTrackerInfo('x'), { code: 'SHEET_GONE' });

  const offline = makeEnv();
  offline.ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(offline.ctx.getTrackerInfo('x'), { code: 'NETWORK' });

  const signedOut = makeEnv();
  signedOut.chrome.identity.getAuthToken = async () => { throw new Error('The user is not signed in.'); };
  await assert.rejects(signedOut.ctx.getTrackerInfo('x'), { code: 'SIGNED_OUT', detail: 'The user is not signed in.' });
});

test('outside Google Chrome, sign-in uses launchWebAuthFlow and caches the token for the session', async () => {
  const env = makeEnv({ brand: 'Microsoft Edge', routes: [['GET', /files\/x\?/, () => ({ name: 'T' })]] });
  env.chrome.identity.getAuthToken = async () => { throw new Error('should not be called'); };
  await env.ctx.getTrackerInfo('x');
  await env.ctx.getTrackerInfo('x');
  assert.equal(env.calls.authFlows.length, 1, 'second call used the cached token');
  const flow = env.calls.authFlows[0];
  assert.equal(flow.interactive, false);
  const params = new URL(flow.url).searchParams;
  assert.equal(params.get('client_id'), 'YOUR_WEB_APPLICATION_CLIENT_ID.apps.googleusercontent.com');
  assert.equal(params.get('redirect_uri'), 'https://abcdefghijklmnop.chromiumapp.org/');
  assert.equal(params.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(params.get('response_type'), 'token');
  assert.equal(params.get('prompt'), 'none');
  assert.equal(env.calls.fetch[0].init.headers.Authorization, 'Bearer web-tok');
  assert.equal(env.chrome.storage.session.data.webToken.token, 'web-tok');

  const interactive = makeEnv({ brand: 'Brave' });
  assert.equal(await interactive.ctx.getToken(true), 'web-tok');
  assert.equal(new URL(interactive.calls.authFlows[0].url).searchParams.get('prompt'), null, 'consent screen allowed');
});

test('signOut revokes the token and clears caches', async () => {
  const env = makeEnv({ session: { linkCache: { id: ID, links: [], at: Date.now() } }, routes: [['POST', /oauth2\.googleapis\.com\/revoke$/, () => ({})]] });
  await env.ctx.signOut();
  const revoke = env.calls.fetch[0];
  assert.equal(revoke.init.mode, 'no-cors');
  assert.equal(revoke.body.get('token'), 'tok-1');
  assert.deepEqual(env.calls.removed, ['tok-1']);
  assert.equal(env.chrome.storage.session.data.linkCache, undefined);
});

// ----- Kept in sync with other files ----------------------------------------

test('sheets.js agrees with the content scripts and the manifest', () => {
  const block = (source, name) => {
    const match = source.match(new RegExp(`${name} = (?:new Set\\()?([\\[{][\\s\\S]*?[\\]}])`));
    assert.ok(match, `${name} not found`);
    return match[1].replace(/\s+/g, '');
  };
  assert.equal(block(SHEETS_JS, 'STATUS_COLORS'), block(read('extension/content/ui.js'), 'STATUS_COLORS'));
  assert.equal(block(SHEETS_JS, 'TRACKING_PARAMS'), block(read('extension/content/extract.js'), 'TRACKING_PARAMS'));

  const manifest = JSON.parse(read('extension/manifest.json'));
  const { constant } = makeEnv();
  assert.equal(manifest.oauth2.client_id, constant('CONFIG.CHROME_CLIENT_ID'));
  assert.deepEqual(manifest.oauth2.scopes, [constant('SCOPE')]);
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting', 'identity', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://sheets.googleapis.com/*', 'https://www.googleapis.com/*']);
});
