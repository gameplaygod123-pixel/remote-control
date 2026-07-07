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
- **GPU efficiency vs Parsec — dup_frames=0 (PENDING Windows standalone verify,
  staged in `ffmpegArgs.ts` @ `cc4e381`, NOT built):** Task Manager showed our
  ffmpeg at **45.7% Video-Encode engine** vs Parsec 6.1% (same tool). Cause: we run
  `ddagrab=...:framerate=60` with default dup_frames=1, so NVENC re-encodes the
  STATIC screen 60×/s. Fix = **`dup_frames=0`** (emit only on actual desktop change;
  framerate becomes a cap) — Parsec's trick; our RTP path already uses wall-clock TS
  for this variable interval (phase1/NOTES #64). RISK: our cursor is COMPOSITED into
  the video (not sent separately like Parsec), so a cursor-only move must still
  count as a "change" or the cursor freezes on a static screen. **GATE before
  building beta.3: Windows-Claude runs standalone ffmpeg dup_frames=0 → confirm (a)
  option accepted, (b) Video-Encode engine drops toward ~6%, (c) CURSOR stays smooth
  when only the mouse moves over a still screen.** If cursor freezes, need a
  different approach (separate cursor = big, or a min-fps floor).
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

Latest release: **v1.24.0** — **native video pipeline (lower latency than
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
