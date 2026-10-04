# Google Cloud setup (maintainers)

Users never see any of this: they click **Connect Google Sheets** and approve Google's consent screen. These one-time steps create the OAuth clients behind that button. You need them to run the extension from source or to publish it.

You end up with four values:

| Value | Where it goes |
|---|---|
| A stable **extension ID** (from the manifest `key`) | Registered on both OAuth clients |
| **Chrome Extension** OAuth client ID | `extension/manifest.json` → `oauth2.client_id` **and** `extension/config.js` → `CHROME_CLIENT_ID` (a test checks they match) |
| **Web application** OAuth client ID | `extension/config.js` → `WEB_CLIENT_ID` |
| The manifest `key` | `extension/manifest.json` → `"key"` (optional while developing, recommended) |

Google Chrome signs in with the Chrome Extension client (`chrome.identity.getAuthToken`). Edge, Brave and other Chromium browsers don't support that API, so they use the Web application client through `chrome.identity.launchWebAuthFlow`, which redirects to `https://<extension-id>.chromiumapp.org/`.

> **Both clients must be in the same Google Cloud project.** The extension tags the spreadsheet it creates with a private Drive `appProperties` value, and Drive scopes those to the project. Clients in two projects couldn't find each other's sheets.

## 1. Get a stable extension ID

OAuth clients are tied to an extension ID. Chrome derives the ID from a public key. Without a `"key"` in the manifest, every unpacked copy gets a random ID that changes with the folder path, and sign-in breaks whenever it changes. Pick **one** of these:

### Option A: use the Chrome Web Store key (recommended)

This makes your local ID equal to the published ID, so one set of OAuth clients serves both.

1. Create the item in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) by uploading a zip of `extension/` as a draft (see [PUBLISHING.md](PUBLISHING.md)). It doesn't need to be submitted.
2. Open the item → **Package** → **View public key**.
3. Copy the key text between `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`, joined into one line with no spaces.
4. Add it to `extension/manifest.json`:
   ```json
   "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…",
   ```
5. The item ID shown in the dashboard is your extension ID.

### Option B: generate your own key

Good for local development before a store item exists.

```sh
# Private key: keep it secret and out of git (*.pem is already in .gitignore). Back it up.
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem

# Public key → the manifest "key" value (one line)
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A; echo

# Extension ID (on macOS use `shasum -a 256` instead of `sha256sum`)
openssl rsa -in key.pem -pubout -outform DER | sha256sum | head -c32 | tr 0-9a-f a-p; echo
```

Paste the public key into `extension/manifest.json` as `"key": "…"`. A key you generate yourself gives a different ID from the store's, so you would register that ID on the OAuth clients too (step 4 explains how).

### Check

Reload the extension at `chrome://extensions`. The **ID** on its card must match the ID you expect. A manifest with an invalid `key` doesn't load at all.

## 2. Create the project and enable the APIs

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project, for example *Job Application Tracker*.
2. Go to **APIs & Services → Library** and enable:
   - **Google Sheets API**
   - **Google Drive API**

## 3. Configure the OAuth consent screen

In **APIs & Services → OAuth consent screen**, which newer consoles call **Google Auth Platform**:

1. **Branding:** app name *Job Application Tracker*, a user support email, and the developer contact email. For production you'll also need an app logo, a home page (the GitHub repository) and a privacy policy URL (link to [`PRIVACY.md`](../PRIVACY.md) on GitHub).
2. **Audience:** user type **External**. Leave the publishing status at **Testing** while you develop.
3. **Test users:** add every Google account that should be able to sign in while the app is in Testing, up to 100. Other accounts get an "access blocked" error.
4. **Data access (scopes):** **Add or remove scopes** → add `https://www.googleapis.com/auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app"). It is a non-sensitive scope. Do **not** add the `spreadsheets` or `drive` scopes, because the extension doesn't need them and they require a security review.

While the app is in Testing, Google expires test users' grants after 7 days, so you may have to click **Connect Google Sheets** again each week. That stops once the app is in production.

## 4. Create the OAuth clients

In **APIs & Services → Credentials** (or **Google Auth Platform → Clients**) → **Create credentials → OAuth client ID**:

### Chrome Extension client (Google Chrome)

1. **Application type:** *Chrome Extension*.
2. **Name:** e.g. *Job Tracker – Chrome*.
3. **Item ID:** your extension ID from step 1.
4. Create, then copy the **Client ID** into **both**:
   - `extension/manifest.json` → `"oauth2": { "client_id": "…" }`
   - `extension/config.js` → `CHROME_CLIENT_ID`

### Web application client (Edge, Brave and other browsers)

1. **Application type:** *Web application*.
2. **Name:** e.g. *Job Tracker – other browsers*.
3. **Authorized redirect URIs:** add `https://<extension-id>.chromiumapp.org/`, using your extension ID and keeping the trailing slash. No JavaScript origins are needed.
4. Create, then copy the **Client ID** into `extension/config.js` → `WEB_CLIENT_ID`.

The extension uses the token-only (implicit) flow, so it never uses the **client secret**. Never put a client secret in the extension.

If the extension has more than one ID (a self-generated development key and the store ID, or a separate Microsoft Edge Add-ons listing), create one Chrome Extension client per ID if you need Google Chrome sign-in for each. Add one redirect URI per ID to the single Web application client. The manifest can hold only one `oauth2.client_id`, so the build you load or publish must carry the matching one.

## 5. Try it

1. Run `npm test`. The manifest/config consistency test catches a client ID pasted in only one place.
2. Reload the extension at `chrome://extensions`, open its options page and click **Connect Google Sheets**.
3. Sign in with a test user → a **Job Applications Tracker** spreadsheet appears in that account's Drive.

| Symptom | Likely cause |
|---|---|
| `bad client id` / `OAuth2 request failed: Service responded with error: 'bad client id: …'` | `oauth2.client_id` in the manifest is still the placeholder, or the client's Item ID isn't this extension's ID |
| `redirect_uri_mismatch` (Edge/Brave) | The Web application client lacks `https://<this-id>.chromiumapp.org/` (with the trailing slash) |
| `Error 403: access_denied`, "has not completed the Google verification process" | The account isn't a test user while the app is in Testing |
| "Google Sheets API has not been used in project … or it is disabled" | Enable both APIs in the same project as the clients |
| Connect works in Chrome, but Edge can't find the sheet Chrome created | The two clients are in different projects |

## 6. Moving to production

1. **Publish the app:** in **OAuth consent screen → Audience** (or **Publishing status**), click **Publish app** to switch from Testing to **In production**. Until you do, only test users can connect, even after the Chrome Web Store approves the extension.
2. **Verification:** `drive.file` is non-sensitive, so no security assessment (CASA) is required. Google may still ask for **brand verification** before your app name and logo appear on the consent screen. Prepare these, then submit from the **Verification Center**:
   - A home page that describes the extension and links to the privacy policy.
   - A privacy policy URL on a domain you own or control, such as GitHub Pages or the repository.
   - Proof that you own any domain you list (verified in [Google Search Console](https://search.google.com/search-console)).
   - An app logo (120×120 px) and support email.

   Brand verification usually takes a few business days.
3. **Point the clients at the store ID:** if you developed with a self-generated key, make sure the published build's `oauth2.client_id` belongs to a Chrome Extension client whose Item ID is the **store** ID. Also make sure the Web application client lists the store ID's `chromiumapp.org` redirect.
4. **Quotas:** the default Sheets API quota (per-minute read and write requests per user and per project) is far above what one person saving jobs uses. Check **APIs & Services → Quotas** if many users join.
