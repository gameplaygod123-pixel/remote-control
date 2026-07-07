# Step 3 — Custom DXGI capturer with change-detection

The endgame of the Parsec-parity roadmap
([`streaming-improvements-plan.md`](streaming-improvements-plan.md) Step 3). This
is the ONLY path to Parsec-level GPU (our ffmpeg/ddagrab sits ~38-42% Video-Encode
during active control; Parsec ~6%) and the proper out-of-video cursor. ddagrab
re-encodes on every DXGI-reported change including pointer-only updates, and has no
way to skip them; a capturer we own can.

## Why this is the fix (recap of the ddagrab dead-ends)

- `dup_frames=0` only stops *padding* a static screen to a constant fps — it still
  passes through every frame DXGI reports as changed.
- `draw_mouse=0` (beta.4) removed the cursor from the video but gave ZERO GPU
  benefit: DXGI Desktop Duplication emits a new frame on every pointer-move and
  ddagrab passes it through regardless of `LastPresentTime`. Proven on hardware
  (draw_mouse 0 vs 1 = identical 478-frame count). The problem is structural: **ddagrab
  has no change-detection**; only a custom `AcquireNextFrame` loop that inspects the
  frame metadata can skip unchanged / pointer-only frames.

## Architecture decision — standalone `capturer.exe` subprocess (NOT koffi, NOT a node addon)

The capturer is a **standalone native Windows executable** (C++). It does DXGI
Desktop Duplication + change-detection + NVENC and writes a raw **H.264 Annex-B
elementary stream to stdout** — byte-for-byte the same contract as the ffmpeg
command we run today (`-f h264 pipe:1`, in-band SPS/PPS, 4-byte start codes). The
TS sender spawns it exactly where it spawns ffmpeg and reads stdout unchanged.

Why a subprocess and not in-process FFI:

1. **Crash isolation = golden rule #1.** DXGI COM + the NVENC SDK are exactly the
   "a bad call segfaults natively, JS try/catch can't catch it" hazard the golden
   rule is about. As a subprocess, a fault exits the process with a code — the
   sender's existing ffmpeg crash-recovery (`frameSource.ts`, the beta.2 restart-in-
   place + crash-loop guard) handles it identically to an ffmpeg crash. In-process
   (koffi COM vtable calls or a node addon) a fault takes down the Electron main.
2. **Reuses the proven plumbing.** `FfmpegFrameSource` already spawns a binary,
   splits Annex-B off stdout (`NalSplitter`), assembles access units, packetizes to
   RTP. The capturer drops into that with a near-zero sender change (just which
   binary + argv).
3. **No COM-through-koffi.** DXGI is COM (vtable dispatch, IUnknown refcounts,
   HRESULT). Doing that through koffi is far more error-prone than the flat Win32
   calls we've done (SendInput, GetCursorInfo) and would be in-process. Skip it.
4. **Packaging is the ffmpeg pattern.** Bundle `capturer.exe` under
   `resources/` like `resources/ffmpeg/ffmpeg.exe`; `build-win.sh` stages + verifies
   it; `resolveCapturerPath()` mirrors `resolveFfmpegPath()`.

Trade-off accepted: we own more native code than "just an ffmpeg flag". That's the
cost of the only real fix. Crash-isolation keeps the risk bounded.

## Division of labor

This is **Windows-Claude-led** implementation: the C++ must be compiled (MSVC) and
tested against the real RTX 3060 Ti + a live desktop — Mac-Claude has neither a
Windows toolchain nor the GPU, so Mac cannot compile or run any of it. Mac-Claude
owns: this spec + architecture, the Annex-B output contract (must match ffmpeg's so
the receiver is untouched), the sender-side TS wiring (3c), the Mac cursor overlay
(3d), and review/merge. WC owns: writing/compiling the capturer, the isolation
harnesses, and all real-hardware verification. Every sub-step ships as its own
PRERELEASE and is verified on hardware before promotion (golden rule #1).

## Phasing (each sub-step = its own prerelease)

### 3a — Standalone DXGI capturer + change-detection (isolation harness, NO NVENC yet)

Goal: prove we can capture the desktop via DXGI Desktop Duplication and **skip
unchanged and pointer-only frames**, and read cursor metadata — all standalone,
logging only. No encode, no RTP, no Electron. This de-risks the COM/DXGI half before
touching NVENC.

DXGI sequence (per Microsoft Desktop Duplication API):

1. `D3D11CreateDevice` (hardware, BGRA support flag) → `ID3D11Device` + context.
2. `IDXGIDevice` → `IDXGIAdapter` → enumerate `IDXGIOutput` (pick the target
   monitor, default primary = output 0) → `QueryInterface` `IDXGIOutput1` →
   `DuplicateOutput` → `IDXGIOutputDuplication`.
3. Capture loop:
   - `AcquireNextFrame(timeoutMs, &frameInfo, &desktopResource)`.
   - **`DXGI_ERROR_WAIT_TIMEOUT` → nothing changed → skip** (no emit). This is the
     static-screen idle path — the whole point.
   - On success, inspect `DXGI_OUTDUPL_FRAME_INFO`:
     - `LastPresentTime.QuadPart == 0` → **pointer-only update, screen did NOT
       change → skip the screen frame** (still process the cursor metadata below).
       This is the mouse-moving-on-a-static-screen case ddagrab can't skip.
     - `AccumulatedFrames > 0` / `LastPresentTime != 0` → a real desktop change →
       this is a frame to (eventually) encode.
   - Cursor metadata (always, cheap):
     - `frameInfo.LastMouseUpdateTime != 0` → cursor moved or changed.
     - `frameInfo.PointerPosition` (Position x/y + Visible) → cursor position.
     - `frameInfo.PointerShapeBufferLength > 0` → shape changed → call
       `GetFramePointerShape` to read `DXGI_OUTDUPL_POINTER_SHAPE_INFO` (Type:
       MONOCHROME / COLOR / MASKED_COLOR, HotSpot, dimensions) + the shape bitmap.
       Cache it; feed 3d.
   - `ReleaseFrame()` **immediately** every iteration you acquired (even on skip),
     or the next `AcquireNextFrame` fails.
   - `DXGI_ERROR_ACCESS_LOST` / `DXGI_ERROR_INVALID_CALL` → the duplication was torn
     down (desktop switch, resolution change, a second capturer e.g. Parsec grabbing
     it, secure desktop) → **re-init the whole duplication** (release + rebuild from
     step 2) with a short backoff. This is the SAME event beta.2's ddagrab crash-
     recovery already handles; here we recover in-process without exiting.

Harness output (stderr log, human-readable): per second, print
`emitted=<realChanges> skipped_timeout=<n> skipped_pointeronly=<n>
cursor=(x,y,visible,shapeType)`. Optionally dump the first few changed frames'
`(width,height,rowPitch)` to confirm the surface is sane. NO stdout stream yet.

**3a success criteria (WC, real hardware):**
- Static screen, mouse still → `emitted≈0`, `skipped_timeout` climbing. (ddagrab
  would emit ~60/s here.)
- Static screen, **mouse moving** → `emitted≈0`, `skipped_pointeronly` climbing,
  `cursor=(x,y…)` tracking the move. ← THE decider vs beta.4.
- Play a video / scroll → `emitted` tracks the real change rate.
- Cursor shape changes (hover a text field → I-beam, a link → hand) logged as shape
  changes.
- `ACCESS_LOST` (switch desktops / lock / start Parsec) → logged + auto re-init, no
  crash, resumes when the desktop returns.
- Coexists with Parsec running (the owner's primary monitor — do NOT close Parsec).

Where the code lives: `apps/desktop/native/dxgi-capturer/` (new). A WC-owned build
script (MSVC/cmake) produces `capturer.exe`; a `dev/` harness or a `--selftest` flag
runs the 3a log loop.

#### 3a — implementation status & notes (Windows-Claude, 2026-07-08: DONE, verified)

Built + verified on the real RTX 3060 Ti agent. Code lives in
[`apps/desktop/native/dxgi-capturer/`](../apps/desktop/native/dxgi-capturer/)
(`main.cpp` + `build.ps1` [single-file `cl.exe`] + `CMakeLists.txt`); full build
steps, the exact decider numbers, and the run recipe are in that dir's
[`README.md`](../apps/desktop/native/dxgi-capturer/README.md). All 3a success
criteria above passed:

- static + still → `emitted≈1/s`, `skipped_timeout` dominant.
- static + **mouse moving** → `emitted≈1/s`, `skipped_pointeronly ~60/s`, cursor
  tracking. (the decider vs beta.4.)
- real change (video/scroll) → `emitted` tracks the change rate.
- shape change → logged (desktop arrow `color 32x32` ↔ Notepad I-beam
  `monochrome 32x64`); detected via a content hash, not `Type` alone (arrow and
  I-beam can share `Type`).
- `ACCESS_LOST` → owner's live Win+L (~22s): logged, retried quietly, recovered
  after 87 attempts, resumed — no crash, no spam. Multiple ACCESS_LOST events
  recovered in one run = Parsec coexistence holds.

Notes / spec corrections found while implementing (for 3b onward):
- The frame-info field is **`PointerShapeBufferSize`**, not `PointerShapeBufferLength`
  (the name in the 3a spec above is approximate).
- **ACCESS_LOST retry must be effectively indefinite** with throttled logging — a
  fixed short cap (an early 15s cap) kills the process during a normal-length screen
  lock. It waits for the desktop and recovers on its own (the sender's beta.2 policy).
- Measuring "static screen": any animating on-screen UI (VSCode/this very tool's
  spinner/streaming) drives *real* DXGI presents, so a naive static test reads
  `emitted=10-22/s`. For a true static reading, `Shell.Application.MinimizeAll()`
  first (residual ≈1/s). Mouse-move / shape-change deciders are scriptable via
  P/Invoke `SetCursorPos` + a Notepad hover (no physical mouse needed).
- Toolchain now installed on the agent: VS 2022 Build Tools (VCTools) + Windows SDK
  10.0.26100 (`cl.exe` 14.44). DXGI headers are in the SDK's `shared/`, not `um/`;
  `SetProcessDPIAware` needs `user32.lib`.

### 3b — DXGI → NVENC direct, zero-copy (still standalone, → .h264 file)

Add NVENC (NVIDIA Video Codec SDK). Feed the acquired `ID3D11Texture2D` straight to
NVENC as a registered D3D11 input resource (zero-copy, no CPU download — same
zero-copy property our ffmpeg nvenc path has). Encode ONLY the frames 3a decided are
real changes. Same low-latency config we already tuned and proved on VT: preset P1,
tune ull, no B-frames, `-zerolatency`, VBR ≤40 Mbps target/25 Mbps, VBV ≈ 250ms,
**plain periodic IDR every 2s (NVENC_KEYFRAME_GOP = 120), NO intra-refresh** (Step 1
proved intra-refresh breaks the VideoToolbox receiver —
[[pure-intra-refresh-freezes-videotoolbox]]; must stay out here too). Output raw
Annex-B to a `.h264` file for offline inspection.

Decide the NVENC binding here: the SDK is a C API (`nvEncodeAPI.h`) linked into the
C++ capturer directly — NOT koffi (we're in a standalone .exe now, so just link it).

**3b success (WC):** static screen + mouse moving → NVENC Video-Encode engine near
Parsec's ~6% (vs our ffmpeg's ~40%), because pointer-only frames are never encoded.
The `.h264` decodes cleanly in VLC/ffplay; SPS/PPS in-band before each IDR; IDR every
~2s.

#### 3b — implementation status & notes (Windows-Claude, 2026-07-08: DONE, verified)

Implemented in [`nvenc.{h,cpp}`](../apps/desktop/native/dxgi-capturer/) + a
`--encode <file>` mode on the capturer. `nvEncodeAPI64.dll` (ships with the driver)
loaded at runtime; the header (`nvEncodeAPI.h`, redistributable, FFmpeg/nv-codec-
headers) is auto-fetched by `build.ps1` (gitignored, mirrors build-win.sh's ffmpeg).
Zero-copy = `CopyResource` the still-held desktop `ID3D11Texture2D` into an owned
registered texture (NVENC `NV_ENC_BUFFER_FORMAT_ARGB` == DXGI BGRA byte order) then
encode; no CPU download. Only real-change frames are fed in. Config exactly as spec:
P1 + ULL, VBR 25/40 Mbps, VBV 250ms, `frameIntervalP=1` (no B), `enableIntraRefresh=0`,
`repeatSPSPPS=1`. IDR is driven by **wall clock** (`idrPeriod=INFINITE`, FORCEIDR
every 2s) rather than a frame count — because with change-detection the frame rate is
variable, so "120 frames" ≠ 2s. On `ACCESS_LOST` the encoder is torn down before the
device is released and rebuilt against the new device (fresh SPS/PPS + IDR).

Verified (RTX 3060 Ti, 2560×1440, Parsec running):
- **GPU decider (frames actually encoded, 7s):** static + mouse-moving = **13**
  (~2/s, residual + forced IDR) vs active screen = 70; ddagrab would encode ~420 in
  both. The encoder idles through constant mouse movement — the GPU win's root cause.
- Absolute encoder-% vs Parsec's ~6% is muddied by Parsec's concurrent NVENC session
  (nvidia-smi enc% is GPU-aggregate); frames-encoded is the clean proof. Final % is
  best read in 3c real-use (or with Parsec briefly closed).
- **Decodes cleanly in ffmpeg 8.1** (0 errors): H.264 High, 2560×1440, yuv420p, I/P
  only (no B-frames), IDR ~every 2s, in-band SPS/PPS.

### 3c — Wire into the sender (replace ffmpeg), full e2e prerelease

`capturer.exe` writes the same Annex-B contract to stdout that ffmpeg does.
Sender-side (TS): a `resolveCapturerPath()` + spawn it instead of ffmpeg when
present/enabled (gate: env or a saved pref, default OFF → falls back to the ffmpeg
path so nothing regresses). The `NalSplitter` / `AccessUnitAssembler` / RTP path and
the whole Mac receiver are UNCHANGED (that's the payoff of matching the contract).
Wall-clock RTP timestamps already handle the now-variable frame interval.

**Split of work:** WC adds the `--output stdout` mode + CLI arg parsing to
`capturer.exe` (against the contract below) and delivers the built binary to Mac's
packaging (see "Binary delivery"). Mac writes the TS `CapturerFrameSource`, the
resolver, the gate, and the electron-builder / build-win.sh packaging + verify.

#### 3c CLI contract (Mac owns this; WC implements it in capturer.exe)

```
capturer.exe [options]
  --output stdout | <path.h264>   default: stdout. A path => write to file (3b/testing).
  --monitor <idx>                 DXGI output index. default: 0 (primary).
  --fps <n>                       framerate CAP (change-detection => variable ≤ cap). default: 60.
  --bitrate <kbps>                NVENC VBR target average. default: 25000.
  --maxrate <kbps>                NVENC VBR hard cap (-maxrate). default: 40000.
  --gop <frames>                  IDR interval. default: 120 (≈2s@60). NO intra-refresh, EVER.
  --selftest                      3a change-detection log loop only (no encode).
```

Behavioural contract (must match what the receiver already expects from ffmpeg):
- **stdout** = raw H.264 **Annex-B** elementary stream, 4-byte start codes
  (`LongStartSequence`), **in-band SPS/PPS before every IDR**, **flushed per frame**
  (no muxer buffering — low latency). Byte-identical role to ffmpeg `-f h264 pipe:1`.
- First emitted frame is an **IDR**. Periodic IDR every `--gop` frames. I/P only, no B.
- **stderr** = human log lines prefixed `[capturer] ...` (the sender's `onLog`
  captures them; keep the per-second `emitted/skipped_*` counters there too).
- **Exit codes:** 0 = clean shutdown (stdin closed / EOF). Non-zero = fatal → the
  sender's existing crash-recovery respawns it (same as an ffmpeg fatal). **`ACCESS_LOST`
  must recover IN-PROCESS (no exit)** — it's expected (desktop switch / lock / Parsec),
  not a fatal; emit a fresh IDR after rebuild.
- **stdin control channel (forced IDR on demand):** when the sender receives an RTCP
  PLI it writes a single byte **`'I'`** (0x49) to the capturer's stdin → the capturer
  emits an IDR at the next frame. This is the cheap forced-IDR-without-respawn that
  makes PLI recovery instant (the "flat-bitrate endgame" the ffmpeg path couldn't do —
  ffmpeg had to respawn). A closed stdin = shutdown signal → exit 0. If unimplemented
  at first, the periodic `--gop` IDR still bounds recovery to ≤2s; wire it when ready.

#### Binary delivery (how the WC-built .exe reaches Mac's packaging)

Mac runs `build-win.sh` (darwin host, cross-packages win32) but can't compile
`capturer.exe`. So WC delivers the built binary to a committed path
**`apps/desktop/native/dxgi-capturer/bin/capturer.exe`** (un-ignore JUST that file;
source `third_party/` + intermediate build output stay ignored). Then, mirroring the
ffmpeg bundling: `electron-builder.yml` `win.extraResources` packs it to
`resources/capturer/capturer.exe`, `resolveCapturerPath()` looks there, and
`build-win.sh` asserts it's a PE + packed (like the ffmpeg strings-verify). Rebuild
the exe only when the capturer source changes (re-commit the binary). Small single
exe, one agent — the binary-in-git cost is acceptable (same spirit as bundling
ffmpeg, just self-built instead of downloaded).

**3c success (WC, Parsec left open):** control 10+ min → GPU Video-Encode during
active control near Parsec, video smooth, coexists with Parsec (ACCESS_LOST recovers
in place), no freeze/stuck-keys. HUD fps tracks real change rate (idle low, active
high). → prerelease, then promote.

### 3d — Cursor from DXGI (the proper out-of-video cursor)

The screen no longer contains the cursor (we skip pointer-only frames + can encode
with the cursor excluded), so draw it on the Mac. The capturer already has the
cursor from 3a's `PointerPosition` + `GetFramePointerShape`. Emit it out-of-band
(a small side channel from capturer.exe, e.g. a second pipe / stderr-framed
messages, → the sender → the existing **`'cursor'` data channel**, un-gate
`PR_CURSOR_OVERLAY`) → the Mac draws it: reuse beta.4's CSS-cursor overlay for
standard shapes (map DXGI shape → CSS keyword), and OPTIONALLY the real bitmap for
custom app cursors (only if worth it; the CSS path is the safe default). Position
comes from the Mac's own mouse (it's the input source) for 0-latency, or from
`PointerPosition` — pick the Mac-local one (instant).

**3d success:** cursor shows the correct native shape (I-beam/hand/resize), moves
with 0 latency, no double-cursor artifact, and the encoder truly idles on a static
screen with the mouse moving (the cursor is no longer in the video at all).

## Guardrails carried from earlier findings

- **No intra-refresh** anywhere on this pipeline (VideoToolbox can't decode it).
- **Do NOT close or modify Parsec** — it's the owner's primary monitor; coexistence
  (two DXGI duplications) must be proven, not sidestepped.
- Every sub-step: PRERELEASE + real-hardware verify before promotion (golden rule #1).
- Keep the ffmpeg path as the fallback until 3c is proven, then keep it as the
  non-NVIDIA / capturer-missing fallback (mirrors WebRTC-under-native).
