import { mouse, keyboard, Point, Button, Key } from '@nut-tree-fork/nut-js'

// Injects mouse/keyboard input on the agent (target) machine.
// Coordinates are absolute screen pixels, matching what the controller
// captures relative to the agent's screen resolution.

export async function moveMouse(x: number, y: number): Promise<void> {
  await mouse.setPosition(new Point(x, y))
}

export async function clickMouse(button: 'left' | 'right' = 'left'): Promise<void> {
  await mouse.click(button === 'left' ? Button.LEFT : Button.RIGHT)
}

export async function typeText(text: string): Promise<void> {
  await keyboard.type(text)
}

export async function pressKey(key: keyof typeof Key): Promise<void> {
  await keyboard.pressKey(Key[key])
  await keyboard.releaseKey(Key[key])
}

// Confirmed via screenshot on macOS (Sonoma/Tahoe, Retina) that this returns a
// stale/incorrect value even though moveMouse() itself lands the cursor
// correctly -- don't rely on this for verification. Not needed by the real
// injection path (the agent only ever sets position from remote input).
export async function getMousePosition(): Promise<{ x: number; y: number }> {
  const pos = await mouse.getPosition()
  return { x: pos.x, y: pos.y }
}
