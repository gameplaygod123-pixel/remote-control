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
- Phase 0-B (DXGI capture → MF hardware encode) native spike lives in
  [`../native/`](../native/) (`dxdup_mf_encode.cpp`). **BLOCKED**: this machine has
  no MSVC/Windows SDK to compile it — see NOTES + `native/README.md`.

## Status

Phase 0 in progress on branch `feat/native-video`. See
[`phase0/NOTES.md`](phase0/NOTES.md) for the gate assessment. Phase 1 (the real
forked sender wired to `VideoSenderHost`) has not started.
