# video-native/native

Native capture + hardware-encode code for the Windows **sender** half (and, later,
the Mac receiver's decode — that lives on the Mac side). Per the plan
([`docs/native-video-plan.md`](../../../../../docs/native-video-plan.md) §3.5) the
exact "form" of this layer (standalone helper `.exe` vs Node native addon vs koffi
FFI) is **decided in Phase 0**. This README records what Phase 0 found.

## Windows sender pipeline (what this proves)

```
DXGI Output Duplication (IDXGIOutputDuplication)   ← capture the desktop on the GPU
        │  ID3D11Texture2D (BGRA, GPU)
        ▼
Media Foundation H.264 encoder MFT (hardware)      ← low-latency, no B-frames, CBR
   (MF auto-selects the NVENC / QuickSync hardware MFT under the hood)
        │  IMFSample → Annex-B H.264 NAL units
        ▼
(Phase 1) feed NALs into a node-datachannel H264RtpPacketizer video track
```

## Hardware on this agent (probed 2026-07-06) — very favourable

| Component | Result |
|---|---|
| NVIDIA GeForce RTX 3060 Ti — **NVENC** (`nvEncodeAPI64.dll` present) | H.264 **and** HEVC HW encode (Ampere) |
| Intel UHD Graphics 770 — **QuickSync** | HW encode fallback |
| **Media Foundation** (`mfplat.dll` present) | vendor-agnostic HW encode path |
| Parsec Virtual Display Adapter | present (owner runs Parsec; note for DXGI output selection) |

Implication for the plan's open questions (§7): the **MF path is preferred**
(vendor-agnostic, and MF will bind the NVENC hardware MFT here anyway); NVENC-direct
is a possible latency optimisation later. HEVC is viable both ends (this GPU encodes
it; the Mac decodes it) but H.264 stays the safe default per `shared/contract.ts`.

## Phase 0-B outcome: proven **compiler-free** (owner's chosen path)

This machine has **no native build toolchain** (probed 2026-07-06): no MSVC `cl.exe`,
no Visual Studio / Build Tools (`vswhere` absent), no Windows SDK (`dxgi.h`/`mfapi.h`
nowhere), no clang. Consistent with the app never needing a compiler (`koffi` /
`node-datachannel` ship prebuilt — CLAUDE.md golden rule #3).

Rather than install a multi-GB SDK, Phase 0-B was proven with a **portable ffmpeg**
(no install/admin) exercising the *same* OS APIs — `ddagrab` (DXGI Desktop
Duplication) + `h264_mf` (Media Foundation) + `h264_nvenc`/`hevc_nvenc` (NVENC).
**Result: PASS** — 1440p60 GPU capture → NVENC zero-copy at ~7 % CPU, decodable
output. See [`phase0-ffmpeg/RESULTS.md`](phase0-ffmpeg/RESULTS.md) (repro:
`phase0-ffmpeg/bench.ps1`).

**Key architecture finding:** production can avoid MSVC entirely — bundle a prebuilt
ffmpeg and drive it as the forked video helper (`ddagrab → nvenc → -f h264 pipe:1`
Annex-B) feeding node-datachannel's `H264RtpPacketizer`. Details + trade-offs vs
koffi-FFI / native-addon in RESULTS.md.

### `dxdup_mf_encode.cpp` — reference only (NOT compiled/run)

The hand-written DXGI-Duplication + MF-SinkWriter C++ spike is kept as a reference
for a possible future native-addon path, but it was **never compiled or run** (no
toolchain) — golden rule #1: unverified native code, do not trust/ship without
building + running on the real machine. `build.bat` documents how, once a toolchain
exists (`winget install Microsoft.VisualStudio.2022.BuildTools`, C++ workload).
