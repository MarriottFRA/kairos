#!/usr/bin/env python3
"""Companion to portable-msvc.py: adds MSBuild and the VC v143 build targets.

portable-msvc.py downloads the compiler and Windows SDK but not MSBuild (it deletes
Common7). node-gyp drives Windows builds through MSBuild rather than invoking cl.exe
directly, so without this the build fails immediately.

Run from the same directory as portable-msvc.py, after it has finished:

    python fetch-msbuild.py

Extracts into the same ./msvc folder. See WINDOWS_NATIVE_BUILD.md.
"""
import io
import hashlib
import json
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

try:
    import truststore
    truststore.inject_into_ssl()
except ModuleNotFoundError:
    # Only needed behind a TLS-intercepting proxy; see WINDOWS_NATIVE_BUILD.md.
    pass

OUTPUT = Path("msvc")
DOWNLOADS = Path("downloads")
CACHE = Path("vsmanifest.json")
CHANNEL = "https://aka.ms/vs/17/release/channel"

PACKAGES = [
    "microsoft.build",                          # MSBuild.exe + core targets
    "microsoft.build.dependencies",
    "microsoft.build.filetracker.msi",          # tracked C++ builds
    "microsoft.visualstudio.vc.msbuild.base",
    "microsoft.visualstudio.vc.msbuild.base.resources",
    "microsoft.visualstudio.vc.msbuild.x64",
    "microsoft.visualstudio.vc.msbuild.v170.base",
    "microsoft.visualstudio.vc.msbuild.v170.base.resources",
    "microsoft.visualstudio.vc.msbuild.v170.x64",
    "microsoft.visualstudio.vc.msbuild.v170.x64.v143",
    "microsoft.visualcpp.tools.core",
    "microsoft.visualcpp.tools.core.x86",
]

# portable-msvc.py strips VC\Redist, but Microsoft.VCToolsVersion.default.props imports
# this file unconditionally and MSBuild fails with MSB4019 without it. The redist itself
# is genuinely unused: node-gyp links the CRT statically (/MT).
VCREDIST_PROPS = """<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <VCToolsRedistVersion Condition="'$(VCToolsRedistVersion)' == ''">14.44.35211</VCToolsRedistVersion>
  </PropertyGroup>
</Project>
"""


def download(url):
    with urllib.request.urlopen(url) as res:
        return res.read()


def download_verified(url, sha256, filename):
    fpath = DOWNLOADS / filename
    if fpath.exists():
        data = fpath.read_bytes()
        if hashlib.sha256(data).hexdigest() == sha256.lower():
            print(f"{filename} ... cached")
            return data
    data = download(url)
    if hashlib.sha256(data).hexdigest() != sha256.lower():
        sys.exit(f"Hash mismatch for {filename}")
    fpath.write_bytes(data)
    print(f"{filename} ... {len(data) >> 10}KB")
    return data


if not OUTPUT.exists():
    sys.exit(f"{OUTPUT} not found - run portable-msvc.py first")

DOWNLOADS.mkdir(exist_ok=True)

if CACHE.exists():
    vsmanifest = json.loads(CACHE.read_bytes())
else:
    print("Downloading VS manifest...")
    channel = json.loads(download(CHANNEL))
    vs = next(x for x in channel["channelItems"]
              if x["id"] == "Microsoft.VisualStudio.Manifests.VisualStudio")
    raw = download(vs["payloads"][0]["url"])
    CACHE.write_bytes(raw)
    vsmanifest = json.loads(raw)

ids = {}
for p in vsmanifest["packages"]:
    ids.setdefault(p["id"].lower(), []).append(p)

msi = []
for pkg in PACKAGES:
    if pkg not in ids:
        print(f"{pkg} ... !!! MISSING !!!")
        continue
    p = next((x for x in ids[pkg] if x.get("language") in (None, "en-US")), ids[pkg][0])
    for payload in p["payloads"]:
        filename = Path(payload["fileName"].replace("\\", "/")).name
        data = download_verified(payload["url"], payload["sha256"], filename)
        if filename.lower().endswith(".msi"):
            msi.append(DOWNLOADS / filename)
            continue
        if not zipfile.is_zipfile(io.BytesIO(data)):
            continue
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                if name.startswith("Contents/"):
                    out = OUTPUT / Path(name).relative_to("Contents")
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(z.read(name))

for m in msi:
    subprocess.check_call(
        f'msiexec /a "{m.resolve()}" /quiet /qn TARGETDIR="{OUTPUT.resolve()}"')
    (OUTPUT / m.name).unlink(missing_ok=True)

redist_props = OUTPUT / "VC/Auxiliary/Build/Microsoft.VCRedistVersion.default.props"
redist_props.parent.mkdir(parents=True, exist_ok=True)
redist_props.write_text(VCREDIST_PROPS)
print(f"wrote {redist_props}")

msbuild = OUTPUT / "MSBuild/Current/Bin/MSBuild.exe"
targets = OUTPUT / "MSBuild/Microsoft/VC/v170/Microsoft.Cpp.targets"
print(f"MSBuild.exe present: {msbuild.exists()}")
print(f"VC v170 targets present: {targets.exists()}")
print("Done.")
