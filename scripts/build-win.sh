#!/bin/bash
# Builds the Windows installer FROM THIS MAC with the correct native
# binaries. Needed because node-datachannel (unlike nut.js, which ships one
# package per platform) installs only the CURRENT platform's binary into
# build/Release/node_datachannel.node -- packaging straight from a Mac would
# ship a darwin binary that crashes the input-helper on Windows, silently
# downgrading every session to the renderer input path (which freezes when
# the agent window is hidden -- the exact bug the helper exists to fix).
#
# Usage:  VITE_SIGNALING_URL="wss://..." scripts/build-win.sh
# (VITE_SIGNALING_URL is the baked-in fallback; the app normally resolves
# the live URL from signaling-url.json on GitHub at runtime.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NDC_VERSION="0.32.3"
NDC_DIR="$REPO_ROOT/node_modules/.pnpm/node-datachannel@$NDC_VERSION/node_modules/node-datachannel"
NDC_BINARY="$NDC_DIR/build/Release/node_datachannel.node"
CACHE_DIR="$REPO_ROOT/.cache"
WIN_BINARY="$CACHE_DIR/node_datachannel-win32-x64-$NDC_VERSION.node"
# Native-video encoder bundled into the installer (golden-rule #1 native path).
# LGPL build (licensing settled -- see video-native/sender/README.md) with
# ddagrab (DXGI capture) + h264_nvenc; ~109MB, NOT committed. Staged into
# apps/desktop/ffmpeg/ so electron-builder's win.extraResources packs it to
# resources/ffmpeg/ffmpeg.exe, where resolveFfmpegPath() looks.
FFMPEG_CACHE="$CACHE_DIR/ffmpeg-win32-x64/ffmpeg.exe"
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip"
FFMPEG_STAGE="$REPO_ROOT/apps/desktop/ffmpeg"

if [ -z "${VITE_SIGNALING_URL:-}" ]; then
  echo "ERROR: VITE_SIGNALING_URL must be set (see README / signaling-url.json)" >&2
  exit 1
fi

if [ ! -f "$NDC_BINARY" ]; then
  echo "ERROR: $NDC_BINARY not found -- run pnpm install first" >&2
  exit 1
fi

# Fetch and cache the win32-x64 prebuilt once.
if [ ! -f "$WIN_BINARY" ]; then
  echo "downloading node-datachannel win32-x64 prebuilt..."
  mkdir -p "$CACHE_DIR"
  TMP=$(mktemp -d)
  curl -sL -o "$TMP/ndc.tar.gz" \
    "https://github.com/murat-dogan/node-datachannel/releases/download/v$NDC_VERSION/node-datachannel-v$NDC_VERSION-napi-v8-win32-x64.tar.gz"
  tar xzf "$TMP/ndc.tar.gz" -C "$TMP"
  file "$TMP/build/Release/node_datachannel.node" | grep -q "PE32+" || {
    echo "ERROR: downloaded binary is not a Windows PE -- aborting" >&2
    exit 1
  }
  mv "$TMP/build/Release/node_datachannel.node" "$WIN_BINARY"
  rm -rf "$TMP"
fi

# Fetch and cache the win32 ffmpeg once, verifying the encoders it must contain
# are actually compiled in (strings works on the stripped PE without running it).
if [ ! -f "$FFMPEG_CACHE" ]; then
  echo "downloading ffmpeg win64 LGPL (ddagrab + h264_nvenc)..."
  mkdir -p "$(dirname "$FFMPEG_CACHE")"
  TMP=$(mktemp -d)
  curl -sL -o "$TMP/ffmpeg.zip" "$FFMPEG_URL"
  unzip -o -j "$TMP/ffmpeg.zip" "*/bin/ffmpeg.exe" -d "$TMP" >/dev/null
  file "$TMP/ffmpeg.exe" | grep -q "PE32+" || {
    echo "ERROR: downloaded ffmpeg is not a Windows PE -- aborting" >&2
    exit 1
  }
  for enc in ddagrab h264_nvenc; do
    strings -a "$TMP/ffmpeg.exe" | grep -qx "$enc" || {
      echo "ERROR: bundled ffmpeg is missing '$enc' -- wrong build, aborting" >&2
      exit 1
    }
  done
  mv "$TMP/ffmpeg.exe" "$FFMPEG_CACHE"
  rm -rf "$TMP"
fi

# Stage it where win.extraResources (electron-builder.yml) picks it up.
mkdir -p "$FFMPEG_STAGE"
cp "$FFMPEG_CACHE" "$FFMPEG_STAGE/ffmpeg.exe"
echo "staged ffmpeg -> $FFMPEG_STAGE/ffmpeg.exe"

# Stage the Step 3 custom DXGI capturer IF Windows-Claude has delivered the built
# binary (committed at native/dxgi-capturer/bin/capturer.exe -- small, self-built,
# unlike ffmpeg which is downloaded). Absent = build without it; VIDEO_CAPTURER then
# silently falls back to ffmpeg, so the build still works either way.
CAPTURER_SRC="$REPO_ROOT/apps/desktop/native/dxgi-capturer/bin/capturer.exe"
CAPTURER_STAGE="$REPO_ROOT/apps/desktop/capturer"
mkdir -p "$CAPTURER_STAGE"
rm -f "$CAPTURER_STAGE/capturer.exe"
EXPECT_CAPTURER=0
if [ -f "$CAPTURER_SRC" ]; then
  file "$CAPTURER_SRC" | grep -q "PE32+" || {
    echo "ERROR: native/dxgi-capturer/bin/capturer.exe is not a Windows PE -- aborting" >&2
    exit 1
  }
  cp "$CAPTURER_SRC" "$CAPTURER_STAGE/capturer.exe"
  echo "staged capturer -> $CAPTURER_STAGE/capturer.exe"
  EXPECT_CAPTURER=1
else
  echo "note: native/dxgi-capturer/bin/capturer.exe not present -- building WITHOUT the DXGI capturer (VIDEO_CAPTURER falls back to ffmpeg)"
fi

# Swap in the Windows binary for the duration of the build, then restore the
# darwin one no matter how the build exits.
BACKUP="$NDC_BINARY.darwin-backup"
cp "$NDC_BINARY" "$BACKUP"
restore() {
  mv "$BACKUP" "$NDC_BINARY"
  echo "restored darwin node-datachannel binary"
}
trap restore EXIT

cp "$WIN_BINARY" "$NDC_BINARY"
echo "swapped in win32-x64 node-datachannel binary"

cd "$REPO_ROOT/apps/desktop"
npm run build:win

# Sanity check: the built app must contain the WINDOWS binaries.
PACKED=$(find dist/win-unpacked -path "*node-datachannel*" -name "node_datachannel.node" | head -1)
if [ -z "$PACKED" ] || ! file "$PACKED" | grep -q "PE32+"; then
  echo "ERROR: packaged node_datachannel.node is missing or not a Windows PE" >&2
  exit 1
fi
echo "OK: packaged node-datachannel is win32-x64 ($PACKED)"

# koffi ships per-platform binaries as @koromix/koffi-<platform> optional
# deps; pnpm only installs the win32 one because of supportedArchitectures
# in pnpm-workspace.yaml -- verify it actually made it into the package,
# otherwise the input-helper's keyboard injection dies at require('koffi')
# on the target machine.
KOFFI_WIN=$(find dist/win-unpacked -path "*koffi-win32-x64*" -name "*.node" | head -1)
if [ -z "$KOFFI_WIN" ] || ! file "$KOFFI_WIN" | grep -q "PE32+"; then
  echo "ERROR: packaged koffi win32-x64 binary is missing (check pnpm supportedArchitectures)" >&2
  exit 1
fi
echo "OK: packaged koffi win32-x64 present ($KOFFI_WIN)"

# The native-video encoder must be packed at resources/ffmpeg/ffmpeg.exe, the
# exact path resolveFfmpegPath() reads; a missing one silently drops every native
# session back to WebRTC.
PACKED_FFMPEG=$(find dist/win-unpacked/resources/ffmpeg -name ffmpeg.exe | head -1)
if [ -z "$PACKED_FFMPEG" ] || ! file "$PACKED_FFMPEG" | grep -q "PE32+"; then
  echo "ERROR: packaged resources/ffmpeg/ffmpeg.exe is missing or not a Windows PE" >&2
  exit 1
fi
echo "OK: packaged ffmpeg present ($PACKED_FFMPEG)"

# If we staged the custom DXGI capturer, it must be packed at
# resources/capturer/capturer.exe (resolveCapturerPath()). Only asserted when a
# binary was delivered (EXPECT_CAPTURER=1) so a capturer-less build still passes.
if [ "$EXPECT_CAPTURER" = "1" ]; then
  PACKED_CAPTURER=$(find dist/win-unpacked/resources/capturer -name capturer.exe | head -1)
  if [ -z "$PACKED_CAPTURER" ] || ! file "$PACKED_CAPTURER" | grep -q "PE32+"; then
    echo "ERROR: packaged resources/capturer/capturer.exe is missing or not a Windows PE" >&2
    exit 1
  fi
  echo "OK: packaged capturer present ($PACKED_CAPTURER)"
fi
