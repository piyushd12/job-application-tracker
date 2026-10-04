'use strict';

// Google Sheets and Drive access for the service worker, loaded with importScripts after config.js.
// It signs in with the drive.file scope only, so it can see nothing but the spreadsheets it created.
// Every failure is thrown as a SheetsError whose code background.js turns into a friendly message.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_TIMEOUT_MS = 20000;
const LINK_CACHE_MS = 60 * 1000;

const TRACKER_TITLE = 'Job Applications Tracker';
const TRACKER_PROPERTY = 'jobTracker';
const SHEET_NAME = 'Applications';
const SUMMARY_NAME = 'Summary';
const APPLICATIONS_ID = 0;
const SUMMARY_ID = 1;

const HEADERS = [
  'Company', 'Role', 'Applied Date', 'Status', 'Work Mode', 'Location',
  'YOE', 'Salary / CTC', 'Source', 'Job Link', 'Last Updated', 'Notes',
];
/** 1-based column numbers, as in the sheet. */
const COL = {
  company: 1, role: 2, applied: 3, status: 4, workMode: 5, location: 6,
  yoe: 7, salary: 8, source: 9, link: 10, updated: 11, notes: 12,
};
const COLUMN_WIDTHS = [180, 220, 110, 150, 100, 170, 90, 150, 130, 280, 120, 280];
const TEXT_COLUMNS = [COL.company, COL.role, COL.location, COL.yoe, COL.salary, COL.source, COL.link, COL.notes];
const DATE_FORMAT = 'dd mmm yyyy';
const HEADER_BACKGROUND = '#1f2937';

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
const WORK_MODES = ['On-site', 'Remote', 'Hybrid', 'N/A'];
const GHOSTABLE_STATUSES = ['Applied', 'OA / Assessment'];

const PREFORMATTED_ROWS = 1000;
const MIN_FREE_ROWS = 50;
const TOP_UP_ROWS = 500;
const MAX_FIELD_LENGTH = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SERIAL_EPOCH = Date.UTC(1899, 11, 30); // day 0 of spreadsheet date serial numbers

/** Query parameters ignored when comparing job links. Keep in sync with extension/content/extract.js. */
const TRACKING_PARAMS = [
  'ref', 'refid', 'ref_src', 'referrer', 'trk', 'trkinfo', 'trackingid', 'gh_src',
  'lever-source', 'lever-origin', 'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid',
];

class SheetsError extends Error {
  constructor(code, detail = '') {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

// ----- Sign-in ------------------------------------------------------------

/** getAuthToken only works in Google Chrome; Edge, Brave and other Chromium browsers use the web flow. */
// ponytail: decided by brand name; revisit if a Chromium fork starts reporting "Google Chrome".
function usesChromeSignIn() {
  const brands = (globalThis.navigator && navigator.userAgentData && navigator.userAgentData.brands) || [];
  return typeof chrome.identity.getAuthToken === 'function' && brands.some((b) => b.brand === 'Google Chrome');
}

/** An access token. Interactive sign-in may open Google's consent screen, so only use it after a click. */
async function getToken(interactive = false) {
  let token;
  try {
    if (usesChromeSignIn()) {
      const result = await chrome.identity.getAuthToken({ interactive, scopes: [SCOPE] });
      token = typeof result === 'string' ? result : result && result.token;
    } else {
      token = await webFlowToken(interactive);
    }
  } catch (err) {
    throw new SheetsError('SIGNED_OUT', (err && err.message) || '');
  }
  if (!token) throw new SheetsError('SIGNED_OUT');
  return token;
}

/** OAuth implicit flow through https://<extension-id>.chromiumapp.org/. Tokens last about an hour. */
async function webFlowToken(interactive) {
  const { webToken } = await chrome.storage.session.get('webToken');
  if (webToken && webToken.expiresAt - Date.now() > 60 * 1000) return webToken.token;

  const params = new URLSearchParams({
    client_id: CONFIG.WEB_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
  });
  if (!interactive) params.set('prompt', 'none');
  const redirect = await chrome.identity.launchWebAuthFlow({
    url: `${AUTH_URL}?${params}`,
    interactive,
    // Google answers prompt=none with a page that redirects, not with an immediate 302.
    abortOnLoadForNonInteractive: false,
    timeoutMsForNonInteractive: 10000,
  });
  const reply = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = reply.get('access_token');
  if (!token) throw new Error(reply.get('error') || 'No access token in the reply.');
  const expiresIn = Number(reply.get('expires_in')) || 3600;
  await chrome.storage.session.set({ webToken: { token, expiresAt: Date.now() + expiresIn * 1000 } });
  return token;
}

/** Forgets a token Google rejected, so the next getToken fetches a fresh one. */
async function dropToken(token) {
  try {
    if (usesChromeSignIn()) await chrome.identity.removeCachedAuthToken({ token });
    else await chrome.storage.session.remove('webToken');
  } catch {
    // Nothing cached.
  }
}

/** Revokes the extension's access to the user's Google account and forgets every cached token. */
async function signOut() {
  let token = '';
  try {
    token = await getToken(false);
  } catch {
    // Already signed out.
  }
  if (token) {
    // no-cors needs no host permission; the reply isn't needed.
    await fetch(REVOKE_URL, { method: 'POST', mode: 'no-cors', body: new URLSearchParams({ token }) }).catch(() => {});
    await dropToken(token);
  }
  try {
    if (chrome.identity.clearAllCachedAuthTokens) await chrome.identity.clearAllCachedAuthTokens();
  } catch {
    // Not available in this browser.
  }
  await chrome.storage.session.remove(['webToken', 'linkCache']);
}

// ----- REST ---------------------------------------------------------------

/** Calls a Google API with the user's token. A 401 drops the cached token and retries once. */
async function google(url, { method = 'GET', body, interactive = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(interactive);
    const init = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new SheetsError('NETWORK');
    }
    if (response.status === 401 && attempt === 0) {
      await dropToken(token);
      continue;
    }
    if (response.ok) return response.json().catch(() => ({}));
    throw new SheetsError(codeForStatus(response.status), await googleMessage(response));
  }
}

function codeForStatus(status) {
  if (status === 401) return 'SIGNED_OUT';
  if (status === 403 || status === 404) return 'SHEET_GONE'; // deleted, or access removed
  if (status === 429) return 'BUSY';
  return 'GOOGLE_ERROR';
}

async function googleMessage(response) {
  try {
    const data = await response.json();
    return String((data && data.error && data.error.message) || '');
  } catch {
    return '';
  }
}

function valuesUrl(id, range, suffix = '') {
  return `${SHEETS_API}/${id}/values/${encodeURIComponent(range)}${suffix}`;
}

function batchUpdate(id, requests) {
  return google(`${SHEETS_API}/${id}:batchUpdate`, { method: 'POST', body: { requests } });
}

function spreadsheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

// ----- Connected spreadsheet ---------------------------------------------

async function trackerId() {
  const { spreadsheetId } = await chrome.storage.local.get('spreadsheetId');
  if (!spreadsheetId) throw new SheetsError('NOT_CONNECTED');
  return spreadsheetId;
}

async function useTracker(id) {
  await chrome.storage.local.set({ spreadsheetId: id, statusSnapshot: {} });
  await chrome.storage.session.remove('linkCache');
}

async function forgetTracker() {
  await chrome.storage.local.remove(['spreadsheetId', 'statusSnapshot']);
  await chrome.storage.session.remove('linkCache');
}

/** Name and link of a spreadsheet, or SHEET_GONE when it was deleted or trashed. */
async function getTrackerInfo(id) {
  const file = await google(`${DRIVE_API}/${encodeURIComponent(id)}?fields=id,name,trashed`);
  if (file.trashed) throw new SheetsError('SHEET_GONE');
  return { id, name: file.name, url: spreadsheetUrl(id) };
}

/** A tracker this extension created before (tagged with appProperties), newest first, or null. */
async function findExistingTracker() {
  const params = new URLSearchParams({
    q: `appProperties has { key='${TRACKER_PROPERTY}' and value='1' } and trashed=false`,
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name)',
    pageSize: '10',
  });
  const res = await google(`${DRIVE_API}?${params}`);
  const file = res.files && res.files[0];
  return file ? { id: file.id, name: file.name, url: spreadsheetUrl(file.id) } : null;
}

/** Creates the fully formatted tracker in the user's Drive and tags it so findExistingTracker can see it. */
async function createTrackerSpreadsheet() {
  const created = await google(SHEETS_API, {
    method: 'POST',
    body: {
      properties: { title: TRACKER_TITLE },
      sheets: [
        { properties: { sheetId: APPLICATIONS_ID, title: SHEET_NAME, gridProperties: { rowCount: PREFORMATTED_ROWS + 1, columnCount: HEADERS.length } } },
        { properties: { sheetId: SUMMARY_ID, title: SUMMARY_NAME } },
      ],
    },
  });
  const id = created.spreadsheetId;
  await batchUpdate(id, setupRequests());
  await google(`${DRIVE_API}/${id}?fields=id`, { method: 'PATCH', body: { appProperties: { [TRACKER_PROPERTY]: '1' } } });
  return { id, name: TRACKER_TITLE, url: spreadsheetUrl(id) };
}

/** The Applications tab's id and size. */
async function applicationsSheet(id) {
  const res = await google(`${SHEETS_API}/${id}?fields=sheets.properties(sheetId,title,gridProperties.rowCount)`);
  const props = (res.sheets || []).map((s) => s.properties).find((p) => p && p.title === SHEET_NAME);
  if (!props) throw new SheetsError('SETUP_REQUIRED');
  return { sheetId: props.sheetId, rowCount: props.gridProperties.rowCount };
}

// ----- Saving and lookup --------------------------------------------------

async function appendJob(job) {
  const problem = validateJob(job);
  if (problem) throw new SheetsError('BAD_REQUEST', problem);
  const id = await trackerId();
  const sheet = await applicationsSheet(id);
  const values = jobToRow(job);
  const res = await google(valuesUrl(id, `${SHEET_NAME}!A:L`, ':append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE'), {
    method: 'POST',
    body: { values: [values] },
  });
  const match = /![A-Z]+(\d+)/.exec((res.updates && res.updates.updatedRange) || '');
  if (!match) throw new SheetsError('GOOGLE_ERROR', 'The sheet did not say which row it wrote.');
  const row = Number(match[1]);
  if (sheet.rowCount - row < MIN_FREE_ROWS) await topUpRows(id, sheet, row);
  await rememberSavedRow(id, row, values);
  return { row, sheetUrl: `${spreadsheetUrl(id)}#gid=${sheet.sheetId}&range=A${row}` };
}

// ponytail: the new rows go just below the row we wrote, inside every formatted range, so they inherit its
// formats and the dropdowns, colors and filter stretch over them. Rows typed past the grid by hand stay plain.
function topUpRows(id, sheet, row) {
  const start = Math.min(row, sheet.rowCount - 1);
  return batchUpdate(id, [{
    insertDimension: {
      range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: start, endIndex: start + TOP_UP_ROWS },
      inheritFromBefore: true,
    },
  }]);
}

/** Keeps the cached link column current after a save, and records the row's status for the daily upkeep. */
async function rememberSavedRow(id, row, values) {
  const link = values[COL.link - 1];
  const { linkCache } = await chrome.storage.session.get('linkCache');
  if (linkCache && linkCache.id === id) {
    linkCache.links[row - 2] = link;
    await chrome.storage.session.set({ linkCache });
  }
  const { statusSnapshot = {} } = await chrome.storage.local.get('statusSnapshot');
  let n = 0;
  while (Object.hasOwn(statusSnapshot, snapshotKey(link, n))) n++;
  statusSnapshot[snapshotKey(link, n)] = values[COL.status - 1];
  await chrome.storage.local.set({ statusSnapshot });
}

/** The Job Link column, cached briefly so opening the panel on several jobs doesn't re-read it each time. */
async function jobLinks(id) {
  const { linkCache } = await chrome.storage.session.get('linkCache');
  if (linkCache && linkCache.id === id && Date.now() - linkCache.at < LINK_CACHE_MS) return linkCache.links;
  const res = await google(valuesUrl(id, `${SHEET_NAME}!J2:J`));
  const links = (res.values || []).map((r) => cellText(r[0]));
  await chrome.storage.session.set({ linkCache: { id, links, at: Date.now() } });
  return links;
}

/** The newest row whose normalized Job Link matches, with its date and status as the sheet shows them. */
async function findByLink(url) {
  const target = normalizeLink(url);
  if (!target) throw new SheetsError('BAD_REQUEST', 'Missing url.');
  const id = await trackerId();
  const links = await jobLinks(id);
  for (let i = links.length - 1; i >= 0; i--) {
    if (normalizeLink(links[i]) !== target) continue;
    const row = i + 2;
    const res = await google(valuesUrl(id, `${SHEET_NAME}!A${row}:L${row}`));
    const cells = (res.values && res.values[0]) || [];
    return {
      found: true,
      row,
      appliedDate: cellText(cells[COL.applied - 1]),
      status: cellText(cells[COL.status - 1]) || 'N/A',
    };
  }
  return { found: false };
}

// ----- Daily upkeep (run from a chrome.alarms alarm) ---------------------------

/**
 * Marks stale rows Ghosted and stamps Last Updated after a manual Status change. Status changes are
 * found by comparing every row with the snapshot taken on the previous run. The snapshot is saved only
 * after the sheet was written, so a failed run is retried in full next time.
 */
async function runUpkeep(settings) {
  const { spreadsheetId: id, statusSnapshot = {} } = await chrome.storage.local.get(['spreadsheetId', 'statusSnapshot']);
  if (!id) return 0;
  const res = await google(valuesUrl(id, `${SHEET_NAME}!A2:L`, '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'));
  const { data, snapshot } = planUpkeep(res.values || [], statusSnapshot, settings);
  if (data.length) {
    await google(`${SHEETS_API}/${id}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'USER_ENTERED', data } });
  }
  await chrome.storage.local.set({ statusSnapshot: snapshot });
  return data.length;
}

/**
 * Pure: the cell writes for one upkeep run, and the next snapshot. rows are Applications!A2:L as
 * unformatted values, so dates are serial numbers.
 * - A Status that differs from the snapshot was changed by hand: Last Updated becomes today.
 * - Otherwise an Applied or OA / Assessment row whose Last Updated (or Applied Date) is older than
 *   ghostAfterDays becomes Ghosted, and Last Updated becomes today. Rows without a date are left alone.
 */
function planUpkeep(rows, previous, { autoGhost = true, ghostAfterDays = 30, today = new Date() } = {}) {
  const todayIso = isoDate(today);
  const cutoff = toSerial(todayIso) - ghostAfterDays;
  const seen = {};
  const snapshot = {};
  const data = [];
  rows.forEach((cells, i) => {
    const row = i + 2;
    const link = cellText(cells[COL.link - 1]);
    let status = cellText(cells[COL.status - 1]);
    let key = '';
    if (link) {
      seen[link] = (seen[link] || 0) + 1;
      key = snapshotKey(link, seen[link] - 1);
    }
    let stamp = Boolean(key && status && Object.hasOwn(previous, key) && previous[key] !== status);
    if (!stamp && autoGhost && GHOSTABLE_STATUSES.includes(status)) {
      const last = toSerial(cells[COL.updated - 1]) || toSerial(cells[COL.applied - 1]);
      if (last && last < cutoff) {
        status = 'Ghosted';
        data.push({ range: `${SHEET_NAME}!D${row}`, values: [[status]] });
        stamp = true;
      }
    }
    if (stamp) data.push({ range: `${SHEET_NAME}!K${row}`, values: [[todayIso]] });
    if (key) snapshot[key] = status;
  });
  return { data, snapshot };
}

/** Snapshot key for the nth row (0-based) with this Job Link, so a job saved twice keeps two entries. */
// ponytail: keyed by link and position; deleting one of several rows with the same link can stamp the other once.
function snapshotKey(link, n) {
  return n ? `${link} #${n + 1}` : link;
}

/** A spreadsheet date serial number from a serial, or from a date typed as text. 0 when there is none. */
function toSerial(value) {
  if (typeof value === 'number') return value;
  const time = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? 0 : (time - SERIAL_EPOCH) / DAY_MS;
}

// ----- Rows ---------------------------------------------------------------

function validateJob(job) {
  if (!job || typeof job !== 'object') return 'Missing job.';
  if (!cellText(job.company) && !cellText(job.role)) return 'Company or role is required.';
  if (!/^https?:\/\/[^\s/?#]+\.[^\s/?#]+\S*$/i.test(cellText(job.url))) return 'Job link must be a valid http(s) URL.';
  return '';
}

/** Column order must match HEADERS. Dates are ISO strings, which Sheets parses in the spreadsheet's time zone. */
function jobToRow(job) {
  return [
    safeText(job.company),
    safeText(job.role),
    appliedDate(job.appliedDate),
    oneOf(job.status, STATUSES, 'Applied'),
    oneOf(job.workMode, WORK_MODES, 'N/A'),
    safeText(job.location),
    safeText(job.yoe) || 'N/A', // the YOE column is plain text, so "2-5 yrs" never becomes a date
    safeText(job.salary),
    safeText(job.source) || 'Company Site',
    safeText(job.url),
    isoDate(new Date()),
    safeText(job.notes),
  ];
}

/** Trims, caps length and neutralises values Sheets would treat as a formula. */
function safeText(value) {
  const s = cellText(value).slice(0, MAX_FIELD_LENGTH);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function appliedDate(value) {
  const s = cellText(value);
  return /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(s) ? s : isoDate(new Date());
}

function oneOf(value, allowed, fallback) {
  const s = cellText(value);
  return allowed.includes(s) ? s : fallback;
}

/** Lower-cased link without scheme, www, hash, Workday locale, tracking parameters, /apply or trailing slash. */
function normalizeLink(value) {
  let s = cellText(value).replace(/^'/, '').toLowerCase();
  s = s.replace(/#.*$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/^([^/]*\.myworkday(?:jobs|site)\.com)\/[a-z]{2}-[a-z]{2}(?=\/)/, '$1');
  if (!s) return '';
  const q = s.indexOf('?');
  const path = (q === -1 ? s : s.slice(0, q)).replace(/\/apply\/?$/, '').replace(/\/+$/, '');
  const params = (q === -1 ? '' : s.slice(q + 1)).split('&').filter((pair) => {
    const name = pair.split('=')[0];
    return name && !name.startsWith('utm_') && !TRACKING_PARAMS.includes(name);
  });
  return params.length ? `${path}?${params.sort().join('&')}` : path;
}

function cellText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** YYYY-MM-DD in the browser's time zone. */
function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ----- Sheet layout (one batchUpdate, the same result as the old Apps Script setup) ----------

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { red: (n >> 16) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

/** 0-based, end-exclusive grid range. */
function grid(sheetId, startRow, endRow, startCol, endCol) {
  return { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol };
}

function repeatFormat(range, userEnteredFormat) {
  return { repeatCell: { range, cell: { userEnteredFormat }, fields: `userEnteredFormat(${Object.keys(userEnteredFormat).join(',')})` } };
}

function writeCells(sheetId, row, col, rows) {
  const cell = (v) => ({ userEnteredValue: String(v).startsWith('=') ? { formulaValue: v } : { stringValue: v } });
  return {
    updateCells: {
      start: { sheetId, rowIndex: row, columnIndex: col },
      rows: rows.map((r) => ({ values: r.map(cell) })),
      fields: 'userEnteredValue',
    },
  };
}

function frozenHeader(sheetId) {
  return { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } };
}

function columnWidths(sheetId, widths) {
  return widths.map((pixelSize, i) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  }));
}

const HEADER_FORMAT = {
  backgroundColor: rgb(HEADER_BACKGROUND),
  textFormat: { bold: true, foregroundColor: rgb('#ffffff') },
  verticalAlignment: 'MIDDLE',
};

function dropdown(range, values) {
  return {
    setDataValidation: {
      range,
      rule: { condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) }, strict: true, showCustomUi: true },
    },
  };
}

function setupRequests() {
  const rows = PREFORMATTED_ROWS + 1;
  const column = (c) => grid(APPLICATIONS_ID, 1, rows, c - 1, c); // data rows of a 1-based column
  return [
    // Applications: header, frozen row, widths
    writeCells(APPLICATIONS_ID, 0, 0, [HEADERS]),
    repeatFormat(grid(APPLICATIONS_ID, 0, 1, 0, HEADERS.length), HEADER_FORMAT),
    frozenHeader(APPLICATIONS_ID),
    { updateDimensionProperties: { range: { sheetId: APPLICATIONS_ID, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 32 }, fields: 'pixelSize' } },
    ...columnWidths(APPLICATIONS_ID, COLUMN_WIDTHS),
    // Data rows: plain text, dates, dropdowns, status colors, filter
    ...TEXT_COLUMNS.map((c) => repeatFormat(column(c), { numberFormat: { type: 'TEXT' } })),
    ...[COL.applied, COL.updated].map((c) => repeatFormat(column(c), { numberFormat: { type: 'DATE', pattern: DATE_FORMAT } })),
    dropdown(column(COL.status), STATUSES),
    dropdown(column(COL.workMode), WORK_MODES),
    ...STATUSES.map((status, index) => ({
      addConditionalFormatRule: {
        index,
        rule: {
          ranges: [column(COL.status)],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: status }] },
            format: { backgroundColor: rgb(STATUS_COLORS[status][0]), textFormat: { foregroundColor: rgb(STATUS_COLORS[status][1]) } },
          },
        },
      },
    })),
    { setBasicFilter: { filter: { range: grid(APPLICATIONS_ID, 0, rows, 0, HEADERS.length) } } },
    ...summaryRequests(),
  ];
}

/** Formulas only, so the Summary always reflects the current rows. */
function summaryRequests() {
  const status = `'${SHEET_NAME}'!D2:D`;
  const applied = `'${SHEET_NAME}'!C2:C`;
  const all = `'${SHEET_NAME}'!A2:L`;
  const count = (s) => `COUNTIF(${status},"${s}")`;
  const since = (days) => `=COUNTIFS(${applied},">="&(TODAY()-${days}),${status},"<>Saved")`;
  const lastStatusRow = STATUSES.length + 1;
  const percent = { numberFormat: { type: 'PERCENT', pattern: '0.0%' } };

  return [
    writeCells(SUMMARY_ID, 0, 0, [
      ['Metric', 'Value'],
      ['Total applications', `=COUNTA(${status})-${count('Saved')}`],
      ['Applied in last 7 days', since(7)],
      ['Applied in last 30 days', since(30)],
      ['Response rate', `=IFERROR((${['OA / Assessment', 'Interview', 'Offer', 'Rejected'].map(count).join('+')})/B2,0)`],
      ['Interview rate', `=IFERROR((${count('Interview')}+${count('Offer')})/B2,0)`],
      ['Offers', `=${count('Offer')}`],
    ]),
    repeatFormat(grid(SUMMARY_ID, 4, 6, 1, 2), percent),
    writeCells(SUMMARY_ID, 0, 3, [['Status', 'Count', 'Share']].concat(STATUSES.map((s, i) => (
      [s, `=${count(s)}`, `=IFERROR(E${i + 2}/SUM(E$2:E$${lastStatusRow}),0)`]
    )))),
    repeatFormat(grid(SUMMARY_ID, 1, lastStatusRow, 5, 6), percent),
    ...STATUSES.map((s, i) => repeatFormat(grid(SUMMARY_ID, i + 1, i + 2, 3, 4), {
      backgroundColor: rgb(STATUS_COLORS[s][0]),
      textFormat: { foregroundColor: rgb(STATUS_COLORS[s][1]) },
    })),
    // IFERROR: QUERY returns #N/A on a sheet with no rows yet.
    writeCells(SUMMARY_ID, 0, 7, [
      ['Source', 'Count'],
      [`=IFERROR(QUERY(${all},"select I, count(I) where I <> '' group by I order by count(I) desc label I '', count(I) ''",0),"")`],
    ]),
    ...[[0, 2], [3, 6], [7, 9]].map(([from, to]) => repeatFormat(grid(SUMMARY_ID, 0, 1, from, to), HEADER_FORMAT)),
    frozenHeader(SUMMARY_ID),
    ...columnWidths(SUMMARY_ID, [200, 90, 24, 150, 70, 70, 24, 150, 70]),
  ];
}
