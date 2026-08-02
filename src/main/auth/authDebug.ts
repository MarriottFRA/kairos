/**
 * TEMPORARY sign-in diagnostics — DELETE WHEN THE ENTRA ISSUE IS RESOLVED.
 * -----------------------------------------------------------
 * The Microsoft/Entra sign-in runs inside a BrowserWindow we own (see
 * `msBroker.ts`). When that window ends up on a blank white page there is
 * nothing to look at: no address bar, no DevTools, and the existing
 * `MS_BROKER_DEBUG` logging only reaches the main-process console, which a
 * packaged-app user cannot see or send back.
 *
 * This gives that window a live, on-screen printout the affected user can read
 * and paste back to us:
 *
 *   - OFF BY DEFAULT. It is armed deliberately, from the sign-in screen: a very
 *     discreet dot in the corner (or `Ctrl+Shift+Alt+D`), which lights up red
 *     while tracing is on. The chord also works inside the sign-in window
 *     itself, so it can still be armed while staring at the blank page. Until
 *     armed this module does nothing at all, which is why the same build is
 *     safe to ship to everyone.
 *   - Once armed, a floating "Sign-in diagnostics" window streams every
 *     navigation, redirect, load failure, blocked scheme, denied popup,
 *     proxy-credential prompt, certificate error and page-content snapshot for
 *     the SIGN-IN WINDOW ONLY. Nothing else in the app is instrumented.
 *   - NOTHING IS WRITTEN TO DISK. The transcript lives in memory for the run;
 *     "Copy all" (or Ctrl+C) puts it on the clipboard for Teams/email, and it
 *     is gone when the app closes.
 *
 * Only password-shaped values are scrubbed — URLs are otherwise verbatim,
 * because the redirect chain is the entire point.
 *
 * Removal: delete this file and the `// [AUTH-DEBUG]` marked lines in
 * `msBroker.ts` — nothing else imports it.
 */

import { app, BrowserWindow, clipboard, screen, session } from "electron";

/** The hidden arming chord. Pressed in the main window or the sign-in window. */
const CHORD = { ctrl: true, shift: true, alt: true, key: "d" } as const;
/** Human-readable form, shown in the viewer header. */
const CHORD_LABEL = "Ctrl+Shift+Alt+D";

/** Sign-in partition, mirrored from `msBroker.SWA_PARTITION` — deliberately not
 *  imported, so deleting this feature never has to touch the broker's exports. */
const SWA_PARTITION = "persist:swa";

/** How often the sign-in page is sampled for "what is actually rendered". */
const SNAPSHOT_INTERVAL_MS = 2000;
/** Re-log an unchanged snapshot only every Nth tick, so a stall stays visible
 *  without flooding the window. */
const SNAPSHOT_REPEAT_EVERY = 5;
/** Cap on retained lines (viewer DOM + clipboard buffer). */
const MAX_LINES = 5000;
/** Poll interval for the viewer's "Copy all" button (no IPC channel needed). */
const BUTTON_POLL_MS = 250;

/** Anything that looks like a password carried in a URL or logged string. */
const PASSWORD_PATTERN = /((?:password|passwd|pwd|passwrd)=)([^&\s]+)/gi;

type Level = "info" | "nav" | "page" | "warn" | "error" | "ok";

/** Off until the chord is pressed. Everything in this module keys off it. */
let armed = false;
let viewer: BrowserWindow | null = null;
let sessionHooksInstalled = false;
let certificateHookInstalled = false;

/** In-memory only — deliberately never persisted. */
const buffer: string[] = [];
const pending: Array<{ line: string; level: Level }> = [];

/** Sign-in windows that have registered, so a late arm can still attach. */
const registered = new Map<BrowserWindow, string>();
const attached = new WeakSet<BrowserWindow>();

// ── arming ──────────────────────────────────────────────────────

/** Whether diagnostics are currently recording. */
export function authDebugArmed(): boolean {
  return armed;
}

/** Notified whenever tracing turns on/off, so the red light can follow along. */
let onChange: ((on: boolean) => void) | null = null;
export function authDebugOnChange(cb: (on: boolean) => void): void {
  onChange = cb;
}

/**
 * Install the hidden chord listener on a window. Cheap and inert — it only
 * inspects keystrokes and does nothing until the chord matches.
 *
 * Only installed on the SIGN-IN window: the main window's copy of the chord
 * lives in the renderer (see `AuthDebugToggle`), which owns the indicator state,
 * and a second listener here would toggle it straight back off.
 */
export function authDebugInstallChord(win: BrowserWindow): void {
  win.webContents.on("before-input-event", (_event, input) => {
    if (
      input.type === "keyDown" &&
      input.control === CHORD.ctrl &&
      input.shift === CHORD.shift &&
      input.alt === CHORD.alt &&
      (input.key || "").toLowerCase() === CHORD.key
    ) {
      // Arm-only from inside the sign-in window: the user pressing this while
      // looking at a blank page wants tracing ON, never off.
      authDebugSetArmed(true);
    }
  });
}

/**
 * Turn tracing on or off.
 *
 * On: open the viewer and tap any sign-in window that already exists (the usual
 * case — armed while looking at the blank page, so the very next snapshot names
 * the host that is blank).
 *
 * Off: close the viewer and drop the transcript. Nothing was ever written to
 * disk, so switching off genuinely leaves nothing behind.
 */
export function authDebugSetArmed(on: boolean): boolean {
  if (on === armed) {
    if (on) focusViewer();
    return armed;
  }
  armed = on;

  if (on) {
    openViewer();
    log("session", `Kairos ${app.getVersion()} — sign-in tracing ON`, "ok");
    log(
      "session",
      `electron=${process.versions.electron} chrome=${process.versions.chrome} ${process.platform}/${process.arch}`
    );
    log("session", "Nothing is written to disk — use “Copy all” and paste into Teams/email.");
    log("session", `Chord ${CHORD_LABEL} arms this from the sign-in window too.`);

    for (const [win, label] of registered) {
      if (!win.isDestroyed()) attach(win, label);
    }
  } else {
    closeViewer();
    buffer.length = 0;
    pending.length = 0;
  }

  onChange?.(armed);
  return armed;
}

/**
 * Register a sign-in window. Attaches immediately when already armed, otherwise
 * remembers it so a later chord press can attach retroactively.
 */
export function authDebugRegisterWindow(win: BrowserWindow, label: string): void {
  registered.set(win, label);
  win.on("closed", () => registered.delete(win));
  authDebugInstallChord(win);
  if (armed) attach(win, label);
}

// ── logging ─────────────────────────────────────────────────────

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3
  )}`;
}

/** Strip password-shaped values; everything else is logged verbatim. */
function scrub(text: string): string {
  return text.replace(PASSWORD_PATTERN, "$1<redacted>");
}

/**
 * Append one line to the in-memory transcript and the viewer. Never throws —
 * diagnostics must not be able to break the sign-in they are watching.
 */
export function authDebugLog(tag: string, message: string, level: Level = "info"): void {
  if (!armed) return;
  log(tag, message, level);
}

function log(tag: string, message: string, level: Level = "info"): void {
  // Taps stay attached across a disarm; this is what makes them go quiet.
  if (!armed) return;

  const line = `${stamp()}  ${tag.padEnd(18)}  ${scrub(message)}`;

  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.shift();

  appendToViewer(line, level);
}

/** Trim absurdly long URLs but keep them otherwise intact. */
function showUrl(raw: string): string {
  if (!raw) return "(empty)";
  return raw.length > 1200 ? raw.slice(0, 1200) + " …[truncated]" : raw;
}

// ── viewer window ───────────────────────────────────────────────

/**
 * The viewer is an `about:blank` page whose DOM is built from here. No file is
 * staged on disk, no `data:` URL (Chromium refuses those for top-level
 * navigation in some configurations) and no inline script — which also means no
 * CSP can get in the way.
 */
const VIEWER_SKELETON = `(function () {
  document.title = 'Kairos — Sign-in diagnostics';
  document.body.innerHTML = '';
  var hd = document.createElement('div');
  hd.id = 'hd';
  var ttl = document.createElement('span');
  ttl.id = 'ttl';
  ttl.textContent = 'Kairos — sign-in diagnostics (temporary, nothing saved to disk)';
  var btn = document.createElement('button');
  btn.id = 'copy';
  btn.type = 'button';
  btn.textContent = 'Copy all';
  btn.addEventListener('click', function () { window.__kairosCopy = true; });
  var msg = document.createElement('span');
  msg.id = 'msg';
  hd.appendChild(ttl); hd.appendChild(btn); hd.appendChild(msg);
  var out = document.createElement('div');
  out.id = 'out';
  document.body.appendChild(hd);
  document.body.appendChild(out);
})();`;

/**
 * Styles and behaviour are injected from the main process rather than shipped as
 * inline `<script>`/`<style>`, so the viewer works under any CSP and leaves no
 * IPC channel or preload file behind when this feature is deleted.
 */
const VIEWER_CSS = `
  html, body { margin: 0; padding: 0; background: #0b0f14; color: #d6deeb; }
  body { font: 12px/1.45 Consolas, "Cascadia Mono", monospace; padding: 0 0 16px; }
  #hd { position: sticky; top: 0; display: flex; align-items: center; gap: 10px;
        background: #131a23; color: #8fb3d9; padding: 8px 12px;
        border-bottom: 1px solid #24303d; }
  #ttl { flex: 1; }
  #copy { font: inherit; cursor: pointer; padding: 3px 12px; border-radius: 4px;
          border: 1px solid #3a566f; background: #1d2c3a; color: #d6deeb; }
  #copy:hover { background: #26394b; }
  #msg { color: #78d18a; min-width: 90px; }
  #out { padding: 8px 12px; white-space: pre-wrap; word-break: break-all; }
  .l { padding: 1px 0; }
  .info  { color: #d6deeb; }
  .nav   { color: #6fd3ff; }
  .page  { color: #8b98a8; }
  .ok    { color: #78d18a; }
  .warn  { color: #ffcc66; }
  .error { color: #ff6b6b; font-weight: bold; }
`;

/**
 * Open the floating diagnostics window, parked bottom-left and always-on-top so
 * it stays readable next to the Microsoft sign-in window. Left open after a
 * failure on purpose — the user needs to read it once the flow has died.
 */
function openViewer(): void {
  if (viewer && !viewer.isDestroyed()) {
    focusViewer();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(880, work.width - 40);
  const height = Math.min(440, Math.floor(work.height / 2));

  const win = new BrowserWindow({
    width,
    height,
    x: work.x + 20,
    y: work.y + work.height - height - 20,
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: "Kairos — Sign-in diagnostics",
    webPreferences: {
      // Own partition so the renderer CSP hook (defaultSession) never applies.
      partition: "auth-debug-viewer",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  viewer = win;
  win.setAlwaysOnTop(true, "floating");

  // Ctrl+C anywhere in the viewer copies the whole transcript, not just any
  // text selection — the user should not have to select 300 lines by hand.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && (input.key || "").toLowerCase() === "c") {
      event.preventDefault();
      copyAll();
    }
  });

  // Closing the diagnostics window is the natural "stop tracing" gesture, so it
  // disarms and takes the red indicator with it.
  win.on("closed", () => {
    viewer = null;
    if (armed) {
      armed = false;
      buffer.length = 0;
      pending.length = 0;
      onChange?.(false);
    }
  });

  win.webContents.once("did-finish-load", () => {
    void win.webContents
      .executeJavaScript(VIEWER_SKELETON, true)
      .then(() => win.webContents.insertCSS(VIEWER_CSS))
      .catch((): void => { /* best-effort: diagnostics never break sign-in */ })
      .then(() => {
        flushPending();
        watchCopyButton(win);
        // `ready-to-show` is unreliable for about:blank; this is the backstop.
        if (!win.isDestroyed()) win.showInactive();
      });
  });

  void win.loadURL("about:blank").catch((): void => { /* best-effort: diagnostics never break sign-in */ });
  win.once("ready-to-show", () => win.showInactive());
}

function focusViewer(): void {
  if (!viewer || viewer.isDestroyed()) return;
  if (viewer.isMinimized()) viewer.restore();
  viewer.showInactive();
}

function closeViewer(): void {
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
  viewer = null;
}

/** Put the full transcript on the clipboard and confirm in the header. */
function copyAll(): void {
  clipboard.writeText(buffer.join("\r\n"));
  if (!viewer || viewer.isDestroyed()) return;
  void viewer.webContents
    .executeJavaScript(
      `(function () {
        var m = document.getElementById('msg');
        if (!m) return;
        m.textContent = 'Copied ✓';
        setTimeout(function () { m.textContent = ''; }, 2500);
      })();`,
      true
    )
    .catch((): void => { /* best-effort: diagnostics never break sign-in */ });
}

/**
 * The "Copy all" button is polled rather than wired through IPC: a click sets a
 * flag on `window`, main reads and clears it. No preload, no ipcMain channel, so
 * deleting this file removes the entire feature.
 */
function watchCopyButton(win: BrowserWindow): void {
  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    win.webContents
      .executeJavaScript(
        `(function () {
          var b = document.getElementById('copy');
          if (b && !b.__wired) {
            b.__wired = true;
            b.addEventListener('click', function () { window.__kairosCopy = true; });
          }
          var want = !!window.__kairosCopy;
          window.__kairosCopy = false;
          return want;
        })();`,
        true
      )
      .then((wanted: boolean) => {
        if (wanted) copyAll();
      })
      .catch((): void => { /* best-effort: diagnostics never break sign-in */ });
  }, BUTTON_POLL_MS);

  win.on("closed", () => clearInterval(timer));
}

/** Push one line into the viewer DOM, queueing until the page is ready. */
function appendToViewer(line: string, level: Level): void {
  if (!viewer || viewer.isDestroyed() || viewer.webContents.isLoading()) {
    pending.push({ line, level });
    if (pending.length > MAX_LINES) pending.shift();
    return;
  }
  writeLine(viewer, line, level);
}

function flushPending(): void {
  if (!viewer || viewer.isDestroyed()) return;
  const queued = pending.splice(0, pending.length);
  for (const item of queued) writeLine(viewer, item.line, item.level);
}

function writeLine(win: BrowserWindow, line: string, level: Level): void {
  const js = `(function () {
    var out = document.getElementById('out');
    if (!out) return;
    var div = document.createElement('div');
    div.className = 'l ' + ${JSON.stringify(level)};
    div.textContent = ${JSON.stringify(line)};
    out.appendChild(div);
    while (out.childNodes.length > ${MAX_LINES}) out.removeChild(out.firstChild);
    window.scrollTo(0, document.body.scrollHeight);
  })();`;
  win.webContents.executeJavaScript(js, true).catch((): void => { /* best-effort: diagnostics never break sign-in */ });
}

// ── sign-in window instrumentation ──────────────────────────────

/** Extract a URL from either the legacy positional args or the details object. */
function urlOf(args: unknown[]): string {
  for (const arg of args) {
    if (typeof arg === "string" && /^[a-z][a-z0-9+.-]*:/i.test(arg)) return arg;
  }
  const first = args[0] as { url?: unknown } | undefined;
  return typeof first?.url === "string" ? first.url : "(unknown url)";
}

function safeUrl(wc: Electron.WebContents): string {
  try {
    return wc.getURL();
  } catch {
    return "";
  }
}

/**
 * Tap the sign-in window: every navigation, redirect, failure, crash and page
 * console message, plus a periodic snapshot of what is actually rendered (which
 * is how a white page proves itself). Idempotent per window.
 */
function attach(win: BrowserWindow, label: string): void {
  if (attached.has(win)) return;
  attached.add(win);

  const wc = win.webContents;
  const tag = (name: string) => `${label}/${name}`;

  log(tag("attached"), `now at ${showUrl(safeUrl(wc))}`, "ok");

  wc.on("did-start-loading", () => log(tag("loading"), "started", "page"));
  wc.on("did-stop-loading", () =>
    log(tag("loading"), `stopped @ ${showUrl(safeUrl(wc))}`, "page")
  );

  wc.on("did-start-navigation", (...args: unknown[]) =>
    log(tag("nav-start"), showUrl(urlOf(args)), "nav")
  );
  wc.on("did-redirect-navigation", (...args: unknown[]) =>
    log(tag("redirect"), showUrl(urlOf(args)), "nav")
  );
  wc.on("did-navigate", (...args: unknown[]) => {
    const status = typeof args[2] === "number" ? ` [HTTP ${args[2]}]` : "";
    log(tag("navigated"), `${showUrl(urlOf(args))}${status}`, "nav");
  });
  wc.on("did-navigate-in-page", (...args: unknown[]) =>
    log(tag("in-page"), showUrl(urlOf(args)), "nav")
  );
  wc.on("did-frame-navigate", (...args: unknown[]) =>
    log(tag("frame-nav"), showUrl(urlOf(args)), "page")
  );

  wc.on(
    "did-fail-load",
    (
      _e,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) =>
      log(
        tag("FAIL-LOAD"),
        `${errorDescription} (${errorCode})${isMainFrame ? "" : " [subframe]"} → ${showUrl(validatedURL)}`,
        isMainFrame ? "error" : "warn"
      )
  );
  wc.on(
    "did-fail-provisional-load",
    (_e, errorCode: number, errorDescription: string, validatedURL: string) =>
      log(
        tag("FAIL-PROVISIONAL"),
        `${errorDescription} (${errorCode}) → ${showUrl(validatedURL)}`,
        "error"
      )
  );

  // A proxy or site asking for HTTP-auth credentials: unhandled, so the request
  // is cancelled and the page renders blank. A browser would prompt instead —
  // exactly the kind of "works in Edge, not in the app" difference we're after.
  wc.on("login", (...args: unknown[]) => {
    const info = args.find(
      (a) => typeof a === "object" && a !== null && "isProxy" in (a as object)
    ) as { isProxy?: boolean; scheme?: string; host?: string; port?: number } | undefined;
    log(
      tag("AUTH-PROMPT"),
      `credentials requested — proxy=${info?.isProxy} scheme=${info?.scheme} host=${info?.host}:${info?.port} (cancelled: no prompt UI)`,
      "error"
    );
  });

  wc.on("render-process-gone", (_e, details) =>
    log(tag("RENDERER-GONE"), `${details.reason} (exit ${details.exitCode})`, "error")
  );
  wc.on("unresponsive", () => log(tag("unresponsive"), "page is hung", "warn"));
  wc.on("responsive", () => log(tag("responsive"), "page recovered", "ok"));

  wc.on("console-message", (...args: unknown[]) => {
    const details = args[0] as { message?: unknown } | undefined;
    const message =
      typeof details?.message === "string"
        ? details.message
        : typeof args[2] === "string"
          ? args[2]
          : "";
    if (!message) return;
    log(tag("page-console"), message.slice(0, 300), "page");
  });

  installSessionHooks();
  installCertificateHook();
  startSnapshots(win, label);
}

/**
 * Poll what the sign-in window is actually showing. A blank page is otherwise
 * indistinguishable from a slow one: this records the live URL, title, ready
 * state, visible-text length and the first line of that text, so "white page on
 * host X after redirect Y" becomes a fact rather than a guess.
 */
function startSnapshots(win: BrowserWindow, label: string): void {
  let last = "";
  let repeats = 0;

  const timer = setInterval(() => {
    if (win.isDestroyed()) return;
    win.webContents
      .executeJavaScript(
        `JSON.stringify({
          href: location.href,
          title: document.title,
          ready: document.readyState,
          len: ((document.body && document.body.innerText) || '').trim().length,
          text: ((document.body && document.body.innerText) || '').trim().slice(0, 200).replace(/\\s+/g, ' '),
          frames: document.querySelectorAll('iframe').length,
          forms: document.querySelectorAll('form').length
        })`,
        true
      )
      .then((raw: string) => {
        const s = JSON.parse(raw) as {
          href: string;
          title: string;
          ready: string;
          len: number;
          text: string;
          frames: number;
          forms: number;
        };
        const summary =
          `${showUrl(s.href)} | title="${s.title}" | ${s.ready} | text=${s.len} chars` +
          ` | iframes=${s.frames} forms=${s.forms}` +
          (s.len ? ` | "${s.text}"` : " | *** PAGE IS BLANK ***");

        if (summary === last) {
          repeats += 1;
          if (repeats % SNAPSHOT_REPEAT_EVERY !== 0) return;
          log(`${label}/snapshot`, `(unchanged) ${summary}`, s.len ? "page" : "error");
          return;
        }
        last = summary;
        repeats = 0;
        log(`${label}/snapshot`, summary, s.len ? "page" : "error");
      })
      .catch(() => {
        /* mid-navigation or destroyed — the next tick covers it */
      });
  }, SNAPSHOT_INTERVAL_MS);

  win.on("closed", () => {
    clearInterval(timer);
    log(`${label}/window`, "sign-in window closed", "warn");
  });
}

/**
 * Network-level errors in the sign-in partition ONLY, including subresources the
 * navigation events never surface (a blocked corporate proxy, a DNS failure on
 * the federated STS, a TLS reset). No other session is touched.
 */
function installSessionHooks(): void {
  if (sessionHooksInstalled) return;
  sessionHooksInstalled = true;

  try {
    const swa = session.fromPartition(SWA_PARTITION);
    swa.webRequest.onErrorOccurred((details) => {
      log(
        "net/error",
        `${details.error} — ${details.resourceType} ${showUrl(details.url)}`,
        details.resourceType === "mainFrame" ? "error" : "warn"
      );
    });
    swa.webRequest.onCompleted((details) => {
      if (details.resourceType !== "mainFrame") return;
      log(
        "net/mainframe",
        `HTTP ${details.statusCode} ${showUrl(details.url)}`,
        details.statusCode >= 400 ? "error" : "page"
      );
    });
  } catch (error) {
    log("net/hooks", `could not install: ${String(error)}`, "warn");
  }
}

/** Certificate rejections (TLS interception by a corporate proxy shows here). */
function installCertificateHook(): void {
  if (certificateHookInstalled) return;
  certificateHookInstalled = true;

  app.on("certificate-error", (_event, _wc, url, error) => {
    // Not handled: no `preventDefault()`, so Electron's default (reject) stands.
    log("CERT-ERROR", `${error} → ${showUrl(url)}`, "error");
  });
}

/** Shown in the viewer header on arm, and used by `msBroker` in its hint text. */
export const AUTH_DEBUG_CHORD_LABEL = CHORD_LABEL;
