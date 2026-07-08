# Endgame: NACK retransmit — patch libdatachannel to emit NACK (owner-picked 2026-07-09)

The true-0-dip endgame. After vbv=16+LTR-off (config option 2) got us to MINOR JUDDER /
60fps@97%, the residual is per-loss ~50ms blips. The only way to repair loss SILENTLY
(no PLI→IDR hitch) is retransmit or FEC — both blocked at the ndc surface. Owner chose
the **NACK retransmit** path (cheaper than FEC given the ~11ms RTT). See
[`step-fec-recovery.md`](step-fec-recovery.md) "THE ENDGAME" for how we got here.

## The blocker being fixed
`dev/spike-nack.mjs` proved the SDP negotiates `a=rtcp-fb:96 nack` (offer+answer, H264+H265),
and the sender already runs `RtcpNackResponder` (retransmits on NACK). But ndc 0.32.3 pins
**libdatachannel v0.24.2**, whose `RtcpReceivingSession` emits only RR+PLI+REMB — it
`updateSeq()`-tracks gaps but **never builds a Generic NACK (RTPFB PT=205 FMT=1)**. Master
libdatachannel is the same. ndc exposes no NACK-requester and no raw-RTCP send. So the fix
must be a **native patch to libdatachannel** + a rebuild of the ndc addon.

## ⭐ Key simplification — Mac-only native rebuild
The RECEIVER (needs the NACK-emit patch) runs on the **Mac controller**. The SENDER
(`RtcpNackResponder`, retransmits) runs on the **Windows agent** and already works in stock
v0.24.2. So **only the Mac's ndc needs the patched rebuild (darwin-arm64); the Windows agent
keeps its stock ndc binary, untouched.** This halves the work and keeps the risky native
change on ONE platform. (The Mac's other ndc users — input-helper, file transfer — use data
channels, not `RtcpReceivingSession`, so the media-only patch can't affect them.)

## The patch (libdatachannel `src/rtcpreceivingsession.cpp`)
`RtcpReceivingSession` already tracks sequence state in `updateSeq()`. Add NACK emission:
- On `incoming()`, when `updateSeq` sees a FORWARD gap (received seq > expected+1), record the
  missing seq range.
- Build a **Generic NACK** (RTPFB PT=205 FMT=1; the `RtcpNack`/FCI PID+BLP structs already exist
  in libdatachannel for the responder side) listing missing seqs, and `send()` it like `pushPLI()`.
- **Reorder tolerance:** don't NACK instantly — hold a gap a few ms / packets (a later seq may be
  reorder, not loss); mirror our JS `LossDetector`'s reorder window. Rate-limit re-NACK of the
  same seq (~1 per RTT) so we don't storm on a real blackout.
- Keep it MINIMAL + behind the existing behavior (still send RR/PLI); NACK is additive.

## Progress (2026-07-09)
- ✅ **Phase A DONE** — ndc v0.32.3 builds from source on the Mac (cmake 4.3.4 + cmake-js +
  brew openssl@3, OpenSSL statically linked). Self-built `node_datachannel.node` (darwin-arm64,
  N-API 8) loads + `dev/spike-nack.mjs` passes. **Install gotcha found:** copying a signed
  mach-o over one macOS already validated at that path → `SIGKILL (Code Signature Invalid)` on
  dlopen; fix = `rm` + `cp` + `codesign --force --sign -` (proven).
- ✅ **Phase B DONE** — the patch (`apps/desktop/native/ndc-nack/rtcpreceivingsession-nack.patch`)
  adds `pushNACK()` + a gap-detector in `incoming()` (forward gap 2..`RTC_NACK_MAX_GAP=64`; bigger
  = blackout → existing PLI path). Compiles clean; **`nack-test.cpp` PASS** (feeds in-order RTP
  then a gap → the patched `RtcpReceivingSession` emits exactly one Generic NACK listing the
  missing seqs). Patched binary is drop-in (regression spike clean). Full recipe +
  build/apply/verify/install steps in [`apps/desktop/native/ndc-nack/README.md`](../apps/desktop/native/ndc-nack/README.md).
- ✅ **Phase C DONE** — `receiver/reorderBuffer.ts` `SeqReorderBuffer`: a shallow seq-ordered
  RTP buffer wired into `receiver/index.ts` behind `VIDEO_NACK_BUFFER=1` (default OFF =
  byte-identical immediate-PLI path). In-order packets drain immediately (0 added latency); a
  small gap (≤`maxGap`=64) is HELD `NACK_BUFFER_HOLD_MS`=30ms for the retransmit — if it arrives,
  released in order SILENTLY (no PLI/hitch); if not, `onGap`→PLI (fallback). A large gap (blackout,
  never NACKed) skips immediately→PLI (no latency penalty). `lossDetector` still MEASURES network
  loss for the analyzer's `loss=`; `pli=`/`hitch` now reflect only UNRECOVERED loss. Unit-tested
  (11 reorder cases: silent-fill, timeout, blackout-skip, wrap, dup-drop) + typecheck + lint clean.
- ⏳ **Phase D** (next, needs WC + hardware) — install the patched darwin ndc into the controller
  (`rm`+`cp`+`codesign`), launch with `VIDEO_NACK_BUFFER=1`, agent unchanged → e2e: `analyze-
  session.mjs` should show per-loss `pli=`/`hitch` drop toward 0 (losses repaired silently) while
  `loss=` (network) is unchanged. Pair with STEP 2 (lower bitrate) for blackout losses.

## Build approach (the hard part)
ndc builds via `cmake-js` + cmake FetchContent(libdatachannel v0.24.2) + OpenSSL. Mac lacks
`cmake` (install via brew). Plan:
1. **Phase A — baseline source build (de-risk FIRST):** install cmake/cmake-js, clone
   node-datachannel @ the 0.32.3 tag, build the UNPATCHED addon on darwin-arm64, swap it into
   `node_modules`, run `dev/spike-nack.mjs` + a real session → prove a self-built ndc works
   identically before changing any C++. If the baseline build fails (OpenSSL/usrsctp/libsrtp
   deps), the whole path is blocked — find out now.
2. **Phase B — patch + rebuild:** vendor/patch libdatachannel v0.24.2 (point FetchContent at a
   local patched copy, or apply a patch), rebuild. Verify the patched receiver EMITS NACK
   (extend the spike with ndc verbose logging / a loss-injection loopback, or confirm on real
   hardware via the sender's NACK count).
3. **Phase C — receiver buffer + delayed PLI (Mac TS):** today the receiver depacketizes →
   assembles AUs → presents immediately (`DisplayImmediately=true`) and PLIs on the first gap.
   For retransmit to help, (a) add a **shallow ~1-frame (~16-30ms) receive/reassembly buffer** so
   an ~11ms-late retransmitted packet completes the AU before it's needed, and (b) make the
   `LossDetector` **wait ~1 RTT for the retransmit before firing PLI** (PLI stays the fallback for
   losses too big to fill in the buffer window = blackouts). Trade: +~16-30ms latency for silent
   scattered-loss repair (the guide's shallow adaptive jitter buffer, §3).
4. **Phase D — package + verify (golden rule #1):** ship the patched darwin ndc with the Mac
   controller; e2e on real hardware → analyzer shows the per-loss dips gone (loss still occurs but
   is repaired silently, no fps dip / no PLI). Windows agent unchanged.

## Honest limits
- **Blackouts** (link dark ~78ms, the 17:47 cluster): retransmit also can't beat a full dark
  window (the retransmit is lost too) unless the buffer is very deep (kills latency). Pair with
  **STEP 2 (lower bitrate)** so fewer packets are in flight per blackout → more of it fits the
  retransmit window. NACK fixes the SCATTERED losses; STEP 2 shrinks the blackout ones.
- Building ndc from source may hit dep issues (OpenSSL path, usrsctp/libsrtp submodules). Phase A
  exists to surface those before investing in the patch.
- Native change = golden rule #1: prerelease + real-hardware verify before promoting.
