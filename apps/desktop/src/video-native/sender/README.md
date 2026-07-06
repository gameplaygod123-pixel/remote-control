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

## Production sender (BUILT — pending Mac review + real-ffmpeg run)

The real forked helper is now implemented, wired strictly to the frozen
[`../shared/ipc.ts`](../shared/ipc.ts) / [`../shared/contract.ts`](../shared/contract.ts):

- [`index.ts`](index.ts) — the forked helper. node-datachannel **raw** media API
  (not the polyfill — it has no tracks): `Video` SendOnly + `H264RtpPacketizer`
  (`LongStartSequence`) + `RtcpSrReporter` + `RtcpNackResponder`. Agent = offerer.
  Wires all 4 risk items: **A** parse incoming RTCP on the send track → PLI forces
  an IDR, **debounced** with a 400 ms cooldown (> the ~265 ms respawn) so PLIs that
  arrive before a forced keyframe lands are coalesced instead of stacking respawns
  (Mac-review MUST FIX; agreed two-sided: receiver ≤1 PLI/s, sender cooldown
  ≥300–500 ms); **B** low-latency ffmpeg flags; **C** wall-clock 90 kHz RTP
  timestamps; **D** fixed CBR at `startBitrateKbps`. Emits `NativeVideoStats` per second
  (capture/encode `null` — ffmpeg exposes no split).
- [`ffmpegArgs.ts`](ffmpegArgs.ts) — the measured-good `ddagrab → nvenc/mf → Annex-B
  pipe:1` argv (NVENC primary, MF fallback). Pure/testable.
- [`nalSplitter.ts`](nalSplitter.ts) — Annex-B NAL split + access-unit assembly.
- [`rtcpFeedback.ts`](rtcpFeedback.ts) — RTCP compound parser (PLI/FIR/NACK).
- [`frameSource.ts`](frameSource.ts) — `FfmpegFrameSource` (spawn/supervise ffmpeg,
  `forceKeyframe()` = respawn for a fresh IDR, NVENC→MF auto-fallback) and a
  `SyntheticFrameSource` (ffmpeg-free, for the verification harness).
- Host: [`../../main/videoSenderHost.ts`](../../main/videoSenderHost.ts) — mirror of
  `inputHelperHost.ts` (fork-as-Node, ping/pong liveness, respawn, SDP/ICE relay).
  Built to `out/main/video-sender.js` via the new `electron.vite.config.ts` entry.

### Verification ([`dev/`](dev/))

- `node src/video-native/sender/dev/verify.mjs` — bundles the **real** helper with
  esbuild, forks it like the host would against `dev/verify-receiver.mjs`, relaying
  SDP/ICE over the ipc.ts shapes. **PASS on this machine:** negotiates SRTP media →
  connected, ~100% frame delivery, per-second stats emitted, and a receiver PLI
  reaches the helper → `forcing IDR` (item A end-to-end), and the **PLI debounce**
  (a PLI inside the cooldown is coalesced, spaced ones honoured → 2 forced, 1
  coalesced). Uses `VIDEO_FAKE_SOURCE=1` (synthetic frames) so it needs no ffmpeg.
- `node src/video-native/sender/dev/verify-units.mjs` — unit checks for the pure
  modules the e2e doesn't touch (NAL split/AU assembly across chunk boundaries,
  ffmpeg arg set, RTCP PLI parse). **PASS.**

### Still to do (real hardware + integration)

1. **Real-ffmpeg run (golden rule #1):** drop `ffmpeg.exe` in and run the helper
   without `VIDEO_FAKE_SOURCE` to exercise the actual `ddagrab → NVENC` + NAL
   split + PLI→**respawn** path on the RTX 3060 Ti. (The transport/packetize/PLI
   wiring is proven above; this proves the capture stage integration.)
2. **Bundle ffmpeg** via `build-win.sh` into `resources/ffmpeg/ffmpeg.exe` (LGPL
   build, licensing settled) so `resolveFfmpegPath()` finds it in a packaged app.
3. **The one wiring point** in `agent/AgentView.tsx`: pick `native` vs `webrtc`
   (behind `VIDEO_PIPELINE`/`NATIVE_VIDEO_CAP`), start `videoSenderHost`, relay its
   offer/ice/stats through the existing signaling. Left untouched here so the WebRTC
   default can't regress — proposed as a small, separate reviewed change.

**Do not merge to main** — Mac side reviews + merges.
