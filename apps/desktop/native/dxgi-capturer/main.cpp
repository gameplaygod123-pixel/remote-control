// dxgi-capturer — Step 3a change-detection harness + Step 3b NVENC encode
//
// Standalone C++ .exe that does the DXGI Desktop Duplication change-detection
// ddagrab structurally cannot do (see docs/step3-dxgi-capturer.md). It acquires
// frames, classifies each acquire, reads cursor metadata, logs per-second counters
// (3a), and — with --encode <file> — feeds ONLY the real-change frames to NVENC
// zero-copy and writes Annex-B H.264 to a file (3b). Architecture is locked: a
// standalone subprocess (drop-in for ffmpeg later), NOT koffi-COM and NOT a node
// addon (crash isolation, golden rule #1).
//
// Loop semantics (owner spec):
//   AcquireNextFrame ->
//     DXGI_ERROR_WAIT_TIMEOUT           -> nothing changed              -> skipped_timeout
//     LastPresentTime.QuadPart == 0     -> pointer/metadata-only update -> skipped_pointeronly
//     LastPresentTime.QuadPart != 0     -> real desktop change          -> emitted
//   cursor: PointerPosition (x,y,Visible) valid when LastMouseUpdateTime != 0;
//           PointerShape read via GetFramePointerShape when PointerShapeBufferLength > 0.
//   ReleaseFrame() after every successful acquire (else the next acquire fails).
//   DXGI_ERROR_ACCESS_LOST -> re-init the whole duplication (desktop switch / lock /
//                             Parsec grabbing the desktop) — same event beta.2 recovers.

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "nvenc.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

static const char* PtrTypeName(UINT t) {
    switch (t) {
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME:   return "monochrome";
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR:        return "color";
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR: return "masked_color";
        default:                                           return "none";
    }
}

// FNV-1a 64 over the cursor bitmap + its dimensions/type — a cheap signature so
// we can tell arrow from I-beam from hand even when DXGI reports the same Type.
static uint64_t HashShape(const uint8_t* data, UINT len, const DXGI_OUTDUPL_POINTER_SHAPE_INFO& si) {
    uint64_t h = 1469598103934665603ULL;  // FNV offset basis
    auto mix = [&h](uint64_t v) { h = (h ^ (v & 0xFF)) * 1099511628211ULL; };
    mix(si.Type); mix(si.Width); mix(si.Height); mix(si.HotSpot.x); mix(si.HotSpot.y);
    for (UINT i = 0; i < len; ++i) { h = (h ^ data[i]) * 1099511628211ULL; }
    return h;
}

static void LogHr(const char* what, HRESULT hr) {
    printf("[err] %s failed: 0x%08lX\n", what, (unsigned long)hr);
    fflush(stdout);
}

class DuplCapturer {
public:
    DuplCapturer(UINT outputIndex, std::string encodePath)
        : outputIndex_(outputIndex), encodePath_(std::move(encodePath)),
          encoding_(!encodePath_.empty()) {}
    ~DuplCapturer() { Release(); }

    int Run(int durationSec) {
        if (!InitWithRetry()) {
            printf("[fatal] could not initialize Desktop Duplication\n");
            fflush(stdout);
            return 1;
        }

        if (encoding_) {
            encFile_ = fopen(encodePath_.c_str(), "wb");
            if (!encFile_) { printf("[fatal] cannot open %s for writing\n", encodePath_.c_str()); fflush(stdout); return 3; }
            if (!setupEncoder()) return 4;
            printf("[encode] writing Annex-B H.264 to %s (real-change frames only)\n", encodePath_.c_str());
            fflush(stdout);
        }

        const auto startT = Clock::now();
        auto intervalStart = startT;

        // per-interval counters (reset every log)
        uint64_t emitted = 0, skippedTimeout = 0, skippedPointerOnly = 0;
        // persistent cursor state
        long cursorX = 0, cursorY = 0;
        bool cursorVisible = false;
        UINT shapeType = 0;          // 0 = none seen yet (for the per-second summary)
        uint64_t lastShapeHash = 0;  // content hash to detect arrow->I-beam->hand
        std::vector<uint8_t> shapeBuf;

        for (;;) {
            if (durationSec > 0 &&
                std::chrono::duration_cast<std::chrono::seconds>(Clock::now() - startT).count() >= durationSec) {
                break;
            }

            DXGI_OUTDUPL_FRAME_INFO fi = {};
            ComPtr<IDXGIResource> desktopResource;
            HRESULT hr = dupl_->AcquireNextFrame(kAcquireTimeoutMs, &fi, &desktopResource);

            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                // no update within the timeout window = the idle path
                ++skippedTimeout;
                MaybeLog(intervalStart, emitted, skippedTimeout, skippedPointerOnly,
                         cursorX, cursorY, cursorVisible, shapeType);
                continue;
            }
            if (hr == DXGI_ERROR_ACCESS_LOST) {
                printf("[access-lost] duplication lost -> re-init\n");
                fflush(stdout);
                recover();
                continue;
            }
            if (FAILED(hr)) {
                LogHr("AcquireNextFrame", hr);
                recover();  // treat as recoverable capture loss (mirror beta.2 policy)
                continue;
            }

            // ---- acquire succeeded: we now HOLD a frame and MUST ReleaseFrame ----
            const bool screenChanged = (fi.LastPresentTime.QuadPart != 0);
            if (screenChanged) {
                ++emitted;  // real desktop change -> encode
                // 3b: feed ONLY real-change frames to NVENC, while the frame is still
                // held (CopyResource happens before ReleaseFrame below).
                if (encoding_) {
                    ComPtr<ID3D11Texture2D> frameTex;
                    if (SUCCEEDED(desktopResource.As(&frameTex))) {
                        auto now = Clock::now();
                        bool forceIdr = !haveEncodedFrame_ ||
                            std::chrono::duration_cast<std::chrono::milliseconds>(now - lastIdr_).count()
                                >= (long long)(kIdrIntervalSec * 1000);
                        if (!encoder_.EncodeFrame(frameTex.Get(), forceIdr)) {
                            printf("[encode] frame failed -> recover\n"); fflush(stdout);
                            dupl_->ReleaseFrame();
                            recover();
                            continue;
                        }
                        if (forceIdr) { lastIdr_ = now; haveEncodedFrame_ = true; }
                    }
                }
            } else {
                ++skippedPointerOnly; // pointer/metadata-only -> SKIP the screen encode
            }

            // cursor position is only valid when the mouse-update timestamp is set
            if (fi.LastMouseUpdateTime.QuadPart != 0) {
                cursorX = fi.PointerPosition.Position.x;
                cursorY = fi.PointerPosition.Position.y;
                cursorVisible = (fi.PointerPosition.Visible != FALSE);
            }
            // a new cursor shape is available this frame -> fetch it (kept for 3d).
            // NB: the struct field is PointerShapeBufferSize (the spec's
            // "PointerShapeBufferLength" was approximate).
            if (fi.PointerShapeBufferSize > 0) {
                if (shapeBuf.size() < fi.PointerShapeBufferSize) shapeBuf.resize(fi.PointerShapeBufferSize);
                UINT required = 0;
                DXGI_OUTDUPL_POINTER_SHAPE_INFO si = {};
                HRESULT shr = dupl_->GetFramePointerShape(
                    static_cast<UINT>(shapeBuf.size()), shapeBuf.data(), &required, &si);
                if (SUCCEEDED(shr)) {
                    // DXGI delivers a shape only when it actually changes, but two
                    // distinct shapes (arrow vs I-beam) can share si.Type, so detect
                    // on a content hash of the bitmap + dims, not on Type alone.
                    uint64_t h = HashShape(shapeBuf.data(), required ? required : fi.PointerShapeBufferSize, si);
                    if (h != lastShapeHash) {
                        printf("[cursor-shape] type=%s(%u) %ux%u hotspot=(%d,%d) bytes=%u\n",
                               PtrTypeName(si.Type), si.Type, si.Width, si.Height,
                               si.HotSpot.x, si.HotSpot.y, fi.PointerShapeBufferSize);
                        fflush(stdout);
                        lastShapeHash = h;
                    }
                    shapeType = si.Type;
                } else {
                    LogHr("GetFramePointerShape", shr);
                }
            }

            HRESULT rr = dupl_->ReleaseFrame();
            if (FAILED(rr)) {
                LogHr("ReleaseFrame", rr);
                recover();
                continue;
            }

            MaybeLog(intervalStart, emitted, skippedTimeout, skippedPointerOnly,
                     cursorX, cursorY, cursorVisible, shapeType);
        }

        if (encoding_) {
            encoder_.Shutdown();
            if (encFile_) { fclose(encFile_); encFile_ = nullptr; }
            printf("[encode] done: %llu frames, %llu bytes -> %s\n",
                   (unsigned long long)encoder_.framesEncoded(),
                   (unsigned long long)encoder_.bytesOut(), encodePath_.c_str());
        }
        printf("[done] duration %ds elapsed\n", durationSec);
        fflush(stdout);
        return 0;
    }

private:
    static constexpr UINT kAcquireTimeoutMs = 250;  // idle wakes ~4x/s to still log

    void MaybeLog(std::chrono::steady_clock::time_point& intervalStart,
                  uint64_t& emitted, uint64_t& skippedTimeout, uint64_t& skippedPointerOnly,
                  long cursorX, long cursorY, bool cursorVisible, UINT shapeType) {
        auto now = Clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - intervalStart).count() < 1000) return;
        printf("emitted=%llu skipped_timeout=%llu skipped_pointeronly=%llu cursor=(%ld,%ld,%s,%s)\n",
               (unsigned long long)emitted, (unsigned long long)skippedTimeout,
               (unsigned long long)skippedPointerOnly,
               cursorX, cursorY, cursorVisible ? "visible" : "hidden", PtrTypeName(shapeType));
        fflush(stdout);
        emitted = skippedTimeout = skippedPointerOnly = 0;  // per-second interval counters
        intervalStart = now;
    }

    bool Init(bool quiet) {
        Release();
        auto fail = [&](const char* w, HRESULT h) { if (!quiet) LogHr(w, h); return false; };

        D3D_FEATURE_LEVEL fl = {};
        HRESULT hr = D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
            nullptr, 0, D3D11_SDK_VERSION, &device_, &fl, &context_);
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

        printf("[init] output=%u  %dx%d  (duplication ready)\n", outputIndex_, width_, height_);
        fflush(stdout);
        return true;
    }

    bool InitWithRetry() { return ReinitWithRetry(); }

    // On ACCESS_LOST (desktop switch, screen lock / secure desktop, Parsec grabbing
    // the desktop) DuplicateOutput keeps failing until the normal desktop returns.
    // Retry indefinitely with throttled logging so a long lock never crashes us and
    // never spams — it recovers by itself on unlock (mirrors the sender's beta.2
    // crash-recovery policy). Always returns true (waits for the desktop).
    bool ReinitWithRetry() {
        for (int attempt = 0; ; ++attempt) {
            if (Init(/*quiet=*/attempt > 0)) {
                if (attempt > 0) { printf("[reinit] recovered after %d attempt(s)\n", attempt); fflush(stdout); }
                return true;
            }
            if (attempt == 0 || (attempt % 20) == 0) {  // first, then ~every 5s
                printf("[reinit] duplication unavailable (attempt %d) — retrying (screen locked / desktop switch?)\n",
                       attempt + 1);
                fflush(stdout);
            }
            Sleep(250);
        }
    }

    void Release() {
        // In the loop we always ReleaseFrame before reinit, so we don't hold a
        // frame here; just drop the COM references.
        dupl_.Reset();
        context_.Reset();
        device_.Reset();
    }

    UINT outputIndex_;
    int width_ = 0, height_ = 0;
    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGIOutputDuplication> dupl_;

    // --- 3b encode state (only when --encode was given) ---
    std::string encodePath_;
    bool encoding_ = false;
    FILE* encFile_ = nullptr;
    NvEncoder encoder_;
    Clock::time_point lastIdr_{};
    bool haveEncodedFrame_ = false;  // false => force IDR on the next real-change frame
    static constexpr double kIdrIntervalSec = 2.0;

    // (Re)create the encoder bound to the CURRENT device_ (called after each
    // duplication re-init, since ACCESS_LOST recovery recreates the device).
    bool setupEncoder() {
        encoder_.Shutdown();
        NvEncConfig cfg;
        cfg.width = width_; cfg.height = height_;
        cfg.fps = 60; cfg.targetKbps = 25000; cfg.maxKbps = 40000;
        cfg.vbvMs = 250; cfg.idrIntervalSec = kIdrIntervalSec;
        haveEncodedFrame_ = false;  // first frame after (re)init = IDR
        if (!encoder_.Init(device_.Get(), context_.Get(), cfg, encFile_)) {
            printf("[fatal] NVENC init failed\n"); fflush(stdout);
            return false;
        }
        return true;
    }

    // Duplication recovery that also rebuilds the encoder (the encoder is bound to
    // the device, which Init() recreates). Encoder is torn down BEFORE the old
    // device is released, then rebuilt against the new one (fresh SPS/PPS + IDR).
    void recover() {
        if (encoding_) encoder_.Shutdown();
        ReinitWithRetry();
        if (encoding_) setupEncoder();
    }
};

int main(int argc, char** argv) {
    int durationSec = 0;   // 0 = run until killed
    UINT outputIndex = 0;
    std::string encodePath;  // empty => 3a harness only (no NVENC)

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--selftest") {
            // default mode; explicit flag kept for the harness/spec
        } else if (a == "--duration" && i + 1 < argc) {
            durationSec = std::atoi(argv[++i]);
        } else if (a == "--output" && i + 1 < argc) {
            outputIndex = static_cast<UINT>(std::atoi(argv[++i]));
        } else if (a == "--encode" && i + 1 < argc) {
            encodePath = argv[++i];
        } else if (a == "--help" || a == "-h") {
            printf("dxgi-capturer (Step 3a change-detection + 3b NVENC)\n"
                   "  --selftest         run the acquire/classify loop (default)\n"
                   "  --duration <sec>   stop after N seconds (default: run forever)\n"
                   "  --output <index>   DXGI output to duplicate (default 0)\n"
                   "  --encode <file>    NVENC-encode real-change frames to a .h264 file (3b)\n");
            return 0;
        } else {
            printf("[warn] ignoring unknown arg: %s\n", a.c_str());
        }
    }

    // Per-monitor DPI aware so width/height and cursor coords are physical pixels.
    SetProcessDPIAware();

    printf("[start] dxgi-capturer (output=%u, duration=%ds%s)\n",
           outputIndex, durationSec, encodePath.empty() ? "" : ", NVENC encode");
    fflush(stdout);

    DuplCapturer cap(outputIndex, encodePath);
    return cap.Run(durationSec);
}
