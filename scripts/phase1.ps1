# Phase 1 pipe/transport harness launcher. Usage:
#   scripts\phase1.ps1 decoder|forward|fallback|framing|all
# Sets PR_INPUT_SERVICE=1 (serviceClient reads it at import) and runs the TS
# harness via the tsx already in the pnpm store. Requires a prior `pnpm --filter
# desktop build` so out/main/input-injector.js exists.
param([string]$Stage = "all")
$ErrorActionPreference = "Stop"
$desktop = Join-Path $PSScriptRoot "..\apps\desktop"
$tsx = Join-Path $PSScriptRoot "..\node_modules\.pnpm\tsx@4.22.4\node_modules\tsx\dist\cli.mjs"
$env:PR_INPUT_SERVICE = "1"
Push-Location $desktop
try {
  node $tsx "src/input-service/dev/phase1-pipe.ts" $Stage
} finally {
  Pop-Location
}
