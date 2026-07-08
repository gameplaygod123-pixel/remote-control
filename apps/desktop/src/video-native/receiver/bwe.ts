// Bandwidth estimator (BWE) for the native video receiver — AIMD, loss + jitter.
//
// The native video pc is media-only (no data channel, so no built-in WebRTC BWE /
// REMB), so the Mac receiver estimates congestion ITSELF and steers the SENDER's
// NVENC bitrate over signaling. The capturer accepts a live `B<kbps>` on stdin
// (nvEncReconfigureEncoder, no respawn — WC verified 25→12→45 Mbps), so the loop is:
// receiver measures congestion → AIMD target → signaling `video-bitrate` → agent →
// capturer stdin. See docs/bwe-hevc-plan.md.
//
// Model = AIMD (TCP-style). Each ~1s window: calm link → additive-increase (gentle
// probe up); congested → multiplicative-decrease (back off fast). Congestion = seq-
// gap packet LOSS **or** a frame-pacing JITTER spike — the jitter term is what makes
// this see BUFFERBLOAT (a full link queues + delays AUs long before it drops them;
// v1.27.0-beta.1 used loss only, capped 60 Mbps, and bloated the ~40 Mbps link). The
// ceiling is now 25 Mbps (v1.26.0's proven-smooth target) so BWE can only back OFF
// from a known-good point, never overshoot. Pure + unit-tested (dev/verify-...) — no
// I/O, so the control law is reviewable in isolation (a bad number just changes
// bitrate; it can't crash anything, unlike the native FFI paths).

/** Never starve the encoder below this — a floor keeps the picture decodable even
 *  on a bad link (mirrors the WebRTC x-google-min-bitrate floor from v1.22.0). */
export const BWE_FLOOR_KBPS = 5_000
/**
 * Hard ceiling. Set to **25 Mbps** = v1.26.0's proven-smooth VBR target (its
 * maxrate ~40 Mbps was owner-verified "smooth like Parsec" on this exact link).
 *
 * NOT 60 (the owner's first ask): v1.27.0-beta.1 capped 60 and BUFFERBLOATED — the
 * link is ~40 Mbps, so a 60 Mbps VBR burst filled the queue → AUs arrived late/in
 * clumps → double cursor (local Mac cursor vs the delayed video cursor), higher
 * end-to-end latency, and eventual freeze. Loss-only AIMD never saw it (bloat is
 * DELAY, not packet loss, until the queue finally overflows). Capping at v1.26.0's
 * proven target means BWE's worst case == v1.26.0 (smooth) and it can only back OFF
 * below that on a bad link — it can never overshoot into bloat. The real "Parsec
 * runs 1440p60 at ~3 Mbps" win is H.265 (Feature B, 1.6× efficiency), NOT pushing
 * H.264 higher. See docs/bwe-hevc-plan.md + the WC bufferbloat diagnosis.
 */
export const BWE_CEIL_KBPS = 25_000
/**
 * HEVC ceiling — **15 Mbps**, LOWER than H.264's 25 on purpose. HEVC is ~1.6×
 * more efficient, so HEVC@15 ≈ H.264@25 in quality; capping HEVC at 25 wastes its
 * whole advantage AND caused v1.28.0-beta.1's ~2s freezes: on the owner's
 * Parsec-shared ~35-45 Mbps link, an HEVC VBR burst to maxrate (target×~1.4) at an
 * IDR/scene-change overflowed the queue → seq-gap loss → VideoToolbox stalls on the
 * broken reference until the next periodic IDR (gop 2s) = the "freeze ~2s" WC saw.
 * At 15 the burst stays under the link, so no overflow, no loss, no stall — and it
 * showcases HEVC's low-bitrate win (the reason we added it). WC real-hardware e2e:
 * decode itself is clean (ndc win32 H265 + VideoToolbox proven); only the bitrate
 * was too high for HEVC on this link. Codec-aware because the same 25 stays right
 * for H.264. See docs/bwe-hevc-plan.md + the beta.1 WC diagnosis.
 */
export const BWE_HEVC_CEIL_KBPS = 15_000
/** Start AT the ceiling (= the proven-good point + the capturer's launch bitrate)
 *  so there's no cold-start ramp; BWE only ever backs OFF from here when the link
 *  is congested, then probes back up toward the cap when it clears. */
export const BWE_START_KBPS = 25_000

/** The AIMD ceiling for a codec: HEVC gets the lower 15 Mbps cap (see above). */
export function bweCeilingForCodec(codec: 'h264' | 'hevc'): number {
  return codec === 'hevc' ? BWE_HEVC_CEIL_KBPS : BWE_CEIL_KBPS
}

// Loss thresholds (fraction of a 1s window's expected packets that went missing).
const LOSS_LOW = 0.02 // < 2% sustained -> increase
const LOSS_HIGH = 0.05 // > 5% -> decrease immediately
// Delay signal (bufferbloat): jitter = smoothed AU inter-arrival deviation. A
// saturated link delivers AUs in bursts -> jitter climbs BEFORE any packet loss, so
// this catches congestion earlier than loss alone (the v1.27.0-beta.1 gap). Healthy
// active streaming here measured 3-13ms, so 30ms = a clear queue-buildup signal and
// 18ms = "calm enough to probe up again".
const JITTER_CONGESTION_MS = 30 // > this -> back off (bloat precursor)
const JITTER_PROBE_OK_MS = 18 // must be under this to probe UP
const INCREASE_KBPS = 2_000 // additive-increase step per clean window (~gentle probe)
const DECREASE_FACTOR = 0.85 // multiplicative-decrease on congestion (~15% cut)
/** Hysteresis: don't signal a change smaller than this (avoid thrashing the encoder
 *  / spamming signaling for sub-Mbps wiggles). */
const EMIT_THRESHOLD_KBPS = 1_000

export interface BweUpdate {
  /** The new target bitrate (kbps) after this window's AIMD step. */
  targetKbps: number
  /** Measured packet-loss fraction for the window (0..1). */
  lossFraction: number
  /** True if the target moved > EMIT_THRESHOLD_KBPS since the last emit — the
   *  caller only sends a `video-bitrate` signaling msg when this is set. */
  changed: boolean
}

// Extends a 16-bit RTP sequence number to a monotonic value, wrap-aware, so loss
// math survives the 65535->0 rollover. Tracks the highest extended seq; each new
// packet's extension = highest + shortest signed distance from the current low 16.
class SeqExtender {
  private maxExtended = -1

  extend(seq16: number): number {
    if (this.maxExtended < 0) {
      this.maxExtended = seq16
      return seq16
    }
    const prev16 = this.maxExtended & 0xffff
    let delta = seq16 - prev16
    if (delta > 0x8000)
      delta -= 0x10000 // seq16 is actually behind (reorder near wrap)
    else if (delta < -0x8000) delta += 0x10000 // seq16 is ahead across a wrap
    const extended = this.maxExtended + delta
    if (extended > this.maxExtended) this.maxExtended = extended
    return extended
  }
}

// The AIMD control law, split out so it's trivially testable (feed loss+jitter
// series, assert it backs off on either congestion signal and ramps to the cap
// only when BOTH are calm). Congestion = loss OR high jitter (bufferbloat), which
// is the v1.27.0-beta.1 fix: loss alone missed the delay-only bloat on a full link.
class AimdController {
  private readonly ceil: number
  private target: number
  private lastEmitted: number

  // ceilKbps defaults to the H.264 cap; HEVC passes the lower BWE_HEVC_CEIL_KBPS.
  // Start AT the ceiling so BWE only ever backs off from a known-good point.
  constructor(ceilKbps: number = BWE_CEIL_KBPS) {
    this.ceil = ceilKbps
    this.target = Math.min(BWE_START_KBPS, ceilKbps)
    this.lastEmitted = this.target
  }

  update(lossFraction: number, jitterMs: number | null): BweUpdate {
    const congested =
      lossFraction > LOSS_HIGH || (jitterMs != null && jitterMs > JITTER_CONGESTION_MS)
    const calm = lossFraction < LOSS_LOW && (jitterMs == null || jitterMs < JITTER_PROBE_OK_MS)
    if (congested) {
      // Back off fast on loss OR a jitter spike (queue building = bloat precursor).
      this.target = Math.max(BWE_FLOOR_KBPS, Math.round(this.target * DECREASE_FACTOR))
    } else if (calm && this.target < this.ceil) {
      // Probe back up toward the cap only when both signals are clear.
      this.target = Math.min(this.ceil, this.target + INCREASE_KBPS)
    }
    // In the dead-band (mild loss/jitter): hold — don't oscillate.
    const changed = Math.abs(this.target - this.lastEmitted) >= EMIT_THRESHOLD_KBPS
    if (changed) this.lastEmitted = this.target
    return { targetKbps: this.target, lossFraction, changed }
  }
}

/**
 * Observe RTP sequence numbers, and once per ~1s window (`tick(jitterMs)`) run AIMD
 * on the measured loss + the receiver's frame-pacing jitter (bufferbloat signal) and
 * return the new bitrate target (with a `changed` flag for the caller's hysteresis).
 * Static screens produce NO packets (change-detection capture) → `tick()` returns
 * null → the caller HOLDS the current target (no signal to measure, so don't probe
 * up or back off on silence).
 */
export class BandwidthEstimator {
  private extender = new SeqExtender()
  private controller: AimdController
  private windowMin = Infinity
  private windowMax = -Infinity
  private count = 0

  // ceilKbps: the AIMD ceiling (H.264 default 25 Mbps; HEVC passes 15). The receiver
  // re-creates the estimator with the codec's ceiling once it detects the codec.
  constructor(ceilKbps: number = BWE_CEIL_KBPS) {
    this.controller = new AimdController(ceilKbps)
  }

  /** Feed the 16-bit RTP sequence number of one received MEDIA packet (skip RTCP). */
  observe(seq16: number): void {
    const ext = this.extender.extend(seq16)
    if (ext < this.windowMin) this.windowMin = ext
    if (ext > this.windowMax) this.windowMax = ext
    this.count += 1
  }

  /** Close the window: loss = 1 - received/expected across [min..max] seq, plus the
   *  receiver's current smoothed `jitterMs` (bufferbloat signal; null when idle/
   *  unknown). Returns the AIMD result, or null if no packets arrived (idle → hold). */
  tick(jitterMs: number | null): BweUpdate | null {
    if (this.count === 0) return null
    const expected = this.windowMax - this.windowMin + 1
    // Reorder/dup can push count slightly past expected -> clamp to [0,1].
    const lossFraction =
      expected > 0 ? Math.max(0, Math.min(1, (expected - this.count) / expected)) : 0
    this.windowMin = Infinity
    this.windowMax = -Infinity
    this.count = 0
    return this.controller.update(lossFraction, jitterMs)
  }
}
