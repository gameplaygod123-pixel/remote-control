// Turns ffmpeg's raw Annex-B byte stream (off stdout) into whole H.264 access
// units ready to hand to node-datachannel's H264RtpPacketizer.
//
// Two stages, both ported from the measured phase1/ffmpeg-pipe.mjs spike:
//   1. NalSplitter  -- byte stream -> individual NAL units (start codes stripped),
//      correctly spanning chunk boundaries.
//   2. AccessUnitAssembler -- NAL units -> one access unit (frame) per VCL slice,
//      re-emitted WITH 4-byte start codes (the 'LongStartSequence' separator the
//      packetizer expects).
//
// Annex-B carries no length prefix, so a NAL is only known complete once the NEXT
// start code appears; the assembler therefore flushes frame N when frame N's VCL
// slice is delivered (which the splitter can only do once frame N+1's start code
// arrives). That ~1-frame detection latency is inherent to piping `-f h264` and
// was included in the 16.55ms cadence measured in phase1/NOTES #2 -- documented
// here so it isn't "fixed" by accident. Removing it needs an out-of-band framed
// muxer (future work), not a change to this splitter.

import type { VideoCodec } from '../shared/contract'

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

// NAL header layout differs by codec:
//   H.264 (RFC 6184): 1-byte header, type = byte0 & 0x1f (types 1..31).
//   HEVC  (RFC 7798): 2-byte header, type = (byte0 >> 1) & 0x3f (types 0..63).
function nalType(nal: Buffer, codec: VideoCodec): number {
  if (nal.length === 0) return -1
  return codec === 'hevc' ? (nal[0] >> 1) & 0x3f : nal[0] & 0x1f
}

/** VCL (coded picture slice) NAL types -- one per frame in our low-latency
 *  single-slice config, so a VCL NAL marks the end of an access unit.
 *   H.264: 1..5 (1 = non-IDR .. 5 = IDR).
 *   HEVC : 0..31 (all VCL types; TRAIL/RASL/RADL/IDR/CRA/BLA). */
function isVcl(type: number, codec: VideoCodec): boolean {
  return codec === 'hevc' ? type >= 0 && type <= 31 : type >= 1 && type <= 5
}

/** A VCL type that begins a keyframe (decodable entry point).
 *   H.264: IDR = 5.
 *   HEVC : IDR_W_RADL = 19, IDR_N_LP = 20 (our capturer emits IDR keyframes). */
function isKeyframeVcl(type: number, codec: VideoCodec): boolean {
  return codec === 'hevc' ? type === 19 || type === 20 : type === 5
}

/**
 * Streaming Annex-B start-code scanner. Feed it stdout chunks; it returns the NAL
 * units (payload bytes, start code removed) that became complete on this push.
 */
export class NalSplitter {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const nals: Buffer[] = []

    // Locate every start code (00 00 01 or 00 00 00 01) as [offset, codeLen].
    const starts: Array<[number, number]> = []
    let i = 0
    while (i + 3 < this.buf.length) {
      if (this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 1) {
        starts.push([i, 3])
        i += 3
      } else if (
        this.buf[i] === 0 &&
        this.buf[i + 1] === 0 &&
        this.buf[i + 2] === 0 &&
        this.buf[i + 3] === 1
      ) {
        starts.push([i, 4])
        i += 4
      } else {
        i++
      }
    }
    if (starts.length < 2) return nals // need a following start code to close a NAL

    // Emit the NAL between each pair of consecutive start codes; keep the tail
    // from the final start code (an as-yet-unclosed NAL) for the next push.
    for (let s = 0; s < starts.length - 1; s++) {
      const [pos, codeLen] = starts[s]
      const end = starts[s + 1][0]
      const nal = this.buf.subarray(pos + codeLen, end)
      if (nal.length > 0) nals.push(Buffer.from(nal)) // copy: subarray aliases this.buf
    }
    this.buf = Buffer.from(this.buf.subarray(starts[starts.length - 1][0]))
    return nals
  }

  reset(): void {
    this.buf = Buffer.alloc(0)
  }
}

export interface AccessUnit {
  /** The frame, NALs joined with 4-byte start codes (LongStartSequence). */
  data: Buffer
  /** True if this AU contains an IDR slice (a keyframe). */
  keyframe: boolean
}

/**
 * Groups NAL units into access units. Leading parameter/SEI/AUD NALs attach to
 * the frame that follows (H.264 6/7/8/9; HEVC VPS/SPS/PPS 32/33/34 + SEI 39/40 +
 * AUD 35); the frame is flushed the moment its VCL slice arrives. With `-bsf:v
 * dump_extra` / the capturer's in-band params each IDR is preceded by its
 * parameter sets, so a keyframe AU is self-contained (decodable after a
 * mid-stream join / respawn). Codec-aware: pass 'hevc' for the HEVC NAL layout.
 */
export class AccessUnitAssembler {
  private pending: Buffer[] = []
  private hasVcl = false

  constructor(private readonly codec: VideoCodec = 'h264') {}

  push(nal: Buffer): AccessUnit | null {
    const type = nalType(nal, this.codec)
    let flushed: AccessUnit | null = null

    // A VCL while we already hold one means a new AU began without our VCL having
    // flushed (multi-slice / unexpected) -- flush what we have first, defensively.
    if (isVcl(type, this.codec) && this.hasVcl) {
      flushed = this.flush()
    }
    this.pending.push(nal)
    if (isVcl(type, this.codec)) {
      this.hasVcl = true
      // Single slice per frame in our config -> this VCL ends the AU.
      const au = this.flush()
      return flushed ?? au
    }
    return flushed
  }

  private flush(): AccessUnit | null {
    if (this.pending.length === 0) return null
    let keyframe = false
    const parts: Buffer[] = []
    for (const nal of this.pending) {
      if (isKeyframeVcl(nalType(nal, this.codec), this.codec)) keyframe = true
      parts.push(START_CODE, nal)
    }
    this.pending = []
    this.hasVcl = false
    return { data: Buffer.concat(parts), keyframe }
  }

  reset(): void {
    this.pending = []
    this.hasVcl = false
  }
}
