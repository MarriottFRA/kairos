# Releasing Kairos

How to cut a release, plus the environment gotchas we hit getting publish to work
(especially on locked-down corporate machines). Read the **Release checklist**
first; the sections after it explain the *why* behind each workaround.

## How shipping works

- The app is **Electron Forge** + **Squirrel.Windows** (`@electron-forge/maker-squirrel`
  → `electron-winstaller`), published to **GitHub Releases** on
  **`MarriottFRA/kairos`** via `@electron-forge/publisher-github` (see
  `forge.config.ts`).
- Installed clients auto-update with **`update-electron-app`** (`src/main.ts`), which
  asks `update.electronjs.org` for a newer release and lets Squirrel's native
  `autoUpdater` pull the artifacts from our GitHub Releases.
- **Nothing names the repo at runtime.** `updateElectronApp()` is called with no
  `repo` option, so it calls its own `guessRepo()`, which parses the `repository.url`
  field out of the **packaged `package.json`**. If you ever change that field, the
  auto-updater silently follows it. The manual "check for updates" button is separate
  and *does* hardcode the repo, in `src/ipc/handlers/app.ts` — keep the two in sync.
- **The repo must stay public.** `update.electronjs.org` refuses to serve private
  repositories. Flipping `MarriottFRA/kairos` to private breaks auto-update for every
  installed client, with no error the user can see.
- The publisher is configured with **`draft: true`**, so `npm run publish` creates a
  **draft** release. Clients do **not** get the update until you open the draft on
  GitHub and click **Publish release**.
- Build is **x64 only**. There is intentionally no 32-bit (`ia32`) build — the
  postPackage hook bundles x64-only native modules (`better-sqlite3-multiple-ciphers`
  and the koffi platform package `@koromix/koffi-win32-x64`). A missing `x32` folder
  under `out\make\...` is expected, not a bug.

## Release checklist

1. Make sure the app isn't running (it locks files under `out\`).
2. Make sure `GITHUB_TOKEN` is set — see **GitHub token** below. Without it the build
   succeeds and then the upload step dies.
3. Commit your code changes first (`npm version` requires a clean working tree).
4. Bump the version — this also commits and tags:
   ```powershell
   npm version patch          # 0.0.3 -> 0.0.4 (commit + tag v0.0.4)
   ```
   If the tag already exists (a burned version number), bump to the next free one:
   ```powershell
   git tag -l "v0.0.*"        # find next free
   npm version 0.0.5          # use an explicit free version
   ```
5. Clean previous build output:
   ```powershell
   Remove-Item -Recurse -Force .\out
   ```
6. Publish (see **Corporate network** below for the cert var):
   ```powershell
   $env:NODE_EXTRA_CA_CERTS = "$env:USERPROFILE\corp-roots.pem"
   npm run publish
   ```
   Success = `out\make\squirrel.windows\x64\` contains
   `kairos-<ver>-full.nupkg`, `RELEASES`, and `Kairos-<ver> Setup.exe`.
7. Push the version commit + tag:
   ```powershell
   git push --follow-tags
   ```
   Push **before** you publish the draft, not after — see **Icons** below for why the
   release can look right and still ship a broken icon if you skip this.
8. On GitHub, open the **draft** release for the new version and click
   **Publish release**. Auto-update only serves published (non-draft) releases.

## GitHub token

`@electron-forge/publisher-github` reads **`process.env.GITHUB_TOKEN`** and nothing
else — not `GH_TOKEN`, not your `gh` CLI login. With no token it throws:

```
Please set GITHUB_TOKEN in your environment to access these features
```

`forge.config.ts` starts with `import 'dotenv/config'`, so the simplest setup is a
`.env` at the repo root (gitignored; see `.env.example`):

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

Required scope:

- **Classic PAT** — the `repo` scope.
- **Fine-grained PAT** — *Contents: Read and write*, and `MarriottFRA/kairos` must be
  listed explicitly among the token's repositories. A fine-grained token minted for a
  different repo fails here with a 404, not a permissions error, which reads as "repo
  doesn't exist" and sends you looking in the wrong place.

Tokens are per-repo-ish and expire; if publish suddenly 404s on a repo you can browse
fine in a browser, suspect the token before suspecting the config.

## Icons

`src/images/kairos_logo.*` must be **committed and pushed**. Two separate consumers:

- The build reads them off disk — `packagerConfig.icon`, the Squirrel `setupIcon`, the
  deb/rpm icons. This works on your machine even if the files are untracked, which is
  exactly how they stayed untracked for a while.
- `iconUrl` in `forge.config.ts` is a **URL Squirrel bakes into the nuspec**:
  `https://raw.githubusercontent.com/MarriottFRA/kairos/master/src/images/kairos_logo.ico`.
  It's fetched by the *client*, at install time, from `master`. If the file isn't on
  master, that URL 404s and the Apps & features (Add/Remove Programs) entry falls back
  to a generic Electron icon. There is no build-time error for this.

So: a release built from a local commit you haven't pushed will install with the wrong
ARP icon. Push first.

## Testing auto-update

One release proves nothing — the updater needs a *newer* one to find. To actually
verify the loop:

1. Publish and un-draft release A (say `0.0.4`).
2. Install it from `Kairos-0.0.4 Setup.exe`. Per-user install, no admin rights, lands
   in `%LocalAppData%\kairos`.
3. Publish and un-draft release B (`0.0.5`).
4. Launch the installed 0.0.4. It checks on startup and then every 10 minutes
   (`src/main.ts`), downloads silently, and fires `update-downloaded`.

Useful while testing:

- **There is no log file by default.** `src/main.ts` sets
  `log.transports.file.level = false`, which disables `electron-log`'s file transport
  outright — so a packaged build writes nothing to `%AppData%\Kairos\logs\`, and its
  console output isn't visible either. Before a publish test, temporarily set that to
  `'info'` and rebuild. `update-electron-app` logs the resolved `feedURL` on startup;
  that line is the fastest way to confirm it resolved `MarriottFRA/kairos` and not
  something else. Revert before shipping for real.
- Update checks are **disabled in development** (`app.isPackaged` guard in both
  `initializeAutoUpdater()` and `update-electron-app` itself). `npm start` will never
  show you an update.
- The installer is **unsigned**, so SmartScreen warns on first install ("Windows
  protected your PC" → More info → Run anyway). Expected until we buy a code-signing
  certificate.

## Environment fixes (the stuff that bit us)

### 1. electron-winstaller 7z bug — FIXED automatically, do not remove

**Symptom:** `npm run publish` builds fine, then Squirrel's releasify dies with:
```
Utility: Failed to extract file ...\kairos-<ver>-full.nupkg to ...\SquirrelTemp\tempa
The system cannot find the file specified
... Win32Exception at Squirrel.Utility.CreateZipFromDirectory
```
Only the intermediate `kairos.<ver>.nupkg` is produced; no `Setup.exe`/`RELEASES`.

**Cause:** `electron-winstaller` ships only arch-suffixed 7-Zip binaries
(`vendor/7z-x64.exe`, `7z-x64.dll`) and relies on its own postinstall
(`node_modules/electron-winstaller/script/select-7z-arch.js`) to copy the host-arch
one to `vendor/7z.exe` / `vendor/7z.dll`. **That script is broken** — it uses
`os.arch` (the function) instead of `os.arch()`, so the copy never happens and the
plain `7z.exe`/`7z.dll` Squirrel needs to extract the nupkg are missing.

**Fix (in this repo):** `scripts/fix-winstaller-7z.js` creates the missing files
correctly. It runs automatically via the `postinstall` script in `package.json`, so a
fresh `npm install` self-heals on any machine. It's idempotent and never throws — a
no-op where the files already exist. If you ever need to run it manually:
```powershell
node ./scripts/fix-winstaller-7z.js
```

> Note: `node_modules` is per-machine and git-ignored, so this bug appears only on
> machines whose install didn't already have `7z.exe`. That's why it failed on the
> corporate machine but not a personal rig that had a working copy from an earlier
> install. The committed `postinstall` normalizes both.

### 2. Corporate network — self-signed certificate in certificate chain

**Symptom:** publish reaches the upload step then fails with
`RequestError: self-signed certificate in certificate chain`.

**Cause:** corporate TLS interception (proxy injects its own root CA). Forge's GitHub
publisher uses Node's HTTP client, and Node doesn't trust the corporate root CA.
(`git push` works because Git uses the Windows cert store; Node has its own.)

**Fix — preferred (keeps TLS verification on):** export the Windows root store to a
PEM and point Node at it:
```powershell
$pem = "$env:USERPROFILE\corp-roots.pem"
Get-ChildItem Cert:\LocalMachine\Root | ForEach-Object {
  "-----BEGIN CERTIFICATE-----"
  [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
  "-----END CERTIFICATE-----"
} | Out-File -Encoding ascii $pem
$env:NODE_EXTRA_CA_CERTS = $pem
# optional, make permanent: setx NODE_EXTRA_CA_CERTS "$env:USERPROFILE\corp-roots.pem"
```
**Fix — quick/unsafe (one-off only):** disable TLS verification for the session:
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
```
Only affects the network/upload step. It does **not** help any local build failure.

Note this cuts the other way at *runtime*: the app deliberately uses Electron's
`net.fetch` (Chromium's stack, which honours the Windows cert store) rather than Node's
`https` for its own GitHub and API calls, precisely so end users behind the same proxy
don't need any of this.

### 3. Version tag collisions

**Symptom:** `npm version patch` bumps `package.json` and commits, then fails with
`fatal: tag 'v0.0.x' already exists`.

**Cause:** that version number was already tagged/released. `npm version` does
bump+commit before tagging, so you're left with a bump commit and no tag.

**Fix:** move to the next free version. Either re-point the bump commit
(`npm version <next> --no-git-tag-version` → `git commit -a --amend` →
`git tag v<next>`) or undo and redo (`git reset --hard HEAD~1` → `npm version <next>`,
safe because the bump commit is auto-generated).

## Things we investigated and RULED OUT (don't chase these)

- **Long paths (>260).** Max path under `out\...\node_modules` measured **214** — not
  the cause. No need for the long-paths registry flag or a `subst` drive.
- **Node version.** Node 24/26 is fine. The `DEP0174`/`DEP0187` deprecation warnings
  during the build are noise; the real failure was the missing `7z.exe` (item 1). No
  Node downgrade is needed.
- **Antivirus quarantine.** Plausible on a corporate box, but not what happened here —
  `SquirrelTemp` simply never received a `7z.exe` to begin with.

## Quick troubleshooting table

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Please set GITHUB_TOKEN in your environment` | no token | add `GITHUB_TOKEN` to `.env` |
| upload 404s on a repo you can browse fine | fine-grained PAT not scoped to `MarriottFRA/kairos` | re-mint the token with this repo listed |
| `cannot find the file specified` in Squirrel releasify; only intermediate `.nupkg` produced | missing `vendor/7z.exe` (electron-winstaller bug) | `node ./scripts/fix-winstaller-7z.js` (auto via postinstall) |
| `self-signed certificate in certificate chain` at upload | corporate TLS interception | set `NODE_EXTRA_CA_CERTS` (or `NODE_TLS_REJECT_UNAUTHORIZED=0`) |
| `tag 'v0.0.x' already exists` | version already released | bump to next free version |
| no `x32` folder in `out/make` | x64-only build by design | not an error — ignore |
| clients not updating after publish | release left as draft | publish the draft release on GitHub |
| clients not updating, ever, all at once | repo went private | `update.electronjs.org` won't serve private repos — make it public again |
| generic Electron icon in Apps & features | `kairos_logo.ico` not on `master` | commit + push the icon, then rebuild |
