import { useEffect, useRef, useState } from 'react'

// TEMP (spike oracle, see docs/native-input-plan.md): keydown.key alone only
// shows the last event and doesn't reveal whether Shift/modifier state was
// actually applied by the OS, or whether composed Unicode text landed at
// all -- both needed to test the raw-SendInput keyboard spike properly, so
// this view now also keeps a running log and a real text input to capture
// accumulated typed text the same way any real text field would.
function CaptureTestView(): React.JSX.Element {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [lastClick, setLastClick] = useState<string | null>(null)
  const [keyLog, setKeyLog] = useState<string[]>([])
  const [typedText, setTypedText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onMove(event: MouseEvent): void {
      setPos({ x: event.clientX, y: event.clientY })
    }
    function onKey(event: KeyboardEvent): void {
      setKeyLog((prev) =>
        [
          ...prev,
          `key=${JSON.stringify(event.key)} code=${event.code} shift=${event.shiftKey} ctrl=${event.ctrlKey} alt=${event.altKey}`
        ].slice(-50)
      )
    }
    function onClick(event: MouseEvent): void {
      setLastClick(`(${event.clientX}, ${event.clientY}) button ${event.button}`)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [])

  return (
    <div style={{ padding: 16 }} tabIndex={0}>
      <h1>Capture Test (DOM events)</h1>
      <p>Move the mouse and type inside this window to confirm capture produces correct data.</p>
      <p>
        mouse position: ({pos.x}, {pos.y})
      </p>
      <p>last click: {lastClick ?? '(none yet)'}</p>
      <p>
        typed text (focus this box, this is the injection target):{' '}
        <input
          ref={inputRef}
          value={typedText}
          onChange={(e) => setTypedText(e.target.value)}
          style={{ width: 400 }}
        />
      </p>
      <button onClick={() => setTypedText('')}>clear</button>
      <h2>keydown log (last 50)</h2>
      <pre style={{ maxHeight: 300, overflow: 'auto', background: '#eee', padding: 8 }}>
        {keyLog.join('\n') || '(none yet)'}
      </pre>
    </div>
  )
}

export default CaptureTestView
