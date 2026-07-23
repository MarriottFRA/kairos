# Building on Windows without admin rights

## The symptom

`npm install` succeeds, then `npm start` fails:

```
✖ Preparing native dependencies: 0 / 1
  › node-gyp failed to rebuild
    'node_modules\better-sqlite3-multiple-ciphers'

gyp ERR! find VS You need to install the latest version of Visual Studio
        including the "Desktop development with C++" workload.
Error: Could not find any Visual Studio installation to use
```

`better-sqlite3-multiple-ciphers` publishes no prebuilt binary for our Electron version, so
node-gyp has to compile it from source and needs a C++ compiler. Nothing is wrong with your
`npm install`.

## Fix it the easy way first

Install **Build Tools for Visual Studio 2022** with the *Desktop development with C++*
workload:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

If that works, stop reading. `npm start` will work.

The rest of this document is for locked-down corporate machines where the above fails with
**"This operation is disabled by Group Policy"** and you can't get admin rights.

---

## Option A: get the compiled binary from a colleague

Native modules only care about **arch + ABI + module version** - nothing else about the
machine matters. Someone with a working toolchain can build it and send you one file.

On their machine:

```powershell
npx electron-rebuild -f -a x64 -v <electron-version> -w better-sqlite3-multiple-ciphers
```

They send you `node_modules\better-sqlite3-multiple-ciphers\build\Release\better_sqlite3.node`.

You put it at the identical path, then write the marker that tells Electron Forge it's
already built:

```powershell
$rel = "node_modules\better-sqlite3-multiple-ciphers\build\Release"
Set-Content -Encoding ascii -NoNewline "$rel\.forge-meta" "x64--<abi>"
```

Find `<abi>` with `node -e "console.log(require('node-abi').getAbi('<electron-version>','electron'))"`
(148 for Electron 43). `@electron/rebuild` compares this string exactly and skips the
rebuild when it matches.

Fast, but you depend on someone else every time Electron's major version changes.

## Option B: portable MSVC toolchain

Unpacks the real Microsoft compiler into a folder. No admin, no registry, no installer
service, no `Program Files`. Delete the folder and it's gone.

### 1. Get the toolchain

```powershell
mkdir $env:USERPROFILE\.portable-msvc
cd $env:USERPROFILE\.portable-msvc
curl.exe -o portable-msvc.py https://gist.githubusercontent.com/mmozeiko/7f3162ec2988e81e56d5c4e22cde9977/raw/portable-msvc.py
python portable-msvc.py --accept-license --vs 2022 --host x64 --target x64
```

Downloads ~460 MB from Microsoft's CDN, every payload SHA256-verified against the official
VS manifest. Needs Python 3.

Pin `--vs 2022`. node-gyp only recognises VS up to version 17; VS 2026 (v18) is rejected.

> **Behind a TLS-intercepting proxy?** If this dies with `CERTIFICATE_VERIFY_FAILED`,
> Python isn't using the Windows certificate store. Install `truststore` and add two lines
> to the top of the script:
> ```powershell
> pip install --user truststore --trusted-host pypi.org --trusted-host files.pythonhosted.org
> ```
> ```python
> import truststore
> truststore.inject_into_ssl()
> ```
> This still validates the chain - it just delegates to Windows, which trusts your proxy's
> CA. Don't disable verification.

### 2. Add MSBuild

The script above omits MSBuild, and node-gyp builds through MSBuild rather than calling
`cl.exe` directly. Run this repo's companion script from the same folder:

```powershell
copy <repo>\scripts\portable-msvc\fetch-msbuild.py .
python fetch-msbuild.py
```

It should end with `MSBuild.exe present: True` / `VC v170 targets present: True`.

### 3. Build

```powershell
. <repo>\scripts\portable-msvc\devshell.ps1
npm start
```

`devshell.ps1` assumes `%USERPROFILE%\.portable-msvc`; pass `-Root <path>` if you put it
elsewhere.

## How often do I need the dev shell?

Rarely. After one successful build, `@electron/rebuild` writes `.forge-meta` (see Option A)
and skips the rebuild on every later run, so plain `npm start` works in any shell.

You only need the dev shell again after:

| Trigger | Why |
| --- | --- |
| `npm install` / `npm ci` | wipes `node_modules`, taking `build/` and the marker with it |
| Electron **major** version bump | the ABI changes, so the marker no longer matches |
| bumping a native dependency | different source, must rebuild |
| building for another arch (e.g. arm64) | the marker is arch-specific |

It is **not** per publish - packaging reuses the same compiled binary.

Worth stashing the built `.node` somewhere outside `node_modules` so you can restore it
after a reinstall instead of recompiling.

## Does any of this affect the shipped app?

No. The toolchain is build-time only; what ships is the compiled `.node`. Electron's
`config.gypi` sets `node_shared: 'false'`, which selects `/MT`, so the C runtime is
statically linked and **no VC++ redistributable is needed** on user machines. The output is
byte-for-byte what a normal Build Tools install produces - it is the same Microsoft
compiler.

---

## Appendix: why the portable toolchain needs so much coaxing

Everything in `devshell.ps1` compensates for the toolchain not being *registered*. Each of
these was a separate build failure, in the order they surface. Useful if you hit a variant
of one.

1. **`Could not find any Visual Studio installation`** - node-gyp detects VS via the VSSetup
   PowerShell module and a COM class, neither of which exists for an unpacked copy. Setting
   `VCINSTALLDIR` makes node-gyp skip detection entirely; `VSCMD_VER=17.x` tells it VS2022,
   which maps to toolset v143.

2. **`MSB4019: Microsoft.VCRedistVersion.default.props was not found`** - `portable-msvc.py`
   strips `VC\Redist`, but `Microsoft.VCToolsVersion.default.props` imports that file
   unconditionally. `fetch-msbuild.py` recreates it; it only defines `VCToolsRedistVersion`,
   and the redist really is unused because of `/MT`.

3. **`MSB8036: The Windows SDK version ... was not found`** - the SDK is found through the
   registry, and the `DesignTime\` marker the check falls back on is stripped too. The whole
   check is guarded on `DisableRegistryUse != 'true'`, so setting that skips it; the SDK
   paths are then supplied directly.

4. **`MSB8070: Cannot find MSVC toolset ... 'VCToolsInstallDir_170_is_not_defined'`** - a
   consequence of (3): `Microsoft.Cpp.VCTools.props` stubs the versioned properties to
   `*_is_not_defined` when `DisableRegistryUse` is set and they're empty. Note
   `VCToolsInstallDir_170` must be set *explicitly* - the stub runs before the rule that
   would derive it from `VCInstallDir_170`.

5. **`C1083: Cannot open include file: 'windows.h'`** - MSBuild rebuilds the compiler's
   `INCLUDE`/`LIB` from `$(IncludePath)`/`$(LibraryPath)` instead of inheriting the shell's,
   and those are assembled from the registry-derived paths that are empty here.

MSBuild seeds its properties from environment variables, which is what makes (3)-(5)
fixable from a shell script without editing any Microsoft `.props`/`.targets` file.
