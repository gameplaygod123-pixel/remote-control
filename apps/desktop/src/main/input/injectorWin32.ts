import koffi from 'koffi'
import { CODE_TO_VK } from './keyMapWin32'

// Windows-only keyboard injection via user32.SendInput, bypassing
// @nut-tree-fork/nut-js's keyboard path entirely. See
// docs/native-input-plan.md's keyboard-injection-silent-failure addendum:
// libnut-win32's keyboard calls resolve without ever throwing but silently
// deliver zero (or near-zero) characters when run from a windowless process
// (confirmed via a real DOM-event oracle, not just Notepad -- Notepad's own
// WM_GETTEXT turned out to be an unreliable read on this system and produced
// a false "SendInput doesn't work either" result on the first attempt).
// Raw SendInput has no such requirement; verified working end to end
// (ASCII, Thai, digits, symbols, both cases) from the exact same
// ELECTRON_RUN_AS_NODE, no-window context the real input-helper runs in.
// Mouse injection is unaffected by any of this and stays on nut.js (see
// injector.ts) -- only keyboard ever silently failed there.

const INPUT_KEYBOARD = 1
const INPUT_MOUSE = 0
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004
const KEYEVENTF_SCANCODE = 0x0008

// MOUSEINPUT dwFlags for wheel scrolling.
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x01000

// Lazily initialized on first actual injection call, NOT at module load:
// this module is imported unconditionally by injector.ts (whose isWin32
// branching happens at call time, inside each function), and injector.ts is
// in turn imported by the Electron main process on every platform --
// koffi.load('user32.dll') at module scope would throw on the macOS
// controller the moment the app starts. Verified: dlopen('user32.dll')
// throws immediately on macOS. All callers are win32-gated, so init only
// ever runs where user32.dll actually exists.
let sendInputFn: ((count: number, buf: Buffer, size: number) => number) | null = null
let mapVirtualKeyFn: ((code: number, mapType: number) => number) | null = null
let inputSize = 0

function ensureInit(): void {
  if (sendInputFn) return
  const user32 = koffi.load('user32.dll')
  koffi.struct('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uint64'
  })
  // INPUT is a tagged union (type + MOUSEINPUT|KEYBDINPUT|HARDWAREINPUT) that's
  // 40 bytes on x64 (8-byte header + 32-byte union, sized to the largest
  // member, MOUSEINPUT). _tail pads KEYBDINPUT's 24 bytes up to that same 32,
  // matching the real struct's layout byte-for-byte -- verified via hexdump
  // against the documented Win32 INPUT/KEYBDINPUT layout during the spike.
  koffi.struct('INPUT', {
    type: 'uint32',
    _pad: 'uint32',
    ki: 'KEYBDINPUT',
    _tail: 'uint64'
  })
  // Mouse view of the same 40-byte tagged union. MOUSEINPUT is already 32 bytes
  // (its own uint64 padding), so INPUT_M is 8+32=40 -- the same size as the
  // keyboard INPUT above, so SendInput's uniform cbSize is happy either way. We
  // pass a plain Buffer to the pointer param, so encoding it as INPUT_M and
  // reusing sendInputFn (typed INPUT*) is ABI-correct.
  koffi.struct('MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'int32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uint64'
  })
  koffi.struct('INPUT_M', { type: 'uint32', _pad: 'uint32', mi: 'MOUSEINPUT' })
  sendInputFn = user32.func(
    'uint32 SendInput(uint32 cInputs, _Inout_ INPUT *pInputs, int cbSize)'
  ) as (count: number, buf: Buffer, size: number) => number
  mapVirtualKeyFn = user32.func('uint32 MapVirtualKeyW(uint32 uCode, uint32 uMapType)') as (
    code: number,
    mapType: number
  ) => number
  inputSize = koffi.sizeof('INPUT')
}

// VK -> hardware scan code, cached per VK (the mapping never changes within
// a session). Windows' own language-switch handling (the Thai grave-key
// toggle, Alt+Shift, etc.) reads the SCAN CODE off injected key events, not
// the VK -- events sent with wScan=0 typed characters fine but never
// triggered the layout switch. Populating the real scan code is SendInput
// best practice anyway: plenty of software (games especially) reads scan
// codes rather than VKs.
const MAPVK_VK_TO_VSC = 0
const scanCodeCache = new Map<number, number>()

function scanCodeFor(vk: number): number {
  let scan = scanCodeCache.get(vk)
  if (scan === undefined) {
    scan = mapVirtualKeyFn!(vk, MAPVK_VK_TO_VSC)
    scanCodeCache.set(vk, scan)
  }
  return scan
}

function sendOne(ki: { wVk: number; wScan: number; dwFlags: number }): void {
  ensureInit()
  const buf = Buffer.alloc(inputSize)
  koffi.encode(buf, 0, 'INPUT', {
    type: INPUT_KEYBOARD,
    _pad: 0,
    ki: { ...ki, time: 0, dwExtraInfo: 0n },
    _tail: 0n
  })
  sendInputFn!(1, buf, inputSize)
}

// One SendInput call per UTF-16 code unit (not per Unicode code point) --
// KEYEVENTF_UNICODE's wScan is a 16-bit UTF-16 code unit, so a character
// outside the BMP (e.g. an emoji) needs its surrogate pair delivered as two
// separate events, exactly like real Windows text input already does under
// the hood. Thai and all other characters this app targets are single BMP
// code units, but iterating by code unit keeps supplementary-plane input
// from silently mangling instead of only working for the common case.
export function typeTextWin32(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    sendOne({ wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE })
    sendOne({ wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP })
  }
}

// Real key-hold semantics via actual VK codes -- required for modifier
// combos (Ctrl+C) and any key held across time, neither of which
// typeTextWin32 can express. Unmapped codes are silently ignored, matching
// keyToggle()'s existing behavior in injector.ts.
//
// `scan` (GAME MODE): inject as a pure hardware scan code (KEYEVENTF_SCANCODE,
// wVk=0) so DirectInput/RawInput games -- which ignore VK-flagged SendInput --
// see a real keyboard press. Windows still derives the VK from the scan code
// for the foreground layout, so GetAsyncKeyState-based games work too. The
// default (VK) path is unchanged, keeping normal typing/shortcuts identical.
export function keyToggleWin32(code: string, down: boolean, scan = false): void {
  const entry = CODE_TO_VK[code]
  if (entry === undefined) return
  ensureInit()
  const extended = entry.extended ? KEYEVENTF_EXTENDEDKEY : 0
  const up = down ? 0 : KEYEVENTF_KEYUP
  if (scan) {
    sendOne({ wVk: 0, wScan: scanCodeFor(entry.vk), dwFlags: KEYEVENTF_SCANCODE | up | extended })
    return
  }
  sendOne({ wVk: entry.vk, wScan: scanCodeFor(entry.vk), dwFlags: up | extended })
}

function sendMouseData(mouseData: number, dwFlags: number): void {
  ensureInit()
  const buf = Buffer.alloc(inputSize)
  koffi.encode(buf, 0, 'INPUT_M', {
    type: INPUT_MOUSE,
    _pad: 0,
    mi: { dx: 0, dy: 0, mouseData, dwFlags, time: 0, dwExtraInfo: 0n }
  })
  sendInputFn!(1, buf, inputSize)
}

// px->wheel-unit gain (wheel units per trackpad pixel). A FEEL knob: tune on
// real hardware via INPUT_WHEEL_GAIN, then bake the winning default. Windows
// scrolls ~3 lines per WHEEL_DELTA(120), so ~120 units ≈ 48px -> ~2.5 units/px
// is roughly 1:1; start at 1 (conservative) and raise if it feels slow.
const WHEEL_GAIN = Number(process.env.INPUT_WHEEL_GAIN) || 1

// Fractional remainders kept across events so sub-notch scrolls aren't lost and
// fast flicks stay smooth (mouseData can be < 120 -- true high-resolution wheel,
// honored by every modern Windows app).
let wheelAccX = 0
let wheelAccY = 0

// Smooth high-resolution wheel from raw trackpad pixel deltas (Mac controller,
// px:true). Bypasses nut.js's whole-notch scroll entirely -- the same reason
// the keyboard moved to raw SendInput.
export function injectWheelWin32(dx: number, dy: number): void {
  // Vertical: Windows wheel +up, browser deltaY +down -> negate.
  wheelAccY += -dy * WHEEL_GAIN
  const outY = Math.trunc(wheelAccY)
  if (outY !== 0) {
    wheelAccY -= outY
    sendMouseData(outY, MOUSEEVENTF_WHEEL)
  }
  // Horizontal: HWHEEL +right matches browser deltaX +right (no negate).
  wheelAccX += dx * WHEEL_GAIN
  const outX = Math.trunc(wheelAccX)
  if (outX !== 0) {
    wheelAccX -= outX
    sendMouseData(outX, MOUSEEVENTF_HWHEEL)
  }
}
