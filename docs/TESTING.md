# Manual QA checklist

`npm test` covers the extractor, the panel logic, the options page, the service worker and `Code.gs` with mocks. It cannot cover real job sites (which change their markup), a real Google deployment, or how the panel looks and behaves in a browser. Run this checklist before a release and after any change to `ui.js`, `background.js`, the site readers or `Code.gs`.

Tick each box. When something fails, note the URL, the browser version and what you saw.

## 0. Preparation

- [ ] `npm test` passes.
- [ ] A **fresh test sheet** is set up as in the README (paste `Code.gs` and `appsscript.json`, run `setup`, deploy as *Execute as: Me* / *Who has access: Anyone*).
- [ ] The extension is loaded unpacked from `extension/` in Chrome (also repeat sections 1–3 in Edge and Brave before a major release).
- [ ] Settings → paste the `/exec` URL → **Test connection** shows `✓ Connected to "<sheet name>" · 0 jobs saved. Settings saved.`
- [ ] `chrome://extensions` shows no errors for the extension (the **Errors** button is absent).

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
- [ ] In the sheet: Applied Date shows as `03 Oct 2026` style (a real date, right-aligned), YOE `2-5 yrs` stays text, Status and Work Mode have dropdowns, Status cells are colored.
- [ ] A Company or Notes value starting with `=`, `+`, `-` or `@` (type one in the panel) is stored as text, not run as a formula.
- [ ] Change a Status in the sheet: **Last Updated** changes to now.
- [ ] Set a test row's Last Updated to 40 days ago, then **Job Tracker → Mark ghosted now**: that row becomes **Ghosted**. A row with no dates is left alone.
- [ ] On a fresh sheet with no rows, the **Summary** tab shows zeros and no `#N/A`, `#DIV/0!` or `#REF!` errors.
- [ ] **Job Tracker → Run setup** a second time: no duplicate tabs, colors, dropdowns or filters (check **Format → Conditional formatting** for the Status column shows 8 rules), and **Triggers** in Apps Script still lists one `markGhosted` trigger.

## 3. Errors

Each error appears in the panel's red banner with a **Settings** button, or in the options page status line.

- [ ] **No URL:** clear the URL in settings and save, then click the toolbar icon → the settings page opens. Open the panel with the floating tab → "Add your Web App URL in Settings first."
- [ ] **Not public:** redeploy with *Who has access: Only myself* → Test connection says "Google returned a sign-in page…". Restore *Anyone* afterwards.
- [ ] **/dev URL:** paste the `/dev` URL → the options page refuses it before sending anything.
- [ ] **Wrong secret:** set `SECRET = 'abc'` in Code.gs, deploy a new version, leave the extension secret empty → "The secret doesn't match…".
- [ ] **Not set up:** in a new sheet, deploy without running `setup` → Test connection warns "isn't set up yet"; saving shows the setup message.
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
