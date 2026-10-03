/**
 * Job Application Tracker: Google Apps Script backend.
 *
 * 1. In your Google Sheet open Extensions → Apps Script, replace the editor contents with this file.
 * 2. Run `setup` once (or reload the sheet and use Job Tracker → Run setup) and grant access.
 * 3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 * 4. Paste the /exec URL into the extension settings.
 *
 * The extension talks to this script only. Your data never leaves your Google account.
 */

// ===== Settings ============================================================

/** Optional shared token. Leave empty to disable. If set, paste the same value into the extension settings. */
const SECRET = '';

/** Once a day, mark stale "Applied" and "OA / Assessment" rows as "Ghosted". Run setup again after changing this. */
const AUTO_GHOST = true;

/** Days without any change before a row is marked "Ghosted". */
const GHOST_AFTER_DAYS = 30;

// ===========================================================================

const API_VERSION = 1;
const SHEET_NAME = 'Applications';
const SUMMARY_NAME = 'Summary';

const HEADERS = [
  'Company', 'Role', 'Applied Date', 'Status', 'Work Mode', 'Location',
  'YOE', 'Salary / CTC', 'Source', 'Job Link', 'Last Updated', 'Notes',
];
const COL = {
  company: 1, role: 2, applied: 3, status: 4, workMode: 5, location: 6,
  yoe: 7, salary: 8, source: 9, link: 10, updated: 11, notes: 12,
};
const COLUMN_WIDTHS = [180, 220, 110, 150, 100, 170, 90, 150, 130, 280, 120, 280];
const TEXT_COLUMNS = [COL.company, COL.role, COL.location, COL.yoe, COL.salary, COL.source, COL.link, COL.notes];
const DATE_FORMAT = 'dd mmm yyyy';

const STATUSES = ['Saved', 'Applied', 'OA / Assessment', 'Interview', 'Offer', 'Rejected', 'Ghosted', 'Withdrawn'];
/** [background, text] per status. Keep in sync with extension/content/ui.js. */
const STATUS_COLORS = {
  'Saved': ['#f1f3f4', '#3c4043'],
  'Applied': ['#d2e3fc', '#174ea6'],
  'OA / Assessment': ['#e9d7fe', '#5b2c98'],
  'Interview': ['#feefc3', '#8a5a00'],
  'Offer': ['#ceead6', '#0d652d'],
  'Rejected': ['#fad2cf', '#a50e0e'],
  'Ghosted': ['#5f6368', '#ffffff'],
  'Withdrawn': ['#e6d5c3', '#6d4c2f'],
};
const GHOSTABLE_STATUSES = ['Applied', 'OA / Assessment'];
const WORK_MODES = ['On-site', 'Remote', 'Hybrid', 'N/A'];

const PREFORMATTED_ROWS = 1000;
const MIN_FREE_ROWS = 50;
const TOP_UP_ROWS = 500;
const MAX_FIELD_LENGTH = 5000;
const LOCK_TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Query parameters ignored when comparing job links. Keep in sync with extension/content/extract.js. */
const TRACKING_PARAMS = [
  'ref', 'refid', 'ref_src', 'referrer', 'trk', 'trkinfo', 'trackingid', 'gh_src',
  'lever-source', 'lever-origin', 'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid',
];

// ===== Web App =============================================================

function doGet(e) {
  return respond_(route_((e && e.parameter) || {}, ['ping', 'check']));
}

function doPost(e) {
  let request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond_(fail_('BAD_REQUEST', 'Body must be JSON.'));
  }
  return respond_(route_(request || {}, ['ping', 'check', 'add']));
}

function route_(request, allowedActions) {
  try {
    if (SECRET && request.token !== SECRET) return fail_('BAD_TOKEN');
    if (allowedActions.indexOf(request.action) === -1) return fail_('UNKNOWN_ACTION');
    if (request.action === 'ping') return ping_();
    if (request.action === 'check') return checkDuplicate_(request.url);
    return addJob_(request.job);
  } catch (err) {
    console.error((err && err.stack) || err);
    return fail_('INTERNAL');
  }
}

function ping_() {
  const sheet = getJobSheet_();
  return {
    ok: true,
    version: API_VERSION,
    setup: Boolean(sheet),
    sheetName: SpreadsheetApp.getActiveSpreadsheet().getName(),
    rows: sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0,
  };
}

function addJob_(job) {
  const problem = validateJob_(job);
  if (problem) return fail_('BAD_REQUEST', problem);
  const sheet = getJobSheet_();
  if (!sheet) return fail_('SETUP_REQUIRED');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) return fail_('LOCK_TIMEOUT');
  try {
    ensureFreeRows_(sheet);
    const row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([jobToRow_(job)]);
    SpreadsheetApp.flush();
    return { ok: true, row: row, sheetUrl: sheetUrl_(sheet, row) };
  } finally {
    lock.releaseLock();
  }
}

// ponytail: linear scan of the link column only (one narrow read); fine for tens of thousands of rows.
function checkDuplicate_(url) {
  const target = normalizeLink_(url);
  if (!target) return fail_('BAD_REQUEST', 'Missing url.');
  const sheet = getJobSheet_();
  if (!sheet) return fail_('SETUP_REQUIRED');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, found: false };
  const links = sheet.getRange(2, COL.link, lastRow - 1, 1).getValues();
  for (let i = links.length - 1; i >= 0; i--) {
    if (normalizeLink_(links[i][0]) !== target) continue;
    const row = sheet.getRange(i + 2, 1, 1, HEADERS.length).getValues()[0];
    return {
      ok: true,
      found: true,
      row: i + 2,
      appliedDate: formatDate_(row[COL.applied - 1]),
      status: text_(row[COL.status - 1]) || 'N/A',
    };
  }
  return { ok: true, found: false };
}

function respond_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  return message ? { ok: false, error: code, message: message } : { ok: false, error: code };
}

// ===== Rows ================================================================

function validateJob_(job) {
  if (!job || typeof job !== 'object') return 'Missing job.';
  if (!text_(job.company) && !text_(job.role)) return 'Company or role is required.';
  if (!/^https?:\/\/[^\s/?#]+\.[^\s/?#]+\S*$/i.test(text_(job.url))) return 'Job link must be a valid http(s) URL.';
  return '';
}

/** Column order must match HEADERS. */
function jobToRow_(job) {
  return [
    safeText_(job.company),
    safeText_(job.role),
    appliedDate_(job.appliedDate),
    oneOf_(job.status, STATUSES, 'Applied'),
    oneOf_(job.workMode, WORK_MODES, 'N/A'),
    safeText_(job.location),
    safeText_(job.yoe) || 'N/A',
    safeText_(job.salary),
    safeText_(job.source) || 'Company Site',
    safeText_(job.url),
    new Date(),
    safeText_(job.notes),
  ];
}

/** Trims, caps length and neutralises values Sheets would treat as a formula. */
function safeText_(value) {
  const s = text_(value).slice(0, MAX_FIELD_LENGTH);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** An ISO date string is parsed by Sheets in the spreadsheet's own time zone, so the day never shifts. */
function appliedDate_(value) {
  const s = text_(value);
  if (/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(s)) return s;
  return Utilities.formatDate(new Date(), timeZone_(), 'yyyy-MM-dd');
}

function oneOf_(value, allowed, fallback) {
  const s = text_(value);
  return allowed.indexOf(s) === -1 ? fallback : s;
}

/** Lower-cased link without scheme, www, hash, Workday locale, tracking parameters, /apply or trailing slash. */
function normalizeLink_(value) {
  let s = text_(value).replace(/^'/, '').toLowerCase();
  s = s.replace(/#.*$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/^([^/]*\.myworkday(?:jobs|site)\.com)\/[a-z]{2}-[a-z]{2}(?=\/)/, '$1');
  if (!s) return '';
  const q = s.indexOf('?');
  const path = (q === -1 ? s : s.slice(0, q)).replace(/\/apply\/?$/, '').replace(/\/+$/, '');
  const params = (q === -1 ? '' : s.slice(q + 1)).split('&').filter(function (pair) {
    const name = pair.split('=')[0];
    return name && name.indexOf('utm_') !== 0 && TRACKING_PARAMS.indexOf(name) === -1;
  });
  return params.length ? path + '?' + params.sort().join('&') : path;
}

function sheetUrl_(sheet, row) {
  return SpreadsheetApp.getActiveSpreadsheet().getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + row;
}

// ===== Triggers and menu ===================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Job Tracker')
    .addItem('Run setup', 'setup')
    .addItem('Mark ghosted now', 'markGhostedNow')
    .addToUi();
}

/** Simple trigger: stamp Last Updated whenever Status changes (including multi-row pastes). */
function onEdit(e) {
  const range = e && e.range;
  if (!range) return;
  const sheet = range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;
  if (range.getColumn() > COL.status || range.getLastColumn() < COL.status) return;

  const firstRow = Math.max(range.getRow(), 2);
  const count = range.getLastRow() - firstRow + 1;
  if (count < 1) return;
  const statuses = sheet.getRange(firstRow, COL.status, count, 1).getValues();
  const stampRange = sheet.getRange(firstRow, COL.updated, count, 1);
  const stamps = stampRange.getValues();
  const now = new Date();
  statuses.forEach(function (row, i) {
    if (text_(row[0])) stamps[i][0] = now;
  });
  stampRange.setValues(stamps);
}

/** Daily time trigger installed by setup(). */
function markGhosted() {
  return AUTO_GHOST ? ghostStaleRows_() : 0;
}

/** Menu item: runs regardless of AUTO_GHOST. */
function markGhostedNow() {
  const count = ghostStaleRows_();
  toast_(count === 1 ? '1 row marked Ghosted.' : count + ' rows marked Ghosted.');
}

function ghostStaleRows_() {
  const sheet = getJobSheet_();
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) return 0;
  try {
    const count = sheet.getLastRow() - 1;
    const rows = sheet.getRange(2, 1, count, HEADERS.length).getValues();
    const statuses = rows.map(function (r) { return [r[COL.status - 1]]; });
    const stamps = rows.map(function (r) { return [r[COL.updated - 1]]; });
    const cutoff = Date.now() - GHOST_AFTER_DAYS * DAY_MS;
    const now = new Date();
    let changed = 0;

    rows.forEach(function (r, i) {
      if (GHOSTABLE_STATUSES.indexOf(text_(r[COL.status - 1])) === -1) return;
      const last = toTime_(r[COL.updated - 1]) || toTime_(r[COL.applied - 1]);
      if (!last || last >= cutoff) return;
      statuses[i][0] = 'Ghosted';
      stamps[i][0] = now;
      changed++;
    });

    if (changed) {
      sheet.getRange(2, COL.status, count, 1).setValues(statuses);
      sheet.getRange(2, COL.updated, count, 1).setValues(stamps);
    }
    return changed;
  } finally {
    lock.releaseLock();
  }
}

// ===== Setup ===============================================================

/** Creates or repairs everything. Safe to run any number of times. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME, 0);

  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }
  if (sheet.getMaxRows() < PREFORMATTED_ROWS + 1) {
    sheet.insertRowsAfter(sheet.getMaxRows(), PREFORMATTED_ROWS + 1 - sheet.getMaxRows());
  }
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  formatHeader_(sheet);
  formatDataRows_(sheet);
  buildSummary_(ss);
  installTriggers_();
  SpreadsheetApp.flush();
  toast_('Setup complete. Next: Deploy → New deployment → Web app.');
}

function formatHeader_(sheet) {
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#1f2937')
    .setFontColor('#ffffff')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);
  COLUMN_WIDTHS.forEach(function (width, i) { sheet.setColumnWidth(i + 1, width); });
}

/** Formats every row below the header: plain-text columns, dates, dropdowns, status colors, filter. */
function formatDataRows_(sheet) {
  const rows = sheet.getMaxRows() - 1;
  TEXT_COLUMNS.forEach(function (c) { sheet.getRange(2, c, rows, 1).setNumberFormat('@'); });
  [COL.applied, COL.updated].forEach(function (c) { sheet.getRange(2, c, rows, 1).setNumberFormat(DATE_FORMAT); });
  sheet.getRange(2, COL.status, rows, 1).setDataValidation(dropdown_(STATUSES));
  sheet.getRange(2, COL.workMode, rows, 1).setDataValidation(dropdown_(WORK_MODES));
  applyStatusColors_(sheet, rows);
  ensureFilter_(sheet);
}

function dropdown_(values) {
  return SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
}

/** Replaces only our own rules (those on the Status column) and keeps any the user added elsewhere. */
function applyStatusColors_(sheet, rows) {
  const range = sheet.getRange(2, COL.status, rows, 1);
  const others = sheet.getConditionalFormatRules().filter(function (rule) {
    return !rule.getRanges().every(function (r) { return r.getColumn() === COL.status && r.getNumColumns() === 1; });
  });
  const ours = STATUSES.map(function (status) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(status)
      .setBackground(STATUS_COLORS[status][0])
      .setFontColor(STATUS_COLORS[status][1])
      .setRanges([range])
      .build();
  });
  sheet.setConditionalFormatRules(others.concat(ours));
}

/** Makes the filter cover every row, keeping any active column criteria. */
function ensureFilter_(sheet) {
  const maxRows = sheet.getMaxRows();
  const existing = sheet.getFilter();
  if (existing && existing.getRange().getLastRow() >= maxRows) return;

  const criteria = [];
  if (existing) {
    for (let c = 1; c <= HEADERS.length; c++) {
      const columnCriteria = existing.getColumnFilterCriteria(c);
      if (columnCriteria) criteria.push([c, columnCriteria]);
    }
    existing.remove();
  }
  const filter = sheet.getRange(1, 1, maxRows, HEADERS.length).createFilter();
  criteria.forEach(function (pair) { filter.setColumnFilterCriteria(pair[0], pair[1]); });
}

/** Adds pre-formatted rows when the sheet is close to full. Called under the script lock. */
function ensureFreeRows_(sheet) {
  if (sheet.getMaxRows() - sheet.getLastRow() >= MIN_FREE_ROWS) return;
  sheet.insertRowsAfter(Math.max(sheet.getLastRow(), 1), TOP_UP_ROWS);
  formatDataRows_(sheet);
}

function buildSummary_(ss) {
  const sheet = ss.getSheetByName(SUMMARY_NAME) || ss.insertSheet(SUMMARY_NAME);
  sheet.clear();

  const status = "'" + SHEET_NAME + "'!D2:D";
  const applied = "'" + SHEET_NAME + "'!C2:C";
  const all = "'" + SHEET_NAME + "'!A2:L";
  const count = function (s) { return 'COUNTIF(' + status + ',"' + s + '")'; };
  const since = function (days) { return '=COUNTIFS(' + applied + ',">="&(TODAY()-' + days + '),' + status + ',"<>Saved")'; };

  const metrics = [
    ['Metric', 'Value'],
    ['Total applications', '=COUNTA(' + status + ')-' + count('Saved')],
    ['Applied in last 7 days', since(7)],
    ['Applied in last 30 days', since(30)],
    ['Response rate', '=IFERROR((' + ['OA / Assessment', 'Interview', 'Offer', 'Rejected'].map(count).join('+') + ')/B2,0)'],
    ['Interview rate', '=IFERROR((' + count('Interview') + '+' + count('Offer') + ')/B2,0)'],
    ['Offers', '=' + count('Offer')],
  ];
  sheet.getRange(1, 1, metrics.length, 2).setValues(metrics);
  sheet.getRange(5, 2, 2, 1).setNumberFormat('0.0%');

  const lastStatusRow = STATUSES.length + 1;
  const statusRows = [['Status', 'Count', 'Share']].concat(STATUSES.map(function (s, i) {
    return [s, '=' + count(s), '=IFERROR(E' + (i + 2) + '/SUM(E$2:E$' + lastStatusRow + '),0)'];
  }));
  sheet.getRange(1, 4, statusRows.length, 3).setValues(statusRows);
  sheet.getRange(2, 6, STATUSES.length, 1).setNumberFormat('0.0%');
  STATUSES.forEach(function (s, i) {
    sheet.getRange(i + 2, 4).setBackground(STATUS_COLORS[s][0]).setFontColor(STATUS_COLORS[s][1]);
  });

  sheet.getRange(1, 8, 1, 2).setValues([['Source', 'Count']]);
  // IFERROR: QUERY returns #N/A on a sheet with no rows yet.
  sheet.getRange(2, 8).setFormula('=IFERROR(QUERY(' + all + ",\"select I, count(I) where I <> '' group by I order by count(I) desc label I '', count(I) ''\",0),\"\")");

  [[1, 2], [4, 3], [8, 2]].forEach(function (block) {
    sheet.getRange(1, block[0], 1, block[1]).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  });
  sheet.setFrozenRows(1);
  [200, 90, 24, 150, 70, 70, 24, 150, 70].forEach(function (width, i) { sheet.setColumnWidth(i + 1, width); });
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'markGhosted') ScriptApp.deleteTrigger(trigger);
  });
  if (AUTO_GHOST) ScriptApp.newTrigger('markGhosted').timeBased().everyDays(1).atHour(6).inTimezone(timeZone_()).create();
}

// ===== Helpers =============================================================

/** The Applications sheet, or null when setup() has not been run. */
function getJobSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getMaxColumns() < HEADERS.length) return null;
  const header = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  return HEADERS.every(function (h, i) { return header[i] === h; }) ? sheet : null;
}

function text_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

function toTime_(value) {
  if (isDate_(value)) return value.getTime();
  return typeof value === 'string' && value ? Date.parse(value) || 0 : 0;
}

function formatDate_(value) {
  return isDate_(value) ? Utilities.formatDate(value, timeZone_(), 'dd MMM yyyy') : text_(value);
}

function timeZone_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

function toast_(message) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Job Tracker', 6);
  } catch (err) {
    // No UI when called from the Web App or a trigger.
  }
}
