'use strict';

const DEFAULT_SETTINGS = { buttonMode: 'auto', hiddenSites: [], autoGhost: true, ghostAfterDays: 30 };
/** Settings of the old Apps Script version. */
const LEGACY_SETTINGS = { webAppUrl: '', secret: '' };
const RECONNECT_ERRORS = ['SHEET_GONE', 'SIGNED_OUT', 'SETUP_REQUIRED'];

const $ = (id) => document.getElementById(id);
const els = {
  legacyNotice: $('legacy-notice'),
  stateDisconnected: $('state-disconnected'),
  stateChoose: $('state-choose'),
  stateConnected: $('state-connected'),
  connect: $('connect'),
  existingName: $('existing-name'),
  useExisting: $('use-existing'),
  createNew: $('create-new'),
  sheetName: $('sheet-name'),
  openSheet: $('open-sheet'),
  disconnect: $('disconnect'),
  status: $('connection-status'),
  autoGhost: $('auto-ghost'),
  ghostDays: $('ghost-days'),
  upkeepSaved: $('upkeep-saved'),
  modeSaved: $('mode-saved'),
  sites: $('hidden-sites'),
  noSites: $('no-hidden-sites'),
  shortcut: $('shortcut'),
  editShortcut: $('edit-shortcut'),
};

let hiddenSites = [];
let existingSheet = null;

// ----- Load ---------------------------------------------------------------

async function init() {
  let settings = { ...DEFAULT_SETTINGS, ...LEGACY_SETTINGS };
  try {
    settings = await chrome.storage.sync.get(settings);
  } catch {
    showStatus('error', "Couldn't read your settings. Try reopening this page.");
  }
  if (settings.webAppUrl || settings.secret) {
    // One-time notice: the old settings are removed right away, so it never shows again.
    els.legacyNotice.hidden = false;
    chrome.storage.sync.remove(Object.keys(LEGACY_SETTINGS)).catch(() => {});
  }
  const mode = document.querySelector(`input[name="buttonMode"][value="${settings.buttonMode}"]`)
    || document.querySelector('input[name="buttonMode"][value="auto"]');
  mode.checked = true;
  els.autoGhost.checked = settings.autoGhost !== false;
  els.ghostDays.value = String(settings.ghostAfterDays);
  renderHiddenSites(settings.hiddenSites);
  showShortcut();
  await refreshConnection();
}

async function showShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const action = commands.find((c) => c.name === '_execute_action');
    els.shortcut.textContent = (action && action.shortcut) || 'not set';
  } catch {
    // Keep the default text.
  }
}

// ----- Connection ---------------------------------------------------------

async function refreshConnection() {
  const res = await ask({ type: 'status' });
  if (res.ok && res.connected) showConnected(res.sheet);
  else if (res.ok) showState('disconnected');
  else failed(res);
}

/** Signs in (Google's consent screen on first use), then finds or creates the tracker. */
async function connect() {
  setBusy(true);
  showStatus('', 'Waiting for Google…');
  const res = await ask({ type: 'connect' });
  setBusy(false);
  if (!res.ok) return failed(res);
  if (res.existing) {
    existingSheet = res.existing;
    els.existingName.textContent = res.existing.name;
    showState('choose');
    showStatus('', '');
    els.useExisting.focus();
    return;
  }
  showConnected(res.sheet, `Created “${res.sheet.name}” in your Google Drive.`);
}

async function useExisting() {
  if (!existingSheet) return;
  await finishConnect({ type: 'use-sheet', id: existingSheet.id }, 'Connected to your existing sheet.');
}

async function createNew() {
  await finishConnect({ type: 'create-sheet' }, 'Created a new sheet in your Google Drive.');
}

async function finishConnect(message, note) {
  setBusy(true);
  showStatus('', 'Working…');
  const res = await ask(message);
  setBusy(false);
  if (res.ok) showConnected(res.sheet, note);
  else failed(res);
}

async function disconnect() {
  setBusy(true);
  const res = await ask({ type: 'disconnect' });
  setBusy(false);
  if (!res.ok) return failed(res);
  showState('disconnected');
  showStatus('ok', 'Disconnected. Your sheet stays in your Google Drive.');
  els.connect.focus();
}

function showConnected(sheet, note = '') {
  els.sheetName.textContent = sheet.name || 'your sheet';
  const url = String(sheet.url || '');
  els.openSheet.href = url.startsWith('https://docs.google.com/') ? url : 'https://docs.google.com/spreadsheets/';
  showState('connected');
  showStatus(note ? 'ok' : '', note);
}

/** Shows the error; when the sheet or sign-in is the problem, the main button offers to reconnect. */
function failed(res) {
  const reconnect = RECONNECT_ERRORS.includes(res.error);
  if (reconnect || els.stateConnected.hidden) showState('disconnected', reconnect);
  const detail = res.detail && res.error !== 'BAD_REQUEST' ? ` Google said: ${res.detail}` : '';
  showStatus('error', `${res.message || 'Something went wrong.'}${detail}`);
}

function showState(name, reconnect = false) {
  els.stateDisconnected.hidden = name !== 'disconnected';
  els.stateChoose.hidden = name !== 'choose';
  els.stateConnected.hidden = name !== 'connected';
  els.connect.textContent = reconnect ? 'Reconnect' : 'Connect Google Sheets';
}

function setBusy(on) {
  for (const button of [els.connect, els.useExisting, els.createNew, els.disconnect]) button.disabled = on;
}

async function ask(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || { ok: false, message: 'No reply from the extension.' };
  } catch {
    return { ok: false, message: "Couldn't reach the extension's background worker. Reload the extension and try again." };
  }
}

function showStatus(kind, message) {
  els.status.className = `status ${kind}`.trim();
  els.status.textContent = message;
  els.status.hidden = !message;
}

// ----- Automatic upkeep ---------------------------------------------------

async function saveUpkeep() {
  const days = Number(els.ghostDays.value);
  const valid = Number.isInteger(days) && days >= 1 && days <= 365;
  els.ghostDays.setAttribute('aria-invalid', String(!valid));
  if (!valid) {
    flashNote(els.upkeepSaved, 'Enter a whole number of days between 1 and 365.');
    return;
  }
  try {
    await chrome.storage.sync.set({ autoGhost: els.autoGhost.checked, ghostAfterDays: days });
    flashNote(els.upkeepSaved, 'Saved');
  } catch {
    flashNote(els.upkeepSaved, "Couldn't save. Try again.");
  }
}

const noteTimers = new Map();

function flashNote(el, text) {
  el.textContent = text;
  clearTimeout(noteTimers.get(el));
  noteTimers.set(el, setTimeout(() => { el.textContent = ''; }, 2500));
}

// ----- Button mode --------------------------------------------------------

async function saveMode(event) {
  if (event.target.name !== 'buttonMode') return;
  try {
    await chrome.storage.sync.set({ buttonMode: event.target.value });
    flashNote(els.modeSaved, 'Saved');
  } catch {
    flashNote(els.modeSaved, "Couldn't save. Try again.");
  }
}

// ----- Hidden sites -------------------------------------------------------

function renderHiddenSites(sites) {
  hiddenSites = Array.isArray(sites) ? [...sites].sort() : [];
  els.sites.replaceChildren(...hiddenSites.map((site) => {
    const item = document.createElement('li');
    const name = document.createElement('code');
    name.textContent = site;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Show the button on ${site} again`);
    remove.addEventListener('click', () => removeSite(site));
    item.append(name, remove);
    return item;
  }));
  els.noSites.hidden = hiddenSites.length > 0;
}

async function removeSite(site) {
  const next = hiddenSites.filter((s) => s !== site);
  try {
    await chrome.storage.sync.set({ hiddenSites: next });
    renderHiddenSites(next);
  } catch {
    showStatus('error', "Couldn't update hidden sites. Try again.");
  }
}

// ----- Wire up ------------------------------------------------------------

els.connect.addEventListener('click', connect);
els.useExisting.addEventListener('click', useExisting);
els.createNew.addEventListener('click', createNew);
els.disconnect.addEventListener('click', disconnect);
els.autoGhost.addEventListener('change', saveUpkeep);
els.ghostDays.addEventListener('change', saveUpkeep);
document.getElementById('button-mode').addEventListener('change', saveMode);
els.editShortcut.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {
    showStatus('error', 'Open chrome://extensions/shortcuts in a new tab to change the shortcut.');
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.hiddenSites) renderHiddenSites(changes.hiddenSites.newValue);
});

init();
