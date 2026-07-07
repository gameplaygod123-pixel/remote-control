// Windows-only: watches the CURRENT system cursor SHAPE (arrow / I-beam / hand /
// resize / wait / hidden) and reports it as a SEMANTIC id, so the Mac controller
// can draw the matching NATIVE cursor via CSS while the native video ships
// WITHOUT a composited cursor (ddagrab draw_mouse=0 -> the encoder sits near-idle
// on a static screen, like Parsec -- see sender/ffmpegArgs.ts).
//
// Deliberately NO bitmap: we compare the live cursor handle against the standard
// system cursors (LoadCursorW) and send only a name. That keeps the FFI a single,
// well-known GetCursorInfo call -- NO GetIconInfo/GetDIBits/BITMAPINFO pixel
// plumbing, which is exactly the koffi struct work that dangling-pointer-crashed
// the v1.15.0 clipboard FFI (golden rule #1). Custom/app cursors that aren't a
// standard system handle fall back to 'default'.
//
// koffi is loaded LAZILY here (golden rule #5) and only on win32; on any other
// platform, or on ANY load/struct-size failure, this is a silent no-op and the
// controller simply keeps showing the local OS cursor (graceful degradation --
// the whole feature can fail without breaking anything).

import koffi from 'koffi'
import type { CursorShape } from '../renderer/src/shared/input/inputProtocol'

// Standard cursor resource ids (winuser.h IDC_*), passed to LoadCursorW as
// MAKEINTRESOURCE (the integer sits in the pointer slot). Each maps to the CSS
// `cursor` keyword the controller applies verbatim.
const STANDARD_CURSORS: Array<{ id: number; shape: CursorShape }> = [
  { id: 32512, shape: 'default' }, // IDC_ARROW
  { id: 32513, shape: 'text' }, // IDC_IBEAM
  { id: 32514, shape: 'wait' }, // IDC_WAIT
  { id: 32515, shape: 'crosshair' }, // IDC_CROSS
  { id: 32649, shape: 'pointer' }, // IDC_HAND
  { id: 32650, shape: 'progress' }, // IDC_APPSTARTING
  { id: 32651, shape: 'help' }, // IDC_HELP
  { id: 32646, shape: 'move' }, // IDC_SIZEALL
  { id: 32648, shape: 'not-allowed' }, // IDC_NO
  { id: 32644, shape: 'ew-resize' }, // IDC_SIZEWE
  { id: 32645, shape: 'ns-resize' }, // IDC_SIZENS
  { id: 32642, shape: 'nwse-resize' }, // IDC_SIZENWSE
  { id: 32643, shape: 'nesw-resize' } // IDC_SIZENESW
]

const CURSOR_SHOWING = 0x00000001
// ~16 Hz: cursor SHAPE changes are rare (we never send position -- the Mac
// already knows it), so a slow poll adds effectively no load.
const POLL_INTERVAL_MS = 60
// Known x64 layout: cbSize(4) flags(4) hCursor(8, 8-aligned) ptScreenPos(POINT=8)
// = 24. Asserted before any pointer is handed to GetCursorInfo -- a wrong koffi
// layout would let native code scribble past the struct (uncatchable segfault).
const CURSORINFO_SIZE = 24

export interface CursorCaptureHandle {
  stop(): void
}

const NOOP: CursorCaptureHandle = {
  stop() {
    /* nothing running to stop */
  }
}

// Starts polling; invokes onShape ONLY when the shape actually changes (so the
// caller can send it straight down a channel). Returns a stop handle.
export function startCursorCapture(onShape: (shape: CursorShape) => void): CursorCaptureHandle {
  if (process.platform !== 'win32') return NOOP

  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const user32 = koffi.load('user32.dll')

    // POINT { LONG x; LONG y }  /  CURSORINFO { DWORD cbSize; DWORD flags;
    // HCURSOR hCursor; POINT ptScreenPos }. hCursor + the handles below are all
    // uintptr_t so they come back as plain integers we can compare by value.
    koffi.struct('PR_POINT', { x: 'int32', y: 'int32' })
    const CURSORINFO = koffi.struct('CURSORINFO', {
      cbSize: 'uint32',
      flags: 'uint32',
      hCursor: 'uintptr_t',
      ptScreenPos: 'PR_POINT'
    })
    if (koffi.sizeof(CURSORINFO) !== CURSORINFO_SIZE) return NOOP

    const GetCursorInfo = user32.func('int GetCursorInfo(_Inout_ CURSORINFO *pci)') as (pci: {
      cbSize: number
      flags: number
      hCursor: number | bigint
      ptScreenPos: { x: number; y: number }
    }) => number
    // LoadCursorW(HINSTANCE, LPCWSTR): both args + the return are pointer-sized.
    // The resource name is MAKEINTRESOURCE(id) -- the integer id in the pointer
    // slot -- so lpCursorName is declared size_t to accept it directly.
    const LoadCursorW = user32.func(
      'uintptr_t LoadCursorW(void *hInstance, size_t lpCursorName)'
    ) as (hInstance: unknown, lpCursorName: number) => number | bigint

    // Resolve the standard cursor handles once. These are shared, process-wide
    // handles that never need freeing; the live hCursor equals one of them
    // whenever a standard cursor is showing. Keyed by String() so a number vs
    // BigInt representation can't cause a miss.
    const handleToShape = new Map<string, CursorShape>()
    for (const { id, shape } of STANDARD_CURSORS) {
      const h = LoadCursorW(null, id)
      if (h) handleToShape.set(String(h), shape)
    }
    if (handleToShape.size === 0) return NOOP // LoadCursorW gave nothing -- bail

    let last: CursorShape | null = null
    const info = { cbSize: CURSORINFO_SIZE, flags: 0, hCursor: 0, ptScreenPos: { x: 0, y: 0 } }
    timer = setInterval(() => {
      try {
        info.cbSize = CURSORINFO_SIZE // GetCursorInfo requires this set each call
        if (!GetCursorInfo(info)) return
        const shape =
          (info.flags & CURSOR_SHOWING) === 0
            ? 'none'
            : (handleToShape.get(String(info.hCursor)) ?? 'default')
        if (shape !== last) {
          last = shape
          onShape(shape)
        }
      } catch {
        /* a transient GetCursorInfo failure -- skip this tick */
      }
    }, POLL_INTERVAL_MS)
  } catch {
    // koffi load / struct / func setup failed -- no-op, controller keeps the
    // local OS cursor. (A bad SIGNATURE segfaults uncatchably; this catch only
    // covers load/parse errors -- hence the struct-size guard above.)
    if (timer) clearInterval(timer)
    return NOOP
  }

  return {
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
