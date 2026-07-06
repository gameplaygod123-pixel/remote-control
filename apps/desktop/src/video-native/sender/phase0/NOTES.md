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

## 0-B · DXGI capture → Media Foundation HW encode → decodable H.264 — ⛔ BLOCKED

**Question:** DXGI Desktop Duplication → MF hardware H.264 encode → a decodable
stream, with measured capture+encode latency.

**Hardware is favourable (probed):** NVIDIA RTX 3060 Ti with **NVENC**
(`nvEncodeAPI64.dll`), Intel UHD 770 QuickSync, and **Media Foundation**
(`mfplat.dll`) all present → HW H.264 **and** HEVC encode available. A Parsec
Virtual Display Adapter is also enumerated (owner runs Parsec).

**BLOCKER — no native build toolchain on this machine:** no MSVC `cl.exe`, no Visual
Studio / Build Tools (`vswhere` absent), no Windows SDK (`dxgi.h`/`mfapi.h` nowhere),
no clang, no ffmpeg. DXGI+D3D11+MF require compiled native C++ against the SDK.
(Consistent with the app never needing a compiler — `koffi`/`node-datachannel` ship
prebuilt, per CLAUDE.md.)

**Done anyway (foundation):** the real spike source is written and ready —
[`../../native/dxdup_mf_encode.cpp`](../../native/dxdup_mf_encode.cpp) (DXGI
Duplication → MF SinkWriter hardware H.264 → `out.mp4`, prints capture latency) +
`native/build.bat`. **NOT COMPILED / NOT RUN** — golden rule #1: unverified native
code, must be built + run on the real machine before any trust.

**To unblock (owner decision — see report):**
1. Install VS Build Tools + Windows SDK (`winget install
   Microsoft.VisualStudio.2022.BuildTools`, "Desktop development with C++"). Multi-
   GB, machine-modifying → needs owner OK. Then `build.bat` compiles the spike.
2. Portable ffmpeg (`ddagrab` + `h264_mf`) — compiler-free proof of the SAME
   DXGI-Duplication + MF-HW-encode pipeline + latency on this GPU.

---

## Phase 0 gate — overall

| Assumption | Verdict |
|---|---|
| node-datachannel carries H.264 RTP media outside Chromium, low latency | ✅ **PASS** (measured) |
| DXGI capture → MF HW encode → decodable H.264 + latency | ⛔ **BLOCKED on toolchain** (spike written, not runnable here) |
| RTP track interface + IPC contract agreed | ✅ frozen upstream in `shared/` (contract.ts + ipc.ts) |

**The plan's #1 risk (media transport) is retired.** The remaining Phase 0 proof is
gated purely on getting a C++ toolchain onto this machine — a decision for the owner,
not a technical dead end. **Do not merge to main** (Mac side reviews + merges).
