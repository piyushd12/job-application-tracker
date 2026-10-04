'use strict';

// Runs apps-script/Code.gs in a node:vm context with small in-memory mocks of the Google services it uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Wraps an object so unknown methods (formatting calls we don't care about) are chainable no-ops. */
function absorb(target) {
  const proxy = new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop] : () => proxy),
  });
  return proxy;
}

/** Records builder calls; build() returns a plain object describing them. */
function builder(kind) {
  const calls = [];
  const proxy = new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'build') {
        return () => ({ kind, calls, getRanges: () => (calls.find(([name]) => name === 'setRanges') || [, [[]]])[1][0] });
      }
      return (...args) => { calls.push([prop, args]); return proxy; };
    },
  });
  return proxy;
}

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getLastRow() { return this.row + this.numRows - 1; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getNumColumns() { return this.numCols; }
  getValues() {
    return this.sheet.cells.slice(this.row - 1, this.row - 1 + this.numRows)
      .map((r) => r.slice(this.col - 1, this.col - 1 + this.numCols));
  }
  setValues(values) {
    assert.equal(values.length, this.numRows, 'setValues row count');
    values.forEach((r, i) => {
      assert.equal(r.length, this.numCols, 'setValues column count');
      r.forEach((v, j) => { this.sheet.cells[this.row - 1 + i][this.col - 1 + j] = v; });
    });
    return this;
  }
  setFormula(formula) { return this.setValues([[formula]]); }
  setDataValidation(rule) {
    this.sheet.validations[this.col] = { rule, firstRow: this.row, lastRow: this.getLastRow() };
    return this;
  }
  createFilter() {
    const sheet = this.sheet;
    const range = this;
    sheet.filter = {
      getRange: () => range,
      remove: () => { sheet.filter = null; },
      getColumnFilterCriteria: () => null,
      setColumnFilterCriteria() {},
    };
    sheet.filtersCreated++;
    return sheet.filter;
  }
}

class MockSheet {
  constructor(name, rows = 1000, cols = 26) {
    this.name = name;
    this.cols = cols;
    this.cells = Array.from({ length: rows }, () => Array(cols).fill(''));
    this.filter = null;
    this.filtersCreated = 0;
    this.rules = [];
    this.validations = {};
  }
  getName() { return this.name; }
  getSheetId() { return 7; }
  getMaxRows() { return this.cells.length; }
  getMaxColumns() { return this.cols; }
  getLastRow() {
    for (let r = this.cells.length; r > 0; r--) {
      if (this.cells[r - 1].some((v) => v !== '' && v !== null)) return r;
    }
    return 0;
  }
  insertRowsAfter(after, count) {
    this.cells.splice(after, 0, ...Array.from({ length: count }, () => Array(this.cols).fill('')));
  }
  getRange(row, col, numRows = 1, numCols = 1) { return absorb(new MockRange(this, row, col, numRows, numCols)); }
  getFilter() { return this.filter; }
  getConditionalFormatRules() { return this.rules.slice(); }
  setConditionalFormatRules(rules) { this.rules = rules; }
  clear() { this.cells = this.cells.map((r) => r.map(() => '')); }
  cell(row, col) { return this.cells[row - 1][col - 1]; }
}

function makeEnv({ secret = '', autoGhost = true } = {}) {
  const sheets = [];
  const triggers = [];
  const ss = absorb({
    getName: () => 'My Job Hunt',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/abc/edit',
    getSpreadsheetTimeZone: () => 'Asia/Kolkata',
    getSheetByName: (name) => sheets.find((s) => s.name === name) || null,
    insertSheet: (name) => {
      const sheet = absorb(new MockSheet(name));
      sheets.push(sheet);
      return sheet;
    },
  });
  const triggerBuilder = (name) => {
    const calls = {};
    const proxy = new Proxy({}, {
      get: (_, prop) => (prop === 'create'
        ? () => triggers.push({ getHandlerFunction: () => name, calls })
        : (...args) => { calls[prop] = args; return proxy; }),
    });
    return proxy;
  };
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush() {},
      newDataValidation: () => builder('validation'),
      newConditionalFormatRule: () => builder('conditional'),
      getUi: () => absorb({}),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: triggerBuilder,
    },
    Utilities: {
      formatDate: (d, tz, format) => (format === 'yyyy-MM-dd'
        ? d.toISOString().slice(0, 10)
        : `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`),
    },
    console: { error() {}, log() {} },
  };

  const code = replaceOnce(
    replaceOnce(CODE, "const SECRET = '';", `const SECRET = ${JSON.stringify(secret)};`),
    'const AUTO_GHOST = true;', `const AUTO_GHOST = ${autoGhost};`,
  );
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'Code.gs' });

  return {
    ctx,
    triggers,
    sheets,
    sheet: () => ss.getSheetByName('Applications'),
    summary: () => ss.getSheetByName('Summary'),
    get: (params) => JSON.parse(ctx.doGet({ parameter: params }).text),
    post: (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text),
  };
}

function replaceOnce(source, from, to) {
  assert.ok(source.includes(from), `Code.gs no longer contains: ${from}`);
  return source.replace(from, to);
}

const JOB = {
  company: 'Acme',
  role: 'Backend Engineer',
  appliedDate: '2026-10-03',
  status: 'Applied',
  workMode: 'Hybrid',
  location: 'Pune, India',
  yoe: '2-5 yrs',
  salary: '12-18 LPA',
  source: 'Company Site',
  url: 'https://careers.acme.com/jobs/42',
  notes: '',
};

const STATUS = 4;
const UPDATED = 11;

test('requests before setup report SETUP_REQUIRED', () => {
  const env = makeEnv();
  assert.deepEqual(env.get({ action: 'ping' }), { ok: true, version: 1, setup: false, sheetName: 'My Job Hunt', rows: 0 });
  assert.equal(env.post({ action: 'add', job: JOB }).error, 'SETUP_REQUIRED');
  assert.equal(env.get({ action: 'check', url: JOB.url }).error, 'SETUP_REQUIRED');
});

test('setup builds the sheet and is idempotent', () => {
  const env = makeEnv();
  env.ctx.setup();
  const sheet = env.sheet();
  assert.deepEqual(sheet.getRange(1, 1, 1, 12).getValues()[0].slice(0, 4), ['Company', 'Role', 'Applied Date', 'Status']);
  assert.ok(sheet.getMaxRows() >= 1001, 'about 1000 pre-formatted rows');
  assert.equal(sheet.rules.length, 8, 'one color rule per status');
  assert.equal(sheet.validations[STATUS].lastRow, sheet.getMaxRows());
  assert.equal(env.triggers.length, 1);
  assert.ok(env.summary(), 'summary tab exists');
  assert.match(String(env.summary().cell(2, 2)), /^=COUNTA\('Applications'!D2:D\)/);

  env.ctx.setup();
  assert.equal(sheet.rules.length, 8);
  assert.equal(env.triggers.length, 1);
  assert.equal(sheet.filtersCreated, 1);
  assert.deepEqual(env.sheets.map((s) => s.name), ['Applications', 'Summary'], 'no duplicate tabs');
  assert.equal(env.get({ action: 'ping' }).setup, true);
});

test('setup keeps rules on other columns and the daily trigger runs in the sheet time zone', () => {
  const env = makeEnv();
  env.ctx.setup();
  const sheet = env.sheet();
  const userRule = { getRanges: () => [sheet.getRange(2, 6, 10, 1)] };
  sheet.rules.push(userRule);
  env.ctx.setup();
  assert.equal(sheet.rules.length, 9);
  assert.ok(sheet.rules.includes(userRule));
  assert.deepEqual(env.triggers[0].calls.atHour, [6]);
  assert.deepEqual(env.triggers[0].calls.inTimezone, ['Asia/Kolkata']);
});

test('Summary formulas tolerate an empty sheet', () => {
  const env = makeEnv();
  env.ctx.setup();
  const summary = env.summary();
  assert.match(String(summary.cell(5, 2)), /^=IFERROR\(/, 'response rate');
  assert.match(String(summary.cell(6, 2)), /^=IFERROR\(/, 'interview rate');
  for (let r = 2; r <= 9; r++) assert.match(String(summary.cell(r, 6)), /^=IFERROR\(/, 'status share');
  assert.match(String(summary.cell(2, 8)), /^=IFERROR\(QUERY\(/, 'source breakdown');
});

test('setup skips the daily trigger when AUTO_GHOST is off', () => {
  const env = makeEnv({ autoGhost: false });
  env.ctx.setup();
  assert.equal(env.triggers.length, 0);
});

test('add appends a sanitized row and returns its number', () => {
  const env = makeEnv();
  env.ctx.setup();
  const res = env.post({
    action: 'add',
    job: { ...JOB, company: '=HYPERLINK("http://evil")', notes: '+1 referral', status: 'Bogus', workMode: '' },
  });
  assert.deepEqual(res, { ok: true, row: 2, sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=7&range=A2' });

  const row = env.sheet().getRange(2, 1, 1, 12).getValues()[0];
  assert.equal(row[0], '\'=HYPERLINK("http://evil")');
  assert.equal(row[2], '2026-10-03');
  assert.equal(row[3], 'Applied');
  assert.equal(row[4], 'N/A');
  assert.equal(row[6], '2-5 yrs');
  assert.equal(Object.prototype.toString.call(row[10]), '[object Date]');
  assert.equal(row[11], "'+1 referral");
  assert.equal(env.post({ action: 'add', job: JOB }).row, 3);
  assert.equal(env.get({ action: 'ping' }).rows, 2);
});

test('add falls back to today for a malformed applied date', () => {
  const env = makeEnv();
  env.ctx.setup();
  env.post({ action: 'add', job: { ...JOB, appliedDate: '2026-13-45' } });
  assert.equal(env.sheet().cell(2, 3), new Date().toISOString().slice(0, 10));
});

test('add validates company/role and link', () => {
  const env = makeEnv();
  env.ctx.setup();
  assert.equal(env.post({ action: 'add', job: { ...JOB, company: ' ', role: '' } }).error, 'BAD_REQUEST');
  assert.equal(env.post({ action: 'add', job: { ...JOB, url: 'javascript:alert(1)' } }).error, 'BAD_REQUEST');
  assert.equal(env.post({ action: 'add' }).error, 'BAD_REQUEST');
  assert.equal(env.post('not json').error, 'BAD_REQUEST');
});

test('add tops up pre-formatted rows when the sheet is nearly full', () => {
  const env = makeEnv();
  env.ctx.setup();
  const sheet = env.sheet();
  const before = sheet.getMaxRows();
  for (let r = 2; r <= before - 10; r++) sheet.cells[r - 1][0] = 'filler';
  const res = env.post({ action: 'add', job: JOB });
  assert.equal(res.row, before - 9);
  assert.ok(sheet.getMaxRows() >= before + 500);
  assert.equal(sheet.validations[STATUS].lastRow, sheet.getMaxRows());
});

test('check finds duplicates by normalized link', () => {
  const env = makeEnv();
  env.ctx.setup();
  env.post({ action: 'add', job: { ...JOB, url: 'https://careers.acme.com/jobs/42?utm_source=x&team=core' } });
  assert.deepEqual(env.get({ action: 'check', url: 'http://www.careers.acme.com/jobs/42/apply?team=core&gh_src=1#top' }), {
    ok: true, found: true, row: 2, appliedDate: '2026-10-03', status: 'Applied',
  });
  assert.deepEqual(env.get({ action: 'check', url: 'https://careers.acme.com/jobs/43' }), { ok: true, found: false });
  assert.equal(env.get({ action: 'check' }).error, 'BAD_REQUEST');
});

test('check ignores the Workday locale segment', () => {
  const env = makeEnv();
  env.ctx.setup();
  env.post({ action: 'add', job: { ...JOB, url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Pune/QA_R-1' } });
  assert.equal(env.get({ action: 'check', url: 'https://acme.wd5.myworkdayjobs.com/External/job/Pune/QA_R-1' }).found, true);
  assert.equal(env.get({ action: 'check', url: 'https://acme.wd5.myworkdayjobs.com/de-DE/External/job/Pune/QA_R-1' }).found, true);
});

test('check scales to thousands of rows and reports the newest match', () => {
  const env = makeEnv();
  env.ctx.setup();
  const sheet = env.sheet();
  const rows = 2500;
  sheet.insertRowsAfter(sheet.getMaxRows(), rows);
  for (let r = 2; r <= rows + 1; r++) {
    sheet.cells[r - 1].splice(0, 12, 'Acme', 'Role', '2026-01-01', 'Applied', 'N/A', '', 'N/A', '', 'LinkedIn', `https://acme.com/jobs/${r}`, '', '');
  }
  sheet.cells[rows][9] = 'https://acme.com/jobs/2'; // a second, newer copy of row 2's link
  sheet.cells[rows][3] = 'Interview';

  const started = Date.now();
  assert.deepEqual(env.get({ action: 'check', url: 'https://acme.com/jobs/2?utm_source=x' }), {
    ok: true, found: true, row: rows + 1, appliedDate: '2026-01-01', status: 'Interview',
  });
  assert.equal(env.get({ action: 'check', url: 'https://acme.com/jobs/999999' }).found, false);
  assert.ok(Date.now() - started < 1000, 'fast enough');
});

test('secret token is enforced only when set', () => {
  const env = makeEnv({ secret: 's3cret' });
  assert.equal(env.get({ action: 'ping' }).error, 'BAD_TOKEN');
  assert.equal(env.get({ action: 'ping', token: 'nope' }).error, 'BAD_TOKEN');
  assert.equal(env.get({ action: 'ping', token: 's3cret' }).ok, true);
  assert.equal(env.post({ action: 'ping', token: 's3cret' }).ok, true);
});

test('unknown actions and GET writes are rejected', () => {
  const env = makeEnv();
  env.ctx.setup();
  assert.equal(env.get({ action: 'add' }).error, 'UNKNOWN_ACTION');
  assert.equal(env.post({ action: 'delete' }).error, 'UNKNOWN_ACTION');
});

test('onEdit stamps Last Updated only for Status edits', () => {
  const env = makeEnv();
  env.ctx.setup();
  env.post({ action: 'add', job: JOB });
  const sheet = env.sheet();
  sheet.cells[1][UPDATED - 1] = 'old';

  env.ctx.onEdit({ range: sheet.getRange(2, 6) });
  assert.equal(sheet.cell(2, UPDATED), 'old');

  sheet.cells[1][STATUS - 1] = 'Interview';
  env.ctx.onEdit({ range: sheet.getRange(1, 1, 2, 12) });
  assert.equal(Object.prototype.toString.call(sheet.cell(2, UPDATED)), '[object Date]');
  assert.equal(sheet.cell(1, UPDATED), 'Last Updated', 'header untouched');
});

test('markGhosted ghosts stale Applied/OA rows only', () => {
  const env = makeEnv();
  env.ctx.setup();
  const sheet = env.sheet();
  const old = new Date(Date.now() - 40 * DAY_MS);
  const recent = new Date(Date.now() - 5 * DAY_MS);
  [['Applied', old], ['OA / Assessment', old], ['Interview', old], ['Applied', recent], ['Applied', '']].forEach(([status, updated], i) => {
    env.post({ action: 'add', job: { ...JOB, status, url: `https://acme.com/jobs/${i}` } });
    sheet.cells[i + 1][UPDATED - 1] = updated;
  });
  sheet.cells[5][2] = old; // Applied Date is the fallback when Last Updated is blank

  assert.equal(env.ctx.markGhosted(), 3);
  assert.deepEqual([2, 3, 4, 5, 6].map((r) => sheet.cell(r, STATUS)), ['Ghosted', 'Ghosted', 'Interview', 'Applied', 'Ghosted']);
  assert.equal(env.ctx.markGhosted(), 0);
});

test('markGhosted skips rows without a usable date', () => {
  const env = makeEnv();
  env.ctx.setup();
  const sheet = env.sheet();
  sheet.cells[1].splice(0, 12, 'Manual', 'Typed row', '', 'Applied', 'N/A', '', 'N/A', '', '', 'https://a.com/1', '', '');
  sheet.cells[2].splice(0, 12, 'Manual', 'Typed row', 'soon', 'Applied', 'N/A', '', 'N/A', '', '', 'https://a.com/2', 'n/a', '');
  assert.equal(env.ctx.markGhosted(), 0);
  assert.deepEqual([sheet.cell(2, STATUS), sheet.cell(3, STATUS)], ['Applied', 'Applied']);
});

test('markGhosted does nothing when AUTO_GHOST is off', () => {
  const env = makeEnv({ autoGhost: false });
  env.ctx.setup();
  env.post({ action: 'add', job: JOB });
  env.sheet().cells[1][UPDATED - 1] = new Date(Date.now() - 90 * DAY_MS);
  assert.equal(env.ctx.markGhosted(), 0);
  assert.equal(env.sheet().cell(2, STATUS), 'Applied');
});

test('Code.gs and the extension agree on status colors and tracking parameters', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const block = (source, name) => {
    const match = source.match(new RegExp(`${name} = (?:new Set\\()?([\\[{][\\s\\S]*?[\\]}])`));
    assert.ok(match, `${name} not found`);
    return match[1].replace(/\s+/g, '');
  };
  assert.equal(block(CODE, 'STATUS_COLORS'), block(read('extension/content/ui.js'), 'STATUS_COLORS'));
  assert.equal(block(CODE, 'TRACKING_PARAMS'), block(read('extension/content/extract.js'), 'TRACKING_PARAMS'));
});
