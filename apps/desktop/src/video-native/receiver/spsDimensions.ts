// Minimal H.264 SPS parser -- extracts the coded picture width/height (with
// frame-cropping applied) from an Annex-B access unit so the native receiver can
// report the real resolution in the HUD. ndc/VideoToolbox know the size but never
// surface it back to Node; the SPS is right there in the in-band parameter sets
// (the sender emits them every GOP via -bsf:v dump_extra), so we read it locally.
//
// Only the fields up to frame_cropping are decoded; anything after (VUI etc.) is
// ignored. 4:2:0 8-bit is the only chroma the pipeline ever negotiates, but the
// crop-unit math handles the general case defensively.

// Strip H.264 emulation-prevention bytes (00 00 03 -> 00 00) so the raw RBSP can
// be Exp-Golomb decoded.
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length)
  let o = 0
  let zeros = 0
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i]
    if (zeros >= 2 && b === 0x03 && i + 1 < nal.length && nal[i + 1] <= 0x03) {
      zeros = 0
      continue // drop the emulation_prevention_three_byte
    }
    out[o++] = b
    zeros = b === 0x00 ? zeros + 1 : 0
  }
  return out.subarray(0, o)
}

// Bit reader over an RBSP with unsigned/signed Exp-Golomb.
class BitReader {
  private pos = 0
  constructor(private readonly buf: Uint8Array) {}
  bit(): number {
    const byte = this.buf[this.pos >> 3] ?? 0
    const b = (byte >> (7 - (this.pos & 7))) & 1
    this.pos++
    return b
  }
  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v >>> 0
  }
  ue(): number {
    let zeros = 0
    while (this.pos < this.buf.length * 8 && this.bit() === 0) zeros++
    if (zeros === 0) return 0
    return (1 << zeros) - 1 + this.bits(zeros)
  }
  se(): number {
    const k = this.ue()
    return k & 1 ? (k + 1) >> 1 : -(k >> 1)
  }
}

function parseSps(rbsp: Uint8Array): { width: number; height: number } | null {
  const r = new BitReader(rbsp)
  const profileIdc = r.bits(8)
  r.bits(8) // constraint flags + reserved
  r.bits(8) // level_idc
  r.ue() // seq_parameter_set_id

  let chromaFormatIdc = 1 // 4:2:0 default
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = r.ue()
    if (chromaFormatIdc === 3) r.bit() // separate_colour_plane_flag
    r.ue() // bit_depth_luma_minus8
    r.ue() // bit_depth_chroma_minus8
    r.bit() // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) return null // seq_scaling_matrix_present -- rare for nvenc; bail rather than misparse
  }

  r.ue() // log2_max_frame_num_minus4
  const picOrderCntType = r.ue()
  if (picOrderCntType === 0) {
    r.ue() // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.bit() // delta_pic_order_always_zero_flag
    r.se() // offset_for_non_ref_pic
    r.se() // offset_for_top_to_bottom_field
    const n = r.ue()
    for (let i = 0; i < n; i++) r.se()
  }

  r.ue() // max_num_ref_frames
  r.bit() // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbs = r.ue() + 1
  const picHeightInMapUnits = r.ue() + 1
  const frameMbsOnly = r.bit()
  if (!frameMbsOnly) r.bit() // mb_adaptive_frame_field_flag
  r.bit() // direct_8x8_inference_flag

  let width = picWidthInMbs * 16
  let height = (2 - frameMbsOnly) * picHeightInMapUnits * 16

  if (r.bit()) {
    // frame_cropping_flag
    const cl = r.ue()
    const cr = r.ue()
    const ct = r.ue()
    const cb = r.ue()
    const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
    const subH = chromaFormatIdc === 1 ? 2 : 1
    const cropUnitX = chromaFormatIdc === 0 ? 1 : subW
    const cropUnitY = (chromaFormatIdc === 0 ? 1 : subH) * (2 - frameMbsOnly)
    width -= (cl + cr) * cropUnitX
    height -= (ct + cb) * cropUnitY
  }

  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return null
  return { width, height }
}

// Scan an Annex-B access unit for the first SPS NAL (type 7) and return its coded
// dimensions, or null if none/parse fails.
export function spsDimensions(au: Buffer): { width: number; height: number } | null {
  const n = au.length
  let i = 0
  while (i + 2 < n) {
    // Find a start code (00 00 01; the 4-byte 00 00 00 01 matches on its last 3).
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      const nalStart = i + 3
      if (nalStart < n && (au[nalStart] & 0x1f) === 7) {
        // The NAL runs until the next start code, or to the end of the buffer if
        // this SPS is the last NAL (don't truncate the trailing bytes).
        let j = nalStart + 1
        while (j + 2 < n && !(au[j] === 0 && au[j + 1] === 0 && au[j + 2] === 1)) j++
        const end = j + 2 < n ? j : n
        // Skip the 1-byte NAL header, unescape, parse.
        return parseSps(unescapeRbsp(au.subarray(nalStart + 1, end)))
      }
      i = nalStart
    } else {
      i++
    }
  }
  return null
}
