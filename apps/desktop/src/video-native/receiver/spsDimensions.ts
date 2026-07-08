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

// HEVC profile_tier_level -- we only need to SKIP it to reach the picture size.
// general PTL = 96 bits (profile 8 + compat 32 + constraints 48 + level 8); then,
// if there are sub-layers, their present flags + reserved bits + sub-layer PTLs.
function skipHevcPtl(r: BitReader, maxSubLayersMinus1: number): void {
  r.bits(8) // general_profile_space(2)+tier_flag(1)+profile_idc(5)
  r.bits(32) // general_profile_compatibility_flags
  r.bits(32)
  r.bits(16) // 48 bits: source flags (4) + constraint/reserved (44)
  r.bits(8) // general_level_idc
  const subProfile: number[] = []
  const subLevel: number[] = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.bit())
    subLevel.push(r.bit())
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2) // reserved_zero_2bits
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) {
      r.bits(32)
      r.bits(32)
      r.bits(24)
    } // 88 bits
    if (subLevel[i]) r.bits(8)
  }
}

// HEVC SPS (RFC/H.265 §7.3.2.2.1) -> coded picture size with the conformance window
// applied. Only the fields up to conformance_window are decoded.
function parseHevcSps(rbsp: Uint8Array): { width: number; height: number } | null {
  const r = new BitReader(rbsp)
  r.bits(4) // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3)
  r.bit() // sps_temporal_id_nesting_flag
  skipHevcPtl(r, maxSubLayersMinus1)
  r.ue() // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue()
  if (chromaFormatIdc === 3) r.bit() // separate_colour_plane_flag
  let width = r.ue() // pic_width_in_luma_samples
  let height = r.ue() // pic_height_in_luma_samples
  if (r.bit()) {
    // conformance_window_flag
    const l = r.ue()
    const rr = r.ue()
    const t = r.ue()
    const b = r.ue()
    const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
    const subH = chromaFormatIdc === 1 ? 2 : 1
    width -= (l + rr) * subW
    height -= (t + b) * subH
  }
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return null
  return { width, height }
}

// Scan an Annex-B access unit for the first NAL of the given kind and return its
// coded dimensions. `test` selects the SPS by codec, `hdr` is the NAL-header byte
// count to skip before the RBSP.
function scanForSps(
  au: Buffer,
  test: (b0: number) => boolean,
  hdr: number,
  parse: (rbsp: Uint8Array) => { width: number; height: number } | null
): { width: number; height: number } | null {
  const n = au.length
  let i = 0
  while (i + 2 < n) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      const nalStart = i + 3
      if (nalStart < n && test(au[nalStart])) {
        let j = nalStart + 1
        while (j + 2 < n && !(au[j] === 0 && au[j + 1] === 0 && au[j + 2] === 1)) j++
        const end = j + 2 < n ? j : n
        return parse(unescapeRbsp(au.subarray(nalStart + hdr, end)))
      }
      i = nalStart
    } else {
      i++
    }
  }
  return null
}

// Scan an Annex-B access unit for the first H.264 SPS NAL (type 7) and return its
// coded dimensions, or null if none/parse fails.
export function spsDimensions(au: Buffer): { width: number; height: number } | null {
  return scanForSps(au, (b0) => (b0 & 0x1f) === 7, 1, parseSps)
}

// Codec-aware dimensions from the in-band SPS: H.264 SPS type 7 (1-byte header) or
// HEVC SPS type 33 (2-byte header, type = (b0 >> 1) & 0x3f).
export function videoDimensions(
  au: Buffer,
  codec: 'h264' | 'hevc'
): { width: number; height: number } | null {
  if (codec === 'hevc') {
    return scanForSps(au, (b0) => ((b0 >> 1) & 0x3f) === 33, 2, parseHevcSps)
  }
  return spsDimensions(au)
}
