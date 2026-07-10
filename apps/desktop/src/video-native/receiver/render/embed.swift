// In-process native render surface (librvr.dylib).
//
// THE FIX for the native-video-plan §3a crux. The old path drew decoded frames
// into a SEPARATE borderless NSWindow floated over the Electron window and kept
// in sync via set-render-rect. Two OS windows can't move/resize/fullscreen
// atomically, so it stuttered on drag, covered other apps, clipped the rounded
// corners, and broke mouse routing in fullscreen.
//
// Instead we composite the video INSIDE the one Electron window: this dylib is
// loaded by the Electron main process (main/nativeRenderSurface.ts, via koffi)
// and adds an AVSampleBufferDisplayLayer-backed NSView as the BOTTOM subview of
// the window's content view (the pointer comes from BrowserWindow
// .getNativeWindowHandle()). The web UI sits above it and is transparent over the
// video area (CSS .native-video), so the decoded frames show through with the
// floating controls painted on top. One window => the OS handles drag, resize,
// fullscreen, Spaces, z-order and corner-rounding for free.
//
// koffi calls arrive on the Electron main process's JS thread, which IS the macOS
// main/AppKit thread, so AppKit mutations here are already on-thread; we still
// guard with an explicit main-thread hop for safety.

import Foundation
import AVFoundation
import CoreMedia
import AppKit

final class EmbeddedSurface {
  static let shared = EmbeddedSurface()

  private var videoView: NSView?
  private weak var displayLayer: AVSampleBufferDisplayLayer?
  private let decoder = Decoder()
  private var attached = false
  // Reserve a strip at the TOP of the window for the web session titlebar so the
  // video is drawn BELOW it, not behind it (the bar used to clip the top of the
  // remote screen). Set from JS (rvr_set_top_inset): the titlebar height when
  // windowed, 0 in fullscreen (no bar there). macOS coords are bottom-left origin,
  // so "top gap" = shrink the height and pin y=0 (bottom).
  private var topInset: CGFloat = 0

  private init() {
    decoder.onSample = { [weak self] sb in
      self?.displayLayer?.sampleBufferRenderer.enqueue(sb)
    }
  }

  // The video subview's frame within its superview: full width, and full height
  // minus the reserved top strip. autoresizingMask keeps BOTH y-margins fixed, so
  // the top gap stays a constant `topInset` as the window resizes.
  private func frameFor(_ bounds: NSRect) -> NSRect {
    NSRect(x: 0, y: 0, width: bounds.width, height: max(0, bounds.height - topInset))
  }

  func attach(_ contentView: NSView) {
    if attached { return }
    attached = true
    let layer = AVSampleBufferDisplayLayer()
    layer.videoGravity = .resizeAspect                 // preserve aspect, letterbox
    layer.backgroundColor = NSColor.black.cgColor      // letterbox bars = black
    let view = NSView(frame: frameFor(contentView.bounds))
    view.wantsLayer = true
    view.layer = layer                                 // layer-hosting: layer tracks bounds
    view.autoresizingMask = [.width, .height]          // fills the window (below the strip) as it resizes
    // .below => sits under the web-contents subview; the transparent web area
    // (CSS .native-video) lets these frames show, controls paint on top.
    contentView.addSubview(view, positioned: .below, relativeTo: nil)
    videoView = view
    displayLayer = layer
    FileHandle.standardError.write("[embed] attached video subview \(contentView.bounds) topInset \(topInset)\n".data(using: .utf8)!)
  }

  // Update the reserved top strip (titlebar height windowed / 0 fullscreen) and
  // reposition the live video subview to match.
  func setTopInset(_ inset: CGFloat) {
    topInset = inset
    if let v = videoView, let sv = v.superview {
      v.frame = frameFor(sv.bounds)
    }
  }

  func setCodec(_ c: Codec) {
    decoder.setCodec(c)
  }

  func push(_ data: Data) {
    decoder.push(data)
  }

  func detach() {
    videoView?.removeFromSuperview()
    videoView = nil
    displayLayer = nil
    attached = false
  }
}

@inline(__always) private func onMain(_ block: @escaping () -> Void) {
  if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
}

// ─────────────────────────── C ABI for koffi ───────────────────────────

/// Attach the render surface to a BrowserWindow content view (NSView*), passed as
/// its raw pointer value from getNativeWindowHandle(). Idempotent.
@_cdecl("rvr_attach")
public func rvr_attach(_ viewPtr: UInt64) {
  guard let raw = UnsafeRawPointer(bitPattern: UInt(viewPtr)) else { return }
  let view = Unmanaged<NSView>.fromOpaque(raw).takeUnretainedValue()
  onMain { EmbeddedSurface.shared.attach(view) }
}

/// Set the decoder codec before AUs arrive (0 = H.264, 1 = HEVC). Detected from the
/// offer SDP on the JS side (nativeRenderSurface.setNativeCodec). Idempotent.
@_cdecl("rvr_set_codec")
public func rvr_set_codec(_ codec: Int32) {
  let c: Codec = codec == 1 ? .hevc : .h264
  onMain { EmbeddedSurface.shared.setCodec(c) }
}

/// Reserve a top strip (points) for the web session titlebar so the video draws
/// below it, not behind it. Titlebar height when windowed, 0 in fullscreen.
@_cdecl("rvr_set_top_inset")
public func rvr_set_top_inset(_ inset: Int32) {
  onMain { EmbeddedSurface.shared.setTopInset(CGFloat(max(0, inset))) }
}

/// Feed one Annex-B access unit (decode + enqueue). `ptr`/`len` are only valid for
/// the duration of the call, so we copy immediately.
@_cdecl("rvr_push")
public func rvr_push(_ ptr: UnsafePointer<UInt8>, _ len: Int32) {
  let data = Data(bytes: ptr, count: Int(len))
  onMain { EmbeddedSurface.shared.push(data) }
}

/// Remove the render surface (session end / receiver-down).
@_cdecl("rvr_detach")
public func rvr_detach() {
  onMain { EmbeddedSurface.shared.detach() }
}
