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
  OpenClipboard: (hwnd: number) => number
  CloseClipboard: () => number
  EmptyClipboard: () => number
  GetClipboardData: (format: number) => unknown
  SetClipboardData: (format: number, handle: unknown) => unknown
  GlobalAlloc: (flags: number, bytes: number) => unknown
  GlobalLock: (handle: unknown) => unknown
  GlobalUnlock: (handle: unknown) => number
}

let win32: Win32Clipboard | null = null

function ensureWin32(): Win32Clipboard {
  if (win32) return win32
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  win32 = {
    // hWnd is passed as 0 (no owner window) -- the helper has none, which is
    // legal for clipboard access.
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
    GlobalUnlock: kernel32.func('int GlobalUnlock(void *hMem)') as Win32Clipboard['GlobalUnlock']
  }
  return win32
}

// OpenClipboard fails if another process currently holds the clipboard open
// -- common and transient. Retry a few times rather than dropping the sync
// for a whole poll cycle; give up quietly after that (next poll retries).
function openClipboardWithRetry(api: Win32Clipboard): boolean {
  for (let i = 0; i < 5; i++) {
    if (api.OpenClipboard(0)) return true
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
    const ptr = api.GlobalLock(handle)
    if (!ptr) return ''
    try {
      // Null-terminated UTF-16 (wchar) string straight out of the locked
      // global memory.
      return koffi.decode(ptr, 'str16') as string
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
    const bytes = (text.length + 1) * 2
    const handle = api.GlobalAlloc(GMEM_MOVEABLE, bytes)
    if (!handle) return
    const ptr = api.GlobalLock(handle)
    if (!ptr) return
    koffi.encode(ptr, 'str16', text)
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
