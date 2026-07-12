@echo off
REM Phase 0-B spike build — requires MSVC + Windows SDK (see native/README.md blocker).
REM This machine did NOT have a toolchain when the spike was written; install first:
REM   winget install Microsoft.VisualStudio.2022.BuildTools
REM   (select the "Desktop development with C++" workload: MSVC + Windows 11 SDK)
REM
REM Then run this from a "x64 Native Tools Command Prompt for VS 2022" (which sets up
REM INCLUDE/LIB), or call vcvars64.bat first:
REM   "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
REM
REM Build:
cl /nologo /EHsc /std:c++17 /O2 dxdup_mf_encode.cpp
REM
REM Run (captures the primary display for ~5 s and writes out.mp4):
REM   dxdup_mf_encode.exe
REM Verify decodability (needs ffprobe, or just open out.mp4 in a player):
REM   ffprobe out.mp4
