# Phase 0-B results — DXGI capture + HW encode, proven **compiler-free** via ffmpeg

Owner-chosen path (no VS Build Tools): use a portable ffmpeg to prove the exact
pipeline — **DXGI Desktop Duplication (`ddagrab`) → Media Foundation / NVENC hardware
encode → decodable H.264/HEVC** — and measure latency, without any MSVC/Windows SDK.

Measured on the real Windows agent, 2026-07-06: **NVIDIA RTX 3060 Ti**, primary
display **2560×1440**, ffmpeg `N-125472` (BtbN gpl). Reproduce: `bench.ps1 -Ff <ffmpeg.exe>`.
(The 160 MB ffmpeg binary is intentionally **not** committed — drop your own in.)

## A) Capture — ✅ DXGI Desktop Duplication works

`ddagrab=output_idx=0:framerate=60` opened DXGI output 0 at **2560×1440, 8-bit RGB**,
delivering GPU (`d3d11`) frames. Native-resolution desktop capture, on the GPU,
outside Chromium — proven.

## B) Encoder throughput (synthetic moving source, max-speed, ~30 Mbps CBR low-latency)

Per-frame = pure encode cost incl. pipeline. **NB:** this feeds a *CPU* source, so
each frame is uploaded to the GPU → this **handicaps NVENC** (the real path C is
zero-copy). Still, everything clears 60 fps with 5–12× headroom:

| encoder | 1080p per-frame | 1080p thru | 1440p per-frame | 1440p thru |
|---|---|---|---|---|
| h264_nvenc | 2.36 ms | 425 fps (7.1×) | 3.55 ms | 281 fps (4.7×) |
| h264_mf    | 1.37 ms | 730 fps (12.2×) | 2.45 ms | 408 fps (6.8×) |
| hevc_nvenc | 1.60 ms | 627 fps (10.5×) | 2.61 ms | 383 fps (6.4×) |
| hevc_mf    | **unavailable on this machine** (MF HEVC encoder not installed) | | | |

→ Encode is **not** a latency bottleneck: ~1.4–3.6 ms/frame, all ≪ the 16.6 ms
frame budget. (The felt-latency win is removing Chromium's capture/render frames,
exactly the plan's thesis.)

## C) Realistic path — ddagrab **GPU capture → encoder**, realtime 1440p60 (the important one)

| path | holds 60 fps? | CPU (utime / 5 s) |
|---|---|---|
| ddagrab → **h264_nvenc** (GPU zero-copy) | ✅ ~60 fps (0.96×) | **0.22 s ≈ 7 % of one core** |
| ddagrab → **hevc_nvenc** (GPU zero-copy) | ✅ ~60 fps | **0.14 s ≈ 4 % of one core** |
| ddagrab → h264_mf (needs `hwdownload` GPU→CPU) | ✅ ~60 fps | **6.5 s ≈ 130 % of one core** |

**Decisive finding:** the all-GPU **ddagrab → NVENC zero-copy** path sustains native
1440p60 at ~5–7 % CPU — the Parsec-style path. Media Foundation forces a per-frame
GPU→CPU `hwdownload` (~130 % CPU, more latency). So the production sender should
**capture on the GPU (DXGI dup) and encode on the GPU (NVENC), zero-copy**; MF is the
vendor-agnostic fallback for non-NVIDIA GPUs.

HEVC via `hevc_nvenc` is even leaner than H.264 → viable for the HEVC / higher-quality
"North Star". `hevc_mf` isn't available here, so the HEVC path is NVENC-only on this box.

## D) Decodable proof — ✅

`ddagrab → h264_nvenc → cap.mp4`, then `ffprobe`: **h264, 2560×1440, 59.5 fps,
26.75 Mbps, 2.0 s** — plays in any player. Full capture→encode→container→decode
verified.

## Known wiring detail (Phase 1, not a blocker)

GPU downscale to 1080p (`scale_d3d11=1920:1080`) errored (`Unsupported pixel format
(null)`) — needs `scale_d3d11=1920:1080:format=nv12`, or just encode native 1440p
(the Parsec target). `scale_cuda` needs `hwmap=derive_device=cuda` first.

---

## Architecture answer — **yes, production can avoid MSVC** (owner's key question)

The whole pipeline above ran with a **prebuilt binary, zero compilation**. That maps
straight onto the project's existing "no-compile, prebuilt native" philosophy (the
input helper uses prebuilt **koffi**; the video helper can use prebuilt **ffmpeg**):

- **Recommended — bundle ffmpeg, drive it as the capture/encode child process.**
  The video helper (separate process, forked like the input helper per plan §2.3)
  spawns ffmpeg: `ddagrab → nvenc/mf → -f h264 pipe:1` (Annex-B elementary stream on
  stdout), and pipes the NAL units into node-datachannel's `H264RtpPacketizer`
  (`LongStartSequence` separator — the exact format Phase 0-A's sender used). **No
  MSVC, no native addon, no Windows SDK.** ffmpeg *is* the "separate process outside
  Chromium" the plan wants. Latency: the ddagrab→nvenc work is the same GPU zero-copy
  we measured; a stdout pipe adds negligible IPC.
  - Cost/caveats: binary size (strip to needed components; an LGPL build with
    nvenc+mf avoids GPL obligations on our app — settle licensing before shipping);
    keyframe-on-demand + dynamic bitrate via ffmpeg stdin commands or re-spawn;
    cursor handling (ddagrab composites the OS cursor — matches `contract.ts`
    `cursor:'composited'` default; `separate` local-cursor is future work).

- **Not recommended — koffi FFI straight to DXGI/MF.** DXGI/D3D11/Media Foundation
  are **COM** (vtables, IUnknown, HRESULTs) — calling that through koffi is
  impractical and fragile, unlike the flat `user32.SendInput` the input helper uses.
  NVENC's API is flat C but still heavy to bind by hand. High effort, low robustness.

- **Not recommended now — native C++ addon (node-gyp/MSVC).** Needs the very
  toolchain the owner wants to avoid; heaviest to build/ship. Keep the ready
  `dxdup_mf_encode.cpp` spike only as a reference / last resort.

**Bottom line for Phase 1:** build the sender as a **forked video helper that drives a
bundled ffmpeg (ddagrab → NVENC zero-copy, MF fallback)** and feeds NALs to the
node-datachannel `H264RtpPacketizer`. Proven end-to-end here, no compiler required.
