import Foundation
import VideoToolbox
import AVFoundation
import AppKit
import CoreMedia

print("== receiver toolchain probe ==")
print("macOS:", ProcessInfo.processInfo.operatingSystemVersionString)
let h264HW = VTIsHardwareDecodeSupported(kCMVideoCodecType_H264)
let hevcHW = VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)
print("HW decode H264:", h264HW, "| HEVC:", hevcHW)
let layer = AVSampleBufferDisplayLayer()
print("AVSampleBufferDisplayLayer instantiated:", type(of: layer))
print("NSWindow host available:", NSWindow.self)
print("RESULT: frameworks link + HW decode probe OK")
