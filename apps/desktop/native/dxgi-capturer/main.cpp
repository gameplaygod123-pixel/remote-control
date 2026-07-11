// dxgi-capturer — custom DXGI Desktop Duplication capturer (Step 3).
//
// Standalone C++ .exe that replaces ffmpeg/ddagrab in the native video sender. It
// does DXGI Desktop Duplication with change-detection, NVENC-encodes zero-copy, and writes
// raw H.264 Annex-B to stdout exactly like `ffmpeg -f h264 pipe:1`. Drop-in for ffmpeg; the
// Mac receiver is untouched.
//
// CADENCE (default, Parsec-parity): a LOCKED 1/fps emit clock — exactly one frame every 16.66ms
// (@60). Real P/IDR when the desktop changed during the tick, else a near-free coded-SKIP frame
// (NV_ENC_PIC_TYPE_SKIPPED: no motion estimation, ~1-2% GPU, a few bytes). The receiver sees a
// steady 60fps regardless of content rate — fixing the 41-60fps jitter (=judder) of the old
// emit-on-change path. `--legacy-emit` reverts to the change-triggered path (still skips
// unchanged/pointer-only frames — the case ddagrab can't skip — but at a variable rate).
// NOT koffi-COM, NOT a node addon — crash isolation (golden rule #1).
//
// CLI + behavioural contract: docs/step3-dxgi-capturer.md "3c CLI contract".
//   stdout = Annex-B (4-byte start codes, in-band SPS/PPS before every IDR, flushed
//            per frame). First frame = IDR. Periodic IDR every --gop frames. I/P only.
//   stdin  = 'I' (0x49) => force an IDR next frame (cheap PLI recovery, no respawn);
//            'L' (0x4C) => LTR-P recovery: a small P referencing an older long-term
//            reference (needs --ltr; falls back to IDR if no LTR marked yet);
//            'B'<ascii-kbps>'\n' (e.g. "B25000\n") => set the live VBR bitrate (BWE
//            feedback, no respawn/IDR). Closed stdin / EOF => clean shutdown (exit 0).
//   stderr = "[capturer] ..." log lines incl. the per-second emitted/skipped counters.
//   exit   = 0 clean; non-zero fatal (sender respawns). ACCESS_LOST recovers IN-PROCESS.

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "nvenc.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

// All human output goes to stderr; stdout is reserved for the H.264 stream.
static void Log(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt);
    fprintf(stderr, "[capturer] ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    fflush(stderr);
}
static void LogHr(const char* what, HRESULT hr) { Log("%s failed: 0x%08lX", what, (unsigned long)hr); }

static const char* PtrTypeName(UINT t) {
    switch (t) {
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME:   return "monochrome";
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR:        return "color";
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR: return "masked_color";
        default:                                           return "none";
    }
}

// FNV-1a 64 over the cursor bitmap + dims/type — tells arrow from I-beam from hand
// even when DXGI reports the same Type (kept for 3d).
static uint64_t HashShape(const uint8_t* data, UINT len, const DXGI_OUTDUPL_POINTER_SHAPE_INFO& si) {
    uint64_t h = 1469598103934665603ULL;
    auto mix = [&h](uint64_t v) { h = (h ^ (v & 0xFF)) * 1099511628211ULL; };
    mix(si.Type); mix(si.Width); mix(si.Height); mix(si.HotSpot.x); mix(si.HotSpot.y);
    for (UINT i = 0; i < len; ++i) { h = (h ^ data[i]) * 1099511628211ULL; }
    return h;
}

struct CapturerOptions {
    UINT monitor = 0;
    std::string output = "stdout";  // "stdout" or a file path
    int fps = 60;                   // CAP (change-detection makes the real rate variable)
    int bitrateKbps = 25000;        // NVENC VBR target
    int maxrateKbps = 40000;        // NVENC VBR cap
    int gopFrames = 120;            // IDR interval in frames (~2s@60), NO intra-refresh
    int vbvMs = 250;                // NVENC VBV/HRD buffer in ms (default 250 = maxrate/4). SHRINKING
                                    // this (e.g. ~33 = 2 frames@60) caps how big a single frame/burst
                                    // can get — VBR must spread an IDR/scene-change across more frames
                                    // instead of one 290KB spike that overflows the link (the 130-163
                                    // consecutive-packet loss bursts). --vbv-ms / tune vbv=33 /
                                    // env VIDEO_CAPTURER_VBV_MS. A/B against the loss cascade.
    bool hevc = false;              // false=H.264 (receiver-compatible today), true=H.265/HEVC
                                    // (Parsec uses HEVC — ~2x cheaper NVENC at 1440p; A/B experiment)
    int preset = 1;                 // NVENC preset 1..7 (P1=fastest/lowest encode-ms, default;
                                    // higher = more per-frame encode time + quality). --preset / tune.
    bool ltr = false;               // LTR recovery: on 'L' (PLI) send a small P from an older
                                    // long-term reference instead of a full IDR (Parsec-grade — no
                                    // IDR-burst loss cascade). --ltr / tune ltr=1 / env VIDEO_CAPTURER_LTR.
    int floorFps = 0;               // min-fps FLOOR during activity (0 = off, DEFAULT); duplicates
                                    // the last frame as a cheap P-frame so low-motion (typing)
                                    // has steady cadence, decaying to idle when truly static.
                                    // OFF by default (Mac decision): it costs GPU and is a
                                    // different problem than drop-judder (which BWE fixes). Opt in
                                    // via --floor-fps / tune-file / VIDEO_CAPTURER_FLOOR_FPS.
    int floorDecayMs = 350;         // keep the floor alive this long after the last real change
    bool selftest = false;          // 3a change-detection log loop only (no encode)
    int durationSec = 0;            // 0 = run until stdin EOF / killed (offline testing aid)
    bool desktopFollow = false;     // SECURE-DESKTOP capture (Part 2a): before creating the DXGI
                                    // duplication — and on every ACCESS_LOST recover — attach this
                                    // thread to the ACTIVE input desktop (OpenInputDesktop +
                                    // SetThreadDesktop). Reaching Winlogon (UAC / lock / Ctrl+Alt+Del)
                                    // requires running as SYSTEM-in-session; a normal user just gets
                                    // Default (harmless). --desktop-follow / env
                                    // VIDEO_CAPTURER_DESKTOP_FOLLOW=1. Off = today's behaviour, exact.
    bool lockedCadence = true;      // Parsec-parity: emit EXACTLY one frame every 1/fps (locked
                                    // 60fps cadence) — real P/IDR when the desktop changed this
                                    // tick, else a near-free coded-SKIP frame. Replaces the old
                                    // "emit only on change" (variable 41-60fps -> receiver judder).
                                    // Disable with --legacy-emit / tune legacy=1 to revert to the
                                    // change-triggered path without a rebuild.
    int lockedIdleMs = 350;         // locked-cadence idle decay: keep the 60fps skip cadence only
                                    // while the desktop changed within this window; once static
                                    // longer, stop emitting (idle GPU -> ~0). 0 = never decay
                                    // (Parsec-style always-locked, but ~17-20% enc on a static
                                    // 1440p screen since NVENC coded-skip needs PTD=0 = all-intra).
};

class DuplCapturer {
public:
    explicit DuplCapturer(const CapturerOptions& o)
        : opt_(o), outputIndex_(o.monitor),
          encoding_(!o.selftest), streamStdout_(o.output == "stdout") {
        gopIntervalSec_ = (o.fps > 0) ? (double)o.gopFrames / o.fps : 2.0;
        minEncodeIntervalSec_ = (o.fps > 0) ? 1.0 / o.fps : 0.0;
        floorFps_ = o.floorFps;
        floorIntervalMs_ = (floorFps_ > 0) ? 1000.0 / floorFps_ : 0.0;
        floorDecayMs_ = o.floorDecayMs;
        bitrateMaxRatio_ = (o.bitrateKbps > 0) ? (double)o.maxrateKbps / o.bitrateKbps : 1.6;
        lockedCadence_ = o.lockedCadence;
        lockedIdleMs_ = o.lockedIdleMs;
        desktopFollow_ = o.desktopFollow;
    }
    ~DuplCapturer() { Release(); if (currentDesktop_) { CloseDesktop(currentDesktop_); currentDesktop_ = nullptr; } }

    int Run() {
        if (!InitWithRetry()) { Log("fatal: could not initialize Desktop Duplication"); return 1; }

        if (encoding_) {
            if (streamStdout_) {
                _setmode(_fileno(stdout), _O_BINARY);  // raw bytes, no CRLF translation
                encFile_ = stdout;
            } else {
                encFile_ = fopen(opt_.output.c_str(), "wb");
                if (!encFile_) { Log("fatal: cannot open %s for writing", opt_.output.c_str()); return 3; }
            }
            if (!setupEncoder()) return 4;
            lastEncode_ = Clock::now();
            if (streamStdout_) { std::thread(&DuplCapturer::stdinLoop, this).detach(); }
            std::string floorDesc = floorFps_ > 0
                ? std::to_string(floorFps_) + "fps/" + std::to_string(floorDecayMs_) + "ms" : "off";
            Log("encoding -> %s  %dx%d  fps<=%d  VBR %d/%d kbps  vbv %dms  gop %d frames (~%.1fs)  no-intra-refresh  floor=%s",
                streamStdout_ ? "stdout" : opt_.output.c_str(), width_, height_, opt_.fps,
                opt_.bitrateKbps, opt_.maxrateKbps, (opt_.vbvMs > 0 ? opt_.vbvMs : 250),
                opt_.gopFrames, gopIntervalSec_, floorDesc.c_str());
        }

        // Parsec-parity path: a locked 1/fps emit clock instead of emit-on-change.
        if (lockedCadence_ && encoding_) return lockedLoop();

        const auto startT = Clock::now();
        auto intervalStart = startT;
        uint64_t emitted = 0, skippedTimeout = 0, skippedPointerOnly = 0, floorFrames = 0;
        long cursorX = 0, cursorY = 0;
        bool cursorVisible = false;
        UINT shapeType = 0;
        uint64_t lastShapeHash = 0;
        std::vector<uint8_t> shapeBuf;

        for (;;) {
            if (shutdownRequested_.load()) { Log("stdin closed -> shutdown"); break; }
            const auto now = Clock::now();
            if (opt_.durationSec > 0 &&
                std::chrono::duration_cast<std::chrono::seconds>(now - startT).count() >= opt_.durationSec) break;

            // BWE: apply a pending live bitrate change on THIS (encode) thread — NVENC session
            // calls aren't thread-safe, so the stdin thread only parks the value. maxrate keeps
            // the sender's original target:max ratio. No respawn, no IDR.
            if (encoding_) {
                int pb = pendingBitrateKbps_.exchange(-1);
                if (pb > 0) {
                    int newMax = (int)(pb * bitrateMaxRatio_ + 0.5);
                    encoder_.SetBitrate(pb, newMax);
                }
            }

            // During an activity window the acquire timeout shrinks to the floor interval
            // so we wake in time to emit a duplicate P-frame; truly idle -> 250ms (sleep).
            UINT acquireTimeout = kAcquireTimeoutMs;
            if (encoding_ && floorFps_ > 0 && haveEncodedFrame_ &&
                std::chrono::duration_cast<std::chrono::milliseconds>(now - lastRealChange_).count() < floorDecayMs_) {
                acquireTimeout = (UINT)(floorIntervalMs_ > 1.0 ? floorIntervalMs_ : 1.0);
            }

            DXGI_OUTDUPL_FRAME_INFO fi = {};
            ComPtr<IDXGIResource> desktopResource;
            HRESULT hr = dupl_->AcquireNextFrame(acquireTimeout, &fi, &desktopResource);

            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                ++skippedTimeout;
                if (encoding_ && haveEncodedFrame_) {
                    // PLI on a static screen: no new change is coming, but a recovering
                    // receiver needs a fresh keyframe -> re-encode the last frame as IDR.
                    if (idrRequested_.exchange(false)) {
                        if (encoder_.EncodeRepeatIdr()) { lastIdr_ = now; lastEncode_ = now; Log("forced IDR (PLI, static screen)"); }
                    // LTR-P recovery on a static screen: cheap resync from an older long-term ref
                    // (IDR fallback inside if none marked yet). Mirrors the PLI-IDR path above.
                    } else if (ltrRequested_.exchange(false)) {
                        auto r = encoder_.EncodeLtrRecover();
                        if (r == NvEncoder::LtrResult::IdrFallback) lastIdr_ = now;
                        if (r != NvEncoder::LtrResult::Fail) lastEncode_ = now;
                    // min-fps FLOOR: within the activity window, keep a steady cadence by
                    // duplicating the last frame (cheap skip-MB P-frame). Decays to idle
                    // once the screen is truly static (past floorDecayMs) -> GPU back to ~0.
                    } else if (floorFps_ > 0 &&
                               std::chrono::duration_cast<std::chrono::milliseconds>(now - lastRealChange_).count() < floorDecayMs_ &&
                               std::chrono::duration_cast<std::chrono::milliseconds>(now - lastEncode_).count() >= (long long)floorIntervalMs_) {
                        if (encoder_.EncodeRepeatFrame()) { lastEncode_ = now; ++floorFrames; }
                    }
                }
                maybeLog(intervalStart, emitted, skippedTimeout, skippedPointerOnly, floorFrames, cursorX, cursorY, cursorVisible, shapeType);
                continue;
            }
            if (hr == DXGI_ERROR_ACCESS_LOST) { Log("access-lost: duplication lost -> re-init"); recover(); continue; }
            if (FAILED(hr)) { LogHr("AcquireNextFrame", hr); recover(); continue; }

            // ---- acquire succeeded: we HOLD a frame and MUST ReleaseFrame ----
            const bool screenChanged = (fi.LastPresentTime.QuadPart != 0);
            if (screenChanged) {
                ++emitted;
                lastRealChange_ = now;  // arms the min-fps floor for the next floorDecayMs
                if (encoding_) {
                    const bool wallIdr = !haveEncodedFrame_ ||
                        std::chrono::duration_cast<std::chrono::milliseconds>(now - lastIdr_).count()
                            >= (long long)(gopIntervalSec_ * 1000);
                    const bool pli = idrRequested_.exchange(false);
                    const bool ltr = ltrRequested_.exchange(false);  // 'L' -> LTR-P (not IDR)
                    const bool forceIdr = wallIdr || pli;
                    const bool underCap = haveEncodedFrame_ &&
                        std::chrono::duration_cast<std::chrono::milliseconds>(now - lastEncode_).count()
                            < (long long)(minEncodeIntervalSec_ * 1000);
                    if (forceIdr || ltr || !underCap) {  // else: over the fps cap -> coalesce (skip)
                        ComPtr<ID3D11Texture2D> frameTex;
                        if (SUCCEEDED(desktopResource.As(&frameTex))) {
                            bool encOk;
                            if (ltr && !forceIdr) {
                                // stage the fresh content, then encode it as a P referencing an older
                                // LTR (cheap resync). IDR fallback inside if no LTR marked yet.
                                encoder_.StageFrame(frameTex.Get());
                                auto r = encoder_.EncodeLtrRecover();
                                encOk = (r != NvEncoder::LtrResult::Fail);
                                if (r == NvEncoder::LtrResult::IdrFallback) lastIdr_ = now;
                            } else {
                                encOk = encoder_.EncodeFrame(frameTex.Get(), forceIdr);
                                if (encOk && forceIdr) lastIdr_ = now;
                            }
                            if (!encOk) {
                                Log("encode failed -> recover"); dupl_->ReleaseFrame(); recover(); continue;
                            }
                            lastEncode_ = now;
                            haveEncodedFrame_ = true;
                        }
                    }
                }
            } else {
                ++skippedPointerOnly;  // pointer/metadata-only -> screen NOT encoded
            }

            // cursor metadata (every acquire; position valid when the mouse ts is set)
            if (fi.LastMouseUpdateTime.QuadPart != 0) {
                cursorX = fi.PointerPosition.Position.x;
                cursorY = fi.PointerPosition.Position.y;
                cursorVisible = (fi.PointerPosition.Visible != FALSE);
            }
            if (fi.PointerShapeBufferSize > 0) {  // a new cursor shape is available
                if (shapeBuf.size() < fi.PointerShapeBufferSize) shapeBuf.resize(fi.PointerShapeBufferSize);
                UINT required = 0;
                DXGI_OUTDUPL_POINTER_SHAPE_INFO si = {};
                HRESULT shr = dupl_->GetFramePointerShape(
                    static_cast<UINT>(shapeBuf.size()), shapeBuf.data(), &required, &si);
                if (SUCCEEDED(shr)) {
                    uint64_t h = HashShape(shapeBuf.data(), required ? required : fi.PointerShapeBufferSize, si);
                    if (h != lastShapeHash) {
                        Log("cursor-shape type=%s(%u) %ux%u hotspot=(%d,%d) bytes=%u",
                            PtrTypeName(si.Type), si.Type, si.Width, si.Height,
                            si.HotSpot.x, si.HotSpot.y, fi.PointerShapeBufferSize);
                        lastShapeHash = h;
                    }
                    shapeType = si.Type;
                } else {
                    LogHr("GetFramePointerShape", shr);
                }
            }

            HRESULT rr = dupl_->ReleaseFrame();
            if (FAILED(rr)) { LogHr("ReleaseFrame", rr); recover(); continue; }

            maybeLog(intervalStart, emitted, skippedTimeout, skippedPointerOnly, floorFrames, cursorX, cursorY, cursorVisible, shapeType);
        }

        if (encoding_) {
            encoder_.Shutdown();
            if (encFile_ && encFile_ != stdout) fclose(encFile_);
            encFile_ = nullptr;
            Log("done: %llu frames encoded, %llu bytes",
                (unsigned long long)encoder_.framesEncoded(), (unsigned long long)encoder_.bytesOut());
        }
        return 0;
    }

private:
    static constexpr UINT kAcquireTimeoutMs = 250;  // idle wakes ~4x/s to still log

    // stdin control bytes (from the sender): 'I'/'i' = force IDR next frame (PLI, bare byte);
    // 'L'/'l' = LTR-P recovery (cheap resync from an older long-term ref, no IDR burst);
    // 'B'<ascii-kbps>'\n' = set the live VBR bitrate (BWE feedback). A tiny state machine
    // handles ReadFile chunking: 'B' opens a digit-accumulate mode ended by any non-digit
    // (the '\n'); the terminator is re-scanned so a following 'I'/'L'/'B' still registers.
    void stdinLoop() {
        HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
        char buf[64]; DWORD n = 0;
        std::string num; bool inBitrate = false;
        for (;;) {
            BOOL ok = ReadFile(h, buf, sizeof(buf), &n, nullptr);
            if (!ok || n == 0) { shutdownRequested_.store(true); return; }  // EOF / closed pipe
            for (DWORD i = 0; i < n; ++i) {
                char c = buf[i];
                if (inBitrate && c >= '0' && c <= '9') { if (num.size() < 9) num.push_back(c); continue; }
                if (inBitrate) {  // non-digit terminates the number
                    if (!num.empty()) pendingBitrateKbps_.store(std::atoi(num.c_str()));
                    num.clear(); inBitrate = false;  // fall through to re-scan c as a command
                }
                if (c == 'I' || c == 'i') idrRequested_.store(true);
                else if (c == 'L' || c == 'l') ltrRequested_.store(true);
                else if (c == 'B') { inBitrate = true; num.clear(); }
            }
        }
    }

    void maybeLog(Clock::time_point& intervalStart, uint64_t& emitted, uint64_t& skippedTimeout,
                  uint64_t& skippedPointerOnly, uint64_t& floorFrames, long cursorX, long cursorY,
                  bool cursorVisible, UINT shapeType) {
        auto now = Clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - intervalStart).count() < 1000) return;
        Log("emitted=%llu floor=%llu skipped_timeout=%llu skipped_pointeronly=%llu cursor=(%ld,%ld,%s,%s)",
            (unsigned long long)emitted, (unsigned long long)floorFrames, (unsigned long long)skippedTimeout,
            (unsigned long long)skippedPointerOnly, cursorX, cursorY, cursorVisible ? "visible" : "hidden",
            PtrTypeName(shapeType));
        emitted = skippedTimeout = skippedPointerOnly = floorFrames = 0;
        intervalStart = now;
    }

    void maybeLogLocked(Clock::time_point& intervalStart, uint64_t& sent, uint64_t& real,
                        uint64_t& skip, uint64_t& idr, uint64_t& coalesced, uint64_t& ltr,
                        long cursorX, long cursorY, bool cursorVisible, UINT shapeType) {
        auto now = Clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - intervalStart).count() < 1000) return;
        // emitted = the LOCKED cadence (should read ~fps steady); real/skip = the content split.
        // ltr = LTR-P recovery frames this window (cheap resync); enc_ms = avg per-frame HW encode
        // latency this window (the "Encode" time metric).
        Log("emitted=%llu real=%llu skip=%llu idr=%llu ltr=%llu coalesced=%llu enc_ms=%.1f cursor=(%ld,%ld,%s,%s)",
            (unsigned long long)sent, (unsigned long long)real, (unsigned long long)skip,
            (unsigned long long)idr, (unsigned long long)ltr, (unsigned long long)coalesced,
            encoder_.takeAvgEncodeMs(),
            cursorX, cursorY, cursorVisible ? "visible" : "hidden", PtrTypeName(shapeType));
        sent = real = skip = idr = coalesced = ltr = 0;
        intervalStart = now;
    }

    // Locked-cadence emit loop (Parsec-parity). Keep a steady 1/fps emit clock and emit EXACTLY
    // one frame per tick: an IDR (first frame / wall-clock GOP / PLI), a real P-frame when the
    // desktop changed during the tick window, or a near-free coded-SKIP frame when it didn't.
    // Cadence stays at fps regardless of content rate, so the receiver never sees the 41-60fps
    // jitter the change-triggered path produced. Change-detection still runs — to pick P vs SKIP
    // and to coalesce multiple sub-tick changes down to the latest frame.
    int lockedLoop() {
        using namespace std::chrono;
        const auto tickDur = duration_cast<Clock::duration>(
            duration<double>(minEncodeIntervalSec_ > 0 ? minEncodeIntervalSec_ : 1.0 / 60));
        const auto startT = Clock::now();
        auto nextTick = startT + tickDur;
        auto intervalStart = startT;

        uint64_t sent = 0, realFrames = 0, skipFrames = 0, idrFrames = 0, coalesced = 0, ltrFrames = 0;
        long cursorX = 0, cursorY = 0; bool cursorVisible = false; UINT shapeType = 0;
        uint64_t lastShapeHash = 0; std::vector<uint8_t> shapeBuf;
        bool haveStaged = false;  // a real desktop change is staged in encodeTex_ for this tick

        for (;;) {
            if (shutdownRequested_.load()) { Log("stdin closed -> shutdown"); break; }
            if (opt_.durationSec > 0 &&
                duration_cast<seconds>(Clock::now() - startT).count() >= opt_.durationSec) break;

            // BWE: apply a pending live bitrate change on THIS (encode) thread.
            { int pb = pendingBitrateKbps_.exchange(-1);
              if (pb > 0) { int newMax = (int)(pb * bitrateMaxRatio_ + 0.5); encoder_.SetBitrate(pb, newMax); } }

            // ---- drain desktop changes until the tick, coalescing to the latest frame ----
            long long budgetMs = duration_cast<milliseconds>(nextTick - Clock::now()).count();
            UINT timeout = budgetMs <= 0 ? 0 : (budgetMs > 250 ? 250 : (UINT)budgetMs);
            DXGI_OUTDUPL_FRAME_INFO fi = {};
            ComPtr<IDXGIResource> desktopResource;
            HRESULT hr = dupl_->AcquireNextFrame(timeout, &fi, &desktopResource);

            if (hr == DXGI_ERROR_ACCESS_LOST) {
                Log("access-lost: duplication lost -> re-init");
                recover(); haveStaged = false; nextTick = Clock::now() + tickDur; continue;
            }
            if (hr != DXGI_ERROR_WAIT_TIMEOUT && FAILED(hr)) {
                LogHr("AcquireNextFrame", hr);
                recover(); haveStaged = false; nextTick = Clock::now() + tickDur; continue;
            }
            if (hr != DXGI_ERROR_WAIT_TIMEOUT) {  // we HOLD a frame; must ReleaseFrame
                const auto now = Clock::now();
                if (fi.LastPresentTime.QuadPart != 0) {  // real desktop change
                    ComPtr<ID3D11Texture2D> frameTex;
                    if (SUCCEEDED(desktopResource.As(&frameTex)) && encoder_.StageFrame(frameTex.Get())) {
                        if (haveStaged) ++coalesced;  // an earlier change this tick is superseded
                        haveStaged = true; lastRealChange_ = now;
                    }
                }
                if (fi.LastMouseUpdateTime.QuadPart != 0) {
                    cursorX = fi.PointerPosition.Position.x; cursorY = fi.PointerPosition.Position.y;
                    cursorVisible = (fi.PointerPosition.Visible != FALSE);
                }
                if (fi.PointerShapeBufferSize > 0) {
                    if (shapeBuf.size() < fi.PointerShapeBufferSize) shapeBuf.resize(fi.PointerShapeBufferSize);
                    UINT required = 0; DXGI_OUTDUPL_POINTER_SHAPE_INFO si = {};
                    if (SUCCEEDED(dupl_->GetFramePointerShape((UINT)shapeBuf.size(), shapeBuf.data(), &required, &si))) {
                        uint64_t h = HashShape(shapeBuf.data(), required ? required : fi.PointerShapeBufferSize, si);
                        if (h != lastShapeHash) {
                            Log("cursor-shape type=%s(%u) %ux%u hotspot=(%d,%d) bytes=%u",
                                PtrTypeName(si.Type), si.Type, si.Width, si.Height,
                                si.HotSpot.x, si.HotSpot.y, fi.PointerShapeBufferSize);
                            lastShapeHash = h;
                        }
                        shapeType = si.Type;
                    }
                }
                HRESULT rr = dupl_->ReleaseFrame();
                if (FAILED(rr)) { LogHr("ReleaseFrame", rr); recover(); haveStaged = false; nextTick = Clock::now() + tickDur; continue; }
            }

            if (Clock::now() < nextTick) continue;  // not yet time to emit -> keep draining

            // ---- TICK: emit exactly one frame ----
            const auto tnow = Clock::now();
            const bool firstFrame = !haveEncodedFrame_;
            if (firstFrame && !haveStaged) {  // no reference yet — don't emit P/SKIP; hold cadence
                nextTick += tickDur;
                if (tnow - nextTick > seconds(1)) nextTick = tnow + tickDur;
                maybeLogLocked(intervalStart, sent, realFrames, skipFrames, idrFrames, coalesced, ltrFrames, cursorX, cursorY, cursorVisible, shapeType);
                continue;
            }
            // Idle decay: a coded skip still runs motion estimation (~17-20% enc @1440p60), so
            // emitting 60 skips/s on a STATIC screen wastes GPU for no benefit (nothing is moving
            // to judder). Keep the locked 60 cadence only while recently active — once the desktop
            // has been static past lockedIdleMs, stop emitting (idle GPU -> ~0, like legacy) and
            // just hold the tick clock; the next real change resumes locked 60 within one tick.
            const bool pli = idrRequested_.exchange(false);
            const bool ltr = ltrRequested_.exchange(false);  // 'L' -> LTR-P recovery (not IDR)
            const bool recentlyActive =
                duration_cast<milliseconds>(tnow - lastRealChange_).count() < lockedIdleMs_;
            if (!haveStaged && !recentlyActive && !pli && !ltr) {
                nextTick += tickDur;
                if (tnow - nextTick > seconds(1)) nextTick = tnow + tickDur;
                maybeLogLocked(intervalStart, sent, realFrames, skipFrames, idrFrames, coalesced, ltrFrames, cursorX, cursorY, cursorVisible, shapeType);
                continue;
            }
            const bool wallIdr = firstFrame ||
                duration_cast<milliseconds>(tnow - lastIdr_).count() >= (long long)(gopIntervalSec_ * 1000);
            bool ok = true;
            if (wallIdr || pli) {
                ok = encoder_.EncodeRepeatIdr();  // encode whatever is staged in encodeTex_ as IDR
                if (ok) { lastIdr_ = tnow; ++idrFrames; }
            } else if (ltr) {
                // LTR-P recovery: a small P from an older long-term ref (falls back to IDR if no LTR
                // has been marked yet). Cheap resync — avoids the IDR-burst loss cascade.
                auto r = encoder_.EncodeLtrRecover();
                if (r == NvEncoder::LtrResult::Fail) ok = false;
                else if (r == NvEncoder::LtrResult::IdrFallback) { lastIdr_ = tnow; ++idrFrames; }
                else ++ltrFrames;
            } else if (haveStaged) {
                ok = encoder_.EncodeRepeatFrame();  // staged new content -> real P-frame
                if (ok) ++realFrames;
            } else {
                ok = encoder_.EncodeSkipped();       // gap during an active window -> keepalive skip
                if (ok) ++skipFrames;
            }
            if (!ok) { Log("encode failed -> recover"); recover(); haveStaged = false; nextTick = Clock::now() + tickDur; continue; }
            haveEncodedFrame_ = true; lastEncode_ = tnow; haveStaged = false; ++sent;

            nextTick += tickDur;
            if (Clock::now() - nextTick > seconds(1)) nextTick = Clock::now() + tickDur;  // resync if far behind
            maybeLogLocked(intervalStart, sent, realFrames, skipFrames, idrFrames, coalesced, ltrFrames, cursorX, cursorY, cursorVisible, shapeType);
        }

        encoder_.Shutdown();
        if (encFile_ && encFile_ != stdout) fclose(encFile_);
        encFile_ = nullptr;
        Log("done: %llu frames encoded, %llu bytes",
            (unsigned long long)encoder_.framesEncoded(), (unsigned long long)encoder_.bytesOut());
        return 0;
    }

    bool setupEncoder() {
        encoder_.Shutdown();
        NvEncConfig cfg;
        cfg.width = width_; cfg.height = height_;
        cfg.fps = opt_.fps; cfg.targetKbps = opt_.bitrateKbps; cfg.maxKbps = opt_.maxrateKbps;
        cfg.vbvMs = (opt_.vbvMs > 0) ? opt_.vbvMs : 250; cfg.idrIntervalSec = gopIntervalSec_; cfg.hevc = opt_.hevc;
        cfg.preset = (opt_.preset < 1) ? 1 : (opt_.preset > 7 ? 7 : opt_.preset);  // clamp P1..P7
        cfg.ltr = opt_.ltr;
        haveEncodedFrame_ = false;  // first frame after (re)init = IDR
        if (!encoder_.Init(device_.Get(), context_.Get(), cfg, encFile_)) { Log("fatal: NVENC init failed"); return false; }
        return true;
    }

    void recover() {
        if (encoding_) encoder_.Shutdown();
        ReinitWithRetry();
        if (encoding_) setupEncoder();
    }

    // SECURE-DESKTOP follow (Part 2a): point THIS thread at the desktop currently receiving user
    // input (Default in normal use; Winlogon during UAC / lock / Ctrl+Alt+Del). DXGI Desktop
    // Duplication can only duplicate the desktop the calling thread is attached to, and attaching
    // to Winlogon requires SYSTEM — so this is the crux of "SEE the secure desktop". Must run
    // BEFORE DuplicateOutput and be re-run on every ACCESS_LOST (a secure-desktop switch IS an
    // ACCESS_LOST), which happens for free because Init() runs on each ReinitWithRetry attempt.
    // Returns false (throttled-quiet on retries) so ReinitWithRetry keeps retrying until the
    // target desktop is reachable — mirrors the lock-screen retry policy.
    bool AttachInputDesktop(bool quiet) {
        if (!desktopFollow_) return true;
        HDESK h = OpenInputDesktop(0, FALSE, GENERIC_ALL);
        if (!h) {
            if (!quiet) Log("desktop-follow: OpenInputDesktop failed: %lu (not SYSTEM? secure desktop up?)",
                            (unsigned long)GetLastError());
            return false;
        }
        if (!SetThreadDesktop(h)) {
            if (!quiet) Log("desktop-follow: SetThreadDesktop failed: %lu", (unsigned long)GetLastError());
            CloseDesktop(h);
            return false;
        }
        char name[128] = {0}; DWORD len = 0;
        GetUserObjectInformationA(h, UOI_NAME, name, sizeof(name) - 1, &len);
        if (currentDesktopName_ != name) {
            Log("desktop-follow: input desktop -> '%s'", name[0] ? name : "?");
            currentDesktopName_ = name;
        }
        // The thread now references the new handle; releasing the previous one is safe (only this
        // thread ever attaches a desktop — the stdin thread makes no desktop calls).
        if (currentDesktop_) CloseDesktop(currentDesktop_);
        currentDesktop_ = h;
        return true;
    }

    bool Init(bool quiet) {
        Release();
        auto fail = [&](const char* w, HRESULT h) { if (!quiet) LogHr(w, h); return false; };

        if (!AttachInputDesktop(quiet)) return false;

        D3D_FEATURE_LEVEL fl = {};
        HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                       D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                       D3D11_SDK_VERSION, &device_, &fl, &context_);
        if (FAILED(hr)) return fail("D3D11CreateDevice", hr);

        ComPtr<IDXGIDevice> dxgiDevice;
        hr = device_.As(&dxgiDevice);
        if (FAILED(hr)) return fail("QI IDXGIDevice", hr);
        ComPtr<IDXGIAdapter> adapter;
        hr = dxgiDevice->GetAdapter(&adapter);
        if (FAILED(hr)) return fail("GetAdapter", hr);

        ComPtr<IDXGIOutput> output;
        hr = adapter->EnumOutputs(outputIndex_, &output);
        if (FAILED(hr)) return fail("EnumOutputs", hr);
        DXGI_OUTPUT_DESC desc = {};
        output->GetDesc(&desc);
        width_ = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
        height_ = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;

        ComPtr<IDXGIOutput1> output1;
        hr = output.As(&output1);
        if (FAILED(hr)) return fail("QI IDXGIOutput1", hr);
        hr = output1->DuplicateOutput(device_.Get(), &dupl_);
        if (FAILED(hr)) return fail("DuplicateOutput", hr);

        Log("init: output=%u  %dx%d  (duplication ready)", outputIndex_, width_, height_);
        return true;
    }

    bool InitWithRetry() { return ReinitWithRetry(); }

    // On ACCESS_LOST DuplicateOutput keeps failing until the normal desktop returns
    // (screen lock / desktop switch / Parsec). Retry indefinitely, throttled logging,
    // so a long lock never crashes us — recovers on its own (mirrors beta.2 policy).
    bool ReinitWithRetry() {
        for (int attempt = 0; ; ++attempt) {
            if (Init(/*quiet=*/attempt > 0)) {
                if (attempt > 0) Log("reinit: recovered after %d attempt(s)", attempt);
                return true;
            }
            if (attempt == 0 || (attempt % 20) == 0)
                Log("reinit: duplication unavailable (attempt %d) — retrying (locked / desktop switch?)", attempt + 1);
            Sleep(250);
        }
    }

    void Release() {
        dupl_.Reset();
        context_.Reset();
        device_.Reset();
    }

    CapturerOptions opt_;
    UINT outputIndex_;
    int width_ = 0, height_ = 0;
    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGIOutputDuplication> dupl_;

    // encode state
    bool encoding_ = false;
    bool streamStdout_ = false;
    FILE* encFile_ = nullptr;
    NvEncoder encoder_;
    Clock::time_point lastIdr_{}, lastEncode_{}, lastRealChange_{};
    bool haveEncodedFrame_ = false;
    double gopIntervalSec_ = 2.0;
    double minEncodeIntervalSec_ = 0.0;
    int floorFps_ = 0;               // min-fps floor during activity (0 = off)
    double floorIntervalMs_ = 0.0;   // 1000/floorFps
    long floorDecayMs_ = 0;          // floor stays alive this long after the last real change
    bool lockedCadence_ = true;      // locked 1/fps emit clock (Parsec-parity) vs emit-on-change
    long lockedIdleMs_ = 350;        // locked-cadence idle decay window (0 = never decay)

    // secure-desktop follow (Part 2a)
    bool desktopFollow_ = false;
    HDESK currentDesktop_ = nullptr;      // the input desktop this thread is attached to (owned)
    std::string currentDesktopName_;      // last-logged desktop name (Default / Winlogon)

    // control channel (set from the stdin thread)
    std::atomic<bool> idrRequested_{false};
    std::atomic<bool> ltrRequested_{false};  // 'L' from stdin -> LTR-P recovery (cheap resync)
    std::atomic<bool> shutdownRequested_{false};
    std::atomic<int>  pendingBitrateKbps_{-1};  // 'B<kbps>' from stdin -> apply on encode thread
    double bitrateMaxRatio_ = 1.6;              // maxrate/target, preserved across BWE retunes
};

// Live tuning WITHOUT an agent relaunch: if this file exists the capturer reads it at
// every spawn (per session) and its key=value lines override the sender's CLI args.
// Lets us A/B bitrate/codec/floor vs Parsec by editing one file + reconnecting — no
// env (which would need the elevated agent relaunched to inherit) and no rebuild.
// Absent by default => normal behaviour. Path: %LOCALAPPDATA%\pr-capturer-tune.txt.
static void applyTuneFile(CapturerOptions& o) {
    const char* base = std::getenv("LOCALAPPDATA");
    if (!base) base = std::getenv("TEMP");
    if (!base) return;
    std::string path = std::string(base) + "\\pr-capturer-tune.txt";
    FILE* f = fopen(path.c_str(), "r");
    if (!f) return;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char key[128] = {0}, val[128] = {0};
        if (sscanf(line, " %127[^=# \t] = %127[^\r\n \t]", key, val) != 2) continue;
        std::string k = key, v = val;
        if (k == "bitrate") o.bitrateKbps = std::atoi(v.c_str());
        else if (k == "maxrate") o.maxrateKbps = std::atoi(v.c_str());
        else if (k == "fps") o.fps = std::atoi(v.c_str());
        else if (k == "floor-fps") o.floorFps = std::atoi(v.c_str());
        else if (k == "floor-decay") o.floorDecayMs = std::atoi(v.c_str());
        else if (k == "codec") o.hevc = (v == "h265" || v == "hevc" || v == "HEVC");
        else if (k == "preset") o.preset = std::atoi(v.c_str());
        else if (k == "ltr") o.ltr = (v == "1" || v == "true" || v == "on");
        else if (k == "legacy") o.lockedCadence = !(v == "1" || v == "true" || v == "on");
        else if (k == "locked-cadence") o.lockedCadence = (v == "1" || v == "true" || v == "on");
        else if (k == "locked-idle-ms") o.lockedIdleMs = std::atoi(v.c_str());
        else if (k == "vbv") o.vbvMs = std::atoi(v.c_str());
    }
    fclose(f);
    Log("tune-file applied: %s", path.c_str());
}

int main(int argc, char** argv) {
    CapturerOptions o;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](int& out) { if (i + 1 < argc) out = std::atoi(argv[++i]); };
        if (a == "--selftest") o.selftest = true;
        else if (a == "--output" && i + 1 < argc) o.output = argv[++i];
        else if (a == "--monitor" && i + 1 < argc) o.monitor = (UINT)std::atoi(argv[++i]);
        else if (a == "--fps") next(o.fps);
        else if (a == "--bitrate") next(o.bitrateKbps);
        else if (a == "--maxrate") next(o.maxrateKbps);
        else if (a == "--gop") next(o.gopFrames);
        else if (a == "--vbv-ms") next(o.vbvMs);
        else if (a == "--codec" && i + 1 < argc) { std::string c = argv[++i]; o.hevc = (c == "h265" || c == "hevc" || c == "HEVC"); }
        else if (a == "--preset") next(o.preset);
        else if (a == "--ltr") o.ltr = true;  // LTR-P recovery on 'L' (else plain IDR)
        else if (a == "--floor-fps") next(o.floorFps);
        else if (a == "--floor-decay") next(o.floorDecayMs);
        else if (a == "--legacy-emit") o.lockedCadence = false;  // revert to emit-on-change
        else if (a == "--locked-cadence") o.lockedCadence = true;
        else if (a == "--locked-idle-ms") next(o.lockedIdleMs);
        else if (a == "--desktop-follow") o.desktopFollow = true;  // secure-desktop capture (2a)
        else if (a == "--duration") next(o.durationSec);
        else if (a == "--help" || a == "-h") {
            printf("dxgi-capturer (Step 3 custom DXGI capturer)\n"
                   "  --output stdout|<path>   H.264 Annex-B to stdout (default) or a file\n"
                   "  --monitor <idx>          DXGI output index (default 0)\n"
                   "  --fps <n>                framerate cap (default 60)\n"
                   "  --bitrate <kbps>         NVENC VBR target (default 25000)\n"
                   "  --maxrate <kbps>         NVENC VBR cap (default 40000)\n"
                   "  --gop <frames>           IDR interval (~2s@60, default 120; NO intra-refresh)\n"
                   "  --vbv-ms <ms>            NVENC VBV buffer ms (default 250; ~33=2 frames caps burst\n"
                   "                           size to cut the 130+-pkt loss bursts. tune vbv=33 / env\n"
                   "                           VIDEO_CAPTURER_VBV_MS)\n"
                   "  --codec h264|h265        H.264 (default) or H.265/HEVC (Parsec-parity GPU test)\n"
                   "  --preset <1..7>          NVENC preset P1..P7 (default 1=fastest/lowest encode-ms;\n"
                   "                           higher = more per-frame encode time + quality). tune: preset=N\n"
                   "  --ltr                    LTR recovery: on 'L' send a small P from an older long-term\n"
                   "                           reference instead of a full IDR (tune ltr=1 / env VIDEO_CAPTURER_LTR)\n"
                   "  --floor-fps <n>          min-fps floor during activity (default 0=off;\n"
                   "                           env VIDEO_CAPTURER_FLOOR_FPS overrides for live tuning)\n"
                   "  --floor-decay <ms>       floor stays alive this long after a change (default 350)\n"
                   "  --legacy-emit            revert to emit-on-change (default is locked 1/fps cadence;\n"
                   "                           tune legacy=1 / env VIDEO_CAPTURER_LEGACY_EMIT=1 also revert)\n"
                   "  --locked-idle-ms <ms>    locked-cadence idle decay (default 350; 0 = never decay,\n"
                   "                           always-locked but ~17-20%% enc on a static 1440p screen)\n"
                   "  --desktop-follow         SECURE-DESKTOP capture: attach the capture thread to the\n"
                   "                           active input desktop (OpenInputDesktop+SetThreadDesktop) on\n"
                   "                           init + every ACCESS_LOST, so a SYSTEM-in-session capturer sees\n"
                   "                           Winlogon (UAC / lock). env VIDEO_CAPTURER_DESKTOP_FOLLOW=1\n"
                   "  --selftest               3a change-detection log loop only (no encode)\n"
                   "  --duration <sec>         stop after N seconds (offline testing)\n"
                   "  stdin: 'I' -> force IDR;  'L' -> LTR-P recovery;  'B'<kbps>'\\n' -> live VBR bitrate;  EOF -> shutdown\n");
            return 0;
        } else Log("ignoring unknown arg: %s", a.c_str());
    }

    // env overrides for live tuning without a rebuild (the sender forks us with its
    // env, so setx <VAR> + reconnect sweeps it). These WIN over the sender's CLI args
    // (--bitrate/--maxrate/--floor-fps) so we can A/B against Parsec without a Mac build.
    if (const char* fenv = std::getenv("VIDEO_CAPTURER_FLOOR_FPS")) o.floorFps = std::atoi(fenv);
    if (const char* denv = std::getenv("VIDEO_CAPTURER_FLOOR_DECAY_MS")) o.floorDecayMs = std::atoi(denv);
    if (const char* benv = std::getenv("VIDEO_CAPTURER_BITRATE_KBPS")) o.bitrateKbps = std::atoi(benv);
    if (const char* menv = std::getenv("VIDEO_CAPTURER_MAXRATE_KBPS")) o.maxrateKbps = std::atoi(menv);
    if (const char* venv = std::getenv("VIDEO_CAPTURER_VBV_MS")) o.vbvMs = std::atoi(venv);
    if (const char* cenv = std::getenv("VIDEO_CAPTURER_CODEC")) { std::string c = cenv; o.hevc = (c == "h265" || c == "hevc" || c == "HEVC"); }
    // LTR enable is OR across --ltr / VIDEO_CAPTURER_LTR / VIDEO_LTR (never cleared by a falsy env
    // so an explicit --ltr wins). VIDEO_LTR is the SENDER's own gate (index.ts): the agent sets it
    // to make the sender answer PLIs with 'L', and we (forked with its env) auto-arm LTR marking to
    // match — so the joint prerelease needs no extra capturer arg. Mac's buildCapturerArgs is unchanged.
    auto truthy = [](const char* s) { std::string v = s ? s : ""; return v == "1" || v == "true" || v == "on"; };
    if (const char* e = std::getenv("VIDEO_CAPTURER_LTR")) o.ltr = o.ltr || truthy(e);
    if (const char* e = std::getenv("VIDEO_LTR"))          o.ltr = o.ltr || truthy(e);
    if (const char* lenv = std::getenv("VIDEO_CAPTURER_LEGACY_EMIT")) { std::string l = lenv; o.lockedCadence = !(l == "1" || l == "true" || l == "on"); }
    if (const char* e = std::getenv("VIDEO_CAPTURER_DESKTOP_FOLLOW")) o.desktopFollow = o.desktopFollow || truthy(e);
    applyTuneFile(o);  // highest priority: a live tune file overrides CLI + env (no relaunch)

    SetProcessDPIAware();  // physical pixels for width/height + cursor coords
    Log("start: monitor=%u output=%s fps=%d %s%s", o.monitor, o.output.c_str(), o.fps,
        o.selftest ? "(selftest, no encode) " : "", o.desktopFollow ? "(desktop-follow)" : "");

    DuplCapturer cap(o);
    return cap.Run();
}
