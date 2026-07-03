import { useEffect, useState } from 'react'

function CaptureTestView(): React.JSX.Element {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [lastKey, setLastKey] = useState<string | null>(null)
  const [lastClick, setLastClick] = useState<string | null>(null)

  useEffect(() => {
    function onMove(event: MouseEvent): void {
      setPos({ x: event.clientX, y: event.clientY })
    }
    function onKey(event: KeyboardEvent): void {
      setLastKey(event.key)
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
      <p>last key: {lastKey ?? '(none yet)'}</p>
      <p>last click: {lastClick ?? '(none yet)'}</p>
    </div>
  )
}

export default CaptureTestView
