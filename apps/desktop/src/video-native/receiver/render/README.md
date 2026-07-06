# receiver/render — native Mac render surface

The Mac controller's native present stage. Hardware-decodes H.264 via VideoToolbox
and presents through `AVSampleBufferDisplayLayer` — the path that removes the
`<video>`/compositor latency wall (`docs/native-video-plan.md` §3a).

## Two build outputs (CLT `swiftc`, no Xcode.app / no node addon)

Built by `scripts/build-render-mac.sh` into `apps/desktop/out/video-render/`:

- **`librvr.dylib`** (`embed.swift` + `decoder.swift`) — **the real path.** Loaded
  by the Electron main process via koffi (`main/nativeRenderSurface.ts`) and adds an
  `AVSampleBufferDisplayLayer`-backed NSView as the BOTTOM subview of the controller
  window's content view (pointer from `BrowserWindow.getNativeWindowHandle()`). The
  video composites **INSIDE the one Electron window** — the web UI sits above it and
  is transparent over the video area (CSS `.native-video`), floating controls paint
  on top. One window ⇒ the OS handles drag / resize / fullscreen / Spaces / z-order /
  corner-rounding for free.
- **`video-render`** (`main.swift` + `decoder.swift`) — a standalone `--selftest`
  binary for headless decode verification only (`decoded 120/120`, `ok:true`). Not
  shipped.

`decoder.swift` (the `Decoder` class: Annex-B → SPS/PPS format desc → AVCC
`CMSampleBuffer` tagged `DisplayImmediately`) is shared by both, so selftest and
production exercise the identical VideoToolbox path.

## Why in-process, not a separate window (the §3a fix)

The first cut floated a separate borderless `NSWindow` over the Electron window and
kept it aligned with `set-render-rect`. Two OS windows can't move/resize/fullscreen
atomically, so it stuttered on drag, covered other apps, clipped the rounded corners,
and broke mouse routing in fullscreen. Compositing inside the single window erases
all of that. See `embed.swift`'s header.

## C ABI (koffi ↔ dylib)

| symbol | purpose |
| --- | --- |
| `void rvr_attach(uint64_t nsViewPtr)` | add the video subview to the content view (idempotent). Pointer = `getNativeWindowHandle()` read as an 8-byte LE `NSView*`. |
| `void rvr_push(uint8_t *au, int32_t len)` | decode + enqueue one Annex-B access unit (copied immediately). |
| `void rvr_detach()` | remove the subview (session end / receiver-down). |

All run on the Electron main JS thread = the macOS main/AppKit thread, so AppKit
mutations are on-thread.

## Data path

`receiver/index.ts` (forked Node helper) owns RTP recv + depacketize, then sends each
reassembled AU to Electron main as `{ evt:'au', data:Buffer }` over an
`'advanced'`-serialized fork channel (efficient Buffer transfer at 60fps). Main pushes
it into the surface via `pushNativeAccessUnit` → `rvr_push`. No Swift subprocess, no
control fd, no render-rect.

## Key decisions ("best path", not easy path)

- **AVSampleBufferDisplayLayer subview inside the window**, not a pixel copy back to
  the renderer (that would reintroduce the compositor wall) and not a separate window
  (the §3a pain above).
- **`kCMSampleAttachmentKey_DisplayImmediately`** — present each frame ASAP with no
  timebase scheduling, the lowest-latency present path.
- **Window aspect locked to the remote's** (`setAspectRatio(16/9)` in main, released on
  detach) so the in-window video fills edge-to-edge with no letterbox AND the input
  hit-target maps 1:1.

## TODO (Phase 2 continuation)

- Decode/present latency + real width/height in the `stats` event (currently fps/kbps
  from RTP only; decodeMs/renderMs dropped with the subprocess).
- Keyframe-needed signal from the decode path back to the helper on mid-stream decode
  failure (helper then `track.requestKeyframe()` → PLI).
- Packaging: build `librvr.dylib` into the app Resources (`video-render/`) +
  codesign/notarize; then PRERELEASE (golden rule #1) before a full release.
