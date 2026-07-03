import { useState } from 'react'

export default function CopyButton({ value }: { value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  async function handleCopy(): Promise<void> {
    await window.api.clipboard.write(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <button className="copy-btn" onClick={handleCopy} title="Copy" type="button">
      {copied ? '✓' : '⧉'}
    </button>
  )
}
