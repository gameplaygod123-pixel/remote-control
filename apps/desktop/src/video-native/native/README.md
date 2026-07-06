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

## ⛔ Phase 0 BLOCKER: no native build toolchain on this machine

DXGI + D3D11 + Media Foundation require compiling native C++ against the Windows SDK.
Probed 2026-07-06 — **none present**:

- ❌ MSVC `cl.exe` — not on PATH, not in Program Files
- ❌ Visual Studio / Build Tools — `vswhere` absent, no install dirs
- ❌ Windows 10/11 SDK — no `Include` dir, no `dxgi.h` / `mfapi.h` anywhere on C:
- ❌ clang, ❌ ffmpeg/ffprobe
- ✅ `dotnet` present · ✅ `winget` present · ⚠️ only the Python Store stub

(Consistent with the app never needing a compiler: `koffi` and `node-datachannel`
ship prebuilt binaries — see repo CLAUDE.md golden rule #3.)

**To unblock, one of:**
1. **Install VS Build Tools + Windows SDK** (the real path). Multi-GB, machine-
   modifying → needs owner OK. `winget install Microsoft.VisualStudio.2022.BuildTools`
   with the "Desktop development with C++" workload (MSVC + Windows 11 SDK).
   Then `dxdup_mf_encode.cpp` compiles via `build.bat`.
2. **Portable ffmpeg** (no install/admin) as a *compiler-free* pipeline proof:
   `ffmpeg -f lavfi -i ddagrab=... -c:v h264_mf ...` exercises the SAME DXGI
   Desktop Duplication + Media Foundation HW encode and yields capture+encode
   latency on this exact GPU. Proves feasibility; does not prove our in-process
   wiring (that's Phase 1 regardless).

`dxdup_mf_encode.cpp` in this folder is the real spike source, written and ready —
but **NOT YET COMPILED OR RUN** (no toolchain). Golden rule #1: it is unverified
native code and must be built + run on this real machine before any trust/release.
