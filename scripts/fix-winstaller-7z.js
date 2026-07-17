/**
 * Workaround for electron-winstaller 5.4.0 packaging bug.
 *
 * The published package ships only arch-suffixed 7-Zip binaries
 * (vendor/7z-x64.exe, vendor/7z-arm64.exe, + matching .dll) and relies on its
 * own postinstall script (script/select-7z-arch.js) to copy the host-arch one
 * to vendor/7z.exe / vendor/7z.dll. That script is broken — it uses `os.arch`
 * (the function) instead of `os.arch()` — so on a fresh install the plain
 * 7z.exe/7z.dll are never created. Squirrel's releasify then fails to extract
 * the .nupkg with "The system cannot find the file specified", and no
 * Setup.exe / RELEASES / -full.nupkg are produced.
 *
 * This script creates the missing files correctly. It is idempotent and never
 * throws, so it is a no-op on machines where the files already exist and is
 * safe to run as a postinstall on any platform.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const vendor = path.join(__dirname, '..', 'node_modules', 'electron-winstaller', 'vendor');
const arch = os.arch(); // host arch: 'x64', 'arm64', etc.

for (const ext of ['exe', 'dll']) {
  const src = path.join(vendor, `7z-${arch}.${ext}`);
  const dst = path.join(vendor, `7z.${ext}`);
  try {
    if (fs.existsSync(dst)) continue;   // already present -> leave it alone
    if (!fs.existsSync(src)) continue;  // winstaller absent / different layout -> skip quietly
    fs.copyFileSync(src, dst);
    console.log(`[fix-winstaller-7z] created ${path.basename(dst)}`);
  } catch (e) {
    console.warn(`[fix-winstaller-7z] skipped ${path.basename(dst)}: ${e.message}`);
  }
}
