// Bandwidth estimator (BWE) for the native video receiver — AIMD, loss-based.
//
// The native video pc is media-only (no data channel, so no built-in WebRTC BWE /
// REMB), so the Mac receiver estimates congestion ITSELF from RTP sequence-number
// gaps and steers the SENDER's NVENC bitrate over signaling. The capturer already
// accepts a live `B<kbps>` on stdin (nvEncReconfigureEncoder, no respawn — WC
// verified 25→12→45 Mbps), so the loop is: receiver measures loss → AIMD target →
// signaling `video-bitrate` → agent → capturer stdin. See docs/bwe-hevc-plan.md.
//
// Model = AIMD (the classic TCP / loss-based congestion controller). Each ~1s
// window: clean link → additive-increase (gentle probe up); lossy → multiplicative-
// decrease (back off fast). Clamped to [FLOOR, CEIL]. Owner: cap 60 Mbps like
// Parsec. Pure + unit-tested (dev/verify-units) — no I/O, so the control law is
// reviewable in isolation before it ever touches the encoder (a bad number just
// changes bitrate; it can't crash anything, unlike the native FFI paths).

/** Never starve the encoder below this — a floor keeps the picture decodable even
 *  on a bad link (mirrors the WebRTC x-google-min-bitrate floor from v1.22.0). */
export const BWE_FLOOR_KBPS = 5_000
/** Hard ceiling. Owner: "Max ไม่เกิน 60" (Parsec-like). BWE never targets above this. */
export const BWE_CEIL_KBPS = 60_000
/** Initial target — matches DEFAULT_VIDEO_CONFIG.startBitrateKbps so the first
 *  window doesn't yank the capturer off its launch bitrate. */
export const BWE_START_KBPS = 25_000

// Loss thresholds (fraction of a 1s window's expected packets that went missing).
const LOSS_LOW = 0.02 // < 2% sustained -> increase
const LOSS_HIGH = 0.05 // > 5% -> decrease immediately
const INCREASE_KBPS = 2_000 // additive-increase step per clean window (~gentle probe)
const DECREASE_FACTOR = 0.85 // multiplicative-decrease on loss (~15% cut)
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

// The AIMD control law, split out so it's trivially testable (feed a loss series,
// assert the target ramps to the cap when clean and backs off on loss).
class AimdController {
  private target = BWE_START_KBPS
  private lastEmitted = BWE_START_KBPS

  update(lossFraction: number): BweUpdate {
    if (lossFraction > LOSS_HIGH) {
      this.target = Math.max(BWE_FLOOR_KBPS, Math.round(this.target * DECREASE_FACTOR))
    } else if (lossFraction < LOSS_LOW && this.target < BWE_CEIL_KBPS) {
      this.target = Math.min(BWE_CEIL_KBPS, this.target + INCREASE_KBPS)
    }
    // Between LOW..HIGH: hold (a small, tolerable amount of loss — don't oscillate).
    const changed = Math.abs(this.target - this.lastEmitted) >= EMIT_THRESHOLD_KBPS
    if (changed) this.lastEmitted = this.target
    return { targetKbps: this.target, lossFraction, changed }
  }
}

/**
 * Observe RTP sequence numbers, and once per ~1s window (`tick()`) run AIMD on the
 * measured loss and return the new bitrate target (with a `changed` flag for the
 * caller's hysteresis). Static screens produce NO packets (change-detection capture)
 * → `tick()` returns null → the caller HOLDS the current target (no signal to
 * measure, so don't probe up or back off on silence).
 */
export class BandwidthEstimator {
  private extender = new SeqExtender()
  private controller = new AimdController()
  private windowMin = Infinity
  private windowMax = -Infinity
  private count = 0

  /** Feed the 16-bit RTP sequence number of one received MEDIA packet (skip RTCP). */
  observe(seq16: number): void {
    const ext = this.extender.extend(seq16)
    if (ext < this.windowMin) this.windowMin = ext
    if (ext > this.windowMax) this.windowMax = ext
    this.count += 1
  }

  /** Close the window: loss = 1 - received/expected across [min..max] seq. Returns
   *  the AIMD result, or null if no packets arrived this window (idle → hold). */
  tick(): BweUpdate | null {
    if (this.count === 0) return null
    const expected = this.windowMax - this.windowMin + 1
    // Reorder/dup can push count slightly past expected -> clamp to [0,1].
    const lossFraction =
      expected > 0 ? Math.max(0, Math.min(1, (expected - this.count) / expected)) : 0
    this.windowMin = Infinity
    this.windowMax = -Infinity
    this.count = 0
    return this.controller.update(lossFraction)
  }
}
