# Parsec-parity research — what's left to match Parsec

Research pass (2026-07-08) triggered by the residual HEVC judder: a ~53ms hitch per
loss during a high-motion video on the Parsec-shared link. Root cause is confirmed
external **blackout** loss (130–163 consecutive packets = the link goes dark ~90ms),
recovered today by **PLI → full IDR**. This doc maps our pipeline against the
low-latency-streaming playbook (`~/Downloads/low-latency-remote-streaming-guide.md` +
NVENC/VideoToolbox docs + the Moonlight LTR design) to find the ONE real remaining gap.

## Gap analysis — us vs the Parsec/Moonlight/Sunshine playbook

The guide's "5 keys to smoothness" scored against our v1.28.0 pipeline:

| # | Technique | Us | Notes |
|---|---|---|---|
| 1 | Everything on GPU (zero-copy cap→enc, dec→render) | ✅ | DXGI→NVENC D3D11 zero-copy; VideoToolbox→AVSampleBufferDisplayLayer |
| 2 | HW encode/decode, B-off, no reorder, one-in-one-out | ✅ | NVENC p1 ULL, `-bf 0`; VideoToolbox `AllowFrameReordering=false` |
| 3 | UDP + FEC + shallow adaptive jitter buffer | ⚠️ | UDP/RTP ✅; **FEC ❌** (ruled out — can't recover a total blackout, and interleaved FEC adds ~200ms = kills latency); jitter buffer: we present immediately, but jitter is already **4ms** so a buffer would only ADD latency |
| 4 | **Intra-refresh / LTR instead of full keyframes** | ❌ | intra-refresh is VideoToolbox-incompatible (proven, [[pure-intra-refresh-freezes-videotoolbox]]); **LTR is the gap** — we recover with a full IDR (a 130–160-packet burst) |
| 5 | Multi-thread pipeline + frame pacing | ✅ | separate capturer/sender/receiver processes; jitter 4ms so pacing unneeded |

**Verdict: we already do ~90% of the Parsec playbook.** Zero-copy, HW codecs, low-latency
present, adaptive bitrate (BWE), reorder-tolerant loss detection, fast PLI recovery, and
H.265 all landed (v1.26–v1.28). **The ONE technique Parsec/Moonlight use that we don't is
LTR-based loss recovery** (key #4). FEC (key #3) is deliberately NOT pursued — it can't
recover our blackout loss pattern without an interleaving latency we won't pay.

## The gap: LTR-based recovery (replaces PLI → full IDR)

**Today:** a lost packet breaks a frame → the receiver PLIs → the sender forces a full
**IDR** (130–160 packets). That big burst (a) takes ~53ms and (b) on an already-degraded
link self-congests and triggers a follow-on loss cascade (observed 14:20:46–14:21:10:
130→139→163-packet losses back to back).

**LTR (Long-Term Reference), how Moonlight/Parsec do it** (NVENC/HEVC/AV1 all support it;
Moonlight is migrating its RFI protocol to LTR — moonlight-common-c#120):
1. The sender periodically encodes a frame and **marks it LTR** ("pins" it in the DPB so
   short-term frames can't evict it).
2. The receiver **ACKs** frames it decoded cleanly, over the control channel.
3. The sender promotes the last-ACKed LTR to the "recovery" reference and rotates a fresh
   LTR (a tiny DPB: 2 LTR + 1 short-term).
4. **On loss**, the receiver sends a NACK/RFI (not "give me a keyframe"). The sender encodes
   a small **P-frame that references the last-ACKed recovery LTR** — decodable, ~a normal
   P-frame in size, NO keyframe burst → no cascade, recovers in ~1 frame.

Net win vs our IDR path: recovery frame goes from ~150 packets to ~a handful, so recovery
is faster AND doesn't self-congest a bad link. This is exactly the "avoid full keyframes"
principle (guide §4.1/§4.3/§5.3).

### Why LTR helps even our *blackout* loss
During the ~90ms blackout no frame gets through — LTR can't change that. But the RECOVERY
after the blackout is where LTR wins: instead of a full IDR burst (which is what pile-drives
the already-recovering link into the cascade), the sender emits one small LTR-P delta from
the last good pre-blackout frame. Cheap, fast, no burst.

## Plan (phased, prerelease-per-substep, golden rule #1)

- **Quick experiment first (cheap, WC one-liner) — smaller VBV:** the guide sets VBV ≈ 1–2
  frames; our capturer uses ~250ms (`bufsize = maxrate/4`), which lets a single IDR balloon
  into the 150-packet burst. Shrinking VBV to ~2 frames (~33ms) caps per-frame size → smaller
  bursts → less self-induced overflow, with a small quality trade on complex frames. One NVENC
  param in `capturer.exe`; measure loss/cascade with `analyze-session.mjs`. Do this before the
  big LTR build — it may blunt the cascade cheaply.
- **LTR recovery (the real fix), phased:**
  - **L1 (Windows/WC):** capturer marks LTR frames via the NVENC LTR API
    (`NV_ENC_PIC_FLAG_*`/LTR mark/use) and, on a stdin command, encodes a P-frame from a given
    LTR index instead of an IDR. Verify standalone (`.h264` decodes; recovery frame is small).
  - **L2 (protocol, both):** a lightweight **ACK + RFI** feedback over the input pc data channel
    (media pc is media-only): receiver ACKs decoded frame numbers; on a confirmed loss it sends
    `RFI(lastGoodFrame)` instead of a bare PLI. Sender maps that to "encode LTR-P from the last
    ACKed LTR". Keep the existing PLI→IDR as the FALLBACK (no ACK / LTR unsupported).
  - **L3 (Mac):** the receiver already produces frame-level AUs; add frame-number ACK + wire the
    RFI path. VideoToolbox decodes the LTR-P frame as a normal P-frame (no receiver codec change).
  - Prerelease + real-hardware verify; the analyzer measures recovery-ms + cascade drop.

## What we deliberately are NOT doing
- **FEC** — can't recover a total blackout (parity is lost too); interleaving to survive bursts
  costs ~200ms latency = the opposite of the goal. (If the loss pattern were SCATTERED, FEC
  would be the answer — it isn't here.)
- **Intra-refresh** — VideoToolbox can't decode the rolling-intra structure ([[pure-intra-refresh-freezes-videotoolbox]]).
- **Multi-slice** — only helps scattered loss (a blackout loses all slices); needs a per-slice
  send/assembler rewrite (Step-2-scale). Deferred.
- **Fixing the link** (wired vs Wi-Fi, Parsec bandwidth cap, router QoS) is the true root of the
  blackouts and the cheapest real fix, but it's environment, not code.

## Sources
- Local: `~/Downloads/low-latency-remote-streaming-guide.md` (§4.1 NVENC, §4.3 VideoToolbox LTR, §5.3 loss strategy)
- [Moonlight: supersede RFI with LTR frames (moonlight-common-c #120)](https://github.com/moonlight-stream/moonlight-common-c/issues/120)
- [NVENC Video Codec SDK — Programming Guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)
- [Explore low-latency video encoding with VideoToolbox — WWDC21](https://developer.apple.com/videos/play/wwdc2021/10158/)
- Sunshine (LizardByte) + Moonlight (moonlight-stream) open-source reference implementations
