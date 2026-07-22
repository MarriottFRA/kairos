/**
 * Run vitest under Electron's Node runtime (ELECTRON_RUN_AS_NODE).
 *
 * The repo's native module (better-sqlite3-multiple-ciphers) is compiled for
 * Electron's ABI, so tests that open real SQLite databases cannot load it
 * under the system Node. Electron-as-Node matches the ABI exactly and needs
 * no second build or C++ toolchain. Extra CLI args pass through to vitest.
 */

const { spawnSync } = require("child_process");

// Required from plain Node, the electron package resolves to the binary path.
const electron = require("electron");

const result = spawnSync(
  electron,
  ["./node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }
);

process.exit(result.status === null ? 1 : result.status);
