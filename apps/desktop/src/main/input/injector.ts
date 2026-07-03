import { mouse, keyboard, screen, Point, Button, Key } from '@nut-tree-fork/nut-js'
import { CODE_TO_KEY } from './keyMap'

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

export async function typeText(text: string): Promise<void> {
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
export async function keyToggle(code: string, down: boolean): Promise<void> {
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
