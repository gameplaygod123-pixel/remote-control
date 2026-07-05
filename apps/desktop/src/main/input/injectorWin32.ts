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

const SendInput = user32.func(
  'uint32 SendInput(uint32 cInputs, _Inout_ INPUT *pInputs, int cbSize)'
)

const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

const INPUT_SIZE = koffi.sizeof('INPUT')

function sendOne(ki: {
  wVk: number
  wScan: number
  dwFlags: number
}): void {
  const buf = Buffer.alloc(INPUT_SIZE)
  koffi.encode(buf, 0, 'INPUT', {
    type: INPUT_KEYBOARD,
    _pad: 0,
    ki: { ...ki, time: 0, dwExtraInfo: 0n },
    _tail: 0n
  })
  SendInput(1, buf, INPUT_SIZE)
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
export function keyToggleWin32(code: string, down: boolean): void {
  const entry = CODE_TO_VK[code]
  if (entry === undefined) return
  sendOne({
    wVk: entry.vk,
    wScan: 0,
    dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | (entry.extended ? KEYEVENTF_EXTENDEDKEY : 0)
  })
}
