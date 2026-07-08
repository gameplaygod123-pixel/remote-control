// nvenc.cpp — NVENC H.264 encoder impl for the DXGI capturer (Step 3b).
#include "nvenc.h"

#include <windows.h>
#include <nvEncodeAPI.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>

// The NVENC entry points we drive live in a function-list struct filled by the DLL.
#define FL (reinterpret_cast<NV_ENCODE_API_FUNCTION_LIST*>(fnListMem_))
#define ENC (enc_)

using CreateInstanceFn = NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);

// All logs go to stderr (stdout is the H.264 stream in the sender path).
static void NvLog(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt);
    fprintf(stderr, "[capturer] ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    fflush(stderr);
}
static void LogNv(const char* what, NVENCSTATUS s) { NvLog("nvenc %s failed: status=%d", what, (int)s); }

#define NVCK(call, what) do { NVENCSTATUS _s = (call); if (_s != NV_ENC_SUCCESS) { LogNv((what), _s); return false; } } while (0)

NvEncoder::~NvEncoder() { Shutdown(); }

bool NvEncoder::Init(ID3D11Device* device, ID3D11DeviceContext* context,
                     const NvEncConfig& cfg, FILE* out) {
    device_ = device;
    context_ = context;
    cfg_ = cfg;
    out_ = out;

    // --- load the DLL (ships with the NVIDIA driver) + the API function list ---
    dll_ = LoadLibraryA("nvEncodeAPI64.dll");
    if (!dll_) { NvLog("LoadLibrary nvEncodeAPI64.dll failed (no NVIDIA driver?)"); return false; }

    auto createInstance = reinterpret_cast<CreateInstanceFn>(
        GetProcAddress(reinterpret_cast<HMODULE>(dll_), "NvEncodeAPICreateInstance"));
    if (!createInstance) { NvLog("GetProcAddress NvEncodeAPICreateInstance failed"); return false; }

    auto* fl = new NV_ENCODE_API_FUNCTION_LIST{};
    fl->version = NV_ENCODE_API_FUNCTION_LIST_VER;
    fnListMem_ = fl;
    NVCK(createInstance(fl), "NvEncodeAPICreateInstance");

    // --- open a session bound to our D3D11 device ---
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS op = {};
    op.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    op.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    op.device = device_;
    op.apiVersion = NVENCAPI_VERSION;
    NVCK(FL->nvEncOpenEncodeSessionEx(&op, &enc_), "nvEncOpenEncodeSessionEx");

    const GUID codecGuid = cfg_.hevc ? NV_ENC_CODEC_HEVC_GUID : NV_ENC_CODEC_H264_GUID;

    // --- start from the P1 + ultra-low-latency preset, then pin our config ---
    NV_ENC_PRESET_CONFIG pc = {};
    pc.version = NV_ENC_PRESET_CONFIG_VER;
    pc.presetCfg.version = NV_ENC_CONFIG_VER;
    NVCK(FL->nvEncGetEncodePresetConfigEx(enc_, codecGuid, NV_ENC_PRESET_P1_GUID,
                                          NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &pc),
         "nvEncGetEncodePresetConfigEx");

    // Persist the encode config + init params on the heap so SetBitrate() can retune the
    // live encoder via nvEncReconfigureEncoder (reInitEncodeParams must point at a valid
    // encodeConfig that OUTLIVES the call). initParams.encodeConfig -> this encCfg.
    auto* encCfgPtr = new NV_ENC_CONFIG(pc.presetCfg);
    encCfgMem_ = encCfgPtr;
    NV_ENC_CONFIG& encCfg = *encCfgPtr;
    encCfg.version = NV_ENC_CONFIG_VER;
    encCfg.gopLength = NVENC_INFINITE_GOPLENGTH;   // we drive IDR ourselves (wall-clock)
    encCfg.frameIntervalP = 1;                     // IPPP — no B-frames

    encCfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
    encCfg.rcParams.averageBitRate = static_cast<uint32_t>(cfg_.targetKbps) * 1000u;
    encCfg.rcParams.maxBitRate     = static_cast<uint32_t>(cfg_.maxKbps) * 1000u;
    encCfg.rcParams.vbvBufferSize  = static_cast<uint32_t>(
        static_cast<uint64_t>(encCfg.rcParams.maxBitRate) * cfg_.vbvMs / 1000);
    encCfg.rcParams.vbvInitialDelay = encCfg.rcParams.vbvBufferSize;

    if (cfg_.hevc) {
        NV_ENC_CONFIG_HEVC& hevc = encCfg.encodeCodecConfig.hevcConfig;
        hevc.idrPeriod = NVENC_INFINITE_GOPLENGTH;  // no auto-IDR; we force by wall clock
        hevc.repeatSPSPPS = 1;                       // in-band VPS/SPS/PPS before every IDR
        hevc.enableIntraRefresh = 0;                 // NEVER (VideoToolbox can't decode it — Step 1)
        hevc.sliceMode = 0;                          // single slice
        hevc.sliceModeData = 0;
        hevc.outputAUD = 0;
    } else {
        NV_ENC_CONFIG_H264& h264 = encCfg.encodeCodecConfig.h264Config;
        h264.idrPeriod = NVENC_INFINITE_GOPLENGTH;  // no auto-IDR; we force by wall clock
        h264.repeatSPSPPS = 1;                        // in-band SPS/PPS before every IDR
        h264.enableIntraRefresh = 0;                  // NEVER (VideoToolbox can't decode it — Step 1)
        h264.sliceMode = 0;                           // single slice (Step 2 multi-slice skipped)
        h264.sliceModeData = 0;
        h264.outputAUD = 0;
    }

    auto* ipPtr = new NV_ENC_INITIALIZE_PARAMS{};
    initParamsMem_ = ipPtr;
    NV_ENC_INITIALIZE_PARAMS& ip = *ipPtr;
    ip.version = NV_ENC_INITIALIZE_PARAMS_VER;
    ip.encodeGUID = codecGuid;
    ip.presetGUID = NV_ENC_PRESET_P1_GUID;
    ip.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    ip.encodeWidth = cfg_.width;   ip.encodeHeight = cfg_.height;
    ip.darWidth = cfg_.width;      ip.darHeight = cfg_.height;
    ip.maxEncodeWidth = cfg_.width; ip.maxEncodeHeight = cfg_.height;
    ip.frameRateNum = cfg_.fps;    ip.frameRateDen = 1;
    ip.enablePTD = 1;              // encoder picks frame types; FORCEIDR still honored
    ip.enableEncodeAsync = 0;      // synchronous — LockBitstream blocks until ready
    ip.encodeConfig = encCfgPtr;
    NVCK(FL->nvEncInitializeEncoder(enc_, &ip), "nvEncInitializeEncoder");

    // --- owned BGRA texture we CopyResource each real-change frame into, registered once ---
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = cfg_.width; td.Height = cfg_.height;
    td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    HRESULT hr = device_->CreateTexture2D(&td, nullptr, &encodeTex_);
    if (FAILED(hr)) { NvLog("CreateTexture2D failed: 0x%08lX", (unsigned long)hr); return false; }

    NV_ENC_REGISTER_RESOURCE reg = {};
    reg.version = NV_ENC_REGISTER_RESOURCE_VER;
    reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    reg.width = cfg_.width; reg.height = cfg_.height; reg.pitch = 0;
    reg.resourceToRegister = encodeTex_;
    reg.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB;  // DXGI BGRA == NVENC "ARGB" byte order
    reg.bufferUsage = NV_ENC_INPUT_IMAGE;
    NVCK(FL->nvEncRegisterResource(enc_, &reg), "nvEncRegisterResource");
    registered_ = reg.registeredResource;

    NV_ENC_CREATE_BITSTREAM_BUFFER bb = {};
    bb.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    NVCK(FL->nvEncCreateBitstreamBuffer(enc_, &bb), "nvEncCreateBitstreamBuffer");
    bitstream_ = bb.bitstreamBuffer;

    NvLog("nvenc %s P1/ULL VBR %d/%d kbps, VBV %dms, IDR ~%.1fs, %dx%d@%d, no-B no-intra-refresh",
          cfg_.hevc ? "HEVC" : "H264", cfg_.targetKbps, cfg_.maxKbps, cfg_.vbvMs, cfg_.idrIntervalSec,
          cfg_.width, cfg_.height, cfg_.fps);
    return true;
}

bool NvEncoder::EncodeFrame(ID3D11Texture2D* srcTex, bool forceIdr) {
    if (!enc_) return false;
    // GPU->GPU copy of the still-held desktop frame into our registered texture
    // (no CPU download = zero-copy in the host sense). Caller ReleaseFrames after.
    context_->CopyResource(encodeTex_, srcTex);
    return encodeMapped(forceIdr);
}

bool NvEncoder::EncodeRepeatIdr() {
    if (!enc_) return false;
    return encodeMapped(/*forceIdr=*/true);  // re-encode the last frame already in encodeTex_
}

bool NvEncoder::EncodeRepeatFrame() {
    if (!enc_) return false;
    return encodeMapped(/*forceIdr=*/false);  // duplicate last frame as a cheap P-frame (floor)
}

bool NvEncoder::SetBitrate(int targetKbps, int maxKbps) {
    if (!enc_ || !initParamsMem_ || !encCfgMem_) return false;
    if (targetKbps <= 0) return false;
    if (maxKbps < targetKbps) maxKbps = targetKbps;

    auto* encCfg = reinterpret_cast<NV_ENC_CONFIG*>(encCfgMem_);
    auto* ip     = reinterpret_cast<NV_ENC_INITIALIZE_PARAMS*>(initParamsMem_);

    // Retune ONLY the rate-control fields in the persisted config (everything else — codec,
    // preset, resolution, GOP, no-B/no-intra-refresh — stays byte-identical so this is a
    // pure RC change, not a re-init).
    encCfg->rcParams.averageBitRate = static_cast<uint32_t>(targetKbps) * 1000u;
    encCfg->rcParams.maxBitRate     = static_cast<uint32_t>(maxKbps) * 1000u;
    encCfg->rcParams.vbvBufferSize  = static_cast<uint32_t>(
        static_cast<uint64_t>(encCfg->rcParams.maxBitRate) * cfg_.vbvMs / 1000);
    encCfg->rcParams.vbvInitialDelay = encCfg->rcParams.vbvBufferSize;

    NV_ENC_RECONFIGURE_PARAMS rp = {};
    rp.version = NV_ENC_RECONFIGURE_PARAMS_VER;
    rp.reInitEncodeParams = *ip;   // carries encodeConfig -> our just-updated encCfg
    rp.resetEncoder = 0;           // keep the running stream (no session reset)
    rp.forceIDR = 0;               // BWE must NOT trigger a keyframe spike
    NVCK(FL->nvEncReconfigureEncoder(enc_, &rp), "nvEncReconfigureEncoder");

    cfg_.targetKbps = targetKbps;
    cfg_.maxKbps = maxKbps;
    NvLog("nvenc reconfigure VBR %d/%d kbps (live, no reset, no IDR)", targetKbps, maxKbps);
    return true;
}

bool NvEncoder::encodeMapped(bool forceIdr) {
    NV_ENC_MAP_INPUT_RESOURCE map = {};
    map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    map.registeredResource = registered_;
    NVCK(FL->nvEncMapInputResource(enc_, &map), "nvEncMapInputResource");

    NV_ENC_PIC_PARAMS pic = {};
    pic.version = NV_ENC_PIC_PARAMS_VER;
    pic.inputBuffer = map.mappedResource;
    pic.bufferFmt = map.mappedBufferFmt;
    pic.inputWidth = cfg_.width;
    pic.inputHeight = cfg_.height;
    pic.outputBitstream = bitstream_;
    pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    pic.inputTimeStamp = ptsCounter_++;
    if (forceIdr)
        pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;

    NVENCSTATUS st = FL->nvEncEncodePicture(enc_, &pic);
    bool ok = true;
    if (st == NV_ENC_SUCCESS) {
        ok = writeBitstream();
        ++framesEncoded_;
    } else if (st == NV_ENC_ERR_NEED_MORE_INPUT) {
        // shouldn't happen with no B-frames / no lookahead, but tolerate it
    } else {
        LogNv("nvEncEncodePicture", st);
        ok = false;
    }

    NVCK(FL->nvEncUnmapInputResource(enc_, map.mappedResource), "nvEncUnmapInputResource");
    return ok;
}

bool NvEncoder::writeBitstream() {
    NV_ENC_LOCK_BITSTREAM lb = {};
    lb.version = NV_ENC_LOCK_BITSTREAM_VER;
    lb.outputBitstream = bitstream_;
    NVCK(FL->nvEncLockBitstream(enc_, &lb), "nvEncLockBitstream");

    if (lb.bitstreamSizeInBytes && out_) {
        fwrite(lb.bitstreamBufferPtr, 1, lb.bitstreamSizeInBytes, out_);
        bytesOut_ += lb.bitstreamSizeInBytes;
        fflush(out_);  // flush per frame — no muxer buffering (low latency, contract)
    }
    NVCK(FL->nvEncUnlockBitstream(enc_, bitstream_), "nvEncUnlockBitstream");
    return true;
}

void NvEncoder::Shutdown() {
    if (enc_ && fnListMem_) {
        // send EOS to flush the encoder (no pending output with sync/no-B, but proper)
        NV_ENC_PIC_PARAMS eos = {};
        eos.version = NV_ENC_PIC_PARAMS_VER;
        eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
        FL->nvEncEncodePicture(enc_, &eos);

        if (registered_) { FL->nvEncUnregisterResource(enc_, registered_); registered_ = nullptr; }
        if (bitstream_)  { FL->nvEncDestroyBitstreamBuffer(enc_, bitstream_); bitstream_ = nullptr; }
        FL->nvEncDestroyEncoder(enc_);
        enc_ = nullptr;
    }
    if (encodeTex_) { encodeTex_->Release(); encodeTex_ = nullptr; }
    if (initParamsMem_) { delete reinterpret_cast<NV_ENC_INITIALIZE_PARAMS*>(initParamsMem_); initParamsMem_ = nullptr; }
    if (encCfgMem_)     { delete reinterpret_cast<NV_ENC_CONFIG*>(encCfgMem_); encCfgMem_ = nullptr; }
    if (fnListMem_) { delete reinterpret_cast<NV_ENCODE_API_FUNCTION_LIST*>(fnListMem_); fnListMem_ = nullptr; }
    if (dll_) { FreeLibrary(reinterpret_cast<HMODULE>(dll_)); dll_ = nullptr; }
    if (out_) { fflush(out_); }  // caller owns the FILE*, we just flush
}
