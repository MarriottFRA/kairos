// API Configuration
// Switch between test and production servers by commenting/uncommenting the URLs below
// Updated testing 6

// Test/Development Server
//export const API_BASE_URL = 'http://127.0.0.1:8000';

// Production Server
export const API_BASE_URL = 'https://fastapi-fafyfgcmaqgsbncg.uksouth-01.azurewebsites.net';

// Azure Static Web App origin (Microsoft/Entra login + broker `mint-ms-token`).
// The broker's security comes from the SWA HttpOnly auth cookie flowing on a
// same-origin request from the auth BrowserWindow — this URL is NOT a secret and
// is safe to ship (see security notes in the auth flow). Swap for a custom domain
// here if one is configured later.
export const SWA_ORIGIN = 'https://red-mushroom-085f93603.2.azurestaticapps.net';

// Entra `domain_hint` injected into the company sign-in flow. The SWA uses the
// managed ("simple") AAD provider, which can't set `loginParameterNames`, so we
// inject the hint client-side in the auth BrowserWindow (see MsBroker). With it,
// Entra Home Realm Discovery routes straight to Marriott SSO — skipping the
// Microsoft email-entry page AND the Windows Security passkey prompt. Set to an
// empty string to disable injection.
export const COMPANY_DOMAIN_HINT = 'marriott.com';

// Placeholder company email autofilled into the Microsoft sign-in box to force
// Entra Home Realm Discovery to redirect to Marriott SSO (Entra ignores
// `domain_hint` auto-acceleration, but submitting any `@marriott.com` address
// federates). The local part is arbitrary — Marriott SSO shows its own login.
// Set to an empty string to disable autofill (the WebAuthn/passkey suppression
// still applies, leaving a clean manual email→password flow).
export const COMPANY_SSO_LOGIN_HINT = 'a@marriott.com';

// Prefix used to encode broker-gate error CODES in an Error message so they can
// survive the IPC boundary (only `error.message` crosses). The renderer strips
// this prefix to branch broker failures (no_principal / domain_not_allowed / ...)
// apart from normal app failures (which carry the FastAPI `detail` text verbatim).
export const MS_BROKER_ERROR_PREFIX = 'MS_BROKER:';
