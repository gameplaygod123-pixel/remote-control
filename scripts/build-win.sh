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

# Sanity check: the built app must contain the WINDOWS binary.
PACKED=$(find dist/win-unpacked -path "*node-datachannel*" -name "node_datachannel.node" | head -1)
if [ -z "$PACKED" ] || ! file "$PACKED" | grep -q "PE32+"; then
  echo "ERROR: packaged node_datachannel.node is missing or not a Windows PE" >&2
  exit 1
fi
echo "OK: packaged node-datachannel is win32-x64 ($PACKED)"
