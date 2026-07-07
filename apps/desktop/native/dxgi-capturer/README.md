# dxgi-capturer — Step 3 custom DXGI capturer

Standalone Windows C++ subprocess that replaces ffmpeg `ddagrab` in the native
video sender. It does DXGI Desktop Duplication with **change-detection** —
the thing ddagrab structurally cannot do (see
[`docs/streaming-improvements-plan.md`](../../../../docs/streaming-improvements-plan.md)
Step 3 and [`docs/step3-dxgi-capturer.md`](../../../../docs/step3-dxgi-capturer.md)).

**Architecture (decided, do not change without discussion):** a standalone
`capturer.exe` subprocess that will eventually emit Annex-B H.264 on stdout exactly
like ffmpeg (drop-in; the Mac receiver is untouched). **NOT** koffi-COM, **NOT** a
node addon — for crash isolation (golden rule #1). A bad DXGI/NVENC call crashes
this process, which the sender host respawns, instead of taking down Electron.

## Status

- **3a — change-detection harness (DONE).** Acquire/classify loop + cursor
  metadata + per-second logging. Verified on the real RTX 3060 Ti agent.
- **3b — DXGI→NVENC zero-copy → .h264 file (DONE).** `nvenc.{h,cpp}`. Encodes ONLY
  real-change frames, zero-copy from the D3D11 texture. Verified (see 3b results).
- **3c — full CLI contract + stdout stream + stdin control (DONE, capturer side).**
  Annex-B → stdout (binary, flushed per frame), stdin `'I'`→IDR, EOF→exit 0, all logs
  to stderr. Matches `capturerArgs.ts`. Mac owns the sender wiring (`CapturerFrameSource`)
  + prerelease build. Built binary published to `bin/capturer.exe` for packaging.
- **3d — cursor from DXGI** `PointerShape` over the existing 'cursor' channel.

## Build

Needs MSVC (VS 2022 Build Tools, VCTools workload) + Windows 10/11 SDK. Install once:

```
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override \
  "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Then either:

```powershell
./build.ps1                 # single-file cl.exe build -> capturer.exe
```
or CMake:
```
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release   # -> build/Release/capturer.exe
```

## Run

Production (what the sender spawns — see `capturerArgs.ts`):

```
capturer.exe --output stdout --monitor 0 --fps 60 --bitrate 25000 --maxrate 40000 --gop 120
```

- **stdout** = raw H.264 Annex-B (4-byte start codes, in-band SPS/PPS before every
  IDR, flushed per frame) — byte-identical to `ffmpeg -f h264 pipe:1`. First frame = IDR.
- **stdin** = one byte `'I'` (0x49) → force an IDR next frame (cheap PLI recovery, no
  respawn). Closed stdin / EOF → clean shutdown (exit 0).
- **stderr** = `[capturer] ...` log lines incl. the per-second `emitted / skipped_timeout
  / skipped_pointeronly / cursor=(x,y,visible,shape)` counters, `cursor-shape` on change,
  `access-lost`/`reinit` on recovery.
- **exit** = 0 clean; non-zero fatal (sender respawns). ACCESS_LOST recovers in-process.

Offline testing: `--output <file.h264>` (write to a file), `--selftest` (3a log loop,
no encode), `--duration <sec>` (stop after N seconds).

- `emitted` — frames where `LastPresentTime != 0` (real desktop change → encoded).
- `skipped_timeout` — `AcquireNextFrame` returned `WAIT_TIMEOUT` (idle, nothing changed).
- `skipped_pointeronly` — `LastPresentTime == 0` (pointer/metadata-only → **not encoded**).

## Decider results (RTX 3060 Ti, 2560×1440, 2026-07-08)

| Scenario | emitted/s | skipped_timeout/s | skipped_pointeronly/s | cursor |
|---|---|---|---|---|
| static screen + static mouse | ~1 | ~3 | 0 | steady |
| **static screen + mouse MOVING** | **~1** | 0 | **~60** | **tracks x,y** |
| screen actively changing | tracks change rate | 0 | 0 | — |

The middle row is the whole point: a mouse-only move on a static screen produces
**~0 screen encodes** while cursor position updates — exactly what ddagrab/beta.4
could not do (beta.4 gave 478 identical frames; this gives ~0). Shape change
(desktop arrow ↔ Notepad I-beam) logs correctly as `color 32x32 hotspot=(0,0)` ↔
`monochrome 32x64 hotspot=(8,9)`.

Mouse-move and shape-change were exercised with synthetic input (`SetCursorPos` +
Notepad hover). `ACCESS_LOST` auto-reinit was verified on the owner's live Win+L
lock (~22s): `[access-lost]` → throttled retry → `[reinit] recovered after 87
attempt(s)` on unlock → resumed — no crash, no spam. Multiple ACCESS_LOST events
recovered in one run (consistent with Parsec grabbing the desktop = coexistence).

## 3b — NVENC encode to .h264 (`nvenc.{h,cpp}`)

```
capturer.exe --encode out.h264 [--duration <sec>] [--output <index>]
```

Only the frames 3a classifies as real changes are fed to NVENC, zero-copy: the
still-held desktop `ID3D11Texture2D` is `CopyResource`'d into an owned registered
texture (no CPU download) then encoded. Config = what we proved on the VideoToolbox
receiver: **H.264 P1 + ultra-low-latency, VBR 25/40 Mbps, VBV 250ms, no B-frames,
wall-clock IDR ~every 2s, NO intra-refresh** (Step 1 proved intra-refresh freezes
the VT decoder), `repeatSPSPPS=1` (in-band SPS/PPS before every IDR). `nvEncodeAPI64.dll`
ships with the driver; the header is auto-fetched by `build.ps1`. On `ACCESS_LOST`
the encoder is torn down and rebuilt against the recreated device (fresh IDR).

### 3b decider results (RTX 3060 Ti, 2560×1440, Parsec running concurrently)

| Scenario | frames NVENC actually encoded (7s) | vs ddagrab (60fps) |
|---|---|---|
| **static screen + mouse MOVING** | **13** (~2/s: residual + forced IDR) | ~420 |
| active screen | 70 (~10/s, tracks real change) | ~420 |

The encoder stays idle through constant mouse movement (`skipped_pointeronly ~60/s`,
frames ≈ residual only) — the root cause of the GPU win. ddagrab re-encodes ~420
frames in *both* cases. Absolute encoder-% vs Parsec's ~6% is muddied here by
Parsec's own concurrent NVENC session; frames-encoded is the clean metric and the
final % is best read in 3c real-use. Both `.h264` outputs **decode cleanly in
ffmpeg 8.1** (0 errors): H.264 High, 2560×1440, yuv420p, I/P only (no B), IDR ~2s.
