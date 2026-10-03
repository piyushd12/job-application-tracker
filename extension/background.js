'use strict';

// Service worker: the only place that talks to the network. Content scripts and the
// options page send it messages; it calls the user's Apps Script Web App and replies.

const DEFAULT_SETTINGS = { webAppUrl: '', secret: '', buttonMode: 'auto', hiddenSites: [] };
const CONTENT_SCRIPTS = ['content/extract.js', 'content/ui.js'];
const REQUEST_TIMEOUT_MS = 20000;

const ERROR_MESSAGES = {
  NOT_CONFIGURED: 'Add your Web App URL in Settings first.',
  NOT_PUBLIC: 'Google returned a sign-in page. Redeploy the Web App with "Who has access: Anyone".',
  NETWORK: "Couldn't reach Google. Check your connection and try again.",
  BAD_RESPONSE: 'Unexpected reply from the Web App. Make sure the URL is the one ending in /exec.',
  BAD_TOKEN: "The secret doesn't match the SECRET in Code.gs.",
  BAD_REQUEST: 'The job data was rejected.',
  UNKNOWN_ACTION: "The extension and Code.gs don't match. Paste the latest Code.gs and redeploy.",
  SETUP_REQUIRED: "The sheet isn't set up yet. In the sheet, choose Job Tracker → Run setup.",
  LOCK_TIMEOUT: 'The sheet is busy. Try again in a moment.',
  INTERNAL: 'Something went wrong in the script. Check Executions in the Apps Script editor.',
};

// ----- Lifecycle, toolbar and shortcut ------------------------------------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});

// Fired by the toolbar icon and by the _execute_action command (Alt+Shift+J).
chrome.action.onClicked.addListener((tab) => {
  openPanel(tab).catch(() => {});
});

async function openPanel(tab) {
  const { webAppUrl } = await getSettings();
  if (!webAppUrl) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (!tab || tab.id === undefined) return;
  if (await sendToTab(tab.id, { type: 'open-panel' })) return;

  // No content script yet (tab opened before install, or after an update): inject it.
  // activeTab grants access because the user just clicked or pressed the shortcut.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS });
  } catch {
    return; // Pages like chrome:// and the Web Store can't be scripted.
  }
  await sendToTab(tab.id, { type: 'open-panel' });
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

// ----- Message router -----------------------------------------------------

const HANDLERS = {
  'add-job': async ({ job }) => callWebApp(await getSettings(), { method: 'POST', body: { action: 'add', job } }),
  'check-duplicate': async ({ url }) => callWebApp(await getSettings(), { params: { action: 'check', url } }),
  'ping': ({ webAppUrl, secret }) => callWebApp({ webAppUrl, secret }, { params: { action: 'ping' } }),
  'open-options': async () => {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message && message.type];
  if (!handler) return false;
  handler(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse(failure('INTERNAL')));
  return true; // keep the channel open for the async reply
});

async function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

// ----- Web App client -----------------------------------------------------

/**
 * Calls the Apps Script Web App. GET puts parameters in the query string; POST sends JSON
 * as text/plain so the browser skips the CORS preflight that Apps Script can't answer.
 */
async function callWebApp({ webAppUrl, secret }, { method = 'GET', params = {}, body = {} }) {
  const base = parseWebAppUrl(webAppUrl);
  if (!base) return failure('NOT_CONFIGURED');
  const token = secret || '';

  const url = new URL(base);
  const init = { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (method === 'GET') {
    for (const [key, value] of Object.entries({ ...params, token })) url.searchParams.set(key, value ?? '');
  } else {
    init.method = 'POST';
    init.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    init.body = JSON.stringify({ ...body, token });
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (err && err.name === 'TimeoutError') return failure('NETWORK');
    return failure((await redirectsAway(base)) ? 'NOT_PUBLIC' : 'NETWORK');
  }
  return readResponse(response);
}

function parseWebAppUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && url.hostname === 'script.google.com' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A Web App that isn't shared with "Anyone" redirects to accounts.google.com. We have no host
 * permission there, so the followed fetch fails like a network error. A second request that
 * doesn't follow redirects tells the two apart: a reachable server answers with a redirect.
 */
async function redirectsAway(url) {
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return res.type === 'opaqueredirect';
  } catch {
    return false;
  }
}

async function readResponse(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return failure('NETWORK');
  }
  if (isSignInPage(response.url, text)) return failure('NOT_PUBLIC');

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return failure('BAD_RESPONSE');
  }
  if (!data || typeof data.ok !== 'boolean') return failure('BAD_RESPONSE');
  if (data.ok) return data;
  return failure(ERROR_MESSAGES[data.error] ? data.error : 'INTERNAL', data.message);
}

function isSignInPage(responseUrl, text) {
  try {
    if (new URL(responseUrl).hostname === 'accounts.google.com') return true;
  } catch {
    // No final URL; fall through to the body check.
  }
  return /^\s*</.test(text) && /accounts\.google\.com|ServiceLogin/i.test(text);
}

function failure(code, detail) {
  const message = detail ? `${ERROR_MESSAGES[code]} ${detail}` : ERROR_MESSAGES[code];
  return { ok: false, error: code, message };
}
