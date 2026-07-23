/**
 * DEV-ONLY exporter: open kairos_secure.db in DB Browser for SQLite.
 * =============================================================================
 *
 * Standalone maintenance script. It lives in scripts/, is NEVER imported by
 * anything under src/, and so is never bundled into the packaged desktop app.
 * It only does anything when a developer runs it by hand on their own machine.
 *
 * WHY IT EXISTS. The live store is encrypted with the ChaCha20-Poly1305 (sqleet)
 * scheme via better-sqlite3-multiple-ciphers (see src/secure_db.ts). DB Browser
 * for SQLite cannot open that scheme — it speaks the SQLCipher/AES-256 format.
 * This script produces a throwaway SQLCipher copy of the store, encrypted under
 * the SAME key, that DB Browser (a SQLCipher-enabled build) opens directly.
 *
 * ONE-WAY, NON-DESTRUCTIVE. The real database is opened READ-ONLY and never
 * modified. The copy is a separate temp file; editing it does NOT write back.
 * Nothing is ever written to disk in the clear — the intermediate decrypt step
 * happens inside the temp file, which is immediately re-encrypted as SQLCipher.
 *
 * HOW. `VACUUM INTO` takes a consistent single-file snapshot even while the app
 * holds the DB open (it reads under a normal read transaction). That snapshot
 * inherits the source key, so we then rekey the private copy:
 *     chacha20+key  --PRAGMA rekey=''-->  plaintext  --cipher=sqlcipher, rekey=key-->  SQLCipher
 *
 * STAYS OPEN, THEN CLEANS UP. After exporting it waits. Press Enter or Ctrl+C
 * and it deletes the temp copy. If you already deleted the file yourself, exit
 * is still clean — cleanup tolerates a missing file.
 *
 * -----------------------------------------------------------------------------
 * USAGE
 *   npm run db:browse -- --key <64-hex>
 *   node ./scripts/secure-db-browse.js --key <64-hex>
 *
 * Or keep the key out of your shell history via the environment:
 *   $env:KAIROS_SECURE_DB_KEY = "<64-hex>"   # PowerShell
 *   npm run db:browse
 *
 * GET THE KEY. In a signed-in dev build, open Settings -> "Developer · dev build
 * only" -> "Reveal secure DB key". It prints the derived key and the exact
 * command to run here.
 *
 * FLAGS
 *   --key <hex>    Passphrase for the store (or env KAIROS_SECURE_DB_KEY).
 *   --db <path>    Override the source database path (defaults to the app's).
 *   --out <path>   Override where the SQLCipher copy is written (default: temp).
 * =============================================================================
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

// --- Stage 1: relaunch under Electron's Node runtime -------------------------
// better-sqlite3-multiple-ciphers is compiled against Electron's ABI (same
// reason as scripts/test-native.js), so it can only be require()d under
// ELECTRON_RUN_AS_NODE. When invoked with plain `node`, re-spawn under Electron.
if (!process.versions.electron) {
  const { spawnSync } = require("child_process");
  const electron = require("electron");
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  process.exit(result.status === null ? 1 : result.status);
}

// --- Stage 2: parse args -----------------------------------------------------
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--key":
        opts.key = argv[++i];
        break;
      case "--db":
        opts.db = argv[++i];
        break;
      case "--out":
        opts.out = argv[++i];
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log("See the header comment in scripts/secure-db-browse.js for usage.");
  process.exit(0);
}

// --- Stage 3: resolve key, source path, output path --------------------------
const key = opts.key ?? process.env.KAIROS_SECURE_DB_KEY;
if (!key) {
  console.error(
    "No key supplied. Pass --key <64-hex> or set KAIROS_SECURE_DB_KEY.\n" +
      "In a signed-in dev build, reveal it via Settings -> Developer -> Reveal secure DB key."
  );
  process.exit(2);
}

/**
 * Mirror of SECURE_DB_PATH from src/main/paths.ts. Duplicated rather than
 * imported because that module is TypeScript and pulls in `electron.app`, which
 * does not exist under ELECTRON_RUN_AS_NODE. Keep in sync if the path logic
 * ever changes.
 */
function defaultSecureDbPath() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set; pass --db <path> explicitly.");
    }
    return path.join(localAppData, "Kairos", "kairos_secure.db");
  }
  throw new Error("Non-Windows platform; pass --db <path> explicitly.");
}

const srcPath = opts.db ?? defaultSecureDbPath();
if (!fs.existsSync(srcPath)) {
  console.error(`Database not found: ${srcPath}`);
  process.exit(1);
}

// pid keeps parallel runs from colliding; the temp copy is deleted on exit.
const outPath =
  opts.out ?? path.join(os.tmpdir(), `kairos-browse-${process.pid}.db`);

/** Remove a database and its WAL sidecars, tolerating anything already gone. */
function removeDbFiles(target) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(target + suffix, { force: true });
    } catch {
      /* best-effort — a file the developer already deleted must not crash us */
    }
  }
}

// --- Stage 4: export ---------------------------------------------------------
const Database = require("better-sqlite3-multiple-ciphers");
const q = (p) => p.replace(/\\/g, "/"); // SQLite wants forward slashes in paths

// Never VACUUM INTO an existing file — SQLite refuses. Start from a clean slot.
removeDbFiles(outPath);

try {
  // 4a. Consistent snapshot of the live store, still ChaCha20-encrypted under
  //     the same key. Read-only, so the real database is never touched.
  const source = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    source.pragma("cipher='chacha20'");
    source.pragma(`key='${key}'`);
    source.prepare("SELECT count(*) FROM sqlite_master").get(); // fail fast on wrong key
    source.exec(`VACUUM main INTO '${q(outPath)}'`);
  } finally {
    source.close();
  }

  // 4b. Rekey the private copy: decrypt in place, then re-encrypt as SQLCipher
  //     (AES-256, SQLCipher-4 compatible) under the same passphrase.
  const copy = new Database(outPath, { fileMustExist: true });
  try {
    copy.pragma("cipher='chacha20'");
    copy.pragma(`key='${key}'`);
    copy.pragma("rekey=''"); // -> plaintext (only ever inside this temp file)
    copy.pragma("cipher='sqlcipher'"); // select the AES scheme DB Browser reads
    copy.pragma(`rekey='${key}'`); // -> SQLCipher-encrypted
  } finally {
    copy.close();
  }

  // 4c. Verify the copy opens as SQLCipher with the key before we hand it over.
  const check = new Database(outPath, { readonly: true, fileMustExist: true });
  try {
    check.pragma("cipher='sqlcipher'");
    check.pragma(`key='${key}'`);
    check.prepare("SELECT count(*) FROM sqlite_master").get();
  } finally {
    check.close();
  }
} catch (error) {
  console.error(`Export failed (wrong key or corrupt file):\n  ${error.message}`);
  removeDbFiles(outPath);
  process.exit(1);
}

// --- Stage 5: report and hold ------------------------------------------------
console.log(
  "\nSQLCipher copy written — open it in DB Browser for SQLite:\n" +
    `\n  ${outPath}\n` +
    "\n  1. File -> Open Database, pick the file above.\n" +
    "  2. When prompted for encryption, choose 'Passphrase' (NOT 'Raw key').\n" +
    "  3. Password:\n" +
    `\n       ${key}\n` +
    "\n     Leave 'Encryption settings' at the SQLCipher 4 defaults. If it says\n" +
    "     'file is not a database', open those settings and confirm SQLCipher 4\n" +
    "     (PBKDF2 256000 · HMAC SHA512 · page size 4096).\n" +
    "\nThis copy is one-way: edits here do NOT write back to the real database.\n"
);

// --- Stage 6: clean up exactly once, however we exit -------------------------
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  removeDbFiles(outPath);
  console.log("Deleted the temp copy. Bye.");
}

// Covers a normal `process.exit()` as well as falling off the end.
process.on("exit", cleanup);
// Ctrl+C / termination: run cleanup, then exit so the `exit` handler is a no-op.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}

/**
 * Resolve a usable input stream for the "press Enter" prompt.
 *
 * On Windows, Electron (even under ELECTRON_RUN_AS_NODE) swaps process.stdin for
 * a mock stream that emits EOF immediately — electron/electron#21705 — so a
 * plain readline closes instantly. The console's real input is reachable as
 * \\.\CONIN$; opening that gives line-buffered input. Falls back to process
 * .stdin (where Ctrl+C is the way out).
 */
function resolveInput() {
  if (process.platform === "win32" && !process.stdin.isTTY) {
    try {
      const fd = fs.openSync("\\\\.\\CONIN$", "r");
      return fs.createReadStream(null, { fd });
    } catch {
      return process.stdin;
    }
  }
  return process.stdin;
}

console.log("Press Enter (or Ctrl+C) to delete the copy and exit.");

const readline = require("readline");
const rl = readline.createInterface({ input: resolveInput(), output: process.stdout });
rl.on("line", () => {
  rl.close();
});
rl.on("close", () => {
  cleanup();
  process.exit(0);
});
