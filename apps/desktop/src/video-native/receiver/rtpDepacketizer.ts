// RTP -> Annex-B access-unit reassembly for the receiver (H.264 + HEVC).
//
// node-datachannel 0.32.3 ships H264/H265RtpPacketizer (send) but NO depacketizer,
// and RtcpReceivingSession only handles RTCP -- so a RecvOnly track's onMessage()
// delivers raw RTP packets and WE reassemble them. This is the exact inverse of the
// sender's H26xRtpPacketizer('LongStartSequence') and mirrors sender/nalSplitter.ts
// in shape + testability (pure, no I/O).
//
// Codec-aware because the RTP payload formats differ:
//   H.264 (RFC 6184): 1-byte NAL header, type = b0 & 0x1f; single NAL (1-23),
//     STAP-A aggregation (24), FU-A fragmentation (28).
//   HEVC  (RFC 7798): 2-byte NAL header, type = (b0 >> 1) & 0x3f; single NAL (0-47),
//     AP aggregation (48), FU fragmentation (49). FU header is 1 byte AFTER the
//     2-byte PayloadHdr; the original NAL header is rebuilt from PayloadHdr + FuType.
// Output is an Annex-B elementary stream (00 00 00 01 start codes) -- exactly what
// the Swift decoder consumes and a VideoToolbox CMSampleBuffer is built from.

import type { VideoCodec } from '../shared/contract'

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

export interface AccessUnit {
  /** Annex-B bytes: one or more (start-code + NAL) for a single frame. */
  data: Buffer
  /** True if this AU carries a keyframe / decodable entry point (H.264 IDR 5 or
   *  SPS 7; HEVC IDR 19/20 or VPS/SPS 32/33). first-frame + keyframe-need logic. */
  keyframe: boolean
}

/** RTCP compound packets share the track's onMessage with RTP; PT 200-206 lives
 *  in byte[1] (no marker bit on RTCP), RTP media PT (96) does not. Route with this. */
export function isRtcp(pkt: Buffer): boolean {
  if (pkt.length < 2) return false
  const pt = pkt[1]
  return pt >= 200 && pt <= 206
}

/**
 * Codec-aware RTP depacketizer. Construct with the negotiated codec ('h264' default,
 * 'hevc' when the offer advertised H265). Reassembles single/aggregated/fragmented
 * RTP packets into whole Annex-B access units.
 */
export class RtpDepacketizer {
  private fuBuffer: Buffer[] = []
  private auNals: Buffer[] = []
  private auKeyframe = false
  private curTimestamp = -1
  private started = false
  private readonly hevc: boolean

  constructor(codec: VideoCodec = 'h264') {
    this.hevc = codec === 'hevc'
  }

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

    if (this.hevc) this.pushHevc(payload)
    else this.pushH264(payload)

    // Marker bit = last packet of this frame -> the access unit is complete.
    if (marker) {
      const au = this.flushAu()
      if (au) out.push(au)
    }
    return out
  }

  private pushH264(payload: Buffer): void {
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
      if (payload.length < 3) return
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
  }

  private pushHevc(payload: Buffer): void {
    if (payload.length < 2) return
    const nalType = (payload[0] >> 1) & 0x3f
    if (nalType <= 47) {
      // Single NAL: the payload IS the NAL (2-byte header included).
      this.addNal(payload)
    } else if (nalType === 48) {
      // AP (aggregation): [2-byte PayloadHdr][ (2-byte size)(NAL) ]... (no DONL --
      // we never signal sprop-max-don-diff, so there is no DON field).
      let p = 2
      while (p + 2 <= payload.length) {
        const size = payload.readUInt16BE(p)
        p += 2
        if (size === 0 || p + size > payload.length) break
        this.addNal(payload.subarray(p, p + size))
        p += size
      }
    } else if (nalType === 49) {
      // FU: [2-byte PayloadHdr][1-byte FU header][fragment]. Rebuild the original
      // 2-byte NAL header from the PayloadHdr (keep F + layer/tid) with FuType.
      if (payload.length < 4) return
      const fuHeader = payload[2]
      const start = (fuHeader & 0x80) !== 0
      const end = (fuHeader & 0x40) !== 0
      const fuType = fuHeader & 0x3f
      if (start) {
        const h0 = (payload[0] & 0x81) | (fuType << 1)
        this.fuBuffer = [Buffer.from([h0, payload[1]])]
      }
      if (this.fuBuffer.length > 0) {
        this.fuBuffer.push(payload.subarray(3))
        if (end) {
          this.addNal(Buffer.concat(this.fuBuffer))
          this.fuBuffer = []
        }
      }
    }
  }

  private addNal(nal: Buffer): void {
    if (nal.length === 0) return
    if (this.hevc) {
      if (nal.length >= 2) {
        const t = (nal[0] >> 1) & 0x3f
        if (t === 19 || t === 20 || t === 32 || t === 33) this.auKeyframe = true // IDR / VPS / SPS
      }
    } else {
      const t = nal[0] & 0x1f
      if (t === 5 || t === 7) this.auKeyframe = true // IDR slice or SPS
    }
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

/** Back-compat alias: the H.264 depacketizer is the codec-aware one fixed to h264. */
export class H264Depacketizer extends RtpDepacketizer {
  constructor() {
    super('h264')
  }
}

/** Factory the receiver uses once it knows the codec (from the offer SDP). */
export function createDepacketizer(codec: VideoCodec): RtpDepacketizer {
  return new RtpDepacketizer(codec)
}
