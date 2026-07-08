// Shared H.264 -> CMSampleBuffer decoder for the native receiver.
//
// Compiled into BOTH build outputs of this directory:
//   - the `video-render` selftest binary (main.swift) -- headless verification.
//   - the `librvr.dylib` in-process render surface (embed.swift) -- the real
//     path, loaded by the Electron main process via koffi and composited INSIDE
//     the Electron window (native-video-plan §3a, no separate NSWindow).
//
// Pure decode/plumbing, no window / no I/O -- so the exact same VideoToolbox path
// is exercised by the selftest and by production.

import Foundation
import AVFoundation
import CoreMedia
import VideoToolbox

// Big-endian u32 read without alignment assumptions.
@inline(__always) func be32(_ b: UnsafeRawBufferPointer, _ i: Int) -> Int {
  (Int(b[i]) << 24) | (Int(b[i+1]) << 16) | (Int(b[i+2]) << 8) | Int(b[i+3])
}

enum Codec {
  case h264
  case hevc
}

// Annex-B access unit -> ready-to-enqueue CMSampleBuffer. Rebuilds the format
// description from in-band parameter sets (H.264 SPS/PPS or HEVC VPS/SPS/PPS);
// emits AVCC (4-byte length prefixed) samples tagged DisplayImmediately for the
// lowest-latency present. Codec is set once from the offer SDP before AUs arrive.
final class Decoder {
  private var codec: Codec = .h264
  private var formatDesc: CMVideoFormatDescription?
  private var vps: Data? // HEVC only
  private var sps: Data?
  private var pps: Data?
  private var firstFrame = false
  var onFirstFrame: (() -> Void)?
  var onSample: ((CMSampleBuffer) -> Void)?

  // Switching codec invalidates any format description / parameter sets built for
  // the old one, so clear them (the new stream's params arrive in-band next IDR).
  func setCodec(_ c: Codec) {
    if c == codec { return }
    codec = c
    formatDesc = nil
    vps = nil; sps = nil; pps = nil
  }

  private func splitNALs(_ au: [UInt8]) -> [ArraySlice<UInt8>] {
    var nals: [ArraySlice<UInt8>] = []
    let n = au.count
    func scLen(_ p: Int) -> Int {
      if p + 3 < n, au[p] == 0, au[p+1] == 0, au[p+2] == 0, au[p+3] == 1 { return 4 }
      if p + 2 < n, au[p] == 0, au[p+1] == 0, au[p+2] == 1 { return 3 }
      return 0
    }
    var i = 0
    while i < n, scLen(i) == 0 { i += 1 }
    while i < n {
      let sc = scLen(i)
      if sc == 0 { i += 1; continue }
      let start = i + sc
      var j = start
      while j < n, scLen(j) == 0 { j += 1 }
      if start < j { nals.append(au[start..<j]) }
      i = j
    }
    return nals
  }

  private func rebuildFormatDesc() {
    switch codec {
    case .h264: rebuildH264()
    case .hevc: rebuildHevc()
    }
  }

  private func rebuildH264() {
    guard let sps = sps, let pps = pps else { return }
    sps.withUnsafeBytes { (s: UnsafeRawBufferPointer) in
      pps.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
        let ptrs = [s.bindMemory(to: UInt8.self).baseAddress!,
                    p.bindMemory(to: UInt8.self).baseAddress!]
        let sizes = [sps.count, pps.count]
        var fd: CMFormatDescription?
        let st = ptrs.withUnsafeBufferPointer { pp in
          sizes.withUnsafeBufferPointer { ss in
            CMVideoFormatDescriptionCreateFromH264ParameterSets(
              allocator: kCFAllocatorDefault, parameterSetCount: 2,
              parameterSetPointers: pp.baseAddress!, parameterSetSizes: ss.baseAddress!,
              nalUnitHeaderLength: 4, formatDescriptionOut: &fd)
          }
        }
        if st == noErr { formatDesc = fd }
        else { FileHandle.standardError.write("[decoder] h264 fmt desc failed \(st)\n".data(using: .utf8)!) }
      }
    }
  }

  private func rebuildHevc() {
    // HEVC needs all three parameter sets (VPS+SPS+PPS) to build the format desc.
    guard let vps = vps, let sps = sps, let pps = pps else { return }
    vps.withUnsafeBytes { (v: UnsafeRawBufferPointer) in
      sps.withUnsafeBytes { (s: UnsafeRawBufferPointer) in
        pps.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
          let ptrs = [v.bindMemory(to: UInt8.self).baseAddress!,
                      s.bindMemory(to: UInt8.self).baseAddress!,
                      p.bindMemory(to: UInt8.self).baseAddress!]
          let sizes = [vps.count, sps.count, pps.count]
          var fd: CMFormatDescription?
          let st = ptrs.withUnsafeBufferPointer { pp in
            sizes.withUnsafeBufferPointer { ss in
              CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                allocator: kCFAllocatorDefault, parameterSetCount: 3,
                parameterSetPointers: pp.baseAddress!, parameterSetSizes: ss.baseAddress!,
                nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &fd)
            }
          }
          if st == noErr { formatDesc = fd }
          else { FileHandle.standardError.write("[decoder] hevc fmt desc failed \(st)\n".data(using: .utf8)!) }
        }
      }
    }
  }

  func push(_ au: Data) {
    let bytes = [UInt8](au)
    var picture: [[UInt8]] = []
    switch codec {
    case .h264:
      for slice in splitNALs(bytes) {
        guard let first = slice.first else { continue }
        switch first & 0x1f {
        case 7: sps = Data(slice); rebuildFormatDesc()
        case 8: pps = Data(slice); rebuildFormatDesc()
        case 9: break // AUD
        default: picture.append(Array(slice))
        }
      }
    case .hevc:
      for slice in splitNALs(bytes) {
        guard let first = slice.first else { continue }
        // HEVC NAL type = (byte0 >> 1) & 0x3f. Params: VPS 32 / SPS 33 / PPS 34.
        // Skip AUD 35 + SEI 39/40. VCL 0..31 are coded picture slices.
        let t = (Int(first) >> 1) & 0x3f
        switch t {
        case 32: vps = Data(slice); rebuildFormatDesc()
        case 33: sps = Data(slice); rebuildFormatDesc()
        case 34: pps = Data(slice); rebuildFormatDesc()
        case 35, 39, 40: break // AUD / SEI prefix+suffix
        default:
          if t <= 31 { picture.append(Array(slice)) }
        }
      }
    }
    guard let fmt = formatDesc, !picture.isEmpty else { return }
    guard let sb = makeSampleBuffer(picture, fmt) else { return }
    onSample?(sb)
    if !firstFrame { firstFrame = true; onFirstFrame?() }
  }

  private func makeSampleBuffer(_ nals: [[UInt8]], _ fmt: CMVideoFormatDescription) -> CMSampleBuffer? {
    var avcc = [UInt8]()
    for nal in nals {
      let len = UInt32(nal.count)
      avcc.append(UInt8((len >> 24) & 0xff)); avcc.append(UInt8((len >> 16) & 0xff))
      avcc.append(UInt8((len >> 8) & 0xff)); avcc.append(UInt8(len & 0xff))
      avcc.append(contentsOf: nal)
    }
    let count = avcc.count
    var block: CMBlockBuffer?
    var st = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: count,
      blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
      offsetToData: 0, dataLength: count, flags: 0, blockBufferOut: &block)
    guard st == kCMBlockBufferNoErr, let bb = block else { return nil }
    st = avcc.withUnsafeBytes { raw in
      CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: bb,
        offsetIntoDestination: 0, dataLength: count)
    }
    guard st == kCMBlockBufferNoErr else { return nil }
    var sb: CMSampleBuffer?
    var timing = CMSampleTimingInfo(duration: .invalid,
      presentationTimeStamp: .invalid, decodeTimeStamp: .invalid)
    var sizes = [count]
    let st2 = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault, dataBuffer: bb, formatDescription: fmt,
      sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
      sampleSizeEntryCount: 1, sampleSizeArray: &sizes, sampleBufferOut: &sb)
    guard st2 == noErr, let sample = sb else { return nil }
    if let arr = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
       CFArrayGetCount(arr) > 0 {
      let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(dict,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    return sample
  }
}
