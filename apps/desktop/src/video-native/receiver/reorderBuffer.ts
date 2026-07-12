// Phase C of the NACK-retransmit endgame (docs/step-nack-retransmit.md): a shallow,
// sequence-ordered RTP receive buffer that makes NACK retransmits USEFUL.
//
// The patched libdatachannel RtcpReceivingSession (apps/desktop/native/ndc-nack) now
// emits a Generic NACK on a small forward seq gap, and the Windows sender's
// RtcpNackResponder retransmits the lost packet (~1 RTT ≈ 11ms on this link). But the
// depacketizer processes packets in ARRIVAL order and presents each AU immediately
// (DisplayImmediately=true) -- so a retransmit that arrives ~11ms late lands AFTER the
// frame was already flushed (incomplete) -> useless. This buffer holds packets briefly
// and releases them IN SEQUENCE, so a retransmit fills the hole before the frame is
// handed to the decoder -> the loss is repaired SILENTLY (no PLI, no IDR, no fps dip).
//
// Cost: latency == the hold time, and ONLY when there is a gap. In the common in-order
// case packets drain immediately (0 added latency) -- the "shallow adaptive jitter
// buffer" of the low-latency playbook. A gap larger than maxGap (a blackout, which the
// patch does NOT NACK) is skipped immediately -> the existing PLI->IDR path, no penalty.
//
// Pure + timer-injectable so it unit-tests without real time.

import { SeqExtender } from './bwe'

export interface ReorderBufferCallbacks {
  /** Release one RTP packet to the depacketizer, in strict sequence order. */
  onPacket(pkt: Buffer): void
  /** A gap gave up (the retransmit never came, or it's a blackout): the caller should
   *  PLI + count the hitch. `count` = number of packets skipped. */
  onGap(count: number): void
}

/** Injected so tests drive time deterministically; defaults to the global timers. */
export interface TimerApi {
  set(cb: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const REAL_TIMER: TimerApi = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export interface ReorderBufferOptions {
  /** How long to hold a small gap waiting for the retransmit (~1 RTT + margin). */
  holdMs?: number
  /** Gaps larger than this are blackouts the patch never NACKs -> skip now, don't wait. */
  maxGap?: number
  /** Safety cap on buffered packets before force-skipping (memory bound). */
  maxBuffer?: number
  timers?: TimerApi
}

export class SeqReorderBuffer {
  private buf = new Map<number, Buffer>() // extended seq -> packet
  private ext = new SeqExtender()
  private next = -1 // next extended seq to release; -1 until the first packet
  private timer: unknown = null
  private readonly holdMs: number
  private readonly maxGap: number
  private readonly maxBuffer: number
  private readonly timers: TimerApi

  constructor(
    private readonly cb: ReorderBufferCallbacks,
    opts: ReorderBufferOptions = {}
  ) {
    this.holdMs = opts.holdMs ?? 30
    this.maxGap = opts.maxGap ?? 64
    this.maxBuffer = opts.maxBuffer ?? 256
    this.timers = opts.timers ?? REAL_TIMER
  }

  /** Feed one raw RTP packet (its 16-bit seq + bytes). Releases via onPacket in order. */
  push(seq16: number, pkt: Buffer): void {
    const seq = this.ext.extend(seq16)
    if (this.next < 0) this.next = seq
    if (seq < this.next) return // already released or skipped (dup / retransmit of a skipped hole)
    this.buf.set(seq, pkt)
    this.drain()
  }

  private drain(): void {
    while (this.buf.has(this.next)) {
      const p = this.buf.get(this.next)!
      this.buf.delete(this.next)
      this.next++
      this.cb.onPacket(p)
    }
    if (this.buf.size === 0) {
      this.clearTimer()
      return
    }
    // A gap sits at `next` with packets buffered ahead. Decide: wait (small gap, a
    // retransmit is on the way) or skip now (blackout / buffer too deep).
    const gap = this.minBuffered() - this.next
    if (gap > this.maxGap || this.buf.size > this.maxBuffer) {
      this.skip()
      return
    }
    this.armTimer()
  }

  private minBuffered(): number {
    let min = Infinity
    for (const s of this.buf.keys()) if (s < min) min = s
    return min
  }

  private armTimer(): void {
    if (this.timer !== null) return // already waiting on this gap
    this.timer = this.timers.set(() => {
      this.timer = null
      this.skip()
    }, this.holdMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer)
      this.timer = null
    }
  }

  /** The retransmit didn't arrive (or it's a blackout): jump past the hole, report the
   *  loss, and keep draining (there may be more holes behind more buffered packets). */
  private skip(): void {
    this.clearTimer()
    if (this.buf.size === 0) return
    const minSeq = this.minBuffered()
    if (minSeq <= this.next) {
      this.drain()
      return
    }
    const lost = minSeq - this.next
    this.next = minSeq
    this.cb.onGap(lost)
    this.drain()
  }

  reset(): void {
    this.clearTimer()
    this.buf.clear()
    this.ext = new SeqExtender()
    this.next = -1
  }
}
