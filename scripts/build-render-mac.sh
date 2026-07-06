#!/bin/bash
# Builds the Mac native render outputs from video-native/receiver/render/:
#   - librvr.dylib   -- the in-process render surface (embed.swift), loaded by the
#                       Electron main process via koffi (main/nativeRenderSurface.ts).
#                       THIS is the real path: it composites decoded H.264 INSIDE
#                       the Electron window (native-video-plan §3a fix).
#   - video-render   -- the standalone selftest binary (main.swift), for headless
#                       `--selftest` decode verification only.
#
# CLT swiftc, no Xcode.app / no node addon (toolchain settled in phase0/RESULTS.md).
# Output goes to out/video-render -- a SIBLING of out/main, so an electron-vite
# main rebuild (which empties out/main) doesn't wipe the dylib. nativeRenderSurface.ts
# finds it via its dev fallback (join(__dirname,'..','video-render',...)) or the
# explicit VIDEO_RENDER_LIB the native launcher sets.
set -euo pipefail

cd "$(dirname "$0")/.."
RENDER_DIR="apps/desktop/src/video-native/receiver/render"
OUT_DIR="apps/desktop/out/video-render"
mkdir -p "$OUT_DIR"

echo "[build-render] compiling librvr.dylib (in-process render surface)"
swiftc -O -emit-library \
  -o "$OUT_DIR/librvr.dylib" \
  "$RENDER_DIR/decoder.swift" "$RENDER_DIR/embed.swift"

echo "[build-render] compiling video-render (selftest binary)"
swiftc -O \
  -o "$OUT_DIR/video-render" \
  "$RENDER_DIR/decoder.swift" "$RENDER_DIR/main.swift"

echo "[build-render] done -> $OUT_DIR"
ls -la "$OUT_DIR"
