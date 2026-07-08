import {
  mouse,
  keyboard,
  screen,
  Point,
  Button,
  Key,
  providerRegistry
} from '@nut-tree-fork/nut-js'
import { CODE_TO_KEY } from './keyMap'
import { typeTextWin32, keyToggleWin32 } from './injectorWin32'

// libnut-win32's keyboard calls resolve without throwing but silently fail
// to deliver most/all keystrokes when this process has never owned a
// window (the real input-helper's situation) -- see
// docs/native-input-plan.md's keyboard-injection-silent-failure addendum.
// Mouse is unaffected (stays on nut.js below); keyboard on Windows goes
// through raw user32.SendInput instead (injectorWin32.ts). Every other
// platform this app's dev/test harness runs on keeps the original nut.js
// keyboard path.
const isWin32 = process.platform === 'win32'

// Injects mouse/keyboard input on the agent (target) machine.
// Coordinates are absolute screen pixels, matching what the controller
// captures relative to the agent's screen resolution.

export async function moveMouse(x: number, y: number): Promise<void> {
  await mouse.setPosition(new Point(x, y))
}

export async function clickMouse(button: 'left' | 'right' = 'left'): Promise<void> {
  await mouse.click(button === 'left' ? Button.LEFT : Button.RIGHT)
}

// nut.js defaults keyboard.config.autoDelayMs to 300ms *per character* --
// fine for a one-shot type() of a whole string, but since remote text input
// now calls this once per real keystroke (see RemoteInputMessage's 'text'
// case), that 300ms would land on every single character typed, on top of
// network latency. The remote keystrokes are already paced by how fast the
// person is actually typing, so nut.js doesn't need to add its own pacing.
keyboard.config.autoDelayMs = 0

// The line above only kills nut.js's *JS-level* sleep. Its keyboard class
// constructor ALSO pushed the 300ms default down into the native libnut
// binary via setKeyboardDelay(300) at module load -- a per-key-event sleep
// inside the native layer that config changes afterward never touch. Left
// alone, every keydown/keyup (and every typed character) still blocks the
// native worker for 300ms, so fast typing backs up into a visible queue.
if (providerRegistry.hasKeyboard()) providerRegistry.getKeyboard().setKeyboardDelay(0)

// Same story for the mouse: nut.js sleeps mouse.config.autoDelayMs (default
// 100ms) *before* every pressButton/releaseButton/scroll -- meaning every
// remote click paid ~100ms down + ~100ms up of pure added latency, and each
// wheel tick another 100ms. Remote input is already paced by the human on
// the other end; nut.js's own pacing (meant for scripted automation) only
// adds lag here. (Native mouse delay is already 0 -- nut.js's mouse
// constructor sets that itself, unlike the keyboard one.)
mouse.config.autoDelayMs = 0

export async function typeText(text: string): Promise<void> {
  if (isWin32) {
    typeTextWin32(text)
    return
  }
  await keyboard.type(text)
}

export async function pressKey(key: keyof typeof Key): Promise<void> {
  await keyboard.pressKey(Key[key])
  await keyboard.releaseKey(Key[key])
}

const BUTTON_MAP: Record<'left' | 'right' | 'middle', Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE
}

// Press/release rather than click() -- lets the controller hold a button
// across separate mousemove events (drag-to-select, drag-and-drop) instead
// of only ever supporting an instantaneous click.
export async function mouseButtonToggle(
  button: 'left' | 'right' | 'middle',
  down: boolean
): Promise<void> {
  if (down) await mouse.pressButton(BUTTON_MAP[button])
  else await mouse.releaseButton(BUTTON_MAP[button])
}

export async function scrollMouse(deltaY: number): Promise<void> {
  const steps = Math.round(Math.abs(deltaY))
  if (steps === 0) return
  if (deltaY > 0) await mouse.scrollDown(steps)
  else await mouse.scrollUp(steps)
}

// Real key-hold semantics (press/release as separate events) rather than
// keyboard.type() -- required for modifier combos (Ctrl+C) and any key held
// across time, neither of which typeText() can express.
export async function keyToggle(code: string, down: boolean, scan = false): Promise<void> {
  if (isWin32) {
    keyToggleWin32(code, down, scan)
    return
  }
  const key = CODE_TO_KEY[code]
  if (key === undefined) return // unmapped key -- silently ignore rather than throw
  if (down) await keyboard.pressKey(key)
  else await keyboard.releaseKey(key)
}

export async function getScreenSize(): Promise<{ width: number; height: number }> {
  return { width: await screen.width(), height: await screen.height() }
}

// Confirmed via screenshot on macOS (Sonoma/Tahoe, Retina) that this returns a
// stale/incorrect value even though moveMouse() itself lands the cursor
// correctly -- don't rely on this for verification. Not needed by the real
// injection path (the agent only ever sets position from remote input).
export async function getMousePosition(): Promise<{ x: number; y: number }> {
  const pos = await mouse.getPosition()
  return { x: pos.x, y: pos.y }
}
