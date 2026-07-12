# Phase 0 — de-risk spike results (Windows sender half)

Branch `feat/native-video`. Executed on the real Windows agent (RTX 3060 Ti,
Windows 10 Pro, Node 24, node-datachannel 0.32.3 / libdatachannel 0.24.2) on
2026-07-06. Per plan §5, Phase 0 must prove two unproven assumptions before any
feature code. This records what was proven, measured, and what is blocked.

---

## 0-A · node-datachannel media (RTP video) outside Chromium — ✅ PASS

**Question (plan risk #1, "node-datachannel media immature / lossy"):** can a plain
Node process (like the input helper) send **and** receive a live H.264 RTP media
track over node-datachannel, off the Chromium path?

**Method:** `phase0/media-loopback.mjs`. Two real forked Node processes (sender +
receiver), each its own libdatachannel stack, exchanging real SRTP/DTLS/ICE media
over localhost UDP; parent relays SDP/ICE (stands in for our signaling). Sender
feeds synthetic Annex-B H.264 access units through the real `H264RtpPacketizer`;
receiver parses RTP, counts frames by the marker bit, and estimates one-way latency
from a wall-clock stamp embedded per frame.

**Result — PASS, deterministic across runs:**
- Media track negotiates (SDP carries H.264 PT 96), DTLS/SRTP connects, RTP video
  flows sender→receiver entirely outside Chromium. ✅
- **One-way transport latency sub-millisecond** (p50 ~0 ms, p99/max ≤ 1 ms) —
  confirms the plan's thesis that transport is *not* the felt-latency bottleneck.
- **100% frame delivery** at the default moderate load (30 fps, ~2 Mbps), repeatable.

**Findings that shape the real sender (important):**
1. `node-datachannel` exposes libdatachannel's **full media API** from plain Node —
   `Video` / `addTrack` / `onTrack` / `H264RtpPacketizer` / `RtpPacketizationConfig`
   / `RtcpReceivingSession` / `RtcpSrReporter` / `RtcpNackResponder` / `PacingHandler`.
   No Chromium, no WebRTC polyfill (the input helper's polyfill has no media tracks).
2. A receive track's `onMessage` delivers **raw RTP packets, not reassembled Annex-B
   frames**. The receiver owns FU-A reassembly → **the Mac receiver half must
   implement depacketization** before handing NALs to VideoToolbox.
3. Media tracks expose **no `bufferedAmount()`**, and `sendMessageBinary()`'s boolean
   is **not** a reliable drop signal (with a pacer in the chain it returns false but
   still sends). Flow control must be measured/among RTCP feedback, not that boolean.
4. `PeerConnection.bytesSent/bytesReceived` **do not count SRTP media** in this build.
5. **Sustained high bitrate needs real flow control.** Unpaced ~20 Mbps overran the
   outbound SRTP buffer and the stream cut off after ~0.5 s; steady loss appears
   earlier as the RECEIVER's per-packet JS callback saturates. In production the
   receiver is **native Mac code**, not a JS loop, so its ceiling is far higher —
   but the sender still needs pacing. `PacingHandler` exists for this; naive params
   ballooned latency to ~1.4 s, so **pacer tuning is a real Phase 1 task**. Repro:
   `FPS=60 IDR_BYTES=60000 P_BYTES=30000 node …/media-loopback.mjs` (and `PACE=1`).

**Not covered here (Phase 1, needs 2 real machines):** sustained 1080p60 @ 30 Mbps
end-to-end delivery, NACK/loss recovery under real network, keyframe-on-request.

---

## 0-B · DXGI capture → HW encode → decodable H.264/HEVC — ✅ PASS (compiler-free)

**Question:** DXGI Desktop Duplication → hardware H.264 encode → a decodable stream,
with measured capture+encode latency.

**Toolchain note:** this machine has **no MSVC/Windows SDK** (no `cl.exe`, no VS/Build
Tools, no `dxgi.h`/`mfapi.h`), so the C++ spike `native/dxdup_mf_encode.cpp` could
not be compiled here (kept as a reference; NOT run). Per owner's decision we proved
the pipeline **compiler-free with a portable ffmpeg** — same OS APIs (`ddagrab` =
DXGI Desktop Duplication; `h264_mf` = Media Foundation; `h264_nvenc`/`hevc_nvenc` =
NVENC). Full numbers + repro: [`../../native/phase0-ffmpeg/RESULTS.md`](../../native/phase0-ffmpeg/RESULTS.md).

**Result — PASS (measured on RTX 3060 Ti, native 2560×1440 display):**
- **Capture:** `ddagrab` opened DXGI output 0 at 2560×1440 8-bit RGB, GPU frames. ✅
- **HW encode:** all of h264_nvenc / h264_mf / hevc_nvenc encode ~30 Mbps CBR with
  **5–12× realtime headroom** (~1.4–3.6 ms/frame) → encode is not the bottleneck.
  (`hevc_mf` unavailable on this box.)
- **Realistic path** ddagrab **GPU→NVENC zero-copy** sustains **1440p60 at ~7 % CPU**
  (H.264) / **~4 %** (HEVC). Media Foundation needs a per-frame GPU→CPU `hwdownload`
  → ~130 % CPU. **NVENC zero-copy wins decisively**; MF is the non-NVIDIA fallback.
- **Decodable:** `ddagrab → h264_nvenc → cap.mp4` = h264 2560×1440 @ 59.5 fps,
  26.75 Mbps, plays. ✅

**Architecture answer (owner's key Q — can we avoid MSVC in production): YES.** The
whole pipeline ran from a **prebuilt binary, zero compilation** — same philosophy as
the input helper's prebuilt koffi. Recommended Phase 1 shape: a forked **video helper
that drives a bundled ffmpeg** (`ddagrab → nvenc/mf → -f h264 pipe:1` Annex-B) and
feeds the NAL stream into node-datachannel's `H264RtpPacketizer` (`LongStartSequence`
— the exact format 0-A used). No native addon, no Windows SDK. koffi-to-COM (DXGI/MF)
is impractical (COM vtables); the C++ addon is a last resort. Detail in RESULTS.md.

---

## Phase 0 gate — overall

| Assumption | Verdict |
|---|---|
| node-datachannel carries H.264 RTP media outside Chromium, low latency | ✅ **PASS** (measured) |
| DXGI capture → HW encode → decodable H.264/HEVC + latency | ✅ **PASS** (measured, compiler-free via ffmpeg) |
| Production can avoid MSVC (owner's ask) | ✅ **YES** — bundle prebuilt ffmpeg, drive as forked helper |
| RTP track interface + IPC contract agreed | ✅ frozen upstream in `shared/` (contract.ts + ipc.ts) |

**Both Phase 0 risks retired.** Media transport (node-datachannel) works outside
Chromium at sub-ms latency; DXGI capture + GPU NVENC encode sustains 1440p60 at
~7 % CPU and is decodable — all with **no compiler**, matching the project's
prebuilt-binary philosophy. Phase 0 gate: **PASS**. Recommended Phase 1: a forked
video helper driving bundled ffmpeg (ddagrab→NVENC) → node-datachannel
`H264RtpPacketizer`. **Do not merge to main** (Mac side reviews + merges).
