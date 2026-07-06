# Receiver Phase 0 — de-risk results

Mirror of the sender's Phase 0 (native/phase0-ffmpeg). Cheapest-first: prove the
Mac toolchain + hardware path exist before writing the real decode/render code.

## 0-A — toolchain + framework probe ✅ PASS

`probe.swift`, compiled with the pre-installed `swiftc` (Command Line Tools, no
Xcode.app) and run on the real Mac controller:

```
macOS: Version 26.4.1 (Build 25E253)
HW decode H264: true | HEVC: true
AVSampleBufferDisplayLayer instantiated: AVSampleBufferDisplayLayer
NSWindow host available: NSWindow
RESULT: frameworks link + HW decode probe OK
```

Repro: `swiftc -O probe.swift -o probe && ./probe`

Conclusions:
- **Toolchain settled**: standalone Swift binary via `swiftc` — no node addon (no
  Electron-ABI coupling), no Xcode.app. Lighter than the sender's situation.
- **HW decode confirmed for BOTH H.264 and HEVC** — the Mac has a decode path for
  the HEVC/4:4:4/10-bit North Star, matching the sender's HEVC-capable NVENC. H.264
  stays the proven default; HEVC is the negotiated step-up (contract already carries
  the codec/chroma/bitDepth flags).
- `AVSampleBufferDisplayLayer` (the compositor-bypass render target) instantiates.

## 0-B — real decode + render path + latency ✅ PASS

`decode_spike.swift` — a self-contained closed loop mirroring the receiver hot
path (no ffmpeg, no network): synthetic BGRA → `VTCompressionSession` (H.264,
low-latency, stand-in for the sender) → compressed `CMSampleBuffer` (exactly what
RTP→Annex-B will rebuild) → `VTDecompressionSession` (measures DECODE, the
receiver's real cost) → `AVSampleBufferVideoRenderer` enqueue (the
compositor-bypass render target). Run on the real Mac, 1920×1080 @ 60, 120 frames:

```
decoder created (HW=true)
DECODE : avg 1.36ms  p95 1.62ms  max 2.71ms  (n=120)   <- receiver's real cost
display layer enqueued: 120 status: 1 (rendering, not failed)
RESULT: PASS
```

Repro: `swiftc -O decode_spike.swift -o decode_spike && ./decode_spike`

Conclusions:
- **HW decode ≈ 1.4 ms/frame** — the receiver's real cost is negligible vs the
  16.6 ms/frame budget, and pairs with the sender's ~2.4 ms NVENC encode: capture +
  encode + decode together are still ≪ one frame. The latency we're chasing lives
  entirely in the Chromium capture/`<video>`/compositor path this pipeline removes
  — the whole plan's premise, now measured on both ends.
- The compressed `CMSampleBuffer` → `AVSampleBufferVideoRenderer` path (VideoToolbox
  decodes internally on enqueue) accepts every frame, status = rendering. This is
  the exact production render call, so no manual `VTDecompressionSession` +
  re-wrap is needed for display — the receiver builds a `CMSampleBuffer` from the
  RTP NALs (format description from in-band SPS/PPS) and enqueues it.
- **Use the modern `layer.sampleBufferRenderer` API** (`AVSampleBufferVideoRenderer`,
  macOS 15+): `AVSampleBufferDisplayLayer.enqueue/status/isReadyForMoreMediaData`
  are deprecated. The spike verifies both; production uses `sampleBufferRenderer`.

Pixels-on-screen (a visible `NSWindow`) is confirmed separately by the owner
running a windowed build on the real desktop — this headless spike proves the
decode + render-path + latency, which is the gate.

## Phase 0 gate — receiver

| assumption | result |
| --- | --- |
| Mac toolchain without Xcode.app / node addon | ✅ swiftc (CLT) standalone binary |
| HW decode H.264 (+ HEVC for North Star) | ✅ both true |
| decode latency ≪ frame budget | ✅ ~1.4 ms/frame |
| AVSampleBufferVideoRenderer accepts compressed AUs | ✅ 120/120, status rendering |
| shared contract/ipc unchanged | ✅ built against frozen shared/, no edits |

Both receiver-side risks closed → ready to build the receiver helper (Phase 2).
