# video-native / receiver (Mac controller half)

The Mac side of the native low-latency pipeline: receive RTP H.264/HEVC outside
Chromium, hardware-decode with VideoToolbox, and present through an
**AVSampleBufferDisplayLayer** — the render target that bypasses the `<video>` +
compositor wall that is the remaining latency ceiling (native-video-plan §1
"KNOWN CEILING").

Builds against the frozen `../shared/contract.ts` + `../shared/ipc.ts` and
nothing else of the sender's. The agent is the SDP **offerer**; this side
**answers** (as today).

## Architecture — a mirror of the sender

The Windows sender is a **pure-Node ndc helper → child ffmpeg** (a bundled binary,
no compile). We invert that split so our native half is equally decoupled and the
Node half stays compile-free:

```
Node helper (ELECTRON_RUN_AS_NODE, forked like the input helper)
  · node-datachannel: answer, recv the H.264 RTP track
  · depacketize RTP → Annex-B access units
        │  pipe NALs (stdin)
        ▼
Swift render binary (standalone, built once with swiftc — CLT, no Xcode.app)
  · VTDecompressionSession: HW decode → CVImageBuffer
  · AVSampleBufferDisplayLayer in a borderless NSWindow
  · positioned over the Electron session view via `set-render-rect`
```

Why a **standalone Swift binary**, not a Node native addon: an addon must match
the ABI of the Node/Electron that loads it (node-gyp against Electron headers —
fragile across upgrades). A separate process pipes NALs over stdin exactly like
the sender pipes from ffmpeg, keeps the ndc helper pure-Node, and matches the
input-helper pattern the repo already trusts.

## Toolchain decision (settled in Phase 0-A — see phase0/RESULTS.md)

Command Line Tools ships swiftc + clang + the SDKs; **HW decode for both H.264 and
HEVC is available** on this Mac. No Xcode.app, no addon. `phase0/probe.swift`
compiles and confirms it.

## Layout

```
receiver/
  phase0/        ← de-risk spike (probe done; decode→render+latency next)
  index.ts       ← ndc helper: answer, recv, depacketize, spawn+feed Swift binary (Phase 2)
  render/        ← the Swift render binary sources (Phase 2)
```

## Do not

- Do not change `../shared/contract.ts` / `../shared/ipc.ts` without re-syncing the
  sender — frozen foundation.
- Do not touch the WebRTC `<video>` path except the single native-vs-webrtc branch.
- Native/FFI ships PRERELEASE first, verified on the real Mac (golden rule #1).
