#!/bin/bash
cd "$(dirname "$0")/apps/desktop"
# The input-helper is forked with ELECTRON_RUN_AS_NODE=1, and this launcher can
# itself be started from an already-Electron parent (VS Code's integrated
# terminal, Claude Code) that has that var set. If it leaks into the env we
# hand to `electron-vite dev`, Electron boots as plain Node -- `electron.app`
# is undefined and the app crashes at import ("Cannot read properties of
# undefined (reading 'isPackaged')") the instant the window would appear.
# Strip it unconditionally so the controller always launches as real Electron.
unset ELECTRON_RUN_AS_NODE
# The signaling server runs on THIS Mac (see server/signaling/supervisor.mjs),
# so the controller talks to it directly over localhost -- no tunnel hop, and
# this never goes stale when the tunnel URL rotates. Only remote machines
# (the Windows agents) need the public tunnel URL, which they fetch from
# signaling-url.json on GitHub at runtime.
export VITE_SIGNALING_URL="ws://localhost:8080"
export APP_MODE=controller
pnpm dev
