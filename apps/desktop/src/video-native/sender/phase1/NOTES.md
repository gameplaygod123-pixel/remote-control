# Phase 1 — the 4 risk items, de-risked with measured answers (Windows sender)

Branch `feat/native-video`. Measured on the real agent (RTX 3060 Ti, 2560×1440,
node-datachannel 0.32.3 / libdatachannel 0.24.2, portable ffmpeg N-125472) 2026-07-06.
Architecture (Mac-approved): bundle ffmpeg + forked video helper, NVENC primary / MF
fallback, pipe Annex-B → node-datachannel `H264RtpPacketizer`.

Spikes: `pli-feedback.mjs` (#1 feedback), `ffmpeg-pipe.mjs` (#1 action / #2 / #3).

---

## #1 · Keyframe-on-demand + loss recovery (highest risk) — ✅ SOLVED

**Does the sender learn "send a keyframe"?** YES. `pli-feedback.mjs` (2 processes):
the receiver's `track.requestKeyframe()` sends a real RTCP PLI, and **node-datachannel
delivers it to the SENDER via `track.onMessage`** — the send-only track's onMessage
receives incoming RTCP; parsing the compound packet shows **PT=206 / FMT=1 (PLI) = the
exact count the receiver sent** (RTCP PTs seen: 201 RR + 206 PSFB). So we detect
keyframe requests with a tiny RTCP parser on the sender track — standard WebRTC
feedback, no side channel needed. (A data-channel-alongside-media fallback did NOT
deliver on the answerer in this config; irrelevant since PLI works. Revisit only if a
control channel is wanted for stats/bitrate.)

**Recovery design (all parts measured):**
1. **NACK auto-retransmit** — `RtcpNackResponder` in the sender chain retransmits lost
   packets from a send buffer with zero JS involvement (wired, verified). First line of
   defence for isolated loss; no keyframe needed.
2. **Short baseline GOP — essentially FREE.** Bitrate is CBR-flat across GOP: 120→60→30
   frames all measured **~26.5 Mbps** (IDRs get bigger, P-frames shrink to compensate).
   So run a short GOP (e.g. `-g 60` = 1 s, or `-g 30` = 0.5 s) at ~no bitrate cost →
   worst-case corruption self-heals within the GOP automatically.
3. **PLI escalation → fresh IDR via respawn.** On a parsed PLI, respawn ffmpeg; a fresh
   process starts with an IDR + in-band SPS/PPS in **~210–265 ms** (measured
   spawn→first-IDR). Rare on a direct P2P link, so an occasional ~¼ s reset is
   acceptable. (No CLI knob forces an IDR mid-stream without respawn; a future
   nvenc-direct addon could expose `forceIntra` for instant IDR — deferred, keeps the
   no-MSVC path.)

Net: NACK for small loss, cheap short GOP as a safety net, PLI→respawn as the escalation.

---

## #2 · Real zero-latency through the pipe — ✅ CONFIRMED (not just encode time)

`ffmpeg-pipe.mjs` reads NALs off `-f h264 pipe:1` and timestamps their arrival:
- **Frames flush one-at-a-time**: per-frame pipe cadence **mean 16.55 ms = 60 fps
  exactly**, p50 ~12 ms — the encoder is NOT buffering multiple frames (`-bf 0`, no
  reorder delay). The high p90/p99 (40–70 ms) is **ddagrab emitting on screen-change**
  (a static desktop skips frames), not pipe latency — a moving screen is steadier and
  it also saves bandwidth when nothing moves.
- **Startup** spawn→first-NAL ~210–255 ms (one-time; also = the respawn cost above).
- **Verified low-latency flag set** (`ffmpeg -h encoder=h264_nvenc`), now the harness
  default: `-c:v h264_nvenc -preset p1 -tune ull -rc cbr -b:v <BR> -bf 0 -g <GOP>
  -delay 0 -zerolatency 1 -rc-lookahead 0 -no-scenecut 1`, output `-bsf:v dump_extra
  -f h264 -flush_packets 1 pipe:1` (dump_extra keeps SPS/PPS in-band before each IDR;
  flush_packets stops muxer buffering). MF fallback: `-c:v h264_mf -b:v <BR>` after
  `hwdownload,format=bgra`.

---

## #3 · RTP 90 kHz timestamps (raw h264 carries no PTS) — ✅ SOLVED

The sender generates them. **Key correction:** a fixed `+90000/fps` per frame DRIFTS
because ddagrab is on-change (variable interval). Use **wall-clock**: `ts = round(
(capture_ms − first_capture_ms) × 90)`. Verified: averages ~1489–1508 ticks/frame
around the nominal 1500 @ 60 fps, tracking real elapsed time. The helper stamps this
onto `RtpPacketizationConfig.timestamp` before each `sendMessageBinary(frame)` (proven
feeding a track in Phase 0-A). Arrival time is the practical proxy for capture time
here; if tighter sync is ever needed, read ddagrab's PTS via a timestamped muxer.

---

## #4 · Bitrate story — one safe fixed CBR for v1; change = respawn

- **No runtime bitrate knob** through the ffmpeg CLI: nvenc CBR is set at launch; there
  is no mid-stream change. Changing bitrate = **respawn** with a new `-b:v` (same
  ~¼ s cost as the keyframe escalation).
- **v1 recommendation:** fix CBR at a safe value. `contract.ts` already carries
  `min/start/max = 6000/20000/30000` kbps; on a direct low-loss P2P link, run CBR at
  **startBitrateKbps (20 Mbps)** (or up to 30) and leave it. No adaptation machinery in
  v1 — matches "pick one safe value + note".
- **Later (optional):** coarse adaptation via respawn on sustained loss (we already see
  loss via RTCP RR on the sender track), or a nvenc-direct addon for live reconfigure.
- **Stats:** report `NativeVideoStats.kbps` + `fps` from the pipe byte/frame rate (and
  `-progress`). `captureMs`/`encodeMs` stay **null** — ffmpeg doesn't expose a per-frame
  capture/encode split. `contract.ts` already allows null, so **no contract change**.

---

## Status / next

All 4 risk items answered with measured data; recommended flags + recovery design
above. **The real forked helper is now BUILT** (spawn/supervise ffmpeg, relay SDP/ICE
through main per `ipc.ts`, feed NALs to the packetizer, parse PLI→respawn, report
stats) — see [`../README.md`](../README.md) for the file map. Verified end-to-end on
this machine via `dev/verify.mjs` (real helper, synthetic frame source): negotiate →
connected, ~100% delivery, per-second stats, **item A PLI→forceKeyframe confirmed by
the helper log**; pure modules unit-checked via `dev/verify-units.mjs`. **Remaining:**
a real-ffmpeg run (drop `ffmpeg.exe` in, no `VIDEO_FAKE_SOURCE`) to exercise the actual
`ddagrab→NVENC` + NAL-split + PLI→respawn on the GPU (golden rule #1), then the one
`AgentView.tsx` wiring point. Do not merge to main — Mac reviews + merges.
