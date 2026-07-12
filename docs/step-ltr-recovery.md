# Step: LTR recovery (Parsec-grade loss recovery)

Replace `PLI → full IDR` with `PLI → small LTR-P frame`. Rationale + gap analysis in
[`parsec-parity-research.md`](parsec-parity-research.md). This is the concrete contract
+ phasing.

## Design (no per-frame ACK — reuse the existing PLI)

Moonlight's full LTR protocol ACKs every frame so the sender knows exactly which LTR the
receiver holds. We DON'T need that complexity: the media pc is media-only (no data
channel), and our loss recovery already works over the existing RTCP **PLI** the receiver
sends on loss. So:

1. **Capturer marks an LTR every ~30 frames (~0.5s)** and keeps the last 2 (a tiny DPB:
   2 LTR + 1 short-term, exactly the SDK-recommended layout).
2. **On a PLI** (which the receiver already sends on a confirmed loss), the sender writes
   **`L`** to the capturer stdin. The capturer encodes the next frame as a **P-frame that
   references the OLDER of its 2 LTRs** — old enough (~1s) that the receiver is sure to
   have had it (older than any plausible blackout). No IDR, no burst, no cascade.
3. **IDR fallback (guaranteed recovery):** if the receiver PLIs again within
   `LTR_ESCALATE_MS` (1200ms) of an LTR attempt, the LTR-P didn't resync it (e.g. the
   blackout also wiped that LTR). The sender then sends a real **IDR** (`I`). So recovery
   is always guaranteed; LTR is just the cheap first try.

This needs no ACK channel and no receiver protocol change — the receiver keeps sending
PLIs exactly as today; only the SENDER's response changes (LTR-P first, IDR on repeat).

## Capturer CLI/stdin contract (WC — L1)

Extend `capturer.exe` stdin (already handles `I`=force-IDR, `B<kbps>`=bitrate):

- **`L`** (one byte): "LTR recovery". Encode the next frame as a P-frame referencing the
  last SAFE long-term reference (see policy below), NOT an IDR. Marked so a decoder can
  follow it as a normal inter frame.
- **LTR marking policy (internal):** every `NV_LTR_MARK_INTERVAL` frames (~30), mark the
  encoded frame as a long-term reference via the NVENC LTR API
  (`NV_ENC_PIC_PARAMS.codecPicParams` LTR mark, `ltrMarkFrameIdx`); keep the last 2 marked
  LTR indices. On `L`, encode with `ltrUseFrameBitmap` referencing the OLDER kept LTR
  (the "recovery" reference). If no LTR has been marked yet (stream just started), fall
  back to a forced IDR.
- Keep the periodic IDR (`--gop 120`) as the baseline so a fresh joiner / the 2s safety
  net is unchanged.
- Verify standalone: the `.h264`/`.h265` decodes clean in ffmpeg; after an `L`, the
  recovery frame is a P (not I) and is a fraction of an IDR's size; drop a frame in a test
  harness and confirm the `L` recovery frame re-syncs the decoder.

NB: NVENC LTR works for H.264, HEVC and AV1 (SDK LTR API), so it covers our H.264 + H.265
paths.

## Sender wiring (Mac — L2, DONE)

`FrameSource.ltrRecover()` (frameSource.ts): `CapturerFrameSource` writes `L`;
ffmpeg/synthetic fall back to `forceKeyframe()`. `sender/index.ts` PLI handler:
`VIDEO_LTR=1` → answer a PLI with `ltrRecover()`; a repeat PLI within `LTR_ESCALATE_MS`
→ escalate to `forceKeyframe()` (IDR). Default (LTR off) = the proven IDR path,
byte-identical. Committed; typecheck + units + lint clean.

## Receiver (Mac — L3)

**No protocol change** — the receiver keeps sending PLIs on loss and decoding whatever
frames arrive. An LTR-P recovery frame is a standard inter frame; VideoToolbox decodes it
IF it retained the referenced LTR in its DPB. **This retention is the one Mac-side risk to
verify** (like we verified intra-refresh was incompatible): a compliant H.264/HEVC decoder
keeps LTR-marked frames, so VideoToolbox SHOULD, but confirm before the joint prerelease.

**De-risk harness (Mac, before WC's L1):** extend the render selftest to use VideoToolbox's
OWN LTR encoder (`kVTCompressionPropertyKey_EnableLTR` + per-frame LTR mark / force-LTR-
refresh, WWDC21 low-latency API) to produce a stream that marks LTRs, SKIPS feeding a few
frames to the decoder (simulate loss), then encodes an LTR-refresh frame — and confirm the
production `Decoder` re-syncs. If VideoToolbox decodes it cleanly, the receiver side is
proven; if not, LTR is VT-incompatible (like intra-refresh) and we keep IDR recovery.

## Rollout (golden rule #1)

1. Mac: sender wiring (DONE) + `--selftest-ltr` decode de-risk.
2. WC: capturer `L` + LTR marking (L1), standalone-verified.
3. Joint prerelease with `VIDEO_LTR=1` (+ `VIDEO_CAPTURER=1`): controller runs the same;
   agent adds `VIDEO_LTR=1`. Measure with `analyze-session.mjs`: hitch recovery-ms should
   DROP (small LTR-P vs big IDR) and the loss CASCADE (back-to-back losses) should vanish
   (no more self-congesting IDR bursts). If VT can't decode LTR-P → keep IDR (env off).
