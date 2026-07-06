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

  private init() {
    decoder.onSample = { [weak self] sb in
      self?.displayLayer?.sampleBufferRenderer.enqueue(sb)
    }
  }

  func attach(_ contentView: NSView) {
    if attached { return }
    attached = true
    let layer = AVSampleBufferDisplayLayer()
    layer.videoGravity = .resizeAspect                 // preserve aspect, letterbox
    layer.backgroundColor = NSColor.black.cgColor      // letterbox bars = black
    let view = NSView(frame: contentView.bounds)
    view.wantsLayer = true
    view.layer = layer                                 // layer-hosting: layer tracks bounds
    view.autoresizingMask = [.width, .height]          // fills the window as it resizes
    // .below => sits under the web-contents subview; the transparent web area
    // (CSS .native-video) lets these frames show, controls paint on top.
    contentView.addSubview(view, positioned: .below, relativeTo: nil)
    videoView = view
    displayLayer = layer
    FileHandle.standardError.write("[embed] attached video subview \(contentView.bounds)\n".data(using: .utf8)!)
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
