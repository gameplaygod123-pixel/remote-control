# Next: BWE auto-bitrate (≤60 Mbps) + H.265 — spec & split

Two follow-ups after v1.26.0 (custom DXGI capturer, locked-60, "smooth like Parsec").
Owner asked (2026-07-08): **auto-bitrate capped at 60 Mbps like Parsec**, and **H.265**
(the one real remaining Parsec differentiator — Parsec runs 1440p60 HEVC at ~3 Mbps).
Both build on the v1.26.0 capturer, which already has the primitives.

Context recap (so a fresh session can start cold):
- Pipeline: Windows `capturer.exe` (DXGI Desktop Duplication + change-detection +
  locked-60 cadence + NVENC) → Annex-B on stdout → TS **video-sender** helper
  (`video-native/sender/`: `NalSplitter`→`AccessUnitAssembler`→RTP over node-datachannel)
  → Mac **video-receiver** (`video-native/receiver/`: JS `rtpDepacketizer` → AU) → Electron
  main → koffi `librvr.dylib` → VideoToolbox → `AVSampleBufferDisplayLayer`.
- Capturer is opt-in `VIDEO_CAPTURER=1` (default OFF = ffmpeg; silent ffmpeg fallback).
- Capturer stdin control already exists: `'I'` = force IDR; **`'B'<ascii-kbps>'\n'` = set
  NVENC VBR bitrate live** (`nvEncReconfigureEncoder`, no respawn — WC verified 25→12→45).
- Capturer CLI already has **`--codec h264|h265`** (WC added it).
- CLI contract + capturer details: [`step3-dxgi-capturer.md`](step3-dxgi-capturer.md).

---

## Feature A — BWE auto-bitrate (AIMD, cap 60 Mbps)

Goal: the sender's bitrate tracks the link like Parsec — ramp up when clean, back off
on loss — instead of a fixed number. Cap **60 Mbps** (owner), floor ~5 Mbps.

### Signal (Mac receiver)
The receiver's `rtpDepacketizer` sees RTP **sequence numbers** → compute **packet-loss
fraction** per ~1s window (count seq gaps / expected). That is the primary congestion
signal (overflow = loss). Secondary: the existing `jitterMs` spike + received-kbps vs
target. (No emitted-fps needed — loss is measured locally from seq gaps.)

### Controller (AIMD, on the Mac — receiver or main)
Every ~1s:
- loss < ~2% sustained (a few windows) **and** current target < cap → **additive
  increase** (e.g. +10% or +2 Mbps, gentle probing).
- loss > ~5% → **multiplicative decrease** (target × ~0.85), immediately.
- Clamp to **[5 Mbps, 60 Mbps]**. Start ~15–20 Mbps and let it ramp.
- Hysteresis / rate-limit changes (don't thrash; only send when the target moved > ~1 Mbps).

### Feedback path (Mac → Windows) — DECIDED: piggyback on **signaling**
The native video pc is media-only (no data channel), so route the target over the
existing **signaling** channel (BWE tolerates ~1–2s latency, doesn't need real-time):
Mac receiver → Mac main → signaling msg `{ type: 'video-bitrate', kbps, channel:
'video-native' }` → relayed to the agent → agent main → **video-sender helper** (IPC)
→ writes **`B<kbps>\n`** to the capturer stdin.

### Work split
- **Mac (next Mac session):** loss estimate in `video-native/receiver/` (seq-gap loss
  fraction), the AIMD controller, emit a bitrate target up to main, send the signaling
  msg. Add the `video-bitrate` message to the signaling protocol
  (`packages/protocol` / signaling-server passthrough — old servers must ignore unknown
  fields, as with `caps`). Unit-test the AIMD (clean→ramp to cap, loss→back off, clamps).
- **Windows (WC):** the agent's **video-sender host/helper** receives the relayed
  `video-bitrate` signaling msg (via agent main → IPC) and **forwards `B<kbps>\n` to the
  capturer stdin** (the capturer side is done). Verify: Mac drives loss (or a forced
  target) → capturer `[capturer]` log shows the retune → bitrate changes live, decode
  clean, no respawn.
- **Both:** the fixed `startBitrateKbps`/`maxBitrateKbps` in `DEFAULT_VIDEO_CONFIG`
  become the initial + the 60 Mbps cap; BWE overrides live.

Golden rule #1: NVENC reconfigure is native — verify on the real RTX before promoting.

---

## Feature B — H.265 (HEVC)

Goal: match Parsec's codec. HEVC ≈1.6× more efficient → same quality at ~half the
bitrate (helps BWE headroom + quality), NOT lower GPU. VideoToolbox on the owner's M4
Pro decodes HEVC in hardware, so it's feasible.

### Capturer (Windows) — mostly done
`--codec h265` exists. Verify it emits valid **HEVC Annex-B**: **VPS+SPS+PPS in-band**
before each IDR, 2-byte NAL headers, IDR every ~2s, decodes clean in VLC/ffplay.

### Sender NAL/AU assembly (TS, runs on the agent) — Mac writes, WC e2e
`video-native/sender/nalSplitter.ts`:
- `NalSplitter` (start-code scan) is codec-agnostic → unchanged. ✓
- `AccessUnitAssembler` is H.264-specific: `nalType = byte & 0x1f`, `isVcl = 1..5`,
  keyframe = type 5. **HEVC:** `nalType = (byte0 >> 1) & 0x3F`, **VCL = 0..31**, IDR =
  **19 (IDR_W_RADL) / 20 (IDR_N_LP)** (keyframe), params VPS=32/SPS=33/PPS=34, AUD=35.
  → make it **codec-aware** (pass the codec in). Unit-test both codecs.

### Receiver decode (Mac Swift) — Mac writes
`video-native/receiver/render/decoder.swift`:
- H.264 path: `CMVideoFormatDescriptionCreateFromH264ParameterSets` from SPS(7)/PPS(8).
- **HEVC path:** collect **VPS(32)+SPS(33)+PPS(34)** →
  `CMVideoFormatDescriptionCreateFromHEVCParameterSets` (3 param sets, `nalUnitHeaderLength:
  4`). NAL type via `(byte0 >> 1) & 0x3F`. AVCC framing (4-byte length) is the same. The
  `spsDimensions.ts` resolution parser is H.264-only → add an HEVC SPS parser or read
  size from the format description.
- `AVSampleBufferDisplayLayer` decodes HEVC natively once the format desc is HEVC.

### Codec negotiation
`DEFAULT_VIDEO_CONFIG.codec` gains `'h265'`; `capturerArgs` passes `--codec`. The receiver
must know the codec: simplest = carry it in the config the receiver already receives (or
auto-detect from the first NAL's HEVC type). Keep H.264 the default; H.265 opt-in first.

### Work split
- **Windows (WC):** verify `--codec h265` HEVC Annex-B output (VPS/SPS/PPS in-band, decodes);
  confirm the sender helper passes `--codec` through; e2e once Mac lands the decoder.
- **Mac (next Mac session):** codec-aware `nalSplitter.ts` (unit-tested), HEVC
  `decoder.swift`, HEVC SPS dimensions (or from fmt desc), codec plumbing/negotiation.

Golden rule #1: HEVC decode is a native/VideoToolbox path — prerelease + real-hardware
verify (both machines) before promoting.

---

## Sequencing
Do **BWE first** (higher impact: stops overflow drops, the capturer half is already done),
then **H.265** (quality/bitrate polish; bigger both-ends change). Each its own prerelease.
