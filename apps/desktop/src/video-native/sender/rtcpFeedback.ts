// Parses incoming RTCP (delivered to the sender's send-only track via
// track.onMessage) to detect a keyframe request from the receiver.
//
// Proven in phase1/pli-feedback.mjs: node-datachannel surfaces the receiver's
// RTCP feedback on the SENDER track's onMessage as raw compound RTCP packets.
// requestKeyframe() on the Mac side arrives here as a PLI (PT=206 PSFB, FMT=1);
// that's our cue to force an IDR (respawn ffmpeg). NACK (PT=205 RTPFB) is handled
// automatically by RtcpNackResponder in the send chain -- we only COUNT it here
// for telemetry, we don't act on it.

export interface RtcpFeedback {
  /** Picture Loss Indication count -- the "send a keyframe now" signal. */
  pli: number
  /** Full Intra Request count (also a keyframe request; rarer). */
  fir: number
  /** Generic NACK count (informational; RtcpNackResponder auto-retransmits). */
  nack: number
  /** Distinct RTCP payload types seen (debug aid, e.g. 201=RR, 206=PSFB). */
  payloadTypes: number[]
}

const PT_RTPFB = 205 // Transport-layer feedback (NACK lives here)
const PT_PSFB = 206 // Payload-specific feedback (PLI/FIR live here)

/**
 * Walk a compound RTCP buffer and tally feedback packets. Each RTCP packet's
 * length field is in 32-bit words minus one, so byte length = (len+1)*4.
 * Returns whether at least one keyframe request (PLI or FIR) was present.
 */
export function parseRtcpFeedback(msg: Buffer): RtcpFeedback {
  const fb: RtcpFeedback = { pli: 0, fir: 0, nack: 0, payloadTypes: [] }
  const seenPts = new Set<number>()
  let off = 0
  while (off + 4 <= msg.length) {
    const pt = msg[off + 1]
    const fmt = msg[off] & 0x1f // FMT (feedback message type) in the low 5 bits
    const words = msg.readUInt16BE(off + 2)
    const byteLen = (words + 1) * 4
    seenPts.add(pt)
    if (pt === PT_PSFB && fmt === 1) fb.pli++
    else if (pt === PT_PSFB && fmt === 4) fb.fir++
    else if (pt === PT_RTPFB && fmt === 1) fb.nack++
    if (byteLen <= 0) break // malformed length guard (avoid infinite loop)
    off += byteLen
  }
  fb.payloadTypes = [...seenPts]
  return fb
}

/** True when the receiver asked for a fresh keyframe (PLI or FIR present). */
export function isKeyframeRequest(fb: RtcpFeedback): boolean {
  return fb.pli > 0 || fb.fir > 0
}
