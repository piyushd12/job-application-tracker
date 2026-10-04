# Manual QA checklist

`npm test` covers the extractor, the panel logic, the options page, the service worker and the Sheets layer with mocks. It cannot cover real job sites (which change their markup), real Google sign-in and APIs, or how the panel looks and behaves in a browser. Run this checklist before a release and after any change to `ui.js`, `background.js`, `lib/sheets.js`, the options page or the site readers.

Tick each box. When something fails, note the URL, the browser version and what you saw.

## 0. Preparation

- [ ] `npm test` passes.
- [ ] Google sign-in is configured as in [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md): both client IDs are filled in, the manifest `key` gives the ID registered on both clients, and your test account is a test user on the consent screen.
- [ ] The extension is loaded unpacked from `extension/` in Chrome (also repeat sections 0–3 in Edge and Brave before a major release, which use the web sign-in flow).
- [ ] `chrome://extensions` shows no errors for the extension (the **Errors** button is absent).

### Connect, reconnect, disconnect

- [ ] **First install:** the settings page opens by itself with a single **Connect Google Sheets** button.
- [ ] Click it → Google's consent screen lists only "See, edit, create, and delete only the specific Google Drive files you use with this app" → approve → **✓ Connected to "Job Applications Tracker"**. **Open sheet** opens it.
- [ ] The sheet has **Applications** (12 headers, dark header row, frozen row 1, filter, Status and Work Mode dropdowns) and **Summary** (zeros, no `#N/A`, `#DIV/0!` or `#REF!`).
- [ ] In Google Drive, the file shows up as created by you, with no other access requested.
- [ ] **Disconnect** → back to **Connect Google Sheets**. At [myaccount.google.com/permissions](https://myaccount.google.com/permissions) the app no longer has access.
- [ ] **Connect** again → "You already have a tracker sheet…" with **Use existing sheet** and **Create new**. Both work; **Create new** makes a second spreadsheet.
- [ ] **Cancel** the consent screen → a red message, and the button still works.
- [ ] **Deleted sheet:** move the connected sheet to the trash and reload the settings page → the error says the sheet can't be opened, and the button reads **Reconnect**. Saving from the panel shows the same message with a **Settings** button.
- [ ] **Old settings:** with the previous version's `webAppUrl` saved (or set it from the DevTools console of the options page: `chrome.storage.sync.set({webAppUrl:'x'})`), reload the settings page → the one-time notice appears; reload again → it's gone.
- [ ] **Edge / Brave:** Connect opens a Google sign-in window (not Chrome's account picker), and saving still works more than an hour later while you stay signed in to Google in that browser.

## 1. One real job page per supported site

For each site, open a current job posting (search the site for any common role, such as "software engineer"). Check that the floating **Save job** tab appears, open the panel, and compare every field with the page. Then click **Save** and check the new row in the sheet.

| Site | Page to open | Also check |
|---|---|---|
| LinkedIn | A job at `linkedin.com/jobs/view/<id>` | Workplace type (Remote/Hybrid/On-site) matches the pill |
| LinkedIn search | `linkedin.com/jobs/search/?…` then click 3 different jobs in the list **without reloading** | Each panel shows the job currently selected, never the previous one; Job Link is `…/jobs/view/<id>` |
| Naukri | `naukri.com/job-listings-…` | YOE matches the experience chip (`3-5 Yrs` → `3-5 yrs`); "Not disclosed" salary leaves Salary blank; several cities are separated by `;` |
| Indeed | `<country>.indeed.com/viewjob?jk=…` and a search page with `vjk=` | Job Link is `…/viewjob?jk=<id>` in both cases |
| Glassdoor | `glassdoor.<tld>/job-listing/…` | Company has no trailing rating like `4.1 ★` |
| Greenhouse | `job-boards.greenhouse.io/<company>/jobs/<id>` or `boards.greenhouse.io/…` | Company is the display name, not the URL slug |
| Greenhouse embed | A company careers page whose URL has `?gh_jid=<id>` | Tab appears; Company and Job Link (with `gh_jid`) are filled; Role may need typing |
| Lever | `jobs.lever.co/<company>/<uuid>` | Work mode from the workplace-type label; `/apply` is removed from Job Link |
| Workday | `<tenant>.wd<N>.myworkdayjobs.com/<locale>/<site>/job/…` | Job Link has no `/en-US/` locale; several locations joined with `;` |
| Ashby | `jobs.ashbyhq.com/<company>/<uuid>` | Location Type gives the work mode |
| Any other career site | A company page that publishes JobPosting structured data | Fields come from structured data; Source is **Company Site** |

## 2. Saving, duplicates and the sheet

- [ ] After saving, the panel shows **Saved to row N** and **Open sheet** opens the sheet at that row.
- [ ] Reopen the panel on the same job: a yellow banner says **Already saved on <date>, status Applied**. Saving again adds a second row.
- [ ] Open the same job through a link with tracking parameters (`?utm_source=x`, LinkedIn `?trk=…`): the duplicate banner still appears.
- [ ] Change the Job Link in the panel to another saved job's link and tab out: the banner updates.
- [ ] In the sheet: Applied Date shows as `03 Oct 2026` style (a real date, right-aligned), YOE `2-5 yrs` stays text, Status and Work Mode have dropdowns, Status cells are colored, and the new row is inside the filter.
- [ ] A Company or Notes value starting with `=`, `+`, `-` or `@` (type one in the panel) is stored as text, not run as a formula.
- [ ] **Format → Conditional formatting** on the Status column shows 8 rules.

### Daily upkeep

The alarm runs a minute after the browser starts, then daily. To run it on demand, open the service worker's DevTools (`chrome://extensions` → **service worker**) and run `upkeep()`.

- [ ] Change a row's Status in the sheet, run `upkeep()` → that row's **Last Updated** becomes today; other rows don't change.
- [ ] Set a test row (Applied) to a Last Updated 40 days ago, run `upkeep()` → it becomes **Ghosted** with today's Last Updated. A row with no dates is left alone.
- [ ] Turn **Mark … as Ghosted** off in the settings, repeat → nothing is ghosted. Set the days to 10 → a 15-day-old Applied row is ghosted.
- [ ] Change a Status, quit the browser, start it again and wait a minute → that row's Last Updated is today. In the service worker console, `await chrome.alarms.getAll()` lists `daily-upkeep`.

## 3. Errors

Each error appears in the panel's red banner with a **Settings** button, or in the options page status line.

- [ ] **Not connected:** Disconnect, then click the toolbar icon → the settings page opens. Open the panel with the floating tab → "Connect Google Sheets in Settings first."
- [ ] **Signed out:** remove the app at myaccount.google.com/permissions, then save from the panel → "Google sign-in is needed…" (Chrome may need a minute to drop its cached token).
- [ ] **Renamed tab:** rename **Applications** to something else, save → the "no Applications tab" message. Rename it back.
- [ ] **Offline:** turn on DevTools → Network → Offline on the service worker (or disconnect) → "Couldn't reach Google…".
- [ ] **Extension reloaded:** with a job page open, reload the extension in `chrome://extensions`, then click Save in the already-open panel → "The extension was updated. Reload this page and try again." After reloading the page, everything works and only one tab is visible.

## 4. Toolbar, shortcut and button modes

- [ ] **Alt+Shift+J** on a non-job page (for example a news article) opens the panel.
- [ ] A tab that was open **before** the extension was installed: the toolbar icon opens the panel without reloading the page.
- [ ] On `chrome://extensions`, the Chrome Web Store and a PDF, the icon shows a red **!** badge with an explanatory tooltip, and nothing else happens. The badge disappears after navigating.
- [ ] **Auto** mode: the tab appears on job pages and not on, say, a search engine results page or a news site.
- [ ] **Always** mode: the tab appears everywhere. **Never** mode: the tab never appears, and the icon and shortcut still work.
- [ ] Click the **×** on the tab: it disappears on that site and the site shows up under **Hidden sites** in settings. **Remove** brings it back without reloading the page.

## 5. Keyboard, focus and accessibility

- [ ] Keyboard only: Tab to the floating tab, press Enter → focus lands in **Company**. Tab through every field; every control is reachable and has a visible focus ring.
- [ ] Press **Esc** → the panel closes and focus returns to the floating tab.
- [ ] On LinkedIn, GitHub or Gmail, type in the panel's fields, including letters the site uses as shortcuts (`j`, `k`, `/`, `?`, `g`): nothing happens on the site.
- [ ] Open the panel while LinkedIn's Easy Apply dialog is open: you can still click into and type in the panel's fields.
- [ ] With a screen reader (VoiceOver or NVDA), each field announces its label, and the error and duplicate banners are announced.

## 6. Look and layout

- [ ] **Light mode** and **dark mode** (switch the OS theme): the panel, the floating tab and the settings page are readable, and field borders are clearly visible.
- [ ] **Short window:** use DevTools device toolbar at 320 px height (and at 320 × 568). The panel fits, its form scrolls, and Save/Cancel stay visible. The success view stays reachable.
- [ ] **Narrow window:** at 360 px width the panel fits without horizontal scrolling.
- [ ] Pages with a **fixed header** or heavy overlays (LinkedIn, Naukri, Glassdoor's sign-in prompt): the panel and tab sit above them.
- [ ] Page zoom at 200 %: still usable.
- [ ] A strict Content-Security-Policy site (for example `github.com`): the panel is styled correctly.

## 7. Performance

- [ ] On a busy non-job page (an infinite-scroll feed), DevTools → Performance shows no long tasks from the extension's content script while scrolling.
- [ ] On a LinkedIn search page, clicking through jobs quickly feels as fast as without the extension.
