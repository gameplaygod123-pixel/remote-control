#!/bin/bash
# Launch the Mac controller with the NATIVE video pipeline engaged
# (VIDEO_PIPELINE=native). Everything is byte-identical to start-controller.command
# except it (1) builds the native render dylib first and (2) sets the env knobs so
# the receiver helper + in-process render surface actually run. Default WebRTC is
# unaffected -- use the normal launcher for that.
cd "$(dirname "$0")/apps/desktop"

# See start-controller.command: strip a leaked ELECTRON_RUN_AS_NODE so Electron
# boots as real Electron, not plain Node.
unset ELECTRON_RUN_AS_NODE

# Build librvr.dylib (+ selftest binary) next to the built main bundle so
# nativeRenderSurface.ts finds it. Cheap; safe to run every launch.
bash ../../scripts/build-render-mac.sh

export VITE_SIGNALING_URL="ws://localhost:8080"
export APP_MODE=controller
export VIDEO_PIPELINE=native
# nativeRenderSurface.ts also has a dev fallback path, but be explicit:
export VIDEO_RENDER_LIB="$(cd ../.. && pwd)/apps/desktop/out/video-render/librvr.dylib"
pnpm dev
