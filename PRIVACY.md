# Privacy Policy: Job Application Tracker

_Effective date: 4 October 2026_

Job Application Tracker ("the extension") is a free, open-source browser extension that saves job postings you choose into a Google Sheet in your own Google Drive. This policy explains what the extension reads, where that information goes, and how to remove it.

**In short:** your data goes from your browser straight to your own Google account. The developer runs no servers and receives nothing. There are no analytics, no tracking and no ads.

## What the extension reads

- **Job pages you visit.** To show its "Save job" button and pre-fill the form, the extension reads page content locally in your browser: the job title, company, location, salary, description text and similar details. This happens on your device, and none of it is sent anywhere unless you click **Save**.
- **What you save.** When you click **Save**, the fields shown in the form are sent to your Google Sheet: Company, Role, Applied Date, Status, Work Mode, Location, Years of experience, Salary, Source, Job Link and Notes. You can review and edit every field first.

## Where your data goes

Saved jobs go **only** to a spreadsheet in **your** Google Drive, through Google's official Sheets and Drive APIs, signed in as you. The extension contacts no other server. The developer has no access to your sheet, your Google account or anything you save.

Google processes this data under [Google's Privacy Policy](https://policies.google.com/privacy), as it does for any of your Google Sheets.

## Google account access

When you click **Connect Google Sheets**, Google asks you to grant one permission, the `drive.file` scope: "See, edit, create, and delete only the specific Google Drive files you use with this app." With it, the extension:

- creates one spreadsheet named "Job Applications Tracker" in your Drive and formats it;
- tags that spreadsheet with a private marker, so it can be found again if you reconnect (for example on another computer);
- appends a row each time you save a job;
- reads the spreadsheet's Job Link, Status and date columns to warn you about duplicates, to set "Last Updated" after you change a status, and to mark old applications as "Ghosted" if you leave that setting on.

The extension **cannot** see, list or open any other file in your Google Drive. It never requests access to your Gmail, contacts or other Google data.

The extension's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements, and to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq). Google user data is used only to provide the features described above. It is never transferred to anyone else, never used for advertising, and never read by humans.

## What is stored in your browser

| Data | Where | Why |
|---|---|---|
| Settings (button mode, hidden sites, auto-ghost on/off and days) | Browser sync storage (synced by your browser with your profile, if sync is on) | To remember your choices |
| The ID of your tracker spreadsheet | Local browser storage | To know which sheet to write to |
| Each saved job's link and its last-seen status | Local browser storage | To detect status changes for "Last Updated" |
| A short-lived Google access token (in Edge, Brave and other non-Chrome browsers; Chrome keeps tokens in its own identity system) | Session memory, cleared when the browser closes | To call the Google Sheets API without asking you to sign in each time |
| A copy of your sheet's Job Link column, for up to 60 seconds | Session memory | To make the duplicate check fast |

## What the extension does not do

- No analytics, telemetry, crash reporting or tracking of any kind.
- No ads, and no selling, renting or sharing of data.
- No browsing history is recorded. Pages are only read to detect and fill in job postings.
- No remote code. Everything the extension runs ships inside it.

## Removing your data

- **Disconnect:** in the extension's settings, click **Disconnect**. This revokes the extension's access to your Google account and deletes the stored sheet ID and status list from your browser.
- **Revoke from Google:** at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **Uninstall:** removing the extension deletes all of its browser storage.
- **Your sheet** is an ordinary file in your Google Drive. It stays there until you delete it.

## Children

The extension is a job-search tool and is not directed at children under 13.

## Changes

If this policy changes, the new version will be published in this file with a new effective date. Material changes will be noted in the extension's release notes.

## Contact

Questions or concerns: open an issue at [github.com/piyushd12/job-application-tracking-extension/issues](https://github.com/piyushd12/job-application-tracking-extension/issues).
