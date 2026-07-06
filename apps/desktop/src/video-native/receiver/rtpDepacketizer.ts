// RTP -> Annex-B H.264 access-unit reassembly for the receiver.
//
// node-datachannel 0.32.3 ships H264RtpPacketizer (send) but NO H.264
// depacketizer, and RtcpReceivingSession only handles RTCP -- so a RecvOnly
// track's onMessage() delivers raw RTP packets and WE reassemble them. This is
// the exact inverse of the sender's H264RtpPacketizer('LongStartSequence') and
// mirrors sender/nalSplitter.ts in shape + testability (pure, no I/O).
//
// Handles the three packetization modes libdatachannel emits: single NAL (types
// 1-23), STAP-A aggregation (24), and FU-A fragmentation (28). Output is an
// Annex-B elementary stream (00 00 00 01 start codes) -- exactly what the Swift
// render binary consumes on stdin, and what a VideoToolbox CMSampleBuffer is
// built from.

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

export interface AccessUnit {
  /** Annex-B bytes: one or more (start-code + NAL) for a single frame. */
  data: Buffer
  /** True if this AU carries an IDR (type 5) or SPS (type 7) -- a decodable
   *  entry point. Used for first-frame + "do we still need a keyframe" logic. */
  keyframe: boolean
}

/** RTCP compound packets share the track's onMessage with RTP; PT 200-206 lives
 *  in byte[1] (no marker bit on RTCP), RTP media PT (96) does not. Route with this. */
export function isRtcp(pkt: Buffer): boolean {
  if (pkt.length < 2) return false
  const pt = pkt[1]
  return pt >= 200 && pt <= 206
}

export class H264Depacketizer {
  private fuBuffer: Buffer[] = []
  private auNals: Buffer[] = []
  private auKeyframe = false
  private curTimestamp = -1
  private started = false

  /** Feed one raw RTP packet; returns any access units completed by it. */
  push(pkt: Buffer): AccessUnit[] {
    if (pkt.length < 12) return []
    const b0 = pkt[0]
    const marker = (pkt[1] & 0x80) !== 0
    const cc = b0 & 0x0f
    const hasExt = (b0 & 0x10) !== 0
    const timestamp = pkt.readUInt32BE(4)

    let off = 12 + cc * 4
    if (hasExt) {
      if (off + 4 > pkt.length) return []
      const extWords = pkt.readUInt16BE(off + 2)
      off += 4 + extWords * 4
    }
    if (off >= pkt.length) return []
    const payload = pkt.subarray(off)

    const out: AccessUnit[] = []
    // A timestamp change delimits an access unit even if a marker bit was lost.
    if (this.started && timestamp !== this.curTimestamp) {
      const au = this.flushAu()
      if (au) out.push(au)
    }
    this.curTimestamp = timestamp
    this.started = true

    const nalType = payload[0] & 0x1f
    if (nalType >= 1 && nalType <= 23) {
      this.addNal(payload)
    } else if (nalType === 24) {
      // STAP-A: [1-byte header][ (2-byte size)(NAL) ]...
      let p = 1
      while (p + 2 <= payload.length) {
        const size = payload.readUInt16BE(p)
        p += 2
        if (size === 0 || p + size > payload.length) break
        this.addNal(payload.subarray(p, p + size))
        p += size
      }
    } else if (nalType === 28) {
      // FU-A: [FU indicator][FU header][fragment]. Reconstruct the NAL header
      // from the indicator's NRI + the FU header's type; reassemble across S..E.
      if (payload.length < 3) return out
      const fuHeader = payload[1]
      const start = (fuHeader & 0x80) !== 0
      const end = (fuHeader & 0x40) !== 0
      const type = fuHeader & 0x1f
      if (start) {
        this.fuBuffer = [Buffer.from([(payload[0] & 0xe0) | type])]
      }
      if (this.fuBuffer.length > 0) {
        this.fuBuffer.push(payload.subarray(2))
        if (end) {
          this.addNal(Buffer.concat(this.fuBuffer))
          this.fuBuffer = []
        }
      }
    }
    // Marker bit = last packet of this frame -> the access unit is complete.
    if (marker) {
      const au = this.flushAu()
      if (au) out.push(au)
    }
    return out
  }

  private addNal(nal: Buffer): void {
    if (nal.length === 0) return
    const t = nal[0] & 0x1f
    if (t === 5 || t === 7) this.auKeyframe = true // IDR slice or SPS
    this.auNals.push(START_CODE, nal)
  }

  private flushAu(): AccessUnit | null {
    if (this.auNals.length === 0) return null
    const data = Buffer.concat(this.auNals)
    const keyframe = this.auKeyframe
    this.auNals = []
    this.auKeyframe = false
    return { data, keyframe }
  }

  reset(): void {
    this.fuBuffer = []
    this.auNals = []
    this.auKeyframe = false
    this.curTimestamp = -1
    this.started = false
  }
}
