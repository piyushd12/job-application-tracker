'use strict';

const DEFAULT_SETTINGS = { webAppUrl: '', secret: '', buttonMode: 'auto', hiddenSites: [] };
const WEB_APP_URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+\/|macros\/)s\/[\w-]+\/exec$/;

const $ = (id) => document.getElementById(id);
const els = {
  form: $('connection-form'),
  url: $('web-app-url'),
  secret: $('secret'),
  toggleSecret: $('toggle-secret'),
  test: $('test-connection'),
  status: $('connection-status'),
  modeSaved: $('mode-saved'),
  sites: $('hidden-sites'),
  noSites: $('no-hidden-sites'),
  shortcut: $('shortcut'),
  editShortcut: $('edit-shortcut'),
};

let hiddenSites = [];

// ----- Load ---------------------------------------------------------------

async function init() {
  let settings = DEFAULT_SETTINGS;
  try {
    settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  } catch {
    showStatus('error', "Couldn't read your settings. Try reopening this page.");
  }
  els.url.value = settings.webAppUrl;
  els.secret.value = settings.secret;
  const mode = document.querySelector(`input[name="buttonMode"][value="${settings.buttonMode}"]`)
    || document.querySelector('input[name="buttonMode"][value="auto"]');
  mode.checked = true;
  renderHiddenSites(settings.hiddenSites);
  showShortcut();
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

/** Returns an error message, or '' when the URL is acceptable (empty clears the setting). */
function urlProblem(value) {
  if (!value) return '';
  if (/\/dev$/.test(value)) return 'That is the /dev test URL. Use the deployed URL that ends in /exec.';
  if (!WEB_APP_URL_RE.test(value)) return 'Paste the Web App URL from Apps Script. It looks like https://script.google.com/macros/s/…/exec';
  return '';
}

function readConnection() {
  return { webAppUrl: els.url.value.trim(), secret: els.secret.value.trim() };
}

function checkUrlField(requireValue) {
  const { webAppUrl } = readConnection();
  const problem = requireValue && !webAppUrl ? 'Paste your Web App URL first.' : urlProblem(webAppUrl);
  els.url.setAttribute('aria-invalid', String(Boolean(problem)));
  if (problem) {
    showStatus('error', problem);
    els.url.focus();
  }
  return !problem;
}

async function save(event) {
  event.preventDefault();
  if (!checkUrlField(false)) return;
  try {
    await chrome.storage.sync.set(readConnection());
    showStatus('ok', readConnection().webAppUrl ? 'Saved. Use "Test connection" to check it.' : 'Saved. The extension is not connected to a sheet.');
  } catch {
    showStatus('error', "Couldn't save your settings. Try again.");
  }
}

async function testConnection() {
  if (!checkUrlField(true)) return;
  els.test.disabled = true;
  showStatus('', 'Testing…');
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'ping', ...readConnection() });
  } catch {
    res = { ok: false, message: "Couldn't reach the extension's background worker. Reload the extension and try again." };
  }
  els.test.disabled = false;

  if (!res || !res.ok) {
    showStatus('error', (res && res.message) || 'Connection failed.');
    return;
  }
  // A working connection is what the user wants to keep, so save it right away.
  const saved = await chrome.storage.sync.set(readConnection()).then(() => ' Settings saved.', () => ' Click Save to keep it.');
  if (!res.setup) {
    showStatus('warn', `Connected to “${res.sheetName}”, but the sheet isn't set up yet. In the sheet, choose Job Tracker → Run setup.${saved}`);
  } else {
    const count = res.rows === 1 ? '1 job saved' : `${res.rows} jobs saved`;
    showStatus('ok', `✓ Connected to “${res.sheetName}” · ${count}.${saved}`);
  }
}

function showStatus(kind, message) {
  els.status.className = `status ${kind}`.trim();
  els.status.textContent = message;
  els.status.hidden = !message;
}

// ----- Button mode --------------------------------------------------------

let modeNoteTimer = 0;

async function saveMode(event) {
  if (event.target.name !== 'buttonMode') return;
  try {
    await chrome.storage.sync.set({ buttonMode: event.target.value });
    els.modeSaved.textContent = 'Saved';
  } catch {
    els.modeSaved.textContent = "Couldn't save. Try again.";
  }
  clearTimeout(modeNoteTimer);
  modeNoteTimer = setTimeout(() => { els.modeSaved.textContent = ''; }, 2000);
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

els.form.addEventListener('submit', save);
els.test.addEventListener('click', testConnection);
els.url.addEventListener('input', () => els.url.setAttribute('aria-invalid', 'false'));
els.toggleSecret.addEventListener('click', () => {
  const show = els.secret.type === 'password';
  els.secret.type = show ? 'text' : 'password';
  els.toggleSecret.textContent = show ? 'Hide' : 'Show';
  els.toggleSecret.setAttribute('aria-pressed', String(show));
});
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
