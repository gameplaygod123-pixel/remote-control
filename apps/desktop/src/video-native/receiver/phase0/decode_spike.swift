// Receiver Phase 0-B — self-contained decode + render-path spike (no ffmpeg, no network).
//
// Closed loop that mirrors the REAL receiver's hot path:
//   synthetic BGRA frame
//     -> VTCompressionSession (H.264, low-latency)      = stand-in for the sender
//     -> compressed CMSampleBuffer (this is exactly what RTP->Annex-B will rebuild)
//     -> VTDecompressionSession  (measure DECODE latency, the receiver's real cost)
//     -> AVSampleBufferDisplayLayer.enqueue (the compositor-bypass render target)
//
// Gate: decode latency << 16.6ms/frame budget, and the display layer accepts the
// compressed buffers without going to .failed. (Pixels-on-screen is confirmed
// separately by the owner running the windowed build on the real desktop.)

import Foundation
import VideoToolbox
import AVFoundation
import CoreMedia
import CoreVideo

let W = 1920, H = 1080
let FRAMES = 120
let FPS = 60

func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000.0 }

// A synthetic BGRA pixel buffer, refilled each frame so the encoder can't skip.
func makePixelBuffer() -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  let attrs: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: W,
    kCVPixelBufferHeightKey as String: H,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:]
  ]
  CVPixelBufferCreate(kCFAllocatorDefault, W, H, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb)
  return pb!
}

func fill(_ pb: CVPixelBuffer, frame: Int) {
  CVPixelBufferLockBaseAddress(pb, [])
  defer { CVPixelBufferUnlockBaseAddress(pb, []) }
  guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
  let bpr = CVPixelBufferGetBytesPerRow(pb)
  let ptr = base.assumingMemoryBound(to: UInt8.self)
  for y in 0..<H {
    let row = ptr + y * bpr
    for x in 0..<W {
      let p = row + x * 4
      p[0] = UInt8((x + frame * 3) & 0xff)   // B
      p[1] = UInt8((y + frame * 5) & 0xff)   // G
      p[2] = UInt8((x ^ y ^ frame) & 0xff)   // R
      p[3] = 255
    }
  }
}

// ── Decompression session (built lazily once we have the format description) ──
var decSession: VTDecompressionSession?
var decodeMsSamples: [Double] = []

func ensureDecoder(_ fmt: CMFormatDescription) {
  guard decSession == nil else { return }
  let cb: [String: Any] = [:]
  let dest: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
  ]
  var s: VTDecompressionSession?
  let st = VTDecompressionSessionCreate(
    allocator: kCFAllocatorDefault,
    formatDescription: fmt,
    decoderSpecification: cb as CFDictionary,
    imageBufferAttributes: dest as CFDictionary,
    outputCallback: nil,
    decompressionSessionOut: &s)
  if st != noErr { print("VTDecompressionSessionCreate failed: \(st)"); exit(1) }
  decSession = s
  print("decoder created (HW=\(VTIsHardwareDecodeSupported(kCMVideoCodecType_H264)))")
}

// ── Display layer: the real render target. Enqueue compressed buffers; it decodes+presents. ──
let displayLayer = AVSampleBufferDisplayLayer()
displayLayer.videoGravity = .resizeAspect
var enqueued = 0

// ── Compression session ──
var compSession: VTCompressionSession?
let created = VTCompressionSessionCreate(
  allocator: kCFAllocatorDefault, width: Int32(W), height: Int32(H),
  codecType: kCMVideoCodecType_H264,
  encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
  outputCallback: nil, refcon: nil, compressionSessionOut: &compSession)
if created != noErr { print("VTCompressionSessionCreate failed: \(created)"); exit(1) }
let comp = compSession!
VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 60 as CFNumber)
VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_AverageBitRate, value: 20_000_000 as CFNumber)
VTCompressionSessionPrepareToEncodeFrames(comp)

var encodeMsSamples: [Double] = []
let done = DispatchSemaphore(value: 0)
var completed = 0

for i in 0..<FRAMES {
  let pb = makePixelBuffer()
  fill(pb, frame: i)
  let pts = CMTime(value: Int64(i), timescale: Int32(FPS))
  let t0 = nowMs()
  VTCompressionSessionEncodeFrame(
    comp, imageBuffer: pb, presentationTimeStamp: pts,
    duration: CMTime(value: 1, timescale: Int32(FPS)),
    frameProperties: nil, infoFlagsOut: nil
  ) { status, _, sample in
    defer {
      completed += 1
      if completed == FRAMES { done.signal() }
    }
    guard status == noErr, let sample = sample else { return }
    encodeMsSamples.append(nowMs() - t0)
    guard let fmt = CMSampleBufferGetFormatDescription(sample) else { return }
    ensureDecoder(fmt)

    // DECODE — the receiver's real cost.
    let t1 = nowMs()
    _ = VTDecompressionSessionDecodeFrame(
      decSession!, sampleBuffer: sample, flags: [._EnableAsynchronousDecompression],
      infoFlagsOut: nil
    ) { st, _, _, _, _ in
      if st == noErr { decodeMsSamples.append(nowMs() - t1) }
    }

    // RENDER PATH — enqueue compressed buffer via the modern sampleBufferRenderer
    // (the non-deprecated macOS 15+ API the production receiver will use).
    let renderer = displayLayer.sampleBufferRenderer
    if renderer.isReadyForMoreMediaData {
      renderer.enqueue(sample)
      enqueued += 1
    }
  }
}

if done.wait(timeout: .now() + 15) == .timedOut { print("timed out waiting for encodes") }
VTDecompressionSessionWaitForAsynchronousFrames(decSession!)
usleep(200_000)

func stats(_ a: [Double]) -> String {
  guard !a.isEmpty else { return "n/a" }
  let s = a.sorted()
  let avg = a.reduce(0,+) / Double(a.count)
  let p95 = s[min(s.count - 1, Int(Double(s.count) * 0.95))]
  return String(format: "avg %.2fms  p95 %.2fms  max %.2fms  (n=%d)", avg, p95, s.last!, a.count)
}

print("== receiver 0-B closed-loop (\(W)x\(H) @ \(FPS), \(FRAMES) frames) ==")
print("encode :", stats(encodeMsSamples))
print("DECODE :", stats(decodeMsSamples), "   <- receiver's real cost")
let renderer = displayLayer.sampleBufferRenderer
print("display layer enqueued:", enqueued, "status:", renderer.status.rawValue, "(2=failed)")
if let e = renderer.error { print("display error:", e) }
let ok = !decodeMsSamples.isEmpty && renderer.status != .failed
print("RESULT:", ok ? "PASS" : "FAIL")
