# Step 4: FEC — silent loss repair (the last gap to Parsec)

Prepared as the "big work" fallback if the cheap VBV-shrink experiment isn't enough.
Read [`parsec-parity-research.md`](parsec-parity-research.md) first for the gap analysis.

## Why FEC — the decisive Parsec measurement

WC measured **Parsec itself** on the SAME link during a high-motion video (2026-07-08):
FPS locked 60 (min 58.2, **0 dips <55**), no latency spikes — **even though Parsec ALSO
experienced loss** (its loss counter moved). If the loss were a true external ~90ms link
blackout, Parsec would dip too. It doesn't. So:

- **Parsec's smoothness comes from FEC** (proactive redundancy): it repairs lost packets
  from parity immediately, with NO round-trip → no hitch per loss.
- **Ours is reactive** (PLI → recovery frame → ~1 RTT) → every loss = one hitch. LTR only
  makes each hitch cheaper; it can't remove the round-trip. (LTR e2e proved this: it was
  WORSE than fast-IDR on our loss pattern — 654ms avg vs 53ms — because a blackout wipes
  the LTR it references and, with no ACK, recovery falls back to IDR ~1s later.)

## The two-layer plan (order matters)

**Layer 1 — make losses SCATTERED (before FEC): shrink the encoder VBV.** Our 130–163-
packet loss BURSTS are **self-induced**: we emit big frames (IDR / motion / recovery
frames), and when one coincides with a moment of link contention the whole burst is
dropped. Parsec never bursts that big (small, paced, VBV≈1-frame frames), so the same
contention costs it only a few scattered packets — which FEC recovers. Fix: NVENC VBV
buffer ~250ms → ~2 frames (guide §4.1 "VBV = 1 frame"), capping per-frame size. This is a
capturer one-liner (WC) and the **precondition for FEC** — FEC cannot recover a total
150-packet blackout (the parity is in the same dark window); it only recovers scattered
loss. **Do this first + measure** (`analyze-session.mjs`: lostpkts/event should fall from
130-160 to single digits). It may cut the judder enough on its own.

**Layer 1 — implementation status (2026-07-08): BUILT both ends, A/B armed, awaiting the run.**
- ✅ **WC done + pushed (commit `95177e1`)** — capturer C++ `--vbv-ms <ms>` wired to
  `NvEncConfig.vbvMs` (used by BOTH Init and the live BWE `SetBitrate` reconfigure → a
  bitrate retune keeps the small buffer). Precedence: **CLI default `250` (byte-identical)
  → `--vbv-ms` → tune-file `vbv=` / env `VIDEO_CAPTURER_VBV_MS`** (the last two override, so
  the owner A/Bs without a rebuild). Init/encode log now prints the vbv ms.
  **Standalone proof (2560×1440, gop 120, VBR 25/35), max single frame:** H.264 291KB→122KB
  (**2.4×** smaller burst @ vbv 33), HEVC 223KB→121KB (**1.85×**); frame counts identical
  (360 = 3 IDR / 357 P) at both = no structural change, still valid Annex-B.
- ✅ **Mac done** (`capturerArgs.ts`, this commit): `--vbv-ms` in the reviewable CLI contract
  + `NVENC_VBV_MS = 250`. **Default stays 250 (byte-identical) — we do NOT bake the unvalidated
  33 into a build.** The A/B runs on the CURRENT build (agent TS doesn't pass `--vbv-ms` yet →
  capturer uses its 250 default) via the tune-file, so nothing needs rebuilding to test. Once
  the analyzer validates the shrink, flip `NVENC_VBV_MS` (or pass `vbvMs` per-tuning) → build a
  prerelease. Unit-tested (default 250 + override) + typecheck clean.
- 🎯 **THE A/B (owner, on the current build — no reinstall):** add `vbv=33` to
  `%LOCALAPPDATA%\pr-capturer-tune.txt` → reconnect (no agent relaunch) → drive the SAME HEVC
  stress video (`VIDEO_CAPTURER=1 VIDEO_CODEC=hevc`, LTR OFF) → Mac runs
  `node scripts/analyze-session.mjs`. Remove the line to fall back to 250.
- 🎯 **PASS if:** lostpkts per loss event **130-163 → single/low-double digits** (scattered, not
  one wire-filling burst = confirms self-induced) **and** hitches / recovery-ms drop. If the
  bursts stay ~130 → it's real EXTERNAL contention → go to Layer 2 FEC. If they shrink → the
  cheap fix closed most of it; then decide if the residual still needs FEC. Watch for a quality
  regression on complex frames (VBV too small); if so sweep `vbv=` up (1-frame..3-frame) to taste.

**Layer 2 — FEC (recover the scattered remainder silently).** Systematic block FEC:
- Sender: for every group of **K** media RTP packets, generate **M** parity packets
  (XOR = recover any 1 lost/group; Reed–Solomon RS(K,M) = recover up to M lost/group —
  needed for small bursts). Send parity inline with a distinct payload type / marker.
- Receiver: on a gap, if `received_data + parity >= K` for the group, **reconstruct** the
  missing packet(s) locally → hand the complete frame to the decoder → NO PLI, no hitch.
  We already hand-roll the depacketizer (`rtpDepacketizer.ts`), so receiver-side FEC
  reconstruction slots in there.
- Overhead: M/K extra bandwidth (~10–30%); make it **adaptive** (raise M when the
  receiver's measured loss rises — we already measure loss for BWE/`LossDetector`).

## ⚠️ THE BLOCKER to resolve first — node-datachannel has no FEC / no raw RTP send

Verified in `node-datachannel@0.32.3` `dist/types/lib/index.d.ts`: `Track` exposes only
`sendMessage` / `sendMessageBinary` (a whole access unit) + `requestKeyframe`. ndc's
`H264/H265RtpPacketizer` does the packetization + RTP send **internally** — the sender
never sees individual RTP packets, and there is **no API to send raw RTP or inject FEC
parity** (only `addRTXCodec` for NACK retransmission, not FEC). So packet-level FEC can't
be bolted on through the current ndc surface. Options, cheapest→biggest:

1. **VBV-shrink alone may suffice** — if Layer 1 makes losses small AND the residual hitch
   is acceptable, FEC may not be needed. Measure before building anything.
2. **Side-channel redundancy over a DATA CHANNEL on the video pc** (medium): add a
   DataChannel to the (currently media-only) native video pc and send parity/redundant
   NAL data there; the receiver reconstructs. Avoids touching ndc's RTP internals but is
   app-level, not true RTP FEC, and needs careful reliability/ordering + its own framing.
3. **Extend the node-datachannel native binding** to expose FEC (libdatachannel has RTP
   building blocks) or raw RTP send (big — a C++ fork of the ndc addon; the "proper" path
   but the largest effort, and re-touches the native layer we keep minimal).
4. **Own the whole media transport** (biggest) — replace ndc's media track with our own
   RTP/UDP + FEC. Loses ndc's NACK/SR/ICE integration; effectively rewriting the transport.

Recommended sequencing: **Layer 1 (VBV) → measure → if needed, prototype option 2**
(data-channel redundancy) as the least-invasive FEC before considering option 3.

## What's already built (loss-recovery stack, for a fresh chat)

- **PLI-on-loss** (`receiver/index.ts`): real-time seq-gap detection → PLI → sender forces
  recovery. Recovery ~53ms (fast-IDR). Shipped in v1.28.0.
- **Reorder-tolerant `LossDetector`** (`receiver/bwe.ts`): holds a gap ~8 packets before
  declaring loss, so reorder ≠ a spurious PLI.
- **BWE** (`receiver/bwe.ts`): AIMD loss+jitter, HEVC cap 15, hold-after-backoff.
- **LTR recovery** (`sender/index.ts` + capturer, gated `VIDEO_LTR=1`, **default OFF**):
  built + VT-decode-verified (119/120) but e2e-WORSE on our blackout pattern → left OFF.
  Keep as a building block for ACK-based LTR + to pair with FEC later. WC's 2 pending
  polish fixes (mark LTR sooner; reference only the older LTR / avoid `used=0x3`) are
  worthwhile IF LTR is revived.
- **Auto-test** (`scripts/analyze-session.mjs` + receiver hitch/loss/pli instrumentation):
  one-command deep-metrics report + SMOOTH/MINOR-JUDDER/FREEZING verdict. Use it to gate
  every experiment.

## Decision gates
1. WC shrinks VBV → owner reruns the stress video → `analyze-session.mjs`.
   - lostpkts/event 130→single digits AND hitches acceptable → **maybe done** (no FEC).
   - losses now scattered but hitches still bug the owner → build FEC (option 2 first).
2. Golden rule #1 throughout: any capturer/transport change ships as a PRERELEASE + real-
   hardware verify before promoting. Measure with the analyzer, not by eye.
