# build.ps1 — compile the Step 3a DXGI capturer with MSVC (no cmake needed for a
# single translation unit). Locates VS Build Tools via vswhere, imports vcvars64,
# and invokes cl.exe. Output: capturer.exe next to this script.
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

$src = Join-Path $here 'main.cpp'
$out = Join-Path $here 'capturer.exe'

Write-Host "[build] MSVC at: $vs"
Write-Host "[build] compiling $src -> $out"

# Run cl inside a vcvars-initialized cmd so the SDK include/lib paths resolve.
$obj = Join-Path $here 'capturer.obj'
$cl = "cl /nologo /W3 /EHsc /O2 /std:c++17 `"$src`" /Fe:`"$out`" /Fo:`"$obj`" /link d3d11.lib dxgi.lib user32.lib"
# Suppress vcvars' own banner/stderr (it internally shells out to vswhere without
# a full path and prints a harmless "not recognized" line); keep cl's output.
$full = "call `"$vcvars`" >nul 2>nul && $cl"
cmd /c $full
if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit $LASTEXITCODE" }

Write-Host "[build] OK -> $out"
