/**
 * MsBroker — Microsoft/Entra sign-in via the SWA broker.
 * -----------------------------------------------------------
 * The FastAPI backend cannot validate Entra tokens (no app registration in the
 * tenant). Instead, a broker Azure Function behind an Azure Static Web App
 * (`POST /api/mint-ms-token`) reads the SWA-injected, un-forgeable
 * `x-ms-client-principal` and returns a short-lived (~5 min) HS256 HMAC-signed
 * JWT whose `email` claim is the verified company email.
 *
 * Security model (why this must be a BrowserWindow on the SWA origin):
 *   - The broker's trust comes from the SWA `StaticWebAppsAuthCookie` (HttpOnly,
 *     Secure, scoped to the SWA domain) flowing on a SAME-ORIGIN request. So the
 *     mint call must run INSIDE a page loaded on the SWA origin — not from the
 *     Node process, not from file://, not with a hand-carried token. The window
 *     attaches the cookie automatically; we can't read it.
 *   - No secret ever lives in this app: we never sign or verify the JWT (only the
 *     broker + FastAPI hold `MS_TOKEN_SIGNING_KEY`). The SWA origin is a public
 *     endpoint, not a credential.
 *   - The minted JWT is used ONLY for the two entrance calls (`/auth/ms-exchange`
 *     and `/auth/login` | `/auth/register`) and is never persisted.
 *
 * A dedicated, hidden BrowserWindow on a PERSISTENT partition (`persist:swa`) is
 * used so the SWA login survives restarts. It is shown only when Microsoft needs
 * interactive input; otherwise the mint is silent.
 */

import { BrowserWindow, session } from "electron";
import {
  COMPANY_DOMAIN_HINT,
  COMPANY_SSO_LOGIN_HINT,
  MS_BROKER_ERROR_PREFIX,
} from "../../config";

/** Persistent session partition for the SWA auth window (survives restarts). */
export const SWA_PARTITION = "persist:swa";

/**
 * Diagnostics for the Entra/embedded-webview integration. Keep `false` for
 * normal (fast, hidden-window) operation; flip to `true` only to debug a
 * sign-in regression — it forces the auth window visible and logs every
 * navigation to the main console so a stalled SSO redirect is visible.
 */
const MS_BROKER_DEBUG = false;

/**
 * A clean desktop-Chrome User-Agent (no `Electron/…` or app-name token). Entra
 * and many corporate Conditional-Access policies refuse to render sign-in inside
 * anything they identify as an embedded webview (`disallowed_useragent`), which
 * presents as "reached the SSO page, then spins forever". Presenting a plain
 * Chrome UA — the same engine we already are — avoids that sniff. Built from the
 * real bundled Chromium version so it stays truthful and current.
 */
function desktopChromeUserAgent(): string {
  const chrome = process.versions.chrome || "120.0.0.0";
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
  );
}

/**
 * Broker-gate error carrying the broker's error `code`. Distinct from the app's
 * `ApiError` (which carries `{detail}`) so the renderer can tell "not a valid
 * Entra user" apart from "wrong password / needs approval".
 *
 * The `.message` is `MS_BROKER:<code>` so the code survives the IPC boundary
 * (only `error.message` crosses); `.detail` keeps the human-readable reason for
 * main-side logging.
 *
 * Codes: `no_principal` | `domain_not_allowed` | `server_misconfigured` |
 *        `server_error` | `mint_failed` | `cancelled` | `timeout`.
 */
export class BrokerError extends Error {
  public detail?: string;
  constructor(public code: string, detail?: string) {
    super(`${MS_BROKER_ERROR_PREFIX}${code}`);
    this.name = "BrokerError";
    this.detail = detail;
  }
}

export interface MsBrokerDeps {
  /** SWA origin, e.g. https://<name>.azurestaticapps.net (no trailing slash). */
  swaOrigin: string;
  /** The main window, used as parent so the auth window is tied to the app. */
  getMainWindow: () => BrowserWindow | null;
}

interface MintOptions {
  /**
   * When true, never show the Microsoft login window: if interactive login is
   * required, reject with `no_principal` instead. Used for the on-demand re-mint
   * during login when we expect the SWA cookie to still be valid.
   */
  silent?: boolean;
}

const AUTH_WINDOW_TIMEOUT_MS = 3 * 60 * 1000; // give the user 3 min to sign in

export class MsBroker {
  constructor(private deps: MsBrokerDeps) {
    this.installDomainHintInjector();
  }

  /**
   * Force company Home Realm Discovery by injecting `domain_hint` into the Entra
   * authorize request. The SWA uses the managed AAD provider (no
   * `loginParameterNames`), so we can't set the hint server-side — instead we
   * rewrite the SWA→Entra server redirect here, in the session we control.
   *
   * With `domain_hint=<company>`, Entra skips the Microsoft email-entry page and
   * redirects straight to the federated company SSO, which also avoids the
   * Microsoft passkey/WebAuthn prompt (auth happens at the company IdP).
   *
   * `onBeforeRequest` allows one listener per session and the partition is
   * shared + persistent, so registering once in the constructor is correct.
   */
  private installDomainHintInjector(): void {
    if (!COMPANY_DOMAIN_HINT) return;

    session
      .fromPartition(SWA_PARTITION)
      .webRequest.onBeforeRequest(
        { urls: ["https://login.microsoftonline.com/*"] },
        (details, callback) => {
          // Only rewrite the top-level authorize navigation, and only once
          // (the `domain_hint` guard keeps it idempotent / loop-free).
          if (details.resourceType !== "mainFrame") {
            return callback({});
          }
          let url: URL;
          try {
            url = new URL(details.url);
          } catch {
            return callback({});
          }
          if (
            !url.pathname.includes("/authorize") ||
            url.searchParams.has("domain_hint")
          ) {
            return callback({});
          }
          url.searchParams.set("domain_hint", COMPANY_DOMAIN_HINT);
          if (MS_BROKER_DEBUG) {
            console.log("[msBroker] injected domain_hint:", url.toString());
          }
          callback({ redirectUrl: url.toString() });
        }
      );
  }

  private get swaHost(): string {
    return new URL(this.deps.swaOrigin).host;
  }

  /**
   * Mint a fresh broker JWT. Opens the (hidden) SWA auth window, ensures we are
   * on the authenticated SWA origin (showing Microsoft login only if needed and
   * not `silent`), then runs the same-origin mint fetch inside the page.
   *
   * NEVER cache the returned token — it lives ~5 min and is a one-time handshake.
   */
  async mintToken(options: MintOptions = {}): Promise<string> {
    const silent = options.silent ?? false;
    const win = this.createWindow();
    try {
      // 1) Load the SWA origin. If it lands on the authenticated SWA page we can
      //    mint immediately; if it redirects to Microsoft, drive interactive login.
      await this.waitForSwaOrigin(win, `${this.deps.swaOrigin}/`, silent);

      try {
        return await this.mintOnPage(win);
      } catch (error) {
        // '/' was reachable but the principal wasn't established (public root, not
        // yet signed in). For an interactive attempt, trigger Entra login explicitly.
        if (
          error instanceof BrokerError &&
          error.code === "no_principal" &&
          !silent
        ) {
          await this.waitForSwaOrigin(
            win,
            `${this.deps.swaOrigin}/.auth/login/aad?post_login_redirect_uri=/`,
            false
          );
          return await this.mintOnPage(win);
        }
        throw error;
      }
    } finally {
      this.destroy(win);
    }
  }

  /**
   * Sign out of the SWA (switch-account): navigate the partition to the SWA
   * logout endpoint and clear its cookies. Best-effort.
   */
  async signOut(): Promise<void> {
    const win = this.createWindow();
    try {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        win.webContents.once("did-finish-load", done);
        win.webContents.once("did-navigate", () => setTimeout(done, 300));
        win
          .loadURL(`${this.deps.swaOrigin}/.auth/logout?post_logout_redirect_uri=/`)
          .catch(() => resolve());
        setTimeout(resolve, 8000); // hard cap
      });
    } finally {
      this.destroy(win);
    }
    try {
      await session
        .fromPartition(SWA_PARTITION)
        .clearStorageData({ storages: ["cookies"] });
    } catch {
      /* best-effort */
    }
  }

  // ── internals ───────────────────────────────────────────────────

  private createWindow(): BrowserWindow {
    const parent = this.deps.getMainWindow() ?? undefined;
    const win = new BrowserWindow({
      width: 700,
      height: 680,
      show: false,
      parent,
      modal: false,
      center: true,
      autoHideMenuBar: true,
      title: "Sign in with Microsoft",
      webPreferences: {
        partition: SWA_PARTITION, // persistent cookie store => login survives restarts
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Present as plain desktop Chrome so Entra / Conditional Access doesn't refuse
    // the embedded webview (`disallowed_useragent`). Set before any navigation so
    // every request in the sign-in chain carries it.
    win.webContents.setUserAgent(desktopChromeUserAgent());

    // Harden: never spawn popups.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    // Suppress the Entra passkey/WebAuthn prompt and autofill the company email so
    // the flow jumps straight to Marriott SSO. Must be set up before navigation.
    this.setupAuthPageAutomation(win);

    // Allow the auth flow to traverse whatever IdPs the tenant uses. A federated
    // tenant redirects through its own STS (ADFS/Okta/Ping on a company domain),
    // MFA providers, etc. — an allowlist of only *.microsoftonline.com would block
    // those and hang the window. Permit any HTTPS navigation (the window is a
    // sandboxed, isolated, preload-less partition used solely for sign-in); block
    // only non-HTTPS schemes.
    win.webContents.on("will-navigate", (event, url) => {
      let isHttps = false;
      try {
        isHttps = new URL(url).protocol === "https:";
      } catch {
        isHttps = false;
      }
      if (!isHttps) {
        event.preventDefault();
        if (MS_BROKER_DEBUG) console.log("[msBroker] blocked non-https nav:", url);
      }
    });

    if (MS_BROKER_DEBUG) {
      const wc = win.webContents;
      wc.on("did-navigate", (_e, url) => console.log("[msBroker] NAV:", url));
      wc.on("did-navigate-in-page", (_e, url) =>
        console.log("[msBroker] IN-PAGE:", url)
      );
      wc.on("did-redirect-navigation", (_e, url) =>
        console.log("[msBroker] REDIRECT:", url)
      );
      wc.on("did-fail-load", (_e, code, desc, url) =>
        console.log("[msBroker] FAIL:", code, desc, url)
      );
      wc.on("did-start-loading", () => console.log("[msBroker] start-loading"));
      wc.on("did-stop-loading", () => console.log("[msBroker] stop-loading"));
      // Show the window so the sign-in flow is visible. DevTools is intentionally
      // NOT auto-opened here: it attaches its own debugger and would conflict with
      // the CDP session used by setupAuthPageAutomation. Navigation is still logged
      // to the main-process console above.
      win.once("ready-to-show", () => {
        win.show();
      });
    }

    return win;
  }

  /**
   * Inject a document-start script into the auth window's pages that:
   *   1) Disables Entra's passkey/WebAuthn (overrides `navigator.credentials` and
   *      the `PublicKeyCredential` availability probes) so the "Windows Security →
   *      select a passkey" popup never fires.
   *   2) Autofills `COMPANY_SSO_LOGIN_HINT` into the Microsoft email box and clicks
   *      Next, so Entra Home Realm Discovery redirects to the federated Marriott SSO
   *      (Entra ignores `domain_hint`, but submitting a company address federates).
   *
   * Both are gated to `login.microsoftonline.com` inside the script so the SWA and
   * Marriott SSO pages are untouched. Injection uses the CDP debugger so the script
   * runs in the page's MAIN world BEFORE Entra's own scripts; if the debugger can't
   * attach (e.g. DevTools open), it falls back to a best-effort `dom-ready` inject.
   */
  private setupAuthPageAutomation(win: BrowserWindow): void {
    const hint = JSON.stringify(COMPANY_SSO_LOGIN_HINT || "");
    const source = `(function () {
      try {
        if ((location.hostname || "").indexOf("login.microsoftonline.com") === -1) return;

        // 1) Kill the passkey/WebAuthn prompt.
        try {
          if (navigator.credentials) {
            var deny = function () {
              return Promise.reject(new DOMException("WebAuthn disabled", "NotAllowedError"));
            };
            navigator.credentials.get = deny;
            navigator.credentials.create = deny;
          }
          if (window.PublicKeyCredential) {
            window.PublicKeyCredential.isConditionalMediationAvailable = function () { return Promise.resolve(false); };
            window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function () { return Promise.resolve(false); };
          }
        } catch (e) {}

        // 2) Autofill the company email + submit to trigger the SSO redirect.
        var HINT = ${hint};
        if (!HINT) return;
        var start = Date.now();
        var timer = setInterval(function () {
          if (Date.now() - start > 8000) { clearInterval(timer); return; }
          var input = document.querySelector('input[name="loginfmt"]');
          var next = document.querySelector('#idSIButton9') || document.querySelector('input[type="submit"]');
          if (!input || !next || input.__psAutofilled) return;
          input.__psAutofilled = true;
          clearInterval(timer);
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, HINT);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          setTimeout(function () { try { next.click(); } catch (e) {} }, 200);
        }, 150);
      } catch (e) {}
    })();`;

    const wc = win.webContents;
    try {
      wc.debugger.attach("1.3");
      wc.debugger
        .sendCommand("Page.enable")
        .then(() =>
          wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source })
        )
        .then(() => {
          if (MS_BROKER_DEBUG) console.log("[msBroker] auth-page automation attached (CDP)");
        })
        .catch((err) => {
          if (MS_BROKER_DEBUG) console.log("[msBroker] CDP setup error:", err);
        });
    } catch (err) {
      // DevTools/another debugger already attached — degrade to per-load inject.
      if (MS_BROKER_DEBUG) {
        console.log("[msBroker] CDP attach failed, using dom-ready fallback:", err);
      }
      wc.on("dom-ready", () => {
        wc.executeJavaScript(source, true).catch(() => {
          /* best-effort */
        });
      });
    }
  }

  private destroy(win: BrowserWindow): void {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }

  /**
   * Load `url` and resolve once the top frame lands on the authenticated SWA
   * origin (host === swaHost and NOT an `/.auth/*` transit path). Shows the window
   * when Microsoft login is reached (unless `silent`, in which case it aborts).
   */
  private waitForSwaOrigin(
    win: BrowserWindow,
    url: string,
    silent: boolean
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        win.webContents.removeListener("did-navigate", onNavigate);
        win.webContents.removeListener("did-redirect-navigation", onNavigate);
        win.removeListener("closed", onClosed);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const evaluate = () => {
        let current = "";
        try {
          current = win.webContents.getURL();
        } catch {
          return;
        }
        if (!current) return;

        let parsed: URL;
        try {
          parsed = new URL(current);
        } catch {
          return;
        }

        // Landed on the authenticated SWA origin (not an /.auth transit path) =>
        // the principal is established; we can mint. This is the ONLY success state.
        if (
          parsed.host === this.swaHost &&
          !parsed.pathname.startsWith("/.auth")
        ) {
          if (win.isVisible() && !MS_BROKER_DEBUG) {
            win.hide(); // back on SWA origin => no more interaction needed
          }
          finish(resolve);
          return;
        }

        // Anywhere else that ISN'T the SWA origin means we've been redirected to an
        // identity provider — Entra (login.microsoftonline.com) OR a federated
        // company STS (ADFS/Okta/Ping on a corporate domain). Either way the user
        // must interact, so surface the window (unless silent, where we bail).
        const onSwaTransit =
          parsed.host === this.swaHost && parsed.pathname.startsWith("/.auth");
        if (!onSwaTransit) {
          if (silent) {
            finish(() =>
              reject(new BrokerError("no_principal", "interactive login required"))
            );
          } else if (!win.isVisible()) {
            win.show(); // let the user complete interactive sign-in
          }
        }
      };

      const onNavigate = () => evaluate();
      const onClosed = () =>
        finish(() => reject(new BrokerError("cancelled", "sign-in window closed")));

      const timer = setTimeout(
        () => finish(() => reject(new BrokerError("timeout", "sign-in timed out"))),
        AUTH_WINDOW_TIMEOUT_MS
      );

      win.webContents.on("did-navigate", onNavigate);
      win.webContents.on("did-redirect-navigation", onNavigate);
      win.on("closed", onClosed);

      win
        .loadURL(url)
        .catch((error) =>
          finish(() =>
            reject(new BrokerError("mint_failed", `failed to load SWA: ${error}`))
          )
        );
    });
  }

  /**
   * Run the same-origin mint fetch inside the SWA page (so the auth cookie is
   * attached and the SWA injects `x-ms-client-principal`). Maps broker error
   * shapes to `BrokerError`.
   */
  private async mintOnPage(win: BrowserWindow): Promise<string> {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        try {
          const r = await fetch('/api/mint-ms-token', { method: 'POST', credentials: 'include' });
          const text = await r.text();
          let body = null;
          try { body = JSON.parse(text); } catch (_e) { body = { raw: text }; }
          return { status: r.status, body };
        } catch (e) {
          return { status: 0, body: { error: 'network', message: String(e) } };
        }
      })()`,
      true
    )) as { status: number; body: { token?: string; error?: string } | null };

    const code = result.body?.error;

    if (result.status === 200 && result.body?.token) {
      return result.body.token;
    }
    if (result.status === 401) {
      throw new BrokerError(code || "no_principal", "not signed in");
    }
    if (result.status === 403) {
      throw new BrokerError(code || "domain_not_allowed", "email domain not allowed");
    }
    if (result.status >= 500) {
      throw new BrokerError(code || "server_error", "broker server error");
    }
    throw new BrokerError(
      code || "mint_failed",
      `mint failed (HTTP ${result.status})`
    );
  }
}
