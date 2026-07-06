# Phase 0 rawInject harness launcher. Usage:
#   scripts\phase0.ps1 move|button|text|copy|wheel|all
# Runs the TS harness via the tsx already present in the pnpm store.
param([string]$Stage = "all")
$ErrorActionPreference = "Stop"
$desktop = Join-Path $PSScriptRoot "..\apps\desktop"
$tsx = Join-Path $PSScriptRoot "..\node_modules\.pnpm\tsx@4.22.4\node_modules\tsx\dist\cli.mjs"
Push-Location $desktop
try {
  node $tsx "src/input-service/dev/phase0-rawinject.ts" $Stage
} finally {
  Pop-Location
}
