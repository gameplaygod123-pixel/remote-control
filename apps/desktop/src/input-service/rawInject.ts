// Raw Win32 SendInput for BOTH mouse and keyboard. UNTESTED on Windows — written
// on the Mac for handoff (docs/input-elevation-plan.md, phase 0). Golden rule #1:
// verify on real hardware before shipping; a bad koffi struct/signature segfaults
// natively and JS try/catch can't catch it.
//
// Why raw (not nut.js) for the injector process: the elevated injector must
// SetThreadDesktop to follow the active desktop (Default <-> Winlogon), and that
// only retargets the CALLING thread's SendInput. nut.js does its own thing that
// won't respect our SetThreadDesktop, so mouse must go through the same raw
// SendInput path as keyboard. Keyboard struct layout is proven in
// main/input/injectorWin32.ts (INPUT/KEYBDINPUT byte layout verified via hexdump
// there); this mirrors it and adds MOUSEINPUT.
//
// koffi.load is LAZY (golden rule #5) — never dlopen user32.dll at import time
// (this module may be imported on non-win32 during typechecks/tests).

import koffi from 'koffi'
import { CODE_TO_VK } from '../main/input/keyMapWin32'
import type { RemoteInputMessage } from '../renderer/src/shared/input/inputProtocol'

const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1

// KEYBDINPUT dwFlags
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004
const KEYEVENTF_SCANCODE = 0x0008

// MOUSEINPUT dwFlags
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000

const MAPVK_VK_TO_VSC = 0
// Absolute-mode coordinates are normalized to a 0..65535 grid across the whole
// virtual desktop (all monitors) when combined with VIRTUALDESK.
const ABS_MAX = 65535
// One wheel notch. The controller sends dy = browser deltaY / 40, so the exact
// multiplier here is a FEEL knob — tune on real hardware in phase 0.
const WHEEL_DELTA = 120

type SendInputFn = (count: number, buf: Buffer, size: number) => number
type MapVkFn = (code: number, mapType: number) => number

let sendInputFn: SendInputFn | null = null
let mapVirtualKeyFn: MapVkFn | null = null
let inputSize = 0

function ensureInit(): void {
  if (sendInputFn) return
  const user32 = koffi.load('user32.dll')

  koffi.struct('MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uint64'
  })
  koffi.struct('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uint64'
  })
  // Two 40-byte views of the same tagged union (type + 32-byte payload). Both
  // are exactly sizeof(INPUT)=40 on x64, so SendInput's uniform cbSize is happy
  // whichever we pass. MOUSEINPUT is already 32 bytes (its own uint64 padding);
  // KEYBDINPUT is 24, so _tail pads it up to 32 — same trick as injectorWin32.ts.
  koffi.struct('INPUT_M', { type: 'uint32', _pad: 'uint32', mi: 'MOUSEINPUT' })
  koffi.struct('INPUT_K', { type: 'uint32', _pad: 'uint32', ki: 'KEYBDINPUT', _tail: 'uint64' })

  sendInputFn = user32.func(
    'uint32 SendInput(uint32 cInputs, void *pInputs, int cbSize)'
  ) as SendInputFn
  mapVirtualKeyFn = user32.func('uint32 MapVirtualKeyW(uint32 uCode, uint32 uMapType)') as MapVkFn
  // Both INPUT views are 40 bytes; take the mouse one as the canonical size.
  inputSize = koffi.sizeof('INPUT_M')
}

const scanCodeCache = new Map<number, number>()
function scanCodeFor(vk: number): number {
  // injectKey evaluates scanCodeFor as a sendKey ARGUMENT, i.e. before sendKey
  // (and its ensureInit) runs — so on the first keyboard event of a fresh
  // process mapVirtualKeyFn is still null. Init here so any caller is safe;
  // ensureInit is idempotent. (Caught in phase-0 hardware testing.)
  ensureInit()
  let scan = scanCodeCache.get(vk)
  if (scan === undefined) {
    scan = mapVirtualKeyFn!(vk, MAPVK_VK_TO_VSC)
    scanCodeCache.set(vk, scan)
  }
  return scan
}

function sendMouse(mi: { dx: number; dy: number; mouseData: number; dwFlags: number }): void {
  ensureInit()
  const buf = Buffer.alloc(inputSize)
  koffi.encode(buf, 0, 'INPUT_M', {
    type: INPUT_MOUSE,
    _pad: 0,
    mi: { ...mi, time: 0, dwExtraInfo: 0n }
  })
  sendInputFn!(1, buf, inputSize)
}

function sendKey(ki: { wVk: number; wScan: number; dwFlags: number }): void {
  ensureInit()
  const buf = Buffer.alloc(inputSize)
  koffi.encode(buf, 0, 'INPUT_K', {
    type: INPUT_KEYBOARD,
    _pad: 0,
    ki: { ...ki, time: 0, dwExtraInfo: 0n },
    _tail: 0n
  })
  sendInputFn!(1, buf, inputSize)
}

// x/y are normalized [0,1] from the controller (already resolution-independent),
// which maps cleanly onto absolute mode — no GetSystemMetrics/screen-size query.
export function injectMouseMove(x: number, y: number): void {
  sendMouse({
    dx: Math.round(x * ABS_MAX),
    dy: Math.round(y * ABS_MAX),
    mouseData: 0,
    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
  })
}

export function injectMouseButton(button: 'left' | 'right' | 'middle', down: boolean): void {
  const flag =
    button === 'left'
      ? down
        ? MOUSEEVENTF_LEFTDOWN
        : MOUSEEVENTF_LEFTUP
      : button === 'right'
        ? down
          ? MOUSEEVENTF_RIGHTDOWN
          : MOUSEEVENTF_RIGHTUP
        : down
          ? MOUSEEVENTF_MIDDLEDOWN
          : MOUSEEVENTF_MIDDLEUP
  sendMouse({ dx: 0, dy: 0, mouseData: 0, dwFlags: flag })
}

export function injectWheel(dy: number): void {
  // Windows: positive = wheel forward/away (scroll up); browser deltaY positive
  // = scroll down, so negate. Magnitude is a feel knob (see WHEEL_DELTA note).
  sendMouse({
    dx: 0,
    dy: 0,
    mouseData: Math.round(-dy * WHEEL_DELTA),
    dwFlags: MOUSEEVENTF_WHEEL
  })
}

// Held-key semantics via real VK + scan code (needed for Ctrl+C etc. and any
// held key). Unmapped codes are ignored, matching keyToggleWin32.
//
// `scan` (GAME MODE): pure hardware scan code (KEYEVENTF_SCANCODE, wVk=0) so
// DirectInput/RawInput games see a real, holdable key press -- mirrors
// keyToggleWin32. Default (VK) path unchanged.
export function injectKey(code: string, down: boolean, scan = false): void {
  const entry = CODE_TO_VK[code]
  if (entry === undefined) return
  const extended = entry.extended ? KEYEVENTF_EXTENDEDKEY : 0
  const up = down ? 0 : KEYEVENTF_KEYUP
  if (scan) {
    sendKey({ wVk: 0, wScan: scanCodeFor(entry.vk), dwFlags: KEYEVENTF_SCANCODE | up | extended })
    return
  }
  sendKey({ wVk: entry.vk, wScan: scanCodeFor(entry.vk), dwFlags: up | extended })
}

// One event pair per UTF-16 code unit (surrogate pairs sent as two), layout-
// independent — the Thai/Unicode path. Mirrors typeTextWin32.
export function injectText(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    sendKey({ wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE })
    sendKey({ wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP })
  }
}

// Single dispatch for a decoded RemoteInputMessage — the injector loop calls
// this after ensuring the thread is on the active desktop.
export function injectRaw(message: RemoteInputMessage): void {
  switch (message.t) {
    case 'move':
      injectMouseMove(message.x, message.y)
      break
    case 'down':
    case 'up':
      injectMouseButton(message.button, message.t === 'down')
      break
    case 'wheel':
      injectWheel(message.dy)
      break
    case 'keydown':
    case 'keyup':
      injectKey(message.code, message.t === 'keydown', message.scan === true)
      break
    case 'text':
      injectText(message.text)
      break
  }
}
