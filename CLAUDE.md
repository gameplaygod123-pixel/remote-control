# Personal Remote — Claude working notes

Parsec-like personal remote desktop (Electron + WebRTC). Owner is the sole user
for now (family multi-controller use planned). Owner speaks Thai — reply in Thai.

**Keep this file current: at the end of every working session, update the
"Current status" and "Backlog" sections below and commit, so a fresh chat on
either machine can resume without re-explaining anything.**

## Machines & division of labor

- **Mac** (this repo's home): controller + infrastructure hub — signaling server,
  cloudflared tunnel, supervisor LaunchAgent (`com.personalremote.signaling`),
  source of truth. Mac-side Claude reviews, merges, builds, releases.
- **Windows PC**: the agent (controlled machine). Has its own Claude Code for
  implementing/testing anything that needs real Windows hardware. Works on
  `fix/*` branches and pushes; Mac side merges.
- Diagnostics: agent-side helper log at `%TEMP%\input-helper.log`;
  signaling log at `~/Library/Logs/personal-remote-signaling.log` (Mac).

## Golden rules (learned the hard way — do not skip)

1. **Native/FFI code (koffi Win32 calls, node-datachannel) MUST ship as a
   PRERELEASE first** and be verified on the real Windows machine. A bad FFI
   signature segfaults natively; JS try/catch cannot catch it. v1.15.0 shipped
   untested Win32 clipboard FFI → helper crash-respawn loop → v1.15.1 revert.
2. Everything else ships directly as a **full release** (auto-update) while the
   owner is the only user. Reinstate the prerelease gate when family joins.
3. Build Windows installers ONLY via `scripts/build-win.sh` — it requires
   `VITE_SIGNALING_URL`, swaps the node-datachannel darwin→win32 binary, and
   verifies koffi/node-datachannel win32 binaries are packed. v1.11.0 shipped
   pointing at localhost because this was skipped.
4. Never add unverified ICE servers. libjuice picks ONE stun server per attempt
   with no fallback — a dead server (openrelay was) makes sessions fail
   alternately. Current: Google + Cloudflare STUN, both verified.
5. `koffi.load()` must be lazy (inside functions), never at module scope — it
   crashes the Mac controller at import time.
6. asar is disabled on purpose (the pure-Node input helper can't read asar).
7. Release flow: `gh release create --prerelease` → owner tests on real
   hardware (connect/Back cycles, Thai+English typing, X-close mid-session) →
   `gh release edit --prerelease=false`.

## Architecture crib notes

- **Core constraint**: Chromium throttles the ENTIRE Electron process (main
  process included — timers and socket I/O) when the agent window is hidden.
  Anything that must survive window-hide lives in the pure-Node **input helper**
  (`src/input-helper/`, forked with `ELECTRON_RUN_AS_NODE=1`, uses
  node-datachannel). Renderer keeps video + file-transfer.
- Two peer connections: video pc (renderer↔renderer) and input pc
  (controller renderer ↔ helper). Signaling messages carry
  `channel: 'video' | 'input'`; capability negotiation via `caps:
  ['input-helper']` on pair/connection messages (old servers strip unknown
  fields → graceful fallback).
- Input injection on Windows: raw `user32.SendInput` via koffi —
  `KEYEVENTF_UNICODE` for text (layout-independent Thai), VK + scan codes
  (MapVirtualKeyW) for held keys/shortcuts. libnut keyboard silently no-ops
  from windowless processes; mouse still uses nut.js.
- Self-healing: helper retries negotiation 3× then exits → host respawns
  (2s); ping/pong liveness (10s/5s); controller rebuilds input pc on every
  input-channel offer; agent drops video pc on helper-down → auto re-pair.
- Signaling URL is resolved at runtime from `signaling-url.json` on GitHub
  (raw.githubusercontent.com, ~5-min CDN cache), re-resolved on every
  reconnect; the supervisor auto-publishes tunnel URL changes.

## Current status (updated 2026-07-07)

IN PROGRESS (branch `feat/native-video`): **native-video polish — HUD latency
telemetry (SHIPPED to the branch) + a 120fps/60Mbps PRERELEASE awaiting real-
hardware verify.** Post-v1.24.0 the owner asked to see real latency numbers, then
to push FPS.
- **HUD telemetry (`7d491e4`, Mac-side only, committed — no prerelease needed, not
  FFI):** the native HUD showed only fps/kbps (`Network ?ms`, `0×0`). Added: (1)
  **true resolution** — a from-scratch H.264 **SPS parser**
  (`video-native/receiver/spsDimensions.ts`, handles frame-cropping 1088→1080 /
  high profile / emulation-prevention bytes; unit-verified 10/10 incl. a real
  ffmpeg 1080p vector; parsed once off the first IDR in `receiver/index.ts`) since
  ndc/VideoToolbox never surface the size to Node; (2) **real Network RTT** — the
  native pc is media-only so `pc.rtt()` (SCTP) is always null; derive RTT from the
  **input pc's** candidate-pair `currentRoundTripTime` in `ControllerSession`
  onStats (same two machines / same path, always has a data channel; mirrors
  useVideoStats); (3) **frame-pacing Jitter** — RFC3550-style smoothed AU inter-
  arrival, receiver-side (new `jitterMs` on `NativeVideoStats`); (4) dropped the
  fake `Decode 0ms` (AVSampleBufferDisplayLayer has no decode callback — hide vs
  lie). Owner confirmed live: `Network 11ms · Jitter 10ms · 2560×1440`.
- **RESOLUTION IS NOT DOWNSCALABLE ON THIS GPU (documented finding):** the owner
  asked for an in-app resolution setting. Can't be done without killing latency —
  `ffmpegArgs.ts:83-90` already records that `scale_d3d11` fails on the agent's
  driver (VideoProcessor can't do BGRA→NV12, reproduced ffmpeg 8.1 + master 2026)
  and CUDA hwmap is "not implemented", so NVENC encodes at the **native capture
  res** (2560×1440). The only downscale path is hwdownload→CPU-scale = kills zero-
  copy + adds latency, which defeats native. On a direct ~11ms link bandwidth
  isn't a constraint anyway. DECISION: leave it at native res (the owner's own
  fallback). The zero-cost lever if ever needed = change the source monitor's
  Windows display res (still zero-copy).
- **120fps + 60Mbps → PRERELEASE v1.25.0-beta.1 (`2e8e4aa`):** the Mac controller
  is ProMotion 120Hz and the owner's source is 144Hz, so 120fps is the perceptible
  ceiling (min of both displays; NVENC 3060Ti does 1440p120 easily). Bumped
  `DEFAULT_VIDEO_CONFIG` (native-only; the agent passes it straight to the sender;
  WebRTC untouched): `fps 60→120`, CBR `startBitrateKbps 20→60 Mbps` (2× frames
  need ~2× bits; Parsec runs ~60-70 here), min 6→20, max 30→70. Built via
  `build-win.sh` @ `2e8e4aa` (all 3 packed checks pass, signed, 175MB), published
  **PRERELEASE v1.25.0-beta.1** off `feat/native-video` (golden rule #1). beta.1
  e2e: **120fps encoded perfectly** (HUD 113fps, Jitter 3ms, nvidia-smi 122fps @
  67% util, headroom) BUT after 1-3 min the whole session froze (mouse+kbd dead,
  frame stuck, HUD blank) — SUPERSEDED by beta.2.
- **ROOT CAUSE of the beta.1 freeze (Windows-Claude, real hardware):** the "mouse
  death" was a SYMPTOM. `video-sender.log` showed `ffmpeg [ddagrab] AcquireNextFrame
  failed: 887a0026` = **DXGI_ERROR_ACCESS_LOST** — ddagrab loses Desktop Duplication
  on a desktop/mode switch or a 2nd capturer (Parsec was running concurrently!) →
  ffmpeg exits code=1 → sender helper reported FATAL → **full re-pair tore down
  BOTH video+input** for seconds (sometimes hung at "connecting"). NOT ping/pong
  (0ms), NOT CPU (1%), NOT NVENC (67% free), input-helper healthy throughout. Plus
  `juice: Lost connectivity` (ICE) 2×/15min — the fixed 60 Mbps CBR straining the
  link. (Aside: running Parsec + our ffmpeg at once fights over DXGI duplication +
  dual NVENC — don't; close Parsec.)
- **FIX → PRERELEASE v1.25.0-beta.2 (`edd6a59`):** (1) **ddagrab crash recovery**
  (`frameSource.ts`) — an ffmpeg exit AFTER it streamed is treated as recoverable
  capture loss: **restart ffmpeg in place** (~300ms, fresh IDR + in-band SPS/PPS)
  WITHOUT tearing down the peer connection (brief ~0.5s freeze that auto-recovers
  vs a full re-pair); crash-loop guard (>5 exits/10s) still escalates to onFatal.
  (2) **60fps** (was 120) + (3) **VBR ≤40 Mbps** (was 60 CBR) — `ffmpegArgs.ts`
  `-rc vbr -b:v 25000k -maxrate 40000k -bufsize ~250ms`; a static screen now drops
  to a few Mbps like Parsec (big cut in average traffic = less ICE strain);
  `maxBitrateKbps` is finally USED (the cap). (4) **input-helper ndc log
  Debug→Warning** (killed the 98% `[ndc:Debug]` spam; `NDC_LOG_LEVEL=Debug`
  restores). Sender unit tests updated to VBR (all pass), typecheck clean, built
  via `build-win.sh` (3 packed checks pass, signed). **NEXT: Windows-Claude installs
  over beta.1, CLOSES Parsec, controls 10+ min → confirm no mouse-death/re-pair (a
  real desktop switch auto-recovers in ~0.5s), HUD `60fps · 2560×1440` with Mbps
  that drops on a static screen; watch for residual `juice: Lost connectivity`
  (should fall with VBR). If clean → promote full v1.25.0.** Optional: `VIDEO_NVENC_
  BITRATE_KBPS` still sweeps the VBR target live. STILL OPEN: fix any re-pair that
  hangs at "connecting" (controller side) if it recurs post-fix.
- **beta.2 VERIFIED stable (owner, real hardware): the freeze is GONE** — used it
  long with no mouse-death. Windows-Claude confirmed agent-side: 60fps, VBR
  `-b:v 25000k -maxrate 40000k`, ndc spam 0, and **NVENC util dropped 67%→8%** at
  60fps VBR. beta.2 is promotable BUT two follow-ups emerged before promoting (see
  below), and the owner's REAL use = **Parsec always open as the primary monitor
  (do NOT close/modify Parsec)** — so coexistence must be proven with Parsec
  running (the stable test had it closed).
- **GPU efficiency vs Parsec — dup_frames=0 → PRERELEASE v1.25.0-beta.3
  (`8348ca8`, VERIFIED + shipped):** Task Manager showed our ffmpeg at **45.7%
  Video-Encode engine** vs Parsec 6.1% (same tool). Cause: `ddagrab=...:framerate=60`
  with default dup_frames=1 re-encodes the STATIC screen 60×/s. Fix = **`dup_frames=0`**
  (emit only on actual desktop change; framerate = a cap) — Parsec's trick; our RTP
  path already uses wall-clock TS for this variable interval (phase1/NOTES #64).
  **Windows-Claude verified standalone on the RTX 3060 Ti: static-screen encoder util
  ~32%→~2% (BELOW Parsec's ~6%), stream −91%, AND the cursor stays smooth** — the
  feared cursor-in-video freeze did NOT happen because a cursor-only move is itself a
  desktop change (draw_mouse composites it) → ~54fps while moving, ~5fps idle. Also
  added a **receiver jitter guard** (exclude AU gaps >100ms) so the HUD jitter doesn't
  spike under the now-variable frame rate. Built via `build-win.sh`, published beta.3.
  **beta.3 in-app result (owner+Windows-Claude, Parsec running, ~12min):** ✅ no
  black/stall on a static screen (fps ran 50-77); ✅ ddagrab ACCESS_LOST hit once
  (Parsec grabbed the desktop) and beta.3 recovered in place (`restarting capture
  300ms`, no re-pair). ❌ **GPU still ~38-42% (avgFps ~38), NOT near Parsec's ~6%**;
  ⚠️ cursor a touch stuttery. ROOT CAUSE FOUND: **we composite the cursor into the
  video (`draw_mouse` default-on), and in real use the mouse moves nonstop → ddagrab
  sees a "desktop change" every frame → NVENC re-encodes ~38fps continuously**, so
  dup_frames=0 can't idle. Parsec is at 6% because it draws the cursor as a SEPARATE
  overlay (not in the video). Same reason the cursor stutters — its smoothness was
  tied to the video framerate.
- **CURSOR-OUT-OF-VIDEO → the real Parsec-GPU fix → PRERELEASE v1.25.0-beta.4
  (owner picked "แบบ Parsec เป๊ะ", SHIPPED):** ship `draw_mouse=0` (cursor NOT baked
  into the frame → a mouse-only move is no longer a change → the encoder finally
  idles on a static screen) AND draw the cursor natively on the Mac. Chose the SAFE
  realization over transmitting a cursor bitmap (koffi GetDIBits = the kind of pixel
  FFI that dangling-pointer-crashed v1.15.0): the agent reports only the **semantic
  cursor SHAPE** and the Mac applies it as a **CSS `cursor`** so macOS draws the real
  native cursor (0-latency, correct hotspot, 1:1 position — the Mac already knows the
  position, it's the input source). Standard cursors (arrow/I-beam/hand/resize/wait/
  hidden) map to CSS keywords; custom app cursors fall back to arrow. New code:
  `input-helper/cursorCapture.ts` (Windows koffi `GetCursorInfo` + `LoadCursorW`
  handle-compare, lazy load per golden rule #5, struct-size guard, fully try/no-op
  guarded → any failure degrades to the local Mac cursor, never a black hole); a
  dedicated `'cursor'` data channel on the input pc (`input-helper/index.ts` creates
  it, `peerConnection.ts` `onCursorChannel`, `ControllerSession` applies the shape as
  CSS on the video el, native mode only so WebRTC is untouched); `CursorShape`/
  `RemoteCursorMessage` in `inputProtocol.ts`; `contract.ts` `DEFAULT_VIDEO_CONFIG.
  cursor` `'composited'`→`'separate'`; `ffmpegArgs.ts` grab now `...:dup_frames=0:
  draw_mouse=${separate?0:1}`. Mac-side verified: typecheck (node+web) + sender unit
  tests (draw_mouse 0/1 asserted) + lint(prod, 0 err) all clean. **koffi FFI VERIFIED
  (golden rule #1): Windows-Claude ran the isolation harness `node src/input-helper/
  dev/cursor-capture-test.mjs` on the real RTX agent — 3 runs, NO segfault, 7 shapes
  correct — so `cursorCapture.ts` needs no changes.** Built via `build-win.sh` @
  `feat/native-video` (all 3 packed checks pass: node-datachannel/koffi/ffmpeg win32,
  signed, 175MB, VITE_SIGNALING_URL=cooperative-incorporate-innovations-jumping),
  published **PRERELEASE v1.25.0-beta.4**. **NEXT e2e (owner+Windows-Claude, Parsec
  left OPEN/untouched — primary monitor): install over beta.3, control 10+ min →
  (1) GPU Video-Encode during ACTIVE control should drop toward Parsec's ~6% now the
  cursor no longer re-encodes the screen (THE DECIDER); (2) cursor shows correct NATIVE
  shape (I-beam/hand/resize) + no stutter; (3) coexists with Parsec (ACCESS_LOST
  recovers in place); (4) no mouse-death/stuck-keys.** If clean → promote full v1.25.0
  (rolls up 60fps+VBR≤40, ddagrab crash-recovery, dup_frames=0, cursor-out-of-video,
  quiet ndc log, HUD telemetry, stuck-key panic-release).
- **beta.4 e2e RESULT = REGRESSION (owner+Windows-Claude, real hardware ~12min):**
  `draw_mouse=0` DOES remove the cursor from the video (pixel-diff verified, not a
  software cursor, not Parsec's fault) BUT gave **ZERO GPU benefit** — DXGI Desktop
  Duplication emits a new frame on EVERY pointer-move and ddagrab passes it through
  regardless (`dup_frames=0` only stops padding, doesn't check `LastPresentTime`), so
  `draw_mouse` 0 vs 1 = identical 478-frame count; GPU stayed ~38-42%. PLUS a
  double-cursor-on-drag artifact (app drag-images stay baked in the video while the
  CSS cursor moves independently). So beta.4 is STRICTLY WORSE than beta.3. Root cause
  is structural (ddagrab has no change-detection) — fixable only with a custom DXGI
  capturer, NOT a flag.
- **PIVOT → full Parsec-parity roadmap (owner, 2026-07-08: "แก้มันทั้งหมด ไล่ทีละอย่าง
  เอาให้เหมือน Parsec"):** owner found a research doc
  (`~/Downloads/low-latency-remote-streaming-guide.md`, Parsec/Moonlight/Sunshine
  architecture); measured against our pipeline we already do ~80% right (zero-copy
  cap→enc + enc→render, B-off/zerolatency/no-lookahead, jitter=0, input channel + seq
  + normalized coords, NACK/PLI, HUD). The gaps + the incremental plan are now in
  **[`docs/streaming-improvements-plan.md`](docs/streaming-improvements-plan.md)** —
  Step 0 revert beta.4 + ship v1.25.0 baseline; Step 1 intra-refresh (no 1s keyframe
  spike); Step 2 multi-slice + present tuning; **Step 3 custom DXGI capturer with
  change-detection = the real Parsec-GPU fix + proper cursor (reuses beta.4's cursor
  channel + Mac CSS overlay, sourcing shape from DXGI metadata)**; Step 4 FEC
  (deferred). Doing 0→1→2 first (cheap, existing ffmpeg pipeline), then Step 3
  (big native, phased, prerelease-per-substep).
- **Step 0 DONE — full release v1.25.0** (reverted beta.4; cursor overlay plumbing
  kept DORMANT behind `PR_CURSOR_OVERLAY`, reused in Step 3d; rolls up
  60fps+VBR≤40, ddagrab crash-recovery, dup_frames, HUD telemetry, stuck-key).
- **Step 1 — intra-refresh → PRERELEASE v1.25.1-beta.1 (SHIPPED, awaiting verify):**
  WC confirmed `h264_nvenc` supports `-intra-refresh`/`-forced-idr` on the RTX agent
  and test-encoded it (1 I-frame at start, rolling I-MBs after, no periodic IDR,
  decode clean, forced-idr on PLI still accepted). `ffmpegArgs.ts` nvenc now adds
  `-intra-refresh 1 -forced-idr 1` and sets `-g` to `NVENC_INTRA_REFRESH_GOP`
  (999999 — no periodic full IDR; recovery via PLI→forced-idr; dump_extra still
  repeats SPS/PPS in-band for mid-join). Unit tests updated + pass; built via
  build-win.sh.
  - **beta.1 BUG (WC, real hardware) → FIXED in beta.2:** intra-refresh + forced-idr
    were in the argv correctly, but `sender/index.ts:243` passed `gop = config.fps`
    (60), overriding buildFfmpegArgs' `NVENC_INTRA_REFRESH_GOP` default → running argv
    was `-intra-refresh 1 -g 60`, so NVENC still emitted a full IDR every 1s (proven:
    intra-refresh+g60 = 3 I/3s vs +g999999 = 1 I/3s → bitrate still spiked). Fix:
    `sender/index.ts` now sets `gop = NVENC_INTRA_REFRESH_GOP` (the `config.fps` "1s
    GOP" comment predated intra-refresh; MF fallback is unaffected — its argv has no
    `-g`). Rebuilt → **PRERELEASE v1.25.1-beta.2**.
  - **beta.2 REGRESSION (WC, real hardware) → FIXED in beta.3:** argv was finally
    correct (`-intra-refresh 1 -g 999999 -forced-idr 1`, image sharp) BUT the Mac
    receiver FROZE mid-session — owner had to reconnect every 1-3 min. Proven
    receiver-side: during each freeze the sender log was error-free (pure P-frame
    stream, NO ddagrab ACCESS_LOST / respawn / fatal) = a VideoToolbox decode stall,
    not capture. ROOT CAUSE: **pure intra-refresh (`-g 999999` = one IDR ever) removes
    the periodic IDR that AVSampleBufferDisplayLayer NEEDS to recover** — VT does NOT
    resume off intra-refresh's rolling I-MB recovery, so any loss/reference gap sticks
    forever (drag felt worse = more motion → more glitches → more freezes). forced-idr-
    on-PLI didn't save it (receiver wasn't sending PLI on decode-stall; forcing an IDR
    then needed a heavy ffmpeg respawn). **NEVER ship pure intra-refresh on this VT
    pipeline** (saved to memory). FIX (Option B): keep intra-refresh (spreads the
    keyframe cost across P-frames) but restore a MODERATE periodic IDR safety net —
    `NVENC_INTRA_REFRESH_GOP` 999999→**120** (IDR every ~2s@60fps, half v1.25.0's 1s
    spike frequency) so VT self-heals at least every 2s. `ffmpegArgs.ts` +
    `sender/index.ts` comments + unit test updated (`-g 120`, not 60/999999); all pass,
    typecheck clean. Rebuilt → **PRERELEASE v1.25.1-beta.3**.
  - **beta.3 STILL FROZE → VERDICT: intra-refresh REVERTED (Option A) → v1.25.1-beta.4:**
    beta.3 (`-g 120` + intra-refresh) froze mid-session just like beta.2 (`-g 999999` +
    intra-refresh); only v1.25.0 (`-g 60`, NO intra-refresh) is stable. **The culprit
    is `-intra-refresh` itself, NOT the GOP length** — VideoToolbox / AVSample­Buffer­Display­Layer
    can't cleanly decode the rolling-intra P-frame structure (blurs/freezes BETWEEN
    IDRs, recovers only off a real IDR), so changing IDR frequency can't fix it (WC,
    real hardware, both prereleases). **NEVER use NVENC `-intra-refresh` on this VT
    pipeline** (saved to memory: [[pure-intra-refresh-freezes-videotoolbox]]). Fix =
    remove `-intra-refresh 1`; renamed the const `NVENC_INTRA_REFRESH_GOP` →
    **`NVENC_KEYFRAME_GOP`**. Kept the ONE salvageable partial Step-1 win: plain
    periodic **`-g 120`** (IDR every 2s, NO intra-refresh) instead of v1.25.0's `-g 60`
    (1s) — plain periodic IDRs decode fine on VT and this halves the keyframe-spike
    frequency. `-forced-idr 1` retained (harmless; forces a real IDR on PLI). Unit test
    now asserts `!-intra-refresh` + `-g 120`; tests + typecheck clean. Rebuilt →
    **PRERELEASE v1.25.1-beta.4**.
  - **beta.4 VERIFIED stable → PROMOTED to full v1.25.1 (Step 1 DONE):** WC on real
    hardware — argv confirmed `-g 120` + NO `-intra-refresh` + `-forced-idr 1`; owner
    controlled with heavy drag, NO freeze, a single stable ffmpeg pid ~3+ min, 0
    reconnects, 0 errors. **Step 1 landed as the plain `-g 120` partial win** (IDR every
    2s vs v1.25.0's 1s = half the keyframe-spike frequency; intra-refresh permanently
    dropped — VideoToolbox-incompatible at every GOP length,
    [[pure-intra-refresh-freezes-videotoolbox]]). The true flat-bitrate endgame
    (receiver detects decode-stall → PLI → cheap forced IDR, no respawn) is deferred to
    Step 2/3 receiver work.
- **Step 2 — SKIPPED (code audit 2026-07-08; owner chose to jump to Step 3):** it
  delivers no perceptible win as our pipeline is built. (1) The Mac present path is
  ALREADY optimal — every sample is tagged `kCMSampleAttachmentKey_DisplayImmediately
  =true` and enqueued straight into `AVSampleBufferDisplayLayer.sampleBufferRenderer`
  with no timebase/queue (`receiver/render/decoder.swift`+`embed.swift`). (2)
  `-slices 4` gives NO latency benefit here because the sender assembles the WHOLE
  access unit and sends it in one `sendMessageBinary` (slices only cut latency if you
  *pipeline* per-slice sends, which we don't) — and it would BREAK `AccessUnitAssembler`
  (1 VCL = 1 frame → 4 slices = 4 broken sub-frames). Real slice benefit = a slice-
  level send + partial-decode rewrite = Step-3-scale. Deferred robustness-only variant
  (multi-slice-aware assembler, corrupts 1/4-frame on loss) is invisible on the clean
  link — not worth it. Details in [`docs/streaming-improvements-plan.md`](docs/streaming-improvements-plan.md).
- **Step 3 — custom DXGI capturer = the real Parsec-GPU + cursor fix (ACTIVE, owner
  picked it over Step 2). Full spec: [`docs/step3-dxgi-capturer.md`](docs/step3-dxgi-capturer.md).**
  ARCHITECTURE DECIDED: a **standalone `capturer.exe` subprocess** (DXGI Desktop
  Duplication + change-detection + NVENC → Annex-B on stdout, byte-identical contract
  to today's ffmpeg → drop-in for `FfmpegFrameSource`, receiver UNCHANGED) — NOT
  koffi-COM, NOT a node addon, for crash isolation (golden rule #1: a DXGI/NVENC fault
  = a subprocess exit the existing ffmpeg crash-recovery handles, not an Electron-main
  segfault) + reuse of the proven spawn/stdout/NalSplitter/RTP plumbing. **Windows-
  Claude-LED** (needs MSVC + the real RTX GPU; Mac-Claude can't compile/run DXGI+NVENC
  — Mac owns the spec, the Annex-B contract, the sender TS wiring in 3c, the Mac cursor
  overlay in 3d, review/merge). Phased, prerelease-per-substep:
  - **3a ✅ DONE + VERIFIED on real hardware (WC):** standalone `capturer.exe` (MSVC +
    Win SDK, NOT koffi/addon) with the `AcquireNextFrame` change-detection loop —
    SKIPS `WAIT_TIMEOUT` (unchanged) AND `LastPresentTime==0` (pointer-only). **The
    decider passed: mouse moving on a static screen → ~0 screen frames emitted** (the
    exact case ddagrab/beta.4 could NOT skip = the GPU root cause). ACCESS_LOST recovery
    hardened (was capped 15s → survived a ~22s lock via unlimited retry + throttle).
    Reads cursor `PointerPosition`/`GetFramePointerShape` (for 3d). Files:
    `apps/desktop/native/dxgi-capturer/{main.cpp,build.ps1,CMakeLists.txt,README.md}`
    + `--selftest`. Coexists with Parsec. (WC committing to feat/native-video after
    pulling Mac's spec.)
  - **3b ✅ DONE + VERIFIED on real hardware (WC, `nvenc.{h,cpp}` linking nvEncodeAPI
    directly in the C++ .exe):** DXGI `ID3D11Texture2D` → `CopyResource` → registered
    NVENC D3D11 input → zero-copy encode (no CPU download), encoding ONLY the frames
    3a flags as real changes. **Clean decider metric (frames NVENC actually encoded in
    7s, Parsec running): static screen + mouse moving = 13 (~2/s: residual + forced
    IDR) vs ddagrab's ~420; active screen = 70 (~10/s, tracks real change).** = the GPU
    win ddagrab/beta.4 can't get (they'd encode ~420 in both). `.h264` decodes clean in
    ffmpeg 8.1 (H.264 High, 2560×1440, yuv420p, I/P only NO B, IDR ~every 2s wall-clock,
    SPS/PPS in-band). Config P1/ULL, VBR 25/40 Mbps, VBV 250ms, **`-g 120` NO
    intra-refresh** ✓. ACCESS_LOST → teardown+rebuild encoder+device (fresh IDR). NB:
    absolute enc% vs Parsec ~6% can't be measured cleanly yet (Parsec's own NVENC
    session pollutes nvidia-smi's GPU-wide enc%); frames-encoded is the clean metric,
    real % shows at 3c. Output = `.h264` file (stdout/RTP is 3c). third_party/ + the
    built binary are gitignored.
  - **3c IN PROGRESS — Mac side DONE (committed), awaiting WC's capturer stdout mode +
    binary, then joint e2e PRERELEASE (golden rule #1).** MAC (done): `capturerArgs.ts`
    (`buildCapturerArgs`, unit-tested), `CapturerFrameSource` in `frameSource.ts` (spawns
    capturer.exe, reuses NalSplitter/AU/RTP untouched; **`forceKeyframe()` writes `'I'`
    to stdin = cheap PLI recovery, no respawn**; crash-loop-guarded restart),
    `resolveCapturerPath()` + `capturerEnabled()` gate (**opt-in `VIDEO_CAPTURER=1`,
    default OFF → byte-identical ffmpeg path; capturer missing/fails → SILENT ffmpeg
    fallback**, never a black screen), `electron-builder.yml` packs
    `resources/capturer/capturer.exe`, `build-win.sh` stages from
    `native/dxgi-capturer/bin/capturer.exe` if delivered + verifies it packed (tolerant:
    absent → builds without it). typecheck + lint(0 err) + units pass. WC (todo): add
    `--output stdout` + CLI arg parsing to capturer.exe (contract in
    [`docs/step3-dxgi-capturer.md`](docs/step3-dxgi-capturer.md) "3c CLI contract":
    `--output/--monitor/--fps/--bitrate/--maxrate/--gop`, Annex-B/flush-per-frame,
    **stdin `'I'`=forced IDR**, ACCESS_LOST recovers in-process); commit the built
    `capturer.exe` to `native/dxgi-capturer/bin/` (needs a `.gitignore` exception — that
    dir currently ignores `capturer.exe`). Then Mac builds the PRERELEASE
    (`VIDEO_CAPTURER=1`). Receiver UNCHANGED. DECIDER: GPU during active control near
    Parsec, coexists with Parsec, no freeze/stuck-keys, PLI recovery via stdin works.
  - **3c WC HALF DONE + delivered → PRERELEASE v1.26.0-beta.1 BUILT (awaiting e2e).**
    WC (`016e72c` 3b, `022e8d4` 3c) implemented the exact contract read from
    `capturerArgs.ts`/`CapturerFrameSource` (no guessing): CLI `--output stdout|<path>
    --monitor --fps --bitrate --maxrate --gop` (+`--selftest/--duration`); stdout =
    binary Annex-B (`_setmode _O_BINARY` — no CRLF corruption, verified decodes clean in
    ffmpeg 8.1), 4-byte start codes, in-band SPS/PPS, flush per frame, first frame IDR;
    **stdin `'I'` (separate thread) → forces an IDR next frame, no respawn** (on a static
    screen it re-encodes the last frame as IDR so the receiver re-syncs), EOF → exit 0;
    IDR interval is **wall-clock** (gop/fps seconds, since change-detection makes fps
    variable), fps is a real cap; all logs → stderr `[capturer]` (stdout is pure stream);
    ACCESS_LOST recovers in-process. Built `capturer.exe` (192KB PE) committed to
    `native/dxgi-capturer/bin/` with a `!bin/capturer.exe` gitignore exception (gotcha:
    no trailing `#` comment on that line). Mac built **PRERELEASE v1.26.0-beta.1** via
    build-win.sh (all 4 packed checks pass incl. `resources/capturer/capturer.exe`,
    signed). **ENABLE AT RUNTIME:** the helper inherits the agent env
    (`videoSenderHost` forks with `{...process.env}`), so launch the agent with
    **`VIDEO_CAPTURER=1`** (e.g. `set VIDEO_CAPTURER=1 && PersonalRemote.exe`) — default
    OFF = ffmpeg.
  - **3c e2e RESULT (WC, real hardware) — change-detection ✅, but found the REAL
    remaining Parsec gap = NO adaptive bitrate (BWE):** capturer verified spawning
    (`spawn capturer`, not ffmpeg), packed binary encodes/decodes clean. **Change-
    detection PASSED hard:** static+mouse-still = enc 0% (~1 frame/s); static+MOUSE-
    MOVING = enc ~0% (`skipped_pointeronly` 25-60/s) vs beta.4's flat 38-42% — the
    Parsec-GPU-idle goal ddagrab structurally couldn't hit. BUT GPU + smoothness still
    lose to Parsec, and WC nailed WHY: **we push a FIXED 60fps + fixed bitrate with NO
    BWE** (`sendMessageBinary` per AU, no drop/adapt). The owner's link is ~35-45 Mbps;
    pushing 50/60 → the Mac receives only fps 33-48 / 30-45 Mbps = **packet overflow →
    whole-frame DROPS → not smooth** (THIS is the owner's "กะชาก" judder — frames
    dropped from overflow, not a capture/present issue). Parsec adapts fps+bitrate to
    fit the link → no drops → smooth AND less encode → lower GPU. So the smoothness gap
    AND the GPU gap are the SAME cause: **no adaptive bitrate/framerate.** Codec (H.265
    vs our H.264) is NOT the culprit (A/B inconclusive, scene-variance dominates; enc%
    ours ~30.5 vs Parsec ~19.3 at 50Mbps 1440p60 — HEVC would help ~1.6× but needs a Mac
    HEVC-decode rewrite = parked). Latency is fine (Net 10ms, jitter 4-13ms, same NVENC
    encode ~4-9ms, same VideoToolbox decode ~4ms). **PLAN:** (1) BAND-AID now — fit a
    fixed bitrate to the link (~25-30 Mbps, WC testing 25/35 for zero-drop + steady 60);
    Mac bakes the winning number into `DEFAULT_VIDEO_CONFIG` + rebuild. (2) THE REAL FIX
    = **BWE / adaptive bitrate+fps** (receiver measures bandwidth/loss → feedback over
    the input pc data channel → sender sets capturer bitrate LIVE via a new stdin cmd
    `B<kbps>`, like `'I'`=IDR, no respawn) — fixes smoothness + GPU together; Mac
    (receiver) + Windows (sender). (3) min-fps floor (WC prototyped, 30fps decay→0 on
    static) — keep OFF by default (costs GPU 8→22% active, addresses low-motion cadence
    not the drop-judder); revisit after BWE. WC's experiment infra (env override +
    `%LOCALAPPDATA%\pr-capturer-tune.txt` live tune-file + `--codec h264|h265`) is worth
    committing (gated, no default change).
  - **3c e2e ROUND 2 (WC) — the fps-swing reframe + BWE stdin ready + goal correction:**
    band-aid alone (25/35 Mbps) did NOT stop the swing → the earlier "no BWE" story was
    INCOMPLETE. WC found **3 separate causes** of the fps swing (from `video-sender.log`
    the capturer's own `emitted/s` already swings 41-60 on a video with the cursor still):
    (1) **Capture-side variable rate** — inherent to change-detection: DXGI/DWM delivers
    frames at the CONTENT's real cadence, not a locked 60 (a 30fps video → ~30 emit =
    CORRECT, not a drop). Un-fixable by bitrate. (2) **No receiver pacing** — the Mac
    shows every AU immediately (`DisplayImmediately=true`) so uneven arrival = uneven
    display = judder; a small present/jitter buffer (~1 frame latency) smooths it. (3)
    **Bitrate overflow** — only at high bitrate (the old 50/60); at 25/35 it's no longer
    the bottleneck (hence "same as before"). **GOAL CORRECTION:** "lock a steady 60" is
    NOT achievable/correct with change-detection when the source is <60fps — the right
    pass criterion is **"received fps ≈ sender emitted (no NET loss)" + smooth perceived
    motion**, not "steady 60". **BWE live-bitrate is DONE on the capturer** (WC, verified
    RTX): stdin **`'B'<ascii-kbps>'\n'`** (e.g. `B25000\n`) → `nvEncReconfigureEncoder`
    live (no respawn, no forced IDR, maxrate keeps target:max ratio); tested 25→12→45
    Mbps mid-stream, decode clean. Committed w/ the tooling as `d73834c` (new
    `bin/capturer.exe` — next prerelease packs it). **DIRECTION (Mac):** the real judder
    fix = **receiver-side pacing on the Mac** (WC + earlier Mac analysis agree; NB Parsec's
    own metric showed `queued_frames=0` so verify empirically, toggleable, ~1 frame
    latency) — BWE fixes overflow/robustness but does NOT make motion smooth. PENDING:
    WC compares HUD received-fps vs emitted (41-60) at 25/35 to confirm net-drop=0.
  - **THE FIX — Parsec overlay revealed it + LOCKED-60 capturer (WC `88a3ce8`):** the
    owner sent a Parsec perf overlay on a STATIC screen showing **Host/Client Video Frame
    Time 16.57/16.66ms = Parsec holds a LOCKED 60fps cadence even when nothing moves**
    (Encode field blank = unchanged frames are near-free skip-frames). So Parsec is NOT
    change-detection-drop like our 3a-3c; it's **locked-60 cadence + cheap skip-frames**
    → smooth AND low-GPU. Our change-detection dropped frames → VARIABLE cadence = the
    judder. WC re-architected the capturer: **LOCKED 1/fps clock (emit every 16.66ms)**,
    drain the latest DXGI change per tick → real P/IDR if the screen changed, else a skip
    frame. RESULT: **cadence locked 60 (emitted 60/61 per sec, was 41-60) = judder fix ✅**;
    skip frame = 114-118 bytes (~55 Kbps idle) ✅; decode clean (IPPP, IDR ~2s) ✅. **GPU
    did NOT reach Parsec's 6%:** static-locked ~17-20% enc @1440p (HEVC no better) —
    Parsec's 6% uses TRUE coded-skip (`NV_ENC_PIC_TYPE_SKIPPED`) which NVENC only allows
    with `enablePTD=0`, but PTD=0 + the ULTRA_LOW_LATENCY preset falls back to ALL-INTRA
    (every frame I, 62KB, worst) → reverted; under PTD=1 a "skip" still costs a motion-
    estimation pass ~17-20% @1440p. WC's fix = **idle-decay (`--locked-idle-ms`, default
    350):** a truly static screen has nothing to judder, so after 350ms of no change STOP
    emitting → idle GPU ~0% (= legacy); lock 60 only while active. Net: **motion =
    locked-60 smooth; true static = 0%; active-low-motion (video/typing) = the only
    residual cost ~20%.** Flag-gated: `--legacy-emit` / tune `legacy=1` / env
    `VIDEO_CAPTURER_LEGACY_EMIT=1` reverts to emit-on-change live. **MAC DECISIONS: (1)
    default = LOCKED + idle 350** (judder was the owner's real complaint; locked fixes it;
    true-static stays 0%; ~20% active-low-motion is acceptable on the 3060 Ti). **(2) do
    NOT chase true 6% now** — the only paths (drop ULL for PTD=0 all-intra, or downscale
    1440→1080) sacrifice the latency (Step 1) or resolution the owner values more; judder-
    fixed is the win. Building **PRERELEASE v1.26.0-beta.2** (packs `88a3ce8`) for the
    owner to FEEL the smoothness. → **beta.2 VERIFIED by the owner on real hardware:
    "ลื่นเหมือน Parsec ละ" (smooth like Parsec) — judder GONE. PROMOTED to full
    v1.26.0.** (golden rule #1/#7 honored: locked-60 = native capturer, verified via
    beta.2 before the full release.) The whole Step 3 custom DXGI capturer (change-
    detection + locked-60 cadence + idle-decay + BWE stdin primitive) is now a full
    release. NEXT (owner: "รอบหน้าปล่อยออโต้บิตเรต Max ไม่เกิน 60 แบบ parsec") = BWE
    auto-bitrate, ≤60 Mbps cap — the capturer stdin `B<kbps>` is ready; Mac builds the
    receiver estimate + feedback path.
  - **"Parsec 6%" WAS A MYTH — corrected (owner Task-Manager + Parsec overlay, 2026-07-08):**
    with Task Manager open (its perf graph continuously ANIMATING = not truly static),
    **Parsec itself sits at ~35% GPU Video-Encode** (overlay: Host Video Encode 8.72ms/
    frame @ locked 16.71ms = 60fps, Bitrate 3.10 Mbps, **Hardware H.265**). So Parsec is
    NOT magically 6% on real (animating) content — **our locked-60 ~20% is already
    competitive/better**; ~6% only ever happens on a fully FROZEN screen, which our
    idle-decay already takes to 0%. Fully vindicates "don't chase 6%." **The ONE real
    remaining differentiator = codec: Parsec H.265 vs our H.264.** H.265 ≈1.6× more
    efficient → Parsec pushes 1440p60 at only ~3 Mbps (vs our higher H.264 bitrate) = less
    network (fewer overflow drops) + better quality per bit, NOT lower GPU (HEVC encode GPU
    is similar/higher). **NEXT after the beta.2 judder confirm: consider H.265** — the
    capturer already has `--codec h265` (WC); the gap is Mac-receiver HEVC decode
    (`decoder.swift` → `CMVideoFormatDescriptionCreateFromHEVCParameterSets` VPS+SPS+PPS,
    2-byte NAL header, VCL types 0-31/IDR 19-20 + codec-aware `nalSplitter.ts` `isVcl()` +
    negotiation; VideoToolbox on the M4 Pro decodes HEVC in hardware = feasible, medium
    effort both ends).
  - 3d cursor from DXGI over the dormant `'cursor'` channel (un-gate
    `PR_CURSOR_OVERLAY`) → Mac CSS overlay (reuse beta.4's plumbing).
- **STUCK-KEY BUG — FIXED (`cc4e381`, controller-side, NOT native-related, does not
  block v1.25.0):** holding a modifier (Left Shift) then switching focus (to Parsec/
  Alt-Tab) sent the physical keyup to the new foreground window, so the controller
  never forwarded keyup → the key stuck "down" on the agent (Thai still typed via
  Unicode; shortcuts broke). Windows-Claude proved it from input logs (down=2 up=1
  UNMATCHED). Fix in `ControllerSession.tsx`: track physically-held key codes +
  **panic-release** (keyup all + clear) on window `blur`/`pagehide`/visibility-hidden.
  Mac runs the controller from dev so the owner tests by relaunching (hold Shift →
  switch to Parsec → back → no stuck key).

IN PROGRESS (branch `feat/native-video`, NOT released — needs packaging +
PRERELEASE per golden rule #1): **the native video pipeline works END TO END on
real hardware, and the §3a compositing crux is SOLVED.** The Windows desktop now
decodes + renders natively inside the Mac controller and feels like a normal app.
- **Path**: Windows agent `ffmpeg` (ddagrab DXGI → h264_nvenc, `mf` fallback) →
  Annex-B → `H264RtpPacketizer` → RTP over node-datachannel on
  `channel:'video-native'` → Mac receiver child (`video-native/receiver/`, ndc +
  JS `rtpDepacketizer` since ndc has no H.264 depacketizer) → **forwards each AU
  to Electron main** as `{evt:'au',data:Buffer}` over an `'advanced'`-serialized
  fork channel → main `pushNativeAccessUnit` → **koffi → `librvr.dylib`** →
  VideoToolbox decode → `AVSampleBufferDisplayLayer`.
- **§3a FIX (the whole point)**: the decoded video is an `AVSampleBufferDisplayLayer`
  -backed NSView added as the BOTTOM subview of the controller window's OWN content
  view (`embed.swift`, pointer from `getNativeWindowHandle()`), NOT a separate
  floating NSWindow. One window ⇒ the OS handles drag / resize / fullscreen /
  Spaces / z-order / corner-rounding for free. This killed every prior symptom
  (drag stutter, covers-everything, clipped corners, fullscreen-mouse-dead) at the
  root. The web UI sits above it, transparent over the video area (CSS
  `.native-video`), controls paint on top.
- **Window UX** (all verified windowed on the real Mac): session window locked to
  the remote's 16:9 (`setAspectRatio` + one-time `setContentSize` snap) so the
  video fills edge-to-edge with no letterbox AND input maps 1:1; a `.session-titlebar`
  app-name bar ("Personal Remote · <machine>") that is the window-drag handle
  (rendered whenever windowed, z-index BELOW the floating controls); the floating
  control panel moved below the bar (top:42px) and made responsive (`flex-wrap` +
  `max-width:calc(100vw-24px)`) so it stays usable in a small window.
- **New code**: `receiver/render/{decoder.swift(shared),embed.swift(dylib),main.swift(selftest)}`,
  `main/nativeRenderSurface.ts` (lazy koffi, golden rule #5), build via
  `scripts/build-render-mac.sh` (→ `out/video-render/librvr.dylib`, a sibling of
  out/main so main rebuilds don't wipe it), launch via
  `start-controller-native.command`. SAFETY BAR intact: everything gated on
  `VIDEO_PIPELINE=native` + both caps; default build is byte-identical WebRTC.
- **Verified**: dylib exports the 3 C symbols; koffi loads it + calls safely under
  Electron's Node ABI; selftest decodes 120/120; typecheck + full build clean;
  and the owner confirmed on real hardware — video in-window, smooth drag, working
  fullscreen mouse, no covering, title bar, responsive controls.
- **IN-APP TOGGLE (2026-07-07, `3e68964`)**: the owner asked to run Native as the
  PRIMARY path ("ลื่นสมูส"). Answered by making native a **saved per-machine
  preference** (`main/pipelineConfig.ts` → userData `video-pipeline.txt`, mirrors
  themeConfig) + a **sidebar bolt toggle** (`controller/PipelineToggle.tsx`),
  instead of an env var + a special launcher — WITHOUT removing WebRTC, which
  stays the automatic safety net UNDER native (native only runs Windows-NVIDIA
  +ffmpeg → Mac; anything else / ffmpeg missing / native failure silently falls
  back to WebRTC). `resolveVideoPipeline()` lets the `VIDEO_PIPELINE` env still
  win (dev/harness override), else the saved pref; the 3 startup gates in
  `main/index.ts` now read `nativePipelineEnabled()`. SAFETY BAR intact: code
  default stays `'webrtc'` → no file + no env = byte-identical. `pipeline:get/set`
  IPC + `window.api.pipeline`. Toggle applies on the NEXT session (receiver host
  is wired at startup). `start-controller.command` now builds `librvr.dylib` +
  exports `VIDEO_RENDER_LIB` (guarded on swiftc) so the toggle engages native from
  the ONE normal launcher; it deliberately does NOT set `VIDEO_PIPELINE` so the
  toggle is the source of truth. Typecheck + full build + lint clean.
- **AUTO-NATIVE DEFAULT (owner, 2026-07-07, `c2a686d`): native is now the AUTO
  default** ("บังคับออโต้ native เป็นหลัก") — `pipelineConfig` `AUTO_DEFAULT_PIPELINE
  = 'native'`, so a machine with no saved file tries native automatically (no
  toggle press); the sidebar bolt becomes the OFF switch. This FLIPS the old
  "default byte-identical WebRTC" safety bar, but stays safe because native only
  ACTUALLY engages when both peers advertise the cap + hosts ready, else TOTAL
  silent WebRTC fallback. To keep that fallback total, `video-receiver:is-ready`
  now ALSO requires `nativeSurfaceAvailable()` (dylib loadable) — a machine that
  spawned the receiver but can't load `librvr.dylib` must NOT advertise native or
  it'd black-screen with no fallback. Still MUST ship via PRERELEASE + real-agent
  verify (ffmpeg) before a full release (golden rule #1). Live HUD badge
  `⚡ NATIVE`/`WebRTC` (`.pipeline-badge`, app.css) in `ControllerSession` shows
  which path is ACTUALLY rendering (bolt = saved intent; badge = live reality).
- **ffmpeg BUNDLED + PRERELEASE v1.24.0-beta.1 (2026-07-07, `7d72300`)**: native
  video now ships out of the box on Windows. Windows-Claude verified the agent's
  ffmpeg (ddagrab DXGI + h264_nvenc, static LGPL master 2026-07-06) runs the exact
  `buildFfmpegArgs()` argv on real hardware (RTX, zero-copy NVENC, 8.86MB H.264 in
  2s, no stderr). Owner chose to bundle (vs per-machine FFMPEG_PATH). Mac side:
  `electron-builder.yml` `win.extraResources` packs `apps/desktop/ffmpeg/` →
  `resources/ffmpeg/ffmpeg.exe` (where `resolveFfmpegPath()` looks);
  `build-win.sh` downloads+caches the LGPL build once, VERIFIES it's a PE AND that
  `strings` contains `ddagrab`+`h264_nvenc` before packing, stages it, and asserts
  it's in the packed app. Installer +67MB (100→167MB). Built via `build-win.sh` @
  `7d72300`, all 3 packed-binary checks pass (ndc/koffi/ffmpeg). Published as
  **PRERELEASE v1.24.0-beta.1** (golden rule #1 — native = FFI). **NEXT: real e2e**
  — install over v1.23.0, control from the Mac, confirm the HUD badge shows
  `⚡NATIVE` (not WebRTC) + it feels smoother + the agent's `videoSenderHost`
  spawns ffmpeg (check logs). If good → promote to full v1.24.0.
- **beta.1 e2e (Windows-Claude, real hardware): PASS except one bug.** ✅ ffmpeg
  bundle spawned from `resources\ffmpeg\ffmpeg.exe` (not env — after removing the
  stale `FFMPEG_PATH`), nvenc live, `⚡NATIVE` badge shown, stream live. ❌ native
  cursor drifted on Y — symmetric about centre, worse toward top/bottom (X fine).
- **MOUSE FIX → PRERELEASE v1.24.0-beta.2 (`bb858ce`)**: root cause = the native
  surface draws `.resizeAspect` (letterbox, embed.swift) inside the session window,
  whose aspect lock (`setAspectRatio`) only APPROXIMATELY holds 16:9, so the drawn
  video rect is a hair shorter than the element box; the old native mouse mapping
  normalized over the FULL box → error over the bars. WebRTC was immune because
  `videoRelativePosition` is already letterbox-aware. Fix: native `relativePosition`
  now reproduces the same object-fit math using the remote frame size from
  `nativeStats` (fallback 16:9), mapping over the ACTUAL video rect (pointer on the
  bars → null/no-move). Agent input map untouched (correct). Rebuilt via
  `build-win.sh` @ `bb858ce` (ffmpeg cached), published **v1.24.0-beta.2**. NEXT:
  Windows-Claude installs beta.2 over beta.1, confirms the cursor tracks 1:1 to the
  edges → then promote full v1.24.0.
- **STILL TODO to ship (revised for the owner's dev setup)**: the "bundle
  `librvr.dylib` into Mac app Resources + codesign/notarize" TODO is **moot while
  the owner runs the Mac controller from `electron-vite dev`** (no packaged .dmg —
  backlog #5, deferred); in dev the resolver finds the dylib via
  `VIDEO_RENDER_LIB`/out-sibling. The REAL remaining gaps are Windows-side:
  **(1) ffmpeg must be present** on the agent (ddagrab→h264_nvenc) — ship it or
  find on PATH; **(2)** flip the agent's saved pref to native (an agent-side
  toggle mirroring PipelineToggle, or a script/file) so its sender host spawns;
  then **(3)** real-hardware e2e + PRERELEASE (golden rule #1) before any full
  release — default stays WebRTC. `stats` still reports fps/kbps only
  (decodeMs/renderMs dropped with the Swift subprocess); Windows-side NVENC
  preset/bitrate sweep still open.
- Commits on `feat/native-video`: `ae3c502` (§3a in-window composite), `652b5bb`
  + `3cd6d2f` (title bar), `29eb5ab` (controls below bar), `4397cea` (responsive
  control bar in small windows), `3e68964` (in-app pipeline toggle + persisted
  pref).

Latest release: **v1.27.0** — **BWE auto-bitrate + HUD encode telemetry** (off
`feat/native-video`). The native capturer path (`VIDEO_CAPTURER=1`) now adapts its
VBR bitrate to the link: the Mac receiver runs a loss+jitter AIMD estimator
(`receiver/bwe.ts`, **cap 25 / floor 5 Mbps**, +2 additive / ×0.85 backoff), rides
the target over signaling (`video-bitrate`), and the agent forwards `B<kbps>` to the
capturer stdin (`nvEncReconfigureEncoder`, no respawn). **cap 25 is deliberate** —
beta.1's cap-60 caused bufferbloat on the owner's ~40 Mbps link (delay, not loss →
loss-only AIMD never backed off → double-cursor/freeze); beta.2 fixed it by starting
AT the proven-good 25 and adding a jitter (delay) backoff signal
([[loss-only-bwe-misses-bufferbloat]]). Also: **HUD `Encode X.Xms`** — the capturer
measures pure HW encode time (`enc_ms`, nvEncEncodePicture→LockBitstream) → relayed
agent→controller via `video-sender-stats` → shown in the HUD; **fullscreen HUD
expands** to a full-width telemetry strip; **BWE target** shown as `actual → target
Mbps`. WC-verified on real hardware (baseline
[`docs/streaming-baseline-v1.27.0-beta.3.md`](docs/streaming-baseline-v1.27.0-beta.3.md):
enc_ms avg 5.6ms < Parsec 8.72ms, locked-60, BWE cap 25 confirmed, error 0; owner
confirmed HUD Encode 5.5ms live), shipped via prereleases beta.1–beta.3 before this
full release (golden rules #1/#7). Prior full releases rolled up below.

Prior release: **v1.26.0** — **custom DXGI capturer, locked-60 (smooth like Parsec).**
Standalone `capturer.exe` (DXGI Desktop Duplication + change-detection + locked-60
cadence + idle-decay + NVENC → Annex-B on stdout), opt-in `VIDEO_CAPTURER=1`, ffmpeg
fallback. Change-detection idles the GPU on a static screen (mouse-only = skip);
locked-60 emit fixed the judder ("ลื่นเหมือน Parsec" — owner-verified). Also has the
BWE stdin primitive (`B<kbps>`) + `--codec h265` that v1.27.0/H.265 build on.

Prior release: **v1.25.1** — Parsec-parity roadmap Step 1 (off `feat/native-video`,
same as v1.25.0). Native-video keyframe tuning: **plain periodic IDR every 2s
(`-g 120`)** instead of v1.25.0's 1s (`-g 60`), halving the keyframe-spike
frequency. Step 1 originally tried NVENC `-intra-refresh` for a fully flat bitrate
but it is **permanently dropped** — the Mac VideoToolbox decoder can't handle the
rolling-intra P-frame structure (froze mid-session at every GOP length; verified via
prereleases beta.1–beta.4 before this clean full release, golden rules #1/#7). See
[[pure-intra-refresh-freezes-videotoolbox]]. Prior full release rolled up below.

Prior release: **v1.25.0** — native video 60fps + VBR≤40, ddagrab crash-recovery,
dup_frames on-change capture, HUD latency telemetry, stuck-key panic-release. (Step 0
of the roadmap: reverted the beta.4 cursor-out-of-video regression.)

Prior release: **v1.24.0** — **native video pipeline (lower latency than
WebRTC), SHIPPED + signed off on real hardware.** The whole feat/native-video
effort (see the IN PROGRESS block above for the architecture) is now a full
release. Windows agent ffmpeg (ddagrab DXGI → h264_nvenc) → RTP → Mac controller
VideoToolbox decode + in-window compositing. Highlights:
- **Auto-default** (owner: "บังคับออโต้ native เป็นหลัก"): native engages
  automatically when both ends support it; **WebRTC is the automatic fallback**
  (no NVIDIA / no ffmpeg / native failure / dylib-not-loadable → silently WebRTC,
  never a black screen). `pipelineConfig.ts` `AUTO_DEFAULT_PIPELINE='native'`;
  `video-receiver:is-ready` also requires `nativeSurfaceAvailable()`.
- **Bundled ffmpeg** (LGPL, ddagrab+h264_nvenc) at `resources/ffmpeg/ffmpeg.exe`
  via `electron-builder.yml` `win.extraResources` + `build-win.sh` (downloads/
  caches/strings-verifies the encoders). Installer 100→167MB.
- Sidebar **bolt toggle** (off-switch to force WebRTC) + live **⚡NATIVE/WebRTC**
  HUD badge (bolt=intent, badge=reality). Letterbox-aware native mouse mapping
  (cursor 1:1 to edges — the beta.1→beta.2 fix).
- Golden rules #1/#7 honored: prereleases beta.1 (ffmpeg e2e) + beta.2 (mouse
  fix) verified on the real Windows agent before this clean full v1.24.0. The Mac
  controller still runs from `electron-vite dev` (`start-controller.command` now
  builds `librvr.dylib`); a packaged Mac .dmg + codesign stays deferred
  (backlog #5). Commits: `3e68964` (toggle) `c2a686d` (auto-default+badge)
  `7d72300` (ffmpeg bundle) `bb858ce` (mouse fix) `00e6abb`-ish (v1.24.0). Owner
  confirmed on real hardware: ⚡NATIVE live, cursor 1:1, Thai/English typing OK.

Prior release: **v1.23.0** — **elevated input: Task Manager + secure desktop
(UAC / Ctrl+Alt+Del / lock screen)**. Fixes the owner's "open Task Manager →
mouse dies" and adds control on the secure desktop. Full details in backlog #8
(Track 1 + Track 2, both DONE + proven on real hardware, permanent across reboot).
Both features ship OFF by default (gated behind `PR_INPUT_SERVICE=1` + their setup
scripts: `install-agent-autostart.ps1` for Track 1, `setup-track2-permanent.ps1`
for Track 2), so a plain auto-update is byte-identical WebRTC. Built from
`feat/native-video @ 3c17df4` via `build-win.sh`; verified via prerelease
v1.23.0-beta.1 on the real Windows agent first (golden rule #1). REMAINING polish
(deferred, owner is sole user): Phase 4 hardening (Fix B pipe SDDL + squat guard,
injector crash-respawn, uninstall cleanup) + an in-app Track-2 toggle — do these
when family joins; SYSTEM video capture (see the secure desktop) is a separate
big project.

Prior release: **v1.22.0** — **video quality now matches Parsec** (1920×1080 @
~37 Mbps, verified side-by-side on the same machines). Root cause the owner hit:
on a flawless path (Network 11ms, 0% loss, 0ms jitter, direct P2P) the stream
was still a blurry 480×270 @ 0.1 Mbps — WebRTC's bandwidth estimator (BWE)
starts ultra-conservative and never probes back up on a quiet link, and
`degradationPreference='maintain-framerate'` let the quality scaler nuke
resolution to protect fps. Fixes (all in `agent/AgentView.tsx`, the encoder =
agent side):
- `maxBitrate` 15→30 Mbps; `scaleResolutionDownBy=1` (forbid downscale);
  `degradationPreference` → **`maintain-resolution`** (hold 1080p, flex fps
  only under genuine pressure).
- **SDP munge** on the offer: append `x-google-min-bitrate=6000;
  x-google-start-bitrate=20000;x-google-max-bitrate=30000` to the H.264 fmtp
  line (`profile-level-id`) — the min/start floor is what actually stops the
  0.1 Mbps collapse and makes it begin high instead of ramping from ~0.
- HUD (`useVideoStats.ts` + `ControllerSession.tsx`) now also shows **Loss %**
  and **Jitter ms** (were the two missing diagnostics; RTT/decode already there).
- Shipped via prereleases first (beta.1 fixed bitrate → 720p; beta.2 locked
  1080p) tested on the real Windows agent before this full release.

KNOWN CEILING (documented for future): with every measurable now matching
Parsec, the remaining "not glued to the mouse" feel is **pipeline latency**, not
tunable via settings — Chromium's `desktopCapturer` capture (Windows agent) +
`<video>`/compositor render (Mac controller) each add ~1-2 frames. The only way
past it is a **native receiver** (receive RTP via node-datachannel outside
Chromium → VideoToolbox decode → AVSampleBufferDisplayLayer/Metal render,
mirroring how input was moved to the native helper). Big native/FFI project,
deferred by the owner ("เก็บของก่อน") — the encoder/bitrate tuning is exhausted.

Prior release: **v1.21.2** — **glass opacity 12% → 40%** (owner asked; the
shell is more solid / less washed out) + a dev-launcher crash fix:
- **Glass opacity 12% → 40%.** `deviceList.css`
  `:root[data-theme='glass'] .ctl-shell`: `--dl-bg` .12→.40; rail .34→.55,
  card .44→.66 bumped alongside to keep the shell<rail<card readability
  hierarchy. Controller-only theme (agent stays dark), so this only changes
  the look of the Mac controller in glass mode.
- **FIX: `start-controller.command` crashed on launch when started from an
  Electron parent** (VS Code integrated terminal / Claude Code). Those parents
  export `ELECTRON_RUN_AS_NODE=1` (we set it to fork the input-helper), it
  inherits into `electron-vite dev`, and Electron then boots as plain Node —
  `electron.app` is undefined so `@electron-toolkit/utils` throws
  `Cannot read properties of undefined (reading 'isPackaged')` at import, the
  window never appears, the process exits (looks like "opens then closes
  itself"). NOT set globally (`launchctl`/`.zshrc` are clean) — pure per-process
  inheritance. Fix: the launcher now `unset ELECTRON_RUN_AS_NODE` before
  `pnpm dev`. Same root cause as the documented `env -u ELECTRON_RUN_AS_NODE`
  workaround. Verified: launching from a shell that has the var set now boots
  real Electron, window stays alive. Also `apps/desktop/.gitignore` ignores
  `*.tsbuildinfo` now.

Prior release: **v1.21.1** — **'glass' translucent see-through theme** (3rd
theme beside dark/light). The **macOS** controller window is now created
`transparent:true` **ALWAYS** (v1.21.0 gated it to the saved theme + relaunched
on toggle, but the owner runs the Mac controller via `electron-vite dev` where
`app.relaunch()`+exit just KILLS the app — the vite dev server dies with it).
Dark/light paint an opaque `.ctl-shell` over the transparent window (normal
look, rounded corners + shadow intact — verified on the real Mac), glass drops
to ~12%. So the theme toggle is fully LIVE, no relaunch, works in dev +
packaged. Verified on the real Mac: over a white window the glass shell goes
pale, over dark it stays dark (real see-through); dark theme stays opaque.
**Windows keeps opaque** because `transparent:true` breaks the titleBarOverlay
caption buttons, so glass there degrades to a solid dark tint (backgroundColor
'#171210' under the alpha) — a Windows acrylic/`backgroundMaterial` pass is a
TODO. New `GlassToggle.tsx` (droplet) in
the sidebar; `ThemeToggle` is now a CONTROLLED component — `ControllerView`
owns `theme` state and passes both toggles an `onChange`. `themeConfig` Theme is
now `'dark'|'light'|'glass'`; glass tokens live in `deviceList.css`
(`:root[data-theme='glass'] .ctl-shell` + a `body`/`#root` transparent
override). KNOWN: near-white shell text can wash out over a light wallpaper (no
text-shadow on the heading/footer yet — card name/status already have one);
owner picked 12%/no-blur in the glass-theme mockup artifact. To try on Mac:
`env -u ELECTRON_RUN_AS_NODE APP_MODE=controller ./node_modules/.bin/electron
out/main/index.js` (seed userData `theme.txt`=glass at ~/Library/Application
Support/Electron). v1.20.10 = Connect button inset 4px from the card
left/right/bottom via `.dl-btn { margin:0 4px 4px }` — dropped `width:100%` so
flex-stretch keeps it full-width-minus-margins, else it'd overflow; name
14→12, status 11→10. From a 3rd card-tuner export; the tuner grew a "ระยะปุ่ม
จากขอบ" (btnm) slider + a "ความมนจอ"/padding-min-0 pass earlier). v1.20.9 =
in-session floating control bar now starts COLLAPSED — `ControllerSession` `panelOpen` initial state `true`→`false`; on
connect you see just the small dim status-dot pill (`.session-float__toggle`,
top-center, opacity .45) and click it to expand the Back/name/stats/status
bar). v1.20.8 = thinner frame around the card's screen preview:
`.dl-card` padding 8→4, `.dl-thumb` radius 12→30 so it nests concentrically in
the 34px card corner and the screen hugs all 4 edges evenly). v1.20.7 = name +
online status are now TWO independently
placed labels over the screen — `.dl-name` at `left:2%;top:92%` (bottom-left),
`.dl-status-row` at `right:4px;top:92%` (bottom-right, right-anchored so
"online" can't clip on a narrower card); name 14px, status 11px; both
`position:absolute` inside `.dl-thumb`, no `.dl-overlay` wrapper anymore. Came
from a 2nd card-tuner export where the owner dragged name & status to separate
corners — the tuner now supports independent drag of each). v1.20.6 = card
thumbnail `object-fit: contain` — the live capture shows FULL/uncropped;
`cover` had zoomed it and clipped the left/right edges of the screen. A
streaming card gets `.dl-thumb.has-screen { background:#0d0f14 }` so contain's
letterbox bars read as a monitor bezel.
v1.20.5 rebuilt the device card from the owner's own
**card-tuner** export: name + online status now FLOAT over the screen preview
— an abs-positioned `.dl-overlay` INSIDE `.dl-thumb`, bottom-left `left:17%;
top:90%`, white text `#fff`/`#e8e0d8` with a strong outline shadow, no scrim
box — Parsec-style. Card is a fixed ~302px, `.dl-grid`
`repeat(auto-fill,minmax(258px,302px))` so it no longer stretches full-width;
card radius 34, padding 8, gap 4; thumb radius 12, aspect 16/10, still
transparent bg + live thumbnail when streaming else 28px MonitorIcon; name
12px, status 10px, Connect pill padding 8 / font 12. KNOWN weak spot: light
theme + icon-fallback (online but not yet streaming) = white text on cream,
legible via the outline shadow but not pretty; real machines stream a dark
screen so it's transient — offer theme-aware text color if it bugs the owner.
The **card-tuner artifact** (scratchpad `card-tuner.html`, favicon 🖥️) has a
canvas mock desktop + draggable text overlay + Export → owner sends the JSON,
we apply 1:1. LESSON from v1.20.3/4: don't infer card intent from screenshots
— the tuner ended the guessing loop. v1.20.4 restored the live preview
(v1.20.3 had wrongly removed it). v1.20.2 = transparent thumb bg so placeholder icon floats, 40px icon, 18px card radius, 12px rounder Connect button, bigger name/status; live thumbnails still shown when sent. v1.20.1 = taller thumbnail + ID line removed. v1.20.0 = **light mode (Amber Light) + a sliding sun/moon
theme toggle** at the bottom of the controller sidebar. The whole controller
shell themes through `--dl-*` tokens (deviceList.css); a
`:root[data-theme='light'] .ctl-shell` block redefines them. Persisted per
machine via `main/themeConfig.ts` (userData `theme.txt`, default dark);
`ThemeToggle.tsx` flips `document.documentElement.dataset.theme` + saves.
Session view + agent/setup screens stay dark for now (later pass); Windows
titleBarOverlay buttons keep their dark tint until re-themed dynamically.

The controller has an app-shell layout: a
slim icon sidebar (Computers / File Transfer) drawn by ControllerView, with a
single centered TitleBar (OS bar hidden — macOS hiddenInset traffic lights,
Windows titleBarOverlay whose 38px height must match `.app-titlebar`). A live
session takes the whole window with Parsec-style floating controls (collapsible
pill; only the ⠿ grip is a window-drag region). Recent release trail:
- v1.19.x — **multi-machine file transfer** (File Transfer page): tick online
  machines, pick (native OS dialog via `dialog:pick-files` — a hidden
  `<input type=file>` .click() does NOT open the dialog in this Electron
  build) or drop files, send to all at once. Each target = an independent
  headless `pushFilesToDevice` (own signaling+peer connection, advertises no
  caps so the agent serves the file channel on its legacy renderer path).
  Reliability (v1.19.4): progress = bytes flushed to network (offset −
  bufferedAmount), poll-based drain (the edge-triggered `bufferedamountlow`
  never fired on a 2nd consecutive send → wedged at ~18% while bytes still
  drained), 20s stall watchdog, double-send guard. Roster gained optional
  os + lastSeenAt. CAVEAT: an agent serves one controller at a time, so
  pushing to a machine mid-session kicks that session.
- v1.18.x — UI redesign pass: single centered titlebar; agent window fixed
  680×700 (preview box removed); single-instance lock (relaunch surfaces the
  running window / brings the tray agent back); floating session controls.
- v1.17.1 CSP hotfix; v1.17.0 house token; v1.16.0 clipboard-in-helper.

Working and verified on real hardware:
- Latency ≈ Parsec (direct connection, ~11 ms network).
- Mouse + keyboard survive agent window hidden/X-closed (native helper).
- Thai/English typing + shortcuts; Windows grave `~` layout toggle.
- Typed language follows the CONTROLLER machine's layout (deliberate design —
  each user switches language on their own machine).
- File transfer controller→agent, including multi-machine send from the File
  Transfer page — verified: repeated back-to-back sends, ~590 MB files.
- Auto-update via GitHub Releases; signaling self-heals via supervisor.

Also working since v1.16.0:
- **Clipboard sync survives the agent window hiding** — runs in the input
  helper on the helper's pc (`clipboardNative.ts` + shared
  `clipboardSyncCore.ts`). The v1.15.0 segfault's root cause: koffi's `str16`
  is a POINTER type, so encode/decode stored a transient koffi buffer pointer
  in clipboard memory instead of the text (→ dangling-pointer crash AND
  cross-app paste never actually worked). Fix: inline UTF-16 code units via
  `koffi.array('uint16', n)`, reads bounded by `GlobalSize`, chunked string
  building, `OpenClipboard(null)`. NOTE for future clipboard tests: the owner
  sometimes runs Parsec, whose clipboard sync masks ours — close it first.
  Cosmetic nit for later: helper's `clipboard.onopen` log is overwritten by
  runClipboardSync, never prints.

Since v1.17.0 — **house token** (one shared secret per household):
- Gates register-agent, pair-request (checked BEFORE the PIN — no guessing
  oracle), list-devices (roster leaks names + live thumbnails), and
  remove-device. A wrong/rotated token routes the app back to the
  first-launch token screen via the new `server-error` message.
- Entered once per machine (TokenSetupView on first launch), persisted in
  userData `house-token.txt`; nothing secret is baked into builds anymore
  (`VITE_AGENT_TOKEN` is gone). Dev falls back to `dev-token-change-me`
  (unpackaged only); `HOUSE_TOKEN` env overrides for harnesses.
- The real token lives ONLY in: the LaunchAgent plist
  (`~/Library/LaunchAgents/com.personalremote.signaling.plist`,
  EnvironmentVariables.AGENT_TOKEN), a backup at
  `~/.personal-remote-house-token` (mode 600), and each machine's userData.
  NEVER commit it. Rotating it = edit plist → restart LaunchAgent → kill any
  stray server on 8080 → every machine re-enters via the auto-shown screen.
- Ops gotcha (2026-07-06): a leftover `tsx watch` DEV server was holding
  port 8080, so the supervisor had never spawned its real `dist/index.js` —
  production was silently running dev code with the default token. After
  changing server code: `pnpm --filter signaling-server build`, kill
  whatever holds 8080, let the supervisor's 60s ensureServer respawn it.
- Verified: 9/9 local enforcement tests + live server rejects the old
  default and accepts the new token.

**v1.17.1 CSP incident (2026-07-06) — big lesson:** the renderer CSP
(`connect-src 'self' ws: wss:`) had no `https:` source, so the packaged
app's fetch of `signaling-url.json` from raw.githubusercontent.com was
silently CSP-blocked since the mechanism shipped (v1.13) — the resolver
swallows failures and falls back to the build-time URL, so it only LOOKED
like dynamic URL resolution worked. First tunnel rotation after v1.17.0
bricked every installed app ("disconnected, reconnecting..." forever).
Lessons:
- Dev couldn't catch it (DEV mode skips the fetch). To test the real
  production network path on the Mac: `npx electron out/main/index.js` with
  `APP_MODE=agent` after `npm run build`, ideally with a deliberately dead
  `VITE_SIGNALING_URL` so only the GitHub path can succeed. NOTE: running
  electron against a bare file uses `~/Library/Application Support/Electron/`
  (not `desktop/`) for userData — seed house-token.txt there.
- Windows-side Claude can diagnose installed-app issues by reading the
  packed bundle under the install dir (CSP, baked constants) — no DevTools
  needed.
- A fallback that silently swallows failures hides dead code paths for
  months. Prefer logging/telemetry when a primary path falls back.
- Old (pre-v1.17.0) clients that fail the token check hammer the server in
  a ~1s connect/reject loop (server closes; client backoff resets on every
  successful open). Harmless at family scale; remember when reading logs.

## Backlog (rough priority)

0. **Parsec-parity streaming roadmap** — Step 3 SHIPPED (v1.26.0). Full plan in
   [`docs/streaming-improvements-plan.md`](docs/streaming-improvements-plan.md);
   Step 3 detail in [`docs/step3-dxgi-capturer.md`](docs/step3-dxgi-capturer.md).
   ✅ Step 0 (v1.25.0) → ✅ Step 1 (v1.25.1: `-g 120`, intra-refresh dropped) → ⏭️ Step 2
   SKIPPED (no-op) → ✅ **Step 3 custom DXGI capturer (v1.26.0: change-detection +
   locked-60 = "smooth like Parsec", owner-verified)** → Step 4 FEC (deferred).
   **NEXT TWO (owner-requested 2026-07-08, spec in
   [`docs/bwe-hevc-plan.md`](docs/bwe-hevc-plan.md)):** **(A) BWE auto-bitrate ≤60 Mbps**
   — Mac receiver measures seq-gap loss → AIMD → target over signaling → agent forwards
   `B<kbps>` to the capturer stdin. **(B) H.265** — the real remaining Parsec gap
   (1.6× efficiency, ~half bitrate); needs codec-aware `nalSplitter.ts` + HEVC
   `decoder.swift` (VideoToolbox HW-decodes HEVC on the M4 Pro). Do A first, then B.
   - **(A) BWE — ✅ PRERELEASE v1.27.0-beta.3 (BWE bufferbloat fix + HUD telemetry),
     WC-VERIFIED on real hardware, baseline captured — PROMOTABLE to full v1.27.0.**
     BWE both halves landed (Mac AIMD `20e05bf`, agent forward
     `3790ad2`). **ENABLE: launch the agent with `VIDEO_CAPTURER=1`** (default OFF =
     ffmpeg = no BWE). Signaling server restarted (PID 39111 now relays BOTH
     `video-bitrate` AND `video-sender-stats`).
     - **BASELINE (WC, 2026-07-08, 330s continuous, Parsec running — full dataset in
       [`docs/streaming-baseline-v1.27.0-beta.3.md`](docs/streaming-baseline-v1.27.0-beta.3.md)):**
       `spawn capturer` (not ffmpeg), 2560×1440 H.264 VBR 25/35, gop 120 no-intra-refresh,
       **locked-60 emit (avg 60.6/s)**, change-detection working (mouse-only = skip),
       **enc_ms 3.4–6.6 (avg 5.6ms) — BELOW Parsec's 8.72ms**, GPU no longer downclocks to
       210MHz under real use, **BWE ramps 21250→23250→25000 and stops at cap 25** (beta.2
       fix confirmed, 0 bufferbloat backoffs on the good link), **error 0** across the
       session, no double-cursor/freeze like beta.1. Owner: "ใช้งานได้ปกติ". The enc_ms
       chain (capturer enc_ms → getEncodeMs → reportStats → AgentView relay → HUD) is
       complete; only open item = owner reads the exact `Encode` number on the HUD
       (~5–6ms) to close C 100%, then promote full v1.27.0.
     - **beta.3 adds the HUD telemetry the owner asked for ("เพิ่มตัวดู Encode/Decode +
       ขยายแถบตอน fullscreen"):** (1) **Encode ms** — the capturer measures pure HW
       encode (nvEncEncodePicture→nvEncLockBitstream, excludes the fwrite/pipe-
       backpressure wait that bloated the number before; WC `df75bbb`, ~3-7ms on the RTX
       at 60fps), reports `enc_ms=` in its per-sec log → `frameSource.getEncodeMs()`
       (ignores the 0.0 idle-window value) → `sender/index.ts` fills `encodeMs` →
       AgentView forwards it over the new **`video-sender-stats`** signaling msg
       (agent→controller, `packages/protocol` + server relay) → HUD shows `Encode X.Xms`
       (Mac `92197a5`). (2) **Fullscreen HUD expand** — float rises to the top edge (drag
       titlebar hidden there) + stats row grows (14px tabular). (3) **BWE target in HUD**
       — `actual → target Mbps` so the owner watches auto-bitrate adapt. **Decode ms
       deliberately NOT shown for native** — AVSampleBufferDisplayLayer has no decode-time
       callback (real native decode = a VTDecompressionSession rewrite, deferred/offered);
       WebRTC path still shows Decode. Controller-renderer bits also show on a plain
       `start-controller.command` relaunch (dev), but Encode needs beta.3 on the agent.
     - **beta.1 (`7cdea74`, cap 60, loss-only) = REGRESSION → BUFFERBLOAT (WC diagnosis
       from `video-sender.log`):** capped BWE at 60 Mbps but the owner's link is ~40, so
       a 60 Mbps VBR burst filled the queue → **3 symptoms, one cause:** double cursor
       (instant local Mac cursor vs the delayed in-video cursor), higher end-to-end
       latency, eventual freeze (queue finally overflows → packet loss → decoder waits
       for IDR). Loss-only AIMD **never backed off** (bitrate pinned B60000, 2 backoffs
       all session) because **bufferbloat is DELAY, not packet loss, until overflow.**
       NOT an agent-forward bug (forward relayed every value correctly). Also: **cap 60
     - **beta.1 (`7cdea74`, cap 60, loss-only) = REGRESSION → BUFFERBLOAT (WC diagnosis
       from `video-sender.log`):** capped BWE at 60 Mbps but the owner's link is ~40, so
       a 60 Mbps VBR burst filled the queue → **3 symptoms, one cause:** double cursor
       (instant local Mac cursor vs the delayed in-video cursor), higher end-to-end
       latency, eventual freeze (queue finally overflows → packet loss → decoder waits
       for IDR). Loss-only AIMD **never backed off** (bitrate pinned B60000, 2 backoffs
       all session) because **bufferbloat is DELAY, not packet loss, until overflow.**
       NOT an agent-forward bug (forward relayed every value correctly). Also: **cap 60
       was the wrong target from the start** — Parsec runs 1440p60 smooth at ~3 Mbps via
       H.265, so the low-bitrate win is Feature B (H.265), NOT pushing H.264 to 60.
       [[loss-only-bwe-misses-bufferbloat]]
     - **beta.2 FIX (`baab0df`, `receiver/bwe.ts`):** (1) **CEIL 60 → 25 Mbps** =
       v1.26.0's proven-smooth VBR target (maxrate ~40 on this link); **START = CEIL** so
       BWE starts at the known-good point and can only back OFF, never overshoot into
       bloat (worst case == v1.26.0 = smooth). (2) **Added a DELAY signal** — back off on
       a frame-pacing **jitter spike (>30ms)**, not just loss; jitter climbs as the queue
       builds, BEFORE loss → catches bufferbloat early. Probe up only when loss<2% AND
       jitter<18ms (healthy active = 3-13ms). `tick(jitterMs)`; units 14/14 (incl.
       jitter-only backoff + ramp-back-to-cap). **NEXT e2e (owner + WC, `VIDEO_CAPTURER=1`):
       should now feel == v1.26.0 on a good link (no double cursor / no added latency /
       no freeze) AND back off on a degrading link; WC tail `video-sender.log` for
       `set-bitrate → sent B<kbps>`. If clean → promote full v1.27.0.** (WC offered to
       roll the owner back to v1.26.0 for an immediate working session meanwhile — fine.)
     Detail of each half below.
   - **(A) BWE — MAC SIDE DONE (`20e05bf`):**
     `receiver/bwe.ts` (NEW, pure, units 10/10) = wrap-aware `SeqExtender` +
     seq-gap loss-fraction per 1s window + `AimdController` (clean <2% loss →
     +2 Mbps additive; >5% → ×0.85; clamp **[5, 60] Mbps** (owner cap); start 25;
     1 Mbps hysteresis). Static screen = no packets → `tick()` null → HOLD (don't
     probe on silence). Wired end-to-end on Mac: `receiver/index.ts` observes RTP
     seq (bytes 2-3) + emits `evt:'bitrate'` on a moved target → `ipc.ts` /
     `videoReceiverHost` / `main` / `preload` / `ControllerSession` → signaling
     **`video-bitrate` {deviceId, kbps, channel:'video-native'}** (new in
     `packages/protocol`; server relays it in the sdp/ice `resolveRelayTarget`
     group — **the live signaling server must be rebuilt/restarted to relay it**,
     like `video-native` SDP needed; old servers just drop it → sender holds
     launch bitrate = graceful).
     - **AGENT SIDE DONE (WC) — the 7 forward points wired, typecheck+lint+units
       clean, awaiting joint prerelease.** Signaling `video-bitrate` (channel
       `video-native`) → `AgentView.tsx` handler → `videoSender.setBitrate` (preload
       + `preload/index.d.ts`) → `ipcMain 'video-sender:set-bitrate'` (`main/index.ts`)
       → `videoSenderHost.setBitrate` → IPC `{cmd:'set-bitrate', kbps}`
       (`shared/ipc.ts` MainToVideoSender + VideoSenderHost) → `sender/index.ts`
       switch → `FrameSource.setBitrate`. `CapturerFrameSource.setBitrate` writes
       **`B<kbps>\n`** to the capturer stdin (mirrors `forceKeyframe`→`'I'`, rounds +
       writable-guards, drops on wedged pipe); `FfmpegFrameSource`/`Synthetic` no-op
       (ffmpeg can't retune live — BWE is a capturer-path feature). Capturer
       `B<kbps>\n` live retune RE-VERIFIED locally on the RTX this session (drove
       25→12→45→20 Mbps mid-stream via stdin: one process, exit 0, no respawn, output
       decodes 100% clean). ⚠️ capturer prints NO retune log → judge e2e by the
       bitrate that actually goes out, not a `[capturer]` log line. **NEXT = Mac
       rebuild/restart the live signaling server (to relay `video-bitrate`) + build
       the joint prerelease `VIDEO_CAPTURER=1` (golden rule #1), then owner e2e:
       static→target holds, narrow net→loss→bitrate drops, open→ramps to 60 & holds;
       pass = received fps ≈ emitted (net-drop 0) + smooth, NOT "locked 60".**
   - **(B) H.265 — FULL CODE DONE both ends (`e825583`), Mac receiver half VERIFIED on
     real hardware, → PRERELEASE v1.28.0-beta.1 (awaiting joint e2e).** HEVC is opt-in
     `VIDEO_CODEC=hevc` on the AGENT (default byte-identical H.264); the Mac receiver
     **auto-detects the codec from the offer SDP** (`H265/90000` rtpmap) so nothing needs
     configuring on the controller. Full spec: [`docs/bwe-hevc-plan.md`](docs/bwe-hevc-plan.md).
     - **Sender (TS, runs on agent):** `resolveCodec(env)` → node-datachannel
       `addH265Codec` + `H265RtpPacketizer` (0.32.3 ships both; no depacketizer, same as
       H.264); codec-aware `AccessUnitAssembler` (HEVC 2-byte NAL header, `type=(b0>>1)&0x3f`,
       VCL 0-31, IDR 19/20); coherent ffmpeg fallback (`hevc_nvenc` + `-f hevc`;
       `hevc_nvenc` never MF-fallbacks → the SDP codec can't disagree with the bitstream).
       capturer `--codec h265` was already done (WC-verified valid HEVC Annex-B).
     - **Receiver (Mac):** codec-aware `RtpDepacketizer` (RFC 7798 — AP 48 / FU 49 /
       2-byte header / FU-header rebuild); HEVC `decoder.swift` (VPS 32+SPS 33+PPS 34 →
       `CMVideoFormatDescriptionCreateFromHEVCParameterSets`, `nalUnitHeaderLength:4`) gated
       by a new `rvr_set_codec` C ABI; HEVC SPS dimension parser (`videoDimensions(au,codec)`,
       profile_tier_level skip + conformance window) for the HUD; codec plumbed
       receiver→main→koffi (`evt:'codec'` → `setNativeCodec` → `rvr_set_codec`, guarded so a
       stale dylib still loads H.264).
     - **VERIFIED on the real Mac (golden rule #1, receiver half):** the render selftest
       `--selftest-hevc` encodes HEVC via VideoToolbox and **decodes 120/120** through the
       exact production `Decoder`; `videoDimensions()` parsed **1920×1080** from that real
       VideoToolbox HEVC SPS. Sender + depacketizer unit tests cover BOTH codecs (all pass);
       typecheck + source lint clean; `librvr.dylib` rebuilt with `rvr_set_codec`.
     - **beta.1 e2e RESULT (WC, real hardware): DECODE PROVEN, one tuning bug fixed.**
       ✅ A/B/E PASS — `startSession codec=hevc`, H265 offer (547B vs h264 629B),
       `addH265Codec`+`H265RtpPacketizer` work on **ndc win32** (the never-verified risk),
       `CODEC h265` in the HUD, image clean (no green/artefacts) = **HEVC FU-49/AP-48
       depacketize + VideoToolbox decode PROVEN e2e — golden-rule-1 risk CLEARED.** enc_ms
       10.1ms + GPU 45% (vs H.264 5.6ms/29%) = HEVC encode ~2× heavier (expected). ❌ D:
       **~2s freezes** — ROOT CAUSE (WC from log): HEVC was capped at H.264's 25 Mbps, so a
       VBR burst to maxrate at an IDR/scene-change overflowed the owner's Parsec-shared
       ~35-45 Mbps link → seq-gap loss → VideoToolbox stalls on the broken reference until
       the next periodic IDR (gop 2s). Tuning, not a code fault.
     - **FIX (Mac-side, `c99e047`/`5e96d5d`, NO new agent build): codec-aware BWE ceiling
       — HEVC caps at 15 Mbps (vs H.264 25).** HEVC@15 ≈ H.264@25 quality (its whole point),
       and 15's maxrate burst stays under the link → no overflow → no loss → no stall. Plus
       BWE now **emits its target on the first window** so the capturer (which launches at 25)
       actually gets driven down to 15 (else the dead-band never sends B15000). Receiver-only
       (BWE target rides signaling to the capturer live) → **owner just relaunches
       `start-controller.command`**, agent stays on beta.1. Units cover the HEVC cap + first-emit.
     - **cap-15 retest (WC): freeze STILL there → cap was NOT the cause.** loss stayed
       ~1/min at 15 just like at 25 (BWE sent B15000, backoffs 12750=15000×0.85) → **loss is
       bitrate-INDEPENDENT** (15 Mbps is well under the link). Kept the 15 cap anyway (it's
       HEVC's correct quality/bitrate point) but it's not the freeze fix.
     - **REAL ROOT CAUSE + FIX (`43fdd8b`, receiver-side): PLI-on-loss.** WC's clincher —
       during every freeze the sender got **PLI=0** (only 1/connect). A lost packet breaks an
       HEVC frame; inter frames reference it, so VideoToolbox stalls until the next decodable
       entry = the periodic IDR (~2s @ gop 120) → the exact ~2s freeze. HEVC is more
       loss-sensitive than H.264 (bigger frames), so H.264 on the same link never showed it.
       Fix (the deferred Step 2/3 receiver work): the receiver detects a forward RTP seq gap
       in REAL TIME (`seqForwardDistance`, wrap-aware, unit-tested) → `requestKeyframe` →
       sender forces a cheap IDR via the capturer 'I' stdin (no respawn) → recovery in ~1 RTT
       vs ~2s. Rate-limited ≤1/s; reorder/dup ignored. Helps H.264 too. Receiver-only — no
       agent rebuild.
     - **PLI-on-loss VERIFIED (WC): freeze GONE → PROMOTED full v1.28.0.** PLI 0→29 during
       losses, recovery ~2s→~10ms, owner confirmed no long freeze; only a tiny ~10ms blip per
       loss (loss still ~1/min, not eliminated, just recovered fast). enc_ms 9.9 / GPU 44% /
       emit 60.5, errors 0. v1.28.0 = Latest (H.265 opt-in + PLI-on-loss + HEVC BWE cap 15).
   - **AUTO-TEST tooling (owner asked "หาระบบที่เทสออโต้ได้ ขี้เกียจนั่งดูเอง ไม่เห็นตัวเลขลึกๆ"):**
     `scripts/analyze-session.mjs` parses `video-receiver.log` (+ optional Windows
     `video-sender.log`) into ONE report — fps/jitter/bitrate/BWE + loss rate + **per-hitch
     recovery ms** + a plain **SMOOTH / MINOR JUDDER / FREEZING** verdict with next-step
     notes. Run `node scripts/analyze-session.mjs` after a session instead of scrolling logs
     (`--all` for reconnect-split sessions, `--json`). Backed by new receiver instrumentation:
     a "hitch" line (loss→recovering-keyframe = the real perceived-freeze duration) + per-sec
     `loss=/lostpkts=/pli=` in the stats line. Verified on the real 858s HEVC log (SMOOTH,
     14.9 Mbps @ cap 15, jitter 4.4ms).
   - **RESIDUAL-JUDDER tuning — reorder-tolerant loss detection (`af96f34`, receiver-only, no
     rebuild):** WC's clue — the ~1/min loss is HEVC-SPECIFIC (H.264 same link = 0 loss), so
     it's not plain network contention; a chunk is likely REORDER that the naive "any forward
     seq gap = loss → PLI now" misread → an unnecessary forced IDR = self-inflicted judder.
     New `LossDetector` holds a gap PENDING and only declares loss if the missing seq hasn't
     arrived within a small reorder window (8 packets/~few ms), so reorder cancels the gap (no
     PLI) while real loss still confirms fast. NO added latency (unlike PacingHandler, which
     would delay big frames — wrong trade for a mouse-glued pipeline). Unit-tested. **NEXT:
     owner relaunches `start-controller.command` → run `analyze-session.mjs` → see if loss/PLI/
     hitch counts drop (reorder was the cause) or hold (real network loss → then FEC/accept the
     ~10ms blip).** The auto-test now decides instead of eyeballing.
   - **JUDDER DIAGNOSED via the live analyzer (owner ran a stress video) → tuning FLOOR hit,
     then PIVOT to LTR.** The analyzer on the live HEVC session showed the residual = **total
     link BLACKOUTS** (each loss = 130–163 CONSECUTIVE packets = the link goes dark ~90ms;
     `loss=1 lostpkts=137` per 1s window = one gap, not scattered), **isolated ~every 20-60s**,
     and **bitrate-INDEPENDENT** (62 pkts lost at 12.5 Mbps, 17 at 16.8) = EXTERNAL contention
     (Parsec grabbing the shared ~40 Mbps link / Wi-Fi), not our encoder. So BWE/bitrate tuning
     is proven futile (cap-15 + `HOLD_WINDOWS_AFTER_BACKOFF`=3 hold-after-backoff converge landed
     but can't stop isolated external bursts). Recovery is already ~53ms; normal desktop use =
     loss 0. **FEC REJECTED after the analysis:** it can't recover a total blackout (parity is in
     the same dark window) without ~200ms interleaving latency = kills the mouse-glued feel.
   - **PARSEC-PARITY RESEARCH (owner asked to research how to match Parsec) →
     [`docs/parsec-parity-research.md`](docs/parsec-parity-research.md):** gap-analysis vs the
     low-latency playbook (the owner's guide + NVENC/VideoToolbox docs + Moonlight LTR issue #120)
     = **we already do ~90%** (zero-copy, HW codecs, low-latency present, BWE, reorder-tolerant
     loss, H.265). **The ONE remaining Parsec technique = LTR (Long-Term Reference) recovery**:
     on loss, encode a small P-frame from the last SAFE long-term reference instead of a full IDR
     burst (no keyframe spike, no self-congesting cascade, faster). Owner picked "ลุย LTR เลย".
   - **LTR recovery IN PROGRESS ([`docs/step-ltr-recovery.md`](docs/step-ltr-recovery.md)):**
     - **Mac sender wiring DONE (`7cbe3b3`):** `FrameSource.ltrRecover()` (CapturerFrameSource
       writes **`L`** to stdin; ffmpeg/synthetic fall back to `forceKeyframe`); `sender/index.ts`
       PLI handler — `VIDEO_LTR=1` → answer a PLI with `ltrRecover()` (LTR-P), and a repeat PLI
       within `LTR_ESCALATE_MS`=1200ms → escalate to a real IDR (guaranteed recovery). **No
       per-frame ACK / no receiver protocol change** — reuses the existing PLI; only the sender's
       response changes. Default (LTR off) = proven IDR path, byte-identical + safe with a
       pre-LTR capturer. typecheck/units/lint clean.
     - **Mac decode DE-RISKED (`299b0f8`, golden rule #1): VideoToolbox decodes an LTR stream
       119/120** (`--selftest-ltr` — a VT low-latency encoder marks LTRs + forces an LTR-refresh
       mid-stream; the production `Decoder` decodes it clean). So **LTR is VT-compatible** (unlike
       intra-refresh, which failed to decode). Receiver needs NO change. (NB `EnableLTR` needs the
       low-latency rate-control encoder spec first — was `-12900` without it.)
     - **WC L1 DONE (`8e4f502`) → joint PRERELEASE v1.29.0-beta.1 (LTR) → e2e RESULT: LTR is
       WORSE, left OFF.** capturer marks LTR every ~30f, on `L` encodes a P from the older LTR
       (WC bitstream-verified: NVENC uses the LTR, requested=used=0x1; LTR-P 5-7× smaller than
       IDR). But the Mac `analyze-session.mjs` on the stress video = **FREEZING, hitch avg 654ms
       / max 1870ms** vs v1.28 fast-IDR's ~53ms. ROOT CAUSE: our loss is BLACKOUT (wipes the LTR
       the LTR-P references) and, with **no per-frame ACK**, the sender guesses a "safe" LTR wrong
       → the LTR-P is undecodable → the receiver's 1s PLI cooldown means the escalation-to-IDR
       takes ~1-2s. **LTR fits SCATTERED loss, not our blackouts.** Verdict: `VIDEO_LTR` stays
       **OFF by default** (= v1.28 fast-IDR, 53ms) — LTR code kept as a building block (WC's 2
       polish fixes — mark sooner, `used=0x1` only — parked). Proper LTR needs ACK feedback (big).
   - **THE PARSEC-FEC INSIGHT (WC measured Parsec on the SAME link) → the real gap + plan.**
     Parsec during a high-motion video: **FPS locked 60, 0 dips, no spikes — yet it ALSO loses
     packets** (its loss counter moves). A true external blackout would dip Parsec too; it doesn't
     → **our 130-163-packet loss BURSTS are SELF-INDUCED** (we emit big frames; when one coincides
     with link contention the whole burst drops). Parsec's small/paced/VBV≈1-frame frames + **FEC**
     mean the same contention costs it only a few SCATTERED packets, which FEC repairs SILENTLY (no
     round-trip, no hitch). Ours is REACTIVE (PLI→recovery = a hitch per loss). **So the last gap =
     (1) our frames are too bursty + (2) no FEC.** Two-layer plan (full spec:
     [`docs/step-fec-recovery.md`](docs/step-fec-recovery.md)):
     - **⭐ LAYER 1 (do FIRST, cheap): shrink the NVENC VBV** ~250ms→~2 frames (guide §4.1) so
       every frame is small → the 130-packet bursts become **scattered single-digit losses like
       Parsec**. `analyze-session.mjs` DECIDER: lostpkts/event 130→<10 (proves self-induced) +
       hitches drop. May fix enough on its own; is ALSO the precondition for FEC (FEC can't recover
       a 150-packet blackout — parity is in the same dark window).
       - **BUILT BOTH ENDS + A/B ARMED (2026-07-08) — awaiting the run.** Root cause pinned:
         Parsec on the SAME link doesn't drop → our 130-163-pkt bursts are self-induced = a single
         ~290KB IDR (VBR under a 250ms VBV = maxrate/4) overflows the ~40 Mbps link in one shot.
         - ✅ **WC (`95177e1`, pushed):** capturer `--vbv-ms <ms>` → `NvEncConfig.vbvMs` (Init +
           BWE live-reconfigure both). Precedence: **CLI default 250 (byte-identical) → `--vbv-ms`
           → tune-file `vbv=` / env `VIDEO_CAPTURER_VBV_MS`.** Standalone proof (1440p, gop 120,
           VBR 25/35) max single frame: H.264 291→122KB (**2.4×**), HEVC 223→121KB (**1.85×**);
           frame count identical (360, 3 IDR/357 P) = no structural change, valid Annex-B.
         - ✅ **Mac (`capturerArgs.ts`):** `--vbv-ms` in the CLI contract + `NVENC_VBV_MS = 250`.
           **Default stays 250 — the unvalidated 33 is NOT baked into a build** (golden rule #1);
           the A/B runs on the CURRENT build (agent TS doesn't pass `--vbv-ms` yet → capturer's 250
           default) via the tune-file, no rebuild. Flip after the analyzer validates → prerelease.
           Unit-tested + typecheck clean.
         - 🎯 **THE A/B (owner, no reinstall):** add `vbv=33` to `%LOCALAPPDATA%\pr-capturer-tune.txt`
           → reconnect → same HEVC stress video (`VIDEO_CAPTURER=1 VIDEO_CODEC=hevc`, LTR OFF) → Mac
           `node scripts/analyze-session.mjs`. Remove line = back to 250. **PASS if lostpkts/event
           130-163 → single/low-double digits (scattered = self-induced confirmed) + hitches drop.**
           Stays ~130 → real external contention → Layer 2 FEC. Shrinks → cheap fix closed it (then
           judge if residual needs FEC). Detail: [`docs/step-fec-recovery.md`](docs/step-fec-recovery.md).
         - ❌ **RUN 1 (2026-07-08) CONTAMINATED — LTR was ON, discard.** Analyzer said FREEZING
           (hitch avg 1115ms) but the cause was `VIDEO_LTR=1` still set on the agent, not vbv:
           recovery was BIMODAL & size-uncorrelated (1-pkt loss→1019ms vs 226-pkt loss→51ms = the
           LTR escalation signature, [[ltr-worse-than-idr-on-blackout-loss]]). vbv effect unreadable.
         - 👉 **WC NEXT (clean re-run):** RELAUNCH the agent with NO `VIDEO_LTR` (`ltrEnabled()` reads
           it at launch → a reconnect won't clear it), only `VIDEO_CAPTURER=1 VIDEO_CODEC=hevc`; keep
           `vbv=33` in the tune-file; **grep the sender log for `vbv 33ms`** to confirm the tune took
           (else it says `vbv 250ms`). Owner drives the stress video → Mac re-runs the analyzer.
           Expected LTR-off: every recovery ~50ms → then the vbv burst-shrink read is clean. Full
           recipe + the RUN-1 recovery table in [`docs/step-fec-recovery.md`](docs/step-fec-recovery.md).
         - **RUN-1 root cause (WC, 2026-07-09): `VIDEO_LTR=1` was PERSISTED in the registry
           (`HKCU\Environment`), and the Track-1 self-relaunch scheduled task reads persisted env, so
           a shell `set VIDEO_LTR=` got clobbered on the task handoff** (same class as the HKCU Run-key
           race). Fix = delete the persisted value (User + Machine now empty) → `schtasks /run` fresh.
           [[agent-env-overrides-must-be-persisted]] — applies to EVERY env-toggle (`VIDEO_CAPTURER`,
           `VIDEO_CODEC`, `VIDEO_CAPTURER_*`).
         - ✅ **RUN 2 (LTR OFF) = Layer 1 CONFIRMED (2026-07-09).** vbv is a monotonic lever → loss is
           SELF-INDUCED (frame overflow), not external blackout: vbv 250→33→16 gave burst 130-163 →
           ~90 → **3-46**, loss →1.7→**0.6/min**, verdict FREEZING→**MINOR JUDDER**, recovery ~50ms
           (LTR-off restored fast IDR). At **vbv=16 fps is locked 60 for 97% of seconds**; dips
           (56-57, ~1s) hit ONLY on a loss then snap back.
         - ⭐ **CONFIG OPTION 2 (recorded, owner-requested): `vbv=16 + LTR off`** = near-Parsec, no FEC
           (60@97%, jitter 4ms, loss 0.6/min@~50ms). Ship path = flip `NVENC_VBV_MS` 250→16 +
           LTR-off default → prerelease. Kept as a strong FALLBACK while chasing true-0-dip. **WC
           gating before bake: eyeball vbv=16 motion quality (back off to 24 if blocky) + confirm
           `vbv 16ms` in the sender log.**
         - 👉 **ENDGAME (revised, planned 2026-07-09 — see [`docs/step-fec-recovery.md`](docs/step-fec-recovery.md)
           "THE ENDGAME"):** residual after vbv=16 = 2 loss types → (1) scattered small (FEC/retransmit-
           able now), (2) external blackout bursts (17:47Z 76-80 consec = link dark ~78ms; only fewer-
           packets-in-flight helps). Sequenced: **STEP 2 (cheap) lower HEVC BWE cap 15→~8 Mbps** (Mac-
           only; fewer pkt lost per blackout, Parsec's actual trick) → **STEP 3a (recommended over FEC)
           NACK/RTX retransmit + shallow ~1-frame receive buffer** — RTT is only 11ms so re-send is
           near-free, and the sender ALREADY has `RtcpNackResponder` (`sender/index.ts:233`); missing =
           the receiver actually SENDING NACKs (today it PLI→IDRs every loss) + a small buffer so the
           11ms-late resend lands. First = a SPIKE: does ndc `RtcpReceivingSession` emit NACKs w/ `nack`
           fb? → **STEP 3b app-FEC only if 3a insufficient** (heavier, ndc has no raw-RTP/FEC API).
         - ❌ **STEP 3a SPIKED (2026-07-09) → BLOCKED at the ndc surface.** `dev/spike-nack.mjs` (Mac
           loopback) proved the **SDP negotiates `nack`** (offer+answer, H264+H265) ✅, BUT ndc 0.32.3
           pins **libdatachannel v0.24.2** whose `RtcpReceivingSession` emits only RR+PLI+REMB — it
           tracks seq gaps but **NEVER sends a Generic NACK**, and ndc gives JS no way to send raw RTCP.
           So the sender's `RtcpNackResponder` is dead code (no NACK ever arrives). **Both silent-repair
           endgames (NACK retransmit AND app-FEC) require a NATIVE ndc fork** (patch libdatachannel's
           RtcpReceivingSession to emit NACK on a gap it already tracks + rebuild the addon for
           darwin-arm64 + win32-x64 — golden rule #1, breaks "keep native minimal"). **Fork in the road
           (owner decision):** (A) NOT forking → ship `vbv=16 + LTR off` (opt 2) + STEP 2 lower bitrate =
           MINOR JUDDER/60@97%, done cheap; (B) all-the-way → the libdatachannel NACK-emit patch (most
           contained native option, > app-FEC given RTT 11ms) + a shallow receive buffer. Detail +
           spike in [`docs/step-fec-recovery.md`](docs/step-fec-recovery.md).
         - ✅ **OWNER PICKED (B) — native NACK patch, "ไปให้สุดทาง" (2026-07-09). Full plan:
           [`docs/step-nack-retransmit.md`](docs/step-nack-retransmit.md).** ⭐ KEY SIMPLIFICATION: the
           RECEIVER (needs the NACK-emit patch) runs on the **Mac**; the SENDER (`RtcpNackResponder`,
           retransmits) runs on the **Windows agent** and already works in stock v0.24.2 → **rebuild ndc
           for darwin-arm64 ONLY; the Windows agent binary stays untouched** (halves the work, native
           risk on one platform). Master libdatachannel ALSO doesn't emit NACK (checked) → no upgrade
           shortcut. Phases: A baseline source build on Mac (de-risk toolchain FIRST — cmake+cmake-js+
           OpenSSL; N-API 8 = ABI-stable across node/electron) → B patch `rtcpreceivingsession.cpp` to
           emit Generic NACK on a tracked gap (reorder-tolerant, rate-limited) + rebuild → C Mac-receiver
           shallow ~1-frame buffer + delay PLI ~1 RTT so the ~11ms retransmit lands → D prerelease +
           real-hw verify (golden rule #1). Pair with STEP 2 (lower bitrate) for the blackout losses
           NACK can't beat.
         - ✅ **Phase A + B DONE (2026-07-09).** A: ndc v0.32.3 builds from source on Mac (cmake 4.3.4
           + cmake-js + brew openssl@3 static); self-built `node_datachannel.node` (darwin-arm64, N-API
           8) loads + spike passes. **Install gotcha:** `cp` over a validated signed mach-o →
           `SIGKILL (Code Signature Invalid)` on dlopen → fix = `rm`+`cp`+`codesign --force --sign -`.
           B: the patch (`apps/desktop/native/ndc-nack/rtcpreceivingsession-nack.patch`) adds `pushNACK`
           + a gap-detector in `incoming()` (forward gap 2..64; bigger=blackout→PLI). Compiles clean;
           **`nack-test.cpp` PASS** (emits exactly one Generic NACK for the missing seqs); patched
           binary drop-in (regression spike clean). Artifacts + full build/apply/verify/install recipe:
           [`apps/desktop/native/ndc-nack/README.md`](apps/desktop/native/ndc-nack/README.md). The
           risky unknowns (can we build+patch ndc? does NACK emission work?) are now CLEARED.
         - ✅ **Phase C DONE (2026-07-09)** — `receiver/reorderBuffer.ts` `SeqReorderBuffer` wired into
           `receiver/index.ts` behind **`VIDEO_NACK_BUFFER=1`** (default OFF = byte-identical immediate-
           PLI path). In-order = drain immediately (0 latency); small gap (≤64) HELD 30ms for the
           retransmit → arrives = silent release (no PLI/hitch), else onGap→PLI; blackout gap (>64) =
           skip now→PLI (no penalty). `lossDetector` still measures network loss (analyzer `loss=`);
           `pli=`/`hitch` now = UNRECOVERED loss only. 11 reorder unit tests + typecheck + lint clean.
         - ✅ **Phase D VERIFIED on real hardware (2026-07-09) — NACK retransmit works e2e.** Patched
           darwin ndc installed in the controller (`rm`+`cp`+`codesign`, still installed now; backup at
           `...node_datachannel.node.orig-prebuilt`), launched `VIDEO_NACK_BUFFER=1`, agent unchanged.
           278s HEVC stress → `analyze-session.mjs`: **PLI-per-loss 1.0 → 0.3 (~66% of losses repaired
           SILENTLY, no PLI/hitch)**. Raw pattern = the design exactly: loss ≤64 pkt (4/7/8/17/24/34/37)
           = pli=0 silent; blackout >64 (93/101/106) = pli=1 fallback (~42ms). jitter 1.3ms (↓3.8),
           MINOR JUDDER (only blackout hitches left). The silent-repair endgame is PROVEN.
         - ✅ **NACK ENDGAME DONE + ACCEPTED (owner, 2026-07-09: "เท่านี้ใช้ได้แล้ว").** The flicker at
           `vbv=16/33` (VBR bit-starvation, [[small-vbv-flickers]]) retired the tiny-VBV idea — but the
           key finding: **losses stay small/scattered at the DEFAULT VBV too** (network drops, not
           frame-overflow), so the VBV shrink fixed a non-problem. Re-ran at no-flicker VBV + buffer ON:
           scattered losses (5/7/8 pkt) repaired SILENTLY (`pli=0`); only blackouts >64 (83/131) → PLI
           (~50ms); fps 60 locked, jitter ~5ms. **STEP 2 (lower bitrate) REJECTED** — Parsec runs
           bitrate up to ~60, so we don't trade quality to shrink the rare blackouts (the ~50ms blip
           every ~40-50s is accepted).
         - **FINAL SHIP CONFIG:** stock VBV (default 250 — `capturerArgs.ts` `NVENC_VBV_MS` never changed
           off 250, no code change) + patched darwin ndc (committed `native/ndc-nack/bin/node_datachannel
           .darwin-arm64.node`, **AUTO-reapplied by the desktop `postinstall` → `native/ndc-nack/
           postinstall.mjs` after every `pnpm install`**; darwin-arm64-only, no-ops on Windows, never
           fails install; manual fallback `install.sh`) + `VIDEO_NACK_BUFFER=1` on the controller launch
           + LTR off. Windows agent = stock ndc
           (RtcpNackResponder retransmits, untouched). Signed-.dmg packaging of the patched ndc deferred
           (owner runs the controller from dev). Whole Parsec-parity streaming arc is now COMPLETE.
     - **LAYER 2 (big, only if Layer 1 isn't enough): FEC.** ⚠️ **BLOCKER:** node-datachannel
       exposes NO FEC and no raw-RTP send (Track = `sendMessageBinary`(whole AU) + `requestKeyframe`
       only; ndc packetizes internally). So FEC needs one of: (a) VBV alone suffices; (b) a
       DataChannel-side redundancy scheme on the media pc (least-invasive); (c) extend the ndc
       native binding for FEC/raw-RTP (big C++); (d) own the transport (biggest). Sequence:
       Layer 1 → measure → prototype (b) if needed. Adaptive RS/XOR block FEC design + the full
       feasibility breakdown are in `docs/step-fec-recovery.md`.
0b. **Game-mode keyboard (owner-requested 2026-07-08: "ปุ่มเดินในเกม w,a,s,d กดไม่ไป
   + กดค้าง")** — deferred behind the fps-smoothness work. ROOT CAUSE (found by reading
   code): (1) printable keys (WASD) route to the `t:'text'` Unicode path
   (`ControllerSession.tsx:340`) — `KEYEVENTF_UNICODE` sends a CHARACTER, not a key
   press, so games (DirectInput/scancode/GetAsyncKeyState) never see it, AND the text
   path can't express a HOLD (always instant down+up). (2) `keyToggleWin32`
   (`injectorWin32.ts:120`) sends VK, not `KEYEVENTF_SCANCODE` — many games read
   scancodes. (3) `if(e.repeat) return` (`ControllerSession.tsx:344`) drops held-key
   auto-repeat (Backspace-hold deletes once). FIX = a **Text⇄Game keyboard-mode toggle**
   (Parsec-style, default Text): Game mode routes ALL keys through scancode keydown/keyup
   (holds work, no Unicode → no Thai in-game, fine); Text mode keeps Unicode (Thai) +
   forwards repeat for Backspace-hold; injectorWin32 → scancode-driven. Mac writes it all;
   WC tests with a real game (WASD move/hold, shortcuts, Thai still types in Text mode) via
   a prerelease. CAVEAT: kernel-anticheat games block ALL injected input (unfixable via
   SendInput).
   - **MAC SIDE DONE + shipped as PRERELEASE v1.30.0-beta.1 (2026-07-09, `feat/native-video`)
     — awaiting WC real-game verify (golden rule #1: this is native key-injection FFI).**
     Design: a **Text⇄Game toggle** (button in the in-session floating bar, 🎮 green when
     Game; default Text; persisted per controller in `localStorage['pr-keyboard-mode']`).
     New protocol field **`scan?: boolean` on keydown/keyup** (`inputProtocol.ts`) — absent =
     the byte-identical VK path (normal typing/shortcuts UNCHANGED, zero regression); `true` =
     GAME injection. Implementation:
     - **Controller (`ControllerSession.tsx`):** `keyboardMode` state + `keyboardModeRef`
       (synced via effect so the `[]`-deps key handlers read it live). **Game mode** = every
       key routes through keydown/keyup with `scan:true` and `e.repeat` is SWALLOWED (a hold =
       one keydown; the game reads held state). **Text mode** = unchanged Unicode path for
       printables, PLUS the Backspace-hold fix (non-printable keydown now FORWARDS `e.repeat`
       so hold-to-delete/arrow-repeat works). `held` is now a `Map<code, scanFlag>` so
       panic-release (blur/hide) releases each key the same way it was pressed (no stuck key
       across a mid-hold mode switch).
     - **Injectors — `scan` → `KEYEVENTF_SCANCODE` (wVk=0, real scancode):** `keyToggleWin32`
       (`injectorWin32.ts`) + `injectKey` (`rawInject.ts`) both branch on `scan`; DirectInput/
       RawInput games (which ignore VK-flagged SendInput) now see a real holdable press, and
       Windows still derives the VK from the scancode so GetAsyncKeyState games work too.
       Threaded through all 3 agent injection paths: input-helper (`keyToggle`→win32),
       AgentView IPC (`input.key(code,down,scan)` → preload → `input:key` main → `keyToggle`),
       and the SYSTEM injector (`injectRaw`→`injectKey`).
     - Mac verified: typecheck (node+web) clean, lint clean on all touched files (the only
       remaining lint errors are PRE-EXISTING `react-hooks/refs` in AgentView, untouched).
       Can't unit-test the koffi SendInput path on macOS (that's the golden-rule-#1 handoff).
     - **NEXT (WC, real hardware — install v1.30.0-beta.1 over v1.29.0/v1.28.0):** flip to
       🎮 Game (button in the floating panel) → open a real game →
       (1) WASD MOVE + HOLD works (walk continuously), (2) game shortcuts/space/shift hold,
       (3) switch to ⌨ Text → Thai/English still types + Backspace-hold repeat-deletes,
       (4) no stuck key when Alt-Tabbing out mid-hold. If clean → promote. NB the toggle
       button is in the floating panel (expand the pill to reach it) — a global hotkey to
       flip mode mid-game is an easy follow-up if the owner wants it.
1. Verify file transfer with the agent window actually hidden (works via the
   renderer video pc, which is subject to throttling — needs a real test).
2. Computers-page search/sort; per-controller device visibility (family use).
3. Known limitation: helper crash mid-session recovers input only at re-pair.
4. No TURN relay (only matters for CGNAT↔CGNAT pairs).
5. Mac installer (.dmg) — deferred by owner decision.
6. Owner plans a UI redesign + playful feature additions next.
7. **Native video pipeline** — BUILT + working end-to-end on real hardware on
   branch `feat/native-video` (see Current status); plan at
   [`docs/native-video-plan.md`](docs/native-video-plan.md). Owner chose the
   native route 2026-07-06; the §3a compositing crux was solved 2026-07-07 by
   rendering INSIDE the Electron window (no separate NSWindow). REMAINING TO SHIP:
   (a) bundle `librvr.dylib` + `swiftc` build into the Mac app Resources +
   codesign/notarize; (b) merge `feat/native-video`; (c) PRERELEASE per golden
   rule #1 (default stays WebRTC) and verify on the real agent before a full
   release; (d) optional polish — real decodeMs/renderMs in `stats`,
   keyframe-needed signal from the decode path, Windows NVENC preset/bitrate sweep.
8. **Input elevation (SYSTEM service)** — owner-picked 2026-07-07 after "open
   Task Manager → mouse dies instantly". Root cause: Windows UIPI/integrity — our
   medium-integrity injector can't `SendInput` into high-integrity windows (Task
   Manager, admin apps, UAC, Ctrl+Alt+Del, lock). Mac wrote the scaffold; Windows-
   Claude is building + testing it phase by phase on real hardware. Plan + phasing
   + session-0 correction in
   [`docs/input-elevation-plan.md`](docs/input-elevation-plan.md); code +
   test-order in `apps/desktop/src/input-service/README.md`. Architecture (Parsec
   model, corrected for session-0 isolation): a session-0 LocalSystem **launcher**
   (`service.ts`) spawns via `CreateProcessAsUserW` an **injector-in-session**
   (`index.ts`, SYSTEM/high) that hosts a named pipe, follows the active desktop
   (`syncInputDesktop()`), and raw-`SendInput`s (`rawInject.ts`, mouse+kbd); the
   medium helper forwards over the pipe (`serviceClient.ts`) with local-inject
   fallback. SAFETY BAR: gated behind `PR_INPUT_SERVICE=1`, default build
   byte-identical; both processes wired as electron-vite entries
   (`input-service.js` + `input-injector.js`) but inert unless installed.
   **PROGRESS (real hardware):**
   - ✅ **Phase 0 DONE** — `rawInject` (raw SendInput) verified auto (GetCursorPos
     px-exact, clipboard byte-compare for Thai text, EM_GETFIRSTVISIBLELINE for
     wheel). koffi mouse+kbd struct/signature PROVEN on hardware. `WHEEL_DELTA=120`
     = Windows-standard (no tuning). Bug fixed: `injectKey` evaluated `scanCodeFor`
     before `sendKey`'s `ensureInit` → null `mapVirtualKeyFn` on a process's first
     keydown; fixed by `ensureInit()` at the top of `scanCodeFor` (idempotent).
   - ✅ **Phase 1 DONE** — pipe transport/framing/fallback verified: FrameDecoder
     6/6 (partial/corrupt/malformed), forward helper→pipe→injector px-exact, 240-
     move burst coalesced+split correctly, **fallback seamless (kill injector mid-
     session → local inject, 0 frames dropped)**. koffi-under-plain-node OK.
     Harnesses: `input-service/dev/phase{0,1}-*.ts` + `scripts/phase{0,1}.ps1`.
   - ✅ **Phase 2 spawn primitive DONE (the riskiest FFI)** —
     `spawnInjectorInSession()` implemented + verified in isolation: the token
     dance + `CreateProcessAsUserW` spawns the injector as **SYSTEM-in-session**
     (session 1, high integrity) which hosts the pipe. Chose SYSTEM-in-session
     (retarget the SYSTEM token's `TokenSessionId` to the interactive session)
     over `WTSQueryUserToken` — the latter gives the USER token = medium
     integrity, not enough for Task Manager/UAC. `checkSpawnLayout()` asserts
     every struct size/offset (STARTUPINFOW/PROCESS_INFORMATION/TOKEN_PRIVILEGES)
     against known x64 values BEFORE any pointer is passed (golden-rule-1 guard).
     Harness `dev/phase2-spawn.ts` + `scripts/phase2.ps1`.
   - **BIG SIMPLIFICATION (owner tested 2026-07-07): running the AGENT elevated
     (Run as administrator) ALREADY fixes Task Manager** — the forked input-helper
     inherits the agent's high integrity, so its existing local `SendInput`
     reaches Task Manager + every run-as-admin app. No service needed for that.
     Covers everything EXCEPT the secure desktop (UAC consent / Ctrl+Alt+Del /
     lock), which needs SYSTEM.
   - **DECISION (owner, 2026-07-07):** ship BOTH, layered:
     - **(TRACK 1) auto-elevate the agent — ✅ DONE + VERIFIED on real hardware
       2026-07-07: controlling Task Manager over the remote now works** (the
       owner's original "open Task Manager → mouse dies" bug is fixed). Shipped as
       a **Scheduled Task `PersonalRemoteAgent`** (AtLogOn / LogonType=Interactive
       / RunLevel=Highest → elevated, NO per-launch UAC nag). Commits `a146d1c`
       (task + `scripts/install-agent-autostart.ps1`/uninstall; `main/index.ts`
       drops `elevated-autostart.flag` when it runs elevated and then sets
       `openAtLogin:false` so it never re-adds the medium HKCU Run key — the task
       is the sole autostart) + `ec04135` (the crux). **Key finding: elevation
       only sticks when the TASK launches the agent** — a shortcut click / Windows
       "restart apps" / manual launch = Medium → helper Medium → Task Manager dead.
       Fix in `ec04135`: on startup, BEFORE the single-instance lock, if
       packaged+win32+not-elevated+task-exists → `schtasks /run` + exit, so the
       task relaunches a High instance (30s guard + the elevated instance sees
       itself elevated ⇒ no loop). Two bugs found+fixed while doing it: (1)
       `isElevatedWindows()` via `net session` returns success even from Medium on
       this machine (false "elevated") → handoff never fired; now reads token
       integrity via `whoami /groups` (High = S-1-16-12288). (2) module-scope
       `getPath('userData')` returns `...\Electron` before app-ready → gate on task
       existence + a marker in `getPath('temp')`. input-helper integrity was NEVER
       a problem — `child_process.fork` inherits the parent token, so helper+children
       = High whenever main is High (verified). Only `main/index.ts` changed; built
       via `build-win.sh`; default runtime unaffected. Caveat: dragging a file from
       a medium Explorer ONTO the elevated agent window is UIPI-blocked (receiving
       files from the controller is unaffected).
     - **(TRACK 2) SYSTEM service for the secure desktop — ✅ CODE DONE + PROVEN
       end-to-end on real hardware 2026-07-07: the owner locked the screen (Win+L)
       and controlled input from the Mac.** All STEPs pass: A (Fix A pipe — helper
       HOSTS, SYSTEM injector CONNECTS — the Phase-2 ACL blocker is gone; e2e
       cursor px-exact), B (session-0 launcher as a `schtasks /ru SYSTEM /rl HIGHEST`
       task, not an SCM service → no 1053), C (chain on the normal desktop), D
       (`syncInputDesktop()` follows into `Winlogon` → UAC / Ctrl+Alt+Del / lock
       take input; video stays frozen there = expected, SYSTEM-capture is separate).
       Shipped as **PRERELEASE v1.23.0-beta.1** (golden rule #1) off
       `feat/native-video @ 3a62001` via `build-win.sh` (node-datachannel + koffi
       win32 verified packed, asar off) — gated behind `PR_INPUT_SERVICE=1` + the
       SYSTEM service being installed; default runtime byte-identical. **NOT yet a
       clean-install/reboot-permanent test**: the working setup was a dev rig (dev
       agent + flag + service installed from the repo path). Windows-Claude to make
       it permanent from the installed .exe: (1) install the prerelease over
       v1.22.0; (2) set `PR_INPUT_SERVICE=1` on the Track-1 `PersonalRemoteAgent`
       task's launched process + install the `PersonalRemoteInput` SYSTEM launcher
       pointing `-ScriptPath` at the INSTALLED app's `input-service.js` (not the dev
       repo path); (3) reboot → confirm Task Manager (T1) + lock/UAC (T2) both take
       input with nothing set up by hand. If the SYSTEM service is down the helper
       falls back to local High inject, so Track 1 still works (resilient layers).
       Not yet auto-on for a plain install — enabling it (in-app toggle / default)
       is a separate productization step.
   - **Phase 2 e2e findings (real hardware):** ✅ service→CreateProcessAsUser→
     injector-hosts-pipe auto-spawn works; ✅ full medium→medium chain injects
     px-exact via pipe (forwarded, not fallback). **Two blockers found:**
     1. **Pipe ACL** — a SYSTEM injector hosting a libuv/`net` pipe gets a default
        DACL (SYSTEM+Admins only) → the medium helper is denied ("Access is
        denied", node mangles to ENOENT). Cleanly isolated (medium-injector
        connects, SYSTEM-injector denied). FIX: **A now** (swap roles: helper
        hosts, SYSTEM injector connects — SYSTEM opens any user pipe), **B in
        Phase 4** (injector owns pipe via koffi `CreateNamedPipeW`+SDDL+
        `FIRST_PIPE_INSTANCE` — correct trust model). Residual same-user→SYSTEM
        EoP with A is accepted for a sole-user home tool + documented.
     2. **SCM 1053** — `service.ts` is plain Node with no `StartServiceCtrlDispatcher`,
        so `sc start` times out (1053) and SCM kills it (injector orphaned). FIX:
        run the session-0 launcher as a **Scheduled Task `/ru SYSTEM /rl HIGHEST`**
        instead of an SCM service (no dispatcher needed; still session 0 → still
        uses the working `CreateProcessAsUser` primitive). Do NOT hand-roll the
        dispatcher in koffi (callback-from-native segfault risk).
   - ✅ Phase 3 desktop-follow (UAC/lock via `syncInputDesktop()`) DONE (see Track 2
     above). ⏭ REMAINING: reboot-permanent test from the installed prerelease (the
     3 steps above), then Phase 4 harden (Fix B pipe SDDL + squat guard,
     session-change re-target, injector crash-respawn, uninstall cleanup), then a
     full release once the reboot test signs off.
   - Golden rule #1 throughout: PRERELEASE + real-hardware before any full release.
     Secure-desktop cases land input-only (video stays frozen = separate SYSTEM-
     capture project).
9. **Auto-reconnect resilience** — DONE this session (Mac repo, shared
   `signalingClient.ts`): added a liveness watchdog. Root cause of "agent stayed
   offline until I restarted it after closing the MacBook lid": the client pinged
   every 25s but never checked for a pong and relied only on the WS `close` event,
   which never fires on a HALF-OPEN socket (tunnel host sleeps → no FIN/RST). Now
   force-closes + reconnects (re-resolving the URL) after 65s of silence. Benefits
   agent + controller. Untested on the real half-open path yet — verify by
   sleeping one machine mid-session and confirming auto-recovery without a manual
   restart. Optional follow-up the owner deferred: (ค) auto-fallback input→video
   pc if the input pc never opens.
