// Phase 0-B de-risk spike (Windows sender half) — see docs/native-video-plan.md §5.
//
// Question this answers: can we capture the desktop with DXGI Desktop Duplication
// and hardware-encode it to H.264 via Media Foundation (which binds this machine's
// NVENC/QuickSync HW MFT) end to end — producing a DECODABLE stream — and what is
// the capture+encode latency?
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ STATUS: WRITTEN, NOT YET COMPILED OR RUN — this machine has no MSVC/Windows   │
// │ SDK (see native/README.md "Phase 0 BLOCKER"). Golden rule #1: unverified      │
// │ native code. Build + run on the real Windows agent before trusting/shipping.  │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// Approach chosen for a SPIKE (smallest correct surface):
//   - DXGI Output Duplication -> ID3D11Texture2D (BGRA, on GPU).
//   - Copy to a CPU STAGING texture + Map (a spike simplification; production keeps
//     the frame on the GPU and feeds the encoder a D3D11 texture zero-copy).
//   - Media Foundation SinkWriter: input RGB32, output H.264. The SinkWriter auto-
//     selects the hardware encoder MFT (NVENC on the RTX 3060 Ti here) and inserts
//     the RGB32->NV12 converter. MF_LOW_LATENCY + hardware transforms enabled.
//   - Writes out.mp4 (decodable in any player / ffprobe) and prints per-frame
//     CAPTURE latency (acquire+copy+map) precisely. Per-frame ENCODE latency needs
//     the raw IMFTransform path (SinkWriter hides it) — a documented Phase 1 refine.
//
// Build (once a toolchain exists): see build.bat next to this file.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <codecapi.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstdint>
#include <vector>
#include <algorithm>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")

using Microsoft::WRL::ComPtr;

static const int    TARGET_FPS   = 60;
static const int    FRAME_COUNT  = 300;          // ~5 s at 60 fps
static const UINT32 BITRATE_BPS  = 30'000'000;   // match v1.22.0 max (30 Mbps)
static const wchar_t* OUT_PATH    = L"out.mp4";

#define HRCHECK(hr, msg) do { HRESULT _hr=(hr); if(FAILED(_hr)){ \
    fprintf(stderr, "FAIL %s (hr=0x%08lX)\n", msg, (unsigned long)_hr); return 1; } } while(0)

static double now_ms() {
    LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

int wmain() {
    HRCHECK(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "CoInitializeEx");
    HRCHECK(MFStartup(MF_VERSION, MFSTARTUP_LITE), "MFStartup");

    // ── D3D11 device ─────────────────────────────────────────────────────────
    ComPtr<ID3D11Device> dev; ComPtr<ID3D11DeviceContext> ctx;
    D3D_FEATURE_LEVEL fl;
    HRCHECK(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
              D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
              &dev, &fl, &ctx), "D3D11CreateDevice");

    // ── DXGI Output Duplication of the primary output ─────────────────────────
    ComPtr<IDXGIDevice> dxgiDev;  HRCHECK(dev.As(&dxgiDev), "QI IDXGIDevice");
    ComPtr<IDXGIAdapter> adapter; HRCHECK(dxgiDev->GetAdapter(&adapter), "GetAdapter");
    ComPtr<IDXGIOutput> output;   HRCHECK(adapter->EnumOutputs(0, &output), "EnumOutputs(0)");
    ComPtr<IDXGIOutput1> output1; HRCHECK(output.As(&output1), "QI IDXGIOutput1");
    ComPtr<IDXGIOutputDuplication> dup;
    HRCHECK(output1->DuplicateOutput(dev.Get(), &dup), "DuplicateOutput");
    DXGI_OUTDUPL_DESC ddesc; dup->GetDesc(&ddesc);
    const UINT W = ddesc.ModeDesc.Width, H = ddesc.ModeDesc.Height;
    printf("[spike] duplicating primary output %ux%u, target %dfps, %u Mbps -> %ls\n",
           W, H, TARGET_FPS, BITRATE_BPS / 1'000'000, OUT_PATH);

    // ── CPU staging texture (spike simplification; production stays on GPU) ────
    D3D11_TEXTURE2D_DESC sd{};
    sd.Width = W; sd.Height = H; sd.MipLevels = 1; sd.ArraySize = 1;
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM; sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    HRCHECK(dev->CreateTexture2D(&sd, nullptr, &staging), "CreateTexture2D(staging)");

    // ── Media Foundation SinkWriter (hardware H.264, low latency) ─────────────
    ComPtr<IMFAttributes> attrs; HRCHECK(MFCreateAttributes(&attrs, 3), "MFCreateAttributes");
    attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1); // bind NVENC/QSV MFT
    attrs->SetUINT32(MF_LOW_LATENCY, 1);
    ComPtr<IMFSinkWriter> sink;
    HRCHECK(MFCreateSinkWriterFromURL(OUT_PATH, nullptr, attrs.Get(), &sink),
            "MFCreateSinkWriterFromURL");

    // output type: H.264
    ComPtr<IMFMediaType> outType; MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    outType->SetUINT32(MF_MT_AVG_BITRATE, BITRATE_BPS);
    outType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    outType->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
    MFSetAttributeSize(outType.Get(), MF_MT_FRAME_SIZE, W, H);
    MFSetAttributeRatio(outType.Get(), MF_MT_FRAME_RATE, TARGET_FPS, 1);
    MFSetAttributeRatio(outType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    DWORD streamIndex = 0;
    HRCHECK(sink->AddStream(outType.Get(), &streamIndex), "AddStream");

    // input type: RGB32 (from the BGRA staging map). SinkWriter inserts the
    // RGB32->NV12 converter and hands NV12 to the HW encoder.
    ComPtr<IMFMediaType> inType; MFCreateMediaType(&inType);
    inType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    inType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    inType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(inType.Get(), MF_MT_FRAME_SIZE, W, H);
    MFSetAttributeRatio(inType.Get(), MF_MT_FRAME_RATE, TARGET_FPS, 1);
    HRCHECK(sink->SetInputMediaType(streamIndex, inType.Get(), nullptr), "SetInputMediaType");

    // low-latency + no B-frames on the underlying encoder (best-effort via CODECAPI)
    ComPtr<ICodecAPI> codec;
    if (SUCCEEDED(sink->GetServiceForStream(streamIndex, GUID_NULL, IID_PPV_ARGS(&codec)))) {
        VARIANT v; v.vt = VT_BOOL; v.boolVal = VARIANT_TRUE;
        codec->SetValue(&CODECAPI_AVLowLatencyMode, &v);
        VARIANT z; z.vt = VT_UI4; z.ulVal = 0; codec->SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &z);
    }

    HRCHECK(sink->BeginWriting(), "BeginWriting");

    // ── capture + encode loop ──────────────────────────────────────────────────
    std::vector<double> capMs; capMs.reserve(FRAME_COUNT);
    const LONGLONG frameDur = 10'000'000LL / TARGET_FPS; // 100ns units
    LONGLONG ts = 0;
    int encoded = 0;
    const double runStart = now_ms();

    for (int i = 0; i < FRAME_COUNT; ) {
        DXGI_OUTDUPL_FRAME_INFO fi; ComPtr<IDXGIResource> res;
        HRESULT hr = dup->AcquireNextFrame(1000, &fi, &res);
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) continue;          // no screen change; retry
        HRCHECK(hr, "AcquireNextFrame");

        const double t0 = now_ms();
        ComPtr<ID3D11Texture2D> frame; res.As(&frame);
        ctx->CopyResource(staging.Get(), frame.Get());
        D3D11_MAPPED_SUBRESOURCE map;
        HRCHECK(ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &map), "Map(staging)");

        // wrap the mapped RGB32 into an IMFSample (contiguous copy for the spike)
        ComPtr<IMFMediaBuffer> buf;
        const DWORD sizeBytes = W * H * 4;
        HRCHECK(MFCreateMemoryBuffer(sizeBytes, &buf), "MFCreateMemoryBuffer");
        BYTE* dst; buf->Lock(&dst, nullptr, nullptr);
        // copy row by row (staging RowPitch may exceed W*4)
        for (UINT y = 0; y < H; ++y)
            memcpy(dst + y * W * 4, (BYTE*)map.pData + y * map.RowPitch, W * 4);
        buf->Unlock(); buf->SetCurrentLength(sizeBytes);
        ctx->Unmap(staging.Get(), 0);

        const double capElapsed = now_ms() - t0; // acquire+copy+map+pack = capture cost
        capMs.push_back(capElapsed);

        ComPtr<IMFSample> sample; MFCreateSample(&sample);
        sample->AddBuffer(buf.Get());
        sample->SetSampleTime(ts); sample->SetSampleDuration(frameDur);
        ts += frameDur;

        HRCHECK(sink->WriteSample(streamIndex, sample.Get()), "WriteSample");
        encoded++; i++;
        dup->ReleaseFrame();
    }

    HRCHECK(sink->Finalize(), "Finalize");
    const double wall = now_ms() - runStart;

    // ── results ────────────────────────────────────────────────────────────────
    std::sort(capMs.begin(), capMs.end());
    auto pct = [&](double p){ return capMs.empty() ? 0.0 : capMs[(size_t)std::min(capMs.size()-1, (size_t)(p/100.0*capMs.size()))]; };
    printf("\n================ Phase 0-B RESULT ================\n");
    printf("frames encoded            : %d -> %ls\n", encoded, OUT_PATH);
    printf("wall time                 : %.0f ms (%.1f fps sustained through encode)\n", wall, encoded * 1000.0 / wall);
    printf("CAPTURE latency p50/p90/p99/max ms: %.2f / %.2f / %.2f / %.2f\n", pct(50), pct(90), pct(99), capMs.empty()?0:capMs.back());
    printf("NOTE: per-frame ENCODE latency needs the raw H264 IMFTransform (Phase 1);\n");
    printf("      verify decodability:  ffprobe out.mp4   (expect h264, %ux%u)\n", W, H);
    printf("GATE (DXGI->MF HW encode -> decodable): PASS if out.mp4 plays & capture p50 < ~5 ms\n");
    printf("==================================================\n");

    MFShutdown(); CoUninitialize();
    return 0;
}
