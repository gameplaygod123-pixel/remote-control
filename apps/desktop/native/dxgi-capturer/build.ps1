# build.ps1 — compile the DXGI capturer (3a harness + 3b NVENC) with MSVC.
# Locates VS Build Tools via vswhere, imports vcvars64, auto-fetches the
# redistributable nvEncodeAPI.h, and invokes cl.exe. Output: capturer.exe here.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "vswhere not found. Install VS Build Tools: winget install --id Microsoft.VisualStudio.2022.BuildTools --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'"
}
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "MSVC VC tools (x86.x64) not found via vswhere." }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

# NVENC API header — redistributable MIT header, same one ffmpeg uses. Auto-fetch
# (not committed), mirroring how build-win.sh downloads/caches ffmpeg.
$inc = Join-Path $here 'third_party\nvcodec'
$hdr = Join-Path $inc 'nvEncodeAPI.h'
if (-not (Test-Path $hdr)) {
    New-Item -ItemType Directory -Force $inc | Out-Null
    Write-Host "[build] fetching nvEncodeAPI.h (FFmpeg/nv-codec-headers) ..."
    Invoke-WebRequest -UseBasicParsing `
        -Uri 'https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/master/include/ffnvcodec/nvEncodeAPI.h' `
        -OutFile $hdr
}

$out = Join-Path $here 'capturer.exe'
Write-Host "[build] MSVC at: $vs"
Write-Host "[build] compiling main.cpp + nvenc.cpp -> $out"

# cd into $here so objects and the exe land beside the sources (avoids /Fo path quoting).
$cl = "cd /d `"$here`" && cl /nologo /W3 /EHsc /O2 /std:c++17 /D_CRT_SECURE_NO_WARNINGS /I`"$inc`" main.cpp nvenc.cpp /Fe:capturer.exe /link d3d11.lib dxgi.lib user32.lib"
# Suppress vcvars' own banner/stderr (harmless internal vswhere call); keep cl output.
$full = "call `"$vcvars`" >nul 2>nul && $cl"
cmd /c $full
if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit $LASTEXITCODE" }

Write-Host "[build] OK -> $out"
