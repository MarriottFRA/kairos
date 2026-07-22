/**
 * DEV-ONLY interactive SQL console for the encrypted Kairos feature store.
 * =============================================================================
 *
 * This is a standalone maintenance script. It lives in scripts/ and is NEVER
 * imported by anything under src/, so esbuild / electron-forge never bundle it
 * into the packaged desktop app. It only does anything when a developer runs it
 * by hand on their own machine. There is no in-app surface here and no way for
 * an end user to reach it.
 *
 * WHY IT EXISTS. kairos_secure.db is encrypted with the ChaCha20-Poly1305
 * (sqleet) scheme via better-sqlite3-multiple-ciphers (see src/secure_db.ts).
 * That format is deliberately NOT the SQLCipher/AES format DB Browser for SQLite
 * understands, so the usual GUI can't open it. This gives you a "just poke at the
 * data" console using the exact same driver and cipher the app uses, so the
 * on-disk format can never disagree.
 *
 * NOTHING IS DECRYPTED TO DISK. The database stays encrypted at rest the whole
 * time; rows are only ever held in memory while a query runs.
 *
 * SAFETY. Opens READ-ONLY by default, so browsing cannot mutate real data. Pass
 * --write to allow INSERT/UPDATE/DELETE (use with care — this is live data).
 *
 * -----------------------------------------------------------------------------
 * USAGE
 *   npm run db:repl -- --key <64-hex>
 *   node ./scripts/secure-db-repl.js --key <64-hex>
 *
 * Or put the key in the environment so it stays out of your shell history:
 *   $env:KAIROS_SECURE_DB_KEY = "<64-hex>"   # PowerShell
 *   npm run db:repl
 *
 * GET THE KEY. In a signed-in dev build the app exposes the derived key via the
 * dev-only reveal path (revealSecureDbKeyForDev in src/secure_db.ts) — that is
 * hard-blocked in packaged builds. The value it prints is what you pass here.
 *
 * FLAGS
 *   --key <hex>    Passphrase for PRAGMA key (or env KAIROS_SECURE_DB_KEY).
 *   --db <path>    Override the database path (defaults to the app's location).
 *   --write        Open read-write. Default is read-only.
 *   --exec "SQL"   Run one statement and exit (non-interactive).
 *
 * IN-REPL COMMANDS
 *   .tables            list tables
 *   .schema [name]     show CREATE statements (optionally for one object)
 *   .help              this list
 *   .quit / .exit      leave
 *   <any SQL>;         run it — SELECT/PRAGMA print a table, writes show changes
 * =============================================================================
 */

"use strict";

const path = require("path");
const fs = require("fs");

// --- Stage 1: relaunch under Electron's Node runtime -------------------------
// better-sqlite3-multiple-ciphers is compiled against Electron's ABI (same
// reason as scripts/test-native.js), so it can only be require()d under
// ELECTRON_RUN_AS_NODE. When invoked with plain `node`, re-spawn ourselves under
// the Electron binary with stdio inherited so the interactive prompt still
// attaches to the real terminal.
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
  const opts = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--key":
        opts.key = argv[++i];
        break;
      case "--db":
        opts.db = argv[++i];
        break;
      case "--exec":
        opts.exec = argv[++i];
        break;
      case "--write":
        opts.write = true;
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
  console.log("See the header comment in scripts/secure-db-repl.js for usage.");
  process.exit(0);
}

// --- Stage 3: resolve key and database path ----------------------------------
const key = opts.key ?? process.env.KAIROS_SECURE_DB_KEY;
if (!key) {
  console.error(
    "No key supplied. Pass --key <64-hex> or set KAIROS_SECURE_DB_KEY.\n" +
      "In a signed-in dev build the app can reveal it (revealSecureDbKeyForDev)."
  );
  process.exit(2);
}

/**
 * Mirror of SECURE_DB_PATH from src/main/paths.ts. Duplicated rather than
 * imported because that module is TypeScript and pulls in `electron.app`, which
 * does not exist under ELECTRON_RUN_AS_NODE. Keep this in sync if the app's path
 * logic ever changes.
 */
function defaultSecureDbPath() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set; pass --db <path> explicitly.");
    }
    return path.join(localAppData, "Kairos", "kairos_secure.db");
  }
  // macOS / Linux dev machines: pass --db explicitly.
  throw new Error("Non-Windows platform; pass --db <path> explicitly.");
}

const dbPath = opts.db ?? defaultSecureDbPath();
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

// --- Stage 4: open the encrypted database ------------------------------------
const Database = require("better-sqlite3-multiple-ciphers");

let db;
try {
  db = new Database(dbPath, { readonly: !opts.write, fileMustExist: true });
  // Cipher BEFORE key: `key` runs the KDF for whichever scheme is active. The key
  // is passed as a quoted passphrase (matches src/secure_db.ts) — NOT a raw
  // x'..' key — so the scheme's KDF runs over the hex string exactly as the app
  // does it.
  db.pragma("cipher='chacha20'");
  db.pragma(`key='${key}'`);
  // Force a real read so a wrong key fails here with a clear message rather than
  // at some later query.
  db.prepare("SELECT count(*) FROM sqlite_master").get();
} catch (error) {
  console.error(
    `Could not open/decrypt the database (wrong key or corrupt file):\n  ${error.message}`
  );
  process.exit(1);
}

console.log(
  `Opened ${dbPath}\n` +
    `mode: ${opts.write ? "READ-WRITE (live data!)" : "read-only"} | cipher: chacha20\n`
);

// --- Stage 5: statement execution --------------------------------------------
function runSql(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return;
  const stmt = db.prepare(trimmed);
  if (stmt.reader) {
    // Returns rows (SELECT / PRAGMA / EXPLAIN / RETURNING).
    const rows = stmt.all();
    if (rows.length === 0) {
      console.log("(0 rows)");
    } else {
      console.table(rows);
      console.log(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
    }
  } else {
    const info = stmt.run();
    console.log(`OK — ${info.changes} row(s) changed.`);
  }
}

// --- Stage 6: one-shot or interactive ----------------------------------------
if (opts.exec) {
  try {
    runSql(opts.exec);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    db.close();
    process.exit(1);
  }
  db.close();
  process.exit(0);
}

const readline = require("readline");

/**
 * Resolve a usable input stream for the prompt.
 *
 * On Windows, Electron (even under ELECTRON_RUN_AS_NODE) swaps process.stdin for
 * a mock stream that immediately emits EOF — see electron/electron#21705 — so a
 * readline over it closes instantly ("bye." before you can type). The console's
 * real input device is reachable as \\.\CONIN$; opening that directly gives us
 * line-buffered input the console still echoes for us. stdout is unaffected, so
 * only the input side needs this. Falls back to process.stdin if CONIN$ can't be
 * opened (e.g. no attached console), where --exec is the usable path.
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

const rl = readline.createInterface({
  input: resolveInput(),
  output: process.stdout,
  prompt: "secure> ",
});

function handleDotCommand(line) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "tables":
      runSql(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      break;
    case "schema": {
      const name = rest[0];
      const where = name
        ? `AND name = '${name.replace(/'/g, "''")}'`
        : "";
      const rows = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type IN ('table','view','index') AND sql IS NOT NULL ${where} ORDER BY type, name`
        )
        .all();
      if (rows.length === 0) console.log("(nothing matches)");
      else rows.forEach((r) => console.log(r.sql + ";\n"));
      break;
    }
    case "help":
      console.log(
        ".tables            list tables\n" +
          ".schema [name]     show CREATE statements\n" +
          ".quit / .exit      leave\n" +
          "<SQL>;             run a statement"
      );
      break;
    case "quit":
    case "exit":
      rl.close();
      return;
    default:
      console.log(`Unknown command: .${cmd} (try .help)`);
  }
}

// Buffer input until a statement is terminated with `;`, so multi-line SQL works.
let buffer = "";
rl.prompt();
rl.on("line", (line) => {
  const text = line.trim();

  // Dot-commands are single-line and only valid at the start of a statement.
  if (buffer === "" && text.startsWith(".")) {
    try {
      handleDotCommand(text);
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }
    rl.prompt();
    return;
  }

  buffer += line + "\n";
  if (!text.endsWith(";")) {
    rl.setPrompt("   ...> ");
    rl.prompt();
    return;
  }

  try {
    runSql(buffer);
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
  buffer = "";
  rl.setPrompt("secure> ");
  rl.prompt();
});

rl.on("close", () => {
  db.close();
  console.log("\nbye.");
  process.exit(0);
});
