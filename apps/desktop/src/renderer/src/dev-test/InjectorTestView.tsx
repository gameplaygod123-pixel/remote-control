import { useState } from 'react'

const TARGET = { x: 300, y: 300 }

function InjectorTestView(): React.JSX.Element {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [log, setLog] = useState<string[]>([])

  function append(line: string): void {
    setLog((prev) => [...prev, line])
  }

  async function runMoveTest(): Promise<void> {
    await window.api.input.move(TARGET.x, TARGET.y)
    // Note: nut.js's getPosition() has been observed to return a stale/incorrect
    // value on macOS (confirmed via screenshot that setPosition itself lands
    // correctly). Shown for reference only -- don't trust it as a pass/fail check.
    const actual = await window.api.input.getPosition()
    setPosition(actual)
    append(`move -> requested (${TARGET.x}, ${TARGET.y}). Confirm visually where the cursor landed.`)
  }

  async function runClickTest(): Promise<void> {
    await window.api.input.click('left')
    append('click -> sent (check whatever is under the cursor for a click effect)')
  }

  async function runTypeTest(): Promise<void> {
    await window.api.input.type('hello from remote control test')
    append('type -> sent "hello from remote control test" (check a focused text field)')
  }

  // Phase 5 additions: the press/release, scroll, and code-based key
  // primitives added for the WebRTC data-channel remote-control path.
  // Verified here in isolation (same as the original Phase 2 buttons above)
  // before trusting them inside the full WebRTC pipeline.
  async function runMouseButtonTest(): Promise<void> {
    await window.api.input.mouseButton('left', true)
    await new Promise((r) => setTimeout(r, 150))
    await window.api.input.mouseButton('left', false)
    append('mouseButton -> pressed then released left button (press/release, not click())')
  }

  async function runScrollTest(): Promise<void> {
    await window.api.input.scroll(3)
    append('scroll -> sent deltaY=3 (check a scrollable, focused window)')
  }

  async function runKeyTest(): Promise<void> {
    await window.api.input.key('ShiftLeft', true)
    await window.api.input.key('KeyA', true)
    await window.api.input.key('KeyA', false)
    await window.api.input.key('ShiftLeft', false)
    append('key -> sent Shift+A (should type uppercase "A" into a focused text field)')
  }

  async function runScreenSizeTest(): Promise<void> {
    const size = await window.api.input.getScreenSize()
    append(`screen size -> ${size.width}x${size.height}`)
  }

  return (
    <div style={{ padding: 16 }}>
      <h1>Injector Test (nut.js)</h1>
      <p>
        Click a button, then look at the real cursor / a focused text field elsewhere on this
        machine to confirm the injection actually happened.
      </p>
      <button onClick={runMoveTest}>Move mouse to ({TARGET.x}, {TARGET.y})</button>{' '}
      <button onClick={runClickTest}>Click</button>{' '}
      <button onClick={runTypeTest}>Type test string</button>{' '}
      <button onClick={runMouseButtonTest}>Mouse down/up (drag primitive)</button>{' '}
      <button onClick={runScrollTest}>Scroll down 3</button>{' '}
      <button onClick={runKeyTest}>Key Shift+A</button>{' '}
      <button onClick={runScreenSizeTest}>Get screen size</button>
      {position && (
        <p>
          last read position (unreliable, see note in code): ({position.x}, {position.y})
        </p>
      )}
      <pre>{log.join('\n')}</pre>
    </div>
  )
}

export default InjectorTestView
