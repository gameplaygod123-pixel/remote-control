// nvenc.h — minimal NVENC H.264 encoder for the DXGI capturer (Step 3b).
//
// Encodes ONLY the frames 3a decided are real desktop changes, zero-copy from a
// D3D11 texture (no CPU download), and writes raw Annex-B to a FILE* (3b: a .h264
// file; 3c will point this at stdout). Config matches what we proved on the
// VideoToolbox receiver: preset P1, tune ULL, no B-frames, VBR, ~250ms VBV,
// **plain periodic IDR (wall-clock ~2s), NO intra-refresh** (Step 1 proved
// intra-refresh freezes the VT decoder). SPS/PPS in-band before every IDR.
#pragma once

#include <d3d11.h>
#include <cstdint>
#include <cstdio>
#include <chrono>

struct NvEncConfig {
    int width = 0;
    int height = 0;
    int fps = 60;
    int targetKbps = 25000;   // VBR average
    int maxKbps = 40000;      // VBR cap
    int vbvMs = 250;          // VBV buffer ~250ms
    double idrIntervalSec = 2.0;  // wall-clock IDR period (not a frame count — we skip frames)
    bool hevc = false;        // false = H.264, true = H.265/HEVC (Parsec-parity GPU experiment)
    int preset = 1;           // NVENC preset 1..7: P1=fastest/lowest encode-ms .. P7=slow/quality.
                              // Raising it lifts per-frame encode time (quality/latency tradeoff).
};

// Opaque to callers; the impl holds all NVENC handles.
class NvEncoder {
public:
    NvEncoder() = default;
    ~NvEncoder();

    // device: the same D3D11 device the capturer duplicates with. out: destination
    // (a .h264 file for 3b). Returns false on any setup failure (caller logs & aborts).
    bool Init(ID3D11Device* device, ID3D11DeviceContext* context,
              const NvEncConfig& cfg, FILE* out);

    // Encode one real-change frame. `srcTex` is the acquired desktop texture — MUST
    // be called while the frame is still held (before ReleaseFrame); we CopyResource
    // it into an owned encode texture immediately. `forceIdr` is decided by the caller
    // (first frame / wall-clock 2s elapsed / PLI). Returns false on a fatal encode error.
    bool EncodeFrame(ID3D11Texture2D* srcTex, bool forceIdr);

    // Stage (GPU-copy) a desktop frame into the registered encode texture WITHOUT encoding it.
    // The locked-cadence loop copies the latest change during the tick window, then emits it at
    // the tick via EncodeRepeatFrame()/EncodeRepeatIdr(). MUST be called while srcTex is held
    // (before ReleaseFrame). No NVENC call, so it's cheap; the encode happens once, at the tick.
    bool StageFrame(ID3D11Texture2D* srcTex);

    // Re-encode the LAST frame (already in the registered texture) as a forced IDR —
    // for a PLI on a static screen, where no new desktop change is coming but the
    // receiver needs a fresh keyframe. No CopyResource.
    bool EncodeRepeatIdr();

    // Re-encode the LAST frame as a plain (non-IDR) P-frame — the min-fps FLOOR: during
    // an activity window we keep a steady cadence by duplicating the last frame when no
    // new desktop change arrives. Content is unchanged, so it encodes to a near-empty
    // skip-MB P-frame (cheap on GPU + wire) yet regularizes receiver pacing. No CopyResource.
    // NOTE: this still runs full motion estimation (~22% enc on a static screen) — for the
    // LOCKED-cadence path use EncodeSkipped() instead, which is near-free.
    bool EncodeRepeatFrame();

    // Emit a CODED-SKIP frame (NV_ENC_PIC_TYPE_SKIPPED) — the Parsec-parity idle path.
    // NVENC codes a P-frame whose every MB is a "skip" (copy-from-reference) WITHOUT running
    // motion estimation, so on a static screen it costs almost no GPU (~1-2% vs 22% for a
    // re-encoded P-frame) and only a few bytes on the wire, yet advances the stream one frame
    // to hold a locked 60fps cadence at the receiver. No CopyResource. Requires enablePTD=0
    // (we drive picture types explicitly). Must be called from the encode thread.
    bool EncodeSkipped();

    // Change the VBR target/max bitrate LIVE (nvEncReconfigureEncoder, resetEncoder=0,
    // no forced IDR) — the sender's BWE feedback path: receiver measures the link, sends
    // the new ceiling, we retune NVENC in place with no respawn and no keyframe spike.
    // MUST be called from the encode thread (same one that calls EncodeFrame). kbps values.
    bool SetBitrate(int targetKbps, int maxKbps);

    void Shutdown();  // flush EOS + free everything

    uint64_t framesEncoded() const { return framesEncoded_; }
    uint64_t bytesOut()      const { return bytesOut_; }
    // Average per-frame HW encode time (ms) since the last call; resets the accumulator.
    // Measured around nvEncEncodePicture + the synchronous nvEncLockBitstream (encode done).
    double takeAvgEncodeMs();

private:
    bool encodeMapped(int nvPicType);  // map registered tex -> encode as pictureType -> emit (shared)
    bool writeBitstream();             // lock/emit/unlock the encoded output

    void* enc_ = nullptr;              // NVENC session handle
    void* fnListMem_ = nullptr;        // heap NV_ENCODE_API_FUNCTION_LIST
    void* registered_ = nullptr;       // NV_ENC_REGISTERED_PTR for encodeTex_
    void* bitstream_ = nullptr;        // NV_ENC_OUTPUT_PTR
    void* dll_ = nullptr;              // HMODULE nvEncodeAPI64.dll
    void* initParamsMem_ = nullptr;    // heap NV_ENC_INITIALIZE_PARAMS (persisted for reconfigure)
    void* encCfgMem_ = nullptr;        // heap NV_ENC_CONFIG (initParams.encodeConfig points here)

    ID3D11Device* device_ = nullptr;
    ID3D11DeviceContext* context_ = nullptr;
    ID3D11Texture2D* encodeTex_ = nullptr;  // owned BGRA copy target registered with NVENC

    FILE* out_ = nullptr;
    NvEncConfig cfg_{};
    uint64_t framesEncoded_ = 0;
    uint64_t bytesOut_ = 0;
    uint64_t ptsCounter_ = 0;
    double   encMsSum_ = 0.0;   // accumulated per-frame encode time (ms) for the current log window
    uint64_t encMsCount_ = 0;
    std::chrono::steady_clock::time_point encStart_{};  // set before EncodePicture; measured to
                                                        // just after LockBitstream (excludes fwrite)
};
