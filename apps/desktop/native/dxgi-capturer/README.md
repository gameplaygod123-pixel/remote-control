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

- **3a — isolation harness (DONE, this dir).** Acquire/classify loop + cursor
  metadata + per-second logging. No NVENC, no output. Verified on the real
  RTX 3060 Ti agent (see "Decider results" below).
- **3b — DXGI→NVENC zero-copy → .h264 file.** Next. `-g 120`, no intra-refresh.
- **3c — wire into the sender** replacing ddagrab (RTP path unchanged).
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

## Run (3a harness)

```
capturer.exe --selftest [--duration <sec>] [--output <index>]
```

Logs once per second (per-second interval counts):

```
emitted=<n> skipped_timeout=<n> skipped_pointeronly=<n> cursor=(x,y,visible,shapeType)
[cursor-shape] type=<name>(<n>) WxH hotspot=(x,y) bytes=<n>   # on each shape change
[access-lost] duplication lost -> re-init                     # on desktop switch/lock/Parsec grab
```

- `emitted` — frames where `LastPresentTime != 0` (real desktop change → would encode).
- `skipped_timeout` — `AcquireNextFrame` returned `WAIT_TIMEOUT` (idle, nothing changed).
- `skipped_pointeronly` — `LastPresentTime == 0` (pointer/metadata-only → **skip the encode**).

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
