#!/bin/bash
cd "$(dirname "$0")/apps/desktop"
# The signaling server runs on THIS Mac (see server/signaling/supervisor.mjs),
# so the controller talks to it directly over localhost -- no tunnel hop, and
# this never goes stale when the tunnel URL rotates. Only remote machines
# (the Windows agents) need the public tunnel URL, which they fetch from
# signaling-url.json on GitHub at runtime.
export VITE_SIGNALING_URL="ws://localhost:8080"
export APP_MODE=controller
pnpm dev
