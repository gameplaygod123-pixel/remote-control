# video-native/sender (Windows agent half)

Owned by the **Windows-side Claude**. Turns the desktop into an H.264 RTP media
track: **DXGI capture → Media Foundation / NVENC hardware encode → node-datachannel
video track**, forked out of Chromium like the input helper and driven over the
frozen IPC contract in [`../shared/ipc.ts`](../shared/ipc.ts) (`VideoSender*` types).
The agent is the SDP **offerer** (unchanged from today).

Build against the frozen foundation only: [`../shared/contract.ts`](../shared/contract.ts)
+ [`../shared/ipc.ts`](../shared/ipc.ts). Do not edit those.

## phase0/ — de-risk spikes (throwaway proofs, not production code)

- [`phase0/media-loopback.mjs`](phase0/media-loopback.mjs) — **Phase 0-A**: proves
  node-datachannel sends **and** receives a live H.264 RTP media track outside
  Chromium. Two real forked Node processes exchange SRTP/DTLS/ICE over localhost.
  Run: `node src/video-native/sender/phase0/media-loopback.mjs` (from `apps/desktop`).
  **Result: PASS** — see [`phase0/NOTES.md`](phase0/NOTES.md).
- **Phase 0-B** (DXGI capture → HW encode) proven **compiler-free** via portable
  ffmpeg (this machine has no MSVC/Windows SDK): 1440p60 GPU capture → NVENC
  zero-copy at ~7% CPU, decodable. Numbers + repro + the "avoid MSVC in production"
  architecture answer in [`../native/phase0-ffmpeg/RESULTS.md`](../native/phase0-ffmpeg/RESULTS.md).
  The C++ spike `../native/dxdup_mf_encode.cpp` is reference-only (not compiled).

## phase1/ — the 4 Mac-approved risk items, de-risked

- [`phase1/pli-feedback.mjs`](phase1/pli-feedback.mjs) — **#1**: proves the receiver's
  RTCP PLI reaches the SENDER via `track.onMessage` (PT=206/FMT=1), so keyframe-on-demand
  works with standard WebRTC feedback.
- [`phase1/ffmpeg-pipe.mjs`](phase1/ffmpeg-pipe.mjs) — **#1 action / #2 / #3**: spawns the
  real `ddagrab → h264_nvenc → -f h264 pipe:1` command, splits Annex-B NALs, measures
  respawn/first-IDR latency + per-frame pipe cadence, and generates wall-clock 90 kHz RTP
  timestamps. Needs a portable ffmpeg: `FFMPEG=<path> node …/ffmpeg-pipe.mjs`.
- Answers to all 4 (+ recommended low-latency flag set & recovery design):
  [`phase1/NOTES.md`](phase1/NOTES.md).

## Status

Branch `feat/native-video`. Phase 0 gate PASSED ([`phase0/NOTES.md`](phase0/NOTES.md)).
Phase 1's 4 risk items answered with measured data ([`phase1/NOTES.md`](phase1/NOTES.md)).
**Next (after Mac reviews the approach):** build the real forked `VideoSenderHost`
(spawn/supervise ffmpeg, relay SDP/ICE via `ipc.ts`, feed NALs to the packetizer, parse
PLI→respawn, report stats). Not started — pending review.
