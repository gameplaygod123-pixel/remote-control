#!/usr/bin/env bash
# Install the patched (NACK-emitting) node-datachannel binary into node_modules for the
# Mac controller. Re-run after any `pnpm install` (which restores the stock prebuilt and
# disables silent loss repair). darwin-arm64 only; the Windows agent uses stock ndc.
#
# The committed binary is built from rtcpreceivingsession-nack.patch on libdatachannel
# v0.24.2 (see README.md for the from-source recipe). Copying over a mach-o macOS has
# already validated needs a re-codesign or it SIGKILLs on dlopen -- handled below.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(cd ../../../.. && pwd)
SRC="bin/node_datachannel.darwin-arm64.node"
DEST="$REPO/node_modules/.pnpm/node-datachannel@0.32.3/node_modules/node-datachannel/build/Release/node_datachannel.node"

if [ ! -f "$SRC" ]; then echo "missing $SRC (build via README.md recipe)"; exit 1; fi
if [ ! -d "$(dirname "$DEST")" ]; then echo "node-datachannel@0.32.3 not installed at the expected path"; exit 1; fi

# back up the stock prebuilt once
[ -f "$DEST.orig-prebuilt" ] || cp "$DEST" "$DEST.orig-prebuilt"

rm -f "$DEST"
cp "$SRC" "$DEST"
codesign --force --sign - "$DEST"
node -e "require('node-datachannel')" >/dev/null 2>&1 && echo "OK: patched ndc installed + loads (NACK-emitting)" \
  || { echo "FAILED to load -- reverting"; cp "$DEST.orig-prebuilt" "$DEST"; exit 1; }
echo "Launch the controller with VIDEO_NACK_BUFFER=1 to enable silent loss repair."
