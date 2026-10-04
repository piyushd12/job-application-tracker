'use strict';

// Google OAuth client IDs. Both clients must belong to the same Google Cloud project.
// See docs/GOOGLE_CLOUD_SETUP.md for how to create them.
const CONFIG = {
  // "Chrome Extension" client, used by chrome.identity.getAuthToken in Google Chrome.
  // manifest.json repeats it under oauth2.client_id (Chrome reads it from there); keep the two equal.
  CHROME_CLIENT_ID: 'YOUR_CHROME_EXTENSION_CLIENT_ID.apps.googleusercontent.com',
  // "Web application" client with the redirect URI https://<extension-id>.chromiumapp.org/,
  // used by chrome.identity.launchWebAuthFlow in Edge, Brave and other Chromium browsers.
  WEB_CLIENT_ID: 'YOUR_WEB_APPLICATION_CLIENT_ID.apps.googleusercontent.com',
};
