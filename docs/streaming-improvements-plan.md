# Streaming improvements — Parsec-parity roadmap

Goal (owner, 2026-07-08): make the native video pipeline match Parsec across the
board — **low latency, low GPU, smooth (steady frame pacing), instant cursor** —
fixing every gap, one step at a time, each shipped + verified before the next.

This plan is derived from the owner's research doc
`~/Downloads/low-latency-remote-streaming-guide.md` (Parsec/Moonlight/Sunshine
architecture) measured against our current pipeline. Both machines execute from
this file; keep it current as steps land.

## Current pipeline (recap)

- **Host (Windows agent):** ffmpeg `ddagrab` (DXGI Desktop Duplication) →
  `h264_nvenc` (zero-copy d3d11) → Annex-B → `H264RtpPacketizer` → RTP over
  node-datachannel on `channel:'video-native'`.
- **Client (Mac controller):** node-datachannel receiver → forward AU to Electron
  main → koffi `librvr.dylib` → VideoToolbox decode → `AVSampleBufferDisplayLayer`
  composited inside the Electron window.
- **Input:** controller renderer → input pc → input-helper → `SendInput` (koffi).

## What we ALREADY do right (validated against the guide — do not regress)

- Zero-copy GPU capture→encode, ddagrab→nvenc d3d11 (guide §3.2, §8.4)
- HW encode, B-frames off, `-zerolatency`, lookahead off = one-in-one-out (§4.1)
- Zero-copy decode→render, VideoToolbox→AVSampleBufferDisplayLayer (§6.1)
- Jitter buffer target 0 on the WebRTC path; native receiver forwards AUs
  immediately (§5.4)
- Input on a separate low-latency channel, seq numbers, move-coalescing,
  normalized 0..1 coords (§7.2, §7.5)
- `SendInput` injection + elevated for the secure desktop (Track 1/2) (§7.3)
- NACK wired (RtcpNackResponder); PLI on loss (§5.3)
- HUD glass-to-glass telemetry: fps/kbps/RTT/jitter/resolution (§8.5)

We already implement ~80% of the guide. The gaps below are what remains.

## The gaps → roadmap

Each step is independently shippable and verified on real hardware BEFORE the
next (golden rule #1/#7: native/FFI = PRERELEASE first; build only via
`scripts/build-win.sh` with `VITE_SIGNALING_URL`).

### Step 0 — Revert beta.4 regression, ship stable v1.25.0  ← baseline
beta.4 (`draw_mouse=0` + CSS cursor) is a REGRESSION: on ddagrab it gave zero GPU
benefit (DXGI emits a frame on every pointer-move and ddagrab passes it through —
`draw_mouse` 0 vs 1 = identical 478-frame count, verified on hardware) AND added a
double-cursor artifact on drag (app drag-images stay in the video). Root cause is
structural (ddagrab has no change-detection) → belongs to Step 3, not a flag.

- Set `DEFAULT_VIDEO_CONFIG.cursor` back to `'composited'` (ffmpeg `draw_mouse=1`,
  cursor in the video = proven beta.3 behavior).
- Gate the input-helper cursor channel + `cursorCapture` behind an off-by-default
  env (`PR_CURSOR_OVERLAY`) so the plumbing stays DORMANT but present — it is
  reused wholesale in Step 3d (the transport + Mac-side CSS overlay are correct
  per guide §6.2; only the cursor SOURCE changes to DXGI metadata). beta.4 is NOT
  wasted.
- Bump to `1.25.0`, ship as a FULL release (runtime = verified beta.3 behavior;
  betas 1/2/3 verified the native path on the real agent).
- Rolls up: 60fps + VBR≤40, ddagrab crash-recovery, dup_frames padding-off, HUD
  telemetry, stuck-key panic-release.
- **Verify:** already-proven beta.3 behavior; smoke-test one session (native
  badge, cursor single, Thai/English typing).

### Step 1 — Intra-refresh instead of the 1s keyframe (guide §4.1)
We send an IDR every 60 frames (1s GOP). A full IDR is a bandwidth SPIKE → a
periodic micro-stutter and a bitrate that isn't flat. Parsec/Moonlight use
**intra-refresh**: no periodic full keyframe; each frame refreshes a moving band
so the whole screen refreshes over ~60 frames — steady bitrate, smoother, and it
self-heals loss without a spike.

- FIRST verify ffmpeg `h264_nvenc` support: `-intra-refresh 1` (+ long/effectively
  infinite GOP, `-forced-idr` only for the first frame / on PLI). If ffmpeg's
  nvenc intra-refresh is too limited, this moves into Step 3's native NVENC.
- Keep the PLI→IDR recovery path working alongside it.
- **Verify (prerelease):** HUD bitrate is FLAT (no ~1s spikes), no visible banding
  artifact, PLI recovery still restores a corrupted stream.
- Effort: low (ffmpeg flags) if supported.

### Step 2 — Multi-slice + present/latency tuning (guide §4.1, §6.1) — SKIPPED

Code audit (2026-07-08) found this delivers no perceptible win as our pipeline is
built, so the owner chose to jump to Step 3:
- **Mac present path is ALREADY optimal:** every sample is tagged
  `kCMSampleAttachmentKey_DisplayImmediately=true` and enqueued straight into
  `AVSampleBufferDisplayLayer.sampleBufferRenderer` with no controlTimebase/queue —
  it presents as soon as decoded. Nothing to tune.
- **`-slices 4` gives no latency benefit here:** the sender assembles the WHOLE
  access unit (all NALs of a frame) and sends it in one `sendMessageBinary` — slices
  only cut latency if you *pipeline* them (send each slice as it encodes), which we
  don't. Worse, `-slices 4` would break `AccessUnitAssembler` (it treats 1 VCL = 1
  frame → 4 slices = 4 broken sub-frames). Real slice benefit needs a slice-level
  send + partial-decode rewrite = Step-3-scale, not "low effort".
- Deferred robustness-only option if ever wanted: `-slices 4` + a multi-slice-aware
  assembler (group slices by `first_mb_in_slice==0`) → a lost packet corrupts 1/4 of
  a frame not the whole frame. Invisible on the owner's clean ~0%-loss link; no
  latency change. Not worth it now.

### Step 3 — Custom DXGI capturer with change-detection  ← the big one (ACTIVE)
The ONLY path to Parsec-level GPU (~6%→~2%) AND the proper cursor. ddagrab can't
skip unchanged/pointer-only frames; a custom DXGI Desktop Duplication capturer
can (guide §3.2/3.3). It also unlocks dirty-rects and gives cursor position+shape
straight from DXGI metadata (no separate GetCursorInfo). Replaces ddagrab; keeps
zero-copy by feeding NVENC directly. Phased, each sub-step prerelease-verified
(golden rule #1 — this is native/FFI, the highest-risk work in the project).

**Full spec + architecture decision: [`step3-dxgi-capturer.md`](step3-dxgi-capturer.md).**
Decided: a **standalone `capturer.exe` subprocess** (DXGI + NVENC → Annex-B on
stdout, drop-in for ffmpeg) — NOT koffi-COM / NOT a node addon — for crash isolation
(golden rule #1) + reuse of the existing spawn/stdout/RTP plumbing. Windows-Claude-
led (needs MSVC + the RTX GPU; Mac can't compile/test it). Sub-steps:

- **3a. Standalone DXGI capturer** (koffi or a small C++ addon): `AcquireNextFrame`
  with `DXGI_ERROR_WAIT_TIMEOUT` (nothing changed → skip) and `LastPresentTime`
  (0 = pointer-only → skip the screen encode), read cursor metadata
  (`PointerPosition` every frame, `PointerShape` on change), `ReleaseFrame`
  immediately. Handle `DXGI_ERROR_ACCESS_LOST` (re-init — same event our beta.2
  crash-recovery already handles). ISOLATION HARNESS first: static screen → ~0
  frames emitted; active screen → frames only on real change; log cursor metadata.
- **3b. DXGI→NVENC direct, zero-copy** (NVIDIA Video Codec SDK via koffi/addon, or
  a shared-texture handoff): standalone DXGI→NVENC→`.h264` file; confirm GPU stays
  ~2% on a static screen while the mouse moves. Use the same low-latency config we
  already tuned (P1, ull, no B, CBR/VBR, VBV≈1 frame) + intra-refresh from Step 1.
- **3c. Wire into the sender** replacing ddagrab; RTP path unchanged. Full e2e
  prerelease: GPU during active control near Parsec, coexists with Parsec.
- **3d. Cursor from DXGI** `PointerShape` → out-of-band over the existing 'cursor'
  channel (un-gate `PR_CURSOR_OVERLAY`) → Mac draws it (reuse beta.4's CSS overlay;
  optionally the real bitmap for custom cursors). Instant cursor (guide §6.2).
- Effort: large. Decide the NVENC-binding approach (koffi vs native addon) at 3b.

### Step 4 — FEC (guide §5.3)  ← deferred
NACK already covers our direct ~11ms link (0% loss). FEC only matters on a lossy
Wi-Fi / real remote-internet path. Add (WebRTC FEC or an RTP FEC layer) only once
a real lossy network shows dropped frames NACK can't recover in time.

## Sequencing & discipline
0 → 1 → 2 first (cheap, on the existing ffmpeg pipeline, real smoothness/latency
wins). Re-confirm `nvidia-smi` encoder util during real use after 0-2 to decide
how hard Step 3's GPU win is actually needed (Task Manager's "Video Encode" %
reads far higher than nvidia-smi's ~8%). Then Step 3 as the endgame. Step 4 only
on demand. Every native change: PRERELEASE + real-agent verify before full
release; build ONLY via `scripts/build-win.sh`.

Reference: `~/Downloads/low-latency-remote-streaming-guide.md`; open source to mine
— Sunshine (host), Moonlight (client RTP/FEC), NVENC SDK, WWDC VideoToolbox
low-latency.
