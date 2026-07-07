// dxgi-capturer — custom DXGI Desktop Duplication capturer (Step 3).
//
// Standalone C++ .exe that replaces ffmpeg/ddagrab in the native video sender. It
// does DXGI Desktop Duplication with change-detection (skips unchanged AND
// pointer-only frames — the case ddagrab can't skip), NVENC-encodes ONLY the real
// changes zero-copy, and writes raw H.264 Annex-B to stdout exactly like
// `ffmpeg -f h264 pipe:1`. Drop-in for ffmpeg; the Mac receiver is untouched.
// NOT koffi-COM, NOT a node addon — crash isolation (golden rule #1).
//
// CLI + behavioural contract: docs/step3-dxgi-capturer.md "3c CLI contract".
//   stdout = Annex-B (4-byte start codes, in-band SPS/PPS before every IDR, flushed
//            per frame). First frame = IDR. Periodic IDR every --gop frames. I/P only.
//   stdin  = a single byte 'I' (0x49) => force an IDR next frame (cheap PLI recovery,
//            no respawn). Closed stdin / EOF => clean shutdown (exit 0).
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
    bool selftest = false;          // 3a change-detection log loop only (no encode)
    int durationSec = 0;            // 0 = run until stdin EOF / killed (offline testing aid)
};

class DuplCapturer {
public:
    explicit DuplCapturer(const CapturerOptions& o)
        : opt_(o), outputIndex_(o.monitor),
          encoding_(!o.selftest), streamStdout_(o.output == "stdout") {
        gopIntervalSec_ = (o.fps > 0) ? (double)o.gopFrames / o.fps : 2.0;
        minEncodeIntervalSec_ = (o.fps > 0) ? 1.0 / o.fps : 0.0;
    }
    ~DuplCapturer() { Release(); }

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
            Log("encoding -> %s  %dx%d  fps<=%d  VBR %d/%d kbps  gop %d frames (~%.1fs)  no-intra-refresh",
                streamStdout_ ? "stdout" : opt_.output.c_str(), width_, height_, opt_.fps,
                opt_.bitrateKbps, opt_.maxrateKbps, opt_.gopFrames, gopIntervalSec_);
        }

        const auto startT = Clock::now();
        auto intervalStart = startT;
        uint64_t emitted = 0, skippedTimeout = 0, skippedPointerOnly = 0;
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

            DXGI_OUTDUPL_FRAME_INFO fi = {};
            ComPtr<IDXGIResource> desktopResource;
            HRESULT hr = dupl_->AcquireNextFrame(kAcquireTimeoutMs, &fi, &desktopResource);

            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                ++skippedTimeout;
                // PLI on a static screen: no new change is coming, but a recovering
                // receiver needs a fresh keyframe -> re-encode the last frame as IDR.
                if (encoding_ && haveEncodedFrame_ && idrRequested_.exchange(false)) {
                    if (encoder_.EncodeRepeatIdr()) { lastIdr_ = now; lastEncode_ = now; Log("forced IDR (PLI, static screen)"); }
                }
                maybeLog(intervalStart, emitted, skippedTimeout, skippedPointerOnly, cursorX, cursorY, cursorVisible, shapeType);
                continue;
            }
            if (hr == DXGI_ERROR_ACCESS_LOST) { Log("access-lost: duplication lost -> re-init"); recover(); continue; }
            if (FAILED(hr)) { LogHr("AcquireNextFrame", hr); recover(); continue; }

            // ---- acquire succeeded: we HOLD a frame and MUST ReleaseFrame ----
            const bool screenChanged = (fi.LastPresentTime.QuadPart != 0);
            if (screenChanged) {
                ++emitted;
                if (encoding_) {
                    const bool wallIdr = !haveEncodedFrame_ ||
                        std::chrono::duration_cast<std::chrono::milliseconds>(now - lastIdr_).count()
                            >= (long long)(gopIntervalSec_ * 1000);
                    const bool pli = idrRequested_.exchange(false);
                    const bool forceIdr = wallIdr || pli;
                    const bool underCap = haveEncodedFrame_ &&
                        std::chrono::duration_cast<std::chrono::milliseconds>(now - lastEncode_).count()
                            < (long long)(minEncodeIntervalSec_ * 1000);
                    if (forceIdr || !underCap) {  // else: over the fps cap -> coalesce (skip)
                        ComPtr<ID3D11Texture2D> frameTex;
                        if (SUCCEEDED(desktopResource.As(&frameTex))) {
                            if (!encoder_.EncodeFrame(frameTex.Get(), forceIdr)) {
                                Log("encode failed -> recover"); dupl_->ReleaseFrame(); recover(); continue;
                            }
                            lastEncode_ = now;
                            haveEncodedFrame_ = true;
                            if (forceIdr) lastIdr_ = now;
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

            maybeLog(intervalStart, emitted, skippedTimeout, skippedPointerOnly, cursorX, cursorY, cursorVisible, shapeType);
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

    void stdinLoop() {
        HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
        char buf[64]; DWORD n = 0;
        for (;;) {
            BOOL ok = ReadFile(h, buf, sizeof(buf), &n, nullptr);
            if (!ok || n == 0) { shutdownRequested_.store(true); return; }  // EOF / closed pipe
            for (DWORD i = 0; i < n; ++i) if (buf[i] == 'I' || buf[i] == 'i') idrRequested_.store(true);
        }
    }

    void maybeLog(Clock::time_point& intervalStart, uint64_t& emitted, uint64_t& skippedTimeout,
                  uint64_t& skippedPointerOnly, long cursorX, long cursorY, bool cursorVisible, UINT shapeType) {
        auto now = Clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - intervalStart).count() < 1000) return;
        Log("emitted=%llu skipped_timeout=%llu skipped_pointeronly=%llu cursor=(%ld,%ld,%s,%s)",
            (unsigned long long)emitted, (unsigned long long)skippedTimeout, (unsigned long long)skippedPointerOnly,
            cursorX, cursorY, cursorVisible ? "visible" : "hidden", PtrTypeName(shapeType));
        emitted = skippedTimeout = skippedPointerOnly = 0;
        intervalStart = now;
    }

    bool setupEncoder() {
        encoder_.Shutdown();
        NvEncConfig cfg;
        cfg.width = width_; cfg.height = height_;
        cfg.fps = opt_.fps; cfg.targetKbps = opt_.bitrateKbps; cfg.maxKbps = opt_.maxrateKbps;
        cfg.vbvMs = 250; cfg.idrIntervalSec = gopIntervalSec_;
        haveEncodedFrame_ = false;  // first frame after (re)init = IDR
        if (!encoder_.Init(device_.Get(), context_.Get(), cfg, encFile_)) { Log("fatal: NVENC init failed"); return false; }
        return true;
    }

    void recover() {
        if (encoding_) encoder_.Shutdown();
        ReinitWithRetry();
        if (encoding_) setupEncoder();
    }

    bool Init(bool quiet) {
        Release();
        auto fail = [&](const char* w, HRESULT h) { if (!quiet) LogHr(w, h); return false; };

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
    Clock::time_point lastIdr_{}, lastEncode_{};
    bool haveEncodedFrame_ = false;
    double gopIntervalSec_ = 2.0;
    double minEncodeIntervalSec_ = 0.0;

    // control channel (set from the stdin thread)
    std::atomic<bool> idrRequested_{false};
    std::atomic<bool> shutdownRequested_{false};
};

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
        else if (a == "--duration") next(o.durationSec);
        else if (a == "--help" || a == "-h") {
            printf("dxgi-capturer (Step 3 custom DXGI capturer)\n"
                   "  --output stdout|<path>   H.264 Annex-B to stdout (default) or a file\n"
                   "  --monitor <idx>          DXGI output index (default 0)\n"
                   "  --fps <n>                framerate cap (default 60)\n"
                   "  --bitrate <kbps>         NVENC VBR target (default 25000)\n"
                   "  --maxrate <kbps>         NVENC VBR cap (default 40000)\n"
                   "  --gop <frames>           IDR interval (~2s@60, default 120; NO intra-refresh)\n"
                   "  --selftest               3a change-detection log loop only (no encode)\n"
                   "  --duration <sec>         stop after N seconds (offline testing)\n"
                   "  stdin: byte 'I' -> force IDR; EOF -> clean shutdown\n");
            return 0;
        } else Log("ignoring unknown arg: %s", a.c_str());
    }

    SetProcessDPIAware();  // physical pixels for width/height + cursor coords
    Log("start: monitor=%u output=%s fps=%d %s", o.monitor, o.output.c_str(), o.fps,
        o.selftest ? "(selftest, no encode)" : "");

    DuplCapturer cap(o);
    return cap.Run();
}
