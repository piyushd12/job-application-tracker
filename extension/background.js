'use strict';

// Service worker: the only place that talks to the network. Content scripts and the options page
// send it messages; it calls Google Sheets and Drive through lib/sheets.js and replies.

importScripts('config.js', 'lib/sheets.js');

const CONTENT_SCRIPTS = ['content/extract.js', 'content/ui.js'];
const LEGACY_SETTINGS = ['webAppUrl', 'secret'];
const UNSUPPORTED_PAGE_TITLE = "Can't save from this page: browser pages, the Chrome Web Store and local files are off-limits to extensions.";

const ERROR_MESSAGES = {
  NOT_CONNECTED: 'Connect Google Sheets in Settings first.',
  SIGNED_OUT: 'Google sign-in is needed. Open Settings and click Connect Google Sheets.',
  SHEET_GONE: "Can't open your tracker sheet. It may have been deleted, or access was removed. Open Settings and click Reconnect.",
  SETUP_REQUIRED: 'Your tracker sheet has no "Applications" tab. Rename it back, or open Settings and click Reconnect to create a new sheet.',
  BUSY: 'Google Sheets is busy. Try again in a moment.',
  NETWORK: "Couldn't reach Google. Check your connection and try again.",
  GOOGLE_ERROR: 'Google Sheets returned an error. Try again in a moment.',
  BAD_REQUEST: 'The job data was rejected.',
  INTERNAL: 'Something went wrong in the extension. Try again.',
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
  const { spreadsheetId } = await chrome.storage.local.get('spreadsheetId');
  if (!spreadsheetId) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (!tab || tab.id === undefined) return;
  if (await sendToTab(tab.id, { type: 'open-panel' })) return;

  // No content script yet (tab opened before install, or after an update): inject it.
  // activeTab grants access because the user just clicked or pressed the shortcut.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS });
    if (await sendToTab(tab.id, { type: 'open-panel' })) return;
  } catch {
    // Pages like chrome://, the Web Store and file:// (without file access) can't be scripted.
  }
  await flagUnsupportedPage(tab.id);
}

/** Tells the user why nothing happened. Chrome clears per-tab badge and title when the tab navigates. */
async function flagUnsupportedPage(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b42318' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: UNSUPPORTED_PAGE_TITLE });
  } catch {
    // The tab was closed meanwhile.
  }
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
  'add-job': async ({ job }) => ({ ok: true, ...(await appendJob(job)) }),
  'check-duplicate': async ({ url }) => ({ ok: true, ...(await findByLink(url)) }),

  // Options page. Only "connect" may show Google's consent screen: it runs right after a click.
  'status': async () => {
    const { spreadsheetId } = await chrome.storage.local.get('spreadsheetId');
    if (!spreadsheetId) return { ok: true, connected: false };
    return { ok: true, connected: true, sheet: await getTrackerInfo(spreadsheetId) };
  },
  'connect': async () => {
    await getToken(true);
    const existing = await findExistingTracker();
    if (existing) return { ok: true, existing };
    return connected(await createTrackerSpreadsheet());
  },
  'use-sheet': async ({ id }) => {
    if (!/^[\w-]+$/.test(String(id || ''))) return failure('BAD_REQUEST');
    return connected(await getTrackerInfo(id));
  },
  'create-sheet': async () => connected(await createTrackerSpreadsheet()),
  'disconnect': async () => {
    await signOut();
    await forgetTracker();
    return { ok: true };
  },

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
    .catch((err) => sendResponse(ERROR_MESSAGES[err && err.code] ? failure(err.code, err.detail) : failure('INTERNAL')));
  return true; // keep the channel open for the async reply
});

async function connected(sheet) {
  await useTracker(sheet.id);
  await chrome.storage.sync.remove(LEGACY_SETTINGS);
  return { ok: true, sheet };
}

/**
 * message is what the panel and options page show. detail is Google's own wording (the options page adds it),
 * except for BAD_REQUEST, whose detail is our own validation text and part of the message.
 */
function failure(code, detail = '') {
  const message = code === 'BAD_REQUEST' && detail ? `${ERROR_MESSAGES[code]} ${detail}` : ERROR_MESSAGES[code];
  return { ok: false, error: code, message, detail };
}
