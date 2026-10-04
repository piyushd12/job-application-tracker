# Publishing to the Chrome Web Store (maintainers)

The steps below take the extension from this repository to a public Chrome Web Store listing. Do [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md) alongside: the OAuth clients need the store's extension ID, and the OAuth app must be **In production** before strangers can connect.

## Before you start

- A Google account for the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). Registration costs a one-time US$5 fee, and the account needs 2-step verification.
- `npm test` passes, and the [manual QA checklist](TESTING.md) is done in Chrome, plus Edge or Brave for the web sign-in flow.
- The version in `extension/manifest.json` (and `package.json`) is bumped. Every upload needs a higher version than the last one.

## 1. Build the zip

The zip contains the **contents** of `extension/`, with `manifest.json` at its root. The manifest `key` is only for local development, because the store signs the package with its own key. So drop it from the uploaded copy:

```sh
rm -rf build && cp -r extension build
node -e "const f='build/manifest.json',m=JSON.parse(require('fs').readFileSync(f));delete m.key;require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\n')"
(cd build && zip -qr "../job-application-tracker-$(node -p "require('./manifest.json').version").zip" .)
rm -rf build
```

`*.zip` is git-ignored. Check that the zip holds `config.js` with the real Web application client ID, and that the manifest holds the real Chrome Extension client ID, not the placeholders.

## 2. First upload: get the item ID and key

1. In the dashboard click **New item** and upload the zip. This creates a draft and assigns the permanent **item ID**, which is the extension ID.
2. **Package → View public key:** copy it into `extension/manifest.json` as `"key"`, so local builds share the store ID (Option A in GOOGLE_CLOUD_SETUP.md).
3. Create or update the OAuth clients for this ID:
   - The Chrome Extension client's Item ID.
   - The Web application client's redirect `https://<item-id>.chromiumapp.org/`.
   - Put the Chrome client ID in the manifest and `config.js`.
4. Rebuild the zip with the final client IDs and upload it again (**Package → Upload new package**).

## 3. Store listing

| Field | What to enter |
|---|---|
| Name | Job Application Tracker (from the manifest) |
| Summary | Up to 132 characters, e.g. "Save the job you just applied to into your own Google Sheet with one click. No servers, no AI." |
| Description | What it does, supported sites, the sheet it creates, and the privacy points from the README |
| Category | Workflow & Planning, or Tools |
| Language | English |
| Homepage / support URL | The GitHub repository and its Issues page |

### Assets

| Asset | Size | Required | Source |
|---|---|---|---|
| Store icon | 128×128 PNG (96×96 artwork with transparent padding) | Yes | `extension/icons/icon128.png` (regenerate with `npm run icons`) |
| Screenshots | 1280×800 (or 640×400) PNG/JPEG, 1–5 | At least one | See below |
| Small promo tile | 440×280 PNG/JPEG | Yes | Icon plus "Job Application Tracker – one click to your Google Sheet" |
| Marquee promo tile | 1400×560 | No | Only needed if the store features the item |
| Promo video | YouTube link | No | — |

Suggested screenshots (synthetic data only, no real people or job posts):

1. A job page with the floating **Save job** tab and the open panel, every field filled.
2. **Saved to row N · Open sheet** after saving.
3. The sheet with colored Status cells.
4. The Summary tab.
5. The settings page showing **✓ Connected**.

Put the source images in `docs/screenshots/`.

## 4. Privacy practices tab

**Single purpose:** "Saves job postings the user chooses into a Google Sheet in the user's own Google Drive, and keeps that sheet's status dates up to date."

**Permission justifications:**

| Permission | Justification |
|---|---|
| `identity` | Signs the user in with Google (scope `drive.file`) so the extension can create and update the user's tracker spreadsheet. |
| `storage` | Stores the user's settings, the ID of their tracker sheet and the last-seen status of each saved job. |
| `alarms` | Runs a once-a-day check that marks stale applications as Ghosted and sets Last Updated after status changes. |
| `activeTab` | Opens the save panel on the current tab when the user clicks the toolbar icon or presses the shortcut on a tab opened before installation. |
| `scripting` | Injects the panel's content scripts into that tab after such a click. |
| Host permissions `https://sheets.googleapis.com/*`, `https://www.googleapis.com/*` | Calls the Google Sheets API (create the sheet, append rows, read the link and status columns) and the Google Drive API (tag the sheet and find it again). No other hosts are contacted. |
| Content scripts on `http://*/*`, `https://*/*` | Detect job postings on any website, including thousands of company career sites, and read their title, company, location and similar fields locally. Nothing is sent until the user clicks Save. |

**Remote code:** No. All JavaScript ships in the package.

**Data usage**, declared as what the extension handles:
- **Website content:** the job details the user chooses to save. Tick it.
- Nothing else is collected. No browsing history, no analytics, no personal communications.
- Certify all three statements: data isn't sold to third parties, isn't used for purposes unrelated to the single purpose, and isn't used to determine creditworthiness.
- Mention that data goes only to the user's own Google account and never to the developer.

**Privacy policy URL:** the GitHub URL of [`PRIVACY.md`](../PRIVACY.md), e.g. `https://github.com/piyushd12/job-application-tracking-extension/blob/main/PRIVACY.md`, or a GitHub Pages copy. Use the same URL on the OAuth consent screen.

## 5. Distribution and submission

1. **Distribution:** Public, and all regions (or the ones you choose).
2. **Notes for the reviewer** (in the submission form):
   > The extension signs in with Google using only the `drive.file` scope. To test: open the options page → Connect Google Sheets → approve with any Google account. A "Job Applications Tracker" spreadsheet is created in that account's Drive. Then open any job posting (for example a jobs.lever.co or job-boards.greenhouse.io job page), click the "Save job" tab on the right edge, and click Save. The row appears in the sheet. The extension has no backend server.
3. Click **Submit for review**. Review usually takes a few days. Broad host access (content scripts on all sites) can lengthen it, and the justification above helps.
4. Before or while it's in review, set the OAuth app to **In production** ([GOOGLE_CLOUD_SETUP.md §6](GOOGLE_CLOUD_SETUP.md#6-moving-to-production)). Otherwise reviewers and users who aren't test users can't connect, and the review may be rejected.

## 6. After approval

- Replace the Chrome Web Store placeholder link in `README.md` with the listing URL.
- Tag the release in git (`git tag v<version>`) and attach the zip to a GitHub release if you like.
- For updates: bump the version, rebuild the zip, then **Package → Upload new package** → submit. Users update automatically. If a release adds a permission, Chrome disables the extension until the user accepts it, so keep permission changes rare.
- Microsoft Edge Add-ons (optional): it accepts the same zip at [partner.microsoft.com](https://partner.microsoft.com/dashboard/microsoftedge). Edge assigns its own ID, so add `https://<edge-id>.chromiumapp.org/` to the Web application client's redirect URIs. Edge users then sign in through the web flow.
