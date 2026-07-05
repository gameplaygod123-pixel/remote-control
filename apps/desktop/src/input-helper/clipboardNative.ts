// OS clipboard read/write for the pure-Node input-helper process, which has
// no access to Electron's `clipboard` module (that's a main-process API, and
// the main process is throttled anyway when the agent window is hidden --
// the whole reason this runs in the helper). Windows uses the Win32
// clipboard API via koffi (same FFI already loaded for keyboard injection);
// macOS uses pbcopy/pbpaste so the local dev harness works. Any other
// platform is a no-op (only the dev harness ever reaches it).

import { execFileSync } from 'child_process'
import koffi from 'koffi'

const isWin32 = process.platform === 'win32'
const isDarwin = process.platform === 'darwin'

// ---- Windows (Win32 clipboard via koffi) ----

const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x0002

interface Win32Clipboard {
  OpenClipboard: (hwnd: unknown) => number
  CloseClipboard: () => number
  EmptyClipboard: () => number
  GetClipboardData: (format: number) => unknown
  SetClipboardData: (format: number, handle: unknown) => unknown
  GlobalAlloc: (flags: number, bytes: number) => unknown
  GlobalLock: (handle: unknown) => unknown
  GlobalUnlock: (handle: unknown) => number
  GlobalSize: (handle: unknown) => number
}

let win32: Win32Clipboard | null = null

function ensureWin32(): Win32Clipboard {
  if (win32) return win32
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  win32 = {
    // hWnd is null (no owner window) -- the helper has none, which is legal
    // for clipboard access. Passed as an explicit null pointer rather than
    // the integer 0 so koffi always treats it as a void* NULL, not an
    // address-typed argument.
    OpenClipboard: user32.func('int OpenClipboard(void *hWnd)') as Win32Clipboard['OpenClipboard'],
    CloseClipboard: user32.func('int CloseClipboard()') as Win32Clipboard['CloseClipboard'],
    EmptyClipboard: user32.func('int EmptyClipboard()') as Win32Clipboard['EmptyClipboard'],
    GetClipboardData: user32.func(
      'void *GetClipboardData(uint uFormat)'
    ) as Win32Clipboard['GetClipboardData'],
    SetClipboardData: user32.func(
      'void *SetClipboardData(uint uFormat, void *hMem)'
    ) as Win32Clipboard['SetClipboardData'],
    GlobalAlloc: kernel32.func(
      'void *GlobalAlloc(uint uFlags, size_t dwBytes)'
    ) as Win32Clipboard['GlobalAlloc'],
    GlobalLock: kernel32.func('void *GlobalLock(void *hMem)') as Win32Clipboard['GlobalLock'],
    GlobalUnlock: kernel32.func('int GlobalUnlock(void *hMem)') as Win32Clipboard['GlobalUnlock'],
    // Byte size of a global allocation -- used to bound the read decode so a
    // clipboard buffer that isn't null-terminated can never run the scan off
    // the end into unmapped memory.
    GlobalSize: kernel32.func('size_t GlobalSize(void *hMem)') as Win32Clipboard['GlobalSize']
  }
  return win32
}

// UTF-16 code units are read/written INLINE via koffi.array('uint16', n),
// NOT via koffi's 'str16' type. 'str16' is `const char16_t *` -- a POINTER to
// a string -- so koffi.encode(ptr,'str16',text) stored a pointer to a
// transient koffi-managed buffer in the clipboard's global memory instead of
// the actual text bytes (and koffi.decode(ptr,'str16') read that pointer back
// and dereferenced it). That buffer was subject to koffi's GC, so the pointer
// left in the clipboard went stale and a later read dereferenced freed memory
// -- the segfault that got the whole feature reverted (v1.15.1). It also
// meant the clipboard never actually held the text any other app could read,
// so cross-app sync -- the entire point -- never worked; the roundtrip only
// appeared to pass because encode/decode were symmetric about the same
// koffi-internal buffer. Writing the real code units inline fixes both.
function uint16Array(n: number): ReturnType<typeof koffi.array> {
  return koffi.array('uint16', n)
}

// OpenClipboard fails if another process currently holds the clipboard open
// -- common and transient. Retry a few times rather than dropping the sync
// for a whole poll cycle; give up quietly after that (next poll retries).
function openClipboardWithRetry(api: Win32Clipboard): boolean {
  for (let i = 0; i < 5; i++) {
    if (api.OpenClipboard(null)) return true
    execFileSyncSleep(10)
  }
  return false
}

// No synchronous sleep in Node without spinning; a 10ms busy-wait a handful
// of times only ever runs on a rare clipboard-contention retry, not the hot
// path.
function execFileSyncSleep(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* spin briefly */
  }
}

function readWin32(): string {
  const api = ensureWin32()
  if (!openClipboardWithRetry(api)) return ''
  try {
    const handle = api.GetClipboardData(CF_UNICODETEXT)
    if (!handle) return ''
    const byteSize = api.GlobalSize(handle)
    if (!byteSize) return ''
    const ptr = api.GlobalLock(handle)
    if (!ptr) return ''
    try {
      // Read the raw UTF-16 code units INLINE from the locked global memory,
      // bounded by GlobalSize (see the uint16Array note above for why this
      // must not use koffi's pointer-typed 'str16'). Trimmed at the first
      // null; the GlobalSize bound guarantees the scan can't run past the
      // allocation even for a buffer some other app left un-terminated.
      const maxUnits = Math.floor(byteSize / 2)
      const units = koffi.decode(ptr, uint16Array(maxUnits)) as number[]
      let end = units.indexOf(0)
      if (end < 0) end = units.length
      // Chunked so a very large clipboard payload can't blow the call stack
      // via String.fromCharCode(...spread).
      let out = ''
      const CHUNK = 8192
      for (let i = 0; i < end; i += CHUNK) {
        out += String.fromCharCode.apply(null, units.slice(i, Math.min(end, i + CHUNK)))
      }
      return out
    } finally {
      api.GlobalUnlock(handle)
    }
  } finally {
    api.CloseClipboard()
  }
}

function writeWin32(text: string): void {
  const api = ensureWin32()
  if (!openClipboardWithRetry(api)) return
  try {
    api.EmptyClipboard()
    // (length + 1) UTF-16 code units for the trailing null, 2 bytes each.
    const unitCount = text.length + 1
    const handle = api.GlobalAlloc(GMEM_MOVEABLE, unitCount * 2)
    if (!handle) return
    const ptr = api.GlobalLock(handle)
    if (!ptr) return
    // Write the actual UTF-16 code units INLINE (see the uint16Array note
    // above). `units[text.length]` is left 0 as the required null terminator.
    const units = new Array<number>(unitCount)
    for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i)
    units[text.length] = 0
    koffi.encode(ptr, uint16Array(unitCount), units)
    api.GlobalUnlock(handle)
    // On success the clipboard takes ownership of `handle`; it must NOT be
    // freed here. (A failed SetClipboardData would leak it, but that path is
    // vanishingly rare and the process is short-lived per session anyway.)
    api.SetClipboardData(CF_UNICODETEXT, handle)
  } finally {
    api.CloseClipboard()
  }
}

// ---- macOS (dev harness only) ----

function readDarwin(): string {
  try {
    return execFileSync('pbpaste', { encoding: 'utf8' })
  } catch {
    return ''
  }
}

function writeDarwin(text: string): void {
  try {
    execFileSync('pbcopy', { input: text })
  } catch {
    /* best-effort in dev */
  }
}

// ---- public API ----

// Both wrappers swallow errors: clipboard sync is a non-critical convenience,
// and the Win32 FFI path in particular must never be able to throw up into
// the input-helper's message/poll handlers and take down input injection with
// it (a clipboard failure crashing the helper would be far worse than
// clipboard simply not syncing). Worst case here is a missed sync cycle.
export function readClipboardText(): string {
  try {
    if (isWin32) return readWin32()
    if (isDarwin) return readDarwin()
  } catch {
    /* clipboard read failed -- skip this cycle */
  }
  return ''
}

export function writeClipboardText(text: string): void {
  try {
    if (isWin32) writeWin32(text)
    else if (isDarwin) writeDarwin(text)
  } catch {
    /* clipboard write failed -- ignore */
  }
}
