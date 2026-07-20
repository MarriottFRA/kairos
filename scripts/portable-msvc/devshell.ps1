# Puts a portable MSVC toolchain on the current PowerShell session, so node-gyp can
# build native modules without Visual Studio being installed system-wide.
#
# Usage:
#     . .\scripts\portable-msvc\devshell.ps1
#     npm start
#
# See WINDOWS_NATIVE_BUILD.md for how to create the toolchain in the first place.

param(
    # Where portable-msvc.py was run; must contain an "msvc" subfolder.
    [string]$Root = (Join-Path $env:USERPROFILE '.portable-msvc')
)

$ErrorActionPreference = 'Stop'

$msvc = Join-Path $Root 'msvc'
$setup = Join-Path $msvc 'setup_x64.bat'
if (-not (Test-Path $setup)) {
    throw "Not found: $setup`nRun portable-msvc.py first - see WINDOWS_NATIVE_BUILD.md"
}

# Run setup_x64.bat in a child cmd and import the environment it produces
# (PATH / INCLUDE / LIB / VCToolsVersion / WindowsSDKVersion).
foreach ($line in (cmd /c "`"$setup`" && set")) {
    if ($line -match '^([^=]+)=(.*)$') {
        Set-Item -Path "env:$($matches[1])" -Value $matches[2]
    }
}

$sdkVer = $env:WindowsSDKVersion.TrimEnd('\')
$sdk = Join-Path $msvc 'Windows Kits\10'

# --- Everything below compensates for the toolchain not being registered ---------------
# A normal VS install is discovered through the registry and a COM class. Neither exists
# for an unpacked copy, so each consumer has to be pointed at it explicitly. MSBuild seeds
# its properties from environment variables, which is what makes this possible without
# editing any Microsoft .props/.targets file.

# node-gyp: skips its VS detection entirely when VCINSTALLDIR is set, and reads VSCMD_VER
# to decide the version. 17.x => VS2022 => toolset v143.
$env:VCINSTALLDIR = (Join-Path $msvc 'VC') + '\'
$env:VSCMD_VER = '17.14.0'
$env:VSCMD_ARG_HOST_ARCH = 'x64'
$env:VSCMD_ARG_TGT_ARCH = 'x64'

# MSBuild: skip the registry probe for the Windows SDK (Microsoft.Cpp.WindowsSDK.targets
# guards its check on this) and supply the SDK location directly.
$env:DisableRegistryUse = 'true'
$env:WindowsSdkDir = "$sdk\"
$env:WindowsSdkVerBinPath = "$sdk\bin\$sdkVer\"
$env:WindowsSDKLibVersion = "$sdkVer\"
$env:UniversalCRTSdkDir = "$sdk\"
$env:UCRTVersion = $sdkVer

# With DisableRegistryUse set, Microsoft.Cpp.VCTools.props stubs these to
# "*_is_not_defined" when empty. VCToolsInstallDir_170 must be set explicitly: that stub
# runs before the rule that would otherwise derive it from VCInstallDir_170.
$env:VSInstallDir = "$msvc\"
$env:VCInstallDir_170 = (Join-Path $msvc 'VC') + '\'
$env:VCToolsInstallDir_170 = (Join-Path $msvc "VC\Tools\MSVC\$env:VCToolsVersion") + '\'

# MSBuild rebuilds the compiler's INCLUDE/LIB from these rather than inheriting the
# shell's, and they're normally assembled from registry-derived paths.
$env:IncludePath = $env:INCLUDE
$env:ExternalIncludePath = $env:INCLUDE
$env:LibraryPath = $env:LIB

Write-Host "portable MSVC ready" -ForegroundColor Green
Write-Host "  toolset : $env:VCToolsVersion (v143)"
Write-Host "  sdk     : $sdkVer"
Write-Host "  cl.exe  : $((Get-Command cl.exe -ErrorAction SilentlyContinue).Source)"
