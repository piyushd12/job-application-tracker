/**
 * In-page UI: the floating "Save job" tab and the side panel, rendered inside a closed Shadow DOM
 * so the host page's CSS and scripts can't reach them. Uses JobExtract (extract.js, loaded first).
 * Every network call goes through the service worker.
 */
(() => {
  'use strict';

  const ROOT_ID = 'job-tracker-ext-root';

  // A re-injected copy (for example after the extension was reloaded) replaces the orphaned old UI.
  const stale = document.getElementById(ROOT_ID);
  if (stale) stale.remove();

  const Extract = globalThis.JobExtract;
  if (!Extract || !isExtensionAlive() || !(document.documentElement instanceof HTMLElement)) return;

  /** [background, text] per status. Keep in sync with STATUS_COLORS in apps-script/Code.gs. */
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
  const EXTRA_SOURCES = ['Referral', 'Recruiter', 'Email'];
  const FIELDS = ['company', 'role', 'appliedDate', 'status', 'workMode', 'location', 'yoe', 'salary', 'source', 'url', 'notes'];
  const DEFAULT_SETTINGS = { webAppUrl: '', buttonMode: 'auto', hiddenSites: [] };
  const DETECT_DEBOUNCE_MS = 500;
  const DETECT_MAX_WAIT_MS = 2000;
  const ISOLATED_EVENTS = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut'];
  const RELOADED = { ok: false, error: 'RELOADED', message: 'The extension was updated. Reload this page and try again.' };

  const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="m9 13.5 2 2 4-4"/></svg>';

  // Static markup only. Values from the page are always set later with .value / .textContent.
  const TEMPLATE = `
<style>
  :host {
    --bg: #ffffff; --fg: #1f2328; --muted: #5f6670; --border: #d6dae0; --field: #f6f8fa;
    --accent: #2563eb; --accent-fg: #ffffff; --danger: #b42318; --danger-bg: #fef3f2;
    --warn-bg: #fff4dc; --warn-fg: #7a4d00; --ok-bg: #ceead6; --ok-fg: #0d652d;
    --shadow: 0 12px 40px rgba(15, 23, 42, .18), 0 2px 6px rgba(15, 23, 42, .08);
    --scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #1d2127; --fg: #e6e8eb; --muted: #9aa3ad; --border: #3a414a; --field: #262b33;
      --accent: #6b9bff; --accent-fg: #0b1220; --danger: #ff9b91; --danger-bg: #3a1f1f;
      --warn-bg: #3a2f12; --warn-fg: #f6c86b; --ok-bg: #173b26; --ok-fg: #7ee2a8;
      --shadow: 0 12px 40px rgba(0, 0, 0, .55); --scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  .tab, .panel { color-scheme: var(--scheme); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }

  .tab { position: fixed; right: 0; top: 42%; display: flex; }
  .tab-open {
    display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border: 0;
    border-radius: 12px 0 0 12px; background: var(--accent); color: var(--accent-fg);
    font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; cursor: pointer; box-shadow: var(--shadow);
  }
  .tab-label { max-width: 0; overflow: hidden; white-space: nowrap; transition: max-width .2s ease; }
  .tab:hover .tab-label, .tab:focus-within .tab-label { max-width: 120px; }
  .tab-hide {
    position: absolute; top: -8px; left: -8px; width: 20px; height: 20px; padding: 0; display: grid; place-items: center;
    border: 1px solid var(--border); border-radius: 50%; background: var(--bg); color: var(--muted);
    font: 600 14px/1 system-ui, sans-serif; cursor: pointer; opacity: 0; transition: opacity .15s;
  }
  .tab:hover .tab-hide, .tab:focus-within .tab-hide { opacity: 1; }
  .tab-open:focus-visible, .tab-hide:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }

  .panel {
    position: fixed; top: 12px; right: 12px; bottom: 12px; width: 380px; max-width: calc(100vw - 24px);
    display: flex; flex-direction: column; overflow: hidden; background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); animation: slide-in .18s ease-out;
  }
  @keyframes slide-in { from { transform: translateX(16px); opacity: 0; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .panel { animation: none; } .tab-label, .tab-hide { transition: none; } }

  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 15px; font-weight: 650; }
  .icon-button { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: 20px/1 system-ui, sans-serif; cursor: pointer; }
  .icon-button:hover { background: var(--field); color: var(--fg); }

  form { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .body { flex: 1; overflow-y: auto; padding: 14px 16px 16px; }
  .banner { margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
  .banner.warn { background: var(--warn-bg); color: var(--warn-fg); }
  .banner.error { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; background: var(--danger-bg); color: var(--danger); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .full { grid-column: 1 / -1; }
  .field > span:first-child { font-size: 12px; font-weight: 600; color: var(--muted); }
  input, select, textarea {
    width: 100%; min-width: 0; padding: 7px 9px; font: inherit; color: inherit;
    background: var(--field); border: 1px solid var(--border); border-radius: 8px;
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  [aria-invalid="true"] { border-color: var(--danger); }
  textarea { resize: vertical; min-height: 64px; }
  .hint { margin: -4px 0 0; font-size: 12px; color: var(--danger); }
  .status-wrap { position: relative; display: block; }
  .status-wrap select { padding-left: 28px; }
  .dot { position: absolute; left: 10px; top: 50%; width: 11px; height: 11px; border-radius: 50%; transform: translateY(-50%); pointer-events: none; }

  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
  button.primary, button.secondary { padding: 8px 16px; border-radius: 8px; font: 600 14px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; cursor: pointer; }
  button.primary { border: 0; background: var(--accent); color: var(--accent-fg); }
  button.secondary { border: 1px solid var(--border); background: transparent; color: var(--fg); }
  button.link { flex: none; padding: 0; border: 0; background: none; color: inherit; font: 600 13px/1.4 inherit; text-decoration: underline; cursor: pointer; }
  button:disabled { opacity: .65; cursor: progress; }
  .busy::before {
    content: ""; display: inline-block; width: 12px; height: 12px; margin-right: 8px; vertical-align: -1px;
    border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite;
  }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .success { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px 16px; text-align: center; }
  .check { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 50%; background: var(--ok-bg); color: var(--ok-fg); font-size: 26px; }
  .success p { margin: 0; font-size: 15px; }
  .success a { color: var(--accent); font-weight: 600; }
</style>
<div class="tab" hidden>
  <button class="tab-open" type="button" aria-label="Save this job to your sheet">${ICON}<span class="tab-label">Save job</span></button>
  <button class="tab-hide" type="button" aria-label="Hide this button on this site" title="Hide on this site">×</button>
</div>
<section class="panel" role="dialog" aria-labelledby="jt-title" hidden>
  <header>
    <h2 id="jt-title">Save job</h2>
    <button class="icon-button close" type="button" aria-label="Close (Esc)" title="Close (Esc)">×</button>
  </header>
  <form novalidate>
    <div class="body">
      <p class="banner warn duplicate" role="status" hidden></p>
      <div class="banner error" role="alert" hidden>
        <span class="error-text"></span>
        <button class="link settings" type="button">Settings</button>
      </div>
      <div class="grid">
        <label class="field full"><span>Company</span><input name="company" autocomplete="off"></label>
        <label class="field full"><span>Role</span><input name="role" autocomplete="off"></label>
        <p class="hint full" data-for="name" hidden></p>
        <label class="field"><span>Applied Date</span><input name="appliedDate" type="date"></label>
        <label class="field"><span>Status</span><span class="status-wrap"><span class="dot"></span><select name="status"></select></span></label>
        <label class="field"><span>Work Mode</span><select name="workMode"></select></label>
        <label class="field"><span>YOE</span><input name="yoe" autocomplete="off" placeholder="e.g. 2-5 yrs"></label>
        <label class="field full"><span>Location</span><input name="location" autocomplete="off"></label>
        <label class="field"><span>Salary / CTC</span><input name="salary" autocomplete="off"></label>
        <label class="field"><span>Source</span><input name="source" list="jt-sources" autocomplete="off"></label>
        <label class="field full"><span>Job Link</span><input name="url" type="url" autocomplete="off" spellcheck="false"></label>
        <p class="hint full" data-for="url" hidden></p>
        <label class="field full"><span>Notes</span><textarea name="notes" rows="3" placeholder="Referral, recruiter, next steps…"></textarea></label>
      </div>
      <datalist id="jt-sources"></datalist>
    </div>
    <footer>
      <button class="secondary cancel" type="button">Cancel</button>
      <button class="primary save" type="submit">Save</button>
    </footer>
  </form>
  <div class="success" hidden>
    <div class="check" aria-hidden="true">✓</div>
    <p role="status">Saved to row <strong class="row-number"></strong></p>
    <a class="open-sheet" target="_blank" rel="noopener noreferrer">Open sheet</a>
    <button class="secondary done" type="button">Done</button>
  </div>
</section>`;

  // ----- Mount ------------------------------------------------------------

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'all: initial !important; position: fixed !important; top: 0 !important; right: 0 !important;'
    + ' width: 0 !important; height: 0 !important; z-index: 2147483647 !important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = TEMPLATE;

  const $ = (selector) => shadow.querySelector(selector);
  const ui = {
    tab: $('.tab'), openButton: $('.tab-open'), hideButton: $('.tab-hide'),
    panel: $('.panel'), closeButton: $('.close'), form: $('form'), cancelButton: $('.cancel'), saveButton: $('.save'),
    duplicate: $('.duplicate'), errorBanner: $('.banner.error'), errorText: $('.error-text'), settingsButton: $('.settings'),
    dot: $('.dot'), success: $('.success'), rowNumber: $('.row-number'), openSheet: $('.open-sheet'), doneButton: $('.done'),
  };
  const field = (name) => ui.form.elements.namedItem(name);

  for (const status of Object.keys(STATUS_COLORS)) field('status').append(new Option(status, status));
  for (const mode of WORK_MODES) field('workMode').append(new Option(mode, mode));
  for (const source of [...Extract.SOURCE_NAMES, ...EXTRA_SOURCES]) {
    const option = document.createElement('option');
    option.value = source;
    $('#jt-sources').append(option);
  }

  let settings = { ...DEFAULT_SETTINGS };
  let isJobPage = false;
  let panelOpen = false;
  let saving = false;
  let lastUrl = '';
  let duplicateRequest = 0;
  let detectTimer = 0;
  let firstPendingAt = 0;

  // ----- Settings ---------------------------------------------------------

  async function loadSettings() {
    try {
      settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    } catch {
      // Keep defaults; the tab still works in auto mode.
    }
    renderTab();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULT_SETTINGS) settings[key] = newValue ?? DEFAULT_SETTINGS[key];
    }
    renderTab();
  }

  function isHiddenSite() {
    return Array.isArray(settings.hiddenSites) && settings.hiddenSites.includes(location.hostname);
  }

  function renderTab() {
    const mode = settings.buttonMode;
    const wanted = mode === 'always' || (mode !== 'never' && isJobPage);
    ui.tab.hidden = panelOpen || isHiddenSite() || !wanted;
  }

  async function hideOnThisSite() {
    ui.tab.hidden = true;
    const sites = new Set(Array.isArray(settings.hiddenSites) ? settings.hiddenSites : []);
    sites.add(location.hostname);
    settings.hiddenSites = [...sites];
    try {
      await chrome.storage.sync.set({ hiddenSites: settings.hiddenSites });
    } catch {
      // Still hidden for this page view.
    }
  }

  // ----- Job detection (URL changes and DOM mutations, debounced) ------------

  function detect() {
    lastUrl = location.href;
    try {
      isJobPage = Extract.isLikelyJobPage(document, location.href);
    } catch {
      isJobPage = false;
    }
    renderTab();
  }

  function onPageChange() {
    if (!isExtensionAlive()) {
      teardown();
      return;
    }
    if (!host.isConnected) document.documentElement.append(host);
    if (location.href === lastUrl && isJobPage) return;
    detect();
  }

  /** Debounced, but never postponed longer than DETECT_MAX_WAIT_MS on pages that mutate constantly. */
  function scheduleDetect() {
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    clearTimeout(detectTimer);
    const wait = now - firstPendingAt >= DETECT_MAX_WAIT_MS ? 0 : DETECT_DEBOUNCE_MS;
    detectTimer = setTimeout(() => {
      firstPendingAt = 0;
      onPageChange();
    }, wait);
  }

  const observer = new MutationObserver(scheduleDetect);

  // ----- Panel ------------------------------------------------------------

  function openPanel() {
    let job;
    try {
      job = Extract.extractJob(document, location.href);
    } catch {
      job = { role: document.title, url: location.href, status: 'Applied', workMode: 'N/A', yoe: 'N/A', source: 'Company Site' };
    }
    fillForm(job);
    ui.form.hidden = false;
    ui.success.hidden = true;
    hideError();
    clearFieldErrors();
    setSaving(false);
    panelOpen = true;
    ui.panel.hidden = false;
    renderTab();
    field('company').focus({ preventScroll: true });
    checkDuplicate(job.url);
  }

  function closePanel() {
    panelOpen = false;
    duplicateRequest++; // ignore any reply still in flight
    ui.panel.hidden = true;
    renderTab();
  }

  function fillForm(job) {
    for (const name of FIELDS) field(name).value = job[name] ?? '';
    if (!field('appliedDate').value) field('appliedDate').value = localToday();
    if (!STATUS_COLORS[field('status').value]) field('status').value = 'Applied';
    if (!WORK_MODES.includes(field('workMode').value)) field('workMode').value = 'N/A';
    updateStatusDot();
  }

  function readForm() {
    const job = {};
    for (const name of FIELDS) job[name] = field(name).value.trim();
    return job;
  }

  function updateStatusDot() {
    const [background, text] = STATUS_COLORS[field('status').value] || STATUS_COLORS.Applied;
    ui.dot.style.background = background;
    ui.dot.style.boxShadow = `inset 0 0 0 2px ${text}`;
  }

  async function checkDuplicate(url) {
    const request = ++duplicateRequest;
    ui.duplicate.hidden = true;
    if (!isHttpUrl(url)) return;
    const res = await sendMessage({ type: 'check-duplicate', url });
    if (request !== duplicateRequest || !panelOpen) return;
    if (!res.ok) {
      showError(res);
      return;
    }
    if (res.found) {
      ui.duplicate.textContent = `Already saved on ${res.appliedDate || 'an earlier date'}, status ${res.status || 'unknown'}. Saving again adds a new row.`;
      ui.duplicate.hidden = false;
    }
  }

  function onLinkChanged() {
    const input = field('url');
    if (isHttpUrl(input.value.trim())) input.value = Extract.canonicalUrl(input.value.trim());
    checkDuplicate(input.value);
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (saving) return;
    const job = readForm();
    if (!validate(job)) return;

    hideError();
    setSaving(true);
    const res = await sendMessage({ type: 'add-job', job });
    setSaving(false);
    if (!panelOpen) return;
    if (res.ok) showSuccess(res);
    else showError(res);
  }

  function validate(job) {
    const missingName = !job.company && !job.role;
    const badLink = !isHttpUrl(job.url);
    setFieldError(['company', 'role'], 'name', missingName ? 'Enter a company or a role.' : '');
    setFieldError(['url'], 'url', badLink ? 'Enter a valid link starting with https://' : '');
    if (missingName) field('company').focus();
    else if (badLink) field('url').focus();
    return !missingName && !badLink;
  }

  function setFieldError(names, hintFor, message) {
    for (const name of names) field(name).setAttribute('aria-invalid', String(Boolean(message)));
    const hint = $(`.hint[data-for="${hintFor}"]`);
    hint.textContent = message;
    hint.hidden = !message;
  }

  function clearFieldErrors() {
    setFieldError(['company', 'role'], 'name', '');
    setFieldError(['url'], 'url', '');
  }

  function onFieldInput(event) {
    const name = event.target.name;
    if (event.target.getAttribute('aria-invalid') !== 'true') return;
    if (name === 'company' || name === 'role') setFieldError(['company', 'role'], 'name', '');
    if (name === 'url') setFieldError(['url'], 'url', '');
  }

  function setSaving(on) {
    saving = on;
    ui.saveButton.disabled = on;
    ui.saveButton.classList.toggle('busy', on);
    ui.saveButton.textContent = on ? 'Saving…' : 'Save';
  }

  function showSuccess(res) {
    ui.form.hidden = true;
    ui.success.hidden = false;
    ui.rowNumber.textContent = String(res.row ?? '');
    const sheetUrl = String(res.sheetUrl || '');
    ui.openSheet.hidden = !sheetUrl.startsWith('https://docs.google.com/');
    if (!ui.openSheet.hidden) ui.openSheet.href = sheetUrl;
    ui.doneButton.focus({ preventScroll: true });
  }

  function showError(res) {
    ui.errorText.textContent = res.message || 'Something went wrong. Please try again.';
    ui.errorBanner.hidden = false;
  }

  function hideError() {
    ui.errorBanner.hidden = true;
  }

  // ----- Keyboard isolation -------------------------------------------------

  // Keys typed in the panel must not trigger the site's shortcuts. Events from inside a closed
  // shadow root are retargeted to the host, so stop them there. A capture listener on window also
  // runs before the site's own document/element listeners (only window-capture listeners the page
  // registered earlier can still see the key first).
  function onWindowKey(event) {
    if (event.target !== host) return;
    if (event.type === 'keydown' && event.key === 'Escape' && panelOpen) {
      event.preventDefault();
      closePanel();
    }
    event.stopImmediatePropagation();
  }

  function stopAtHost(event) {
    event.stopPropagation();
  }

  // ----- Messaging ----------------------------------------------------------

  function isExtensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  async function sendMessage(message) {
    if (!isExtensionAlive()) return RELOADED;
    try {
      return (await chrome.runtime.sendMessage(message)) || { ok: false, error: 'INTERNAL', message: 'No reply from the extension.' };
    } catch {
      return RELOADED;
    }
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message && message.type === 'open-panel') {
      openPanel();
      sendResponse({ ok: true });
    }
    return false;
  }

  // ----- Helpers ------------------------------------------------------------

  function isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function localToday() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function teardown() {
    observer.disconnect();
    clearTimeout(detectTimer);
    window.removeEventListener('popstate', scheduleDetect);
    window.removeEventListener('hashchange', scheduleDetect);
    for (const type of ['keydown', 'keyup', 'keypress']) window.removeEventListener(type, onWindowKey, true);
    host.remove();
  }

  // ----- Wire up --------------------------------------------------------------

  ui.openButton.addEventListener('click', openPanel);
  ui.hideButton.addEventListener('click', hideOnThisSite);
  ui.closeButton.addEventListener('click', closePanel);
  ui.cancelButton.addEventListener('click', closePanel);
  ui.doneButton.addEventListener('click', closePanel);
  ui.settingsButton.addEventListener('click', () => sendMessage({ type: 'open-options' }));
  ui.form.addEventListener('submit', onSubmit);
  ui.form.addEventListener('input', onFieldInput);
  field('status').addEventListener('change', updateStatusDot);
  field('url').addEventListener('change', onLinkChanged);

  for (const type of ISOLATED_EVENTS) host.addEventListener(type, stopAtHost);
  for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, onWindowKey, true);

  window.addEventListener('popstate', scheduleDetect);
  window.addEventListener('hashchange', scheduleDetect);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  document.documentElement.append(host);
  detect();
  loadSettings();
})();
