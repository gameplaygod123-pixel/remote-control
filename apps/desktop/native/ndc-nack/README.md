# ndc-nack — patched node-datachannel that emits NACK (Mac receiver only)

The endgame loss-repair patch (see [`docs/step-nack-retransmit.md`](../../../../docs/step-nack-retransmit.md)).
Stock libdatachannel v0.24.2 (pinned by node-datachannel 0.32.3) never sends a Generic
NACK from `RtcpReceivingSession` — so the Windows sender's `RtcpNackResponder` (which
already retransmits on NACK) never fires. This patch makes the **Mac receiver** emit a
NACK on a small forward sequence gap, enabling silent retransmit-based recovery instead
of a PLI→IDR hitch. **Mac (darwin-arm64) only** — the Windows agent keeps stock ndc.

## Files
- `rtcpreceivingsession-nack.patch` — the libdatachannel patch (2 files: the `pushNACK`
  method + the gap-detection call in `incoming()`, gap capped at `RTC_NACK_MAX_GAP=64`;
  bigger gaps = blackouts, left to the existing PLI path).
- `nack-test.cpp` — standalone C++ unit test: feeds in-order RTP then a gap, asserts the
  patched `RtcpReceivingSession` emits exactly one NACK listing the missing seqs. PASS =
  patch works. (Verified 2026-07-09: `NACK packets emitted: 1`, seqs `1003 1004`.)

## Build recipe (darwin-arm64)
```sh
brew install cmake                     # cmake-js needs it; OpenSSL from brew (openssl@3)
git clone --depth 1 --branch v0.32.3 https://github.com/murat-dogan/node-datachannel.git
cd node-datachannel && npm install --ignore-scripts
export OPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3
npx cmake-js rebuild --CDOPENSSL_ROOT_DIR="$OPENSSL_ROOT_DIR"   # baseline (FetchContents libdatachannel v0.24.2)
# apply the patch to the fetched source, then rebuild incrementally:
git -C build/_deps/libdatachannel-src apply /path/to/rtcpreceivingsession-nack.patch
npx cmake-js build --CDOPENSSL_ROOT_DIR="$OPENSSL_ROOT_DIR"
# -> build/Release/node_datachannel.node (N-API 8, ABI-stable across node/electron)
```

## Verify the patch (C++ unit test)
```sh
SRC=build/_deps/libdatachannel-src; DCB=build/_deps/libdatachannel-build
clang++ -std=c++17 -DRTC_ENABLE_MEDIA=1 -DRTC_STATIC nack-test.cpp \
  -I"$SRC/include" -I"$SRC/deps/plog/include" \
  "$DCB/libdatachannel-static.a" "$DCB/deps/libjuice/libjuice-static.a" \
  "$DCB/deps/libsrtp/libsrtp2.a" "$DCB/deps/usrsctp/usrsctplib/libusrsctp.a" \
  -L/opt/homebrew/opt/openssl@3/lib -lssl -lcrypto \
  -framework Security -framework CoreFoundation -o nack-test && ./nack-test
```

## Easy install (committed binary)
The built binary is committed at `bin/node_datachannel.darwin-arm64.node`. To (re)install it
into `node_modules` -- **re-run after any `pnpm install`**, which restores the stock prebuilt:
```sh
apps/desktop/native/ndc-nack/install.sh
```
Then launch the controller with `VIDEO_NACK_BUFFER=1` to enable silent loss repair. Rebuild the
binary from source (below) only when the patch changes.

## Install into the app (⚠️ must re-codesign)
Copying a signed mach-o over one macOS already validated at that path triggers
`SIGKILL (Code Signature Invalid)` on dlopen. Always re-sign after copying:
```sh
APP=node_modules/.pnpm/node-datachannel@0.32.3/node_modules/node-datachannel/build/Release
rm -f "$APP/node_datachannel.node"
cp build/Release/node_datachannel.node "$APP/node_datachannel.node"
codesign --force --sign - "$APP/node_datachannel.node"
```
(For a packaged Mac .dmg this becomes part of the build + notarization; the owner runs
the controller from `electron-vite dev` today, so the swap+codesign above is enough.)

## Status — DONE + accepted by owner (2026-07-09)
- ✅ Phase A: baseline source build on Mac; self-built binary loads + spike passes.
- ✅ Phase B: patch compiles + `nack-test.cpp` PASS (emits NACK on a gap); drop-in.
- ✅ Phase C: `receiver/reorderBuffer.ts` (`VIDEO_NACK_BUFFER=1`) — holds a small gap for the
  retransmit; 11 unit tests pass.
- ✅ Phase D: real-hardware e2e — scattered losses (5/7/8 pkt) repaired SILENTLY (pli=0), only
  blackouts >64 (83/131) fall through to PLI (~50ms). Works at the default (no-flicker) VBV, so
  the flickering small-VBV idea was dropped ([[small-vbv-flickers]]). STEP 2 (lower bitrate)
  REJECTED by the owner (keep bitrate high like Parsec); the rare blackout blips are accepted.
- **Ship config:** stock VBV (default 250, no flicker) + patched ndc (`install.sh`) +
  `VIDEO_NACK_BUFFER=1` + LTR off. Packaging into a signed .dmg is deferred (owner runs from dev).
