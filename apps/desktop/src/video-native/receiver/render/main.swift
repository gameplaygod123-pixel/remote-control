// video-native receiver — Swift render binary.
//
// Driven by the Node receiver helper (receiver/index.ts). The native render half:
// depacketized H.264 access units -> VideoToolbox HW decode -> present via
// AVSampleBufferVideoRenderer in a borderless, click-through NSWindow placed over
// the Electron session view. Removes the <video>/compositor latency wall
// (native-video-plan §3a).
//
// I/O contract with the Node helper (see receiver/render/README.md):
//   stdin  (fd 0): length-prefixed Annex-B access units -- [4-byte BE length][AU].
//   fd 3  (control): line JSON -- {"cmd":"render-rect",x,y,width,height,scale}
//                    (screen points, top-left origin) / {"cmd":"stop"}.
//   stdout (fd 1): line JSON events -- {"evt":"ready"} / {"evt":"first-frame"} /
//                  {"evt":"stats",...}.
//   stderr (fd 2): human logs.
//
// `--selftest` runs the same decode+present path against internally-encoded
// synthetic frames (no window, no stdin), the way the sender's SyntheticFrameSource
// verifies headlessly. Visible pixels are confirmed by the owner in windowed mode.

import Foundation
import AVFoundation
import CoreMedia
import VideoToolbox
import AppKit

// ─────────────────────────── event / log I/O ───────────────────────────
let outHandle = FileHandle.standardOutput
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj),
        let s = String(data: d, encoding: .utf8) else { return }
  outLock.lock(); outHandle.write((s + "\n").data(using: .utf8)!); outLock.unlock()
}
func logErr(_ s: String) {
  FileHandle.standardError.write(("[render] " + s + "\n").data(using: .utf8)!)
}

// Big-endian u32 read without alignment assumptions.
@inline(__always) func be32(_ b: UnsafeRawBufferPointer, _ i: Int) -> Int {
  (Int(b[i]) << 24) | (Int(b[i+1]) << 16) | (Int(b[i+2]) << 8) | Int(b[i+3])
}

// ─────────────────────── H.264 sample-buffer plumbing ───────────────────────
final class Decoder {
  private var formatDesc: CMVideoFormatDescription?
  private var sps: Data?
  private var pps: Data?
  private var firstFrame = false
  var onFirstFrame: (() -> Void)?
  var onSample: ((CMSampleBuffer) -> Void)?

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
        if st == noErr { formatDesc = fd } else { logErr("fmt desc failed \(st)") }
      }
    }
  }

  func push(_ au: Data) {
    let bytes = [UInt8](au)
    var picture: [[UInt8]] = []
    for slice in splitNALs(bytes) {
      guard let first = slice.first else { continue }
      switch first & 0x1f {
      case 7: sps = Data(slice); rebuildFormatDesc()
      case 8: pps = Data(slice); rebuildFormatDesc()
      case 9: break
      default: picture.append(Array(slice))
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

// ─────────────────────────── length-prefixed stdin reader ───────────────────────────
func readExact(_ fd: Int32, _ n: Int) -> Data? {
  if n == 0 { return Data() }
  var buf = Data(); buf.reserveCapacity(n)
  var tmp = [UInt8](repeating: 0, count: 65536)
  while buf.count < n {
    let want = min(n - buf.count, tmp.count)
    let got = tmp.withUnsafeMutableBytes { read(fd, $0.baseAddress, want) }
    if got <= 0 { return nil }
    buf.append(contentsOf: tmp[0..<got])
  }
  return buf
}

// ─────────────────────────── AVCC/format-desc -> Annex-B (selftest helper) ───────────────────────────
func sampleToAnnexB(_ sample: CMSampleBuffer, keyframe: Bool) -> Data {
  var out = Data()
  if keyframe, let fmt = CMSampleBufferGetFormatDescription(sample) {
    var setCount = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0,
      parameterSetPointerOut: nil, parameterSetSizeOut: nil,
      parameterSetCountOut: &setCount, nalUnitHeaderLengthOut: nil)
    for i in 0..<setCount {
      var ptr: UnsafePointer<UInt8>?
      var size = 0
      if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i,
          parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
          parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = ptr {
        out.append(contentsOf: [0, 0, 0, 1])
        out.append(UnsafeBufferPointer(start: p, count: size))
      }
    }
  }
  if let bb = CMSampleBufferGetDataBuffer(sample) {
    var len = 0
    var dp: UnsafeMutablePointer<Int8>?
    if CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil,
        totalLengthOut: &len, dataPointerOut: &dp) == kCMBlockBufferNoErr, let p = dp {
      p.withMemoryRebound(to: UInt8.self, capacity: len) { u8 in
        let raw = UnsafeRawBufferPointer(start: u8, count: len)
        var i = 0
        while i + 4 <= len {
          let nl = be32(raw, i); i += 4
          if nl <= 0 || i + nl > len { break }
          out.append(contentsOf: [0, 0, 0, 1])
          out.append(UnsafeBufferPointer(start: u8 + i, count: nl))
          i += nl
        }
      }
    }
  }
  return out
}

func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
  guard let arr = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
        CFArrayGetCount(arr) > 0 else { return true }
  let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary.self)
  let key = Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
  guard CFDictionaryContainsKey(dict, key) else { return true }
  let val = unsafeBitCast(CFDictionaryGetValue(dict, key), to: CFBoolean.self)
  return !CFBooleanGetValue(val)
}

// ─────────────────────────── selftest (headless) ───────────────────────────
func runSelftest() {
  let W = 1920, H = 1080, FRAMES = 120, FPS = 60
  logErr("selftest \(W)x\(H) @\(FPS) x\(FRAMES)")
  let renderer = AVSampleBufferDisplayLayer().sampleBufferRenderer
  let decoder = Decoder()
  var decoded = 0
  decoder.onFirstFrame = { emit(["evt": "first-frame"]) }
  decoder.onSample = { sb in renderer.enqueue(sb); decoded += 1 }

  var comp: VTCompressionSession?
  VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(W), height: Int32(H),
    codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil,
    compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &comp)
  guard let enc = comp else { emit(["evt": "fatal", "message": "no encoder"]); return }
  VTSessionSetProperty(enc, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
  VTSessionSetProperty(enc, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
  VTSessionSetProperty(enc, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 60 as CFNumber)

  for f in 0..<FRAMES {
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, W, H, kCVPixelFormatType_32BGRA,
      [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &pb)
    guard let pixel = pb else { continue }
    CVPixelBufferLockBaseAddress(pixel, [])
    if let base = CVPixelBufferGetBaseAddress(pixel) {
      memset(base, Int32(f & 0xff), CVPixelBufferGetBytesPerRow(pixel) * H)
    }
    CVPixelBufferUnlockBaseAddress(pixel, [])
    VTCompressionSessionEncodeFrame(enc, imageBuffer: pixel,
      presentationTimeStamp: CMTime(value: Int64(f), timescale: Int32(FPS)),
      duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { st, _, sample in
        guard st == noErr, let s = sample else { return }
        let au = sampleToAnnexB(s, keyframe: isKeyframe(s))
        decoder.push(au)
    }
  }
  VTCompressionSessionCompleteFrames(enc, untilPresentationTimeStamp: .invalid)
  usleep(300_000)
  emit(["evt": "selftest-result", "decoded": decoded, "ok": decoded > 0])
  logErr("selftest decoded \(decoded)/\(FRAMES)")
}

// ─────────────────────────── windowed mode ───────────────────────────
final class RenderApp: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var renderer: AVSampleBufferVideoRenderer!
  let decoder = Decoder()

  func build() {
    let layer = AVSampleBufferDisplayLayer()
    layer.videoGravity = .resize
    renderer = layer.sampleBufferRenderer
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
    view.wantsLayer = true
    view.layer = layer
    // Borderless, transparent, click-through overlay -- mouse passes to Electron
    // beneath so input capture is unaffected (the whole point of §3a).
    window = NSWindow(contentRect: view.frame, styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.contentView = view
    window.orderFrontRegardless()

    decoder.onFirstFrame = { emit(["evt": "first-frame"]) }
    decoder.onSample = { [weak self] sb in
      DispatchQueue.main.async { self?.renderer.enqueue(sb) }
    }
    emit(["evt": "ready"])
    startStdinReader()
    startControlReader()
  }

  func setRenderRect(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ scale: Double) {
    // Incoming: top-left origin screen points. NSWindow uses bottom-left origin.
    guard let screen = NSScreen.screens.first else { return }
    let flippedY = screen.frame.height - y - h
    DispatchQueue.main.async {
      self.window.setFrame(NSRect(x: x, y: flippedY, width: w, height: h), display: true)
    }
  }

  private func startStdinReader() {
    Thread.detachNewThread {
      while true {
        guard let head = readExact(0, 4) else { break }
        let len = head.withUnsafeBytes { be32($0, 0) }
        if len <= 0 { continue }
        guard let au = readExact(0, len) else { break }
        self.decoder.push(au)
      }
      logErr("stdin closed -- exiting")
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  private func startControlReader() {
    Thread.detachNewThread {
      let fh = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
      var acc = Data()
      while true {
        let chunk = fh.availableData
        if chunk.isEmpty { break }
        acc.append(chunk)
        while let nl = acc.firstIndex(of: 0x0a) {
          let line = acc.subdata(in: acc.startIndex..<nl)
          acc.removeSubrange(acc.startIndex...nl)
          self.handleControl(line)
        }
      }
    }
  }

  private func handleControl(_ line: Data) {
    guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          let cmd = obj["cmd"] as? String else { return }
    switch cmd {
    case "render-rect":
      let x = obj["x"] as? Double ?? 0, y = obj["y"] as? Double ?? 0
      let w = obj["width"] as? Double ?? 640, h = obj["height"] as? Double ?? 360
      let s = obj["scale"] as? Double ?? 1
      setRenderRect(x, y, w, h, s)
    case "stop":
      DispatchQueue.main.async { NSApp.terminate(nil) }
    default: break
    }
  }
}

// ─────────────────────────── entry ───────────────────────────
if CommandLine.arguments.contains("--selftest") {
  runSelftest()
} else {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory) // no Dock icon; still shows windows
  let delegate = RenderApp()
  app.delegate = delegate
  delegate.build()
  app.run()
}
